import { defineAdapter, first, stripHtml, xmlItems } from '@nichedb/core/adapter';

/**
 * Newsroom feeds: the wire copy itself, read straight from the publisher's own
 * RSS/Atom. No key, no intermediary, no per-article quota — a newsroom feed is
 * the one thing in news that is reliably free, because publishers want it read.
 *
 * One source watches a list of feed URLs, the same shape as the statuspage
 * adapter watches a list of hosts. RSS, RSS 1.0/RDF and Atom all parse here:
 * the three differ in the item tag and where the link lives, and nothing else
 * this adapter reads.
 *
 * Every URL below was fetched and parsed on 2026-09-08 before being listed.
 * Reuters is deliberately absent: it retired its public RSS feeds, and the
 * remaining endpoints 404. CBC is absent for the same reason — it did not
 * answer at all from here.
 */
export const DEFAULT_FEEDS = [
  'https://feeds.bbci.co.uk/news/world/rss.xml',
  'https://www.aljazeera.com/xml/rss/all.xml',
  'https://www.theguardian.com/world/rss',
  'https://rss.dw.com/rdf/rss-en-all',
  'https://www.france24.com/en/rss',
  'https://feeds.npr.org/1001/rss.xml',
  'https://feeds.a.dj.com/rss/RSSWorldNews.xml',
];

/**
 * A stable outlet slug from the feed URL's host. Feed hosts are noisy —
 * `feeds.bbci.co.uk`, `rss.dw.com`, `feeds.a.dj.com` — so strip the delivery
 * prefixes and the public suffix and keep the name a reader would recognise.
 */
export function outletOf(feedUrl) {
  let host;
  try {
    host = new URL(feedUrl).hostname.toLowerCase();
  } catch {
    return 'unknown';
  }
  const parts = host
    .replace(/^(www|feeds?|rss|news)\./, '')
    .split('.')
    .filter((p) => !['com', 'org', 'net', 'co', 'uk', 'de', 'fr', 'us', 'io'].includes(p));
  // feeds.a.dj.com leaves ["a","dj"]; the last remaining label is the outlet.
  return parts[parts.length - 1] ?? host;
}

/** The first URL among the usual image carriers, or null. */
function imageOf(it) {
  const enclosure = first(it.enclosure);
  if (enclosure?.attrs?.url && /image/i.test(enclosure.attrs.type ?? 'image'))
    return enclosure.attrs.url;
  return first(it['media:content'])?.attrs?.url ?? first(it['media:thumbnail'])?.attrs?.url ?? null;
}

/** RSS puts the link in the element text; Atom puts it in a self-closing href. */
function linkOf(it) {
  const link = it.link;
  if (Array.isArray(link)) {
    const alt = link.find((l) => (l.attrs?.rel ?? 'alternate') === 'alternate');
    return alt?.attrs?.href ?? alt?.text ?? link[0]?.text ?? null;
  }
  return link?.text || link?.attrs?.href || null;
}

export function toItem(feedUrl, it) {
  const outlet = outletOf(feedUrl);
  const url = linkOf(it);
  const externalId = first(it.guid)?.text || first(it.id)?.text || url;
  if (!externalId) return null;
  const title = first(it.title)?.text;
  if (!title) return null;

  const body =
    first(it.description)?.text ??
    first(it.summary)?.text ??
    first(it['content:encoded'])?.text ??
    first(it.content)?.text ??
    '';

  const categories = (Array.isArray(it.category) ? it.category : it.category ? [it.category] : [])
    .map((c) => c.text || c.attrs?.term)
    .filter(Boolean)
    .slice(0, 6);

  return {
    externalId: `${outlet}:${externalId}`,
    kind: 'story',
    title,
    summary: stripHtml(body).slice(0, 600) || null,
    url,
    imageUrl: imageOf(it),
    publishedAt:
      first(it.pubDate)?.text ??
      first(it['dc:date'])?.text ??
      first(it.published)?.text ??
      first(it.updated)?.text ??
      null,
    tags: ['news', outlet, ...categories].filter(Boolean),
    data: {
      outlet,
      feed: feedUrl,
      author: first(it['dc:creator'])?.text ?? first(it.author)?.text ?? null,
      categories,
    },
  };
}

export function parseFeed(xml, feedUrl) {
  // RSS and RDF use <item>; Atom uses <entry>. A document is one or the other,
  // so reading both costs nothing and saves sniffing the root element.
  const rows = [...xmlItems(xml, 'item'), ...xmlItems(xml, 'entry')];
  const out = [];
  for (const it of rows) {
    const item = toItem(feedUrl, it);
    if (item) out.push(item);
  }
  return out;
}

export const newsfeed = defineAdapter({
  name: 'newsfeed',
  title: 'Newsroom feeds',
  collection: 'news',
  description:
    'Stories straight from a publisher’s own RSS or Atom feed — BBC, Al Jazeera, the Guardian, DW, France 24, NPR and the WSJ world wire by default. Keyless, and any feed URL can be added. RSS, RDF and Atom all parse.',
  docs: 'https://www.rssboard.org/rss-specification',
  kinds: ['story'],
  cadenceMinutes: 15,
  configFields: [
    {
      key: 'feeds',
      label: 'Feed URLs',
      type: 'list',
      required: true,
      placeholder: DEFAULT_FEEDS.slice(0, 2).join(', '),
      help: 'Full URLs to RSS, RDF or Atom feeds. One source can watch many.',
    },
  ],
  defaults: { feeds: DEFAULT_FEEDS },
  defaultSources: [
    {
      slug: 'news-world',
      name: 'News: world desks',
      config: { feeds: DEFAULT_FEEDS },
    },
  ],
  async pull({ config, http, log, deadline }) {
    const feeds = (
      Array.isArray(config.feeds) ? config.feeds : String(config.feeds ?? '').split(',')
    )
      .map((f) => String(f).trim())
      .filter((f) => /^https?:\/\//.test(f))
      .slice(0, 40);

    const items = [];
    const failed = [];
    for (const feed of feeds) {
      if (Date.now() > deadline) break;
      try {
        const xml = await http.text(feed, {
          headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, */*' },
          timeoutMs: 15_000,
        });
        items.push(...parseFeed(xml, feed));
      } catch (err) {
        failed.push(`${outletOf(feed)} (${err.message.slice(0, 40)})`);
      }
    }
    log(
      `${feeds.length} feeds, ${items.length} stories${failed.length ? `, failed: ${failed.join(', ')}` : ''}`,
    );
    return {
      items,
      note: `${items.length} stories from ${feeds.length - failed.length} feeds${failed.length ? `; ${failed.length} failed` : ''}`,
    };
  },
});
