import { closeQueues, queues } from '@nichedb/queue';
import { compactPendingRuns } from '../../../packages/queue/src/repair-ingest-queue.js';

// Read-only by default. --apply saves a backup before consolidating requests;
// the backup contains queue metadata only, never ingested records or secrets.
const apply = process.argv.includes('--apply');
try {
  const jobs = await queues.run.getJobs(
    ['waiting', 'delayed', 'prioritized', 'paused'],
    0,
    -1,
    true,
  );
  const plan = await compactPendingRuns(queues.run, jobs);
  console.log(JSON.stringify({ apply, ...plan }));
  if (apply) {
    const backup = `/tmp/nichedb-ingest-queue-${Date.now()}.json`;
    await Bun.write(
      backup,
      JSON.stringify(
        jobs.filter(Boolean).map((j) => ({
          id: j.id,
          name: j.name,
          data: j.data,
          opts: j.opts,
          timestamp: j.timestamp,
        })),
      ),
    );
    console.log(`Backup: ${backup}`);
    console.log(
      JSON.stringify(await compactPendingRuns(queues.run, jobs, { apply, log: console.log })),
    );
  }
} finally {
  await closeQueues();
}
