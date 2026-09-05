import { config } from '@nichedb/config';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

/**
 * BullMQ needs `maxRetriesPerRequest: null` on the connection it blocks on.
 * One connection object shared across queues keeps the socket count flat.
 */
export const connection = new IORedis(config.redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

export const QUEUES = {
  /** Every minute: which sources are due? Enqueues one `run` per source. */
  tick: 'ingest-tick',
  /** One job per source run. Concurrency is the ingest parallelism. */
  run: 'ingest-run',
  /** Every minute: which followed feeds have new items? Enqueues `deliver`. */
  scan: 'feed-scan',
  /** One job per (feed, batch of new items). Fans out to followers. */
  deliver: 'feed-deliver',
};

const defaults = {
  removeOnComplete: { age: 3600, count: 5000 },
  removeOnFail: { age: 86400 },
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
};

export const queues = Object.fromEntries(
  Object.entries(QUEUES).map(([k, name]) => [
    k,
    new Queue(name, { connection, defaultJobOptions: defaults }),
  ]),
);

/* Job ids are bucketed by minute so several instances booting together enqueue
   the same job rather than one each. Never a ':' in a job id -- BullMQ parses
   that as a structured key and crashes at runtime. */
export const minuteStamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

/**
 * Repeatables are declared, not accumulated: clear and re-add on every boot so
 * the code is the single source of truth. A repeatable first fires one interval
 * from NOW, so both tickers are also enqueued once immediately -- the data
 * (next_run_at, last_scanned_item_id) decides whether they do anything.
 */
export async function installSchedules({ log = console.log } = {}) {
  for (const queue of [queues.tick, queues.scan]) {
    for (const r of await queue.getRepeatableJobs()) await queue.removeRepeatableByKey(r.key);
  }
  await queues.tick.add(
    'tick',
    {},
    { repeat: { every: config.ingest.tickSeconds * 1000 }, jobId: 'tick' },
  );
  await queues.scan.add(
    'scan',
    {},
    { repeat: { every: config.feeds.scanSeconds * 1000 }, jobId: 'scan' },
  );
  await queues.tick.add(
    'tick',
    { force: config.ingest.onBoot },
    { jobId: `tick-boot-${minuteStamp()}`, delay: 5_000 },
  );
  await queues.scan.add('scan', {}, { jobId: `scan-boot-${minuteStamp()}`, delay: 20_000 });
  log('[queue] schedules installed');
}

/** Ask for one source to run now, from a button or the API. */
export async function enqueueRun(sourceId, { force = false } = {}) {
  return queues.run.add(
    'run',
    { sourceId, force },
    { jobId: `run-${sourceId}-${minuteStamp()}`, attempts: 1 },
  );
}

export async function closeQueues() {
  await Promise.all(Object.values(queues).map((queue) => queue.close()));
  await connection.quit();
}
