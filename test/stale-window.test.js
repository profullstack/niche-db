import { beforeAll, describe, expect, test } from 'bun:test';
import {
  STALE_MARGIN_MINUTES,
  staleMinutesByAdapter,
} from '../packages/queue/src/ingest-scheduling.js';
import { migratedPglite, pgliteSql } from './helpers/pglite.js';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
const q = await import('../packages/db/src/queries.js');

/**
 * A run abandoned by a Postgres blip is released on its own adapter's clock.
 *
 * dev2, 2026-10-01 01:56: crash recovery under an espn-live run (a one-minute
 * source with the deployment's four-minute deadline). The run could not be
 * closed, and the one stale-run window, sized for the longest budget in the
 * build (a two-hour dump walk, so 130 minutes), kept live scores frozen for
 * over two hours. Against the real queries, on an in-process Postgres.
 */
let raw;
let db;
beforeAll(async () => {
  raw = await migratedPglite();
  db = pgliteSql(raw);
}, 60_000);

const one = async (text, params) => (await raw.query(text, params)).rows[0];
let n = 0;
async function sourceWithRun(adapter, startedMinutesAgo) {
  n += 1;
  const c = await one(`insert into collections (slug, name) values ($1, 'T') returning id`, [
    `stale${n}-${Math.random()}`,
  ]);
  const s = await one(
    `insert into sources (collection_id, adapter, slug, name, enabled, next_run_at)
     values ($1, $2, $3, 'S', true, now() + interval '1 minute') returning id`,
    [c.id, adapter, `stale-src${n}-${Math.random()}`],
  );
  const r = await one(
    `insert into runs (source_id, status, started_at)
     values ($1, 'running', now() - make_interval(mins => $2)) returning id`,
    [s.id, startedMinutesAgo],
  );
  return { sourceId: s.id, runId: r.id };
}
const statusOf = async (runId) =>
  (await one(`select status, error from runs where id = $1`, [runId])).status;

const ADAPTERS = [
  { name: 'espn-live' },
  { name: 'ruuster', budgetMs: 20 * 60_000 },
  { name: 'big-dump', budgetMs: 2 * 60 * 60_000 },
];
const RUN_DEADLINE_MS = 4 * 60_000;
const minutesByAdapter = staleMinutesByAdapter(ADAPTERS, RUN_DEADLINE_MS);
const FALLBACK = 130;

describe('staleMinutesByAdapter', () => {
  test("each adapter's window is its own deadline plus the margin", () => {
    expect(STALE_MARGIN_MINUTES).toBe(5);
    expect(minutesByAdapter).toEqual({ 'espn-live': 9, ruuster: 25, 'big-dump': 125 });
  });
});

describe('the reaper and the due guard, per adapter', () => {
  test('a live-scores run abandoned 12 minutes ago is reaped and its source is due now', async () => {
    const live = await sourceWithRun('espn-live', 12);
    // The old single window would have held it for 130 minutes.
    await q.reapStaleRuns({ minutes: FALLBACK, minutesByAdapter, db });
    expect(await statusOf(live.runId)).toBe('error');
    const due = await q.dueSources({
      runningMinutes: FALLBACK,
      minutesByAdapter,
      limit: 500,
      db,
    });
    expect(due.map((r) => r.id)).toContain(live.sourceId);
  });

  test('a long walk 12 minutes into its two-hour budget is left alone and not enqueued again', async () => {
    const walk = await sourceWithRun('big-dump', 12);
    await raw.query(`update sources set next_run_at = now() - interval '1 minute' where id = $1`, [
      walk.sourceId,
    ]);
    await q.reapStaleRuns({ minutes: FALLBACK, minutesByAdapter, db });
    expect(await statusOf(walk.runId)).toBe('running');
    const due = await q.dueSources({
      runningMinutes: FALLBACK,
      minutesByAdapter,
      limit: 500,
      db,
    });
    expect(due.map((r) => r.id)).not.toContain(walk.sourceId);
  });

  test('a live-scores run inside its window is in flight: not reaped, not due', async () => {
    const live = await sourceWithRun('espn-live', 3);
    await raw.query(`update sources set next_run_at = now() - interval '1 minute' where id = $1`, [
      live.sourceId,
    ]);
    await q.reapStaleRuns({ minutes: FALLBACK, minutesByAdapter, db });
    expect(await statusOf(live.runId)).toBe('running');
    const due = await q.dueSources({
      runningMinutes: FALLBACK,
      minutesByAdapter,
      limit: 500,
      db,
    });
    expect(due.map((r) => r.id)).not.toContain(live.sourceId);
  });

  test('an adapter this build does not know falls back to the long window', async () => {
    const unknown = await sourceWithRun('retired-adapter', 60);
    await q.reapStaleRuns({ minutes: FALLBACK, minutesByAdapter, db });
    expect(await statusOf(unknown.runId)).toBe('running');
    const old = await sourceWithRun('retired-adapter', 131);
    await q.reapStaleRuns({ minutes: FALLBACK, minutesByAdapter, db });
    expect(await statusOf(old.runId)).toBe('error');
  });
});
