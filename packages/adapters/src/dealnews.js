import { defineAdapter, first, stripHtml, xmlItems } from '@nichedb/core/adapter';
import { cleanUrl, dealTags, extractCode, extractDiscount, storeFields } from './dealcodes.js';

/**
 * DealNews: an editorial deal desk since 1997, read from its RSS. Keyless.
 *
 * The one deal feed that publishes structure. Every item carries the retailer,
 * the price with its currency, when the deal expires, its category, whether
 * it is a deal, a sale or a product page, and whether the staff picked it, all
 * in the `dealnews:` namespace. So this adapter parses almost nothing; it
 * reads fields. The code, when there is one, is still in the prose.
 *
 * Two orderings, the same 48 items a few hours apart: `time` is what was just
 * posted and `hotness` is what readers are clicking. Terms: attribute DealNews
 * and do not alter the links, which is why the URL keeps its path and only
 * loses the `iref=rss` tracking.
 */

export const SORTS = {
  time: 'https://www.dealnews.com/?rss=1&sort=time',
  hotness: 'https://www.dealnews.com/?rss=1&sort=hotness',
};

const KINDS = new Set(['deal', 'sale', 'product']);

/** One RSS item to one deal. Exported for the test. */
export function toItem(it) {
  const title = stripHtml(first(it.title)?.text ?? '');
  const guid = first(it.guid)?.text?.trim() || first(it.link)?.text?.trim() || null;
  if (!title || !guid) return null;
  const id = guid.match(/\/(\d+)\.html/)?.[1] ?? guid;
  const description = stripHtml(first(it.description)?.text ?? '');
  const retailer = first(it['dealnews:retailer'])?.text?.trim() || null;
  const priceField = first(it['dealnews:price']);
  const price = priceField?.text ? Number(priceField.text) : null;
  const expires = first(it['dealnews:expires'])?.text || null;
  const dealType = first(it['dealnews:dealType'])?.text?.trim().toLowerCase() || 'deal';
  const category = first(it['dealnews:category'])?.text?.trim() || null;
  const staffPick = first(it['dealnews:staffPick'])?.text === 'true';
  const image = first(it['media:content'])?.attrs?.url || null;
  const text = `${title}\n${description}`;
  const code = extractCode(text);
  const discount = extractDiscount(text);
  const store = storeFields(retailer);
  const extra = [];
  if (staffPick) extra.push('editors-pick');
  if (category) extra.push(`category:${category.toLowerCase()}`);
  let kind = KINDS.has(dealType) ? dealType : 'deal';
  if (code) kind = 'coupon';
  return {
    externalId: `dealnews-${id}`,
    kind,
    title,
    summary: description.slice(0, 1000) || null,
    url: cleanUrl(first(it.link)?.text ?? ''),
    imageUrl: image,
    publishedAt: first(it.pubDate)?.text || null,
    tags: dealTags('dealnews', { storeKey: store.storeKey, code, discount, extra }),
    data: {
      ...store,
      code,
      discountType: discount?.type ?? null,
      discountValue: discount?.value ?? null,
      price: Number.isFinite(price) ? price : null,
      currency: priceField?.attrs?.currency ?? null,
      expires,
      dealType,
      category,
      staffPick,
    },
  };
}

export const dealnews = defineAdapter({
  name: 'dealnews',
  title: 'DealNews',
  collection: 'deals',
  description:
    'Every deal DealNews posts, with the retailer, the price, the expiry, the category and whether the staff picked it, as fields rather than prose. Newest first or hottest first. Keyless.',
  docs: 'https://www.dealnews.com/pages/rss.html',
  kinds: ['deal', 'sale', 'product', 'coupon'],
  cadenceMinutes: 30,
  configFields: [
    {
      key: 'sort',
      label: 'Order',
      type: 'select',
      options: Object.keys(SORTS),
      help: 'time or hotness.',
    },
  ],
  defaults: { sort: 'time' },
  defaultSources: [
    { slug: 'dealnews-latest', name: 'DealNews: latest', config: { sort: 'time' } },
    { slug: 'dealnews-hottest', name: 'DealNews: hottest', config: { sort: 'hotness' } },
  ],
  async pull({ config, http, log }) {
    const sort = SORTS[config.sort] ? config.sort : 'time';
    const xml = await http.text(SORTS[sort]);
    const items = xmlItems(xml, 'item').map(toItem).filter(Boolean);
    const coded = items.filter((i) => i.data.code).length;
    log(`${items.length} item(s), ${coded} with a code`);
    return { items, note: `${items.length} by ${sort}, ${coded} with a code` };
  },
});
