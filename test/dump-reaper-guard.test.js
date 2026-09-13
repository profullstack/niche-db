import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

/**
 * A source with a run in flight must not be enqueued again.
 *
 * `startRun` pushes `next_run_at` one cadence forward, which covers a run
 * shorter than its cadence. A dump adapter with an hour's budget on an hourly
 * source, a source that asked for `nextInMinutes: 1` last time, or the reaper
 * resetting a clock, all bring the source back while the first run is still
 * writing -- and without a guard the tick enqueues a second run of the same
 * source beside it. The guard is bounded by the same window the reaper uses
 * on the same tick, so a run older than it (already marked abandoned) can
 * never park a source for good.
 *
 * Against a real Postgres in process, because the behaviour is the `not
 * exists` and nothing about it survives being mocked.
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
async function source({ minutesOut = -1, enabled = true } = {}) {
  n += 1;
  const c = await one(`insert into collections (slug, name) values ($1, 'T') returning id`, [
    `reap${n}-${Math.random()}`,
  ]);
  const s = await one(
    `insert into sources (collection_id, adapter, slug, name, enabled, next_run_at)
     values ($1, 'x', $2, 'S', $3, now() + make_interval(mins => $4)) returning id`,
    [c.id, `src${n}-${Math.random()}`, enabled, minutesOut],
  );
  return s.id;
}

async function run(sourceId, { status = 'running', minutesAgo = 0 } = {}) {
  await db.query(
    `insert into runs (source_id, status, started_at)
     values ($1, $2, now() - make_interval(mins => $3))`,
    [sourceId, status, minutesAgo],
  );
}

/** The statement `dueSources` runs, kept identical to the query. */
const DUE = `
  select id, slug, adapter, next_run_at from sources s
  where enabled and ($1 or next_run_at <= now())
    and not exists (
      select 1 from runs r
      where r.source_id = s.id and r.status = 'running'
        and r.started_at > now() - ($2)::interval
    )
  order by next_run_at limit $3`;

const due = async ({ force = false, runningMinutes = 70, limit = 50 } = {}) =>
  (await rows(DUE, [force, `${runningMinutes} minutes`, limit])).map((r) => r.id);

describe('dueSources and a run in flight', () => {
  test('an overdue source with a run inside the window is not due', async () => {
    const id = await source();
    await run(id, { minutesAgo: 30 });
    expect(await due()).not.toContain(id);
  });

  test('the same source with no running run is due', async () => {
    const id = await source();
    await run(id, { status: 'ok', minutesAgo: 30 });
    await run(id, { status: 'error', minutesAgo: 5 });
    expect(await due()).toContain(id);
  });

  test('a run older than the window no longer blocks: the reaper owns it now', async () => {
    const id = await source();
    await run(id, { minutesAgo: 71 });
    expect(await due({ runningMinutes: 70 })).toContain(id);
    // Widen the window (a larger budgetMs was declared) and the same run blocks again.
    expect(await due({ runningMinutes: 90 })).not.toContain(id);
  });

  test('the boot sweep (force) gets the same guard', async () => {
    const running = await source({ minutesOut: 600 });
    const idle = await source({ minutesOut: 600 });
    await run(running, { minutesAgo: 10 });
    const ids = await due({ force: true });
    expect(ids).toContain(idle);
    expect(ids).not.toContain(running);
  });

  test('reaping marks the old run abandoned and the source becomes due on the next tick', async () => {
    const id = await source();
    await run(id, { minutesAgo: 100 });
    expect(await due({ runningMinutes: 70 })).toContain(id);
    // The reaper's statement, as in queries.js: a run past the window is an error.
    await db.query(
      `update runs set status = 'error', finished_at = now(), error = 'abandoned (process exited)'
       where status = 'running' and started_at < now() - ($1)::interval`,
      ['70 minutes'],
    );
    const left = await rows(`select status from runs where source_id = $1`, [id]);
    expect(left.map((r) => r.status)).toEqual(['error']);
    expect(await due({ runningMinutes: 70 })).toContain(id);
  });
});
