import { defineAdapter, first, stripHtml, xmlItems } from '@nichedb/core/adapter';

/**
 * LowEndBox: the deal desk of the budget hosting world, read from its RSS.
 *
 * Twenty years of "$12 a year for a VPS in Frankfurt" posts, and the one
 * place the small providers -- the ones with no API and no catalogue
 * endpoint -- announce a price. It is a WordPress feed, twenty posts a page,
 * with a category on each that says which it is: `Low End Virtual`,
 * `Special Offers`, `Shared Hosting`, `Reseller Hosting`, `Dedicated` are
 * offers; `Editorial & News` is the site's own writing about the industry,
 * and `Giveaways` are neither. The category is the split, not the headline,
 * because the headline of an offer and the headline of an editorial about
 * a price rise read the same.
 *
 * Daily is enough: the desk posts a handful a day and the front-page feed
 * carries twenty, so one read a day misses nothing. The guid is WordPress's
 * `?p=` id, unique per post, and is the row id; a post edited later changes
 * its content hash and updates in place.
 */
export const DEFAULT_FEEDS = ['https://lowendbox.com/feed/'];
const OFFER = /low end|offer|hosting|dedicated|vps|storage|colocation/i;
const EDITORIAL = /editorial|news|lowendboxtv|giveaway/i;

/** RSS puts the link in the element text; Atom puts it in a self-closing href. */
function linkOf(it) {
  const link = it.link;
  if (Array.isArray(link)) return link[0]?.attrs?.href ?? link[0]?.text ?? null;
  return link?.text || link?.attrs?.href || null;
}

export function kindOf(categories) {
  const named = categories.filter((c) => OFFER.test(c) || EDITORIAL.test(c));
  if (named.some((c) => OFFER.test(c))) return 'deal';
  return 'story';
}

export function toItem(it, feedUrl) {
  const url = linkOf(it);
  const externalId = first(it.guid)?.text || url;
  const title = first(it.title)?.text;
  if (!externalId || !title) return null;
  const categories = (Array.isArray(it.category) ? it.category : it.category ? [it.category] : [])
    .map((c) => c.text || c.attrs?.term)
    .filter(Boolean);
  const kind = kindOf(categories);
  const body = (first(it.description)?.text ?? first(it['content:encoded'])?.text ?? '')
    // WordPress appends "The post X appeared first on LowEndBox." to every summary.
    .replace(/<p>\s*The post .*?appeared first on .*?<\/p>/is, '');
  return {
    externalId: `lowendbox:${externalId}`,
    kind,
    title,
    summary: stripHtml(body).trim().slice(0, 600) || null,
    url,
    publishedAt: first(it.pubDate)?.text ?? first(it['dc:date'])?.text ?? null,
    tags: [
      kind,
      'lowendbox',
      ...categories.slice(0, 8).map((c) =>
        c
          .toLowerCase()
          .replace(/&amp;/g, 'and')
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, ''),
      ),
    ].filter(Boolean),
    data: {
      feed: feedUrl,
      author: first(it['dc:creator'])?.text ?? null,
      categories,
    },
  };
}

export function parseFeed(xml, feedUrl) {
  return xmlItems(xml, 'item')
    .map((it) => toItem(it, feedUrl))
    .filter(Boolean);
}

export const lowendbox = defineAdapter({
  name: 'lowendbox',
  title: 'LowEndBox offers',
  collection: 'hosting',
  description:
    'Hosting offers and industry news from LowEndBox: cheap VPS, shared, reseller and dedicated deals from the small providers who publish no catalogue, each post filed as a deal or a story by the category the desk gave it. Read from the site’s RSS. Keyless.',
  docs: 'https://lowendbox.com/feed/',
  kinds: ['deal', 'story'],
  cadenceMinutes: 1440,
  configFields: [
    {
      key: 'feeds',
      label: 'Feeds',
      type: 'list',
      placeholder: DEFAULT_FEEDS[0],
      help: 'WordPress RSS feeds to read. The default is the LowEndBox front page.',
    },
  ],
  defaults: { feeds: DEFAULT_FEEDS },
  defaultSources: [
    { slug: 'lowendbox', name: 'Hosting: LowEndBox offers', config: { feeds: DEFAULT_FEEDS } },
  ],
  async pull({ config, http, log, deadline }) {
    const feeds = (
      Array.isArray(config.feeds) ? config.feeds : String(config.feeds ?? '').split(',')
    )
      .map((f) => String(f).trim())
      .filter((f) => /^https?:\/\//.test(f))
      .slice(0, 20);
    const items = [];
    const failed = [];
    for (const url of feeds) {
      if (Date.now() > deadline) break;
      try {
        const xml = await http.text(url, {
          headers: { accept: 'application/rss+xml, application/xml, */*' },
          timeoutMs: 20_000,
        });
        items.push(...parseFeed(xml, url));
      } catch (err) {
        failed.push(`${url} (${err.message.slice(0, 40)})`);
      }
    }
    const deals = items.filter((i) => i.kind === 'deal').length;
    log(
      `${items.length} posts, ${deals} deals${failed.length ? `, failed: ${failed.join(', ')}` : ''}`,
    );
    return {
      items,
      note: `${items.length} posts, ${deals} deals from ${feeds.length - failed.length} feeds`,
    };
  },
});
