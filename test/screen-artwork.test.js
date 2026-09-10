import { describe, expect, test } from 'bun:test';

import { titleItem as imdbTitle } from '../packages/adapters/src/imdb.js';
import { titleItem as tmdbTitle } from '../packages/adapters/src/tmdb.js';
import {
  appliesTo,
  artworkOf,
  imdbIdOf,
  tmdbArtwork,
} from '../packages/enrichers/src/tmdb-artwork.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** An IMDb-only title, the way `imdb-ratings` emits it (no image, no synopsis). */
const IMDB_ROW = imdbTitle({
  tconst: 'tt10300398',
  title: 'The Snowman',
  originalTitle: 'The Snowman',
  titleType: 'movie',
  year: 2027,
  endYear: null,
  category: 'film',
  form: 'movie',
  runtimeMin: null,
  rating: null,
  ratingCount: null,
  genres: ['Drama'],
});

/** The same item as the enrichment worker sees it: a database row, snake_case. */
const asRow = (item, over = {}) => ({
  id: 1,
  kind: item.kind,
  title: item.title,
  summary: item.summary,
  url: item.url,
  image_url: item.imageUrl,
  data: item.data,
  collection_slug: 'screen',
  ...over,
});

const MOVIE_HIT = {
  movie_results: [
    {
      id: 1084242,
      title: 'Toy Story 5',
      overview: '  Woody and Buzz meet a tablet.  ',
      poster_path: '/poster.jpg',
      backdrop_path: '/backdrop.jpg',
      genre_ids: [16, 10751],
      vote_average: 7.4,
      vote_count: 120,
      popularity: 250.5,
      release_date: '2026-06-19',
    },
  ],
  tv_results: [],
  person_results: [],
};

const TV_HIT = {
  movie_results: [],
  tv_results: [
    {
      id: 95396,
      name: 'Severance',
      overview: 'Work and life, surgically divided.',
      poster_path: '/sev.jpg',
      backdrop_path: null,
      genre_ids: [18, 9648],
      vote_average: 8.3,
      vote_count: 2400,
      popularity: 900,
      first_air_date: '2022-02-18',
    },
  ],
};

const MISS = { movie_results: [], tv_results: [], person_results: [], tv_episode_results: [] };

/**
 * A TMDB that records the URLs it was asked and answers from a table keyed by
 * IMDb id, or with a status when told to.
 */
function fakeTmdb({ answers = {}, status = {} } = {}) {
  const urls = [];
  const http = {
    request: async (url) => {
      urls.push(url);
      const u = new URL(url);
      const imdbId = u.pathname.split('/').pop();
      const code = status[imdbId] ?? 200;
      const body = answers[imdbId] ?? MISS;
      return { status: code, ok: code < 400, json: async () => body };
    },
    json: async () => {
      throw new Error('http.json must not be used: its errors quote the URL and the key');
    },
  };
  return { http, urls };
}

const ctx = (http, env = { tmdbApiKey: 'SECRET-KEY' }) => ({ http, env, log: () => {} });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('tmdb-artwork registration', () => {
  test('is named, scoped and keyed as the consolidation contract says', () => {
    expect(tmdbArtwork).toMatchObject({
      name: 'tmdb-artwork',
      collections: ['screen'],
      needsEnv: ['tmdbApiKey'],
      perRun: 30,
    });
    expect(typeof tmdbArtwork.enrich).toBe('function');
    expect(tmdbArtwork.appliesTo).toBe(appliesTo);
  });
});

describe('tmdb-artwork appliesTo', () => {
  test('an IMDb row is asked, as an adapter item or as a database row', () => {
    expect(IMDB_ROW.imageUrl).toBeNull();
    expect(appliesTo(IMDB_ROW)).toBe(true);
    expect(appliesTo(asRow(IMDB_ROW))).toBe(true);
  });

  test('a TMDB title with a poster is not asked, and one already answered by TMDB is not either', () => {
    const withPoster = tmdbTitle({
      id: 1084242,
      title: 'Toy Story 5',
      release_date: '2026-06-19',
      poster_path: '/poster.jpg',
    });
    withPoster.data.imdbId = 'tt3437518';
    expect(appliesTo(withPoster)).toBe(false);
    expect(appliesTo(asRow(withPoster))).toBe(false);

    // No poster but a TMDB id: `find` would say the same thing, so no request.
    const noPoster = tmdbTitle({ id: 1084242, title: 'Toy Story 5', release_date: '2026-06-19' });
    noPoster.data.imdbId = 'tt3437518';
    expect(noPoster.imageUrl).toBeNull();
    expect(appliesTo(noPoster)).toBe(false);
  });

  test('any other title with an IMDb id and no picture is asked', () => {
    const tvmazeLike = {
      kind: 'title',
      title: 'Some Show',
      imageUrl: null,
      data: { provider: 'tvmaze', imdbId: 'tt0903747', tmdbId: null, tvmazeId: '1' },
    };
    expect(appliesTo(tvmazeLike)).toBe(true);
    expect(appliesTo({ ...tvmazeLike, imageUrl: 'https://x/y.jpg' })).toBe(false);
    expect(appliesTo(asRow(tvmazeLike, { image_url: 'https://x/y.jpg' }))).toBe(false);
  });

  test('releases, titles without an IMDb id, and junk are never asked', () => {
    expect(appliesTo({ ...IMDB_ROW, kind: 'release' })).toBe(false);
    expect(appliesTo({ ...IMDB_ROW, data: { ...IMDB_ROW.data, imdbId: null } })).toBe(false);
    expect(appliesTo({ ...IMDB_ROW, data: { ...IMDB_ROW.data, imdbId: 'nm0000001' } })).toBe(false);
    expect(appliesTo({ ...IMDB_ROW, data: {} })).toBe(false);
    expect(appliesTo(null)).toBe(false);
    expect(appliesTo({})).toBe(false);
  });

  test('imdbIdOf accepts only a tconst', () => {
    expect(imdbIdOf(IMDB_ROW)).toBe('tt10300398');
    expect(imdbIdOf({ data: { imdbId: ' tt0111161 ' } })).toBe('tt0111161');
    expect(imdbIdOf({ data: { imdbId: 'tt1' } })).toBeNull();
    expect(imdbIdOf({ data: { imdbId: '0111161' } })).toBeNull();
    expect(imdbIdOf({ data: { imdbId: 'tt0111161/../x' } })).toBeNull();
  });
});

describe('tmdb-artwork mapping', () => {
  test('a film result becomes poster, backdrop, synopsis and the numbers', () => {
    expect(artworkOf(MOVIE_HIT)).toEqual({
      tmdbId: '1084242',
      category: 'film',
      form: 'movie',
      url: 'https://www.themoviedb.org/movie/1084242',
      imageUrl: 'https://image.tmdb.org/t/p/w342/poster.jpg',
      backdropUrl: 'https://image.tmdb.org/t/p/w780/backdrop.jpg',
      summary: 'Woody and Buzz meet a tablet.',
      popularity: 250.5,
      rating: 7.4,
      ratingCount: 120,
      genreIds: [16, 10751],
      releaseDate: '2026-06-19',
    });
  });

  test('a television result is filed as tv with its first air date and no backdrop', () => {
    expect(artworkOf(TV_HIT)).toEqual({
      tmdbId: '95396',
      category: 'tv',
      form: 'series',
      url: 'https://www.themoviedb.org/tv/95396',
      imageUrl: 'https://image.tmdb.org/t/p/w342/sev.jpg',
      backdropUrl: null,
      summary: 'Work and life, surgically divided.',
      popularity: 900,
      rating: 8.3,
      ratingCount: 2400,
      genreIds: [18, 9648],
      releaseDate: '2022-02-18',
    });
  });

  test('a film wins over a show for the rare id that is both', () => {
    expect(artworkOf({ ...MOVIE_HIT, tv_results: TV_HIT.tv_results }).tmdbId).toBe('1084242');
  });

  test('not found is a stored answer, not nothing', () => {
    expect(artworkOf(MISS)).toEqual({ tmdbId: null });
    expect(artworkOf(null)).toEqual({ tmdbId: null });
    expect(artworkOf({ movie_results: [{ title: 'no id' }] })).toEqual({ tmdbId: null });
  });

  test('a hit with no poster, no synopsis and no votes carries nulls, not empty strings', () => {
    const thin = artworkOf({
      movie_results: [{ id: 7, title: 'Obscure', overview: '', vote_count: 0, vote_average: 0 }],
    });
    expect(thin).toMatchObject({
      tmdbId: '7',
      imageUrl: null,
      backdropUrl: null,
      summary: null,
      popularity: null,
      rating: null,
      ratingCount: null,
      genreIds: [],
      releaseDate: null,
    });
  });
});

describe('tmdb-artwork enrich', () => {
  test('asks find by IMDb id with the key on the query, and the key is nowhere in the answer', async () => {
    const { http, urls } = fakeTmdb({ answers: { tt10300398: MOVIE_HIT } });
    const out = await tmdbArtwork.enrich(asRow(IMDB_ROW), ctx(http));

    expect(urls).toHaveLength(1);
    const u = new URL(urls[0]);
    expect(u.origin + u.pathname).toBe('https://api.themoviedb.org/3/find/tt10300398');
    expect(u.searchParams.get('external_source')).toBe('imdb_id');
    expect(u.searchParams.get('api_key')).toBe('SECRET-KEY');

    expect(out.tmdbId).toBe('1084242');
    expect(out.imageUrl).toBe('https://image.tmdb.org/t/p/w342/poster.jpg');
    expect(out.summary).toBe('Woody and Buzz meet a tablet.');
    expect(JSON.stringify(out)).not.toContain('SECRET');
    expect(JSON.stringify(out)).not.toContain('api_key');
  });

  test('a miss is stored as a null id so the title is not asked again', async () => {
    const { http } = fakeTmdb();
    expect(await tmdbArtwork.enrich(asRow(IMDB_ROW), ctx(http))).toEqual({ tmdbId: null });

    const { http: gone } = fakeTmdb({ status: { tt10300398: 404 } });
    expect(await tmdbArtwork.enrich(asRow(IMDB_ROW), ctx(gone))).toEqual({ tmdbId: null });
  });

  test('a 429 throws the message the core throttles on, without the key', async () => {
    const { http } = fakeTmdb({ status: { tt10300398: 429 } });
    let err;
    try {
      await tmdbArtwork.enrich(asRow(IMDB_ROW), ctx(http));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/429|rate limit/i);
    expect(err.message).not.toContain('SECRET');
  });

  test('any other failure throws without quoting the key, so the item is retried', async () => {
    const { http } = fakeTmdb({ status: { tt10300398: 500 } });
    await expect(tmdbArtwork.enrich(asRow(IMDB_ROW), ctx(http))).rejects.toThrow(
      /tmdb answered 500/,
    );
    try {
      await tmdbArtwork.enrich(asRow(IMDB_ROW), ctx(http));
    } catch (e) {
      expect(e.message).not.toContain('SECRET');
    }
  });

  test('refuses to run without a key and makes no request', async () => {
    const { http, urls } = fakeTmdb();
    await expect(tmdbArtwork.enrich(asRow(IMDB_ROW), ctx(http, {}))).rejects.toThrow(
      'TMDB_API_KEY',
    );
    expect(urls).toHaveLength(0);
  });
});
