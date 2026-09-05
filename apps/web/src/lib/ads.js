/**
 * The sponsored item a free feed carries.
 *
 * Fetched from CrawlProof's feed fill for this deployment's slot and kept for
 * a while: a feed is fan-out, and one fetch by us is one impression however
 * many readers the document reaches. Any failure means no item — a feed is
 * never held up by an ad.
 */
import { config } from '@nichedb/config';
import { connection } from '@nichedb/queue';

const FEED_AD = 'https://crawlproof.com/api/ads/feed';

let memo = { at: 0, item: null };

/** Turn CrawlProof's `fields` answer into an item the feed builders render. */
export function sponsoredItem(fields, now = new Date()) {
  if (!fields?.ok || !fields.url) return null;
  const label = fields.label || 'Sponsored';
  const headline = fields.headline || fields.title || '';
  const body = [
    fields.summaryShort || fields.body,
    fields.attribution ? `${label} · ${fields.attribution}` : label,
  ]
    .filter(Boolean)
    .join('\n\n');
  return {
    id: `sponsored-${String(fields.guid ?? fields.impressionId ?? now.toISOString().slice(0, 10)).replace(/[^\w.-]+/g, '-')}`,
    title: `${label}: ${headline}`.trim(),
    url: fields.url,
    summary: body,
    published_at: fields.publishedAt ?? now.toISOString(),
    first_seen_at: now.toISOString(),
    time_known: true,
    precision: 'day',
    tags: ['sponsored'],
    image_url: fields.imageUrl ?? null,
    sponsored: true,
  };
}

/** The current sponsored item for this deployment, or null. Cached in Redis, then memory. */
export async function feedAd({ fetch: f = globalThis.fetch, now = Date.now() } = {}) {
  if (!config.ads.enabled) return null;
  const ttlMs = config.ads.feedTtlSeconds * 1000;
  if (memo.item !== undefined && now - memo.at < ttlMs) return memo.item;

  const key = `ads:feed:${config.ads.slot}`;
  try {
    const hit = await connection.get(key);
    if (hit) {
      memo = { at: now, item: JSON.parse(hit) };
      return memo.item;
    }
  } catch {}

  let item = null;
  try {
    const url = `${FEED_AD}?slot=${encodeURIComponent(config.ads.slot)}&as=fields&src=nichedb-feed`;
    const res = await f(url, {
      headers: { accept: 'application/json', 'user-agent': `${config.siteName} feeds` },
    });
    if (res.ok) item = sponsoredItem(await res.json());
  } catch {}
  memo = { at: now, item };
  connection.set(key, JSON.stringify(item), 'EX', config.ads.feedTtlSeconds).catch(() => {});
  return item;
}

/** For tests. */
export const resetFeedAd = () => {
  memo = { at: 0, item: undefined };
};
