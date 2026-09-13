import { defineAdapter, looseDate } from '@nichedb/core/adapter';

/**
 * The OutreachGraph public directory: what its crawler learned from pages
 * that were already public, about things that are public by nature.
 *
 * outreachgraph.com is the house prospecting product. Nearly everything it
 * knows arrived from the open web, but not everything it knows is public
 * data: a company's home page is, the campaign a workspace runs against it is
 * not; a person's own OpenProfile.md is, the bio a stranger pasted in and the
 * address the enrichment sweep guessed are not. That line is drawn once, on
 * the OutreachGraph side, in `GET /api/v1/public/directory`, keyless: a
 * company or site by its domain, and a person only when they publish their
 * own profile (an OpenProfile.md they serve themselves, or a profile and a
 * home page that vouch for each other with rel=me). Never an email, a phone,
 * a location, a score, a signal, a campaign or a workspace. This adapter
 * takes that page as given and adds nothing to it.
 *
 * PAGING
 *
 * Keyset by `(updated, id)` ascending behind an opaque `cursor`, so a walk
 * from the start meets every row once and a walk with `since` meets what
 * changed. Each run walks from the start, bounded by pages and the deadline;
 * an unchanged row is a content-hash no-op downstream, so the walk is cheap.
 *
 * IDS
 *
 * `outreachgraph:<kind>:<id>` -- the directory's own id, so a re-read updates
 * the row in place, and a company that the crawler later names (site becomes
 * company) keeps its row and changes its kind.
 */

export const DEFAULT_BASE = 'https://outreachgraph.com';
export const PATH = '/api/v1/public/directory';
export const KINDS = ['company', 'site', 'person'];

/** The documented ceiling per page. */
const PAGE = 200;

/** Pages per run: 50 x 200 is ten thousand rows, more than the directory holds today. */
const DEFAULT_PAGES = 50;

const clean = (s) => {
  const t = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t || null;
};

const strings = (v) =>
  (Array.isArray(v) ? v : [])
    .map((s) => clean(s)?.toLowerCase())
    .filter(Boolean)
    .slice(0, 40);

function when(s) {
  if (!s) return { publishedAt: null, timeKnown: false, precision: 'day' };
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return { publishedAt: d, timeKnown: true, precision: 'minute' };
  return looseDate(String(s).slice(0, 10));
}

/** The page URL for a cursor, or the first page. */
export function pageUrl(base, cursor) {
  const origin = String(base ?? DEFAULT_BASE)
    .trim()
    .replace(/\/+$/, '');
  const u = new URL(`${origin}${PATH}`);
  u.searchParams.set('limit', String(PAGE));
  if (cursor) u.searchParams.set('cursor', cursor);
  return u.href;
}

/** What the directory says about itself, in one line, when it says nothing. */
export function describeRow(row) {
  if (row.description) return row.description;
  const host = (() => {
    try {
      return new URL(row.url).hostname.replace(/^www\./, '');
    } catch {
      return null;
    }
  })();
  if (row.kind === 'person') {
    return row.openprofile
      ? `${row.name} publishes an OpenProfile.md.`
      : `${row.name}, whose profile and home page vouch for each other.`;
  }
  if (row.kind === 'site')
    return host ? `A site the crawler read at ${host}.` : 'A site the crawler read.';
  return host ? `${row.name}, at ${host}.` : `${row.name}.`;
}

/**
 * One directory row to one item. `id`, `kind` and `name` are required; the
 * rest is kept as given under `data.row`, and a tag is written only for a
 * value the directory stated. `openprofile` is both a tag, so a feed can cut
 * to the self-published, and a field, so a reader can fetch the file.
 */
export function directoryItem(row, base = DEFAULT_BASE) {
  if (!row?.id || !row?.name) return null;
  const kind = KINDS.includes(row.kind) ? row.kind : null;
  if (!kind) return null;
  const topics = strings(row.topics);
  const country = clean(row.country)?.toLowerCase() ?? null;
  const openprofile = clean(row.openprofile);
  return {
    externalId: `outreachgraph:${kind}:${row.id}`,
    kind,
    title: clean(row.name),
    summary: describeRow({ ...row, kind }),
    url: clean(row.url) ?? openprofile ?? null,
    ...when(row.updated),
    tags: [
      `kind:${kind}`,
      country ? `country:${country}` : null,
      openprofile ? 'openprofile' : null,
      ...topics.map((t) => `topic:${t}`),
    ].filter(Boolean),
    data: {
      row,
      openprofile,
      directory: pageUrl(base),
      attribution: 'OutreachGraph (outreachgraph.com), from its public directory',
    },
  };
}

export const outreachgraph = defineAdapter({
  name: 'outreachgraph',
  title: 'OutreachGraph public directory',
  collection: 'directory',
  description:
    'Companies, sites and self-published people the OutreachGraph crawler has read from the open web, from the keyless public directory outreachgraph.com serves: a company or site by its domain with its industry and stack as topics, and a person only when they publish their own OpenProfile.md or a profile and a home page vouch for each other. The directory withholds every email, phone, address, score, signal, campaign and workspace; this adapter adds nothing to it. Keyless.',
  docs: 'https://github.com/profullstack/outreachgraph#public-directory',
  kinds: KINDS,
  cadenceMinutes: 60,
  configFields: [
    {
      key: 'base',
      label: 'OutreachGraph origin',
      type: 'text',
      help: 'The origin that serves /api/v1/public/directory.',
      placeholder: DEFAULT_BASE,
    },
    {
      key: 'pages',
      label: 'Pages per run',
      type: 'number',
      help: `Up to this many pages of ${PAGE} rows per run.`,
      placeholder: String(DEFAULT_PAGES),
    },
  ],
  defaults: { base: DEFAULT_BASE, pages: DEFAULT_PAGES },
  defaultSources: [
    {
      slug: 'outreachgraph-directory',
      name: 'OutreachGraph: the public half of the crawl',
      description:
        'Companies and sites by their domain, and people who publish their own profile, as outreachgraph.com lists them in its keyless public directory. Nothing private: no email, phone, address, score, signal, campaign or workspace ever leaves OutreachGraph, and a person known only from a scraped handle is not listed.',
      config: { base: DEFAULT_BASE, pages: DEFAULT_PAGES },
      enabled: true,
    },
  ],
  async pull({ config, http, log, deadline }) {
    const base = String(config.base ?? DEFAULT_BASE);
    const maxPages = Math.max(1, Math.min(Number(config.pages) || DEFAULT_PAGES, 200));
    const items = [];
    let cursor = null;
    let pages = 0;
    let skipped = 0;
    while (pages < maxPages && Date.now() < deadline) {
      let doc;
      try {
        doc = await http.json(pageUrl(base, cursor), { timeoutMs: 20_000 });
      } catch (err) {
        log(`page ${pages + 1} failed (${err.message.slice(0, 60)})`);
        break;
      }
      pages += 1;
      const rows = Array.isArray(doc?.items) ? doc.items : [];
      for (const row of rows) {
        const item = directoryItem(row, base);
        if (item) items.push(item);
        else skipped += 1;
      }
      const next = typeof doc?.next === 'string' && doc.next ? doc.next : null;
      if (!next || rows.length === 0) break;
      cursor = next;
    }
    const counts = KINDS.map((k) => `${items.filter((i) => i.kind === k).length} ${k}`).join(', ');
    log(`${pages} pages: ${counts}${skipped ? `, ${skipped} skipped` : ''}`);
    return { items, note: `${pages} pages, ${items.length} rows` };
  },
});
