import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { defineAdapter, looseDate, slugify } from '@nichedb/core/adapter';
import { normTitleOrNull } from './screen-titles.js';

/**
 * The whole catalogue, from IMDb's daily dumps. Ported from genrewatch's
 * backfill.
 *
 * The forward sources answer "what is coming"; this answers "what exists", so a
 * film in somebody's own VOD folder has a row to be matched against. IMDb
 * publishes everything, daily, free, with no key, at datasets.imdbws.com. What it
 * does NOT publish is a release date finer than a year, so every row here is at
 * year precision: browsable and matchable, never alarmable.
 *
 * Two rules decide what is kept, the same two genrewatch uses: a title with at
 * least `minVotes` ratings is worth holding whenever it came out, and a title
 * from the last `recentYears` is worth holding whether or not anybody has rated
 * it yet, because a film released last month has almost no votes and is
 * precisely the one sitting unmatched in a folder. tvEpisode is skipped: eight
 * and a half million rows that are only interesting through their show, which
 * TVmaze already describes with real air times.
 *
 * Three properties make it safe to run inside an ingest deadline:
 *
 *   - It STREAMS. title.basics is ~185 MB gzipped and ~900 MB open; nothing bigger
 *     than one decoded chunk is ever held, and the download is cancelled the
 *     moment a run has what it needs.
 *   - It PAGES. A run emits at most `perRun` titles and records how many data
 *     lines it has consumed; the next run skips that many lines without parsing
 *     them (a newline count, not a split) and carries on. It asks to be run again
 *     in a minute until the dump is exhausted, then rests until the next day.
 *   - It RESTARTS on a new dump. Offsets only mean something inside one file, so
 *     the cursor carries the dump's Last-Modified and a changed stamp starts over.
 *
 * The ratings map (~430k titles above 100 votes, packed one integer per entry)
 * is kept in this module between the runs of one walk and dropped when the walk
 * completes, so the 7 MB ratings dump is not re-read every minute.
 */

const BASE = 'https://datasets.imdbws.com';
const BASICS = `${BASE}/title.basics.tsv.gz`;
const RATINGS = `${BASE}/title.ratings.tsv.gz`;
const PROVIDER = 'imdb';

/** Which title types are worth holding, and what each is here. */
const KIND_MAP = {
  movie: { form: 'movie', category: 'film' },
  tvMovie: { form: 'movie', category: 'film' },
  video: { form: 'movie', category: 'film' },
  tvSeries: { form: 'series', category: 'tv' },
  tvMiniSeries: { form: 'series', category: 'tv' },
  tvSpecial: { form: 'series', category: 'tv' },
};

/** IMDb genre names this collection does not carry. */
const SKIP_GENRES = new Set(['Adult', 'Short', 'Game-Show', 'Reality-TV', 'Talk-Show', 'News']);

/**
 * Ratings, packed into one number per title: the rating in the high digits, the
 * vote count in the low seven. A Map of 430k objects is a hundred megabytes of
 * small allocations; a Map of 430k integers is a fraction of that.
 */
export const packRating = (rating, votes) =>
  Math.round((rating ?? 0) * 10) * 10_000_000 + Math.min(votes ?? 0, 9_999_999);
export const unpackRating = (packed) => ({
  rating: Math.floor(packed / 10_000_000) / 10,
  votes: packed % 10_000_000,
});

/** A TSV integer, or null. */
export function intOf(v) {
  if (v === null || v === undefined) return null;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

/** One TSV line as an object keyed by the header. `\N` is IMDb's null. */
export function parseTsvLine(header, line) {
  const cells = line.split('\t');
  const row = {};
  for (let i = 0; i < header.length; i++) {
    const v = cells[i];
    row[header[i]] = v === undefined || v === '\\N' || v === '' ? null : v;
  }
  return row;
}

/**
 * Gunzip a byte stream and yield it a line at a time, holding nothing bigger
 * than one decoded chunk. Breaking out of the loop destroys both streams, which
 * cancels the download underneath.
 *
 * @param {ReadableStream|import('node:stream').Readable} source gzipped bytes
 */
export async function* gunzipLines(source) {
  const input = source instanceof Readable ? source : Readable.fromWeb(source);
  const gunzip = createGunzip();
  input.pipe(gunzip);
  const decoder = new TextDecoder();
  let rest = '';
  try {
    for await (const chunk of gunzip) {
      rest += decoder.decode(chunk, { stream: true });
      let start = 0;
      let nl = rest.indexOf('\n', start);
      while (nl !== -1) {
        yield rest.slice(start, nl);
        start = nl + 1;
        nl = rest.indexOf('\n', start);
      }
      rest = rest.slice(start);
    }
    rest += decoder.decode();
    // A final line without a trailing newline is legal and IMDb's dumps have had one.
    if (rest !== '') yield rest;
  } finally {
    input.destroy();
    gunzip.destroy();
  }
}

/**
 * Read title.ratings and keep the titles anybody has heard of.
 *
 * @param {AsyncIterable<string>|Iterable<string>} lines
 * @returns {Promise<Map<string, number>>} tconst -> packed rating
 */
export async function loadRatings(lines, { minVotes = 100 } = {}) {
  const keep = new Map();
  let header = null;
  for await (const line of lines) {
    if (line === '') continue;
    if (!header) {
      header = line.split('\t');
      continue;
    }
    const row = parseTsvLine(header, line);
    const votes = intOf(row.numVotes);
    if (!votes || votes < minVotes) continue;
    const rating = Number.parseFloat(row.averageRating);
    keep.set(row.tconst, packRating(Number.isFinite(rating) ? rating : null, votes));
  }
  return keep;
}

/**
 * Turn one basics row into a candidate, or null to skip it. Pure: these rules
 * decide what the collection contains, and getting them wrong is either a
 * million rows of noise or a missing film.
 *
 * @param {object} row a parsed title.basics line
 * @param {{rated?: number, thisYear: number, recentYears: number}} ctx
 */
export function candidateFrom(row, { rated, thisYear, recentYears }) {
  if (!row?.tconst || !row.primaryTitle) return null;
  const map = KIND_MAP[row.titleType];
  if (!map) return null;
  // isAdult is "0"/"1" in the dump.
  if (row.isAdult === '1') return null;

  const year = intOf(row.startYear);
  const votes = rated ? unpackRating(rated) : null;
  const known = Boolean(votes);
  const recent = year !== null && year >= thisYear - recentYears;
  if (!known && !recent) return null;

  const genres = (row.genres ?? '')
    .split(',')
    .map((g) => g.trim())
    .filter((g) => g && !SKIP_GENRES.has(g));

  return {
    tconst: row.tconst,
    title: row.primaryTitle,
    originalTitle: row.originalTitle ?? null,
    titleType: row.titleType,
    year,
    endYear: intOf(row.endYear),
    category: map.category,
    form: map.form,
    runtimeMin: intOf(row.runtimeMinutes),
    rating: votes?.rating ?? null,
    ratingCount: votes?.votes ?? null,
    genres,
  };
}

/** A candidate as a `title` item. */
export function titleItem(c) {
  if (!c?.tconst || !c.title) return null;
  const when = c.year ? looseDate(String(c.year)) : { publishedAt: null, precision: 'year' };
  return {
    externalId: `${PROVIDER}:title:${c.tconst}`,
    kind: 'title',
    title: c.title,
    summary: null,
    url: `https://www.imdb.com/title/${c.tconst}/`,
    imageUrl: null,
    publishedAt: when.publishedAt,
    timeKnown: false,
    precision: when.precision,
    tags: ['title', c.category, PROVIDER, ...c.genres.map((g) => `genre:${slugify(g)}`)],
    data: {
      provider: PROVIDER,
      category: c.category,
      form: c.form,
      year: c.year,
      normTitle: normTitleOrNull(c.title),
      imdbId: c.tconst,
      tmdbId: null,
      tvmazeId: null,
      anilistId: null,
      genres: c.genres,
      rating: c.rating,
      ratingCount: c.ratingCount,
      popularity: null,
      backdropUrl: null,
      tagline: null,
      trailerUrl: null,
      runtimeMin: c.runtimeMin,
      watch: [],
      titleType: c.titleType,
      originalTitle: c.originalTitle,
      endYear: c.endYear,
    },
  };
}

/**
 * One page of the basics dump.
 *
 * Skips `offset` data lines without splitting them, then parses until `limit`
 * items have been emitted, the deadline passes, or the file ends. `consumed` is
 * the number of data lines this call has moved past in total (offset included)
 * and is the next run's offset; `finished` is true only when the file ended.
 *
 * @param {object} opts
 * @param {AsyncIterable<string>|Iterable<string>} opts.lines
 * @param {number} [opts.offset]
 * @param {number} [opts.limit]
 * @param {number} [opts.deadline]
 * @param {Map<string, number>} opts.rated
 * @param {number} opts.thisYear
 * @param {number} opts.recentYears
 */
export async function readBasics({
  lines,
  offset = 0,
  limit = 20_000,
  deadline = Number.POSITIVE_INFINITY,
  rated,
  thisYear,
  recentYears,
}) {
  const items = [];
  let header = null;
  let consumed = 0;
  let skipped = 0;
  let finished = true;
  for await (const line of lines) {
    if (line === '') continue;
    if (!header) {
      header = line.split('\t');
      continue;
    }
    if (consumed < offset) {
      consumed++;
      skipped++;
      continue;
    }
    consumed++;
    const row = parseTsvLine(header, line);
    const c = candidateFrom(row, { rated: rated?.get(row.tconst), thisYear, recentYears });
    if (c) {
      const item = titleItem(c);
      if (item) items.push(item);
    }
    if (items.length >= limit) {
      finished = false;
      break;
    }
    /* Checked against lines READ, not items emitted: the file is mostly episodes,
       which are skipped, so there are stretches of millions of lines that emit
       nothing and would otherwise run past the deadline. */
    if (consumed % 20_000 === 0 && Date.now() > deadline) {
      finished = false;
      break;
    }
  }
  return { items, consumed, skipped, finished };
}

/** The ratings map for one dump, shared by the runs of one walk. */
let ratingsCache = null;

async function ratingsFor(http, { stamp, minVotes, log }) {
  if (ratingsCache?.stamp === stamp && ratingsCache.minVotes === minVotes) return ratingsCache.map;
  const res = await http.request(RATINGS, { timeoutMs: 10 * 60_000 });
  if (!res.ok || !res.body) throw new Error(`imdb ratings answered ${res.status}`);
  const map = await loadRatings(gunzipLines(res.body), { minVotes });
  log(`ratings: ${map.size} titles above ${minVotes} votes`);
  ratingsCache = { stamp, minVotes, map };
  return map;
}

export const imdbRatings = defineAdapter({
  name: 'imdb-ratings',
  title: 'IMDb titles and ratings',
  collection: 'screen',
  description:
    'Every film and series in the IMDb daily dumps that at least a hundred people have rated, plus everything from the last two years whether rated or not: title, year, type, genres, runtime, rating and vote count. Streamed a page per run from datasets.imdbws.com, resuming until the dump is exhausted. Keyless.',
  docs: 'https://developer.imdb.com/non-commercial-datasets/',
  kinds: ['title'],
  cadenceMinutes: 1440,
  configFields: [
    {
      key: 'minVotes',
      label: 'Minimum votes',
      type: 'number',
      placeholder: '100',
      help: 'A title with this many ratings is kept whatever its year.',
    },
    {
      key: 'recentYears',
      label: 'Recent years',
      type: 'number',
      placeholder: '2',
      help: 'A title from the last N years is kept whether rated or not.',
    },
    { key: 'perRun', label: 'Titles per run', type: 'number', placeholder: '20000' },
  ],
  defaults: { minVotes: 100, recentYears: 2, perRun: 20_000 },
  defaultSources: [{ slug: 'imdb-ratings', name: 'IMDb: titles and ratings' }],
  async pull({ config, cursor, http, log, deadline }) {
    const minVotes = Math.max(1, Number(config.minVotes) || 100);
    const recentYears = Math.max(0, Number(config.recentYears) || 2);
    const perRun = Math.max(100, Number(config.perRun) || 20_000);
    const thisYear = new Date().getUTCFullYear();

    const res = await http.request(BASICS, { timeoutMs: 15 * 60_000 });
    if (!res.ok || !res.body) throw new Error(`imdb basics answered ${res.status}`);
    const stamp =
      res.headers.get('last-modified') ??
      res.headers.get('etag') ??
      new Date().toISOString().slice(0, 10);

    if (cursor.done && cursor.dumpDate === stamp) {
      await res.body.cancel().catch(() => {});
      log('dump unchanged since the last complete walk');
      return { items: [], cursor, note: 'dump unchanged' };
    }
    const offset = cursor.dumpDate === stamp ? Math.max(0, Number(cursor.offset) || 0) : 0;
    if (cursor.dumpDate && cursor.dumpDate !== stamp) {
      log(`new dump (${stamp}), starting over`);
      ratingsCache = null;
    }

    const rated = await ratingsFor(http, { stamp, minVotes, log });
    const { items, consumed, skipped, finished } = await readBasics({
      lines: gunzipLines(res.body),
      offset,
      limit: perRun,
      deadline: deadline - 10_000,
      rated,
      thisYear,
      recentYears,
    });
    if (finished) ratingsCache = null;

    log(
      `${items.length} titles from lines ${skipped}-${consumed}` +
        `${finished ? ', dump exhausted' : ''}`,
    );
    return {
      items,
      cursor: { dumpDate: stamp, offset: consumed, done: finished },
      note: `${items.length} titles, ${consumed} lines${finished ? ', complete' : ''}`,
      nextInMinutes: finished ? undefined : 1,
    };
  },
});
