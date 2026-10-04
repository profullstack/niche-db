import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

/*
 * Migration 0035 takes the `datasets` collection off the site. Run against the
 * slice of the schema it touches, with the same cascades, so what it deletes,
 * what it keeps and the restore it documents are all checked here rather than
 * on production.
 */

const MIGRATION = new URL(
  '../packages/db/migrations/0035_retire_academic_datasets.sql',
  import.meta.url,
);

let db;
let sql;
const count = async (q) => (await db.query(q)).rows[0].n;

beforeAll(async () => {
  db = await PGlite.create();
  await db.exec(`
    create table collections (id bigserial primary key, slug text not null unique, name text not null);
    create table sources (
      id bigserial primary key,
      collection_id bigint not null references collections(id) on delete cascade,
      slug text not null unique, adapter text not null);
    create table runs (id bigserial primary key,
      source_id bigint not null references sources(id) on delete cascade);
    create table items (
      id bigserial primary key,
      collection_id bigint not null references collections(id) on delete cascade,
      source_id bigint not null references sources(id) on delete cascade,
      external_id text not null, kind text not null default 'item', title text not null,
      summary text, url text, image_url text, published_at timestamptz,
      time_known boolean not null default true, precision text not null default 'minute',
      tags text[] not null default '{}', data jsonb not null default '{}', content_hash text,
      first_seen_at timestamptz not null default now(), updated_at timestamptz not null default now(),
      search tsvector generated always as (to_tsvector('simple', coalesce(title, ''))) stored,
      unique (source_id, external_id));
    create table feeds (id bigserial primary key,
      collection_id bigint not null references collections(id) on delete cascade,
      slug text not null unique);
    create table follows (feed_id bigint not null references feeds(id) on delete cascade);
    create table collection_stats (
      collection_id bigint primary key references collections(id) on delete cascade);
    create table niches (id bigserial primary key, slug text not null unique,
      status text not null default 'open',
      collection_id bigint references collections(id) on delete set null);

    insert into collections (slug, name) values ('datasets', 'Datasets'), ('dht', 'DHT');
    insert into sources (collection_id, slug, adapter) values
      (1, 'academic-datasets', 'academic-datasets'), (2, 'bittorrented-dht', 'bittorrented-dht');
    insert into runs (source_id) values (1), (2);
    insert into items (collection_id, source_id, external_id, kind, title, tags, data) values
      (1, 1, 'cab7744573688b0b39c521ef66453435785762ac', 'dataset', 'LUMINOUS', '{mirrored}', '{"spec":"openfile"}'),
      (1, 1, '0123456789abcdef0123456789abcdef01234567', 'dataset', 'MIT 6.006', '{}', '{}'),
      (2, 2, '86d6675e152370409b120538f7481c451a083fe9', 'torrent', 'salem spirits', '{}', '{}');
    insert into feeds (collection_id, slug) values
      (1, 'datasets-latest'), (1, 'datasets-mirrored'), (1, 'datasets-public-domain'), (2, 'dht-latest');
    insert into follows values (1), (4);
    insert into collection_stats values (1), (2);
    insert into niches (slug, collection_id) values ('datasets', 1), ('dht', 2);
  `);
  sql = await readFile(MIGRATION, 'utf8');
  await db.exec(`begin; ${sql} commit;`);
}, 60_000);
afterAll(async () => db?.close());

test('the collection, its source, runs, items, feeds, follows and stats are gone', async () => {
  expect(await count(`select count(*)::int as n from collections where slug = 'datasets'`)).toBe(0);
  expect(
    await count(`select count(*)::int as n from sources where slug = 'academic-datasets'`),
  ).toBe(0);
  expect(await count(`select count(*)::int as n from items where kind = 'dataset'`)).toBe(0);
  expect(await count(`select count(*)::int as n from feeds where slug like 'datasets-%'`)).toBe(0);
  expect(await count('select count(*)::int as n from runs')).toBe(1);
  expect(await count('select count(*)::int as n from follows')).toBe(1);
  expect(await count('select count(*)::int as n from collection_stats')).toBe(1);
});

test('nothing outside the collection is touched', async () => {
  expect(await count(`select count(*)::int as n from items where kind = 'torrent'`)).toBe(1);
  expect(await count(`select count(*)::int as n from feeds where slug = 'dht-latest'`)).toBe(1);
  const { rows } = await db.query(`select status, collection_id from niches where slug = 'dht'`);
  expect(rows[0]).toEqual({ status: 'open', collection_id: 2 });
});

test('the items are archived and the niche is archived, not deleted', async () => {
  const { rows } = await db.query(
    'select external_id, title, tags, data, retired_collection, retired_at from retired_items order by title',
  );
  expect(rows.map((r) => r.title)).toEqual(['LUMINOUS', 'MIT 6.006']);
  expect(rows.every((r) => r.retired_collection === 'datasets' && r.retired_at)).toBe(true);
  expect(rows[0].data).toEqual({ spec: 'openfile' });
  const niche = await db.query(`select status, collection_id from niches where slug = 'datasets'`);
  expect(niche.rows[0]).toEqual({ status: 'archived', collection_id: null });
});

test('the restore the migration documents brings every item back', async () => {
  // As the seed would, once the adapter and collection are registered again.
  await db.exec(`
    insert into collections (slug, name) values ('datasets', 'Datasets');
    insert into sources (collection_id, slug, adapter)
      select id, 'academic-datasets', 'academic-datasets' from collections where slug = 'datasets';
  `);
  const restore = sql
    .split('\n')
    .filter((l) => l.startsWith('--   '))
    .map((l) => l.slice(5))
    .join('\n');
  expect(restore).toContain('insert into items');
  await db.exec(restore);
  expect(
    await count(`select count(*)::int as n from items i join collections c on c.id = i.collection_id
                  where c.slug = 'datasets' and i.kind = 'dataset'`),
  ).toBe(2);
  const niche = await db.query(
    `select status, collection_id is not null as linked from niches where slug = 'datasets'`,
  );
  expect(niche.rows[0]).toEqual({ status: 'open', linked: true });
  // Running it twice adds nothing.
  await db.exec(restore);
  expect(await count(`select count(*)::int as n from items where kind = 'dataset'`)).toBe(2);
});
