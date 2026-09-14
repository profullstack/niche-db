import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { enqueueSourceRun, scheduleDueRuns, sourceDeduplicationId } from './ingest-scheduling.js';
import { compactPendingRuns } from './repair-ingest-queue.js';

// CI supplies a Redis service. Every test owns and deletes a separate namespace.
const redisUrl = process.env.REDIS_TEST_URL;
describe.skipIf(!redisUrl)('ingestion scheduling with Redis', () => {
  let queue, connection, worker;
  beforeEach(async () => {
    connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    queue = new Queue(`test-ingest-${randomUUID()}`, { connection });
    await queue.waitUntilReady();
  });
  afterEach(async () => {
    if (worker) await worker.close();
    worker = null;
    await queue.obliterate({ force: true });
    await queue.close();
    await connection.quit();
  });
  test('concurrent requests share one waiting/active run; retained completion allows a fresh run', async () => {
    const requests = await Promise.all(
      Array.from({ length: 30 }, () => enqueueSourceRun(queue, 42)),
    );
    expect(new Set(requests.map((j) => j.id)).size).toBe(1);
    expect(await queue.getWaitingCount()).toBe(1);
    worker = new Worker(queue.name, null, { connection, autorun: false });
    const active = await worker.getNextJob('test-token', { block: false });
    expect((await enqueueSourceRun(queue, 42, { force: true })).id).toBe(active.id);
    expect(await queue.getWaitingCount()).toBe(0);
    await active.moveToCompleted('ok', 'test-token', false);
    const next = await enqueueSourceRun(queue, 42);
    expect(next.id).not.toBe(active.id);
    expect(await queue.getCompletedCount()).toBe(1);
    expect(await queue.getWaitingCount()).toBe(1);
  });
  test('failure releases the source for a later retry', async () => {
    await enqueueSourceRun(queue, 77);
    worker = new Worker(queue.name, null, { connection, autorun: false });
    const active = await worker.getNextJob('test-token', { block: false });
    await active.moveToFailed(new Error('upstream unavailable'), 'test-token', false);
    expect(await queue.getDeduplicationJobId(sourceDeduplicationId(77))).toBeNull();
    expect((await enqueueSourceRun(queue, 77)).id).not.toBe(active.id);
    expect(await queue.getFailedCount()).toBe(1);
  });
  test('a full page of queued sources cannot starve new sources on later pages', async () => {
    const sources = Array.from({ length: 123 }, (_, i) => ({ id: i + 1 }));
    await Promise.all(sources.slice(0, 120).map((s) => enqueueSourceRun(queue, s.id)));
    const readDue = async ({ limit, offset }) => sources.slice(offset, offset + limit);
    expect(await scheduleDueRuns({ queue, readDue, limit: 2, pageSize: 50 })).toEqual({
      added: 2,
      scanned: 122,
    });
    expect(await queue.getWaitingCount()).toBe(122);
    expect((await scheduleDueRuns({ queue, readDue, limit: 2, pageSize: 50 })).added).toBe(1);
    expect((await scheduleDueRuns({ queue, readDue, limit: 2, pageSize: 50 })).added).toBe(0);
    expect(await queue.getWaitingCount()).toBe(123);
  });
  test('repair keeps one request per source, preserves force, and leaves active/foreign jobs alone', async () => {
    await queue.add('run', { sourceId: 1 }, { jobId: 'old-one' });
    await queue.add('run', { sourceId: 1, force: true }, { jobId: 'old-two' });
    await queue.add('run', { sourceId: 2 }, { jobId: 'old-three' });
    await queue.add('unrelated', { sourceId: 9 }, { jobId: 'foreign' });
    const jobs = await queue.getJobs(['waiting'], 0, -1, true);
    expect((await compactPendingRuns(queue, jobs)).duplicates).toBe(1);
    expect(await queue.getWaitingCount()).toBe(4);
    worker = new Worker(queue.name, null, { connection, autorun: false });
    const active = await worker.getNextJob('test-token', { block: false });
    const result = await compactPendingRuns(queue, jobs, { apply: true });
    expect(result.skipped).toBe(1);
    expect(await active.getState()).toBe('active');
    expect(await queue.getJob('foreign')).toBeTruthy();
    const id = await queue.getDeduplicationJobId(sourceDeduplicationId(1));
    expect((await queue.getJob(id)).data.force).toBe(true);
    await active.moveToCompleted('ok', 'test-token', false);
    expect(
      (await compactPendingRuns(queue, await queue.getJobs(['waiting']), { apply: true })).removed,
    ).toBe(0);
  });
});
