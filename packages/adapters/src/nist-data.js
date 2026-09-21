import { defineAdapter, looseDate, slugify, stripHtml } from '@nichedb/core/adapter';

/**
 * NIST Science Data Portal: every dataset NIST publishes at data.nist.gov,
 * newest revision first, read from the portal's Resource Metadata Manager
 * (RMM) records API. About 1,450 datasets, each a NERDm record with a DOI,
 * a landing page, the NIST research themes it belongs to, keywords and
 * authors; a record's `modified` moves when a new version is released, and
 * the row here follows it in place.
 *
 * The API is keyless and pages by `page` (1-based) and `size`; `sort.desc`
 * orders by a field and `include` limits the fields returned, which is the
 * difference between a 30 KB page and a 3 MB one. `modified` arrives in two
 * shapes, `2026-09-14 00:00:00` and `2026-08-27`, so only the date is read
 * and stored at noon UTC like every other date-only value here.
 *
 * A run walks the newest pages until it meets a record older than the last
 * run's cursor (with two days of overlap, since a record's `modified` is a
 * date), or twenty pages, whichever first. The first run reads everything.
 */
export const API = 'https://data.nist.gov/rmm/records';
export const PORTAL = 'https://data.nist.gov/sdp/';
export const PAGE = 100;
export const MAX_PAGES = 20;
const OVERLAP_DAYS = 2;
const INCLUDE = [
  'ediid',
  'title',
  'description',
  'modified',
  'issued',
  'firstIssued',
  'landingPage',
  'doi',
  'version',
  'keyword',
  'theme',
  'authors',
  'license',
  'contactPoint',
  'status',
  'accessLevel',
];
export const ATTRIBUTION =
  'NIST Science Data Portal, data.nist.gov: public domain in the United States (NIST open data licence).';

export function recordsUrl(page) {
  const p = new URLSearchParams({
    size: String(PAGE),
    page: String(page),
    'sort.desc': 'modified',
    include: INCLUDE.join(','),
  });
  return `${API}?${p}`;
}

/** The date part of `modified` (or `issued` when a record has no `modified`), or null. */
export function modifiedOf(r) {
  const s = String(r?.modified ?? r?.issued ?? r?.firstIssued ?? '').slice(0, 10);
  return /^\d{4}-\d\d-\d\d$/.test(s) ? s : null;
}

/**
 * NIST themes are written `Family: Subject` ("Resilience: Community
 * resilience"). The family makes a tag a reader can follow; the full theme
 * is kept on the row.
 */
export function themesOf(r) {
  const all = (Array.isArray(r?.theme) ? r.theme : []).map((t) => String(t).trim()).filter(Boolean);
  const families = [...new Set(all.map((t) => slugify(t.split(':')[0])).filter(Boolean))];
  return { all, families };
}

function authorsOf(r) {
  return (Array.isArray(r?.authors) ? r.authors : [])
    .map((a) =>
      typeof a === 'string'
        ? a
        : (a?.fn ?? [a?.givenName, a?.middleName, a?.familyName].filter(Boolean).join(' ')),
    )
    .map((s) => String(s).trim())
    .filter(Boolean)
    .slice(0, 12);
}

export function toItem(r) {
  const ediid = r?.ediid;
  if (!ediid || !r?.title) return null;
  const id = String(ediid).replace(/^ark:\/\d+\//, '');
  const modified = modifiedOf(r);
  const { all: themes, families } = themesOf(r);
  const keywords = (Array.isArray(r.keyword) ? r.keyword : [])
    .map((k) => String(k).trim())
    .filter(Boolean)
    .slice(0, 12);
  const description = Array.isArray(r.description)
    ? r.description.join(' ')
    : String(r.description ?? '');
  return {
    externalId: String(ediid),
    kind: 'dataset',
    title: String(r.title).replace(/\s+/g, ' ').trim(),
    summary: stripHtml(description).replace(/\s+/g, ' ').trim().slice(0, 1200) || null,
    url: r.landingPage ?? `https://data.nist.gov/od/id/${id}`,
    ...(modified ? looseDate(modified) : { publishedAt: null }),
    tags: [
      'nist',
      'dataset',
      ...families.map((f) => `theme:${f}`),
      ...keywords.slice(0, 8).map((k) => slugify(k)),
    ].filter(Boolean),
    data: {
      ediid: String(ediid),
      id,
      doi: r.doi ?? null,
      version: r.version ?? null,
      modified: r.modified ?? null,
      issued: r.issued ?? r.firstIssued ?? null,
      themes,
      keywords,
      authors: authorsOf(r),
      license: r.license ?? null,
      contact: r.contactPoint?.fn ?? null,
      status: r.status ?? null,
      accessLevel: r.accessLevel ?? null,
      attribution: ATTRIBUTION,
    },
  };
}

/** The cursor date pushed back by the overlap, as yyyy-mm-dd, or null when there is no cursor. */
export function sinceOf(cursor) {
  if (!cursor?.since) return null;
  const d = new Date(`${String(cursor.since).slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() - OVERLAP_DAYS);
  return d.toISOString().slice(0, 10);
}

export const nistDatasets = defineAdapter({
  name: 'nist-datasets',
  title: 'NIST Science Data Portal',
  collection: 'research',
  description:
    'Every dataset NIST publishes at data.nist.gov, newest revision first: title, abstract, DOI, version, research themes, keywords and authors, from the portal’s records API. Keyless, public domain. A row follows its record in place when a new version is released.',
  docs: 'https://data.nist.gov/sdp/#/about',
  kinds: ['dataset'],
  cadenceMinutes: 360,
  defaultSources: [
    {
      slug: 'nist-datasets',
      name: 'NIST Science Data Portal: datasets by last revision',
      description:
        'The datasets NIST publishes at data.nist.gov, read every six hours by last modification: a new dataset or a new version of one appears with its DOI, themes, keywords and authors.',
    },
  ],
  async pull({ cursor, http, log, deadline }) {
    const since = sinceOf(cursor);
    const items = [];
    let newest = cursor?.since ?? null;
    let pages = 0;
    let stopped = null;
    let total = null;
    for (let page = 1; page <= MAX_PAGES; page++) {
      if (Date.now() > deadline) {
        stopped = 'deadline';
        break;
      }
      const doc = await http.json(recordsUrl(page), { timeoutMs: 60_000 });
      pages += 1;
      total = Number(doc?.ResultCount ?? total ?? 0);
      const rows = Array.isArray(doc?.ResultData) ? doc.ResultData : [];
      if (rows.length === 0) break;
      let older = false;
      for (const r of rows) {
        const mod = modifiedOf(r);
        if (since && mod && mod < since) {
          older = true;
          break;
        }
        const it = toItem(r);
        if (!it) continue;
        items.push(it);
        if (mod && (!newest || mod > newest)) newest = mod;
      }
      if (older || rows.length < PAGE) break;
    }
    log(
      `${items.length} datasets in ${pages} page${pages === 1 ? '' : 's'} of ${total ?? '?'}${since ? ` since ${since}` : ''}${stopped ? `; stopped: ${stopped}` : ''}`,
    );
    return {
      items,
      cursor: newest ? { since: newest } : (cursor ?? {}),
      note: `${items.length} datasets${since ? ` revised since ${since}` : ''} of ${total ?? '?'}${stopped ? ` (${stopped})` : ''}`,
    };
  },
});
