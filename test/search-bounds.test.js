import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pgliteSql } from './helpers/pglite.js';

process.env.DATABASE_URL ??= 'postgres://localhost/unused';
const q = await import('../packages/db/src/queries.js');

/*
 * The shapes behind the 2026-09-22 outage: a feed page narrowed by a word or a
 * tag, and the search page. Both now gather their newest matches first (see
 * MATCH_CAP in queries.js) and accept a statement timeout. PGlite plans nothing
 * like production, so these tests pin the contract, not the plan: the same rows
 * come back, newest first, the scanner's walk is untouched, and a timeout is a
 * no-op on a database without transactions.
 */

let db;
let sql;
let music;
let books;
let source;
let seq = 0;
const one = async (text, values = []) => (await db.query(text, values)).rows[0];
const ids = (rows) => rows.map((r) => Number(r.id));

async function item({ collection = music, kind = 'release', title, summary = '', tags = [] }) {
  const row = await one(
    `insert into items (collection_id, source_id, external_id, kind, title, summary, tags, data, published_at)
     values ($1, $2, $3, $4, $5, $6, $7, '{}', '2026-09-01') returning id`,
    [collection, source, String(++seq), kind, title, summary, tags],
  );
  return Number(row.id);
}

beforeAll(async () => {
  db = await new PGlite({ extensions: { citext, pg_trgm } });
  const dir = new URL('../packages/db/migrations/', import.meta.url);
  for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort())
    await db.exec(await readFile(new URL(f, dir), 'utf8'));
  sql = pgliteSql(db);
  // Collections are seeded at boot, not by a migration; the test makes its own.
  music = Number(
    (await one("insert into collections (slug, name) values ('music-test', 'Music') returning id"))
      .id,
  );
  books = Number(
    (await one("insert into collections (slug, name) values ('books-test', 'Books') returning id"))
      .id,
  );
  source = Number(
    (
      await one(
        "insert into sources (collection_id, adapter, slug, name) values ($1, 'musicbrainz', 'test-music', 'Test') returning id",
        [music],
      )
    ).id,
  );
}, 60000);

afterAll(async () => {
  await db?.close();
});

describe('a feed page narrowed by a word or a tag', () => {
  let love1;
  let love2;
  let tagged;
  let other;
  let elsewhere;
  beforeAll(async () => {
    love1 = await item({ title: 'Love Songs', tags: ['pop'] });
    other = await item({ title: 'Quiet Nights', summary: 'nothing to see', tags: ['jazz'] });
    tagged = await item({ title: 'Blue Train', tags: ['jazz', 'reissue'] });
    love2 = await item({ title: 'Modern Love', summary: 'a single', tags: ['pop'] });
    elsewhere = await item({ collection: books, title: 'Love in the Time of Cholera' });
  });

  test('a word gathers the matches of this collection only, newest first', async () => {
    const feed = { collection_id: music, query: { q: 'love' } };
    const rows = await q.feedItems(feed, { db: sql, timeoutMs: 5000 });
    expect(ids(rows)).toEqual([love2, love1]);
    expect(ids(rows)).not.toContain(elsewhere);
    expect(ids(rows)).not.toContain(other);
  });

  test('a title fragment still lands through the trigram fallback', async () => {
    const feed = { collection_id: music, query: { q: 'nigh' } };
    expect(ids(await q.feedItems(feed, { db: sql }))).toEqual([other]);
  });

  test('a tag page walks the same gathered path and honours before', async () => {
    const feed = { collection_id: music, query: { tags: ['jazz'] } };
    expect(ids(await q.feedItems(feed, { db: sql }))).toEqual([tagged, other]);
    expect(ids(await q.feedItems(feed, { db: sql, beforeId: tagged }))).toEqual([other]);
    expect(ids(await q.feedItems(feed, { db: sql, limit: 1 }))).toEqual([tagged]);
  });

  test('the delivery scanner keeps its ascending walk from a cursor', async () => {
    const feed = { collection_id: music, query: { q: 'love' } };
    expect(ids(await q.feedItems(feed, { db: sql, afterId: love1 }))).toEqual([love2]);
    expect(ids(await q.feedItems(feed, { db: sql, afterId: 0 }))).toEqual([love1, love2]);
  });

  test('an unnarrowed page is the whole collection, unchanged', async () => {
    const rows = await q.feedItems({ collection_id: music, query: {} }, { db: sql });
    expect(ids(rows)).toEqual([love2, tagged, other, love1]);
  });
});

describe('a collection page and the items API', () => {
  test('the newest rows of one collection, both directions, with before and a kind', async () => {
    const all = ids(await q.recentItems({ collectionId: music, db: sql, timeoutMs: 5000 }));
    expect(all.length).toBe(4);
    expect([...all].sort((a, b) => b - a)).toEqual(all);
    const oldest = ids(await q.recentItems({ collectionId: music, order: 'asc', db: sql }));
    expect(oldest).toEqual([...all].reverse());
    expect(ids(await q.recentItems({ collectionId: music, beforeId: all[0], db: sql }))).toEqual(
      all.slice(1),
    );
    expect(ids(await q.recentItems({ collectionId: books, kind: 'release', db: sql })).length).toBe(
      1,
    );
    expect(ids(await q.recentItems({ collectionId: books, kind: 'book', db: sql }))).toEqual([]);
  });

  test('a walk from a cursor and the date sorts keep their shape', async () => {
    const all = ids(await q.recentItems({ collectionId: music, db: sql }));
    const walked = ids(await q.recentItems({ collectionId: music, afterId: all[3], db: sql }));
    expect(walked.length).toBe(3);
    expect(walked).not.toContain(all[3]);
    const byUpdated = await q.recentItems({ collectionId: music, sort: 'updated', db: sql });
    expect(byUpdated.length).toBe(4);
  });

  test('a feed narrowed to sources resolves them without a join', async () => {
    const feed = { collection_id: music, query: { sources: ['test-music'] } };
    expect(ids(await q.feedItems(feed, { db: sql })).length).toBe(4);
    const none = { collection_id: music, query: { sources: ['no-such-source'] } };
    expect(await q.feedItems(none, { db: sql })).toEqual([]);
  });
});

describe('search', () => {
  test('ranks the gathered matches, everywhere or in one collection', async () => {
    const everywhere = ids(await q.searchItems('love', { db: sql, timeoutMs: 5000 }));
    expect(everywhere.length).toBe(3);
    const only = ids(await q.searchItems('love', { db: sql, collectionId: books }));
    expect(only.length).toBe(1);
    expect(await q.searchItems('   ', { db: sql })).toEqual([]);
  });

  test('a kind narrows it and a fragment falls back to the title', async () => {
    expect(ids(await q.searchItems('love', { db: sql, kind: 'book' }))).toEqual([]);
    expect((await q.searchItems('Chol', { db: sql })).length).toBe(1);
  });
});

describe('the statement timeout', () => {
  test('is recognised from the message Postgres sends and from its code', () => {
    expect(q.isStatementTimeout(new Error('canceling statement due to statement timeout'))).toBe(
      true,
    );
    expect(q.isStatementTimeout(Object.assign(new Error('x'), { code: '57014' }))).toBe(true);
    expect(q.isStatementTimeout(new Error('relation does not exist'))).toBe(false);
    expect(q.isStatementTimeout(null)).toBe(false);
  });

  test('is a no-op on a database without transactions', async () => {
    const rows = await q.searchItems('love', { db: sql, timeoutMs: 1 });
    expect(rows.length).toBe(3);
  });
});
