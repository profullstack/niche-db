import { defineAdapter, looseDate, slugify } from '@nichedb/core/adapter';

/**
 * Every algorithm and data structure on Wikidata, for the `algorithms`
 * collection.
 *
 * Wikidata holds about 2,700 items that are an instance of algorithm
 * (Q8366) or of one of its subclasses (sorting algorithm, block cipher,
 * cryptographic hash function, graph algorithm, root-finding algorithm, and
 * a few hundred narrower classes) and about 470 that are an instance of data
 * structure (Q175263) or a subclass of it. The lot is CC0, and every item
 * carries what an encyclopedia row wants: the English label and description,
 * the class it was filed under, the English Wikipedia article when there is
 * one, when it was devised (P571), who devised it (P61), its worst, average
 * and best-case time complexity and worst-case space (P3752, P3754, P3753,
 * P3755) as Wikidata's complexity items, and an image.
 *
 * The subclass tree is the community's, so a few things filed under
 * "heuristic" are not algorithms in the textbook sense (a strategem is; a
 * copyright-status heuristic is a stretch). They are kept and the class is a
 * tag, so a feed can pick "sorting-algorithm" or "block-cipher" and skip the
 * rest; a narrower read would lose real entries that are only filed two or
 * three classes down.
 *
 * One SPARQL query per root, ordered by item and paged with OFFSET at 500
 * rows a request (about 6 seconds on the query service on 2026-09-22; the
 * service times out at 60). Only items with an English label are rows: the
 * label is what the row is titled with, and a Q-number title says nothing.
 * A pass is both roots, six or seven requests, `requestsPerRun` a run; after
 * a pass the next run waits a week, which is how an item added or edited
 * since is picked up.
 */

export const WDQS = 'https://query.wikidata.org/sparql';
export const USER_AGENT = 'nichedb wikidata-algorithms (https://nichedb.dev; hello@nichedb.dev)';

/** The two roots walked, in order, and the kind each one's items get. */
export const ROOTS = [
  { key: 'algorithm', qid: 'Q8366', kind: 'algorithm' },
  { key: 'data-structure', qid: 'Q175263', kind: 'data-structure' },
];

/** Rows per request. 500 is a few seconds; the query service times out at 60. */
export const PAGE_ROWS = 500;

/** Requests per run. A pass is six or seven, so one run is usually a pass. */
export const REQUESTS_PER_RUN = 8;

/** Pause between requests; one second is the house pace for Wikidata. */
export const PAUSE_MS = 1000;

/** How long the next run waits after a whole pass. */
export const CADENCE_MINUTES = 10_080;

const FAILURE_STOP = 3;
const TIMEOUT_MS = 75_000;

export const PROVIDER = 'wikidata';
export const ATTRIBUTION = 'Wikidata';

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

const whole = (v, fallback) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const text = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
};

/** The GET url for a query. */
export const sparqlUrl = (query) =>
  `${WDQS}?format=json&query=${encodeURIComponent(String(query))}`;

/**
 * One page of items under a root: the item, its English label and
 * description, every class it is an instance of (pipe-joined), the English
 * Wikipedia article, inception, discoverers, the complexity labels and an
 * image. Grouped by item so multi-valued fields do not multiply rows.
 */
export function pageQuery(rootQid, offset, rows = PAGE_ROWS) {
  return [
    'SELECT ?item ?label ?description',
    '  (GROUP_CONCAT(DISTINCT ?classLabel; separator="|") AS ?classes)',
    '  (GROUP_CONCAT(DISTINCT ?classQid; separator="|") AS ?classIds)',
    '  (SAMPLE(?article) AS ?wikipedia) (SAMPLE(?inception) AS ?since)',
    '  (GROUP_CONCAT(DISTINCT ?discovererLabel; separator="|") AS ?discoverers)',
    '  (SAMPLE(?worstLabel) AS ?worstTime) (SAMPLE(?averageLabel) AS ?averageTime)',
    '  (SAMPLE(?bestLabel) AS ?bestTime) (SAMPLE(?spaceLabel) AS ?worstSpace)',
    '  (SAMPLE(?image) AS ?image)',
    'WHERE {',
    `  ?item wdt:P31 ?class . ?class wdt:P279* wd:${rootQid} .`,
    '  ?item rdfs:label ?label FILTER(LANG(?label) = "en")',
    '  BIND(STRAFTER(STR(?class), "/entity/") AS ?classQid)',
    '  OPTIONAL { ?item schema:description ?description FILTER(LANG(?description) = "en") }',
    '  OPTIONAL { ?class rdfs:label ?classLabel FILTER(LANG(?classLabel) = "en") }',
    '  OPTIONAL { ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> }',
    '  OPTIONAL { ?item wdt:P571 ?inception }',
    '  OPTIONAL { ?item wdt:P61 ?discoverer . ?discoverer rdfs:label ?discovererLabel FILTER(LANG(?discovererLabel) = "en") }',
    '  OPTIONAL { ?item wdt:P3752 ?worst . ?worst rdfs:label ?worstLabel FILTER(LANG(?worstLabel) = "en") }',
    '  OPTIONAL { ?item wdt:P3754 ?average . ?average rdfs:label ?averageLabel FILTER(LANG(?averageLabel) = "en") }',
    '  OPTIONAL { ?item wdt:P3753 ?best . ?best rdfs:label ?bestLabel FILTER(LANG(?bestLabel) = "en") }',
    '  OPTIONAL { ?item wdt:P3755 ?space . ?space rdfs:label ?spaceLabel FILTER(LANG(?spaceLabel) = "en") }',
    '  OPTIONAL { ?item wdt:P18 ?image }',
    '}',
    'GROUP BY ?item ?label ?description',
    'ORDER BY ?item',
    `LIMIT ${rows} OFFSET ${offset}`,
  ].join('\n');
}

/** The rows of a SPARQL JSON answer, each var reduced to its value. */
export function bindings(body) {
  const rows = body?.results?.bindings;
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => {
    const out = {};
    for (const [k, v] of Object.entries(r ?? {})) out[k] = text(v?.value);
    return out;
  });
}

/** The pipe-joined values of a multi-valued field, as a list. */
export const labels = (s) =>
  String(s ?? '')
    .split('|')
    .map((x) => x.trim())
    .filter(Boolean);

export const qidOf = (uri) => {
  const m = String(uri ?? '').match(/\/(Q\d+)$/);
  return m ? m[1] : null;
};

/**
 * A Wikidata time to what looseDate reads. Wikidata sends full timestamps
 * ("1960-01-01T00:00:00Z") even when only the year is known, so a January
 * first is read as a year and a first of the month as a month.
 */
export function wikidataDate(s) {
  const m = String(s ?? '').match(/^(\d{4})-(\d{2})-(\d{2})T/);
  if (!m) return null;
  if (m[2] === '01' && m[3] === '01') return m[1];
  if (m[3] === '01') return `${m[1]}-${m[2]}`;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** An item out of one row, or null for a row with no id or label. */
export function algorithmItem(row, root) {
  const qid = qidOf(row?.item);
  const title = text(row?.label);
  if (!qid || !title) return null;
  const classes = labels(row.classes);
  const classIds = labels(row.classIds);
  const when = wikidataDate(row.since);
  const dated = when ? looseDate(when) : {};
  const wikipedia = text(row.wikipedia);
  return {
    externalId: qid,
    kind: root.kind,
    title,
    summary: text(row.description),
    url: wikipedia ?? `https://www.wikidata.org/wiki/${qid}`,
    imageUrl: text(row.image),
    ...dated,
    tags: ['wikidata', root.kind, ...classes.slice(0, 6).map(slugify)].filter(Boolean),
    data: {
      qid,
      classes,
      classIds,
      wikipedia,
      inception: when,
      discoverers: labels(row.discoverers),
      worstTime: text(row.worstTime),
      averageTime: text(row.averageTime),
      bestTime: text(row.bestTime),
      worstSpace: text(row.worstSpace),
      provider: PROVIDER,
      attribution: ATTRIBUTION,
      license: 'CC0',
    },
  };
}

/** Where a run starts: which root and the offset into it; a fresh pass otherwise. */
export function resumeFrom(prev) {
  const rootIndex = ROOTS.findIndex((r) => r.key === prev?.root);
  const offset = Math.floor(Number(prev?.offset));
  return {
    rootIndex: rootIndex >= 0 ? rootIndex : 0,
    offset: rootIndex >= 0 && Number.isFinite(offset) && offset >= 0 ? offset : 0,
    passes: Math.max(0, Math.floor(Number(prev?.passes)) || 0),
  };
}

export const wikidataAlgorithms = defineAdapter({
  name: 'wikidata-algorithms',
  title: 'Wikidata: algorithms and data structures',
  collection: 'algorithms',
  description:
    'Every item Wikidata files as an algorithm (about 2,700: sorting, searching, graph, numerical, cryptographic and more, by subclass) or as a data structure (about 470), with the English description, the classes it is filed under, the Wikipedia article, when and by whom it was devised, and its stated time and space complexity. CC0. Walked in pages through the SPARQL query service; a pass is a handful of requests and repeats weekly.',
  docs: 'https://www.wikidata.org/wiki/Wikidata:SPARQL_query_service',
  kinds: ['algorithm', 'data-structure'],
  cadenceMinutes: 10,
  configFields: [
    {
      key: 'requestsPerRun',
      label: 'Requests per run',
      type: 'number',
      placeholder: String(REQUESTS_PER_RUN),
      help: 'Each is one page of rows. The walk stops here and picks up ten minutes later.',
    },
    {
      key: 'pageRows',
      label: 'Rows per request',
      type: 'number',
      placeholder: String(PAGE_ROWS),
      help: 'The query service times out at 60 seconds; 500 is a few seconds.',
    },
    {
      key: 'pauseMs',
      label: 'Pause between requests (ms)',
      type: 'number',
      placeholder: String(PAUSE_MS),
    },
  ],
  defaults: { requestsPerRun: REQUESTS_PER_RUN, pageRows: PAGE_ROWS, pauseMs: PAUSE_MS },
  defaultSources: [
    {
      slug: 'wikidata-algorithms',
      name: 'Wikidata: every algorithm and data structure',
      config: { requestsPerRun: REQUESTS_PER_RUN, pageRows: PAGE_ROWS, pauseMs: PAUSE_MS },
    },
  ],
  async *pull({ config, cursor: prev, http, log, deadline }) {
    const cap = whole(config?.requestsPerRun, REQUESTS_PER_RUN);
    const rows = whole(config?.pageRows, PAGE_ROWS);
    const pause =
      config?.pauseMs === 0 ? 0 : Math.max(0, Math.floor(Number(config?.pauseMs))) || PAUSE_MS;
    const stopAt = Number.isFinite(deadline) ? deadline : Number.POSITIVE_INFINITY;
    const state = resumeFrom(prev);
    let rootIndex = state.rootIndex;
    let offset = state.offset;
    let requests = 0;
    let failures = 0;
    let streak = 0;
    let written = 0;
    let skipped = 0;
    let stopped = null;

    const cursorAt = () => ({ root: ROOTS[rootIndex].key, offset, passes: state.passes });

    while (rootIndex < ROOTS.length) {
      if (requests >= cap) {
        stopped = 'cap';
        break;
      }
      if (Date.now() > stopAt) {
        stopped = 'deadline';
        break;
      }
      const root = ROOTS[rootIndex];
      if (requests > 0) await sleep(pause);
      requests += 1;
      let page;
      try {
        const res = await http.request(sparqlUrl(pageQuery(root.qid, offset, rows)), {
          headers: { accept: 'application/sparql-results+json', 'user-agent': USER_AGENT },
          timeoutMs: TIMEOUT_MS,
        });
        if (!res.ok) throw new Error(`query.wikidata.org answered ${res.status}`);
        page = bindings(await res.json());
        streak = 0;
      } catch (err) {
        failures += 1;
        streak += 1;
        log(`${root.key} at ${offset}: ${err?.message ?? err}`);
        if (streak >= FAILURE_STOP) {
          stopped = 'errors';
          break;
        }
        continue;
      }
      const items = [];
      for (const row of page) {
        const item = algorithmItem(row, root);
        if (item) items.push(item);
        else skipped += 1;
      }
      written += items.length;
      if (page.length < rows) {
        rootIndex += 1;
        offset = 0;
      } else {
        offset += page.length;
      }
      if (items.length > 0) {
        yield {
          items,
          cursor:
            rootIndex < ROOTS.length
              ? cursorAt()
              : { root: ROOTS[0].key, offset: 0, passes: state.passes },
        };
      }
    }

    const done = rootIndex >= ROOTS.length;
    if (done) {
      log(`pass complete: ${written} rows, ${skipped} without a label, ${failures} failed`);
      return {
        cursor: {
          root: ROOTS[0].key,
          offset: 0,
          passes: state.passes + 1,
          lastPassAt: new Date().toISOString(),
        },
        note: `pass complete: ${written} rows; next in a week`,
        nextInMinutes: CADENCE_MINUTES,
      };
    }
    log(`${written} rows, at ${ROOTS[rootIndex].key} offset ${offset} (${stopped})`);
    return {
      cursor: cursorAt(),
      note: `${written} rows, at ${ROOTS[rootIndex].key} offset ${offset}${failures ? `, ${failures} failed` : ''}`,
    };
  },
});
