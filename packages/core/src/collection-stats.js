import { config } from '@nichedb/config';
import { sql } from '@nichedb/db';
import * as q from '@nichedb/db/queries';

/**
 * Collection statistics, off the request path.
 *
 * A collection page shows how many items, kinds and tags a collection holds.
 * Counting those live meant three scans of the collection per page view: a
 * count, a group by kind, and an unnest of every row's tags. On music (8.5M
 * rows) or books (6M) each took ten seconds, every crawler hit ran a fresh
 * copy because every paginated URL is its own cache key, and the copies sat
 * on the web pool's twelve connections while a two-millisecond item read
 * queued behind them until the client gave up. So the worker computes them
 * here, one collection at a time, and the pages read the stored row.
 *
 * A pass takes the collections whose row is oldest first, recomputes the ones
 * older than `staleMs`, and stops taking on new ones once `budgetMs` has gone
 * so a slow database never wedges the queue. Each collection's counts run in
 * one transaction under `statement_timeout`, so a collection that cannot be
 * counted in time is logged and skipped rather than held open; its previous
 * row stays. A collection with no row yet is counted live by the page, once,
 * until the first pass reaches it.
 */
export async function refreshCollectionStats({
  log = console.log,
  db = sql,
  staleMs = config.stats.staleSeconds * 1000,
  budgetMs = config.stats.budgetMs,
  statementTimeoutMs = config.stats.statementTimeoutMs,
  now = Date.now,
} = {}) {
  const started = now();
  const rows = await q.collectionsByStatsAge({ db });
  const due = rows.filter(
    (r) => !r.computed_at || now() - new Date(r.computed_at).getTime() >= staleMs,
  );
  let refreshed = 0;
  const failed = [];
  for (const c of due) {
    if (now() - started > budgetMs) break;
    const t0 = now();
    try {
      const stats = await computeCollectionStats(c.id, { db, statementTimeoutMs });
      await q.upsertCollectionStats({ collectionId: c.id, ...stats, ms: now() - t0 }, { db });
      refreshed += 1;
      log(
        `[stats] ${c.slug}: ${stats.items} items, ${stats.kinds.length} kinds, ${stats.tags.length} tags in ${now() - t0}ms`,
      );
    } catch (err) {
      failed.push(c.slug);
      log(`[stats] ${c.slug} failed after ${now() - t0}ms: ${err.message}`);
    }
  }
  return { due: due.length, refreshed, failed, skipped: due.length - refreshed - failed.length };
}

/**
 * One collection's counts, as the page shows them. Sequential inside one
 * transaction so `statement_timeout` bounds each statement; the test database
 * has no transactions and runs them plainly.
 */
export async function computeCollectionStats(
  collectionId,
  { db = sql, statementTimeoutMs = 0 } = {},
) {
  const run = async (tx) => {
    const stats = await q.collectionStats(collectionId, { db: tx });
    const kinds = await q.kindsForCollection(collectionId, { db: tx });
    const tags = await q.topTags(collectionId, { db: tx });
    return {
      items: Number(stats.items),
      itemsToday: Number(stats.items_today),
      sources: Number(stats.sources),
      feeds: Number(stats.feeds),
      kinds: kinds.map((k) => ({ kind: k.kind, n: Number(k.n) })),
      tags: tags.map((t) => ({ tag: t.tag, n: Number(t.n) })),
    };
  };
  if (typeof db.begin === 'function' && statementTimeoutMs > 0) {
    return db.begin(async (tx) => {
      await tx.unsafe(`set local statement_timeout = ${Math.floor(statementTimeoutMs)}`);
      return run(tx);
    });
  }
  return run(db);
}
