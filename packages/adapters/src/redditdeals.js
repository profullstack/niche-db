import { decodeEntities, defineAdapter, first, stripHtml, xmlItems } from '@nichedb/core/adapter';
import {
  cleanUrl,
  dealTags,
  extractCode,
  extractDiscount,
  extractPrice,
  storeFields,
} from './dealcodes.js';

/**
 * Reddit's deal subreddits, read from the Atom feed each one publishes.
 * Keyless, but not anonymous: Reddit answers a generic user agent with 429 and
 * a named one with 200, and the core's user agent names this deployment.
 *
 * These are posts, not listings. r/deals is mostly links with the store in
 * square brackets ("[Amazon] ..."), r/coupons is discussion with the odd code.
 * So the kind is `post`, the store is the bracket when there is one, and the
 * code is lifted from the body when there is one; a consumer wanting rows a
 * shopper can use should take the `coupon-code` tag and leave the rest.
 * Twenty-five entries per subreddit per pull, at a cadence Reddit tolerates.
 */

export const DEFAULT_SUBREDDITS = ['deals', 'coupons'];

/** One Atom entry to one post. Exported for the test. */
export function toItem(entry, subreddit) {
  const id = first(entry.id)?.text?.trim() || null;
  const title = stripHtml(first(entry.title)?.text ?? '');
  if (!id || !title) return null;
  const link = first(entry.link)?.attrs?.href || '';
  // The body is HTML inside XML, so it arrives encoded twice: the XML reader
  // undid one layer, and the `&#32;` Reddit pads its footer with is the other.
  const content = decodeEntities(first(entry.content)?.text ?? '');
  const body = stripHtml(content)
    .replace(/\s*submitted by\s+\/u\/\S+.*$/i, '')
    .trim();
  const storeName = title.match(/^\[([^\]]{2,40})\]/)?.[1]?.trim() || null;
  const text = `${title}\n${body}`;
  const code = extractCode(text);
  const discount = extractDiscount(text);
  const store = storeFields(storeName);
  const authorText = first(entry.author)?.text ? stripHtml(first(entry.author).text) : '';
  const author = authorText.match(/\/u\/(\S+)/)?.[1] || null;
  return {
    externalId: id,
    kind: 'post',
    title,
    summary: body.slice(0, 1000) || null,
    url: cleanUrl(link),
    imageUrl: first(entry['media:thumbnail'])?.attrs?.url || null,
    publishedAt: first(entry.published)?.text || first(entry.updated)?.text || null,
    tags: dealTags('reddit', {
      storeKey: store.storeKey,
      code,
      discount,
      extra: [`r-${subreddit}`],
    }),
    data: {
      ...store,
      code,
      discountType: discount?.type ?? null,
      discountValue: discount?.value ?? null,
      price: extractPrice(title),
      subreddit,
      author,
    },
  };
}

export const redditDeals = defineAdapter({
  name: 'reddit-deals',
  title: 'Reddit deals',
  collection: 'deals',
  description:
    'New posts in the deal subreddits (r/deals and r/coupons by default), with the store read from the title and any coupon code lifted from the body. Keyless, twenty-five per subreddit per pull.',
  docs: 'https://www.reddit.com/r/deals/.rss',
  kinds: ['post'],
  cadenceMinutes: 30,
  configFields: [
    {
      key: 'subreddits',
      label: 'Subreddits',
      type: 'list',
      placeholder: 'deals, coupons',
      help: 'Names without the r/.',
    },
  ],
  defaults: { subreddits: DEFAULT_SUBREDDITS },
  defaultSources: [{ slug: 'reddit-deals', name: 'Reddit: r/deals and r/coupons' }],
  async pull({ config, http, log }) {
    const raw = Array.isArray(config.subreddits)
      ? config.subreddits
      : String(config.subreddits ?? '').split(',');
    const subs = raw.map((s) => String(s).trim().replace(/^r\//, '')).filter(Boolean);
    const items = [];
    const notes = [];
    for (const [n, sub] of (subs.length ? subs : DEFAULT_SUBREDDITS).entries()) {
      // Two feeds back to back is enough for Reddit to answer the second with
      // 429, so the subreddits are read with a breath between them, and one
      // that still refuses is skipped this run rather than failing the source.
      if (n > 0) await Bun.sleep(3000);
      try {
        const xml = await http.text(`https://www.reddit.com/r/${sub}/.rss`);
        const got = xmlItems(xml, 'entry')
          .map((e) => toItem(e, sub))
          .filter(Boolean);
        items.push(...got);
        notes.push(`r/${sub} ${got.length}`);
      } catch (e) {
        log(`r/${sub}: ${e.message}`);
        notes.push(`r/${sub} failed`);
      }
    }
    const coded = items.filter((i) => i.data.code).length;
    log(`${items.length} post(s), ${coded} with a code`);
    return { items, note: `${notes.join(', ')}; ${coded} with a code` };
  },
});
