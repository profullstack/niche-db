import { decodeEntities, defineAdapter } from '@nichedb/core/adapter';

/**
 * The small web, from brisk.news.
 *
 * Everything else in this collection is a newsroom. brisk polls ~33,000
 * independent feeds -- the Kagi small-web catalogue plus a curated set -- and
 * that corpus is the one thing news coverage systematically misses: one writer,
 * no masthead, publishing when they have something to say. A story about a
 * database engine reaches the wire once it becomes an outage and reaches these
 * feeds a year earlier.
 *
 * `/api/news` is keyless and merges three corpora, labelling each row with
 * `source_type`:
 *
 * - `rss`    -- the small web. Taken.
 * - `api`    -- a mainstream wire. NOT taken: this collection already reads
 *               newsrooms directly and through a directory, and a third copy of
 *               a Reuters story is a third copy. The dedupe key would collapse
 *               most of it anyway, which is a reason not to fetch it rather than
 *               a reason to.
 * - `google` -- Google News stubs, whose URLs 302 back to news.google.com
 *               rather than to any publisher (checked live 2026-09-09). Every
 *               one would be a dead link.
 *
 * The small web is reachable only through the uncategorised firehose and through
 * `search=`; a `category=` query never returns one, which is why this adapter
 * walks pages rather than asking per desk.
 */

const BASE = 'https://brisk.news/api/news';

/**
 * brisk caps a response at 50 rows however large a `limit` is asked for, and the
 * merge dilutes the small web as the page grows: measured 2026-09-09, a
 * `limit=30` page came back roughly a third `rss` while `limit=100` (truncated
 * to 50) came back one seventh. Asking for less per page yields more of what
 * this adapter is here for.
 */
const PAGE = 30;

/** Pages of the firehose per run. Roughly a third of each is small web. */
const DEFAULT_PAGES = 12;

/**
 * URLs that are a feed rather than something to read.
 *
 * The corpus is built from feed documents and a few advertise their own comment
 * feed as an entry -- Blogger's `/feeds/<id>/comments/default` arrives carrying
 * a real post title attached to a raw XML endpoint, so a reader clicking the
 * headline gets a wall of markup.
 */
const FEED_URL = /\/comments\/|\/feeds?\/|\.(?:xml|rss|atom)(?:$|\?)/i;

/**
 * brisk renders a card image on demand at its own `/api/screenshot`. Carrying
 * that would point every image in this collection at another site's renderer.
 */
const SCREENSHOT = /^https?:\/\/[^/]*brisk\.news\/api\/screenshot/i;

/**
 * Decoded, whitespace-collapsed, and null when nothing is left.
 *
 * `decodeEntities` always returns a string because the XML parser needs it to.
 * A title that was only an entity decodes to nothing, and a story with no
 * headline is not a story, so the emptiness has to become null somewhere.
 */
const clean = (s) => {
  const t = decodeEntities(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t || null;
};

/**
 * The blog that published a post, from the delivery host.
 *
 * `www.` is stripped because the same blog arrives both ways and would otherwise
 * be two outlets. A value with a space or no dot in it is a feed title that
 * leaked into the column rather than a host.
 */
export function outletOf(row) {
  const raw = typeof row?.source === 'string' ? row.source.trim().toLowerCase() : '';
  if (!raw) return null;
  const host = raw.replace(/^www\./, '').replace(/\.$/, '');
  if (!host || /[\s/]/.test(host) || !host.includes('.')) return null;
  return host;
}

/** One row, or null if it is not a readable small-web post. */
export function toItem(row) {
  // The editorial line. See the note at the top of this file.
  if (row?.source_type !== 'rss') return null;

  const url = typeof row.url === 'string' ? row.url.trim() : '';
  if (!url || FEED_URL.test(url)) return null;

  const title = clean(row.title);
  if (!title) return null;

  const published = row.publishedAt ? new Date(row.publishedAt) : null;
  if (!published || Number.isNaN(published.getTime())) return null;

  const outlet = outletOf(row);
  if (!outlet) return null;

  const image = typeof row.imageUrl === 'string' ? row.imageUrl : '';

  return {
    externalId: `${outlet}:${url}`.slice(0, 500),
    kind: 'story',
    title,
    summary: clean(row.description ?? row.snippet)?.slice(0, 600) ?? null,
    // The publisher's own link, never brisk's `shortUrl` redirector: a shortener
    // hides who published a thing, which is the opposite of what this is for.
    url,
    imageUrl: image && !SCREENSHOT.test(image) ? image : null,
    publishedAt: published,
    /*
     * `independent` rather than one of the newsroom desks. These posts carry no
     * section upstream -- an rss row's `categories` is empty about as often as
     * not -- and filing them under `world` by default would bury the wire under
     * personal blogs. A desk of their own is also the honest description.
     */
    tags: ['news', 'independent', outlet],
    data: { section: 'independent', outlet, outletName: outlet },
  };
}

export const brisk = defineAdapter({
  name: 'brisk',
  title: 'brisk.news small web',
  collection: 'news',
  description:
    'Posts from the ~33,000 independent feeds brisk.news polls — the Kagi small-web catalogue and a curated set. Blogs rather than newsrooms, filed under their own "independent" desk. Keyless. The mainstream wire and the Google News stubs the same endpoint carries are deliberately not taken.',
  docs: 'https://brisk.news',
  kinds: ['story'],
  cadenceMinutes: 60,
  configFields: [
    {
      key: 'pages',
      label: 'Firehose pages per run',
      type: 'number',
      required: false,
      help: 'Thirty rows a page, of which roughly a third are small web. The rest of each page is a wire this collection already reads elsewhere.',
    },
  ],
  defaults: { pages: DEFAULT_PAGES },
  defaultSources: [
    {
      slug: 'news-smallweb',
      name: 'News: the small web',
      config: { pages: DEFAULT_PAGES },
    },
  ],
  async pull({ config, http, log, deadline }) {
    const pages = Math.min(Math.max(Number(config.pages) || DEFAULT_PAGES, 1), 40);
    const items = [];
    const seen = new Set();

    for (let page = 1; page <= pages; page++) {
      if (Date.now() > deadline) break;
      let rows;
      try {
        rows = await http.json(`${BASE}?limit=${PAGE}&page=${page}`, { timeoutMs: 20_000 });
      } catch (err) {
        log(`page ${page} failed (${err.message.slice(0, 60)})`);
        break;
      }
      const batch = rows?.articles ?? [];
      if (batch.length === 0) break;

      for (const row of batch) {
        const item = toItem(row);
        // Pages are assembled per request out of a merge, so the same post can
        // appear on two of them.
        if (item && !seen.has(item.url)) {
          seen.add(item.url);
          items.push(item);
        }
      }
      if (batch.length < PAGE) break;
    }

    log(`${items.length} small-web posts from ${pages} pages`);
    return { items };
  },
});
