import { config } from '@nichedb/config';
import { close as closeDb, sql } from '@nichedb/db';
import { buildBigIndexesOnce } from '@nichedb/db/build-indexes';
import { migrate } from '@nichedb/db/migrate';
import { configurePayments } from '@nichedb/payments';
import { closeQueues, installSchedules } from '@nichedb/queue';
import { startWorkers } from '@nichedb/queue/workers';

/** Workers on their own, for when one instance stops being enough. */
configurePayments({ sql, coinpay: config.coinpay, siteUrl: config.siteUrl });
await migrate();
await installSchedules();
const workers = startWorkers();
/*
 * Large indexes build after the workers are up, outside a transaction and
 * CONCURRENTLY, so no write waits on one. Not awaited on purpose.
 */
buildBigIndexesOnce().catch((err) => console.error('[indexes]', err));

async function shutdown(signal) {
  console.log(`[worker] ${signal}, draining`);
  await Promise.allSettled(workers.map((w) => w.close()));
  await Promise.allSettled([closeQueues(), closeDb()]);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
