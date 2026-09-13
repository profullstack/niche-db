import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

let db;
beforeAll(async () => {
  db = await PGlite.create();
  await db.exec(`
    create table items (id integer primary key, data jsonb not null);
    insert into items values
      (1, '{}'),
      (2, '{"location":{"lat":40,"lon":-74}}'),
      (3, '{"coverage":{"type":"Circle","coordinates":[-74,40],"radius_m":1000}}'),
      (4, '{"coverage":{"type":"Polygon","coordinates":[[[-75,39],[-73,39],[-73,41],[-75,41],[-75,39]]]}}'),
      (5, '{"location":{"lat":"unknown","lon":-74}}');
  `);
  const migration = await readFile(
    new URL('../packages/db/migrations/0023_geographic_queries.sql', import.meta.url),
    'utf8',
  );
  await db.exec(`begin; ${migration} commit;`);
}, 60_000);
afterAll(async () => db?.close());

test('the geographic migration builds its index over existing rows', async () => {
  const { rows } = await db.query(
    'select id from items where ndb_geo_box(data) is not null order by id',
  );
  expect(rows.map((row) => row.id)).toEqual([2, 3, 4]);
  expect((await db.query('select count(*)::int as n from items')).rows[0].n).toBe(5);
  const indexes = await db.query("select indexname from pg_indexes where tablename='items'");
  expect(indexes.rows.map((row) => row.indexname)).toContain('items_geo_box_idx');
});

test('nested geographic helpers resolve under an index-maintenance search path', async () => {
  await db.exec('set search_path = pg_catalog, pg_temp');
  try {
    const { rows } = await db.query(`
      select id, public.ndb_geo_distance(data,-74,40) as distance
      from public.items where public.ndb_geo_box(data) is not null order by id
    `);
    expect(rows).toEqual([
      { id: 2, distance: 0 },
      { id: 3, distance: 0 },
      { id: 4, distance: 0 },
    ]);
    await db.exec('reindex index public.items_geo_box_idx');
  } finally {
    await db.exec('reset search_path');
  }
});

test('the forward migration also repairs helpers installed before the fix', async () => {
  const { rows } = await db.query(
    "select oid::regprocedure::text as signature from pg_proc where proname like 'ndb_%'",
  );
  expect(rows).toHaveLength(7);
  for (const { signature } of rows) await db.exec(`alter function ${signature} reset search_path`);
  await db.exec(
    await readFile(
      new URL(
        '../packages/db/migrations/0024_geographic_function_search_path.sql',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  await db.exec('set search_path = pg_catalog, pg_temp');
  try {
    await db.exec('reindex index public.items_geo_box_idx');
    const result = await db.query(
      'select public.ndb_geo_distance(data,-74,40) as distance from public.items where id=4',
    );
    expect(result.rows[0].distance).toBe(0);
  } finally {
    await db.exec('reset search_path');
  }
});
