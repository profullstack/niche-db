/**
 * How much history BullMQ keeps in Redis, in one place.
 *
 * Three things accumulate if nothing bounds them: finished job hashes (each one
 * holding its data and return value), the `completed` / `failed` sets indexing
 * them, and each queue's `events` stream. The first two are bounded per job by
 * `removeOnComplete` / `removeOnFail`; the stream is bounded per queue by
 * `streams.events.maxLen`, which BullMQ stores in the queue's meta hash when a
 * Queue is constructed. Its own default is 10,000 entries, which is what every
 * busy stream on dev2 was sitting at (2026-10-01): ~1MB each for ticks that
 * return a few counts, and 7.7MB for data-dumps.
 *
 * Nothing in this codebase reads the event streams back -- there is no
 * QueueEvents -- so they are observability only, and a thousand is plenty.
 */
export const EVENT_STREAM_MAX_LEN = 1000;

export const streams = { events: { maxLen: EVENT_STREAM_MAX_LEN } };

/**
 * Completed jobs: an hour, and never more than a thousand per queue.
 *
 * The hour matters beyond debugging: a jobId that is still retained dedupes a
 * new add (the boot jobs bucket by minute, `dl-<feed>-<item>` by content), so
 * the window must outlive the minute bucket. The count is what bounds a burst:
 * ingest-run alone completes several hundred an hour.
 */
export const KEEP_COMPLETED = { age: 3600, count: 1000 };

/**
 * Failed jobs: a week, so a failure seen on Monday is still inspectable on
 * Friday, capped at a thousand so a source that fails every minute cannot fill
 * Redis with stack traces. Measured 2026-10-01: at most 72 per queue.
 */
export const KEEP_FAILED = { age: 7 * 24 * 3600, count: 1000 };

export const retention = { removeOnComplete: KEEP_COMPLETED, removeOnFail: KEEP_FAILED };

/**
 * An events stream larger than this is emptied rather than trimmed by count:
 * a thousand entries is only safe while each entry is small, and a stream
 * this big means some processor returned bulk data (tipoffwatch's live tick
 * once put 15GB in one stream that way).
 */
export const EVENT_STREAM_MAX_BYTES = 32 * 1024 * 1024;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One pass over every queue bringing what is ALREADY in Redis inside the caps
 * above. New options only govern new jobs, so without this a backlog written
 * under the old defaults stays until the stream turns over.
 *
 * Safe to run on every boot: once everything is within bounds each queue costs
 * an XLEN, a MEMORY USAGE and two ZRANGEBYSCOREs, and removes nothing. It works
 * in small steps with a pause between them so no single command holds Redis.
 * Errors are logged, never thrown: this must not stop a worker from booting.
 */
export async function pruneQueues(
  queues,
  {
    log = console.log,
    maxLen = EVENT_STREAM_MAX_LEN,
    maxBytes = EVENT_STREAM_MAX_BYTES,
    step = 500,
    pauseMs = 25,
  } = {},
) {
  const report = [];
  for (const queue of queues) {
    try {
      const r = await pruneQueue(queue, { maxLen, maxBytes, step, pauseMs });
      report.push(r);
      if (r.events.removed || r.completed || r.failed) {
        log(
          `[queue] pruned ${r.name}: events ${r.events.before} -> ${r.events.after} ` +
            `(${mb(r.events.bytes)} before), ${r.completed} completed, ${r.failed} failed`,
        );
      }
    } catch (err) {
      log(`[queue] prune ${queue.name} failed: ${err?.message ?? err}`);
    }
  }
  const removed = report.reduce((n, r) => n + r.events.removed + r.completed + r.failed, 0);
  log(`[queue] retention pass: ${report.length} queue(s), ${removed} entr(ies) removed`);
  return report;
}

async function pruneQueue(queue, { maxLen, maxBytes, step, pauseMs }) {
  const client = await queue.client;
  const key = queue.keys.events;
  // Clean first: each clean call itself appends a `cleaned` event to the stream.
  const completed = await cleanInSteps(queue, KEEP_COMPLETED.age * 1000, 'completed', {
    step,
    pauseMs,
  });
  const failed = await cleanInSteps(queue, KEEP_FAILED.age * 1000, 'failed', { step, pauseMs });

  const before = Number(await client.xlen(key));
  const bytes = Number(await client.call('MEMORY', 'USAGE', key)) || 0;
  const target = bytes > maxBytes ? 0 : maxLen;

  // Exact MAXLEN, not `~`: an approximate trim only drops whole radix nodes,
  // and an oversized entry is a node of its own, so `~` can leave the very
  // entries this exists to remove.
  let len = before;
  while (len > target) {
    await client.xtrim(key, 'MAXLEN', Math.max(target, len - step));
    len = Number(await client.xlen(key));
    if (len > target) await sleep(pauseMs);
  }

  return {
    name: queue.name,
    events: { before, after: len, removed: before - len, bytes },
    completed,
    failed,
  };
}

async function cleanInSteps(queue, graceMs, type, { step, pauseMs }) {
  // Ask first: a clean call appends a `cleaned` event even when it removes
  // nothing, so calling it unconditionally would grow the stream on every boot.
  // Finished sets are scored by finishedOn, the same clock clean() goes by.
  const client = await queue.client;
  const due = Number(await client.zcount(queue.keys[type], '-inf', Date.now() - graceMs));
  if (!due) return 0;
  let total = 0;
  for (;;) {
    const ids = await queue.clean(graceMs, step, type);
    total += ids.length;
    if (ids.length < step) return total;
    await sleep(pauseMs);
  }
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)}MB`;
