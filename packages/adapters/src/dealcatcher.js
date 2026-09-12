import { defineAdapter, first, stripHtml, xmlItems } from '@nichedb/core/adapter';
import {
  cleanUrl,
  dealTags,
  extractCode,
  extractDiscount,
  extractPrice,
  storeFields,
} from './dealcodes.js';

/**
 * Dealcatcher: fifty deals a day from a small editorial desk, read from its
 * RSS. Keyless.
 *
 * The thinnest of the deal feeds: a title, a link, a picture, a time. The
 * store is the title's prefix -- "Amazon - Artificial Cedar Fir Garland
 * $19.19" -- and the price is the title's last dollar figure. The section is
 * in the URL path (`/deals/occasions/christmas/...`), which is the only
 * category it publishes.
 */

export const FEED = 'https://www.dealcatcher.com/rss';

/** One RSS item to one deal. Exported for the test. */
export function toItem(it) {
  const raw = stripHtml(first(it.title)?.text ?? '');
  const link = first(it.link)?.text?.trim() || '';
  const guid = first(it.guid)?.text?.trim() || link;
  if (!raw || !guid) return null;
  const m = raw.match(/^(.{2,40}?)\s+-\s+(.+)$/);
  const storeName = m ? m[1] : null;
  const title = m ? m[2] : raw;
  const description = first(it.description)?.text ?? '';
  const image = description.match(/<img\s[^>]*src="([^"]+)"/i)?.[1] || null;
  const section = link.match(/\/deals\/([^/]+)\//)?.[1] || null;
  const id = link.match(/-(\d+)(?:\?|$)/)?.[1] ?? cleanUrl(guid);
  const text = `${raw}\n${stripHtml(description)}`;
  const code = extractCode(text);
  const discount = extractDiscount(text);
  const store = storeFields(storeName);
  return {
    externalId: `dealcatcher-${id}`,
    kind: code ? 'coupon' : 'deal',
    title: storeName ? `${title} at ${storeName}` : title,
    summary: null,
    url: cleanUrl(link),
    imageUrl: image,
    publishedAt: first(it.pubDate)?.text || null,
    tags: dealTags('dealcatcher', {
      storeKey: store.storeKey,
      code,
      discount,
      extra: section ? [`category:${section}`] : [],
    }),
    data: {
      ...store,
      code,
      discountType: discount?.type ?? null,
      discountValue: discount?.value ?? null,
      price: extractPrice(title),
      category: section,
    },
  };
}

export const dealcatcher = defineAdapter({
  name: 'dealcatcher',
  title: 'Dealcatcher',
  collection: 'deals',
  description:
    "Today's deals from Dealcatcher, fifty at a time, with the store read from the title and the price from its last dollar figure. Keyless.",
  docs: 'https://www.dealcatcher.com/rss',
  kinds: ['deal', 'coupon'],
  cadenceMinutes: 60,
  defaultSources: [{ slug: 'dealcatcher', name: 'Dealcatcher: today’s deals' }],
  async pull({ http, log }) {
    const xml = await http.text(FEED);
    const items = xmlItems(xml, 'item').map(toItem).filter(Boolean);
    log(`${items.length} item(s)`);
    return { items, note: `${items.length} deals` };
  },
});
