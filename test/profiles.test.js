import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { ADAPTERS, adapterByName } from '../packages/adapters/src/index.js';
import {
  appOf,
  docItem,
  openprofiles,
  parseListing,
  sameOrigin,
} from '../packages/adapters/src/openprofiles.js';
// Imported by path: this directory is outside every workspace, so the package only resolves from inside one.
import {
  parseOpenProfile,
  samePerson,
} from '../packages/core/node_modules/@profullstack/openprofile/src/index.ts';
import { normaliseItem } from '../packages/core/src/adapter.js';
import {
  assemble,
  build,
  cleanHandle,
  keysOf,
  parseRef,
  profileItem,
  profilePath,
  profileRef,
  profileSlug,
} from '../packages/core/src/profiles.js';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';
const { COLLECTIONS, DEFAULT_FEEDS } = await import('../packages/core/src/seed.js');

/**
 * People: the adapter that reads the apps' listings, the pure merge behind
 * /c/profiles, the URL shapes, and the tables. The rules under test are the
 * spec's: a shared account URL is one person, a shared name is two, an
 * owner's edit survives every re-read, a document is believed only from the
 * host that listed it.
 */

const fixture = (name) =>
  readFile(new URL(`../packages/adapters/test/fixtures/${name}`, import.meta.url), 'utf8');

const P0D = 'https://p0dcasters.com/api/openprofiles';
const OG = 'https://outreachgraph.com/api/v1/openprofiles';

async function routes() {
  return {
    [P0D]: await fixture('openprofiles-p0dcasters.json'),
    [OG]: await fixture('openprofiles-outreachgraph.json'),
    'https://p0dcasters.com/podcast/beer-and-conversation/openprofile.md':
      await fixture('openprofile-pigweed.md'),
    'https://p0dcasters.com/podcast/the-analytical-engine/openprofile.md': await fixture(
      'openprofile-ada-p0dcasters.md',
    ),
    'https://outreachgraph.com/people/per_01ada/openprofile.md': await fixture(
      'openprofile-ada-outreachgraph.md',
    ),
    'https://outreachgraph.com/people/per_02ada/openprofile.md': await fixture(
      'openprofile-other-ada.md',
    ),
  };
}

function ctx(table, over = {}) {
  const seen = [];
  const answer = async (url) => {
    seen.push(url);
    // The longest matching prefix wins, so a cursor page is not answered by the listing's first page.
    const hit = Object.entries(table)
      .filter(([prefix]) => url.startsWith(prefix))
      .sort((a, b) => b[0].length - a[0].length)[0];
    if (!hit) throw new Error(`404 from ${url}`);
    return hit[1];
  };
  return {
    seen,
    ctx: {
      cursor: {},
      env: {},
      log: () => {},
      budget: 0,
      deadline: Date.now() + 60_000,
      http: {
        json: async (url) => JSON.parse(await answer(url)),
        jsonOrNull: async (url) => {
          try {
            return JSON.parse(await answer(url));
          } catch (err) {
            if (/^404/.test(err.message)) return null;
            throw err;
          }
        },
        text: answer,
      },
      ...over,
      config: { ...openprofiles.defaults, paceMs: 0, ...(over.config ?? {}) },
    },
  };
}

describe('the openprofiles adapter', () => {
  test('is registered for the profiles collection, and the collection and its feeds are seeded', () => {
    expect(adapterByName('openprofiles')).toBe(openprofiles);
    expect(ADAPTERS.filter((a) => a.name === 'openprofiles').length).toBe(1);
    expect(COLLECTIONS.find((c) => c.slug === 'profiles')?.name).toBe('People');
    expect(DEFAULT_FEEDS.filter((f) => f.collection === 'profiles').map((f) => f.slug)).toEqual([
      'all-people',
      'podcasters',
      'guests',
    ]);
    expect(openprofiles.defaultSources[0].config.urls).toEqual([P0D, OG]);
  });

  test('names the app after the listing host and believes a document only from that host', () => {
    expect(appOf(P0D)).toBe('p0dcasters');
    expect(appOf(OG)).toBe('outreachgraph');
    expect(sameOrigin(P0D, 'https://p0dcasters.com/podcast/x/openprofile.md')).toBe(true);
    expect(sameOrigin(P0D, 'https://www.p0dcasters.com/x/openprofile.md')).toBe(true);
    expect(sameOrigin(P0D, 'https://evil.example/openprofile.md')).toBe(false);
    expect(sameOrigin(P0D, 'https://p0dcasters.com.evil.example/x')).toBe(false);
  });

  test('reads a listing page, a bare array too, and skips entries with no URL', () => {
    const { entries, next } = parseListing({
      openprofiles: [{ id: 1, url: 'https://a.example/p.md', name: 'A' }, { name: 'no url' }],
      next: 'abc',
    });
    expect(entries.length).toBe(1);
    expect(entries[0].id).toBe('1');
    expect(next).toBe('abc');
    expect(parseListing([{ url: 'https://a.example/p.md' }]).entries.length).toBe(1);
    expect(parseListing({}).entries).toEqual([]);
  });

  test('one pull: every document from both apps, the off-origin one dropped, the cursor advanced', async () => {
    const t = ctx(await routes(), { config: { urls: [P0D, OG] } });
    const { items, cursor, note } = await openprofiles.pull(t.ctx);
    expect(items.map((i) => i.title)).toEqual([
      'Pigweed and Crowhill',
      'Ada Lovelace',
      'Ada Lovelace',
      'Ada Lovelace',
    ]);
    expect(t.seen.some((u) => u.includes('evil.example'))).toBe(false);
    expect(note).toContain('1 off-origin dropped');
    expect(cursor.since[P0D]).toBe('2026-09-13T04:05:00.000Z');
    expect(cursor.since[OG]).toBe('2026-09-13T03:01:00.000Z');
    expect(cursor.complete).toEqual({ [P0D]: true, [OG]: true });
    expect(cursor.resume).toEqual({});
    for (const it of items) {
      expect(it.kind).toBe('openprofile');
      expect(it.data.doc).toContain('# ');
      expect(normaliseItem(it)).not.toBeNull();
    }
    // The next run asks each listing for what changed since.
    const again = ctx(await routes(), { config: { urls: [P0D] }, cursor });
    await openprofiles.pull(again.ctx);
    expect(again.seen[0]).toContain('since=2026-09-13T04%3A05%3A00.000Z');
  });

  test('a walk the clock cuts resumes where it stopped, soon, and only a finished walk sets since', async () => {
    // A listing of two pages; the first run's deadline passes after the first document.
    const table = await routes();
    const page1 = JSON.parse(table[P0D]);
    const page2 = { openprofiles: page1.openprofiles.slice(2), next: null };
    page1.openprofiles = page1.openprofiles.slice(0, 2);
    page1.next = 'p2';
    table[P0D] = JSON.stringify(page1);
    table[`${P0D}?cursor=p2`] = JSON.stringify(page2);
    // The deadline is read once when pull starts, so it is set just ahead and the
    // first document fetch takes longer than that.
    const cut = ctx(table, { config: { urls: [P0D] } });
    cut.ctx.deadline = Date.now() + 30;
    const realText = cut.ctx.http.text;
    let docs = 0;
    cut.ctx.http.text = async (u) => {
      docs += 1;
      if (docs === 1) await Bun.sleep(50);
      return realText(u);
    };
    const first = await openprofiles.pull(cut.ctx);
    expect(first.items.length).toBe(1);
    expect(first.nextInMinutes).toBe(2);
    expect(first.cursor.since[P0D]).toBeUndefined();
    expect(first.cursor.complete[P0D]).toBeUndefined();
    expect(first.cursor.resume[P0D]).toEqual({ at: '', newest: '2026-09-13T04:00:00.000Z' });

    // The second run carries on: first page again (a document twice is a no-op), then page two.
    const second = ctx(table, { config: { urls: [P0D] }, cursor: first.cursor });
    const done = await openprofiles.pull(second.ctx);
    expect(second.seen[0]).not.toContain('since=');
    expect(done.items.map((i) => i.title)).toEqual(['Pigweed and Crowhill', 'Ada Lovelace']);
    expect(done.nextInMinutes).toBeUndefined();
    expect(done.cursor.resume).toEqual({});
    expect(done.cursor.complete[P0D]).toBe(true);
    expect(done.cursor.since[P0D]).toBe('2026-09-13T04:05:00.000Z');
    expect(second.seen.some((u) => u.includes('cursor=p2'))).toBe(true);
  });

  test('a listing that stops answering mid-walk (402 past its allowance) is a cut, not a failure', async () => {
    const table = await routes();
    const page1 = JSON.parse(table[P0D]);
    page1.openprofiles = page1.openprofiles.slice(0, 2);
    page1.next = 'p2';
    table[P0D] = JSON.stringify(page1);
    const t = ctx(table, { config: { urls: [P0D] } });
    const realJson = t.ctx.http.jsonOrNull;
    t.ctx.http.jsonOrNull = async (u) => {
      if (u.includes('cursor=p2'))
        throw new Error('402 from https://p0dcasters.com/api/openprofiles?cursor=p2');
      return realJson(u);
    };
    const out = await openprofiles.pull(t.ctx);
    expect(out.items.length).toBe(2);
    expect(out.nextInMinutes).toBe(2);
    expect(out.cursor.resume[P0D]).toEqual({ at: 'p2', newest: '2026-09-13T04:05:00.000Z' });
    expect(out.cursor.complete[P0D]).toBeUndefined();
    expect(out.note).toContain('402');
    // The next run asks for page two straight away, not page one again.
    const again = ctx(table, { config: { urls: [P0D] }, cursor: out.cursor });
    await openprofiles.pull(again.ctx).catch(() => {});
    expect(again.seen[0]).toContain('cursor=p2');
  });

  test('a since recorded before any walk finished is not trusted: the next run walks everything', async () => {
    const t = ctx(await routes(), {
      config: { urls: [P0D] },
      cursor: { since: { [P0D]: '2026-09-13T04:05:00.000Z' } },
    });
    await openprofiles.pull(t.ctx);
    expect(t.seen[0]).not.toContain('since=');
  });

  test('a listing that is not there yet is an empty page, not a failure', async () => {
    const t = ctx({}, { config: { urls: ['https://notyet.example/api/openprofiles'] } });
    const { items, note } = await openprofiles.pull(t.ctx);
    expect(items).toEqual([]);
    expect(note).toContain('not there yet');
  });

  test('a document with no name at all is not a profile', () => {
    expect(
      docItem({
        listingUrl: P0D,
        entry: { url: 'https://p0dcasters.com/x/openprofile.md', name: null },
        doc: '- Kind: person\n',
        fetchedAt: '2026-09-13T00:00:00.000Z',
      }),
    ).toBeNull();
  });
});

describe('one person from several apps', () => {
  let p0dAda;
  let ogAda;
  let otherAda;
  beforeAll(async () => {
    p0dAda = await fixture('openprofile-ada-p0dcasters.md');
    ogAda = await fixture('openprofile-ada-outreachgraph.md');
    otherAda = await fixture('openprofile-other-ada.md');
  });

  test('a shared account URL is one person; a shared name is two', () => {
    expect(samePerson(parseOpenProfile(p0dAda), parseOpenProfile(ogAda))).toBe(true);
    expect(samePerson(parseOpenProfile(p0dAda), parseOpenProfile(otherAda))).toBe(false);
    const keys = keysOf(p0dAda);
    expect(keys).toContain('account:bsky.app/profile/ada.example');
    expect(keys).toContain('web:ada.example');
    expect(keysOf(ogAda).some((k) => keys.includes(k))).toBe(true);
    expect(keysOf(otherAda).some((k) => keys.includes(k))).toBe(false);
  });

  test('the merge keeps the first app as primary, unions accounts and topics, carries both sections', () => {
    const built = build({ sourceDocs: [p0dAda, ogAda], overrides: null });
    expect(built.name).toBe('Ada Lovelace');
    expect(built.headline).toBe('Host of The Analytical Engine.');
    expect(built.view.identity.location).toBe('London');
    expect(built.view.accounts.map((a) => a.url)).toEqual([
      'https://bsky.app/profile/ada.example',
      'https://github.com/ada',
    ]);
    expect(built.view.accounts[0].network).toBe('bluesky');
    expect(built.view.topics).toEqual(['computing history', 'mathematics', 'engines']);
    expect(built.view.broadcasts[0].Show).toBe('The Analytical Engine');
    expect(built.view.guest.Expertise).toBe('analytical engines, early computing');
    expect(built.keys).toContain('email:ada@example.com');
    expect(built.markdown).toContain('## Broadcast');
    expect(built.markdown).toContain('## Guest');
  });

  test('the owner’s overlay wins and survives a re-pull that adds a source', () => {
    const overrides = {
      headline: 'Countess. Programmer. Ask me about engines.',
      identity: { Email: null, Location: 'Nottingham' },
      sections: { guest: '- **Available**: yes\n- **Rate**: free', topics: 'none' },
    };
    const first = build({ sourceDocs: [p0dAda], overrides });
    expect(first.headline).toBe('Countess. Programmer. Ask me about engines.');
    expect(first.view.guest.Rate).toBe('free');
    expect(first.view.topics).toEqual([]);
    // The second app arrives with an email and a different Guest section.
    const second = build({ sourceDocs: [p0dAda, ogAda], overrides });
    expect(second.headline).toBe('Countess. Programmer. Ask me about engines.');
    expect(second.view.identity.email).toBeUndefined();
    expect(second.view.identity.location).toBe('Nottingham');
    expect(second.view.guest).toEqual({ Available: 'yes', Rate: 'free' });
    expect(second.view.topics).toEqual([]);
    // The source's accounts still arrive, because the owner did not write Accounts.
    expect(second.view.accounts.map((a) => a.url)).toContain('https://github.com/ada');
    // And the released email is no longer an identity key.
    expect(second.keys).not.toContain('email:ada@example.com');
  });

  test('an empty set of sources is still a document', () => {
    expect(assemble([], null).name).toBe('Unnamed');
  });
});

describe('the URL shapes', () => {
  test('slug-id: the id resolves, the name is cosmetic; a handle is its own shape', () => {
    expect(profileSlug('Ada Lovelace')).toBe('ada-lovelace');
    expect(profileSlug('!!!')).toBe('person');
    expect(profileRef({ id: 12, name: 'Ada Lovelace', slug: 'ada-lovelace' })).toBe(
      'ada-lovelace-12',
    );
    expect(profileRef({ id: 12, name: 'Ada', slug: 'ada', handle: 'ada' })).toBe('ada');
    expect(profilePath({ id: 12, name: 'Ada Lovelace' })).toBe('/c/profiles/ada-lovelace-12');
    expect(parseRef('ada-lovelace-12')).toEqual({ id: 12, slug: 'ada-lovelace', handle: null });
    expect(parseRef('wrong-name-12')).toEqual({ id: 12, slug: 'wrong-name', handle: null });
    expect(parseRef('12')).toEqual({ id: 12, slug: '', handle: null });
    expect(parseRef('ada')).toEqual({ id: null, slug: null, handle: 'ada' });
    expect(parseRef('Ada-Lovelace')).toEqual({ id: null, slug: null, handle: 'ada-lovelace' });
    expect(parseRef('')).toBeNull();
    expect(parseRef('a b')).toBeNull();
  });

  test('a handle may not look like a slug-id or a bare number', () => {
    expect(cleanHandle('@Ada-Lovelace')).toBe('ada-lovelace');
    expect(cleanHandle('ada-12')).toBeNull();
    expect(cleanHandle('12')).toBeNull();
    expect(cleanHandle('a')).toBeNull();
    expect(cleanHandle('has space')).toBeNull();
  });

  test('the collection row for a person: one item, keyed on the profile, tagged for the feeds', async () => {
    const built = build({
      sourceDocs: [await fixture('openprofile-ada-p0dcasters.md')],
      overrides: null,
    });
    const item = normaliseItem(
      profileItem(
        {
          id: 7,
          name: built.name,
          slug: 'ada-lovelace',
          updated_at: '2026-09-13T05:00:00.000Z',
          sources: [{ app: 'p0dcasters', source_url: 'https://p0dcasters.com/x/openprofile.md' }],
        },
        'https://nichedb.test',
        built,
      ),
    );
    expect(item.externalId).toBe('profile:7');
    expect(item.kind).toBe('person');
    expect(item.url).toBe('https://nichedb.test/c/profiles/ada-lovelace-7');
    expect(item.imageUrl).toBe('https://ada.example/ada.jpg');
    expect(item.tags).toContain('broadcast');
    expect(item.tags).toContain('podcaster');
    expect(item.tags).toContain('from:p0dcasters');
    expect(item.tags).not.toContain('guest');
    expect(item.data.openprofile).toBe(
      'https://nichedb.test/c/profiles/ada-lovelace-7/openprofile.md',
    );
  });
});

describe('the tables', () => {
  let db;
  beforeAll(async () => {
    db = await new PGlite({ extensions: { citext, pg_trgm } });
    const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
    for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
      await db.exec(await readFile(dir + f, 'utf8'));
    }
  }, 60_000);
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];

  test('one identity key belongs to one profile, and a source URL to one profile', async () => {
    const a = await one(`insert into profiles (slug, name) values ('ada', 'Ada') returning id`);
    const b = await one(`insert into profiles (slug, name) values ('ada', 'Ada') returning id`);
    await db.query(`insert into profile_identities (profile_id, key) values ($1, $2)`, [
      a.id,
      'account:github.com/ada',
    ]);
    await expect(
      db.query(`insert into profile_identities (profile_id, key) values ($1, $2)`, [
        b.id,
        'account:github.com/ada',
      ]),
    ).rejects.toThrow(/profile_identities_pkey|duplicate/);
    await db.query(
      `insert into profile_sources (profile_id, app, source_url, doc) values ($1, 'p0dcasters', 'https://p0dcasters.com/x/openprofile.md', '# Ada')`,
      [a.id],
    );
    await expect(
      db.query(
        `insert into profile_sources (profile_id, app, source_url, doc) values ($1, 'p0dcasters', 'https://p0dcasters.com/x/openprofile.md', '# Ada')`,
        [b.id],
      ),
    ).rejects.toThrow(/duplicate|unique/);
  });

  test('a handle is unique, case-insensitive, and may not look like a slug-id', async () => {
    const a = await one(
      `insert into profiles (slug, name, handle) values ('ada', 'Ada', 'ada-lovelace') returning id`,
    );
    expect(a.id).toBeGreaterThan(0);
    await expect(
      db.query(`insert into profiles (slug, name, handle) values ('ada', 'Ada', 'Ada-Lovelace')`),
    ).rejects.toThrow(/duplicate|unique/);
    await expect(
      db.query(`insert into profiles (slug, name, handle) values ('ada', 'Ada', 'ada-12')`),
    ).rejects.toThrow(/profiles_handle_shape/);
    await expect(
      db.query(`insert into profiles (slug, name, handle) values ('ada', 'Ada', '12')`),
    ).rejects.toThrow(/profiles_handle_shape/);
  });

  test('deleting a profile takes its keys and sources with it', async () => {
    const p = await one(`insert into profiles (slug, name) values ('x', 'X') returning id`);
    await db.query(
      `insert into profile_identities (profile_id, key) values ($1, 'web:x.example')`,
      [p.id],
    );
    await db.query(`delete from profiles where id = $1`, [p.id]);
    expect(
      await one(`select 1 from profile_identities where key = 'web:x.example'`),
    ).toBeUndefined();
  });
});
