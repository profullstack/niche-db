import { beforeAll, describe, expect, test } from 'bun:test';
import { migratedPglite, pgliteSql } from './helpers/pglite.js';

const q = await import('../packages/db/src/queries.js');

let db;
let sql;
const one = async (text, values = []) => (await db.query(text, values)).rows[0];

beforeAll(async () => {
  db = await migratedPglite();
  sql = pgliteSql(db);
  const c = Number(
    (await one("insert into collections(slug,name) values ('games','Games') returning id")).id,
  );
  const source = async (slug, fields) =>
    Number(
      (
        await one(
          `insert into sources(collection_id,adapter,slug,name,enabled,last_ok_at,last_error,next_run_at)
           values ($1,'steam',$2,$2,$3,$4,$5,$6) returning id`,
          [c, slug, fields.enabled ?? true, fields.ok ?? null, fields.error ?? null, fields.next],
        )
      ).id,
    );
  const now = Date.now();
  const ago = (min) => new Date(now - min * 60_000);
  const healthy = await source('healthy', { ok: ago(5), next: ago(-55) });
  const failing = await source('failing', { ok: ago(600), error: 'HTTP 503', next: ago(-10) });
  await source('waiting', { next: ago(-5) });
  await source('late', { ok: ago(300), next: ago(90) });
  await source('paused', { enabled: false, next: ago(9000) });

  const run = (sid, status, startedMin, added = 0) =>
    one(
      `insert into runs(source_id,status,started_at,finished_at,seen,added,updated,error)
       values ($1,$2,$3,$3,10,$4,1,$5)`,
      [sid, status, ago(startedMin), added, status === 'error' ? 'HTTP 503' : null],
    );
  await run(healthy, 'ok', 5, 4);
  await run(healthy, 'ok', 65, 2);
  await run(failing, 'error', 10);
  await run(healthy, 'running', 1);
  // Older than a day: in the recent list, not in the day's totals.
  await run(healthy, 'ok', 60 * 30, 100);
});

describe('crawlStatus', () => {
  test('counts every source by state', async () => {
    const { sources } = await q.crawlStatus({ db: sql });
    expect(sources).toMatchObject({
      total: 5,
      enabled: 4,
      paused: 1,
      failing: 1,
      waiting: 1,
      ok: 2,
      overdue: 1,
    });
  });

  test('a day of runs, totalled and by hour', async () => {
    const { day, hourly } = await q.crawlStatus({ db: sql });
    expect(day).toMatchObject({ runs: 4, ok: 2, errors: 1, running: 1, sources: 2, added: 6 });
    expect(hourly.reduce((n, h) => n + h.ok + h.errors + h.running, 0)).toBe(4);
  });

  test('lists the failing and the overdue, and the newest runs first', async () => {
    const { failing, overdue, recent } = await q.crawlStatus({ db: sql });
    expect(failing.map((s) => s.slug)).toEqual(['failing']);
    expect(failing[0].last_error).toBe('HTTP 503');
    expect(failing[0].collection_name).toBe('Games');
    // Paused is long past due too, but a paused source is not behind.
    expect(overdue.map((s) => s.slug)).toEqual(['late']);
    expect(recent.map((r) => r.status)).toEqual(['running', 'ok', 'error', 'ok', 'ok']);
  });

  test('respects the limit', async () => {
    const { recent } = await q.crawlStatus({ db: sql, limit: 2 });
    expect(recent).toHaveLength(2);
  });
});
