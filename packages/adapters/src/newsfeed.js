import { defineAdapter, first, stripHtml, xmlItems } from '@nichedb/core/adapter';

/**
 * Newsroom feeds: the wire copy itself, read straight from the publisher's own
 * RSS/Atom. No key, no intermediary, no per-article quota — a newsroom feed is
 * the one thing in news that is reliably free, because publishers want it read.
 *
 * One source watches a list of feeds, the same shape as the statuspage adapter
 * watches a list of hosts. RSS, RSS 1.0/RDF and Atom all parse here: the three
 * differ in the item tag and where the link lives, and nothing else this
 * adapter reads.
 *
 * **Each feed carries its section**, written `section=url`. A publisher already
 * sorts its own copy into desks and publishes one feed per desk, so the section
 * is a fact we are given rather than a guess — which is the whole reason not to
 * classify story text. A bare URL with no `section=` prefix is filed under
 * `world`, which is what the original seven feeds were.
 *
 * Every URL below was fetched and its own <title> checked before being listed,
 * on 2026-09-08. Reuters is deliberately absent: it retired its public RSS
 * feeds. CBC is absent because it did not answer at all. The Guardian's section
 * feeds are listed at their post-redirect `/us/` addresses, because the bare
 * ones 302 and following a hop on every pull is waste.
 */
export const DEFAULT_FEEDS = [
  'world=https://feeds.bbci.co.uk/news/world/rss.xml',
  'world=https://www.aljazeera.com/xml/rss/all.xml',
  'world=https://www.theguardian.com/world/rss',
  'world=https://rss.dw.com/rdf/rss-en-all',
  'world=https://www.france24.com/en/rss',
  'world=https://feeds.npr.org/1001/rss.xml',
  'world=https://feeds.a.dj.com/rss/RSSWorldNews.xml',

  'us=https://feeds.bbci.co.uk/news/world/us_and_canada/rss.xml',
  'us=https://www.theguardian.com/us-news/rss',

  'politics=https://feeds.bbci.co.uk/news/politics/rss.xml',
  'politics=https://www.theguardian.com/politics/rss',
  'politics=https://feeds.npr.org/1014/rss.xml',

  'business=https://feeds.bbci.co.uk/news/business/rss.xml',
  'business=https://www.theguardian.com/us/business/rss',
  'business=https://feeds.npr.org/1006/rss.xml',

  'technology=https://feeds.bbci.co.uk/news/technology/rss.xml',
  'technology=https://www.theguardian.com/us/technology/rss',
  'technology=https://feeds.npr.org/1019/rss.xml',

  'science=https://feeds.bbci.co.uk/news/science_and_environment/rss.xml',
  'science=https://feeds.npr.org/1007/rss.xml',

  'health=https://feeds.bbci.co.uk/news/health/rss.xml',
  'health=https://feeds.npr.org/1128/rss.xml',

  'sport=https://feeds.bbci.co.uk/sport/rss.xml',
  'sport=https://www.theguardian.com/us/sport/rss',

  'climate=https://www.theguardian.com/us/environment/rss',
];

/** The sections the shipped feeds cover, in the order a reader should meet them. */
export const SECTIONS = [
  'world',
  'us',
  'politics',
  'business',
  'technology',
  'science',
  'health',
  'sport',
  'climate',
];

/**
 * Split a `section=url` entry.
 *
 * A bare URL keeps working and lands in `world`: that is what this adapter's
 * feeds all were before sections existed, so an existing stored config does not
 * silently change meaning on upgrade.
 */
export function splitFeedSpec(spec) {
  const s = String(spec ?? '').trim();
  const eq = s.indexOf('=');
  // http**s**:// contains no '=', but guard against a URL with a query string
  // being read as a section by requiring the left side to be a bare word.
  if (eq > 0) {
    const left = s.slice(0, eq);
    if (/^[a-z][a-z0-9-]{0,30}$/i.test(left)) {
      return { section: left.toLowerCase(), url: s.slice(eq + 1).trim() };
    }
  }
  return { section: 'world', url: s };
}

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

export function toItem(feedUrl, it, section = 'world') {
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
    // The section is NOT in the id. The same story reaching two desks is one
    // story, and putting the section in the key would store it twice: measured
    // live, 36 of 803 arrive on two desks, mostly a BBC world story that is also
    // US news. One row wins, and because DEFAULT_FEEDS lists `world` first and
    // the specific desks after it, the winner is the more specific section —
    // which is the right answer and is a property of that ORDER, not an
    // accident. Keep world at the top if you edit the list.
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
    tags: ['news', section, outlet, ...categories].filter(Boolean),
    data: {
      section,
      outlet,
      feed: feedUrl,
      author: first(it['dc:creator'])?.text ?? first(it.author)?.text ?? null,
      categories,
    },
  };
}

export function parseFeed(xml, feedUrl, section = 'world') {
  // RSS and RDF use <item>; Atom uses <entry>. A document is one or the other,
  // so reading both costs nothing and saves sniffing the root element.
  const rows = [...xmlItems(xml, 'item'), ...xmlItems(xml, 'entry')];
  const out = [];
  for (const it of rows) {
    const item = toItem(feedUrl, it, section);
    if (item) out.push(item);
  }
  return out;
}

export const newsfeed = defineAdapter({
  name: 'newsfeed',
  title: 'Newsroom feeds',
  collection: 'news',
  description:
    'Stories straight from a publisher’s own RSS or Atom feed, filed under the desk that published them: world, US, politics, business, technology, science, health, sport and climate. BBC, Al Jazeera, the Guardian, DW, France 24, NPR and the WSJ by default. Keyless. Write a feed as section=url; a bare URL is filed under world.',
  docs: 'https://www.rssboard.org/rss-specification',
  kinds: ['story'],
  cadenceMinutes: 15,
  configFields: [
    {
      key: 'feeds',
      label: 'Feeds',
      type: 'list',
      required: true,
      placeholder: DEFAULT_FEEDS.slice(0, 2).join(', '),
      help: 'Written section=url, e.g. politics=https://example.com/politics/rss. RSS, RDF and Atom all parse. A bare URL is filed under world.',
    },
  ],
  defaults: { feeds: DEFAULT_FEEDS },
  defaultSources: [
    {
      slug: 'news-world',
      name: 'News: newsroom desks',
      config: { feeds: DEFAULT_FEEDS },
    },
  ],
  async pull({ config, http, log, deadline }) {
    const specs = (
      Array.isArray(config.feeds) ? config.feeds : String(config.feeds ?? '').split(',')
    )
      .map((f) => splitFeedSpec(f))
      .filter((f) => /^https?:\/\//.test(f.url))
      .slice(0, 60);

    const items = [];
    const failed = [];
    const sections = new Set();
    for (const { section, url } of specs) {
      if (Date.now() > deadline) break;
      try {
        const xml = await http.text(url, {
          headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, */*' },
          timeoutMs: 15_000,
        });
        items.push(...parseFeed(xml, url, section));
        sections.add(section);
      } catch (err) {
        failed.push(`${section}/${outletOf(url)} (${err.message.slice(0, 40)})`);
      }
    }
    log(
      `${specs.length} feeds, ${sections.size} sections, ${items.length} stories${failed.length ? `, failed: ${failed.join(', ')}` : ''}`,
    );
    return {
      items,
      note: `${items.length} stories from ${specs.length - failed.length} feeds across ${sections.size} sections${failed.length ? `; ${failed.length} failed` : ''}`,
    };
  },
});
