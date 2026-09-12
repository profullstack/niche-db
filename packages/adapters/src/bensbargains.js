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
 * Ben's Bargains: an editorial deal desk since 1999, read from its RSS.
 * Keyless.
 *
 * Twenty items, and the ones most likely to carry a code: the house style is
 * "$30 - 45% off with coupon code <b>4ZLBV9H8</b> at checkout = <b>$18</b>",
 * which the shared extractor reads as a code, a percent discount and a price.
 * The store is the end of the title ("... $18 at Amazon"), and the picture is
 * protocol-relative, which is fixed here so the row has a URL a browser will
 * load.
 */

export const FEED = 'https://bensbargains.com/rss/';

/** One RSS item to one deal. Exported for the test. */
export function toItem(it) {
  const title = stripHtml(first(it.title)?.text ?? '');
  const link = first(it.link)?.text?.trim() || '';
  const guid = first(it.guid)?.text?.trim() || link;
  if (!title || !guid) return null;
  const storeName = title.match(/\bat\s+([A-Z][\w.&'+ -]{1,40}?)\s*$/)?.[1]?.trim() || null;
  const description = first(it.description)?.text ?? '';
  let image = description.match(/<img\s[^>]*src="([^"]+)"/i)?.[1] || null;
  if (image?.startsWith('//')) image = `https:${image}`;
  const id = guid.match(/-(\d+)\/?(?:#.*)?$/)?.[1] ?? cleanUrl(guid);
  const text = `${title}\n${stripHtml(description)}`;
  const code = extractCode(text);
  const discount = extractDiscount(text);
  const store = storeFields(storeName);
  return {
    externalId: `bensbargains-${id}`,
    kind: code ? 'coupon' : 'deal',
    title,
    summary: stripHtml(description).slice(0, 1000) || null,
    url: cleanUrl(link),
    imageUrl: image,
    publishedAt: first(it.pubDate)?.text || null,
    tags: dealTags('bensbargains', { storeKey: store.storeKey, code, discount }),
    data: {
      ...store,
      code,
      discountType: discount?.type ?? null,
      discountValue: discount?.value ?? null,
      price: extractPrice(title),
    },
  };
}

export const bensbargains = defineAdapter({
  name: 'bensbargains',
  title: "Ben's Bargains",
  collection: 'deals',
  description:
    "The latest twenty deals from Ben's Bargains, whose house style names the coupon code, the discount and the price in every post. Keyless.",
  docs: 'https://bensbargains.com/rss/',
  kinds: ['deal', 'coupon'],
  cadenceMinutes: 60,
  defaultSources: [{ slug: 'bens-bargains', name: "Ben's Bargains: latest" }],
  async pull({ http, log }) {
    const xml = await http.text(FEED);
    const items = xmlItems(xml, 'item').map(toItem).filter(Boolean);
    const coded = items.filter((i) => i.data.code).length;
    log(`${items.length} item(s), ${coded} with a code`);
    return { items, note: `${items.length} deals, ${coded} with a code` };
  },
});
