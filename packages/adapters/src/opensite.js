import { defineAdapter } from '@nichedb/core/adapter';
import { AGENT, KINDS, readSitemap, readUrl, recordItem, webUrl } from '@nichedb/core/opensite';

/**
 * Pages, read as OpenSite records (https://logicsrc.com/opensite).
 *
 * A source names a few addresses and, if it likes, a sitemap or two. Each
 * run reads the addresses, then walks the sitemaps from where the last run
 * stopped, up to `pages` per run, and writes one record per page keyed by
 * its canonical address. The reading itself is core's; this only decides
 * what to read and when to stop.
 *
 * The house sites are seeded as sources, one each, front page plus sitemap,
 * so the index holds a card for every page we publish before anyone pastes
 * one. `sites-pasted` is the source the /c/sites/add page writes into and
 * has nothing of its own to pull.
 */

/** Per run: enough to walk a small site in one go and a big one in a day. */
const DEFAULT_PAGES = 100;

const list = (v) =>
  (Array.isArray(v) ? v : String(v ?? '').split(/[\s,]+/)).map((s) => webUrl(s)).filter(Boolean);

const HOUSE = [
  [
    'nixamp',
    'https://nixamp.com',
    'nixamp.com: the streaming platform you run yourself, and every share link on it',
  ],
  [
    'p0dcasters',
    'https://p0dcasters.com',
    'p0dcasters.com: the independent podcast directory, a page per show',
  ],
  ['bl0ggers', 'https://bl0ggers.com', 'bl0ggers.com: publications and their posts'],
  [
    'crawlproof',
    'https://crawlproof.com',
    'crawlproof.com: the crawler gateway and its ad network',
  ],
  ['logicsrc', 'https://logicsrc.com', 'logicsrc.com: every spec and its landing page'],
  ['rssamplifier', 'https://rssamplifier.com', 'rssamplifier.com: the small-web feed directory'],
  ['saasrow', 'https://saasrow.com', 'saasrow.com: the SaaS directory'],
  [
    'outreachgraph',
    'https://outreachgraph.com',
    'outreachgraph.com: the public profiles and company pages',
  ],
  ['tsbb', 'https://tsbb.dev', 'tsbb.dev: the bulletin boards'],
  ['agenticjobs', 'https://agenticjobs.work', 'agenticjobs.work: the job board'],
  ['d0rz', 'https://d0rz.com', 'd0rz.com: the marketplace'],
  ['aiornot', 'https://aiornot.vote', 'aiornot.vote: real or generated, judged by people'],
];

export const opensite = defineAdapter({
  name: 'opensite',
  title: 'OpenSite pages',
  collection: 'sites',
  description:
    'Pages and sites as OpenSite records (logicsrc.com/opensite): for each address a source names, and each page its sitemaps list, the card a careful reader would draw from it: title, description, picture, kind, canonical address, author, feeds, and the og:, twitter: and JSON-LD tags verbatim. Reads with a named user agent, honours robots.txt and a site’s own /.well-known/opensite.json, and keys every record by its canonical address so a re-read updates the row. Keyless.',
  docs: 'https://logicsrc.com/docs/opensite',
  kinds: KINDS,
  cadenceMinutes: 360,
  configFields: [
    {
      key: 'urls',
      label: 'Addresses',
      type: 'list',
      help: 'Pages to read every run, one per line.',
      placeholder: 'https://example.com/',
    },
    {
      key: 'sitemaps',
      label: 'Sitemaps',
      type: 'list',
      help: 'Sitemaps (or sitemap indexes) whose pages are walked, a few hundred per run, carrying on where the last run stopped.',
      placeholder: 'https://example.com/sitemap.xml',
    },
    {
      key: 'pages',
      label: 'Pages per run',
      type: 'number',
      help: `Sitemap pages read per run, after the addresses. Default ${DEFAULT_PAGES}.`,
      placeholder: String(DEFAULT_PAGES),
    },
  ],
  defaults: { urls: [], sitemaps: [], pages: DEFAULT_PAGES },
  defaultSources: [
    {
      slug: 'sites-pasted',
      name: 'Pasted at /c/sites/add',
      description:
        'Every address somebody pasted into the index by hand or through the API. Nothing to pull: the page writes here as it reads.',
      config: { urls: [], sitemaps: [], pages: 0 },
      enabled: false,
    },
    ...HOUSE.map(([slug, origin, description]) => ({
      slug: `${slug}-pages`,
      name: `${origin.replace('https://', '')}: its pages`,
      description,
      config: { urls: [`${origin}/`], sitemaps: [`${origin}/sitemap.xml`], pages: DEFAULT_PAGES },
      enabled: true,
    })),
  ],
  async pull({ config, cursor, http, log, deadline }) {
    const urls = list(config.urls);
    const sitemaps = list(config.sitemaps);
    const perRun = Math.max(0, Math.min(Number(config.pages) || 0, 2000));
    const cache = new Map();
    const items = [];
    const read = async (url) => {
      const record = await readUrl(url, { http, cache });
      const item = record ? recordItem(record) : null;
      if (item) items.push(item);
      return record;
    };
    for (const url of urls) {
      if (Date.now() > deadline) break;
      await read(url);
    }
    // The sitemap walk: every page address the sitemaps name, in order,
    // from where the last run stopped, wrapping to the start at the end.
    let walked = 0;
    let offset = Number(cursor?.offset) || 0;
    if (perRun > 0 && sitemaps.length > 0) {
      const all = [];
      for (const s of sitemaps) {
        const { urls: pages, sitemaps: nested } = await readSitemap(s, { http });
        all.push(...pages);
        for (const n of nested.slice(0, 10)) {
          if (Date.now() > deadline) break;
          all.push(...(await readSitemap(n, { http })).urls);
        }
      }
      const pages = [...new Set(all)].filter((u) => !urls.includes(u));
      if (offset >= pages.length) offset = 0;
      const slice = pages.slice(offset, offset + perRun);
      for (const url of slice) {
        if (Date.now() > deadline) break;
        await read(url);
        walked += 1;
      }
      offset = offset + walked >= pages.length ? 0 : offset + walked;
      log(`${pages.length} in sitemaps, read ${walked}, next from ${offset}`);
    }
    const blocked = items.filter((i) => i.data.record.status === 'blocked').length;
    const gone = items.filter((i) => i.data.record.status === 'gone').length;
    return {
      items,
      cursor: { offset },
      note: `${items.length} pages${blocked ? `, ${blocked} blocked` : ''}${gone ? `, ${gone} gone` : ''}`,
    };
  },
});

export { AGENT };
