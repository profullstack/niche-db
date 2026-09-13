import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

/**
 * A deploy that adds adapters strands the sources it just seeded.
 *
 * The container still draining does not have the new adapters, takes some of
 * the first runs the new one enqueued, and writes `unknown adapter`. On its own
 * that is nothing. What makes it expensive is that `startRun` pushes
 * `next_run_at` a full cadence forward BEFORE the adapter lookup fails, so the
 * source does not just fail once, it forfeits its entire slot. Measured on the
 * three deploys of 2026-09-09: five-minute sources recovered in minutes, but a
 * twelve-hour drought source was parked until 06:50 the next morning and a
 * twenty-four-hour register until the evening after that.
 *
 * These tests run the real SQL against a real Postgres in process, because the
 * whole behaviour is in the `update ... where` and nothing about it can be
 * checked by mocking.
 */
let db;
beforeAll(async () => {
  db = await new PGlite({ extensions: { citext, pg_trgm } });
  const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
  for (const f of (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort()) {
    await db.exec(await readFile(dir + f, 'utf8'));
  }
}, 60_000);

const rows = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (sql, params) => (await rows(sql, params))[0];

let n = 0;
async function source({ adapter, error = null, minutesOut = 720, cadence = 720, enabled = true }) {
  n += 1;
  const c = await one(`insert into collections (slug, name) values ($1, 'T') returning id`, [
    `roll${n}-${Math.random()}`,
  ]);
  /* `minutesOut` is when it is next due and `cadence` is how often it runs.
   * They are separate on purpose: a source can be overdue and still have a
   * twelve-hour cadence, which is exactly the case this file is about. */
  const s = await one(
    `insert into sources (collection_id, adapter, slug, name, enabled, last_error, next_run_at, cadence_minutes)
     values ($1, $2, $3, 'S', $4, $5, now() + make_interval(mins => $6), $7) returning id`,
    [c.id, adapter, `src${n}-${Math.random()}`, enabled, error, minutesOut, cadence],
  );
  return s.id;
}

/** The statement `rescheduleKnownAdapters` runs, kept identical to the query. */
const REPAIR = `
  update sources set next_run_at = now(), updated_at = now()
  where enabled
    and last_error like 'unknown adapter%'
    and next_run_at > now()
    and adapter = any($1::text[])
  returning id`;

const dueNow = async (id) =>
  (await one(`select next_run_at <= now() as due from sources where id = $1`, [id])).due;

describe('recovering from a rollout that stranded a source', () => {
  test('a source parked on unknown adapter is brought forward when the adapter exists', async () => {
    const id = await source({
      adapter: 'drought-monitor',
      error: 'unknown adapter drought-monitor',
    });
    expect(await dueNow(id)).toBe(false);

    const changed = await rows(REPAIR, [['drought-monitor', 'ndbc-buoys']]);
    expect(changed).toHaveLength(1);
    expect(await dueNow(id)).toBe(true);
  });

  test('a source that failed for any other reason keeps its schedule', async () => {
    /* This is the guard that keeps the repair from becoming "retry everything
     * on every boot". A 500 from an upstream is not a rollout. */
    const id = await source({ adapter: 'cfpb-complaints', error: '503 from the CFPB search' });
    await rows(REPAIR, [['cfpb-complaints']]);
    expect(await dueNow(id)).toBe(false);
  });

  test('a source naming an adapter that really is gone stays parked', async () => {
    // Otherwise a removed adapter would spin the scheduler every tick forever.
    const id = await source({
      adapter: 'adapter-we-deleted',
      error: 'unknown adapter adapter-we-deleted',
    });
    await rows(REPAIR, [['drought-monitor', 'ndbc-buoys']]);
    expect(await dueNow(id)).toBe(false);
  });

  test('a disabled source is not woken up', async () => {
    const id = await source({
      adapter: 'drought-monitor',
      error: 'unknown adapter drought-monitor',
      enabled: false,
    });
    await rows(REPAIR, [['drought-monitor']]);
    expect(await dueNow(id)).toBe(false);
  });

  test('a source already due is left alone, so the repair is idempotent', async () => {
    const id = await source({
      adapter: 'ndbc-buoys',
      error: 'unknown adapter ndbc-buoys',
      minutesOut: -30,
    });
    const first = await rows(REPAIR, [['ndbc-buoys']]);
    expect(first).toHaveLength(0);
    expect(await dueNow(id)).toBe(true);
  });

  test('running it twice changes nothing the second time', async () => {
    const id = await source({ adapter: 'nws-surf-zone', error: 'unknown adapter nws-surf-zone' });
    expect(await rows(REPAIR, [['nws-surf-zone']])).toHaveLength(1);
    expect(await rows(REPAIR, [['nws-surf-zone']])).toHaveLength(0);
    expect(await dueNow(id)).toBe(true);
  });

  test('an empty adapter list is not a wildcard', async () => {
    /* `any('{}')` matches nothing, which is what we want, but it is worth
     * pinning: the guard in the query returns early on an empty list and a
     * regression there would wake every failed source in the database. */
    const id = await source({
      adapter: 'drought-monitor',
      error: 'unknown adapter drought-monitor',
    });
    await rows(REPAIR, [[]]);
    expect(await dueNow(id)).toBe(false);
  });
});

describe('the slot a failed lookup costs', () => {
  test('startRun pushes next_run_at a full cadence out before anything else happens', async () => {
    /* This is why the two-minute retry in the unknown-adapter path matters:
     * the slot is already gone by the time the adapter is looked up. */
    const id = await source({ adapter: 'drought-monitor', minutesOut: -1, cadence: 720 });
    expect(await dueNow(id)).toBe(true);

    await db.query(
      `update sources set last_run_at = now(),
         next_run_at = now() + make_interval(mins => cadence_minutes),
         run_count = run_count + 1 where id = $1`,
      [id],
    );
    const after = await one(
      `select extract(epoch from (next_run_at - now())) / 60 as mins from sources where id = $1`,
      [id],
    );
    expect(Number(after.mins)).toBeGreaterThan(700);

    // And the short retry the ingest path now passes brings it back to minutes.
    await db.query(`update sources set next_run_at = $2 where id = $1`, [
      id,
      new Date(Date.now() + 2 * 60_000),
    ]);
    const retry = await one(
      `select extract(epoch from (next_run_at - now())) / 60 as mins from sources where id = $1`,
      [id],
    );
    expect(Number(retry.mins)).toBeLessThan(3);
  });
});

/**
 * The statements `reapStaleRuns` runs, kept identical to the query: a run
 * abandoned by a container that died is marked, and its source is asked to
 * run again now rather than a whole cadence later.
 */
const REAP = `
  update runs set status = 'error', finished_at = now(), error = 'abandoned (process exited)'
  where status = 'running' and started_at < now() - ($1)::interval
  returning id, source_id`;
const REQUEUE = `
  update sources set next_run_at = now(), updated_at = now()
  where id = any($1::int[]) and enabled`;

describe('a run killed by a redeploy does not park its source for a cadence', () => {
  test('the abandoned run is marked and the source is due again now', async () => {
    // A bulk list: read once a month, and its first run began two hours ago.
    const id = await source({ adapter: 'opensite', minutesOut: 43_200, cadence: 43_200 });
    await one(
      `insert into runs (source_id, started_at) values ($1, now() - interval '2 hours') returning id`,
      [id],
    );
    const before = await one(
      `select next_run_at > now() + interval '29 days' as parked from sources where id = $1`,
      [id],
    );
    expect(before.parked).toBe(true);
    const reaped = await rows(REAP, ['40 minutes']);
    expect(reaped.map((r) => r.source_id)).toContain(id);
    await rows(REQUEUE, [[...new Set(reaped.map((r) => r.source_id))]]);
    const run = await one(`select status, error from runs where source_id = $1`, [id]);
    expect(run.status).toBe('error');
    expect(run.error).toBe('abandoned (process exited)');
    const after = await one(`select next_run_at <= now() as due from sources where id = $1`, [id]);
    expect(after.due).toBe(true);
  });

  test('a run still inside its window, and a paused source, are left alone', async () => {
    const fresh = await source({ adapter: 'opensite', minutesOut: 43_200, cadence: 43_200 });
    await one(
      `insert into runs (source_id, started_at) values ($1, now() - interval '5 minutes') returning id`,
      [fresh],
    );
    const paused = await source({
      adapter: 'opensite',
      minutesOut: 43_200,
      cadence: 43_200,
      enabled: false,
    });
    await one(
      `insert into runs (source_id, started_at) values ($1, now() - interval '2 hours') returning id`,
      [paused],
    );
    const reaped = await rows(REAP, ['40 minutes']);
    expect(reaped.map((r) => r.source_id)).not.toContain(fresh);
    expect(reaped.map((r) => r.source_id)).toContain(paused);
    await rows(REQUEUE, [[...new Set(reaped.map((r) => r.source_id))]]);
    expect(
      (await one(`select next_run_at > now() as later from sources where id = $1`, [fresh])).later,
    ).toBe(true);
    expect(
      (await one(`select next_run_at > now() as later from sources where id = $1`, [paused])).later,
    ).toBe(true);
  });
});
