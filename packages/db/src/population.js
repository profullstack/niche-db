import { slugify } from '@nichedb/core/adapter';
import { inTag, KIND, keyTag, LEVELS, levelTag } from '@nichedb/core/population';
import { sql } from './index.js';
import { pgArray } from './queries.js';

/**
 * Reads for the population tree.
 *
 * Every question is a tag containment on `(collection_id, kind, tags)`, the
 * GIN index 0030 built for exactly this shape: "this area" is `key-…`, "its
 * children" is `in-… AND level-…`. See core/population.js for why the tree
 * lives in tags.
 *
 * Ordering by population needs the heap (`data->>'population'`), so the
 * matching ids are gathered index-only first and sorted after, the pattern
 * every page here uses since the planner walked items_pkey backwards for
 * eighteen minutes (PR #112). The largest set a caller can ask for is every
 * ZIP in the country, about 34,000 rows, which sorts well inside the
 * statement timeout.
 *
 * Every read takes an optional `db`, as queries.js does, so a test can run it
 * against a migrated in-memory Postgres.
 */

const TIMEOUT_MS = 15_000;
const MAX_LIMIT = 500;

let collectionIdCache = null;
async function populationCollectionId(db) {
  if (db === sql && collectionIdCache !== null) return collectionIdCache;
  const [row] = await db`select id from collections where slug = 'population'`;
  // Not cached until it exists: a page asked before the first boot's seed
  // must not pin "no such collection" for the life of the process.
  if (!row) return 0;
  if (db === sql) collectionIdCache = row.id;
  return row.id;
}

/** A read under the statement timeout, on a client that can open a transaction. */
function bounded(db, fn) {
  if (typeof db.begin !== 'function') return fn(db);
  return db.begin(async (tx) => {
    await tx.unsafe(`set local statement_timeout = ${TIMEOUT_MS}`);
    return fn(tx);
  });
}

const columns = (d) => d`
  i.id, i.title, i.summary, i.url, i.data, i.tags, i.published_at, i.updated_at,
  s.slug as source_slug, s.name as source_name
`;

/** One area by its key, or null. Two sources never write the same key. */
export async function areaByKey(key, { db = sql } = {}) {
  const cid = await populationCollectionId(db);
  const rows = await bounded(
    db,
    (d) => d`
      select ${columns(d)}
      from items i join sources s on s.id = i.source_id
      where i.collection_id = ${cid} and i.kind = ${KIND}
        and i.tags @> ${pgArray([keyTag(key)])}::text[]
      order by i.updated_at desc
      limit 1`,
  );
  return rows[0] ?? null;
}

/**
 * The areas of one level inside another (or anywhere, with no `within`),
 * largest first, with the total for paging.
 */
export async function areasIn({
  within = null,
  level,
  limit = 50,
  offset = 0,
  order = 'population',
  db = sql,
}) {
  if (!LEVELS.includes(level)) throw new Error(`level must be one of ${LEVELS.join(', ')}`);
  const cid = await populationCollectionId(db);
  const tags = [levelTag(level), ...(within ? [inTag(within)] : [])];
  const rows = Math.min(Math.max(1, Number(limit) || 50), MAX_LIMIT);
  const skip = Math.max(0, Number(offset) || 0);
  const byName = order === 'name';
  const found = await bounded(
    db,
    (d) => d`
      with m as materialized (
        select i.id from items i
        where i.collection_id = ${cid} and i.kind = ${KIND}
          and i.tags @> ${pgArray(tags)}::text[]
      )
      select ${columns(d)}, count(*) over () as total
      from m join items i on i.id = m.id join sources s on s.id = i.source_id
      order by
        case when ${byName}::boolean then i.title end asc,
        (i.data->>'population')::double precision desc nulls last,
        i.title asc
      limit ${rows} offset ${skip}`,
  );
  return { total: Number(found[0]?.total ?? 0), areas: found.map(({ total, ...r }) => r) };
}

/** How many areas of each level sit inside one, for the page's tabs. */
export async function childCounts(key, { db = sql } = {}) {
  const cid = await populationCollectionId(db);
  const found = await bounded(
    db,
    (d) => d`
      select l.level, (
        select count(*) from items i
        where i.collection_id = ${cid} and i.kind = ${KIND}
          and i.tags @> array[${inTag(key)}::text, 'level-' || l.level]
      ) as n
      from unnest(${pgArray(LEVELS)}::text[]) as l(level)`,
  );
  return Object.fromEntries(found.map((r) => [r.level, Number(r.n)]));
}

/** Areas called this, largest first: every Springfield, every Paris. */
export async function areasNamed(name, { limit = 20, db = sql } = {}) {
  const slug = slugify(name);
  if (!slug) return [];
  const cid = await populationCollectionId(db);
  return bounded(
    db,
    (d) => d`
      with m as materialized (
        select i.id from items i
        where i.collection_id = ${cid} and i.kind = ${KIND}
          and i.tags @> ${pgArray([`name-${slug}`])}::text[]
      )
      select ${columns(d)}
      from m join items i on i.id = m.id join sources s on s.id = i.source_id
      order by (i.data->>'population')::double precision desc nulls last
      limit ${Math.min(Math.max(1, Number(limit) || 20), 100)}`,
  );
}

/** Row counts per level across the whole tree, for the landing page. */
export async function populationStats({ db = sql } = {}) {
  const cid = await populationCollectionId(db);
  const found = await bounded(
    db,
    (d) => d`
      select l.level, (
        select count(*) from items i
        where i.collection_id = ${cid} and i.kind = ${KIND}
          and i.tags @> array['level-' || l.level]
      ) as n
      from unnest(${pgArray(LEVELS)}::text[]) as l(level)`,
  );
  return Object.fromEntries(found.map((r) => [r.level, Number(r.n)]));
}
