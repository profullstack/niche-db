import { decodeEntities, defineAdapter } from '@nichedb/core/adapter';

/**
 * Independent podcasts, from the p0dcasters.com directory.
 *
 * p0dcasters lists the shows published from the maker's own domain rather than
 * from a hosting platform, and publishes the whole directory as one OPML
 * document: an `<outline>` per show with the feed, the site and the title. That
 * is the same list a podcast app imports, so reading it here is reading the
 * directory exactly as its members do.
 *
 * One request a run. The document is ~4 MB for ~21,500 shows and carries no
 * dates, so a show is stored undated and an unchanged show costs no write.
 */

export const OPML_URL = 'https://p0dcasters.com/opml';
const DIRECTORY = 'https://p0dcasters.com';

/**
 * Decoded, whitespace-collapsed, and null when nothing is left.
 *
 * `decodeEntities` always returns a string because the XML parser needs it to.
 * A title that was only an entity decodes to nothing, and a show with no name
 * is not a show, so the emptiness has to become null somewhere.
 */
const clean = (s) => {
  const t = decodeEntities(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t || null;
};

/**
 * Every `<outline>` in an OPML document as its attribute map.
 *
 * The core's `xmlItems` wants an element with a body, and an OPML outline is
 * self-closing, so it is read here. Nested outlines would be read flat, which
 * is right: a folder carries no `xmlUrl` and is dropped by `toItem`.
 */
export function parseOpml(xml) {
  const out = [];
  const re = /<outline\s+([^>]*?)\/?>/g;
  let m = re.exec(String(xml ?? ''));
  while (m) {
    const attrs = {};
    for (const a of m[1].matchAll(/([\w:.-]+)="([^"]*)"/g)) attrs[a[1]] = decodeEntities(a[2]);
    out.push(attrs);
    m = re.exec(xml);
  }
  return out;
}

const HTTP = /^https?:\/\//i;

/** One outline, or null if it is a folder, unnamed or not a web feed. */
export function toItem(outline) {
  const feedUrl = clean(outline?.xmlUrl);
  if (!feedUrl || !HTTP.test(feedUrl)) return null;

  const title = clean(outline.title) ?? clean(outline.text);
  if (!title) return null;

  const html = clean(outline.htmlUrl);
  const siteUrl = html && HTTP.test(html) ? html : null;

  let host = null;
  try {
    host = new URL(feedUrl).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    host = null;
  }

  return {
    // The feed URL is the identity: it is what the directory lists and what a
    // player subscribes to, and a show that moves its feed is a new listing.
    externalId: feedUrl.slice(0, 500),
    kind: 'show',
    title,
    summary: null,
    // The show's own site, and the feed itself for the ~1% of outlines that
    // carry none: a reader still lands on the show rather than nowhere.
    url: siteUrl ?? feedUrl,
    imageUrl: null,
    publishedAt: null,
    // The same shape the podcasts adapter writes for its self-hosted half, so
    // one feed query reads both directories.
    tags: ['podcast', 'self-hosted', 'p0dcasters'],
    data: { feedUrl, siteUrl, host, directory: DIRECTORY },
  };
}

export const p0dcasters = defineAdapter({
  name: 'p0dcasters',
  title: 'p0dcasters directory',
  collection: 'podcasts',
  description:
    'Every show in the p0dcasters.com directory of independent, self-hosted podcasts, read from the OPML the directory publishes: feed URL, site and title for ~21,500 shows in one request. Keyless.',
  docs: 'https://p0dcasters.com',
  kinds: ['show'],
  cadenceMinutes: 24 * 60,
  configFields: [],
  defaults: {},
  defaultSources: [
    {
      slug: 'p0dcasters-shows',
      name: 'Podcasts: the p0dcasters directory',
      config: {},
    },
  ],
  async pull({ http, log }) {
    const xml = await http.text(OPML_URL, {
      headers: { accept: 'text/x-opml, application/xml, text/xml, */*' },
      timeoutMs: 90_000,
    });
    const outlines = parseOpml(xml);
    const items = [];
    const seen = new Set();
    for (const o of outlines) {
      const item = toItem(o);
      // A directory can list one feed twice under two titles; one row wins.
      if (item && !seen.has(item.externalId)) {
        seen.add(item.externalId);
        items.push(item);
      }
    }
    log(`${items.length} shows from ${outlines.length} outlines`);
    return { items, note: `${items.length} shows` };
  },
});
