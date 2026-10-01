import { describe, expect, test } from 'bun:test';
import { connect } from '../packages/db/src/index.js';
import { bounded } from '../packages/db/src/queries.js';
import {
  isTransientDbError,
  onUnhandledRejection,
  retryTransient,
} from '../packages/db/src/resilience.js';

/** Errors shaped the way Bun 1.4's Postgres client raises them, as seen on dev2. */
const closed = () =>
  Object.assign(new Error('Connection closed'), {
    name: 'PostgresError',
    code: 'ERR_POSTGRES_CONNECTION_CLOSED',
  });
const recovering = () =>
  Object.assign(new Error('the database system is in recovery mode'), {
    name: 'PostgresError',
    code: 'ERR_POSTGRES_SERVER_ERROR',
    errno: '57P03',
  });
const notAccepting = () =>
  Object.assign(new Error('the database system is not accepting connections'), {
    code: 'ERR_POSTGRES_SERVER_ERROR',
    errno: '57P03',
  });
const adminKill = () =>
  Object.assign(new Error('terminating connection due to administrator command'), {
    code: 'ERR_POSTGRES_SERVER_ERROR',
    errno: '57P01',
  });
const refused = () =>
  Object.assign(new Error('Failed to connect'), { code: 'ERR_POSTGRES_CONNECTION_REFUSED' });
const badSql = () =>
  Object.assign(new Error('syntax error at or near "selec"'), {
    code: 'ERR_POSTGRES_SERVER_ERROR',
    errno: '42601',
  });
const badPassword = () =>
  Object.assign(new Error('password authentication failed for user "postgres"'), {
    code: 'ERR_POSTGRES_SERVER_ERROR',
    errno: '28P01',
  });

describe('isTransientDbError', () => {
  test('the database being away is transient', () => {
    for (const e of [closed(), recovering(), notAccepting(), adminKill(), refused()]) {
      expect(isTransientDbError(e)).toBe(true);
    }
    const sys = Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:5432'), {
      code: 'ECONNREFUSED',
    });
    expect(isTransientDbError(sys)).toBe(true);
    expect(isTransientDbError(new Error('wrapped', { cause: recovering() }))).toBe(true);
  });

  test('a wrong query, a wrong password or a missing database is not', () => {
    expect(isTransientDbError(badSql())).toBe(false);
    expect(isTransientDbError(badPassword())).toBe(false);
    expect(
      isTransientDbError(
        Object.assign(new Error('database "nope" does not exist'), { errno: '3D000' }),
      ),
    ).toBe(false);
    expect(isTransientDbError(new TypeError('x is not a function'))).toBe(false);
    expect(isTransientDbError(null)).toBe(false);
    expect(isTransientDbError('Connection closed')).toBe(false);
  });
});

describe('retryTransient', () => {
  const clock = () => {
    let t = 0;
    const sleeps = [];
    return {
      sleeps,
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
    };
  };

  test('a boot that meets crash recovery waits it out and succeeds', async () => {
    const c = clock();
    const logs = [];
    let calls = 0;
    // The first eight calls meet a server in recovery, then a dropped
    // connection, the way a boot during a dev2 crash did.
    const migrate = async () => {
      calls += 1;
      if (calls <= 6) throw recovering();
      if (calls <= 8) throw closed();
      return 'migrated';
    };
    const out = await retryTransient(migrate, {
      label: 'postgres',
      log: (m) => logs.push(m),
      sleep: c.sleep,
      now: c.now,
    });
    expect(out).toBe('migrated');
    expect(calls).toBe(9);
    // 1s doubling, capped at 30s.
    expect(c.sleeps).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    expect(logs[0]).toContain('in recovery mode');
    expect(logs[0]).toContain('retrying in 1s');
  });

  test('a fatal error is thrown at once, without a retry', async () => {
    const c = clock();
    let calls = 0;
    const err = badSql();
    await expect(
      retryTransient(
        async () => {
          calls += 1;
          throw err;
        },
        { log: () => {}, sleep: c.sleep, now: c.now },
      ),
    ).rejects.toBe(err);
    expect(calls).toBe(1);
    expect(c.sleeps).toEqual([]);

    calls = 0;
    await expect(
      retryTransient(
        async () => {
          calls += 1;
          throw badPassword();
        },
        { log: () => {}, sleep: c.sleep, now: c.now },
      ),
    ).rejects.toThrow(/password authentication failed/);
    expect(calls).toBe(1);
  });

  test('a database that never comes back is given up on after the budget', async () => {
    const c = clock();
    const logs = [];
    let calls = 0;
    await expect(
      retryTransient(
        async () => {
          calls += 1;
          throw recovering();
        },
        { budgetMs: 5 * 60_000, log: (m) => logs.push(m), sleep: c.sleep, now: c.now },
      ),
    ).rejects.toThrow(/recovery mode/);
    expect(c.now()).toBeLessThanOrEqual(5 * 60_000);
    expect(calls).toBeGreaterThan(5);
    expect(logs[logs.length - 1]).toContain('giving up');
  });
});

describe('onUnhandledRejection', () => {
  test('a stray dropped-connection rejection is logged and survived', () => {
    const logs = [];
    const exits = [];
    const r = onUnhandledRejection(closed(), {
      log: (...a) => logs.push(a.join(' ')),
      exit: (code) => exits.push(code),
    });
    expect(r).toBe('survived');
    expect(exits).toEqual([]);
    expect(logs[0]).toContain('ERR_POSTGRES_CONNECTION_CLOSED');
  });

  test('anything else still ends the process, as Bun would', () => {
    const exits = [];
    const r = onUnhandledRejection(new TypeError('boom'), {
      log: () => {},
      exit: (code) => exits.push(code),
    });
    expect(r).toBe('exited');
    expect(exits).toEqual([1]);
  });
});

/*
 * The real thing, where CI has a Postgres: a page read built from fragments,
 * under a statement timeout, has its backend terminated mid-flight (what
 * earlyoom did on dev2). The caller gets the error; nothing else is left
 * rejecting with no one to hear it.
 */
const postgresTest = process.env.MIGRATION_TEST_DATABASE_URL ? test : test.skip;

postgresTest(
  'a bounded read whose backend is killed leaves no unhandled rejection',
  async () => {
    const url = process.env.MIGRATION_TEST_DATABASE_URL;
    const db = connect({ url, max: 2, idleTimeout: 0 });
    const admin = connect({ url, max: 1, idleTimeout: 0 });
    const stray = [];
    const listener = (reason) => stray.push(reason);
    process.on('unhandledRejection', listener);
    try {
      // Built as recentItems builds: fragments, then the statement around them.
      const ok = await bounded(db, 5_000, (d) => {
        const pick = d`${'a'}::text as x, current_setting('statement_timeout') as st`;
        const where = d`${1}::int = 1`;
        return d`select ${pick} where ${where}`;
      });
      expect(ok[0]).toEqual({ x: 'a', st: '5s' });

      const pending = bounded(db, 60_000, (d) => {
        const sleep = d`pg_sleep(${5})`;
        const where = d`${1}::int = 1 and ${d`true`}`;
        return d`select ${sleep} where ${where}`;
      }).then(
        () => 'finished',
        (err) => err,
      );
      await Bun.sleep(500);
      await admin`
        select pg_terminate_backend(pid) from pg_stat_activity
        where query like '%pg_sleep%' and pid <> pg_backend_pid()`;
      const err = await pending;
      expect(err).toBeInstanceOf(Error);
      expect(isTransientDbError(err)).toBe(true);
      await Bun.sleep(300);
      expect(stray).toEqual([]);
      // And the pool is usable again.
      expect((await db`select 1 as ok`)[0].ok).toBe(1);
    } finally {
      process.off('unhandledRejection', listener);
      await db.end();
      await admin.end();
    }
  },
  30_000,
);
