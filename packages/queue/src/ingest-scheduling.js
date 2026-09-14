import { randomUUID } from 'node:crypto';

export const sourceDeduplicationId = (sourceId) => `source-${sourceId}`;

/** One waiting or active run per source, across ticks and manual requests.
 * A fresh job ID lets a completed source run again even while its history is
 * retained. BullMQ releases the deduplication key on completion or failure.
 */
export function enqueueSourceRun(queue, sourceId, { force = false } = {}) {
  return queue.add(
    'run',
    { sourceId, force },
    {
      jobId: `run-${sourceId}-${randomUUID()}`,
      deduplication: { id: sourceDeduplicationId(sourceId) },
      attempts: 1,
    },
  );
}

/** Pending sources stay due in SQL until execution starts. Look past them
 * instead of spending every tick on the same first page of queued sources.
 */
export async function scheduleDueRuns({
  queue,
  readDue,
  force = false,
  runningMinutes,
  limit = 50,
  pageSize = 100,
  deadline = Date.now() + 15000,
}) {
  let offset = 0;
  let added = 0;
  let scanned = 0;
  while (added < limit && Date.now() < deadline) {
    const due = await readDue({ limit: pageSize, offset, force, runningMinutes });
    if (!due.length) break;
    const pending = await Promise.all(
      due.map((s) => queue.getDeduplicationJobId(sourceDeduplicationId(s.id))),
    );
    for (let i = 0; i < due.length && added < limit; i++) {
      scanned++;
      if (pending[i]) continue;
      await enqueueSourceRun(queue, due[i].id, { force });
      added++;
    }
    offset += due.length;
    if (due.length < pageSize) break;
  }
  return { added, scanned };
}
