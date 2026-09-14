# Ingestion queue recovery

The scheduler formerly assigned a different job ID every minute while a source
waited to run. Waiting did not advance its database schedule, so a slow queue
accumulated repeated requests for the same sources. On September 14, 2026 the
production queue held over 74,000 waiting jobs; 38 new California police sources
had never reached a worker.

Runs now use BullMQ simple deduplication with a source ID key. The key remains
through waiting and execution, then releases on success or failure. A separate
unique job ID retains history without suppressing the next scheduled run.
Scheduled and manually requested jobs use the same deduplication key.

The scheduler pages past sources already represented in Redis. It admits at
most 50 new runs per tick rather than repeatedly selecting only the first 50
overdue sources. Paging is ordered by next-run time and source ID. This bounds
duplicate work; execution still depends on worker capacity and upstream speed.

For queues created before this change, inspect the backlog with:

```sh
bun apps/worker/src/repair-queue-cli.js
```

Apply only after the deduplicating scheduler is deployed:

```sh
bun apps/worker/src/repair-queue-cli.js --apply
```

The repair writes a timestamped JSON backup of pending job metadata to `/tmp`,
then creates or locates one deduplicated replacement per source **before**
removing old requests. It preserves manual force flags. Active jobs, other job
types, source configuration, ingested records, and completed history remain
untouched. Removal uses BullMQ's API, which rejects jobs that become active
during the repair. Run the inspection again afterward to verify the backlog.
The backup is local to the container and should be retained externally if
long-term audit storage is needed.

Tests exercise real Redis: concurrent requests while waiting and active,
rescheduling after success and failure, paging past queued sources, and safe
consolidation of legacy jobs. CI provides an isolated Redis service; locally set
`REDIS_TEST_URL` to a test Redis instance. Test queues use unique namespaces and
remove only their own keys.
