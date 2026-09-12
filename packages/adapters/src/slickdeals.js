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
 * Slickdeals: the largest deal community in the US, read from the RSS its own
 * search publishes. Keyless.
 *
 * Three feeds are worth watching and they are the same search with a different
 * mode: the front page, which is the handful of deals the editors promoted out
 * of the forums today; the popular list, which is the forum's own vote; and a
 * search for "coupon code", which is the one that yields codes rather than
 * prices. Each is capped at 25 items, so a source is cheap and the cadence can
 * be short.
 *
 * The store is a fact the feed gives: every outbound link in the post body is
 * a Slickdeals redirect carrying `data-store-slug`, `data-store-id` and the
 * destination host in `data-product-exitWebsite`. That is more than any other
 * deal feed says and it is why Slickdeals items carry `data.storeDomain`. The
 * community's vote is in the body too, as "Thumb Score: +27".
 */

export const FEEDS = {
  frontpage:
    'https://slickdeals.net/newsearch.php?mode=frontpage&searcharea=deals&searchin=first&rss=1',
  popular:
    'https://slickdeals.net/newsearch.php?mode=popdeals&searcharea=deals&searchin=first&rss=1',
  'coupon-codes':
    'https://slickdeals.net/newsearch.php?src=SearchBarV2&q=coupon+code&searcharea=deals&searchin=first&rss=1',
};

/** One RSS item to one deal. Exported for the test. */
export function toItem(it, feed) {
  const title = stripHtml(first(it.title)?.text ?? '');
  const guid = first(it.guid)?.text?.trim() || null;
  if (!title || !guid) return null;
  const body = first(it['content:encoded'])?.text ?? '';
  const description = stripHtml(first(it.description)?.text ?? '');
  const link = first(it.link)?.text ?? '';
  const outbound = body.match(/<a\s[^>]*data-store-slug="([^"]*)"[^>]*>/i);
  const attr = (name) => outbound?.[0].match(new RegExp(`${name}="([^"]*)"`, 'i'))?.[1] || null;
  const storeSlug = attr('data-store-slug');
  const domain = attr('data-product-exitWebsite');
  const asin = attr('data-aps-asin');
  const score = Number(body.match(/Thumb Score:\s*([+-]?\d+)/)?.[1] ?? Number.NaN);
  const image = body.match(/<img\s[^>]*src="([^"]+)"/i)?.[1] || null;
  const text = `${title}\n${stripHtml(body)}`;
  const code = extractCode(text);
  const discount = extractDiscount(text);
  const store = storeFields(storeSlug ? storeSlug.replace(/-/g, ' ') : domain, {
    domain,
    slug: storeSlug,
  });
  const category = first(it.category)?.text?.trim() || null;
  const extra = [];
  if (feed === 'frontpage' || category === 'Frontpage Deals') extra.push('editors-pick');
  if (feed === 'popular' || category === 'Popular Deals') extra.push('popular');
  return {
    externalId: guid,
    kind: code ? 'coupon' : 'deal',
    title,
    summary: description.slice(0, 1000) || null,
    url: cleanUrl(link),
    imageUrl: image,
    publishedAt: first(it.pubDate)?.text || null,
    tags: dealTags('slickdeals', { storeKey: store.storeKey, code, discount, extra }),
    data: {
      ...store,
      code,
      discountType: discount?.type ?? null,
      discountValue: discount?.value ?? null,
      price: extractPrice(title),
      score: Number.isFinite(score) ? score : null,
      author: first(it['dc:creator'])?.text || null,
      category,
      asin,
      feed,
    },
  };
}

export const slickdeals = defineAdapter({
  name: 'slickdeals',
  title: 'Slickdeals',
  collection: 'deals',
  description:
    'Deals and coupon codes from the Slickdeals community: the front page the editors promote, the popular list the forum votes up, and a search for coupon codes. Every post names its store and the destination host, and the code is lifted out of the text. Keyless.',
  docs: 'https://slickdeals.net/newsearch.php',
  kinds: ['deal', 'coupon'],
  cadenceMinutes: 30,
  configFields: [
    {
      key: 'feed',
      label: 'Feed',
      type: 'select',
      options: Object.keys(FEEDS),
      help: 'frontpage is the editors, popular is the vote, coupon-codes is the search that yields codes.',
    },
  ],
  defaults: { feed: 'frontpage' },
  defaultSources: [
    { slug: 'slickdeals-frontpage', name: 'Slickdeals: front page', config: { feed: 'frontpage' } },
    { slug: 'slickdeals-popular', name: 'Slickdeals: popular deals', config: { feed: 'popular' } },
    {
      slug: 'slickdeals-coupon-codes',
      name: 'Slickdeals: coupon codes',
      config: { feed: 'coupon-codes' },
    },
  ],
  async pull({ config, http, log }) {
    const feed = FEEDS[config.feed] ? config.feed : 'frontpage';
    const xml = await http.text(FEEDS[feed]);
    const items = xmlItems(xml, 'item')
      .map((it) => toItem(it, feed))
      .filter(Boolean);
    const coded = items.filter((i) => i.data.code).length;
    log(`${items.length} item(s), ${coded} with a code`);
    return { items, note: `${items.length} from ${feed}, ${coded} with a code` };
  },
});
