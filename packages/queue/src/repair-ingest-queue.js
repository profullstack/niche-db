import { enqueueSourceRun } from './ingest-scheduling.js';

/** Consolidate a snapshot of pending runs through BullMQ's own APIs.
 * Create/locate the replacement before removing old requests. Active jobs and
 * jobs with another purpose are never removed. No source or item data changes.
 */
export async function compactPendingRuns(queue, jobs, { apply = false, log = () => {} } = {}) {
  const groups = new Map();
  for (const job of jobs) {
    if (job?.name !== 'run' || !/^\d+$/.test(String(job.data?.sourceId))) continue;
    const key = String(job.data.sourceId);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(job);
  }
  const result = { jobs: jobs.length, sources: groups.size, duplicates: 0, removed: 0, skipped: 0 };
  for (const group of groups.values()) result.duplicates += group.length - 1;
  if (!apply) return result;
  for (const [sourceId, group] of groups) {
    let stillPending = false;
    for (const job of group) {
      if (['waiting', 'delayed', 'prioritized', 'paused'].includes(await job.getState())) {
        stillPending = true;
        break;
      }
    }
    if (!stillPending) {
      result.skipped += group.length;
      continue;
    }
    const force = group.some((job) => job.data.force === true);
    const replacement = await enqueueSourceRun(queue, sourceId, { force });
    const kept = await queue.getJob(replacement.id);
    if (!kept)
      throw new Error(`Replacement disappeared for source ${sourceId}; stopped before deletion`);
    if (force && !kept.data.force) await kept.updateData({ ...kept.data, force: true });
    for (const job of group) {
      if (job.id === replacement.id) continue;
      if (!['waiting', 'delayed', 'prioritized', 'paused'].includes(await job.getState())) {
        result.skipped++;
        continue;
      }
      try {
        // remove() also refuses a job that became active after getState().
        await job.remove();
        result.removed++;
      } catch (error) {
        if ((await job.getState()) === 'active') result.skipped++;
        else throw error;
      }
    }
    log(
      `source ${sourceId}: kept ${replacement.id}; removed ${result.removed} old requests so far`,
    );
  }
  return result;
}
