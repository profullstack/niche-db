import { defineAdapter, looseDate, slugify } from '@nichedb/core/adapter';

import { normTitleOrNull } from './screen-titles.js';

/**
 * Every film on Wikidata, for the `screen` collection.
 *
 * Wikidata holds about 349,000 items that are an instance of film (P31 =
 * Q11424), CC0, behind a public SPARQL endpoint that asks for a descriptive
 * user agent and a gentle rate. It is the one film catalogue a public directory
 * can carry whole without a key: TMDB and IMDb rows here are windows onto
 * their catalogues, this is the whole thing, and every row carries the IMDb
 * and TMDB ids, so it is also the join table between the other two.
 *
 * How the walk goes. Paging with OFFSET times out past a few thousand rows on
 * this endpoint, so the walk is by numeric item id instead: one query per
 * window of Q ids (`?n >= start && ?n < end` on the number behind the Q),
 * which the query service answers deterministically whatever else is being
 * asked of it. A window is 200,000 ids by default and adapts as it goes:
 * measured live on 2026-09-13, the first 200,000 ids hold 1,719 films and
 * time out at the service's 60 s limit, while 20,000,000 to 20,200,000 holds
 * 1,853 and answers in 24 s, and 100,000,000 on holds 63 and answers in 6 s.
 * So a window that times out is halved and asked again, a window that comes
 * back with more than `maxRows` films is halved for next time, and a window
 * that comes back nearly empty doubles for next time, up to the configured
 * size; the size in force rides in the cursor. Q ids run to about 135 million,
 * so a pass is about 700 windows at the full size. A run asks for
 * `windowsPerRun` windows with a pause between them and resumes at the next
 * window ten minutes later; once the walk passes `topId` the pass is done and
 * the next run, a day later, starts over.
 *
 * The query. The brief's shape grouped by date and image, which multiplies a
 * film with two release dates into two rows, and filled the genre, country and
 * director labels through the label service's automatic mode, which leaves
 * every aggregated label empty (0 of 4,983 rows had a genre live). This one
 * takes MIN of the date and SAMPLE of the rest so a film is one row, and
 * names each label to the label service explicitly, which fills them. The
 * label language falls back from English through `mul` and the languages
 * films are mostly made in, because 44% of the films in a mid-range window
 * have no English label at all; a film whose label is still the bare Q id
 * has no title in any of them and is skipped.
 *
 * One item per film, kind `title`, the same shape as the TMDB and TVmaze
 * rows: category film, form movie, normTitle through screen-titles so the
 * match endpoint joins it, and the IMDb and TMDB ids under data. The image is
 * the P18 file through Commons' Special:FilePath at 512 px wide.
 */

export const SPARQL = 'https://query.wikidata.org/sparql';
export const PROVIDER = 'wikidata';
export const CATEGORY = 'film';
export const ATTRIBUTION = 'Wikidata, CC0';
export const USER_AGENT = 'nichedb (https://nichedb.dev; hello@nichedb.dev)';

/** Q ids in one window by default; the walk halves this when a window times out. */
export const WINDOW = 200_000;

/** The smallest a window shrinks to before a timeout counts as a failure. */
export const MIN_WINDOW = 12_500;

/** One past the newest Q id a pass needs to reach; Q ids were near 135 million on 2026-09-13. */
export const TOP_ID = 136_000_000;

/** Windows per run by default: about six requests, a minute or two of the queue. */
export const WINDOWS_PER_RUN = 6;

/** Films in one answer above which the window halves for next time. */
export const MAX_ROWS = 3000;

/** Wikidata asks for a gentle rate; a second between queries is what a polite client does. */
export const PAUSE_MS = 1000;

/** The query service cuts a query at 60 s; the client waits a little past that for the 504. */
export const TIMEOUT_MS = 70_000;

/** Consecutive failures after which a run stops asking, so an outage costs little. */
const FAILURE_STOP = 3;

/** Label languages, English first, then whatever the film was made in. */
export const LABEL_LANGUAGES = 'en,mul,fr,de,es,it,pt,ru,ja,zh,ko,hi,sv,nl,pl,cs,tr,ar';

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

const text = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
};

/** The SPARQL for one window of Q ids, `start` inclusive and `end` exclusive. */
export function buildQuery(start, end) {
  const s = Math.max(0, Math.floor(Number(start)) || 0);
  const e = Math.max(s + 1, Math.floor(Number(end)) || s + 1);
  return [
    'SELECT ?item ?itemLabel (MIN(?date) AS ?firstDate) (SAMPLE(?imdb) AS ?imdbId)',
    '(SAMPLE(?tmdb) AS ?tmdbId) (SAMPLE(?image) AS ?imageFile) (SAMPLE(?duration) AS ?runtime)',
    '(GROUP_CONCAT(DISTINCT ?genreLabel;separator="|") AS ?genres)',
    '(GROUP_CONCAT(DISTINCT ?countryLabel;separator="|") AS ?countries)',
    '(GROUP_CONCAT(DISTINCT ?directorLabel;separator="|") AS ?directors)',
    'WHERE {',
    '{ SELECT ?item WHERE { ?item wdt:P31 wd:Q11424 .',
    'BIND(xsd:integer(SUBSTR(STR(?item), 33)) AS ?n)',
    `FILTER(?n >= ${s} && ?n < ${e}) } }`,
    'OPTIONAL{?item wdt:P577 ?date} OPTIONAL{?item wdt:P345 ?imdb} OPTIONAL{?item wdt:P4947 ?tmdb}',
    'OPTIONAL{?item wdt:P18 ?image} OPTIONAL{?item wdt:P2047 ?duration}',
    'OPTIONAL{?item wdt:P136 ?genre} OPTIONAL{?item wdt:P495 ?country} OPTIONAL{?item wdt:P57 ?director}',
    `SERVICE wikibase:label { bd:serviceParam wikibase:language "${LABEL_LANGUAGES}".`,
    '?item rdfs:label ?itemLabel . ?genre rdfs:label ?genreLabel .',
    '?country rdfs:label ?countryLabel . ?director rdfs:label ?directorLabel . } }',
    'GROUP BY ?item ?itemLabel',
  ].join(' ');
}

/** The GET url for one window. */
export const windowUrl = (start, end) =>
  `${SPARQL}?query=${encodeURIComponent(buildQuery(start, end))}`;

/** The start and end a window url asks for, for a test or a log line. */
export function windowOf(url) {
  const q = new URL(url).searchParams.get('query') ?? '';
  const m = q.match(/\?n >= (\d+) && \?n < (\d+)/);
  return m ? { start: Number(m[1]), end: Number(m[2]) } : null;
}

/** The rows of a SPARQL JSON answer, or an empty list for anything else. */
export function parseBindings(body) {
  const rows = body?.results?.bindings;
  return Array.isArray(rows) ? rows.filter((r) => r && typeof r === 'object') : [];
}

const value = (row, key) => text(row?.[key]?.value);

/** `http://www.wikidata.org/entity/Q26060` -> `Q26060`. */
export function qidOf(uri) {
  const m = String(uri ?? '').match(/\/(Q\d+)$/);
  return m ? m[1] : null;
}

/** A label the label service could not find is the bare Q id. */
export const isBareQid = (label) => /^Q\d+$/.test(String(label ?? '').trim());

/** The file name behind a Commons `Special:FilePath/...` uri. */
export function fileOf(uri) {
  const m = String(uri ?? '').match(/Special:FilePath\/(.+)$/);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]).replace(/_/g, ' ') || null;
  } catch {
    return m[1];
  }
}

/** A Commons file as a 512 px wide image url. */
export const imageUrlFor = (file) =>
  file
    ? `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}?width=512`
    : null;

/** A `|`-joined GROUP_CONCAT into distinct trimmed names. */
export function splitList(v) {
  const out = [];
  for (const part of String(v ?? '').split('|')) {
    const s = part.trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * Wikidata's genre labels read "comedy film", "drama film"; TMDB's read
 * "Comedy", "Drama". Dropping the trailing word puts both under `genre:comedy`.
 */
export function genreName(label) {
  return String(label ?? '')
    .trim()
    .replace(/\s+films?$/i, '')
    .trim();
}

/** `1972-03-13T00:00:00Z` -> `1972-03-13`, or null for a date this catalogue cannot store. */
export function ymdOf(v) {
  const m = String(v ?? '').match(/^(\d{4})-(\d{2})-(\d{2})T/);
  if (!m) return null;
  const [, y, mo, d] = m;
  if (Number(y) < 1 || Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31)
    return null;
  return `${y}-${mo}-${d}`;
}

/** P2047 is a decimal in minutes for nearly every film; anything else is left out. */
export function runtimeOf(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

const listOf = (names) =>
  names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

/** One line a card can show: year, directors, countries, genres. */
export function summaryOf({ year, directors, countries, genres, runtimeMin }) {
  const head = `${year ? `${year} film` : 'Film'}${directors.length ? ` directed by ${listOf(directors)}` : ''}${countries.length ? ` (${countries.join(', ')})` : ''}.`;
  const tail = [
    genres.length ? `${genres[0][0].toUpperCase()}${genres.join(', ').slice(1)}.` : null,
    runtimeMin ? `${runtimeMin} min.` : null,
  ].filter(Boolean);
  return [head, ...tail].join(' ');
}

/** One SPARQL row -> one title item, or null for a row with no usable id or title. */
export function filmItem(row) {
  const qid = qidOf(value(row, 'item'));
  const label = value(row, 'itemLabel');
  if (!qid || !label || isBareQid(label)) return null;
  const ymd = ymdOf(value(row, 'firstDate'));
  const when = looseDate(ymd ?? '');
  const genres = splitList(value(row, 'genres')).map(genreName).filter(Boolean);
  const countries = splitList(value(row, 'countries'));
  const directors = splitList(value(row, 'directors'));
  const runtimeMin = runtimeOf(value(row, 'runtime'));
  const imageFile = fileOf(value(row, 'imageFile'));
  const year = ymd ? Number(ymd.slice(0, 4)) : null;
  const titleLanguage = text(row?.itemLabel?.['xml:lang']);
  return {
    externalId: `${PROVIDER}:film:${qid}`,
    kind: 'title',
    title: label,
    summary: summaryOf({ year, directors, countries, genres, runtimeMin }),
    url: `https://www.wikidata.org/wiki/${qid}`,
    imageUrl: imageUrlFor(imageFile),
    publishedAt: when.publishedAt,
    timeKnown: false,
    precision: when.precision,
    tags: [
      'title',
      CATEGORY,
      PROVIDER,
      ...genres.map((g) => `genre:${slugify(g)}`),
      ...countries.map((c) => `country:${slugify(c)}`),
    ].filter((t) => !t.endsWith(':')),
    data: {
      provider: PROVIDER,
      category: CATEGORY,
      form: 'movie',
      year,
      normTitle: normTitleOrNull(label),
      titleLanguage,
      imdbId: value(row, 'imdbId'),
      tmdbId: value(row, 'tmdbId'),
      tvmazeId: null,
      anilistId: null,
      wikidataId: qid,
      directors,
      genres,
      countries,
      runtimeMin,
      releaseDate: ymd,
      imageFile,
      attribution: ATTRIBUTION,
    },
  };
}

/** Where a run starts and how wide it asks: the cursor's place and window, else the configured start. */
export function resumeFrom(prev, config) {
  const startId = Math.max(0, Math.floor(Number(config?.startId)) || 0);
  const max = windowSize(config?.window, WINDOW);
  const next = Math.floor(Number(prev?.nextId));
  const window = windowSize(prev?.window, max);
  return {
    start: Number.isFinite(next) && next >= startId ? next : startId,
    window: Math.min(window, max),
  };
}

/** A window size, bounded and a multiple of the minimum so halving stays whole. */
export function windowSize(v, fallback) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < MIN_WINDOW) return fallback;
  return n;
}

/**
 * Whether an answer is the query service giving up on a window that is too
 * wide: its own 504, the Java timeout it sometimes wraps in a 500, or the
 * client's timeout firing first.
 */
export function isTimeout(status, bodyText, err) {
  if (err) {
    const name = String(err?.name ?? '');
    const msg = String(err?.message ?? err ?? '');
    return /timeout|abort/i.test(name) || /timed? ?out/i.test(msg);
  }
  if (status === 504) return true;
  if (status === 500 && /TimeoutException|timeout/i.test(String(bodyText ?? ''))) return true;
  return false;
}

export const wikidataFilms = defineAdapter({
  name: 'wikidata-films',
  title: 'Wikidata: every film',
  collection: 'screen',
  description:
    'Every film on Wikidata, about 349,000, as title rows in the same shape as the TMDB and TVmaze sources: title, release date, directors, genres, countries, runtime, poster from Commons, and the IMDb and TMDB ids that join it to the other two. Keyless; the data is CC0, so it can be used for anything with no credit required, and every row still says where it came from. Walks the numeric Q id space one window at a time through the SPARQL endpoint, shrinking a window that times out and resuming where it stopped; a pass is a few hundred windows and starts over once it passes the newest id.',
  docs: 'https://www.wikidata.org/wiki/Wikidata:SPARQL_query_service',
  kinds: ['title'],
  cadenceMinutes: 1440,
  configFields: [
    {
      key: 'windowsPerRun',
      label: 'Windows per run',
      type: 'number',
      placeholder: String(WINDOWS_PER_RUN),
      help: 'One SPARQL query per window. The walk stops here and picks up ten minutes later.',
    },
    {
      key: 'window',
      label: 'Q ids per window',
      type: 'number',
      placeholder: String(WINDOW),
      help: 'The widest window asked for. A window that times out is halved and asked again; a sparse one grows back.',
    },
    {
      key: 'topId',
      label: 'Q id a pass ends at',
      type: 'number',
      placeholder: String(TOP_ID),
      help: 'Past this id the pass is done and the next run starts over. Raise it as Wikidata grows.',
    },
    {
      key: 'maxRows',
      label: 'Films per window before halving',
      type: 'number',
      placeholder: String(MAX_ROWS),
      help: 'A window that answers with more films than this is kept, and the next window is half as wide.',
    },
    {
      key: 'pauseMs',
      label: 'Pause between queries (ms)',
      type: 'number',
      placeholder: String(PAUSE_MS),
      help: 'Wikidata asks for a gentle rate from clients that walk the whole graph.',
    },
  ],
  defaults: {
    startId: 0,
    windowsPerRun: WINDOWS_PER_RUN,
    window: WINDOW,
    topId: TOP_ID,
    maxRows: MAX_ROWS,
    pauseMs: PAUSE_MS,
  },
  defaultSources: [
    {
      slug: 'wikidata-films',
      name: 'Screen: every film on Wikidata',
      config: {
        startId: 0,
        windowsPerRun: WINDOWS_PER_RUN,
        window: WINDOW,
        topId: TOP_ID,
        maxRows: MAX_ROWS,
        pauseMs: PAUSE_MS,
      },
    },
  ],
  async pull({ config, cursor: prev, http, log, deadline }) {
    const cap = Math.max(1, Math.floor(Number(config?.windowsPerRun)) || WINDOWS_PER_RUN);
    const maxWindow = windowSize(config?.window, WINDOW);
    const topId = Math.max(1, Math.floor(Number(config?.topId)) || TOP_ID);
    const maxRows = Math.max(1, Math.floor(Number(config?.maxRows)) || MAX_ROWS);
    const pause =
      config?.pauseMs === 0 ? 0 : Math.max(0, Math.floor(Number(config?.pauseMs))) || PAUSE_MS;
    const stopAt = Number.isFinite(deadline) ? deadline : Number.POSITIVE_INFINITY;
    const started = resumeFrom(prev, config);
    let start = started.start;
    let window = started.window;
    let requests = 0;
    let failures = 0;
    let streak = 0;
    let windows = 0;
    let skipped = 0;
    let halved = 0;
    let stopped = null;
    const items = [];

    for (;;) {
      if (start >= topId) {
        stopped = 'top';
        break;
      }
      if (requests >= cap) {
        stopped = 'cap';
        break;
      }
      if (Date.now() > stopAt) {
        stopped = 'deadline';
        break;
      }
      if (requests > 0) await sleep(pause);
      requests += 1;
      const end = Math.min(start + window, topId);
      let body = null;
      let timedOut = false;
      let failed = null;
      try {
        const res = await http.request(windowUrl(start, end), {
          headers: { accept: 'application/sparql-results+json', 'user-agent': USER_AGENT },
          timeoutMs: TIMEOUT_MS,
        });
        if (res.ok) {
          body = await res.json();
        } else {
          const bodyText = await res.text().catch(() => '');
          if (isTimeout(res.status, bodyText)) timedOut = true;
          else failed = new Error(`query.wikidata.org answered ${res.status}`);
        }
      } catch (err) {
        if (isTimeout(null, null, err)) timedOut = true;
        else failed = err;
      }

      if (timedOut && window > MIN_WINDOW) {
        window = Math.max(MIN_WINDOW, Math.floor(window / 2));
        halved += 1;
        streak = 0;
        log(`window ${start} to ${end} timed out, asking again ${window} wide`);
        continue;
      }
      if (timedOut || failed) {
        failures += 1;
        streak += 1;
        log(
          `window ${start} to ${end} unavailable (${timedOut ? 'timed out at the smallest window' : (failed?.message ?? failed)})`,
        );
        if (streak >= FAILURE_STOP) {
          stopped = 'errors';
          break;
        }
        continue;
      }

      streak = 0;
      windows += 1;
      const rows = parseBindings(body);
      for (const row of rows) {
        const item = filmItem(row);
        if (item) items.push(item);
        else skipped += 1;
      }
      start = end;
      if (rows.length > maxRows && window > MIN_WINDOW) {
        window = Math.max(MIN_WINDOW, Math.floor(window / 2));
        halved += 1;
      } else if (rows.length * 4 <= maxRows && window < maxWindow) {
        window = Math.min(maxWindow, window * 2);
      }
    }

    if (requests > 0 && failures === requests) {
      throw new Error(
        `wikidata-films: every request failed (${requests} of ${requests}); see the log`,
      );
    }

    const done = stopped === 'top';
    const reason =
      stopped === 'cap'
        ? 'at the window cap'
        : stopped === 'deadline'
          ? 'on the run deadline'
          : stopped === 'errors'
            ? 'after repeated failures'
            : null;

    return {
      items,
      cursor: {
        nextId: done ? null : start,
        window,
        walkedAt: done ? new Date().toISOString() : (prev?.walkedAt ?? null),
      },
      nextInMinutes: done ? undefined : 10,
      note:
        `${items.length} films from ${windows} windows (ids ${started.start} to ${start - 1})` +
        (skipped ? `, ${skipped} without a title` : '') +
        (halved ? `, window halved ${halved} times to ${window}` : '') +
        (failures ? `, ${failures} failed` : '') +
        (done
          ? `; past the top id, next run starts over at ${resumeFrom(null, config).start}`
          : `; stopped ${reason} at ${start}, resuming in 10 min`),
    };
  },
});
