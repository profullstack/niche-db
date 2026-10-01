import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { enqueueSourceRun } from './ingest-scheduling.js';
import {
  EVENT_STREAM_MAX_LEN,
  KEEP_COMPLETED,
  KEEP_FAILED,
  pruneQueues,
  retention,
  streams,
} from './retention.js';

describe('retention caps', () => {
  test('finished jobs are bounded by both age and count', () => {
    for (const keep of [KEEP_COMPLETED, KEEP_FAILED]) {
      expect(keep.age).toBeGreaterThan(0);
      expect(keep.count).toBeGreaterThan(0);
      expect(keep.count).toBeLessThanOrEqual(5000);
    }
    // A retained completed job dedupes a re-add with its id, and the boot jobs
    // bucket by minute: the window has to outlive the bucket.
    expect(KEEP_COMPLETED.age).toBeGreaterThanOrEqual(60);
    expect(retention).toEqual({ removeOnComplete: KEEP_COMPLETED, removeOnFail: KEEP_FAILED });
  });

  test('event streams are capped well below BullMQ’s 10,000 default', () => {
    expect(streams.events.maxLen).toBe(EVENT_STREAM_MAX_LEN);
    expect(EVENT_STREAM_MAX_LEN).toBeLessThan(10_000);
  });

  test('every Queue and Worker is built with the stream cap', async () => {
    const src = (f) => Bun.file(new URL(f, import.meta.url)).text();
    for (const file of ['./index.js', './workers.js']) {
      const text = await src(file);
      const ctor = file === './index.js' ? 'new Queue(' : 'new Worker(';
      const built = text.split(ctor).length - 1;
      expect(built).toBeGreaterThan(0);
      // Each construction names `streams` within its options.
      const blocks = text.split(ctor).slice(1);
      for (const b of blocks) expect(b.slice(0, 1500)).toContain('streams');
    }
  });
});

// CI supplies a Redis service. Every test owns and deletes a separate namespace.
const redisUrl = process.env.REDIS_TEST_URL;
describe.skipIf(!redisUrl)('retention with Redis', () => {
  let queue, connection;
  const logs = [];
  const log = (l) => logs.push(l);
  beforeEach(async () => {
    logs.length = 0;
    connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    queue = new Queue(`test-retention-${randomUUID()}`, {
      connection,
      defaultJobOptions: retention,
      streams,
    });
    await queue.waitUntilReady();
  });
  afterEach(async () => {
    await queue.obliterate({ force: true });
    await queue.close();
    await connection.quit();
  });

  const fillStream = async (n, field = 'x') => {
    const pipe = connection.pipeline();
    for (let i = 0; i < n; i++) pipe.xadd(queue.keys.events, '*', 'event', 'test', 'v', field);
    await pipe.exec();
  };

  test('the queue writes its stream cap into meta, where the Lua scripts read it', async () => {
    expect(await connection.hget(queue.keys.meta, 'opts.maxLenEvents')).toBe(
      String(EVENT_STREAM_MAX_LEN),
    );
  });

  test('a job added with its own options still inherits the retention', async () => {
    const job = await enqueueSourceRun(queue, 7);
    expect(job.opts.removeOnComplete).toEqual(KEEP_COMPLETED);
    expect(job.opts.removeOnFail).toEqual(KEEP_FAILED);
    const repeat = await queue.add('tick', {}, { repeat: { every: 60_000 }, jobId: 'tick' });
    expect(repeat.opts.removeOnComplete).toEqual(KEEP_COMPLETED);
    expect(repeat.opts.removeOnFail).toEqual(KEEP_FAILED);
  });

  test('a backlog stream is trimmed to the cap exactly, then left alone', async () => {
    await fillStream(2600);
    const [r] = await pruneQueues([queue], { log, step: 500, pauseMs: 0 });
    expect(r.events.before).toBeGreaterThanOrEqual(2600);
    expect(await connection.xlen(queue.keys.events)).toBe(EVENT_STREAM_MAX_LEN);
    expect(logs.some((l) => l.includes(`pruned ${queue.name}`))).toBe(true);

    logs.length = 0;
    const [again] = await pruneQueues([queue], { log, pauseMs: 0 });
    expect(again.events.removed).toBe(0);
    expect(logs.some((l) => l.includes('pruned'))).toBe(false);
  });

  test('an oversized stream is emptied, however few entries it has', async () => {
    await fillStream(20, 'y'.repeat(64 * 1024));
    const [r] = await pruneQueues([queue], { log, maxBytes: 256 * 1024, pauseMs: 0 });
    expect(r.events.bytes).toBeGreaterThan(256 * 1024);
    expect(await connection.xlen(queue.keys.events)).toBe(0);
  });

  test('completed jobs past their age are removed, fresh ones kept', async () => {
    const worker = new Worker(queue.name, null, { connection, autorun: false, streams });
    try {
      for (const id of ['old-1', 'old-2', 'fresh']) {
        await queue.add('t', {}, { jobId: id });
        const job = await worker.getNextJob('tok', { block: false });
        await job.moveToCompleted('ok', 'tok', false);
      }
      const old = Date.now() - (KEEP_COMPLETED.age + 60) * 1000;
      for (const id of ['old-1', 'old-2']) {
        await connection.zadd(queue.keys.completed, old, id);
        await connection.hset(`${queue.keys['']}${id}`, 'finishedOn', old, 'processedOn', old);
      }
      const [r] = await pruneQueues([queue], { log, pauseMs: 0 });
      expect(r.completed).toBe(2);
      expect(await queue.getCompletedCount()).toBe(1);
      expect(await queue.getJob('fresh')).toBeTruthy();
    } finally {
      await worker.close();
    }
  });

  test('a failing queue is reported, not thrown', async () => {
    const broken = { name: 'broken', client: Promise.reject(new Error('no redis')) };
    broken.client.catch(() => {});
    const report = await pruneQueues([broken], { log });
    expect(report).toEqual([]);
    expect(logs.some((l) => l.includes('prune broken failed: no redis'))).toBe(true);
  });
});
