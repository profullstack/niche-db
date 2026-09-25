import { config } from '@nichedb/config';
import {
  ADAPTERS,
  enrichPending,
  refreshCollectionStats,
  runSource,
  scanFeeds,
} from '@nichedb/core';
import { generateDump } from '@nichedb/core/data-dumps';
import { syncTlds } from '@nichedb/core/tlds';
import { buildBigIndexesOnce } from '@nichedb/db/build-indexes';
import { cleanGinPendingLists } from '@nichedb/db/gin-maintenance';
import * as q from '@nichedb/db/queries';
import { sendEmail, sendPush } from '@nichedb/notify';
import { buildEvent, sendWebhook } from '@profullstack/autoblog';
import { Worker } from 'bullmq';
import { connection, QUEUES, queues } from './index.js';
import { scheduleDueRuns } from './ingest-scheduling.js';

const log = (...a) => console.log('[worker]', ...a);

/* -------------------------------------------------------------------- tick -- */

/** The longest a run may take: the deployment's deadline, or an adapter's own budget when larger. */
const longestRunMs = () =>
  Math.max(config.ingest.runDeadlineMs, ...ADAPTERS.map((a) => a.budgetMs ?? 0));

/**
 * Which sources are due? Deduplicate through the entire wait and execution,
 * and page past queued sources so new sources can enter a busy queue.
 */
async function runTick(job) {
  // One window for both: a run younger than this is in flight and must not be
  // enqueued again; one older than it was just marked abandoned and may be.
  const runningMinutes = Math.ceil(longestRunMs() / 60_000) + 10;
  await q.reapStaleRuns({ minutes: runningMinutes });
  const result = await scheduleDueRuns({
    queue: queues.run,
    readDue: q.dueSources,
    force: Boolean(job.data?.force),
    runningMinutes,
  });
  if (result.added) log(`tick: queued ${result.added} source(s); checked ${result.scanned}`);
  return { due: result.added };
}

/* -------------------------------------------------------------------- scan -- */

async function runScan() {
  const work = await scanFeeds({ log });
  for (const { feed, items } of work) {
    await queues.deliver.add(
      'deliver',
      { feedId: feed.id, itemIds: items.map((i) => Number(i.id)) },
      { jobId: `dl-${feed.id}-${items[items.length - 1].id}` },
    );
  }
  return { feeds: work.length };
}

/* ----------------------------------------------------------------- deliver -- */

/**
 * One feed, one batch of new items, every follower. Claim first, then send:
 * the worst case is a dropped digest, not a duplicate one.
 */
async function runDeliver(job) {
  const { feedId, itemIds } = job.data;
  const feed = await q.getFeedById(feedId);
  if (!feed) return { skipped: 'feed gone' };
  const items = (await Promise.all(itemIds.map((id) => q.getItem(id)))).filter(Boolean);
  if (items.length === 0) return { skipped: 'items gone' };

  const targets = await q.followerTargets(feedId);
  const claims = [];
  for (const t of targets) {
    for (const channel of t.channels ?? []) {
      if (channel === 'webpush' && (t.push_subscriptions?.length ?? 0) === 0) continue;
      if (channel === 'email' && !t.email) continue;
      if (channel === 'webhook' && !(t.webhook_url && t.webhook_secret)) continue;
      for (const it of items) {
        claims.push({ feed_id: feedId, user_id: t.user_id, item_id: Number(it.id), channel });
      }
    }
  }
  const won = await q.claimDeliveries(claims);
  if (won.length === 0) return { sent: 0, deduped: claims.length };

  // Group what each person won, per channel, into one message.
  const perUser = new Map();
  for (const c of won) {
    const key = `${c.user_id}|${c.channel}`;
    if (!perUser.has(key)) perUser.set(key, { userId: c.user_id, channel: c.channel, itemIds: [] });
    perUser.get(key).itemIds.push(Number(c.item_id));
  }
  const byUser = new Map(targets.map((t) => [t.user_id, t]));
  const byItem = new Map(items.map((i) => [Number(i.id), i]));

  let sent = 0;
  let failed = 0;
  for (const { userId, channel, itemIds: ids } of perUser.values()) {
    const target = byUser.get(userId);
    const batch = ids.map((id) => byItem.get(id)).filter(Boolean);
    try {
      if (channel === 'webpush') await sendPush(target, { feed, items: batch });
      else if (channel === 'email') await sendEmail(target, { feed, items: batch });
      else if (channel === 'webhook') await sendItemWebhooks(target, { feed, items: batch });
      sent++;
    } catch (err) {
      failed++;
      await q.markDeliveriesFailed({ feedId, userId, itemIds: ids, channel });
      log(`deliver ${feed.slug} -> ${channel} failed: ${err.message}`);
    }
  }
  log(`deliver ${feed.slug}: ${items.length} item(s), sent ${sent}, failed ${failed}`);
  return { sent, failed };
}

/**
 * One signed POST per item, as a CloudEvents post-published event with
 * Standard Webhooks headers (@profullstack/autoblog). The receiver verifies
 * with the secret it gave us when it followed. Any non-2xx fails the batch so
 * it is marked for retry.
 */
async function sendItemWebhooks(target, { feed, items }) {
  for (const it of items) {
    const event = buildEvent(
      {
        id: `item_${it.id}`,
        url: it.url ?? `${config.siteUrl}/i/${it.id}`,
        title: it.title,
        slug: `${feed.slug}/${it.id}`,
        html: it.summary ? `<p>${String(it.summary).replace(/</g, '&lt;')}</p>` : '',
        status: 'published',
        published_at: new Date(it.published_at ?? it.first_seen_at).toISOString(),
        updated_at: new Date(it.updated_at ?? it.first_seen_at).toISOString(),
        tags: it.tags ?? [],
        categories: [feed.collection_slug, it.kind].filter(Boolean),
        _nichedb: { feed: feed.slug, source: it.source_slug, kind: it.kind, data: it.data },
      },
      { source: config.siteUrl },
    );
    const r = await sendWebhook(target.webhook_url, event, {
      secret: target.webhook_secret,
      userAgent: `niche-db/0.1 (+${config.siteUrl})`,
    });
    if (!r.ok)
      throw new Error(`webhook ${r.status ?? 'failed'} from ${new URL(target.webhook_url).host}`);
  }
  return items.length;
}

/* -------------------------------------------------------------------- boot -- */

export function startWorkers() {
  const workers = [
    new Worker(QUEUES.tick, runTick, { connection, concurrency: 1 }),
    new Worker(QUEUES.run, (job) => runSource(job.data.sourceId, { log }), {
      connection,
      concurrency: config.ingest.concurrency,
      lockDuration: longestRunMs() + 60_000,
    }),
    new Worker(QUEUES.scan, runScan, { connection, concurrency: 1 }),
    new Worker(QUEUES.deliver, runDeliver, { connection, concurrency: 8 }),
    // One at a time: the enrichers talk to rate-limited third parties and
    // pace themselves inside a run; two runs at once would double that rate.
    new Worker(QUEUES.enrich, () => enrichPending({ log }), {
      connection,
      concurrency: 1,
      lockDuration: 10 * 60_000,
    }),
    // One at a time: each collection's recount is a scan of that collection.
    new Worker(QUEUES.stats, () => refreshCollectionStats({ log }), {
      connection,
      concurrency: 1,
      lockDuration: config.stats.budgetMs + config.stats.statementTimeoutMs + 60_000,
    }),
    /*
     * One at a time: merging a GIN pending list is I/O, and two at once would
     * compete with the ingest this exists to keep out of trouble.
     */
    new Worker(
      QUEUES.maintain,
      async () => {
        /*
         * The index builder runs on this tick as well as at boot. Its drop and
         * its build both hold short locks under a lock_timeout, so on a busy
         * table either can lose the race and give up -- which is the correct
         * behaviour and also means one attempt per deploy is not enough.
         * Production, 2026-09-24: `canceling statement due to lock timeout`,
         * and the index then waited for the next deploy to try again. It is
         * cheap to repeat: a valid index costs one catalog query.
         */
        // Started, never awaited: a build runs for as long as it runs, and the
        // tick must not hold its queue lock open for it.
        buildBigIndexesOnce({ log }).catch((err) => log(`[indexes] ${err?.message ?? err}`));
        return cleanGinPendingLists({ log, timeoutMs: config.maintenance.ginStatementTimeoutMs });
      },
      {
        connection,
        concurrency: 1,
        lockDuration: config.maintenance.ginStatementTimeoutMs + 60_000,
      },
    ),
  ];
  if (config.tlds.enabled)
    workers.push(
      new Worker(QUEUES.tlds, async () => log('[tlds]', JSON.stringify(await syncTlds({ log }))), {
        connection,
        concurrency: 1,
        lockDuration: 20 * 60_000,
      }),
    );
  if (config.dataDumps.enabled)
    workers.push(
      new Worker(QUEUES.dumps, () => generateDump({ log }), {
        connection,
        concurrency: 1,
        lockDuration: 60 * 60_000,
      }),
    );
  for (const w of workers) {
    w.on('failed', (job, err) =>
      console.error(`[worker] ${w.name} job ${job?.id} failed:`, err?.message),
    );
  }
  log(`started ${workers.length} workers`);
  return workers;
}
