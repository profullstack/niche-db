import { connect } from './index.js';

/**
 * Indexes too big to build inside a migration, built after boot instead.
 *
 * A migration runs in a transaction, before the process serves anything, and
 * `CREATE INDEX CONCURRENTLY` cannot run in a transaction at all. So a large
 * index in a migration is a plain `CREATE INDEX`, which takes a lock that
 * blocks every write to the table for as long as the build takes, while the
 * app is not yet listening. On 2026-09-24 that combination took nichedb.dev
 * down for fifteen minutes: a stuck insert held the lock, the migration queued
 * behind it, every other write queued behind the migration, and boot never
 * finished.
 *
 * These build here instead: after the process is already serving, outside any
 * transaction, CONCURRENTLY, so no write ever waits on them. The cost is that
 * they may be missing for a while after a fresh deployment, which is a slower
 * query and never an outage.
 *
 * SELF-HEALING
 *
 * A concurrent build that is interrupted (a deploy, a dropped connection, a
 * cancelled statement) leaves the index in place and INVALID: it answers no
 * query and `create index if not exists` will happily skip it forever, so the
 * fix silently never lands. Every run therefore drops an invalid one before
 * building, which makes an interrupted build a thing the next boot repairs
 * rather than a thing somebody has to notice.
 *
 * EVERY STATEMENT IS BOUNDED
 *
 * `lock_timeout` means the short exclusive locks these need can never queue
 * the table's writes behind them. A statement that cannot get its lock in five
 * seconds gives up and the next boot tries again, which is the whole
 * difference between a slow index and an outage.
 */

/** The indexes this deployment maintains outside its migrations. */
export const BIG_INDEXES = [
  {
    name: 'items_collection_kind_tags_idx',
    extension: 'btree_gin',
    // A feed narrowed by a tag on a large collection: `collection_id = ? and
    // kind = any(?) and tags && ?`. Without the two scalars in the GIN index
    // beside the array, the planner intersects a bitmap over every row of the
    // collection with the tag's own, which on the law collection meant 734,590
    // index entries against 27,045 and no result inside two minutes.
    create:
      'create index concurrently items_collection_kind_tags_idx on items using gin (collection_id, kind, tags)',
  },
];

const LOCK_TIMEOUT_MS = 5000;

/** Present and valid, present but invalid, or absent. */
export async function indexState(sql, name) {
  const rows = await sql`
    select i.indisvalid as valid
    from pg_index i
    where i.indexrelid::regclass::text = ${name}
  `;
  if (rows.length === 0) return 'absent';
  return rows[0].valid ? 'valid' : 'invalid';
}

/** True when the server has the extension available to install. */
export async function extensionAvailable(sql, name) {
  const rows = await sql`select 1 from pg_available_extensions where name = ${name}`;
  return rows.length > 0;
}

/**
 * Bring one index into existence, or say why it did not.
 *
 * Returns what happened rather than throwing: a missing index is a slower
 * query, never a reason to take the process down.
 */
export async function ensureIndex(sql, spec, { log = console.log } = {}) {
  const { name, create, extension } = spec;
  if (extension && !(await extensionAvailable(sql, extension))) {
    log(`[indexes] ${name}: ${extension} unavailable, skipped`);
    return 'unavailable';
  }

  const before = await indexState(sql, name);
  if (before === 'valid') return 'present';

  if (before === 'invalid') {
    // An interrupted build from a previous boot. It answers nothing and would
    // make `if not exists` skip forever, so it goes before anything else.
    log(`[indexes] ${name}: dropping an invalid index left by an interrupted build`);
    /*
     * SET takes no bind parameters: `set lock_timeout = ${n}` through the tag
     * reaches Postgres as `set lock_timeout = $1` and fails with a syntax
     * error at $1. Shipped exactly that way and caught in production, where
     * the builder logged the error and left the invalid index in place.
     */
    await sql.unsafe(`set lock_timeout = ${Math.floor(LOCK_TIMEOUT_MS)}`);
    await sql.unsafe(`drop index if exists ${name}`);
    await sql.unsafe('set lock_timeout = 0');
  }

  if (extension) await sql.unsafe(`create extension if not exists ${extension}`);

  const started = Date.now();
  log(`[indexes] ${name}: building concurrently, this takes a while`);
  await sql.unsafe(create);
  const after = await indexState(sql, name);
  const secs = Math.round((Date.now() - started) / 1000);
  if (after !== 'valid') {
    log(`[indexes] ${name}: build finished ${after} after ${secs}s, the next boot retries`);
    return after;
  }
  log(`[indexes] ${name}: built in ${secs}s`);
  return 'built';
}

/**
 * Build what is missing, on a connection of its own.
 *
 * Its own connection because the pool's idle timeout would cut a build that
 * produces no messages for an hour, and because nothing else should wait
 * behind it. Never awaited by boot: call it and let it run.
 */
/**
 * One build at a time, however many callers ask.
 *
 * Boot starts one and the maintenance tick asks again every couple of minutes,
 * which is what gives a drop or a build that lost a lock race another go. A
 * concurrent build can easily outlive the tick that started it, so without
 * this two of them would run against the same index name and collide.
 */
let inFlight = null;

export function buildBigIndexesOnce(opts = {}) {
  if (!inFlight) {
    inFlight = buildBigIndexes(opts).finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

export async function buildBigIndexes({ log = console.log, indexes = BIG_INDEXES } = {}) {
  const sql = connect({ max: 1, idleTimeout: 0 });
  const results = {};
  try {
    for (const spec of indexes) {
      try {
        results[spec.name] = await ensureIndex(sql, spec, { log });
      } catch (err) {
        // A cancelled build, a lock it could not take, a restart mid-flight:
        // all the same answer, which is that the next boot tries again.
        results[spec.name] = 'failed';
        log(`[indexes] ${spec.name}: ${err?.message ?? err}`);
      }
    }
  } finally {
    await sql.end();
  }
  return results;
}
