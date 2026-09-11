import { assertCoinpayMerchantKey, config } from '@nichedb/config';
import { ensureDefaults, envFor } from '@nichedb/core';
import { close as closeDb, healthcheck, sql } from '@nichedb/db';
import { migrate } from '@nichedb/db/migrate';
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

async function preflight(what, fn) {
  try {
    return await fn();
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
if (!(await healthcheck())) throw new Error('database healthcheck failed at boot');
await ensureDefaults({ env: envFor() });

let workers = [];
if (config.roles.includes('worker')) {
  await preflight('redis', () => installSchedules());
  workers = startWorkers();
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
