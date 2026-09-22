import { defineAdapter, looseDate, slugify } from '@nichedb/core/adapter';

/**
 * OpenAlex: scholarly works, newest first, for the `research` collection.
 *
 * api.openalex.org/works is keyless and its data is CC0. The "polite pool"
 * (faster, more reliable) is joined by putting a contact address in `mailto=`
 * on every query and a descriptive User-Agent, which this does. A filter
 * expression is `key:value` clauses joined by commas; a value with spaces is
 * fine once URL-encoded, which URLSearchParams does exactly once.
 *
 * Traps this is shaped around:
 *
 * - `sort=publication_date:desc` on its own puts works dated in the FUTURE
 *   first (on 2026-09-22 the top row was a Zenodo record dated 2050-02-21), so
 *   every query carries `to_publication_date:<today, UTC>` (the API rejects a `<=` on publication_date). That is the whole
 *   reason `buildQuery` takes the date as an argument.
 * - `from_created_date` would be the honest "what is new" filter, but it is
 *   answered only with a premium key, so publication date is what there is.
 * - Abstracts come as an inverted index ({word: [positions]}) rather than
 *   text, and are put back in order here.
 * - A page can carry the same work twice; items are deduped by id.
 * - `per-page` tops out at 200; 100 is used and up to PAGES_PER_RUN pages are
 *   read with `page=`, stopping early on a short page.
 */

export const API = 'https://api.openalex.org/works';
export const USER_AGENT = 'nichedb openalex (https://nichedb.dev; hello@nichedb.dev)';
export const MAILTO = 'hello@nichedb.dev';

/** Rows per page; the API allows up to 200. */
export const PER_PAGE = 100;

/** Pages read per run. Three is a few hundred works, enough for a three-hour cadence. */
export const PAGES_PER_RUN = 3;

/** The fields asked for; anything else the API would send is not stored. */
export const SELECT = [
  'id',
  'doi',
  'title',
  'publication_date',
  'primary_topic',
  'open_access',
  'authorships',
  'keywords',
  'cited_by_count',
  'type',
  'abstract_inverted_index',
  'best_oa_location',
].join(',');

const text = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
};

/** Today as YYYY-MM-DD in UTC, the ceiling a query carries. */
export const todayUtc = (now = new Date()) => now.toISOString().slice(0, 10);

/** The clauses of a comma-separated filter expression, blanks dropped. */
export const filterClauses = (s) =>
  String(s ?? '')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);

/**
 * The filter expression for a source's config on a given day: the source's
 * own clauses, then the search term, then open access, then the date ceiling.
 */
export function buildFilter(config, today) {
  const search = text(config?.search);
  const oa = String(config?.openAccessOnly ?? 'no').toLowerCase() === 'yes';
  return [
    ...filterClauses(config?.filter),
    search ? `title_and_abstract.search:${search}` : null,
    oa ? 'open_access.is_oa:true' : null,
    `to_publication_date:${today}`,
  ]
    .filter(Boolean)
    .join(',');
}

/** The URL for one page of a source's query. */
export function buildQuery(config, today = todayUtc(), page = 1) {
  const params = new URLSearchParams({
    filter: buildFilter(config, today),
    sort: 'publication_date:desc',
    'per-page': String(PER_PAGE),
    page: String(page),
    select: SELECT,
    mailto: MAILTO,
  });
  return `${API}?${params}`;
}

/** An inverted index ({word: [positions]}) back to the text it came from. */
export function rebuildAbstract(index) {
  if (!index || typeof index !== 'object') return null;
  const words = [];
  for (const [word, positions] of Object.entries(index)) {
    if (!Array.isArray(positions)) continue;
    for (const p of positions) {
      const n = Number(p);
      if (Number.isInteger(n) && n >= 0) words[n] = word;
    }
  }
  const out = words
    .filter((w) => w !== undefined)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return out || null;
}

/** The short id (W…) from an OpenAlex entity URL, or the string as it came. */
export const shortId = (uri) => {
  const s = text(uri);
  if (!s) return null;
  const m = s.match(/\/([A-Z]\d+)$/);
  return m ? m[1] : s;
};

/** One work to an item, or null for a work with no id or title. */
export function workItem(w) {
  const id = shortId(w?.id);
  const title = text(w?.title);
  if (!id || !title) return null;
  const topic = w.primary_topic ?? null;
  const topicName = text(topic?.display_name);
  const subfieldName = text(topic?.subfield?.display_name);
  const fieldName = text(topic?.field?.display_name);
  const oa = w.open_access ?? {};
  const oaStatus = oa.is_oa ? text(oa.oa_status) : null;
  const type = text(w.type);
  const doi = text(w.doi);
  const abstract = rebuildAbstract(w.abstract_inverted_index);
  const authors = (Array.isArray(w.authorships) ? w.authorships : [])
    .map((a) => text(a?.author?.display_name) ?? text(a?.raw_author_name))
    .filter(Boolean)
    .slice(0, 12);
  const keywords = (Array.isArray(w.keywords) ? w.keywords : [])
    .map((k) => text(k?.display_name))
    .filter(Boolean)
    .slice(0, 10);
  return {
    externalId: id,
    kind: 'paper',
    title: title.replace(/\s+/g, ' ').trim(),
    summary: abstract ? abstract.slice(0, 1200) : null,
    url: doi ?? `https://openalex.org/${id}`,
    ...looseDate(w.publication_date),
    tags: [
      'openalex',
      topicName ? slugify(topicName) : null,
      subfieldName ? slugify(subfieldName) : null,
      oaStatus ? `oa:${oaStatus}` : null,
      type,
    ].filter(Boolean),
    data: {
      id,
      doi,
      type,
      topic: topicName,
      subfield: subfieldName,
      field: fieldName,
      oaStatus,
      oaUrl: text(w.best_oa_location?.pdf_url) ?? text(oa.oa_url),
      authors,
      keywords,
      citedBy: Number.isFinite(Number(w.cited_by_count)) ? Number(w.cited_by_count) : 0,
    },
  };
}

export const openalex = defineAdapter({
  name: 'openalex',
  title: 'OpenAlex',
  collection: 'research',
  description:
    'Scholarly works from OpenAlex, newest first, with the abstract, topic, authors, open-access status and citation count. Keyless, CC0. Narrow it with a search term and any OpenAlex filter clauses.',
  docs: 'https://docs.openalex.org/api-entities/works',
  kinds: ['paper'],
  cadenceMinutes: 180,
  configFields: [
    {
      key: 'search',
      label: 'Search',
      placeholder: 'algorithm',
      help: 'Optional: only works whose title or abstract mention this.',
    },
    {
      key: 'filter',
      label: 'Filter',
      placeholder: 'primary_topic.field.id:17',
      help: 'Optional OpenAlex filter clauses, comma separated. The date ceiling is always added.',
    },
    {
      key: 'openAccessOnly',
      label: 'Open access only',
      type: 'select',
      options: ['no', 'yes'],
    },
  ],
  defaults: { openAccessOnly: 'no' },
  defaultSources: [
    {
      slug: 'openalex-algorithms',
      name: 'OpenAlex: algorithm papers',
      config: { search: 'algorithm', filter: 'primary_topic.field.id:17' },
    },
  ],
  async pull({ config, http, log }) {
    const today = todayUtc();
    const seen = new Set();
    const items = [];
    let pages = 0;
    for (let page = 1; page <= PAGES_PER_RUN; page++) {
      const body = await http.json(buildQuery(config, today, page), {
        headers: { 'user-agent': USER_AGENT },
        timeoutMs: 60_000,
      });
      const results = Array.isArray(body?.results) ? body.results : [];
      pages++;
      for (const w of results) {
        const item = workItem(w);
        if (!item || seen.has(item.externalId)) continue;
        seen.add(item.externalId);
        items.push(item);
      }
      if (results.length < PER_PAGE) break;
    }
    log(`${items.length} works over ${pages} page${pages === 1 ? '' : 's'}`);
    return { items, note: `${items.length} works` };
  },
});
