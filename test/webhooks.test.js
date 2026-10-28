import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
// The receiver every follow webhook was verified with before the hub: autoblog's own.
import { verifyAndParse as autoblogVerify } from '@profullstack/autoblog';
import {
  memoryStore,
  postgresStore,
  verifyAndParse,
  verifySignature,
} from '../packages/notify/node_modules/@profullstack/webhooks/src/index.js';
import {
  createHub,
  emitFeedItems,
  emitFollowItems,
  encodeFollowSecret,
  followEndpointId,
  followOwner,
  legacyEventType,
  syncFollowEndpoint,
  wants,
} from '../packages/notify/src/hub.js';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';

/**
 * Webhooks moved from @profullstack/autoblog's in-process sender to the
 * @profullstack/webhooks hub. What must not change: a follow's existing
 * receiver keeps verifying (same key bytes, same Bearer, same envelope), even
 * when its secret looks like a whsec_ key -- the trap where the new package
 * would base64-decode it into a different key.
 */

const SITE = 'https://nichedb.dev';
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
// What the follow form suggested: a whsec_-looking string, which autoblog used whole.
const WHSEC_LOOKING = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const PLAIN = 'my receiver secret';

let db;
let ids;
beforeAll(async () => {
  db = await new PGlite({ extensions: { citext, pg_trgm } });
  const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const hub = files.indexOf('0041_webhooks_hub.sql');
  expect(hub).toBeGreaterThan(0);
  for (const f of files.slice(0, hub)) await db.exec(await readFile(dir + f, 'utf8'));

  // Follows as an older build left them, then the migration.
  await db.query(`insert into users (id, email) values ($1, 'a@x.test'), ($2, 'b@x.test')`, [
    ALICE,
    BOB,
  ]);
  const { rows: cols } = await db.query(
    `insert into collections (slug, name) values ('news', 'News') returning id`,
  );
  const { rows: feeds } = await db.query(
    `insert into feeds (slug, collection_id, name) values ('wire', $1, 'Wire'), ('other', $1, 'Other') returning id`,
    [cols[0].id],
  );
  ids = { wire: Number(feeds[0].id), other: Number(feeds[1].id) };
  await db.query(
    `insert into follows (user_id, feed_id, channels, webhook_url, webhook_secret) values
       ($1, $3, '{webhook}', 'https://a.example/hook', $5),
       ($2, $3, '{webhook,email}', 'https://b.example/hook', $6),
       ($1, $4, '{email}', 'https://a.example/unused', 'nope')`,
    [ALICE, BOB, ids.wire, ids.other, WHSEC_LOOKING, PLAIN],
  );
  for (const f of files.slice(hub)) await db.exec(await readFile(dir + f, 'utf8'));
}, 60_000);

/** A hub on the migrated PGlite whose fetch records every request. */
function hubOn(store) {
  const sent = [];
  const hub = createHub({
    store,
    siteUrl: SITE,
    guard: { lookup: async () => ['93.184.215.14'] },
    fetchImpl: async (url, init) => {
      sent.push({ url, headers: init.headers, body: init.body });
      return new Response(null, { status: 204 });
    },
  });
  return { hub, sent };
}

const ITEM = {
  id: 42,
  title: 'A <b>thing</b> happened',
  url: 'https://source.example/42',
  summary: 'It <really> did',
  kind: 'article',
  tags: ['x'],
  source_slug: 'wire-src',
  data: { k: 1 },
  published_at: '2026-10-28T10:00:00Z',
  first_seen_at: '2026-10-28T10:01:00Z',
};
const feedRow = () => ({ id: ids.wire, slug: 'wire', name: 'Wire', collection_slug: 'news' });

describe('migration 0041', () => {
  test('each webhook follow became its own endpoint, keeping the key bytes', async () => {
    const { rows } = await db.query('select * from webhook_endpoints order by id');
    expect(rows.map((r) => r.id).sort()).toEqual(
      [followEndpointId(ALICE, ids.wire), followEndpointId(BOB, ids.wire)].sort(),
    );
    const alice = rows.find((r) => r.id === followEndpointId(ALICE, ids.wire));
    expect(alice.owner).toBe(followOwner(ALICE, ids.wire));
    expect(alice.url).toBe('https://a.example/hook');
    // Same as the JS encoding, so a later sync writes what the migration wrote.
    expect(alice.secret).toBe(encodeFollowSecret(WHSEC_LOOKING));
    expect(JSON.parse(alice.events)).toEqual(['*']);
    expect(Number(alice.enabled)).toBe(1);
    expect(alice.description).toBe('follow of wire');
  });
});

describe('follow webhooks keep their wire format', () => {
  test('an autoblog receiver still verifies, for a whsec_-looking and a plain secret', async () => {
    const { hub, sent } = hubOn(postgresStore(db));
    for (const [user, secret] of [
      [ALICE, WHSEC_LOOKING],
      [BOB, PLAIN],
    ]) {
      sent.length = 0;
      const target = { user_id: user };
      expect(await emitFollowItems(hub, { target, feed: feedRow(), items: [ITEM] })).toBe(1);
      await hub.drain();
      expect(sent.length).toBe(1);
      const [req] = sent;
      expect(req.url).toBe(user === ALICE ? 'https://a.example/hook' : 'https://b.example/hook');

      // The old receiver: bearer = the secret, HMAC keyed with the whole string, envelope with data.post.
      const r = autoblogVerify({ headers: req.headers, body: req.body, opts: { secret } });
      expect(r.ok).toBe(true);
      expect(r.event.type).toBe('dev.nichedb.post.published.v1');
      expect(r.event.subject).toBe('post:item_42');
      expect(r.post).toMatchObject({
        id: 'item_42',
        url: 'https://source.example/42',
        title: ITEM.title,
        slug: 'wire/42',
        html: '<p>It &lt;really> did</p>',
        status: 'published',
        published_at: '2026-10-28T10:00:00.000Z',
        tags: ['x'],
        categories: ['news', 'article'],
        _nichedb: { feed: 'wire', source: 'wire-src', kind: 'article', data: { k: 1 } },
      });
      expect(req.headers['user-agent']).toBe(`niche-db/0.1 (+${SITE})`);
      expect(req.headers['webhook-event']).toBe('dev.nichedb.post.published.v1');
    }
  });

  test('the trap: the raw whsec_ secret given straight to the package would not verify', async () => {
    const { hub, sent } = hubOn(postgresStore(db));
    await emitFollowItems(hub, { target: { user_id: ALICE }, feed: feedRow(), items: [ITEM] });
    await hub.drain();
    const [req] = sent;
    // The package reads whsec_<base64> as decoded bytes, so the old string is a different key...
    expect(
      verifySignature({ headers: req.headers, body: req.body, secret: WHSEC_LOOKING }).ok,
    ).toBe(false);
    // ...and the re-encoded one is the same key the old string was.
    expect(
      verifySignature({
        headers: req.headers,
        body: req.body,
        secret: encodeFollowSecret(WHSEC_LOOKING),
      }).ok,
    ).toBe(true);
  });

  test("a follow's endpoint only ever gets that follow's items", async () => {
    const { hub, sent } = hubOn(postgresStore(db));
    await emitFollowItems(hub, { target: { user_id: ALICE }, feed: feedRow(), items: [ITEM] });
    await hub.drain();
    expect(sent.map((s) => s.url)).toEqual(['https://a.example/hook']);
    // Account endpoints never see follow endpoints, and cannot act on them.
    expect(await hub.listEndpoints(ALICE)).toEqual([]);
    await expect(hub.secret(ALICE, followEndpointId(ALICE, ids.wire))).rejects.toThrow(
      'no such webhook endpoint',
    );
  });

  test('a follow saved by an older build gets its endpoint on first delivery', async () => {
    const { hub, sent } = hubOn(memoryStore());
    const target = {
      user_id: ALICE,
      channels: ['webhook'],
      webhook_url: 'https://late.example/hook',
      webhook_secret: PLAIN,
    };
    expect(await emitFollowItems(hub, { target, feed: feedRow(), items: [ITEM] })).toBe(1);
    await hub.drain();
    expect(sent[0].url).toBe('https://late.example/hook');
    expect(
      autoblogVerify({ headers: sent[0].headers, body: sent[0].body, opts: { secret: PLAIN } }).ok,
    ).toBe(true);
  });

  test('sync follows the follow: changed, re-enabled, then removed with the channel', async () => {
    const { hub } = hubOn(memoryStore());
    const base = { userId: BOB, feedId: 7, feedSlug: 'x' };
    const id = followEndpointId(BOB, 7);
    await syncFollowEndpoint(hub, {
      ...base,
      follow: { channels: ['webhook'], webhook_url: 'https://one.example', webhook_secret: 's1' },
    });
    await hub.store.updateEndpoint(id, { enabled: false, failures: 20 });
    await syncFollowEndpoint(hub, {
      ...base,
      follow: { channels: ['webhook'], webhook_url: 'https://two.example', webhook_secret: 's2' },
    });
    const e = await hub.store.getEndpoint(id);
    expect(e).toMatchObject({ url: 'https://two.example', enabled: true, failures: 0 });
    expect(e.secret).toBe(encodeFollowSecret('s2'));
    await syncFollowEndpoint(hub, {
      ...base,
      follow: { channels: ['email'], webhook_url: 'https://two.example', webhook_secret: 's2' },
    });
    expect(await hub.store.getEndpoint(id)).toBeNull();
  });
});

describe('account webhooks', () => {
  test('feed.item.published is plain Standard Webhooks, no bearer', async () => {
    const { hub, sent } = hubOn(postgresStore(db));
    const { endpoint, secret } = await hub.createEndpoint(BOB, {
      url: 'https://bob.example/all',
      events: ['feed.*'],
    });
    expect(secret.startsWith('whsec_')).toBe(true);
    expect(await wants(hub, BOB, 'feed.item.published')).toBe(true);
    expect(await wants(hub, BOB, 'submission.approved')).toBe(false);
    expect(await wants(hub, ALICE, 'feed.item.published')).toBe(false);
    expect(await emitFeedItems(hub, { userId: BOB, feed: feedRow(), items: [ITEM] })).toBe(1);
    await hub.drain();
    const req = sent.find((s) => s.url === 'https://bob.example/all');
    expect(req.headers.authorization).toBeUndefined();
    const r = verifyAndParse({ headers: req.headers, body: req.body, secret });
    expect(r.ok).toBe(true);
    expect(r.event).toMatchObject({
      type: 'feed.item.published',
      source: SITE,
      subject: 'item:42',
      data: {
        feed: { slug: 'wire', name: 'Wire', collection: 'news', url: `${SITE}/f/wire` },
        item: { id: 42, page: `${SITE}/i/42`, url: 'https://source.example/42' },
      },
    });
    await hub.deleteEndpoint(BOB, endpoint.id);
  });

  test('unknown event patterns are refused', async () => {
    const { hub } = hubOn(memoryStore());
    await expect(
      hub.createEndpoint(ALICE, { url: 'https://a.example', events: ['room.joined'] }),
    ).rejects.toThrow('no event matches');
  });

  test('legacyEventType mirrors autoblog for any host', () => {
    expect(legacyEventType('https://www.nichedb.dev')).toBe('dev.nichedb.post.published.v1');
    expect(legacyEventType('https://nichedb.test')).toBe('test.nichedb.post.published.v1');
  });
});
