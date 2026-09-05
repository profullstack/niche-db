import { config } from '@nichedb/config';
import * as q from '@nichedb/db/queries';

/**
 * Every minute: for each feed anybody follows, what arrived since the cursor?
 *
 * Returns work units of { feed, items } for the queue to fan out, and moves the
 * cursor. The cursor moves BEFORE delivery is confirmed, deliberately: the
 * worst case is a missed digest, never a duplicate one, and the deliveries
 * table's primary key catches a re-run anyway.
 */
export async function scanFeeds({ log = console.log } = {}) {
  const feeds = await q.feedsWithFollowers();
  const work = [];
  for (const feed of feeds) {
    const items = await q.feedItems(feed, {
      afterId: Number(feed.last_scanned_item_id),
      limit: config.feeds.perScan,
    });
    if (items.length === 0) continue;
    const top = Math.max(...items.map((i) => Number(i.id)));
    await q.setFeedScanCursor(feed.id, top);
    work.push({ feed, items: items.reverse() });
  }
  if (work.length) log(`[scan] ${work.length} feed(s) have new items`);
  return work;
}
