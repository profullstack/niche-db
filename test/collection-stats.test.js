import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { migratedPglite, pgliteSql } from './helpers/pglite.js';

const q = await import('../packages/db/src/queries.js');
const { computeCollectionStats, refreshCollectionStats } = await import(
  '../packages/core/src/collection-stats.js'
);

let db;
let sql;
let hosting;
let empty;
let source;
const one = async (text, values = []) => (await db.query(text, values)).rows[0];

beforeAll(async () => {
  db = await migratedPglite();
  sql = pgliteSql(db);
  hosting = Number(
    (await one("insert into collections(slug,name) values ('hosting','Hosting') returning id")).id,
  );
  empty = Number(
    (await one("insert into collections(slug,name) values ('empty','Empty') returning id")).id,
  );
  source = Number(
    (
      await one(
        "insert into sources(collection_id,adapter,slug,name,enabled) values ($1,'openserver','test-stats','Test',true) returning id",
        [hosting],
      )
    ).id,
  );
  await one(
    "insert into feeds(collection_id,slug,name,query,public) values ($1,'test-feed','Test',$2::jsonb,true)",
    [hosting, JSON.stringify({ kinds: ['plan'] })],
  );
  const rows = [
    ['plan', ['plan', 'kind:vps', 'country:de']],
    ['plan', ['plan', 'kind:dedicated', 'country:us']],
    ['plan', ['plan', 'kind:vps', 'country:us']],
    ['provider', ['provider', 'country:us']],
  ];
  let n = 0;
  for (const [kind, tags] of rows) {
    await one(
      'insert into items (collection_id,source_id,external_id,kind,title,tags,data,published_at,first_seen_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [
        hosting,
        source,
        `stats:${++n}`,
        kind,
        `Row ${n}`,
        tags,
        '{}',
        '2026-09-01',
        n === 1 ? '2020-01-01' : new Date().toISOString(),
      ],
    );
  }
});

afterAll(async () => {
  await db?.close();
});

describe('collection statistics', () => {
  test('computes the counts a collection page shows', async () => {
    const s = await computeCollectionStats(hosting, { db: sql });
    expect(s).toEqual({
      items: 4,
      itemsToday: 3,
      sources: 1,
      feeds: 1,
      kinds: [
        { kind: 'plan', n: 3 },
        { kind: 'provider', n: 1 },
      ],
      tags: expect.arrayContaining([
        { tag: 'country:us', n: 3 },
        { tag: 'plan', n: 3 },
        { tag: 'kind:vps', n: 2 },
      ]),
    });
    expect(s.tags[0].n).toBe(3);
  });

  test('a pass stores every collection without a row, then leaves fresh rows alone', async () => {
    expect(await q.storedCollectionStats(hosting, { db: sql })).toBeNull();
    const log = [];
    const first = await refreshCollectionStats({
      db: sql,
      log: (m) => log.push(m),
      staleMs: 60_000,
    });
    expect(first.refreshed).toBe(first.due);
    expect(first.failed).toEqual([]);
    expect(log.some((m) => m.includes('[stats] hosting: 4 items, 2 kinds'))).toBe(true);

    const stored = await q.storedCollectionStats(hosting, { db: sql });
    expect(stored.items).toBe(4);
    expect(stored.items_today).toBe(3);
    expect(stored.kinds).toEqual([
      { kind: 'plan', n: 3 },
      { kind: 'provider', n: 1 },
    ]);
    expect(stored.tags[0]).toEqual({ tag: 'country:us', n: 3 });
    expect(stored.computed_at).toBeTruthy();
    const none = await q.storedCollectionStats(empty, { db: sql });
    expect(none.items).toBe(0);
    expect(none.kinds).toEqual([]);

    const second = await refreshCollectionStats({ db: sql, log: () => {}, staleMs: 60_000 });
    expect(second.due).toBe(0);
    expect(second.refreshed).toBe(0);
  });

  test('a stale row is recomputed and the budget stops a pass', async () => {
    const later = Date.now() + 2 * 60_000;
    const budgeted = await refreshCollectionStats({
      db: sql,
      log: () => {},
      staleMs: 60_000,
      budgetMs: -1,
      now: () => later,
    });
    expect(budgeted.due).toBeGreaterThan(1);
    expect(budgeted.refreshed).toBe(0);
    expect(budgeted.skipped).toBe(budgeted.due);
    const full = await refreshCollectionStats({
      db: sql,
      log: () => {},
      staleMs: 60_000,
      now: () => later,
    });
    expect(full.refreshed).toBe(full.due);
  });

  test('site totals are read from the stored rows, not counted live', async () => {
    const s = await q.siteStats({ db: sql });
    expect(s.items).toBe(4);
    expect(s.items_today).toBe(3);
    expect(s.sources).toBe(1);
    expect(s.counted).toBeUndefined();
  });
});
