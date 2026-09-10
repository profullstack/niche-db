import { defineAdapter, looseDate, slugify } from '@nichedb/core/adapter';
import { normTitleOrNull } from './screen-titles.js';

/**
 * Film, from TMDB. Ported from genrewatch's catalogue poller.
 *
 * The one screen source that needs a key, and it is free. A film release date is
 * a DATE: TMDB says "2026-12-16" and nothing finer, so every release here is
 * time_known false at day precision.
 *
 * One run does three things, in this order, inside its deadline:
 *
 *   1. The forward calendar: `discover` pages for the next `horizonDays`, most
 *      popular first. A film seen for the first time is emitted straight from the
 *      discover row (poster, overview, rating) with its theatrical release, and
 *      queued for detail.
 *   2. The back catalogue, once: `backCataloguePages` of popularity-ordered films
 *      that already came out, a slice per run via the cursor until the cursor
 *      reaches the end. Page 20 is The Empire Strikes Back; page 250 is nobody.
 *   3. Detail, one request per film inside `budget`: credits, trailer, watch
 *      providers, runtime, tagline, the IMDb id and the region's home-release
 *      dates. A detailed film is re-emitted in full together with its digital and
 *      streaming release rows. Detailed films are re-asked on a slow cycle,
 *      because a digital date is announced weeks AFTER a film opens and asking
 *      once always asks too early.
 *
 * The cursor keeps which ids have been detailed (and when), the detail queue and
 * the back-catalogue page. A film that has already been detailed is NOT re-emitted
 * from a later discover sweep: the discover row is thinner than what the table
 * already holds and would overwrite it.
 */

const BASE = 'https://api.themoviedb.org/3';
const POSTER = 'https://image.tmdb.org/t/p/w342';
const BACKDROP = 'https://image.tmdb.org/t/p/w780';
const PROVIDER = 'tmdb';
const CATEGORY = 'film';

/** TMDB tolerates ~50/s. 100 ms is well inside it and costs nothing here. */
export const MIN_GAP_MS = 100;

/** TMDB's release_type table: 1 premiere, 2 limited, 3 theatrical, 4 digital,
 *  5 physical, 6 TV. */
export const THEATRICAL = 3;
export const DIGITAL = 4;

/** TMDB refuses discover pages beyond 500 whatever the result count. */
const MAX_PAGE = 500;

/** Genres TMDB carries that this collection files elsewhere. */
const REROUTED = new Set(['tv movie']);

/**
 * Notes on a digital release that do NOT name a service. A type-4 entry usually
 * carries a note; most are service names ("Disney+", "Peacock"), so the tests are
 * for the notes that are something else: a window, a cut, a shop.
 */
const NOT_A_SERVICE =
  /^(digital|digital hd|vod|pvod|tvod|est|premium|premium vod|rental|rent|buy|purchase|streaming|online)$/i;
const A_FORMAT_NOTE =
  /\b(version|edition|cut|subtitled|subtitles|dubbed|dub|remaster(ed)?|restored|anniversary|uncut|extended|unrated|imax|3-?d|re-?release|theatrical|director'?s)\b/i;
const A_WINDOW_PHRASE = /\b(pvod|tvod|vod|rent|buy|purchase|rental|est)\b/i;
const NOT_A_PLACE = /[()]|\b(store|channel|official|unreleased|theatres?|cinemas?)\b/i;

/** True when a note names a service somebody could subscribe to. */
export function namesAService(note) {
  if (!note) return false;
  return (
    !NOT_A_SERVICE.test(note) &&
    !A_FORMAT_NOTE.test(note) &&
    !A_WINDOW_PHRASE.test(note) &&
    !NOT_A_PLACE.test(note)
  );
}

const ymd = (d) => d.toISOString().slice(0, 10);
const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s ?? ''));
const today = () => Math.floor(Date.now() / 86_400_000);

/**
 * When a film reaches the reader's own television, from a release_dates payload.
 *
 * Two dates, because TMDB records two and they are weeks apart: rent-or-buy and
 * the subscription service. The service is carried rather than derived, because
 * "Disney+, 23 September" is the whole answer for someone deciding whether to
 * rent it.
 *
 * @returns {{vod: string|null, streaming: {date: string, service: string}|null}}
 */
export function homeReleases(payload, { region = 'US' } = {}) {
  const country = (payload?.results ?? []).find((r) => r?.iso_3166_1 === region);
  const entries = (country?.release_dates ?? [])
    .filter((r) => r?.type === DIGITAL && typeof r.release_date === 'string')
    .map((r) => ({ date: r.release_date.slice(0, 10), note: (r.note ?? '').trim() }))
    .filter((r) => isYmd(r.date))
    .sort((a, b) => a.date.localeCompare(b.date));

  const named = entries.find((e) => namesAService(e.note));
  const plain = entries.find((e) => !namesAService(e.note));

  return {
    vod: plain?.date ?? null,
    streaming: named ? { date: named.date, service: named.note } : null,
  };
}

/** Genre names for a movie, from a detail response or a discover row + table. */
export function genreNames(m, genreById = new Map()) {
  const names = Array.isArray(m.genres)
    ? m.genres.map((g) => g?.name)
    : (m.genre_ids ?? []).map((id) => genreById.get(id));
  return names.filter((n) => n && !REROUTED.has(n.toLowerCase()));
}

const genreTags = (names) => names.map((n) => `genre:${slugify(n)}`);

/**
 * Everything the detail call adds to a discover row, flattened.
 *
 * Pure, so the rules (official trailer first, flat-rate providers only, capped at
 * six) can be tested without a network.
 */
export function detailOf(d, { region = 'US' } = {}) {
  const credits = d.credits ?? {};
  const vids = (d.videos?.results ?? []).filter(
    (v) => v.type === 'Trailer' && v.site === 'YouTube' && v.key,
  );
  const trailer = vids.find((v) => v.official) ?? vids[0];
  const providers = d['watch/providers']?.results?.[region] ?? {};
  return {
    imdbId: d.imdb_id || null,
    runtimeMin: d.runtime || null,
    tagline: d.tagline?.trim() || null,
    trailerUrl: trailer ? `https://www.youtube.com/watch?v=${trailer.key}` : null,
    // Flat-rate streaming only. Rent and buy are a different question from "is
    // it included where I already subscribe".
    watch: (providers.flatrate ?? []).map((p) => p.provider_name).slice(0, 6),
    cast: (credits.cast ?? []).slice(0, 8).map((c) => c.name),
    director: (credits.crew ?? []).find((c) => c.job === 'Director')?.name ?? null,
    studios: (d.production_companies ?? []).map((c) => c.name).slice(0, 3),
    language: d.spoken_languages?.[0]?.english_name ?? null,
    home: homeReleases(d.release_dates, { region }),
  };
}

/**
 * A film as a `title` item.
 *
 * @param {object} m a discover row or a detail response
 * @param {object} [opts]
 * @param {Map<number,string>} [opts.genreById] the genre table, for discover rows
 * @param {object|null} [opts.detail] what `detailOf` returned, when enriched
 */
export function titleItem(m, { genreById, detail = null, region = 'US' } = {}) {
  if (!m?.id || !m.title) return null;
  const id = String(m.id);
  const genres = genreNames(m, genreById);
  const when = looseDate(m.release_date ?? '');
  const votes = Number(m.vote_count ?? 0);
  const poster = m.poster_path ? `${POSTER}${m.poster_path}` : null;
  const backdrop = m.backdrop_path ? `${BACKDROP}${m.backdrop_path}` : null;
  return {
    externalId: `${PROVIDER}:title:${id}`,
    kind: 'title',
    title: m.title,
    summary: m.overview?.trim() || null,
    url: `https://www.themoviedb.org/movie/${id}`,
    imageUrl: poster,
    publishedAt: when.publishedAt,
    timeKnown: false,
    precision: when.precision,
    tags: ['title', CATEGORY, PROVIDER, ...genreTags(genres)],
    data: {
      provider: PROVIDER,
      category: CATEGORY,
      form: 'movie',
      year: isYmd(m.release_date) ? Number(m.release_date.slice(0, 4)) : null,
      normTitle: normTitleOrNull(m.title),
      imdbId: detail?.imdbId ?? null,
      tmdbId: id,
      tvmazeId: null,
      anilistId: null,
      genres,
      rating: votes > 0 && Number.isFinite(Number(m.vote_average)) ? Number(m.vote_average) : null,
      ratingCount: votes || null,
      popularity: Number(m.popularity) || null,
      backdropUrl: backdrop,
      tagline: detail?.tagline ?? null,
      trailerUrl: detail?.trailerUrl ?? null,
      runtimeMin: detail?.runtimeMin ?? null,
      watch: detail?.watch ?? [],
      watchRegion: region,
      originalTitle: m.original_title ?? null,
      releaseDate: isYmd(m.release_date) ? m.release_date : null,
      digitalDate: detail?.home?.vod ?? null,
      streaming: detail?.home?.streaming ?? null,
      cast: detail?.cast ?? [],
      director: detail?.director ?? null,
      studios: detail?.studios ?? [],
      language: detail?.language ?? null,
      // False until the detail call has been made, so a page can tell "no
      // trailer" from "not looked yet".
      detailed: Boolean(detail),
    },
  };
}

/**
 * The release rows a film deserves: the theatrical date from the discover row,
 * and the region's digital and streaming dates when the detail call found them.
 *
 * Keyed apart (`tmdb:release:`, `tmdb:digital:`, `tmdb:stream:<id>:<service>`) so
 * a film that opens in June and lands on Disney+ in September is two things a
 * reader can be told about separately.
 */
export function releaseItems(m, { genreById, detail = null, region = 'US' } = {}) {
  if (!m?.id || !m.title) return [];
  const id = String(m.id);
  const genres = genreNames(m, genreById);
  const poster = m.poster_path ? `${POSTER}${m.poster_path}` : null;
  const backdrop = m.backdrop_path ? `${BACKDROP}${m.backdrop_path}` : null;
  const votes = Number(m.vote_count ?? 0);
  const base = (slot, type, dateStr, venue, venueRegion) => {
    const when = looseDate(dateStr);
    if (!when.publishedAt) return null;
    return {
      externalId: slot,
      kind: 'release',
      title: m.title,
      summary: m.overview?.trim() || null,
      url: `https://www.themoviedb.org/movie/${id}`,
      imageUrl: backdrop ?? poster,
      publishedAt: when.publishedAt,
      timeKnown: false,
      precision: when.precision,
      tags: ['release', CATEGORY, PROVIDER, ...genreTags(genres), `type:${type}`],
      data: {
        provider: PROVIDER,
        category: CATEGORY,
        type,
        titleExternalId: `${PROVIDER}:title:${id}`,
        titleName: m.title,
        season: null,
        number: null,
        venue,
        venueRegion,
        runtimeMin: detail?.runtimeMin ?? null,
        tmdbId: id,
        imdbId: detail?.imdbId ?? null,
        date: dateStr,
        posterUrl: poster,
        backdropUrl: backdrop,
        rating: votes > 0 ? Number(m.vote_average) : null,
        ratingCount: votes || null,
      },
    };
  };
  const home = detail?.home;
  return [
    isYmd(m.release_date)
      ? base(`${PROVIDER}:release:${id}`, 'theatrical', m.release_date, 'Cinemas', null)
      : null,
    home?.vod
      ? base(`${PROVIDER}:digital:${id}`, 'digital', home.vod, 'Rent or buy', region)
      : null,
    home?.streaming
      ? base(
          `${PROVIDER}:stream:${id}:${slugify(home.streaming.service) || 'service'}`,
          'stream',
          home.streaming.date,
          home.streaming.service,
          region,
        )
      : null,
  ].filter(Boolean);
}

/**
 * Bring the cursor to the shape this run expects, whatever an older run left.
 * `seen` maps a TMDB id to the day it was detailed (0 = queued, not yet), `queue`
 * is the ids waiting for a detail call, `backPage` the next back-catalogue page.
 */
export function readCursor(cursor = {}) {
  return {
    seen: cursor.seen && typeof cursor.seen === 'object' ? { ...cursor.seen } : {},
    queue: Array.isArray(cursor.queue) ? [...cursor.queue] : [],
    backPage: Number(cursor.backPage) > 0 ? Number(cursor.backPage) : 1,
  };
}

/** Keep the cursor bounded: the oldest detailed ids go first, never a queued one. */
export function trimSeen(seen, max = 12_000) {
  const ids = Object.keys(seen);
  if (ids.length <= max) return seen;
  const detailed = ids.filter((id) => seen[id] > 0).sort((a, b) => seen[a] - seen[b]);
  for (const id of detailed.slice(0, ids.length - max)) delete seen[id];
  return seen;
}

/**
 * GET one TMDB path. The key goes on the query string here and nowhere else:
 * never in an item's `url`, never in `data`, and never in an error message, which
 * is why this does not use `http.json` (its errors quote the URL).
 */
async function tmdbGet(http, key, path, params = {}) {
  const qs = new URLSearchParams({ ...params, api_key: key });
  const res = await http.request(`${BASE}${path}?${qs}`, { timeoutMs: 20_000 });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`tmdb answered ${res.status} for ${path}`);
  return res.json();
}

export const tmdbReleases = defineAdapter({
  name: 'tmdb-releases',
  title: 'TMDB film releases',
  collection: 'screen',
  description:
    'Films from TMDB: the forward release calendar with theatrical, rent-or-buy and streaming dates for one region, plus a popularity-ordered back catalogue filled once. Posters, genres, ratings, trailers, watch providers and IMDb ids. Needs a free TMDB API key on the deployment (TMDB_API_KEY).',
  docs: 'https://developer.themoviedb.org/docs',
  kinds: ['title', 'release'],
  cadenceMinutes: 720,
  needsEnv: ['tmdbApiKey'],
  configFields: [
    {
      key: 'region',
      label: 'Region',
      placeholder: 'US',
      help: 'ISO 3166-1 country whose home-release dates and watch providers are quoted.',
    },
    { key: 'horizonDays', label: 'Days ahead', type: 'number', placeholder: '120' },
    {
      key: 'backCataloguePages',
      label: 'Back-catalogue pages',
      type: 'number',
      placeholder: '200',
      help: 'Pages of 20 already-released films, most popular first, fetched once.',
    },
  ],
  defaults: {
    region: 'US',
    horizonDays: 120,
    backCataloguePages: 200,
    forwardPages: 15,
    backPagesPerRun: 40,
    redetailDays: 14,
    gapMs: MIN_GAP_MS,
  },
  defaultSources: [{ slug: 'tmdb-releases', name: 'TMDB: film releases' }],
  async pull({ config, cursor, env, http, log, budget, deadline }) {
    const key = env.tmdbApiKey;
    if (!key) throw new Error('tmdb-releases needs TMDB_API_KEY');

    const region = String(config.region || 'US').toUpperCase();
    const horizonDays = Math.max(1, Number(config.horizonDays) || 120);
    const backPages = Math.min(Math.max(0, Number(config.backCataloguePages) || 0), MAX_PAGE);
    const forwardPages = Math.min(Math.max(1, Number(config.forwardPages) || 15), MAX_PAGE);
    const backPagesPerRun = Math.max(1, Number(config.backPagesPerRun) || 40);
    const redetailDays = Math.max(1, Number(config.redetailDays) || 14);
    const gapMs = Number.isFinite(Number(config.gapMs)) ? Number(config.gapMs) : MIN_GAP_MS;

    const state = readCursor(cursor);
    const { seen } = state;
    let { queue } = state;
    const items = [];
    const day = today();
    const timeLeft = () => Date.now() < deadline - 2_000;
    const get = async (path, params) => {
      const out = await tmdbGet(http, key, path, params);
      if (gapMs > 0) await Bun.sleep(gapMs);
      return out;
    };

    const genreById = new Map();
    for (const g of (await get('/genre/movie/list'))?.genres ?? []) genreById.set(g.id, g.name);

    /* 1. The forward calendar. New films are emitted thin and queued for detail;
          detailed ones that have gone stale are queued again. */
    const from = new Date();
    const to = new Date(from.getTime() + horizonDays * 86_400_000);
    const fresh = [];
    const stale = [];
    let forward = 0;
    for (let page = 1; page <= forwardPages && timeLeft(); page++) {
      const res = await get('/discover/movie', {
        'primary_release_date.gte': ymd(from),
        'primary_release_date.lte': ymd(to),
        sort_by: 'popularity.desc',
        include_adult: 'false',
        page: String(page),
      });
      const results = res?.results ?? [];
      for (const m of results) {
        if (!m?.id || !isYmd(m.release_date)) continue;
        forward++;
        const id = String(m.id);
        if (!seen[id]) {
          const t = titleItem(m, { genreById, region });
          if (!t) continue;
          items.push(t, ...releaseItems(m, { genreById, region }));
          seen[id] = 0;
          fresh.push(id);
        } else if (day - seen[id] >= redetailDays) {
          stale.push(id);
        }
      }
      if (results.length === 0 || (res?.page ?? page) >= (res?.total_pages ?? 1)) break;
    }

    /* 2. The back catalogue, a slice per run until the cursor reaches the end. */
    const back = [];
    let backFilms = 0;
    const backStart = state.backPage;
    let backPage = backStart;
    const backEnd = Math.min(backPages, backStart + backPagesPerRun - 1);
    while (backPage <= backEnd && timeLeft()) {
      const res = await get('/discover/movie', {
        'primary_release_date.gte': '1970-01-01',
        'primary_release_date.lte': ymd(from),
        sort_by: 'popularity.desc',
        include_adult: 'false',
        page: String(backPage),
      });
      const results = res?.results ?? [];
      backPage++;
      for (const m of results) {
        if (!m?.id || !isYmd(m.release_date)) continue;
        backFilms++;
        const id = String(m.id);
        if (seen[id] !== undefined) continue;
        const t = titleItem(m, { genreById, region });
        if (!t) continue;
        items.push(t, ...releaseItems(m, { genreById, region }));
        seen[id] = 0;
        back.push(id);
      }
      if (results.length === 0 || (res?.page ?? backPage) >= (res?.total_pages ?? 1)) {
        backPage = backPages + 1;
      }
    }

    /* Newly seen forward films go to the front of the queue: they are what a
       reader is waiting for. The back catalogue and the stale re-checks wait. */
    const queued = new Set([...fresh, ...back, ...stale]);
    queue = [...fresh, ...queue.filter((id) => !queued.has(id)), ...back, ...stale];

    /* 3. Detail, inside the budget. A 404 is stamped like a hit so it is not
          re-asked every run; a transport error leaves the id queued. */
    let spent = 0;
    let detailed = 0;
    let homeDates = 0;
    while (queue.length && spent < budget && timeLeft()) {
      const id = queue[0];
      let d;
      try {
        spent++;
        d = await get(`/movie/${encodeURIComponent(id)}`, {
          append_to_response: 'credits,videos,watch/providers,release_dates',
        });
      } catch (err) {
        log(`detail ${id} failed: ${err?.message ?? err}`);
        queue.push(queue.shift());
        continue;
      }
      queue.shift();
      seen[id] = day;
      if (!d?.id) continue;
      const detail = detailOf(d, { region });
      const t = titleItem(d, { detail, region });
      if (!t) continue;
      const releases = releaseItems(d, { detail, region });
      items.push(t, ...releases);
      detailed++;
      if (releases.length > 1) homeDates++;
    }

    trimSeen(seen);
    const fillDone = backPage > backPages;
    const more = queue.length > 0 || !fillDone;
    log(
      `${forward} films in the next ${horizonDays} days (${fresh.length} new, ${stale.length} stale), ` +
        `back catalogue pages ${backStart}-${backPage - 1} of ${backPages} (${backFilms} films), ` +
        `${detailed} detailed with ${homeDates} home dates, ${queue.length} queued`,
    );
    return {
      items,
      cursor: { seen, queue, backPage: Math.min(backPage, backPages + 1) },
      note: `${items.length} items, ${detailed} detailed, ${queue.length} queued`,
      nextInMinutes: more ? 1 : undefined,
    };
  },
});
