import { defineAdapter, looseDate, slugify } from '@nichedb/core/adapter';

/**
 * Every video game on Wikidata, for the `games` collection.
 *
 * Wikidata holds about 176,000 items that are an instance of video game
 * (P31 = Q7889) and the lot is CC0, so this is the one games catalogue a
 * public directory can carry whole with no key and no terms to keep. The
 * query service (query.wikidata.org) answers SPARQL, times a query out at 60
 * seconds and asks for a descriptive User-Agent and a gentle rate, so the
 * walk is shaped around those three facts.
 *
 * The walk is by numeric id. Every item is Q<n>, so a request asks for the
 * games with n in [from, from + windowSpan) in id order, at most pageRows of
 * them, with the labels, ids and dates joined on in the same query. A window
 * that fills the page is not finished: the next request starts at the last
 * id seen plus one, so a dense stretch (Q135,000,000 to Q136,000,000 holds
 * 53,000 games from one bulk import, most million-id stretches hold under a
 * thousand) is read in as many pages as it needs and a sparse one costs one
 * request. A pass starts by asking for the highest game id and ends when the
 * window start is past it; measured on 2026-09-13, that is about 440 requests
 * at 500 rows, each 3 to 15 seconds, so a pass is around an hour of query
 * time spread over eleven runs at the default cap. The next run after a pass
 * starts over, which is how a game added or edited since is picked up.
 *
 * Titles prefer the English label and fall back to Wikidata's language-neutral
 * `mul` label; a game with neither is skipped and counted, never thrown on.
 * Release dates come from the statement value so the precision is known: a
 * game dated to a year is stored at year precision rather than as January 1.
 */

export const WDQS = 'https://query.wikidata.org/sparql';
export const USER_AGENT = 'nichedb wikidata-games (https://nichedb.dev; hello@nichedb.dev)';

/** The instance-of value that means video game. */
export const GAME_CLASS = 'Q7889';

/** Ids per window. One million is one request across most of the id space. */
export const WINDOW_SPAN = 1_000_000;

/** Rows per request. 500 is 3 to 15 seconds on the query service; 1,000 came close to its 60 second limit. */
export const PAGE_ROWS = 500;

/** Requests per run: 40 requests is five to seven minutes, eleven runs for a pass. */
export const REQUESTS_PER_RUN = 40;

/** Pause between requests. The query service asks for a gentle rate; one second is the house pace for Wikidata. */
export const PAUSE_MS = 1000;

/** Consecutive failures after which a run stops asking, so an outage costs little. */
const FAILURE_STOP = 3;

/** Rows are halved on a failed window down to this (a quarter of a smaller page), since a timeout is the usual failure. */
const MIN_ROWS = 100;

/** Query service timeout is 60 seconds; leave room for the response to arrive. */
const TIMEOUT_MS = 75_000;

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

const text = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
};

const whole = (v, fallback) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** The GET url for a query. The service accepts GET and it keeps the fake in the test keyed on the url. */
export const sparqlUrl = (query) =>
  `${WDQS}?format=json&query=${encodeURIComponent(String(query))}`;

/** The highest game id and the count, one row. */
export const topQuery = () =>
  `SELECT (MAX(xsd:integer(STRAFTER(STR(?item), "Q"))) AS ?top) (COUNT(?item) AS ?total) WHERE { ?item wdt:P31 wd:${GAME_CLASS} }`;

/**
 * The games with an id in [from, to), in id order, at most `rows` of them,
 * one row per game. Single-valued fields are sampled (a game with two release
 * dates keeps the earliest, with its precision riding along after a slash),
 * multi-valued ones are joined with a pipe. Labels are plain rdfs:label
 * lookups rather than the label service, which timed out on the older,
 * claim-rich games.
 */
export function windowQuery(from, to, rows = PAGE_ROWS) {
  const lo = Math.max(0, Math.floor(Number(from)) || 0);
  const hi = Math.max(lo + 1, Math.floor(Number(to)) || lo + 1);
  const limit = whole(rows, PAGE_ROWS);
  const labelled = (v, prop) =>
    `OPTIONAL { ?item wdt:${prop} ?${v} . ?${v} rdfs:label ?${v}Label FILTER(LANG(?${v}Label) = "en") }`;
  const joined = (v) => `(GROUP_CONCAT(DISTINCT ?${v}Label; separator="|") AS ?${v}Labels)`;
  return [
    'SELECT ?item ?id (SAMPLE(?labelEn) AS ?title) (SAMPLE(?labelMul) AS ?titleMul)',
    '(SAMPLE(?desc) AS ?description)',
    '(MIN(CONCAT(STR(?date), "/", STR(?prec))) AS ?published)',
    '(SAMPLE(?steam) AS ?steamAppId) (SAMPLE(?gog) AS ?gogId) (SAMPLE(?igdb) AS ?igdbId)',
    '(SAMPLE(?image) AS ?imageFile) (SAMPLE(?site) AS ?officialSite)',
    joined('platform'),
    joined('publisher'),
    joined('developer'),
    joined('genre'),
    joined('mode'),
    'WHERE {',
    `{ SELECT ?item ?id WHERE { ?item wdt:P31 wd:${GAME_CLASS} . BIND(xsd:integer(STRAFTER(STR(?item), "Q")) AS ?id) FILTER(?id >= ${lo} && ?id < ${hi}) } ORDER BY ?id LIMIT ${limit} }`,
    'OPTIONAL { ?item rdfs:label ?labelEn FILTER(LANG(?labelEn) = "en") }',
    'OPTIONAL { ?item rdfs:label ?labelMul FILTER(LANG(?labelMul) = "mul") }',
    'OPTIONAL { ?item schema:description ?desc FILTER(LANG(?desc) = "en") }',
    'OPTIONAL { ?item p:P577 ?dateStatement . ?dateStatement psv:P577 ?dateValue . ?dateValue wikibase:timeValue ?date ; wikibase:timePrecision ?prec }',
    'OPTIONAL { ?item wdt:P1733 ?steam }',
    'OPTIONAL { ?item wdt:P2725 ?gog }',
    'OPTIONAL { ?item wdt:P5794 ?igdb }',
    'OPTIONAL { ?item wdt:P18 ?image }',
    'OPTIONAL { ?item wdt:P856 ?site }',
    labelled('platform', 'P400'),
    labelled('publisher', 'P123'),
    labelled('developer', 'P178'),
    labelled('genre', 'P136'),
    labelled('mode', 'P404'),
    '} GROUP BY ?item ?id ORDER BY ?id',
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

/** `{ top, total }` out of the top query, or null when the answer has no top. */
export function parseTop(body) {
  const row = bindings(body)[0];
  const top = Math.floor(Number(row?.top));
  if (!Number.isFinite(top) || top <= 0) return null;
  const total = Math.floor(Number(row?.total));
  return { top, total: Number.isFinite(total) && total >= 0 ? total : null };
}

/** The pipe-joined labels of a multi-valued field, as a list. */
export const labels = (s) =>
  String(s ?? '')
    .split('|')
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * `2010-01-11T00:00:00Z/11` (a time value and Wikidata's precision) to a date
 * string of the matching coarseness: 11 is a day, 10 a month, 9 or coarser a
 * year. Null when there is no usable year.
 */
export function wikidataDate(s) {
  const m = String(s ?? '').match(/^\+?(-?\d{1,4})-(\d{2})-(\d{2})T[^/]*(?:\/(\d+))?$/);
  if (!m) return null;
  const year = Number(m[1]);
  if (!Number.isFinite(year) || year <= 0) return null;
  const y = String(year).padStart(4, '0');
  const precision = m[4] === undefined ? 11 : Number(m[4]);
  if (precision >= 11) return `${y}-${m[2]}-${m[3]}`;
  if (precision === 10) return `${y}-${m[2]}`;
  return y;
}

/** The Commons file url as the service hands it, over https, at a size a card can use. */
export function imageUrl(file) {
  const s = text(file);
  if (!s) return null;
  const m = s.match(/^https?:\/\/commons\.wikimedia\.org\/wiki\/Special:FilePath\/(.+)$/);
  if (!m) return s;
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${m[1]}?width=800`;
}

/** The Q-id at the end of an entity uri, or null. */
export const qidOf = (uri) => {
  const m = String(uri ?? '').match(/(Q\d+)$/);
  return m ? m[1] : null;
};

/**
 * One row of the window query -> a plain game, or null when the row has no
 * id or no label in English or `mul`. Nothing here throws on a sparse row.
 */
export function readRow(row) {
  const qid = qidOf(row?.item);
  const title = text(row?.title) ?? text(row?.titleMul);
  if (!qid || !title) return null;
  const releaseDate = wikidataDate(row?.published);
  return {
    qid,
    id: Number(qid.slice(1)),
    title,
    description: text(row?.description),
    releaseDate,
    year: releaseDate ? Number(releaseDate.slice(0, 4)) : null,
    steamAppId: text(row?.steamAppId),
    gogId: text(row?.gogId),
    igdbId: text(row?.igdbId),
    image: text(row?.imageFile),
    officialSite: text(row?.officialSite),
    platforms: labels(row?.platformLabels),
    publishers: labels(row?.publisherLabels),
    developers: labels(row?.developerLabels),
    genres: labels(row?.genreLabels),
    modes: labels(row?.modeLabels),
  };
}

/** One game -> one item, in the shape the IGDB sources use so the two sit together in `games`. */
export function gameItem(g) {
  const external = {};
  if (g.steamAppId) external.steam = g.steamAppId;
  if (g.gogId) external.gog = g.gogId;
  if (g.igdbId) external.igdb = g.igdbId;
  external.wikidata = g.qid;
  return {
    externalId: `wikidata:game:${g.qid}`,
    kind: 'game',
    title: g.title,
    summary: g.description,
    url: `https://www.wikidata.org/wiki/${g.qid}`,
    imageUrl: imageUrl(g.image),
    ...looseDate(g.releaseDate ?? ''),
    tags: [
      'game',
      'wikidata',
      ...g.platforms.map((x) => `platform:${slugify(x)}`),
      ...g.genres.map((x) => `genre:${slugify(x)}`),
    ].filter((t) => !t.endsWith(':')),
    data: {
      provider: 'wikidata',
      qid: g.qid,
      wikidataUrl: `https://www.wikidata.org/wiki/${g.qid}`,
      title: g.title,
      description: g.description,
      releaseDate: g.releaseDate,
      year: g.year,
      steamAppId: g.steamAppId,
      steamUrl: g.steamAppId ? `https://store.steampowered.com/app/${g.steamAppId}` : null,
      gogId: g.gogId,
      gogUrl: g.gogId ? `https://www.gog.com/${g.gogId.replace(/^\/+/, '')}` : null,
      igdbId: g.igdbId,
      igdbUrl: g.igdbId ? `https://www.igdb.com/games/${g.igdbId}` : null,
      officialSite: g.officialSite,
      image: g.image,
      developers: g.developers,
      publishers: g.publishers,
      platforms: g.platforms,
      genres: g.genres,
      modes: g.modes,
      external,
      attribution: 'Wikidata, CC0',
      licence: 'CC0-1.0',
    },
  };
}

/** Where a run starts. `topId` set means a pass is under way; a cursor without one starts a pass. */
export function resumeFrom(prev) {
  const from = Math.floor(Number(prev?.from));
  const topId = Math.floor(Number(prev?.topId));
  const total = Math.floor(Number(prev?.total));
  return {
    from: Number.isFinite(from) && from >= 0 ? from : 0,
    topId: Number.isFinite(topId) && topId > 0 ? topId : null,
    total: Number.isFinite(total) && total >= 0 ? total : null,
    walkedAt: typeof prev?.walkedAt === 'string' ? prev.walkedAt : null,
  };
}

export const wikidataGames = defineAdapter({
  name: 'wikidata-games',
  title: 'Wikidata: every video game',
  collection: 'games',
  description:
    'Every item Wikidata calls a video game, about 176,000, as game rows: title, description, release date at its stated precision, image, official site, platforms, genres, game modes, developers and publishers, and the Steam, GOG and IGDB ids Wikidata cross-references. Wikidata is CC0, so the rows may be used for anything with no credit required, and the source is still named on every row. Walks the numeric id space through the SPARQL query service, a window of ids a request, and starts over once past the highest game.',
  docs: 'https://www.wikidata.org/wiki/Wikidata:SPARQL_query_service',
  kinds: ['game'],
  cadenceMinutes: 1440,
  configFields: [
    {
      key: 'requestsPerRun',
      label: 'Requests per run',
      type: 'number',
      placeholder: String(REQUESTS_PER_RUN),
      help: 'Each is one window of ids. The walk stops here and picks up ten minutes later.',
    },
    {
      key: 'windowSpan',
      label: 'Ids per window',
      type: 'number',
      placeholder: String(WINDOW_SPAN),
      help: 'How many Q numbers one request covers. Most million-id stretches hold under a thousand games.',
    },
    {
      key: 'pageRows',
      label: 'Rows per request',
      type: 'number',
      placeholder: String(PAGE_ROWS),
      help: 'A window with more games than this is read in more than one request. The query service times out at 60 seconds; 500 is safe.',
    },
    {
      key: 'pauseMs',
      label: 'Pause between requests (ms)',
      type: 'number',
      placeholder: String(PAUSE_MS),
      help: 'The query service asks for a gentle rate and a descriptive user agent; every request carries one.',
    },
  ],
  defaults: {
    requestsPerRun: REQUESTS_PER_RUN,
    windowSpan: WINDOW_SPAN,
    pageRows: PAGE_ROWS,
    pauseMs: PAUSE_MS,
  },
  defaultSources: [
    {
      slug: 'wikidata-games',
      name: 'Games: every video game on Wikidata',
      config: {
        requestsPerRun: REQUESTS_PER_RUN,
        windowSpan: WINDOW_SPAN,
        pageRows: PAGE_ROWS,
        pauseMs: PAUSE_MS,
      },
    },
  ],
  async pull({ config, cursor: prev, http, log, deadline }) {
    const cap = whole(config?.requestsPerRun, REQUESTS_PER_RUN);
    const span = whole(config?.windowSpan, WINDOW_SPAN);
    const pageRows = whole(config?.pageRows, PAGE_ROWS);
    const pause =
      config?.pauseMs === 0 ? 0 : Math.max(0, Math.floor(Number(config?.pauseMs))) || PAUSE_MS;
    const stopAt = Number.isFinite(deadline) ? deadline : Number.POSITIVE_INFINITY;
    const state = resumeFrom(prev);
    const startedAt = state.from;
    let from = state.from;
    let topId = state.topId;
    let total = state.total;
    let rows = pageRows;
    const rowsFloor = Math.max(1, Math.min(MIN_ROWS, Math.floor(pageRows / 4)));
    const items = [];
    let requests = 0;
    let failures = 0;
    let streak = 0;
    let skipped = 0;
    let stopped = null;
    let done = false;

    const ask = async (query) => {
      if (requests > 0) await sleep(pause);
      requests += 1;
      const res = await http.request(sparqlUrl(query), {
        headers: { accept: 'application/sparql-results+json', 'user-agent': USER_AGENT },
        timeoutMs: TIMEOUT_MS,
      });
      if (!res.ok) throw new Error(`query.wikidata.org answered ${res.status}`);
      return res.json();
    };

    for (;;) {
      if (requests >= cap) {
        stopped = 'cap';
        break;
      }
      if (Date.now() > stopAt) {
        stopped = 'deadline';
        break;
      }
      if (topId === null) {
        try {
          const top = parseTop(await ask(topQuery()));
          if (!top) throw new Error('no highest id in the answer');
          topId = top.top;
          total = top.total;
          streak = 0;
        } catch (err) {
          failures += 1;
          streak += 1;
          log(`highest game id unavailable (${err?.message ?? err})`);
          if (streak >= FAILURE_STOP) {
            stopped = 'errors';
            break;
          }
        }
        continue;
      }
      if (from > topId) {
        done = true;
        break;
      }
      const to = from + span;
      let page;
      try {
        page = bindings(await ask(windowQuery(from, to, rows)));
        streak = 0;
      } catch (err) {
        failures += 1;
        streak += 1;
        log(`window Q${from} to Q${to} unavailable at ${rows} rows (${err?.message ?? err})`);
        rows = Math.max(rowsFloor, Math.floor(rows / 2));
        if (streak >= FAILURE_STOP) {
          stopped = 'errors';
          break;
        }
        continue;
      }
      let maxId = -1;
      for (const row of page) {
        const id = Number(qidOf(row.item)?.slice(1));
        if (Number.isFinite(id)) maxId = Math.max(maxId, id);
        const g = readRow(row);
        if (!g) {
          skipped += 1;
          continue;
        }
        items.push(gameItem(g));
      }
      from = page.length >= rows && maxId >= from ? maxId + 1 : to;
    }

    if (requests > 0 && failures === requests) {
      throw new Error(`wikidata: every request failed (${requests} of ${requests}); see the log`);
    }

    const reason =
      stopped === 'cap'
        ? 'at the request cap'
        : stopped === 'deadline'
          ? 'on the run deadline'
          : stopped === 'errors'
            ? 'after repeated failures'
            : null;
    log(`${items.length} games in ${requests} requests (Q${startedAt} to Q${from})`);

    return {
      items,
      cursor: done
        ? { from: null, topId: null, total, walkedAt: new Date().toISOString() }
        : { from, topId, total, walkedAt: state.walkedAt },
      nextInMinutes: done ? undefined : 10,
      note:
        `${items.length} games from ${requests} requests (Q${startedAt} to Q${from}` +
        `${topId ? `, highest game Q${topId}` : ''}${total ? `, ${total} in all` : ''})` +
        (skipped ? `, ${skipped} skipped for want of a label` : '') +
        (failures ? `, ${failures} failed` : '') +
        (done
          ? '; past the highest game, next run starts over at Q0'
          : `; stopped ${reason} at Q${from}, resuming in 10 min`),
    };
  },
});
