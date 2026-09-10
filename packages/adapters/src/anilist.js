import { dateOnly, defineAdapter, slugify, stripHtml } from '@nichedb/core/adapter';
import { normTitleOrNull } from './screen-titles.js';

/**
 * Anime, from AniList. Ported from genrewatch's catalogue poller.
 *
 * Chosen over Jikan/MyAnimeList because AniList publishes an `AiringSchedule`
 * with a real unix timestamp per episode, so "episode 8 airs at 17:30 JST on
 * Thursday" is a fact we are given rather than reconstructed from a weekday and
 * a timezone name. Every release here is therefore time-known at the minute.
 *
 * Keyless GraphQL. The published limit is 90 requests a minute and has spent
 * long stretches degraded to 30, so the pacing below is set for the degraded
 * number: this fetch is never urgent and a 429 costs a whole run.
 */

const ENDPOINT = 'https://graphql.anilist.co';
const PROVIDER = 'anilist';
const CATEGORY = 'anime';

/** 2.5 s between calls: comfortably inside AniList's degraded 30/min ceiling. */
export const MIN_GAP_MS = 2500;

/** AniList caps perPage at 50 whatever you ask for. */
const PER_PAGE = 50;

export const QUERY = `query ($page: Int, $from: Int, $to: Int) {
  Page(page: $page, perPage: ${PER_PAGE}) {
    pageInfo { hasNextPage currentPage }
    airingSchedules(airingAt_greater: $from, airingAt_lesser: $to, sort: TIME) {
      id
      airingAt
      episode
      media {
        id
        idMal
        title { romaji english native }
        genres
        format
        status
        siteUrl
        description(asHtml: false)
        episodes
        duration
        averageScore
        popularity
        seasonYear
        startDate { year month day }
        bannerImage
        coverImage { medium large }
        trailer { id site }
        studios(isMain: true) { nodes { name } }
      }
    }
  }
}`;

/** AniList descriptions carry <br> and <i> even with asHtml:false. */
export function plain(text, limit = 400) {
  const s = stripHtml(text).replace(/\s+([.,;:!?])/g, '$1');
  if (!s) return null;
  return s.length > limit ? `${s.slice(0, limit - 1)}…` : s;
}

/**
 * Formats that are not episodic television. A MOVIE with an "airing schedule"
 * is a broadcast premiere, and calling it "episode 1" is wrong in a way readers
 * notice immediately.
 */
const FILM_FORMATS = new Set(['MOVIE']);

const genreTags = (names) => names.map((n) => `genre:${slugify(n)}`);

/** The first release, from AniList's partial date. */
export function startOf(m) {
  const { year, month, day } = m?.startDate ?? {};
  if (!year) return { publishedAt: null, precision: 'year', year: m?.seasonYear ?? null };
  if (month && day) return { publishedAt: dateOnly(year, month, day), precision: 'day', year };
  if (month) return { publishedAt: dateOnly(year, month, 15), precision: 'month', year };
  return { publishedAt: dateOnly(year, 7, 1), precision: 'year', year };
}

export const nameOf = (m) => m?.title?.english || m?.title?.romaji || m?.title?.native || null;

const trailerOf = (m) =>
  m?.trailer?.site === 'youtube' && m.trailer.id
    ? `https://www.youtube.com/watch?v=${m.trailer.id}`
    : null;

/** A series or film as a `title` item. */
export function titleItem(m) {
  const title = nameOf(m);
  if (!m?.id || !title) return null;
  const id = String(m.id);
  const genres = (m.genres ?? []).filter(Boolean);
  const start = startOf(m);
  const studios = (m.studios?.nodes ?? []).map((n) => n.name).filter(Boolean);
  return {
    externalId: `${PROVIDER}:title:${id}`,
    kind: 'title',
    title,
    summary: plain(m.description),
    url: m.siteUrl ?? `https://anilist.co/anime/${id}`,
    imageUrl: m.coverImage?.large ?? m.coverImage?.medium ?? null,
    publishedAt: start.publishedAt,
    timeKnown: false,
    precision: start.precision,
    tags: ['title', CATEGORY, PROVIDER, ...genreTags(genres)],
    data: {
      provider: PROVIDER,
      category: CATEGORY,
      form: FILM_FORMATS.has(m.format) ? 'movie' : 'series',
      year: start.year,
      normTitle: normTitleOrNull(title),
      imdbId: null,
      tmdbId: null,
      tvmazeId: null,
      anilistId: id,
      malId: m.idMal != null ? String(m.idMal) : null,
      genres,
      // AniList scores out of 100; every other source here is out of 10.
      rating: Number.isFinite(m.averageScore) ? Number(m.averageScore) / 10 : null,
      ratingCount: null,
      popularity: Number.isFinite(m.popularity) ? Number(m.popularity) : null,
      backdropUrl: m.bannerImage ?? null,
      tagline: null,
      trailerUrl: trailerOf(m),
      runtimeMin: m.duration ?? null,
      watch: [],
      titles: {
        english: m.title?.english ?? null,
        romaji: m.title?.romaji ?? null,
        native: m.title?.native ?? null,
      },
      format: m.format ?? null,
      status: m.status ?? null,
      episodes: m.episodes ?? null,
      studios,
    },
  };
}

/** One airing as a `release` item with `type:airing`. */
export function releaseItem(s) {
  const m = s?.media;
  const title = nameOf(m);
  if (!m?.id || !title || !s.airingAt) return null;
  const airingAt = new Date(Number(s.airingAt) * 1000);
  if (Number.isNaN(airingAt.getTime())) return null;
  const genres = (m.genres ?? []).filter(Boolean);
  const isFilm = FILM_FORMATS.has(m.format);
  const episode = s.episode ?? null;
  const studio = m.studios?.nodes?.[0]?.name ?? null;
  return {
    externalId: `${PROVIDER}:airing:${m.id}:${episode ?? 0}`,
    kind: 'release',
    title: isFilm ? title : `${title} — Episode ${episode ?? '?'}`,
    summary: plain(m.description),
    imageUrl: m.bannerImage ?? m.coverImage?.large ?? m.coverImage?.medium ?? null,
    url: m.siteUrl ?? `https://anilist.co/anime/${m.id}`,
    publishedAt: airingAt,
    timeKnown: true,
    precision: 'minute',
    tags: ['release', CATEGORY, PROVIDER, ...genreTags(genres), 'type:airing'],
    data: {
      provider: PROVIDER,
      category: CATEGORY,
      type: 'airing',
      titleExternalId: `${PROVIDER}:title:${m.id}`,
      titleName: title,
      season: null,
      number: episode,
      // The studio is the closest thing anime has to a network, and it is the
      // credit fans actually follow.
      venue: studio,
      venueRegion: 'Japan',
      runtimeMin: m.duration ?? null,
      airingScheduleId: String(s.id ?? ''),
      episodeType: isFilm ? 'film' : episode === 1 ? 'premiere' : 'episode',
      episodes: m.episodes ?? null,
      format: m.format ?? null,
      posterUrl: m.coverImage?.large ?? m.coverImage?.medium ?? null,
      backdropUrl: m.bannerImage ?? null,
      rating: Number.isFinite(m.averageScore) ? Number(m.averageScore) / 10 : null,
      trailerUrl: trailerOf(m),
    },
  };
}

/** Titles (once each) and releases from a list of airing schedules. */
export function buildItems(schedules) {
  const titles = new Map();
  const releases = [];
  for (const s of schedules ?? []) {
    const r = releaseItem(s);
    if (!r) continue;
    releases.push(r);
    if (!titles.has(s.media.id)) {
      const t = titleItem(s.media);
      if (t) titles.set(s.media.id, t);
    }
  }
  return { titles: [...titles.values()], releases };
}

export const anilistAiring = defineAdapter({
  name: 'anilist-airing',
  title: 'AniList airing schedule',
  collection: 'screen',
  description:
    'Every anime episode airing in the coming weeks from AniList, with a real broadcast timestamp per episode, the series it belongs to, genres, studio, cover and banner art, score and trailer. Keyless GraphQL.',
  docs: 'https://docs.anilist.co/',
  kinds: ['title', 'release'],
  cadenceMinutes: 360,
  configFields: [
    { key: 'horizonDays', label: 'Days ahead', type: 'number', placeholder: '60' },
    { key: 'maxPages', label: 'Pages of 50', type: 'number', placeholder: '30' },
  ],
  defaults: { horizonDays: 60, maxPages: 30, gapMs: MIN_GAP_MS },
  defaultSources: [{ slug: 'anilist-airing', name: 'AniList: anime airing' }],
  async pull({ config, http, log, deadline }) {
    const horizonDays = Math.max(1, Number(config.horizonDays) || 60);
    const maxPages = Math.min(Math.max(1, Number(config.maxPages) || 30), 200);
    const gapMs = Number.isFinite(Number(config.gapMs)) ? Number(config.gapMs) : MIN_GAP_MS;
    const fromSec = Math.floor(Date.now() / 1000);
    const toSec = fromSec + horizonDays * 86_400;

    const schedules = [];
    let pages = 0;
    for (let page = 1; page <= maxPages; page++) {
      if (Date.now() > deadline - 5_000) {
        log(`deadline reached after ${pages} pages`);
        break;
      }
      const res = await http.json(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: QUERY, variables: { page, from: fromSec, to: toSec } }),
        timeoutMs: 40_000,
      });
      /* GraphQL reports failure with HTTP 200 and an `errors` array, and a
         silent `?.` chain would turn a rate-limit complaint into a quiet week. */
      if (res?.errors?.length) {
        throw new Error(`anilist: ${res.errors.map((e) => e.message).join('; ')}`);
      }
      pages++;
      const pageData = res?.data?.Page;
      const got = pageData?.airingSchedules ?? [];
      schedules.push(...got);
      if (got.length === 0 || !pageData?.pageInfo?.hasNextPage) break;
      if (gapMs > 0) await Bun.sleep(gapMs);
    }

    const { titles, releases } = buildItems(schedules);
    log(`${pages} pages: ${titles.length} series, ${releases.length} airings`);
    return {
      items: [...titles, ...releases],
      note: `${titles.length} series, ${releases.length} airings`,
    };
  },
});
