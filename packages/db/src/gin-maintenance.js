import { connect } from './index.js';
import { pgArray } from './queries.js';

/**
 * Keep the GIN pending lists small, so no INSERT ever pays to merge one.
 *
 * WHY AN INSERT HANGS FOR HOURS
 *
 * A GIN index with `fastupdate` on (the default) does not write new entries
 * into the tree. It appends them to a pending list, and when that list passes
 * `gin_pending_list_limit` (4 MB by default), the NEXT backend to insert is
 * the one that merges the whole list into the index. It is not a background
 * task: a random ingest transaction is picked to do gigabytes of random I/O
 * while holding its transaction open.
 *
 * On `items` that is brutal. The table carries three large GIN indexes --
 * items_search_idx at 6.6 GB, items_title_trgm_idx at 3.5 GB, items_tags_idx --
 * so an unlucky batch insert stalls on `DataFileRead` for minutes. Measured on
 * production, 2026-09-24: inserts stuck for 14 minutes, 27 minutes, 41 minutes
 * and one for 19 hours 29 minutes. Each one pinned the xmin horizon for its
 * whole life, so autovacuum could reclaim nothing database-wide, and each one
 * blocked index builds and delayed boot. Two outages that day had a stuck
 * insert somewhere in the chain.
 *
 * WHAT THIS DOES
 *
 * `gin_clean_pending_list()` does the same merge, on demand, on whatever
 * connection calls it. Running it on a schedule means the list is emptied by
 * this job, little and often, and never grows to the limit where an ingest
 * transaction is handed the bill. Inserts keep the throughput fastupdate is
 * there to give them and stop paying for it at random.
 *
 * Turning `fastupdate` off would also stop the spikes, by making every insert
 * pay a slice of the cost forever. That is the wrong trade for a table this
 * write-heavy: the merge is cheap when it is small and frequent, which is
 * exactly what a schedule makes it.
 */

/** Tables whose GIN indexes are cleaned. Ordered by how much writing they take. */
export const MAINTAINED_TABLES = ['items'];

/** A clean that cannot finish in this long is abandoned; the next tick resumes it. */
export const CLEAN_TIMEOUT_MS = 5 * 60_000;

/** Every GIN index on the named tables, largest first. */
export async function ginIndexes(sql, tables = MAINTAINED_TABLES) {
  return sql`
    select i.relname as index, t.relname as "table", pg_relation_size(i.oid) as bytes
    from pg_class i
    join pg_index x on x.indexrelid = i.oid
    join pg_class t on t.oid = x.indrelid
    join pg_am am on am.oid = i.relam
    where am.amname = 'gin'
      and x.indisvalid
      and t.relname = any(${pgArray(tables)}::text[])
    order by pg_relation_size(i.oid) desc
  `;
}

/**
 * Merge one index's pending list.
 *
 * Bounded, because this runs beside live ingest and a clean that has grown
 * enormous must not become the very stall it exists to prevent. Abandoning it
 * loses nothing: the entries stay in the pending list and the next tick picks
 * them up, a little further along.
 */
export async function cleanIndex(sql, index, { timeoutMs = CLEAN_TIMEOUT_MS } = {}) {
  const started = Date.now();
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(`set local statement_timeout = ${Math.floor(timeoutMs)}`);
      await tx.unsafe(`select gin_clean_pending_list('${index}')`);
    });
    return { index, ms: Date.now() - started, ok: true };
  } catch (err) {
    return { index, ms: Date.now() - started, ok: false, error: err?.message ?? String(err) };
  }
}

/**
 * One pass over every GIN index that matters.
 *
 * Its own connection, with no idle timeout: a clean produces no messages while
 * it runs, and the app pool would cut it. Never throws -- a failed clean is a
 * slower insert later, not a reason to take a worker down.
 */
export async function cleanGinPendingLists({
  log = console.log,
  tables = MAINTAINED_TABLES,
  timeoutMs = CLEAN_TIMEOUT_MS,
} = {}) {
  const sql = connect({ max: 1, idleTimeout: 0 });
  const results = [];
  try {
    for (const row of await ginIndexes(sql, tables)) {
      const r = await cleanIndex(sql, row.index, { timeoutMs });
      results.push(r);
      if (!r.ok) log(`[gin] ${r.index}: ${r.error}`);
      else if (r.ms > 5000) log(`[gin] ${r.index}: cleaned in ${Math.round(r.ms / 1000)}s`);
    }
  } catch (err) {
    log(`[gin] ${err?.message ?? err}`);
  } finally {
    await sql.end();
  }
  return results;
}
