import { defineEnricher } from './enricher.js';

/**
 * A poster, a synopsis and a TMDB id for a title that only IMDb told us about.
 *
 * The IMDb dumps are the whole catalogue (~430k titles) and carry no picture and
 * no synopsis, so an IMDb-only row is a name, a year and a rating. TMDB's `find`
 * endpoint answers an IMDb id with the matching film or show in one request,
 * poster and overview included, which is what genrewatch's backfill did per row
 * and what this does per item, on the enrichment worker, inside the budget.
 *
 * Not everything is found and not every hit is complete: TMDB is thin on the
 * same obscure titles IMDb is thin on. A miss is still an answer and is stored
 * as `{ tmdbId: null }` so the item is stamped and never asked again; the next
 * IMDb dump does not un-stamp it, because the row's content does not change.
 *
 * The key rides on the query string and nowhere else: never in the stored block,
 * never in an error message. That is why this uses `http.request` rather than
 * `http.json`, whose errors quote the URL.
 */

const BASE = 'https://api.themoviedb.org/3';
const POSTER = 'https://image.tmdb.org/t/p/w342';
const BACKDROP = 'https://image.tmdb.org/t/p/w780';

/** TMDB tolerates ~40 requests per 10 s; 100 ms apart is well inside it. */
export const MIN_GAP_MS = 100;

const IMDB_ID = /^tt\d{5,10}$/;
const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s ?? ''));

/** The IMDb id an item carries, or null. */
export function imdbIdOf(item) {
  const id = String(item?.data?.imdbId ?? '').trim();
  return IMDB_ID.test(id) ? id : null;
}

/**
 * Which titles are worth a request: an IMDb row (they never have artwork), or
 * any other title that has an IMDb id, no picture, and no TMDB id already (a
 * TMDB row without a poster has already been asked; `find` would say the same).
 *
 * Reads both the database row (`image_url`) and the adapter shape (`imageUrl`)
 * so the rule is the same whichever a caller holds.
 */
export function appliesTo(item) {
  if (item?.kind !== 'title' || !imdbIdOf(item)) return false;
  if (item.data?.provider === 'imdb') return true;
  const image = item.image_url ?? item.imageUrl ?? null;
  return !image && !item.data?.tmdbId;
}

/**
 * The stored block, from a `find` response. Pure, so the mapping is testable
 * without a network.
 *
 * Films first, then television: IMDb files both and this collection keeps them
 * in different categories, but for "put a poster on it" either answer is right.
 * Taking `movie_results` first only decides which wins for the rare id in both.
 *
 * `imageUrl` and `summary` are what the core backfills onto the item where it
 * had none; everything else stays under `enrichment['tmdb-artwork']`.
 */
export function artworkOf(res) {
  const movie = res?.movie_results?.[0];
  const m = movie?.id ? movie : res?.tv_results?.[0];
  if (!m?.id) return { tmdbId: null };
  const isMovie = m === movie;
  const votes = Number(m.vote_count ?? 0);
  const date = isMovie ? m.release_date : m.first_air_date;
  const id = String(m.id);
  return {
    tmdbId: id,
    category: isMovie ? 'film' : 'tv',
    form: isMovie ? 'movie' : 'series',
    url: `https://www.themoviedb.org/${isMovie ? 'movie' : 'tv'}/${id}`,
    imageUrl: m.poster_path ? `${POSTER}${m.poster_path}` : null,
    backdropUrl: m.backdrop_path ? `${BACKDROP}${m.backdrop_path}` : null,
    summary: typeof m.overview === 'string' && m.overview.trim() ? m.overview.trim() : null,
    popularity: Number.isFinite(Number(m.popularity)) && m.popularity ? Number(m.popularity) : null,
    rating: votes > 0 && Number.isFinite(Number(m.vote_average)) ? Number(m.vote_average) : null,
    ratingCount: votes || null,
    // Ids only: `find` carries no genre table, and the item already has IMDb's names.
    genreIds: Array.isArray(m.genre_ids) ? m.genre_ids.filter(Number.isFinite) : [],
    // A real day where TMDB has one; the IMDb row only knows the year.
    releaseDate: isYmd(date) ? date : null,
  };
}

export const tmdbArtwork = defineEnricher({
  name: 'tmdb-artwork',
  title: 'TMDB artwork',
  description:
    'The poster, synopsis and TMDB id for a title that only IMDb listed, looked up by its IMDb id. Needs TMDB_API_KEY.',
  collections: ['screen'],
  needsEnv: ['tmdbApiKey'],
  appliesTo,
  perRun: 30,
  async enrich(item, { env, http }) {
    const key = env.tmdbApiKey;
    if (!key) throw new Error('tmdb-artwork needs TMDB_API_KEY');
    const imdbId = imdbIdOf(item);
    if (!imdbId) return null;
    const qs = new URLSearchParams({ external_source: 'imdb_id', api_key: key });
    const res = await http.request(`${BASE}/find/${encodeURIComponent(imdbId)}?${qs}`, {
      timeoutMs: 20_000,
    });
    // `http.request` has already waited once on a 429; a second one means TMDB
    // wants this enricher to stop for the tick, which the message tells the core.
    if (res.status === 429) throw new Error('tmdb rate limited (429)');
    if (res.status === 404) return { tmdbId: null };
    if (!res.ok) throw new Error(`tmdb answered ${res.status} for find/${imdbId}`);
    const body = await res.json();
    await Bun.sleep(MIN_GAP_MS);
    return artworkOf(body);
  },
});
