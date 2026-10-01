/**
 * Telling a database that is briefly away from one that is broken.
 *
 * On dev2 the shared Postgres loses connections and whole minutes as a matter of
 * course: the host's earlyoom SIGTERMs backends under memory pressure (which a
 * client sees as "terminating connection due to administrator command", then
 * "Connection closed"), and now and then SIGKILLs one, which puts the server
 * through crash recovery ("the database system is in recovery mode", then "not
 * accepting connections"). Each of those used to cost the process: a boot that
 * met one exited, Docker restarted the container, and the next boot met the
 * same recovery -- 107 restarts in one evening. None of them is a reason to
 * die; the pool reconnects by itself once the server is back.
 *
 * What IS a reason: a migration with bad SQL, a password Postgres rejects, a
 * database that does not exist. Those never get better by waiting, so they are
 * not transient and still end the process.
 */

/** Bun's client-side codes for a connection that went away or never came. */
const TRANSIENT_CODES = new Set([
  'ERR_POSTGRES_CONNECTION_CLOSED',
  'ERR_POSTGRES_CONNECTION_REFUSED',
  'ERR_POSTGRES_CONNECTION_TIMEOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
]);

/**
 * SQLSTATEs that mean "the server, not your query": class 08 (connection
 * exception), 57P01-57P03 (admin shutdown, crash shutdown, cannot connect now:
 * starting up, in recovery, shutting down), 53300 (too many connections).
 */
const TRANSIENT_SQLSTATES = new Set([
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '57P01',
  '57P02',
  '57P03',
  '53300',
]);

const TRANSIENT_MESSAGE =
  /connection closed|in recovery mode|not accepting connections|is starting up|is shutting down|terminating connection due to (administrator command|crash)|crash of another server process|ECONNREFUSED|ECONNRESET|connection refused|failed to connect|too many clients/i;

/** Whether `err` is the database being away rather than the query being wrong. */
export function isTransientDbError(err) {
  if (!err || typeof err !== 'object') return false;
  if (TRANSIENT_CODES.has(err.code)) return true;
  const state = err.errno ?? err.sqlState ?? err.code;
  if (typeof state === 'string' && TRANSIENT_SQLSTATES.has(state)) return true;
  if (err.cause && err.cause !== err && isTransientDbError(err.cause)) return true;
  return TRANSIENT_MESSAGE.test(String(err.message ?? ''));
}

/**
 * Run `fn` until it succeeds, retrying only transient database errors, with
 * capped exponential backoff (1s, 2s, 4s ... 30s) for at most `budgetMs`.
 * A fatal error, or a transient one past the budget, is thrown as it came.
 */
export async function retryTransient(
  fn,
  {
    label = '[db]',
    log = console.error,
    budgetMs = 5 * 60_000,
    baseMs = 1_000,
    maxMs = 30_000,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = Date.now,
  } = {},
) {
  const started = now();
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransientDbError(err)) throw err;
      const waited = now() - started;
      const delay = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
      if (waited + delay > budgetMs) {
        log(`${label}: still failing after ${Math.round(waited / 1000)}s, giving up`);
        throw err;
      }
      log(
        `${label}: ${err?.message ?? err} (attempt ${attempt}); retrying in ${Math.round(delay / 1000)}s`,
      );
      await sleep(delay);
    }
  }
}

/**
 * The process's backstop for a promise nobody handled. A transient database
 * error is logged and survived: whatever query it belonged to has already
 * failed for its caller, and the pool replaces the connection. Anything else
 * keeps Bun's default, which is to end the process, since state after an
 * unknown rejection cannot be trusted.
 */
export function onUnhandledRejection(
  reason,
  { log = console.error, exit = (code) => process.exit(code) } = {},
) {
  if (isTransientDbError(reason)) {
    log(
      `[process] unhandled database rejection survived: ${reason?.code ?? ''} ${reason?.message ?? reason}`,
    );
    return 'survived';
  }
  log('[process] unhandled rejection, exiting:', reason);
  exit(1);
  return 'exited';
}
