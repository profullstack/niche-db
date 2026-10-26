import { config } from '@nichedb/config';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { enqueueSourceRun } from './ingest-scheduling.js';
import { pruneQueues, retention, streams } from './retention.js';

export { streams } from './retention.js';

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
  /** Every couple of minutes: enrich the newest items nobody has enriched. */
  enrich: 'enrich',
  dumps: 'data-dumps',
  /** Every few minutes: recount the collections whose stored statistics went stale. */
  stats: 'collection-stats',
  /** Every couple of minutes: merge the GIN pending lists so no insert has to. */
  maintain: 'db-maintenance',
  /** Daily: IANA's top-level domain list diffed, and every registrar's prices read. */
  tlds: 'tld-sync',
  /** Hourly: ThreatCrush's ban candidates merged into the /traffic review queue. */
  traffic: 'traffic-sync',
};

/*
 * Retention lives in retention.js. BullMQ merges these into every add()
 * shallowly, so an add that passes its own options (a repeat, a jobId,
 * attempts) still inherits removeOnComplete/removeOnFail unless it names them
 * -- and none does.
 */
export const defaults = {
  ...retention,
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
};

export const queues = Object.fromEntries(
  Object.entries(QUEUES).map(([k, name]) => [
    k,
    new Queue(name, { connection, defaultJobOptions: defaults, streams }),
  ]),
);

/* Job ids are bucketed by minute so several instances booting together enqueue
   the same job rather than one each. Never a ':' in a job id -- BullMQ parses
   that as a structured key and crashes at runtime. */
export const minuteStamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

/**
 * The recurring jobs, as BullMQ job schedulers: `[queue, id, repeat, name]`.
 *
 * BullMQ 6 dropped repeatable jobs. `add(name, data, { repeat })` no longer
 * schedules anything -- it adds one plain job and returns -- and
 * getRepeatableJobs/removeRepeatableByKey are gone, so the 5.x version of
 * installSchedules crashed every boot after the upgrade (2026-10-26, #241).
 */
export function scheduleSpecs() {
  const specs = [
    [queues.stats, 'stats', { every: config.stats.tickSeconds * 1000 }, 'stats'],
    [queues.tick, 'tick', { every: config.ingest.tickSeconds * 1000 }, 'tick'],
    [queues.scan, 'scan', { every: config.feeds.scanSeconds * 1000 }, 'scan'],
    [queues.enrich, 'enrich', { every: config.enrich.tickSeconds * 1000 }, 'enrich'],
    [queues.maintain, 'gin', { every: config.maintenance.ginTickSeconds * 1000 }, 'gin'],
  ];
  if (config.dataDumps.enabled) {
    specs.push([queues.dumps, 'hourly-dump', { pattern: '0 * * * *', tz: 'UTC' }, 'snapshot']);
  }
  if (config.tlds.enabled) {
    specs.push([queues.tlds, 'tld-sync', { pattern: config.tlds.cron, tz: 'UTC' }, 'sync']);
  }
  if (config.traffic.feedToken) {
    specs.push([
      queues.traffic,
      'traffic-sync',
      { pattern: config.traffic.cron, tz: 'UTC' },
      'sync',
    ]);
  }
  return specs;
}

/**
 * Schedules are declared, not accumulated: every scheduler the code does not
 * name is removed on boot (which also clears 5.x repeatables left in Redis),
 * and the rest are upserted, so the code is the single source of truth. A
 * scheduler first fires one interval from NOW, so the tickers are also
 * enqueued once shortly after boot -- the data (next_run_at,
 * last_scanned_item_id) decides whether they do anything.
 */
export async function installSchedules({ log = console.log } = {}) {
  const specs = scheduleSpecs();
  for (const queue of [
    queues.tick,
    queues.scan,
    queues.enrich,
    queues.dumps,
    queues.stats,
    queues.maintain,
    queues.tlds,
    queues.traffic,
  ]) {
    const wanted = new Set(specs.filter(([q]) => q === queue).map(([, id]) => id));
    for (const s of await queue.getJobSchedulers()) {
      const id = s.id ?? s.key;
      if (id && !wanted.has(id)) await queue.removeJobScheduler(id);
    }
  }
  for (const [queue, id, repeat, name] of specs) {
    await queue.upsertJobScheduler(id, repeat, { name, data: {} });
  }

  await queues.stats.add('stats', {}, { jobId: `stats-boot-${minuteStamp()}`, delay: 10_000 });
  await queues.tick.add(
    'tick',
    { force: config.ingest.onBoot },
    { jobId: `tick-boot-${minuteStamp()}`, delay: 5_000 },
  );
  await queues.scan.add('scan', {}, { jobId: `scan-boot-${minuteStamp()}`, delay: 20_000 });
  await queues.enrich.add('enrich', {}, { jobId: `enrich-boot-${minuteStamp()}`, delay: 45_000 });
  if (config.dataDumps.enabled) {
    await queues.dumps.add('snapshot', {}, { jobId: `dumps-boot-${minuteStamp()}`, delay: 15_000 });
  }
  await queues.maintain.add('gin', {}, { jobId: `gin-boot-${minuteStamp()}`, delay: 30_000 });
  if (config.tlds.enabled) {
    // Once at boot as well: an unchanged list costs one fetch, and a fresh
    // deployment (or a new registrar) should not wait a day for its first rows.
    await queues.tlds.add('sync', {}, { jobId: `tlds-boot-${minuteStamp()}`, delay: 60_000 });
  }
  if (config.traffic.feedToken) {
    await queues.traffic.add('sync', {}, { jobId: `traffic-boot-${minuteStamp()}`, delay: 90_000 });
  }
  log('[queue] schedules installed');
}

/**
 * Bring what is already in Redis inside the retention caps: the options above
 * only govern jobs added from now on. Idempotent; see pruneQueues.
 */
export function pruneHistory({ log = console.log } = {}) {
  return pruneQueues(Object.values(queues), { log });
}

/** Ask for one source to run now, from a button or the API. */
export async function enqueueRun(sourceId, { force = false } = {}) {
  return enqueueSourceRun(queues.run, sourceId, { force });
}

export async function closeQueues() {
  await Promise.all(Object.values(queues).map((queue) => queue.close()));
  await connection.quit();
}
