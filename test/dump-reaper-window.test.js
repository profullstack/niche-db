import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

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

const DUE = `
  select id from sources s
  where enabled and ($1 or next_run_at <= now())
    and not exists (
      select 1 from runs r
      where r.source_id = s.id and r.status = 'running'
        and r.started_at > now() - ($2)::interval
    )
  order by next_run_at limit $3`;
const REAP = `update runs set status = 'error', finished_at = now(), error = 'abandoned (process exited)'
  where status = 'running' and started_at < now() - ($1)::interval returning id, source_id`;

// budgetMs = 60 min -> runTick window = ceil(60) + 10 = 70
const WINDOW = `${Math.ceil((60 * 60_000) / 60_000) + 10} minutes`;

async function scenario(minutesAgo) {
  const c = await one(`insert into collections (slug, name) values ($1, 'T') returning id`, [
    `r-${Math.random()}`,
  ]);
  // hourly cadence: startRun pushed next_run_at 60 min out from start, so with
  // the run 50 min in it is 10 min away, and 71 min in it is 11 min overdue.
  const s = await one(
    `insert into sources (collection_id, adapter, slug, name, enabled, cadence_minutes, next_run_at)
     values ($1, 'x', $2, 'S', true, 60, now() - make_interval(mins => $3) + interval '60 minutes') returning id`,
    [c.id, `s-${Math.random()}`, minutesAgo],
  );
  const r = await one(
    `insert into runs (source_id, status, started_at) values ($1, 'running', now() - make_interval(mins => $2)) returning id`,
    [s.id, minutesAgo],
  );
  return { sourceId: s.id, runId: r.id };
}

describe('reaper + guard at a 60 minute budget', () => {
  test('50 minutes in: not reaped, not due', async () => {
    const { sourceId, runId } = await scenario(50);
    const reaped = await rows(REAP, [WINDOW]);
    expect(reaped.map((r) => r.id)).not.toContain(runId);
    expect((await rows(DUE, [false, WINDOW, 50])).map((r) => r.id)).not.toContain(sourceId);
    // even the boot sweep leaves it alone
    expect((await rows(DUE, [true, WINDOW, 50])).map((r) => r.id)).not.toContain(sourceId);
    expect((await one('select status from runs where id = $1', [runId])).status).toBe('running');
  });

  test('69 minutes in (budget passed by 9): still inside the window, still not due', async () => {
    const { sourceId, runId } = await scenario(69);
    expect((await rows(REAP, [WINDOW])).map((r) => r.id)).not.toContain(runId);
    expect((await rows(DUE, [false, WINDOW, 50])).map((r) => r.id)).not.toContain(sourceId);
  });

  test('71 minutes in (budget passed by 11): reaped, then due on the same tick', async () => {
    const { sourceId, runId } = await scenario(71);
    // The reaper runs first in runTick, and would set next_run_at = now() for it.
    const reaped = await rows(REAP, [WINDOW]);
    expect(reaped.map((r) => r.id)).toContain(runId);
    await db.query(`update sources set next_run_at = now() where id = $1`, [sourceId]);
    expect((await rows(DUE, [false, WINDOW, 50])).map((r) => r.id)).toContain(sourceId);
    expect((await one('select status, error from runs where id = $1', [runId])).error).toMatch(
      /abandoned/,
    );
  });
});
