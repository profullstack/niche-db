import { assertCoinpayMerchantKey, config } from '@nichedb/config';
import { ensureDefaults, envFor } from '@nichedb/core';
import { close as closeDb, healthcheck, sql } from '@nichedb/db';
import { buildBigIndexesOnce } from '@nichedb/db/build-indexes';
import { migrate } from '@nichedb/db/migrate';
import { onUnhandledRejection, retryTransient } from '@nichedb/db/resilience';
import { configurePayments } from '@nichedb/payments';
import { closeQueues, installSchedules } from '@nichedb/queue';
import { startWorkers } from '@nichedb/queue/workers';
import { app } from './app.js';

/**
 * One process, one container. ROLES decides what this instance runs; it
 * defaults to "web,worker" so a single service does everything.
 */
configurePayments({ sql, coinpay: config.coinpay, siteUrl: config.siteUrl });
assertCoinpayMerchantKey();

/*
 * Installed before the first query: a dropped Postgres connection must not end
 * the process, at boot or after it. See @nichedb/db/resilience for why the
 * database on dev2 goes away, and what still counts as fatal.
 */
process.on('unhandledRejection', (reason) => onUnhandledRejection(reason));

async function preflight(what, fn) {
  try {
    // Postgres in crash recovery, restarting, or refusing for a minute is
    // waited out here (1s doubling to 30s, five minutes in all) rather than
    // exiting into a restart loop. Bad SQL or a rejected password still throws
    // at once. Nothing listens until this passes, so /healthz never answers
    // for a process that cannot serve.
    return what === 'postgres' ? await retryTransient(fn, { label: what }) : await fn();
  } catch (err) {
    const target = what === 'postgres' ? config.databaseUrl : config.redisUrl;
    let host = 'unparseable';
    try {
      host = new URL(target).host;
    } catch {}
    console.error(
      `[boot] cannot reach ${what} at ${host}: ${err?.message ?? err}\n` +
        `[boot] check ${what === 'postgres' ? 'DATABASE_URL' : 'REDIS_URL'} on this service.`,
    );
    throw err;
  }
}

await preflight('postgres', () => migrate());
await preflight('postgres', async () => {
  if (!(await healthcheck())) throw new Error('database healthcheck failed at boot');
});
await preflight('postgres', () => ensureDefaults({ env: envFor() }));

let workers = [];
if (config.roles.includes('worker')) {
  await preflight('redis', () => installSchedules());
  workers = startWorkers();
  /*
   * Large indexes build here rather than in a migration: after boot, outside a
   * transaction, CONCURRENTLY, so no write ever waits on one. Deliberately not
   * awaited -- the process serves while it runs, and a build interrupted by a
   * deploy is repaired by the next boot.
   */
  buildBigIndexesOnce().catch((err) => console.error('[indexes]', err));
}

let server;
if (config.roles.includes('web')) {
  server = Bun.serve({ port: config.port, fetch: app.fetch, idleTimeout: 120 });
  console.log(`[web] ${config.siteName} listening on :${config.port} (${config.roles.join(',')})`);
}

async function shutdown(signal) {
  console.log(`[boot] ${signal}, draining`);
  server?.stop(true);
  await Promise.allSettled(workers.map((w) => w.close()));
  await Promise.allSettled([closeQueues(), closeDb()]);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
