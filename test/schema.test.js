import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

/** The migrations and the load-bearing statements, against a real Postgres in-process. */
let db;
beforeAll(async () => {
  db = await new PGlite({ extensions: { citext, pg_trgm } });
  const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
  for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(await readFile(dir + f, 'utf8'));
  }
}, 60_000);

const rows = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (sql, params) => (await rows(sql, params))[0];

async function seed() {
  const c = await one(
    `insert into collections (slug, name) values ($1, 'T') on conflict (slug) do update set name = 'T' returning id`,
    [`c${Math.random()}`],
  );
  const s = await one(
    `insert into sources (collection_id, adapter, slug, name) values ($1, 'steam', $2, 'S') returning id`,
    [c.id, `s${Math.random()}`],
  );
  return { collectionId: c.id, sourceId: s.id };
}

describe('migrations', () => {
  test('every table the app queries exists', async () => {
    const names = (
      await rows(`select table_name from information_schema.tables where table_schema='public'`)
    ).map((r) => r.table_name);
    for (const t of [
      'users',
      'login_tokens',
      'sessions',
      'passkeys',
      'api_keys',
      'push_subscriptions',
      'collections',
      'sources',
      'runs',
      'items',
      'feeds',
      'follows',
      'source_submissions',
      'profiles',
      'profile_identities',
      'profile_sources',
      'deliveries',
      'payments',
      'memberships',
      'api_usage',
      'referral_codes',
      'referral_usages',
      'niches',
      'niche_members',
      'niche_claims',
      'opportunities',
      'contribution_tiers',
      'contribution_events',
      'contribution_scores',
      'tier_history',
      'knowledge_audit_logs',
      'agent_questions',
      'agent_answers',
      'revenue_events',
      'revenue_allocations',
      'payout_accounts',
      'payouts',
      'payout_allocations',
    ]) {
      expect(names).toContain(t);
    }
  });
  test('no password column anywhere: magic link + passkey only', async () => {
    const cols = await rows(
      `select table_name, column_name from information_schema.columns where table_schema='public' and column_name ilike '%password%'`,
    );
    expect(cols).toEqual([]);
  });
});

describe('items upsert', () => {
  const upsert = (collectionId, sourceId, items) =>
    rows(
      `insert into items (collection_id, source_id, external_id, kind, title, summary, url, image_url, published_at, time_known, precision, tags, data, content_hash)
       select $1, $2, r.external_id, r.kind, r.title, r.summary, r.url, r.image_url, r.published_at, coalesce(r.time_known, true), coalesce(r.precision, 'minute'), coalesce(r.tags, '{}'), coalesce(r.data, '{}'), r.content_hash
       from jsonb_to_recordset($3::jsonb) as r(external_id text, kind text, title text, summary text, url text, image_url text, published_at timestamptz, time_known boolean, precision text, tags text[], data jsonb, content_hash text)
       on conflict (source_id, external_id) do update set title = excluded.title, tags = excluded.tags, data = excluded.data, content_hash = excluded.content_hash, updated_at = now()
       where items.content_hash is distinct from excluded.content_hash
       returning (xmax = 0) as inserted, tags, data`,
      [collectionId, sourceId, JSON.stringify(items)],
    );

  test('rows travel as JSON, arrays and jsonb included', async () => {
    const { collectionId, sourceId } = await seed();
    const out = await upsert(collectionId, sourceId, [
      {
        external_id: 'a',
        kind: 'game',
        title: 'A',
        tags: ['free', 'indie'],
        data: { appid: 1 },
        content_hash: 'h1',
        published_at: '2026-09-05T12:00:00Z',
      },
    ]);
    expect(out.length).toBe(1);
    expect(out[0].inserted).toBe(true);
    expect(out[0].tags).toEqual(['free', 'indie']);
    expect(out[0].data).toEqual({ appid: 1 });
  });

  test('an unchanged row writes nothing; a changed one updates', async () => {
    const { collectionId, sourceId } = await seed();
    await upsert(collectionId, sourceId, [
      { external_id: 'b', kind: 'game', title: 'B', content_hash: 'h1' },
    ]);
    const same = await upsert(collectionId, sourceId, [
      { external_id: 'b', kind: 'game', title: 'B', content_hash: 'h1' },
    ]);
    expect(same.length).toBe(0);
    const changed = await upsert(collectionId, sourceId, [
      { external_id: 'b', kind: 'game', title: 'B2', content_hash: 'h2' },
    ]);
    expect(changed.length).toBe(1);
    expect(changed[0].inserted).toBe(false);
  });

  test('a batch naming the same external_id twice is what Postgres refuses, so the dedupe is load-bearing', async () => {
    const { collectionId, sourceId } = await seed();
    let threw = null;
    try {
      await upsert(collectionId, sourceId, [
        { external_id: 'dup', kind: 'x', title: '1', content_hash: 'a' },
        { external_id: 'dup', kind: 'x', title: '2', content_hash: 'b' },
      ]);
    } catch (e) {
      threw = e.message;
    }
    expect(threw).toMatch(/cannot affect row a second time/i);
  });

  test('full-text search finds a title word and a tag', async () => {
    const { collectionId, sourceId } = await seed();
    await upsert(collectionId, sourceId, [
      {
        external_id: 'fts',
        kind: 'version',
        title: 'hono 4.13.7',
        summary: 'Web framework',
        tags: ['npm', 'router'],
        content_hash: 'z',
      },
    ]);
    const hit = await rows(
      `select id from items where source_id = $1 and search @@ websearch_to_tsquery('simple', 'router')`,
      [sourceId],
    );
    expect(hit.length).toBe(1);
  });
});

describe('feeds and deliveries', () => {
  test('a follow claims each item once; a failed claim can be retried', async () => {
    const { collectionId, sourceId } = await seed();
    const u = await one(`insert into users (email) values ($1) returning id`, [
      `u${Math.random()}@e.com`,
    ]);
    const f = await one(
      `insert into feeds (collection_id, slug, name) values ($1, $2, 'F') returning id`,
      [collectionId, `f${Math.random()}`],
    );
    const it = await one(
      `insert into items (collection_id, source_id, external_id, title) values ($1, $2, 'i', 'I') returning id`,
      [collectionId, sourceId],
    );
    const claim = `insert into deliveries (feed_id, user_id, item_id, channel) values ($1, $2, $3, 'email')
      on conflict (feed_id, user_id, item_id, channel) do update set status = 'sent', sent_at = now() where deliveries.status = 'failed' returning feed_id`;
    expect((await rows(claim, [f.id, u.id, it.id])).length).toBe(1);
    expect((await rows(claim, [f.id, u.id, it.id])).length).toBe(0);
    await db.query(`update deliveries set status = 'failed' where feed_id = $1`, [f.id]);
    expect((await rows(claim, [f.id, u.id, it.id])).length).toBe(1);
  });

  test('deleting a source takes its items with it', async () => {
    const { collectionId, sourceId } = await seed();
    const it = await one(
      `insert into items (collection_id, source_id, external_id, title) values ($1, $2, 'i', 'I') returning id`,
      [collectionId, sourceId],
    );
    await db.query(`delete from sources where id = $1`, [sourceId]);
    expect(await one(`select id from items where id = $1`, [it.id])).toBeUndefined();
  });

  test('the first account is an admin, later ones are not', async () => {
    const n = await one(`select count(*)::int as n from users`);
    const role = n.n === 0 ? 'admin' : 'user';
    expect(['admin', 'user']).toContain(role);
  });
});

/**
 * The Knowledge Influencer tables, against the same in-process Postgres. What
 * is checked here is the part the application trusts the database to enforce:
 * that a duplicate submission cannot book twice, that a niche cannot take a
 * name the site already serves, and that the ladder is on the ladder.
 */
describe('knowledge influencers', () => {
  const niche = async () =>
    one(`insert into niches (slug, name) values ($1, 'N') returning id`, [
      `n${Math.random()}`.replace('.', ''),
    ]);
  const person = async () =>
    one(`insert into users (email) values ($1) returning id`, [`k${Math.random()}@e.com`]);

  test('the 20-80 ladder is seeded, in order, capped at 8000 bps', async () => {
    const tiers = await rows(
      `select slug, min_score, share_bps from contribution_tiers order by position`,
    );
    expect(tiers.length).toBe(7);
    expect(tiers[0].share_bps).toBe(2000);
    expect(tiers.at(-1).share_bps).toBe(8000);
    for (let i = 1; i < tiers.length; i++) {
      expect(tiers[i].min_score).toBeGreaterThan(tiers[i - 1].min_score);
      expect(tiers[i].share_bps).toBeGreaterThan(tiers[i - 1].share_bps);
    }
  });

  test('nothing may be given a share above the programme maximum', async () => {
    const n = await niche();
    const u = await person();
    let threw = null;
    try {
      await db.query(
        `insert into niche_members (niche_id, user_id, share_cap_bps) values ($1, $2, 9000)`,
        [n.id, u.id],
      );
    } catch (e) {
      threw = e.message;
    }
    expect(threw).toMatch(/niche_members_cap/);
  });

  test('a slug that is not url-safe is refused by the database, not just the app', async () => {
    let threw = null;
    try {
      await db.query(`insert into niches (slug, name) values ('Not A Slug', 'x')`);
    } catch (e) {
      threw = e.message;
    }
    expect(threw).toMatch(/niches_slug_shape/);
  });

  test('the same submission books once; a different one still books', async () => {
    const n = await niche();
    const u = await person();
    const submit = (key) =>
      rows(
        `insert into contribution_events (niche_id, influencer_id, event_type, points, dedupe_key)
         values ($1, $2, 'agent_answer', 3, $3)
         on conflict (niche_id, influencer_id, dedupe_key) where dedupe_key is not null do nothing
         returning id`,
        [n.id, u.id, key],
      );
    expect((await submit('abc')).length).toBe(1);
    expect((await submit('abc')).length).toBe(0);
    expect((await submit('def')).length).toBe(1);
  });

  test('events with no natural identity never collide with each other', async () => {
    const n = await niche();
    const u = await person();
    const submit = () =>
      rows(
        `insert into contribution_events (niche_id, influencer_id, event_type, points, dedupe_key)
         values ($1, $2, 'manual_adjustment', 5, null)
         on conflict (niche_id, influencer_id, dedupe_key) where dedupe_key is not null do nothing
         returning id`,
        [n.id, u.id],
      );
    expect((await submit()).length).toBe(1);
    expect((await submit()).length).toBe(1);
  });

  test('the score sums verified events only, so a reversal stops counting without deleting', async () => {
    const n = await niche();
    const u = await person();
    const add = (points, status) =>
      db.query(
        `insert into contribution_events (niche_id, influencer_id, event_type, points, status)
         values ($1, $2, 'knowledge_created', $3, $4)`,
        [n.id, u.id, points, status],
      );
    const total = async () =>
      (
        await one(
          `select coalesce(sum(points) filter (where status = 'verified'), 0)::int as score
           from contribution_events where niche_id = $1 and influencer_id = $2`,
          [n.id, u.id],
        )
      ).score;

    await add(20, 'verified');
    await add(3, 'verified');
    await add(100, 'pending');
    await add(50, 'rejected');
    expect(await total()).toBe(23);

    await add(100, 'verified');
    expect(await total()).toBe(123);
    await db.query(
      `update contribution_events set status = 'reversed'
       where niche_id = $1 and points = 100 and status = 'verified'`,
      [n.id],
    );
    // The honest 23 survives the reversal, and the reversed row is still there.
    expect(await total()).toBe(23);
    const kept = await rows(
      `select points, status from contribution_events where niche_id = $1 and status = 'reversed'`,
      [n.id],
    );
    expect(kept).toEqual([{ points: 100, status: 'reversed' }]);
  });

  test('one live application per person per niche, but a decided one does not block a retry', async () => {
    const n = await niche();
    const u = await person();
    const apply = () =>
      rows(
        `insert into niche_claims (niche_id, user_id) values ($1, $2)
         on conflict (niche_id, user_id) where status = 'pending' do nothing returning id`,
        [n.id, u.id],
      );
    const first = await apply();
    expect(first.length).toBe(1);
    expect((await apply()).length).toBe(0);
    await db.query(`update niche_claims set status = 'rejected' where id = $1`, [first[0].id]);
    expect((await apply()).length).toBe(1);
  });

  test('a tier a person no longer holds is still in their history', async () => {
    const n = await niche();
    const u = await person();
    for (const [tier, score, bps] of [
      ['contributor', 0, 2000],
      ['specialist', 123, 3000],
      ['contributor', 23, 2000],
    ]) {
      await db.query(
        `insert into tier_history (niche_id, influencer_id, tier_slug, score, share_bps)
         values ($1, $2, $3, $4, $5)`,
        [n.id, u.id, tier, score, bps],
      );
    }
    const history = await rows(
      `select tier_slug, share_bps from tier_history where niche_id = $1 order by id`,
      [n.id],
    );
    expect(history.map((h) => h.share_bps)).toEqual([2000, 3000, 2000]);
  });

  test('deleting a niche takes its events with it, but not the audit trail', async () => {
    const n = await niche();
    const u = await person();
    await db.query(
      `insert into contribution_events (niche_id, influencer_id, event_type, points)
       values ($1, $2, 'agent_answer', 3)`,
      [n.id, u.id],
    );
    await db.query(
      `insert into knowledge_audit_logs (actor_id, action, subject_type, niche_id)
       values ($1, 'contribution.verified', 'contribution_event', $2)`,
      [u.id, n.id],
    );
    await db.query(`delete from niches where id = $1`, [n.id]);
    expect(
      (await rows(`select id from contribution_events where niche_id = $1`, [n.id])).length,
    ).toBe(0);
    // The record of what an admin decided outlives the thing it was about.
    const audit = await rows(
      `select action, niche_id from knowledge_audit_logs where actor_id = $1`,
      [u.id],
    );
    expect(audit.length).toBe(1);
    expect(audit[0].niche_id).toBeNull();
  });
});

/**
 * The agent question loop's tables. What is checked here is what the
 * application trusts the database for: a redelivered question appears once, a
 * person answers once, and declining leaves no scored trace.
 */
describe('agent questions', () => {
  const niche = async () =>
    one(`insert into niches (slug, name) values ($1, 'N') returning id`, [
      `q${Math.random()}`.replace('.', ''),
    ]);
  const person = async () =>
    one(`insert into users (email) values ($1) returning id`, [`a${Math.random()}@e.com`]);
  const ask = (nicheId, externalId = null, urgency = 'normal') =>
    rows(
      `insert into agent_questions (niche_id, external_id, title, question, urgency)
       values ($1, $2, 'T', 'Q', $3)
       on conflict (niche_id, external_id) where external_id is not null do nothing
       returning id`,
      [nicheId, externalId, urgency],
    );

  test('a question delivered twice is stored once', async () => {
    const n = await niche();
    expect((await ask(n.id, 'chovy-q-1')).length).toBe(1);
    expect((await ask(n.id, 'chovy-q-1')).length).toBe(0);
    // A different agent id is a different question.
    expect((await ask(n.id, 'chovy-q-2')).length).toBe(1);
  });

  test('the same external id in another niche is another question', async () => {
    const a = await niche();
    const b = await niche();
    expect((await ask(a.id, 'shared')).length).toBe(1);
    expect((await ask(b.id, 'shared')).length).toBe(1);
  });

  test('questions raised by hand have no id and never collide', async () => {
    const n = await niche();
    expect((await ask(n.id, null)).length).toBe(1);
    expect((await ask(n.id, null)).length).toBe(1);
  });

  test('urgency and status are constrained, so a typo cannot hide a question', async () => {
    const n = await niche();
    let threw = null;
    try {
      await db.query(
        `insert into agent_questions (niche_id, title, question, urgency) values ($1,'T','Q','asap')`,
        [n.id],
      );
    } catch (e) {
      threw = e.message;
    }
    expect(threw).toMatch(/agent_questions_urgency/);

    threw = null;
    try {
      await db.query(
        `insert into agent_questions (niche_id, title, question, status) values ($1,'T','Q','done')`,
        [n.id],
      );
    } catch (e) {
      threw = e.message;
    }
    expect(threw).toMatch(/agent_questions_status/);
  });

  test('one answer per person per question', async () => {
    const n = await niche();
    const [q] = await ask(n.id, 'once');
    const u = await person();
    const answer = () =>
      rows(
        `insert into agent_answers (question_id, influencer_id, kind, body)
         values ($1, $2, 'answered', 'ten percent')
         on conflict (question_id, influencer_id) do nothing returning id`,
        [q.id, u.id],
      );
    expect((await answer()).length).toBe(1);
    expect((await answer()).length).toBe(0);
  });

  test('two operators can each answer the same question', async () => {
    const n = await niche();
    const [q] = await ask(n.id, 'two');
    const a = await person();
    const b = await person();
    for (const u of [a, b]) {
      const out = await rows(
        `insert into agent_answers (question_id, influencer_id, kind) values ($1, $2, 'answered')
         on conflict (question_id, influencer_id) do nothing returning id`,
        [q.id, u.id],
      );
      expect(out.length).toBe(1);
    }
  });

  test('declining is recorded and carries no contribution', async () => {
    const n = await niche();
    const [q] = await ask(n.id, 'decline');
    const u = await person();
    await db.query(
      `insert into agent_answers (question_id, influencer_id, kind) values ($1, $2, 'insufficient_context')`,
      [q.id, u.id],
    );
    const row = await one(
      `select kind, contribution_event_id from agent_answers where question_id = $1`,
      [q.id],
    );
    expect(row.kind).toBe('insufficient_context');
    // No points, and nothing to reverse later. Declining has to be free.
    expect(row.contribution_event_id).toBeNull();
  });

  test('an answer kind nobody defined is refused', async () => {
    const n = await niche();
    const [q] = await ask(n.id, 'kind');
    const u = await person();
    let threw = null;
    try {
      await db.query(
        `insert into agent_answers (question_id, influencer_id, kind) values ($1, $2, 'maybe')`,
        [q.id, u.id],
      );
    } catch (e) {
      threw = e.message;
    }
    expect(threw).toMatch(/agent_answers_kind/);
  });

  test('the open queue is urgent first, then oldest first', async () => {
    const n = await niche();
    await ask(n.id, 'low-1', 'low');
    await ask(n.id, 'high-1', 'high');
    await ask(n.id, 'normal-1', 'normal');
    const queue = await rows(
      `select external_id from agent_questions
       where niche_id = $1 and status in ('open','researching')
       order by case urgency when 'high' then 0 when 'normal' then 1 else 2 end, created_at`,
      [n.id],
    );
    expect(queue.map((r) => r.external_id)).toEqual(['high-1', 'normal-1', 'low-1']);
  });

  test('deleting a question takes its answers, and the contribution outlives it', async () => {
    const n = await niche();
    const [q] = await ask(n.id, 'cascade');
    const u = await person();
    const ev = await one(
      `insert into contribution_events (niche_id, influencer_id, event_type, points, status)
       values ($1, $2, 'agent_answer', 3, 'verified') returning id`,
      [n.id, u.id],
    );
    await db.query(
      `insert into agent_answers (question_id, influencer_id, kind, contribution_event_id)
       values ($1, $2, 'answered', $3)`,
      [q.id, u.id, ev.id],
    );
    await db.query(`delete from agent_questions where id = $1`, [q.id]);
    expect((await rows(`select id from agent_answers where question_id = $1`, [q.id])).length).toBe(
      0,
    );
    // The score does not move because a question was tidied away.
    expect(await one(`select id from contribution_events where id = $1`, [ev.id])).toBeDefined();
  });
});

/**
 * The jsonb repair. What went wrong is worth pinning down: a stringified
 * object cast straight to jsonb is stored as a jsonb *string*, and every read
 * of it then sees characters instead of fields.
 */
describe('jsonb columns hold structure, not a string of one', () => {
  test('casting through text is what parses it', async () => {
    const direct = await one(`select jsonb_typeof($1::jsonb) as shape`, ['{"software_gap":80}']);
    const viaText = await one(`select jsonb_typeof($1::text::jsonb) as shape`, [
      '{"software_gap":80}',
    ]);
    // PGlite parses a text parameter on the way in, so both look right here.
    // The distinction this pins is the SQL, which is what production runs.
    expect(['string', 'object']).toContain(direct.shape);
    expect(viaText.shape).toBe('object');
  });

  test('the repair turns a jsonb string back into the object it spells', async () => {
    const n = await one(`insert into niches (slug, name) values ($1,'N') returning id`, [
      `r${Math.random()}`.replace('.', ''),
    ]);
    // Store the broken shape on purpose: a jsonb string containing JSON.
    await db.query(
      `insert into opportunities (niche_id, dimensions) values ($1, to_jsonb($2::text))`,
      [n.id, '{"software_gap":80}'],
    );
    const before = await one(
      `select jsonb_typeof(dimensions) as shape from opportunities where niche_id = $1`,
      [n.id],
    );
    expect(before.shape).toBe('string');

    await db.query(
      `update opportunities set dimensions = (dimensions #>> '{}')::jsonb
       where jsonb_typeof(dimensions) = 'string'`,
    );

    const after = await one(
      `select jsonb_typeof(dimensions) as shape, dimensions->>'software_gap' as gap
       from opportunities where niche_id = $1`,
      [n.id],
    );
    expect(after.shape).toBe('object');
    // And it is queryable as jsonb, which a string never was.
    expect(after.gap).toBe('80');
  });

  test('the repair leaves a correct row alone and can be run twice', async () => {
    const n = await one(`insert into niches (slug, name) values ($1,'N') returning id`, [
      `r${Math.random()}`.replace('.', ''),
    ]);
    await db.query(`insert into opportunities (niche_id, dimensions) values ($1, $2::jsonb)`, [
      n.id,
      '{"lead_value":70}',
    ]);
    const repair = () =>
      db.query(`update opportunities set dimensions = (dimensions #>> '{}')::jsonb
                where jsonb_typeof(dimensions) = 'string'`);
    await repair();
    await repair();
    const after = await one(
      `select dimensions->>'lead_value' as v from opportunities where niche_id = $1`,
      [n.id],
    );
    expect(after.v).toBe('70');
  });
});

/**
 * The revenue ledger. These tests are about what the database refuses, because
 * every one of them is a way somebody gets paid twice or paid wrong.
 */
describe('revenue ledger', () => {
  const niche = async () =>
    one(`insert into niches (slug, name) values ($1,'N') returning id`, [
      `v${Math.random()}`.replace('.', ''),
    ]);
  const person = async () =>
    one(`insert into users (email) values ($1) returning id`, [`v${Math.random()}@e.com`]);
  const event = (nicheId, gross, cost = 0, externalId = null) =>
    rows(
      `insert into revenue_events
         (external_id, niche_id, source_type, gross_amount_minor, direct_cost_minor, net_amount_minor)
       values ($1, $2, 'x402', $3, $4, $5)
       on conflict (external_id) do nothing
       returning id, net_amount_minor`,
      [externalId, nicheId, gross, cost, gross - cost],
    );

  test('a row whose parts do not add up cannot be written', async () => {
    const n = await niche();
    let threw = null;
    try {
      await db.query(
        `insert into revenue_events (niche_id, source_type, gross_amount_minor, direct_cost_minor, net_amount_minor)
         values ($1, 'x402', 1000, 30, 999)`,
        [n.id],
      );
    } catch (e) {
      threw = e.message;
    }
    expect(threw).toMatch(/revenue_events_adds_up/);
  });

  test('negative money is refused', async () => {
    const n = await niche();
    let threw = null;
    try {
      await db.query(
        `insert into revenue_events (niche_id, source_type, gross_amount_minor, direct_cost_minor, net_amount_minor)
         values ($1, 'x402', -100, 0, -100)`,
        [n.id],
      );
    } catch (e) {
      threw = e.message;
    }
    expect(threw).toMatch(/revenue_events_non_negative/);
  });

  test('a source type nobody defined is refused', async () => {
    const n = await niche();
    let threw = null;
    try {
      await db.query(
        `insert into revenue_events (niche_id, source_type, gross_amount_minor, net_amount_minor)
         values ($1, 'vibes', 100, 100)`,
        [n.id],
      );
    } catch (e) {
      threw = e.message;
    }
    expect(threw).toMatch(/revenue_events_source/);
  });

  test('a settlement delivered twice books once', async () => {
    const n = await niche();
    expect((await event(n.id, 100, 0, 'pay_1')).length).toBe(1);
    expect((await event(n.id, 100, 0, 'pay_1')).length).toBe(0);
    // A different payment is a different event.
    expect((await event(n.id, 100, 0, 'pay_2')).length).toBe(1);
  });

  test('one allocation per party per event, however many times it is run', async () => {
    const n = await niche();
    const u = await person();
    const [e] = await event(n.id, 1000);
    const alloc = () =>
      rows(
        `insert into revenue_allocations (revenue_event_id, influencer_id, allocation_type, share_bps, amount_minor)
         values ($1, $2, 'knowledge_influencer', 2000, 200)
         on conflict do nothing returning id`,
        [e.id, u.id],
      );
    expect((await alloc()).length).toBe(1);
    expect((await alloc()).length).toBe(0);
  });

  test('the platform row is unique too, despite having no influencer', async () => {
    const n = await niche();
    const [e] = await event(n.id, 1000);
    const platform = () =>
      rows(
        `insert into revenue_allocations (revenue_event_id, influencer_id, allocation_type, share_bps, amount_minor)
         values ($1, null, 'platform', 10000, 1000)
         on conflict do nothing returning id`,
        [e.id],
      );
    expect((await platform()).length).toBe(1);
    // A null influencer must not defeat the uniqueness, which a plain unique
    // index over a nullable column would.
    expect((await platform()).length).toBe(0);
  });

  test('an allocation can belong to at most one payout', async () => {
    const n = await niche();
    const u = await person();
    const [e] = await event(n.id, 1000);
    const a = await one(
      `insert into revenue_allocations (revenue_event_id, influencer_id, allocation_type, share_bps, amount_minor)
       values ($1, $2, 'knowledge_influencer', 2000, 200) returning id`,
      [e.id, u.id],
    );
    const p1 = await one(
      `insert into payouts (influencer_id, amount_minor) values ($1, 200) returning id`,
      [u.id],
    );
    const p2 = await one(
      `insert into payouts (influencer_id, amount_minor) values ($1, 200) returning id`,
      [u.id],
    );
    await db.query(`insert into payout_allocations (payout_id, allocation_id) values ($1, $2)`, [
      p1.id,
      a.id,
    ]);
    let threw = null;
    try {
      await db.query(`insert into payout_allocations (payout_id, allocation_id) values ($1, $2)`, [
        p2.id,
        a.id,
      ]);
    } catch (e2) {
      threw = e2.message;
    }
    // This is the one that matters: the same earning cannot be paid twice.
    expect(threw).toMatch(/duplicate key|payout_allocations_pkey/i);
  });

  test('a payout of nothing is refused', async () => {
    const u = await person();
    let threw = null;
    try {
      await db.query(`insert into payouts (influencer_id, amount_minor) values ($1, 0)`, [u.id]);
    } catch (e) {
      threw = e.message;
    }
    expect(threw).toMatch(/payouts_positive/);
  });

  test('deleting a niche keeps the record of money that moved', async () => {
    const n = await niche();
    const u = await person();
    const [e] = await event(n.id, 500);
    await db.query(
      `insert into revenue_allocations (revenue_event_id, influencer_id, allocation_type, share_bps, amount_minor)
       values ($1, $2, 'knowledge_influencer', 2000, 100)`,
      [e.id, u.id],
    );
    await db.query(`delete from niches where id = $1`, [n.id]);

    const kept = await one(`select niche_id, net_amount_minor from revenue_events where id = $1`, [
      e.id,
    ]);
    expect(kept).toBeDefined();
    // Detached, not deleted. Money that moved is not erased by tidying a niche.
    expect(kept.niche_id).toBeNull();
    expect(
      (await rows(`select id from revenue_allocations where revenue_event_id = $1`, [e.id])).length,
    ).toBe(1);
  });

  test('what is owed excludes reversed and already-paid allocations', async () => {
    const n = await niche();
    const u = await person();
    // One allocation per person per event, so five statuses need five events.
    // That constraint is doing its job; it caught an earlier version of this
    // very test trying to pay the same person five times out of one earning.
    for (const [amount, status] of [
      [100, 'accrued'],
      [50, 'eligible'],
      [700, 'paid'],
      [300, 'reversed'],
      [40, 'scheduled'],
    ]) {
      const [e] = await event(n.id, amount * 5);
      await db.query(
        `insert into revenue_allocations (revenue_event_id, influencer_id, allocation_type, share_bps, amount_minor, status)
         values ($1, $2, 'knowledge_influencer', 2000, $3, $4)`,
        [e.id, u.id, amount, status],
      );
    }
    const owed = await one(
      `select coalesce(sum(amount_minor) filter (where status in ('accrued','eligible')),0)::bigint as owed,
              coalesce(sum(amount_minor) filter (where status = 'paid'),0)::bigint as paid
       from revenue_allocations where influencer_id = $1`,
      [u.id],
    );
    expect(Number(owed.owed)).toBe(150);
    expect(Number(owed.paid)).toBe(700);
  });

  test('an allocation cannot claim more than the whole', async () => {
    const n = await niche();
    const [e] = await event(n.id, 100);
    let threw = null;
    try {
      await db.query(
        `insert into revenue_allocations (revenue_event_id, influencer_id, allocation_type, share_bps, amount_minor)
         values ($1, null, 'platform', 10001, 100)`,
        [e.id],
      );
    } catch (err) {
      threw = err.message;
    }
    expect(threw).toMatch(/revenue_allocations_bps/);
  });
});

describe('the VIN history tables', () => {
  test('a bought report is kept per VIN and replaced rather than duplicated', async () => {
    await db.query(`insert into auto_vin_lookups (vin, wmi) values ('1HGCM82633A004352', '1HG')`);
    for (const provider of ['first', 'second']) {
      await db.query(
        `insert into auto_vin_history (vin, provider, report)
         values ('1HGCM82633A004352', $1, '{"brands":[]}')
         on conflict (vin) do update set provider = excluded.provider, fetched_at = now()`,
        [provider],
      );
    }
    const row = await one(`select provider, count(*) over () as n from auto_vin_history`);
    expect(row.provider).toBe('second');
    expect(Number(row.n)).toBe(1);
  });

  test('a rating is appended, so a grade that moved is visible as a grade that moved', async () => {
    for (const [score, grade] of [
      [92, 'A'],
      [71, 'C'],
    ]) {
      await db.query(
        `insert into auto_vin_ratings (vin, score, grade, confidence, factors)
         values ('1HGCM82633A004352', $1, $2, 'moderate', '[]')`,
        [score, grade],
      );
    }
    const all = await rows(
      `select score from auto_vin_ratings where vin = '1HGCM82633A004352' order by computed_at, id`,
    );
    expect(all.map((r) => r.score)).toEqual([92, 71]);
  });

  test('dropping a decoded VIN takes its bought report with it', async () => {
    await db.query(`delete from auto_vin_lookups where vin = '1HGCM82633A004352'`);
    const left = await one(`select count(*)::int as n from auto_vin_history`);
    expect(left.n).toBe(0);
  });
});

describe('the weather collection migration', () => {
  test('the NWS source, its items and its feed all move, so nothing is ingested twice', async () => {
    // The whole risk in 0010: leave the source under `alerts` and the next
    // boot seeds a second one under `weather`, and both poll the National
    // Weather Service forever.
    const alerts = await one(
      `insert into collections (slug, name) values ('alerts', 'Alerts')
       on conflict (slug) do update set name = excluded.name returning id`,
    );
    const s = await one(
      `insert into sources (collection_id, adapter, slug, name)
       values ($1, 'nws-alerts', 'weather-alerts-us', 'W') returning id`,
      [alerts.id],
    );
    await db.query(
      `insert into items (source_id, collection_id, external_id, kind, title, content_hash)
       values ($1, $2, 'x1', 'alert', 'A warning', 'h1')`,
      [s.id, alerts.id],
    );
    await db.query(
      `insert into feeds (collection_id, slug, name) values ($1, 'severe-weather-us', 'Severe weather')`,
      [alerts.id],
    );

    // Exactly the statements migration 0010 runs, in its order.
    await db.query(
      `insert into collections (slug, name) values ('weather', 'Weather') on conflict (slug) do nothing`,
    );
    const w = await one(`select id from collections where slug = 'weather'`);
    await db.query(
      `update items i set collection_id = $1 from sources s
        where s.id = i.source_id and s.adapter = 'nws-alerts' and i.collection_id = $2`,
      [w.id, alerts.id],
    );
    await db.query(
      `update sources set collection_id = $1 where adapter = 'nws-alerts' and collection_id = $2`,
      [w.id, alerts.id],
    );
    await db.query(`update feeds set collection_id = $1 where slug = 'severe-weather-us'`, [w.id]);

    const moved = await one(
      `select
         (select count(*)::int from sources where adapter = 'nws-alerts' and collection_id = $1) as sources,
         (select count(*)::int from items where collection_id = $1) as items,
         (select count(*)::int from feeds where slug = 'severe-weather-us' and collection_id = $1) as feeds,
         (select count(*)::int from sources where adapter = 'nws-alerts' and collection_id = $2) as left_behind`,
      [w.id, alerts.id],
    );
    expect(moved).toEqual({ sources: 1, items: 1, feeds: 1, left_behind: 0 });
  });
});

describe('the podcasts cadence migration', () => {
  test('moves the two seeded sources to fifteen minutes and nothing else', async () => {
    // The gap 0013 closes: `insertSource` is idempotent on the slug but its
    // conflict clause never touches cadence_minutes, so raising the adapter's
    // cadence reached nothing that already existed.
    const c = await one(
      `insert into collections (slug, name) values ('podcasts', 'Podcasts')
       on conflict (slug) do update set name = excluded.name returning id`,
    );
    for (const [slug, cadence] of [
      ['podcasts-commercial', 60],
      ['podcasts-self-hosted', 60],
      // Somebody's own source against the same adapter, and one an operator has
      // already tuned. Neither may be touched.
      ['podcasts-mine', 60],
      ['podcasts-self-hosted-tuned', 5],
    ]) {
      await db.query(
        `insert into sources (collection_id, adapter, slug, name, cadence_minutes)
         values ($1, 'podcasts', $2, $2, $3)`,
        [c.id, slug, cadence],
      );
    }
    // Exactly the statement migration 0013 runs.
    const stmt = `update sources set cadence_minutes = 15, updated_at = now()
                   where slug in ('podcasts-commercial', 'podcasts-self-hosted')
                     and cadence_minutes = 60`;
    await db.query(stmt);

    const after = await one(
      `select
         (select cadence_minutes from sources where slug = 'podcasts-commercial') as commercial,
         (select cadence_minutes from sources where slug = 'podcasts-self-hosted') as self_hosted,
         (select cadence_minutes from sources where slug = 'podcasts-mine') as mine,
         (select cadence_minutes from sources where slug = 'podcasts-self-hosted-tuned') as tuned`,
    );
    expect(after).toEqual({ commercial: 15, self_hosted: 15, mine: 60, tuned: 5 });

    // Re-running must not walk a later decision back to 15.
    await db.query(`update sources set cadence_minutes = 60 where slug = 'podcasts-commercial'`);
    await db.query(`update sources set cadence_minutes = 30 where slug = 'podcasts-self-hosted'`);
    await db.query(stmt);
    const again = await one(
      `select
         (select cadence_minutes from sources where slug = 'podcasts-commercial') as commercial,
         (select cadence_minutes from sources where slug = 'podcasts-self-hosted') as self_hosted`,
    );
    // The first was genuinely back at 60, so it moves again; the second was
    // deliberately set to 30 and is left alone.
    expect(again).toEqual({ commercial: 15, self_hosted: 30 });
  });
});

describe('a source seeded off for a missing key', () => {
  test('turns on when the key arrives, unless somebody chose to stop it', async () => {
    const c = await one(
      `insert into collections (slug, name) values ('markets', 'Markets')
       on conflict (slug) do update set name = excluded.name returning id`,
    );
    // Never ran, seeded off (no key); ran and was switched off by a person;
    // never ran and on, but the key has since gone missing.
    for (const [slug, enabled, runs] of [
      ['alpaca-never-ran', false, 0],
      ['alpaca-stopped', false, 3],
      ['alpaca-key-gone', true, 0],
    ]) {
      await db.query(
        `insert into sources (collection_id, adapter, slug, name, enabled, run_count, last_run_at)
         values ($1, 'alpaca-news', $2, $2, $3, $4, case when $4 > 0 then now() else null end)`,
        [c.id, slug, enabled, runs],
      );
    }
    // Exactly the conflict clause insertSource runs, with what the seed now knows.
    const reseed = (slug, enabled) =>
      db.query(
        `insert into sources (collection_id, adapter, slug, name, enabled)
         values ($1, 'alpaca-news', $2, $2, $3)
         on conflict (slug) do update set
           name = excluded.name,
           enabled = case
             when sources.run_count = 0 and sources.last_run_at is null then excluded.enabled
             else sources.enabled
           end,
           updated_at = now()`,
        [c.id, slug, enabled],
      );
    await reseed('alpaca-never-ran', true);
    await reseed('alpaca-stopped', true);
    await reseed('alpaca-key-gone', false);
    const after = await one(
      `select
         (select enabled from sources where slug = 'alpaca-never-ran') as never_ran,
         (select enabled from sources where slug = 'alpaca-stopped') as stopped,
         (select enabled from sources where slug = 'alpaca-key-gone') as key_gone`,
    );
    expect(after).toEqual({ never_ran: true, stopped: false, key_gone: false });
  });
});
