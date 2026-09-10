import { describe, expect, test } from 'bun:test';

import {
  anilistAiring,
  buildItems as anilistBuild,
  releaseItem as anilistRelease,
  titleItem as anilistTitle,
  startOf,
} from '../packages/adapters/src/anilist.js';
import {
  candidateFrom,
  gunzipLines,
  imdbRatings,
  titleItem as imdbTitle,
  intOf,
  loadRatings,
  packRating,
  parseTsvLine,
  readBasics,
  unpackRating,
} from '../packages/adapters/src/imdb.js';
import {
  normaliseTitle,
  normTitleOrNull,
  titleKey,
} from '../packages/adapters/src/screen-titles.js';
import {
  detailOf,
  homeReleases,
  MAX_PROVIDERS,
  namesAService,
  readCursor,
  releaseItems,
  rentOrBuyServices,
  tmdbReleases,
  titleItem as tmdbTitle,
  trimSeen,
  watchProviders,
} from '../packages/adapters/src/tmdb.js';
import {
  classify,
  kindOf,
  buildItems as tvmazeBuild,
  releaseItem as tvmazeRelease,
  tvmazeSchedule,
  titleItem as tvmazeTitle,
  venueOf,
} from '../packages/adapters/src/tvmaze.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

const noon = (ymd) => new Date(`${ymd}T12:00:00.000Z`);

// ---------------------------------------------------------------------------
// Title normalisation
// ---------------------------------------------------------------------------

describe('screen-titles', () => {
  test('two vendors spelling of one film meet on the same words', () => {
    expect(normaliseTitle('Dune: Part Three (2026) [4K]')).toBe('dune part three');
    expect(normaliseTitle('DUNE PART THREE UHD')).toBe('dune part three');
  });

  test('accents fold and punctuation goes, but word order stays', () => {
    expect(normaliseTitle('Amélie')).toBe('amelie');
    expect(normaliseTitle('WALL·E')).toBe('wall e');
    expect(normaliseTitle("Frieren: Beyond Journey's End")).toBe('frieren beyond journey s end');
    expect(normaliseTitle('Léon: The Professional')).toBe('leon the professional');
    expect(normaliseTitle('Straße 2')).toBe('strasse 2');
  });

  test('quality tags are stripped wherever they fall', () => {
    expect(normaliseTitle('Oppenheimer HD HEVC')).toBe('oppenheimer');
    expect(normaliseTitle('Heat 1995 Multi Sub')).toBe('heat 1995');
  });

  test('a title with no Latin characters normalises to nothing, stored as null', () => {
    expect(normaliseTitle('進撃の巨人')).toBe('');
    expect(normTitleOrNull('進撃の巨人')).toBeNull();
    expect(normTitleOrNull('')).toBeNull();
    expect(normTitleOrNull(null)).toBeNull();
  });

  test('titleKey carries category, words and year, and tolerates gaps', () => {
    expect(titleKey({ normTitle: 'the matrix', year: 1999, category: 'film' })).toBe(
      'film the matrix 1999',
    );
    expect(titleKey({ normTitle: 'the matrix', year: null })).toBe('the matrix');
    expect(titleKey({ normTitle: 'the matrix', year: 1999 })).toBe('the matrix 1999');
    expect(titleKey({})).toBe('');
  });
});

// ---------------------------------------------------------------------------
// TMDB
// ---------------------------------------------------------------------------

const GENRES = new Map([
  [16, 'Animation'],
  [10751, 'Family'],
  [10770, 'TV Movie'],
  [878, 'Science Fiction'],
]);

const DISCOVER = {
  id: 1084242,
  title: 'Toy Story 5',
  original_title: 'Toy Story 5',
  release_date: '2026-06-19',
  overview: 'Woody and Buzz meet a tablet.',
  poster_path: '/poster.jpg',
  backdrop_path: '/backdrop.jpg',
  genre_ids: [16, 10751, 10770],
  vote_average: 7.4,
  vote_count: 120,
  popularity: 250.5,
};

const RELEASE_DATES = {
  results: [
    {
      iso_3166_1: 'GB',
      release_dates: [{ type: 4, release_date: '2026-10-01T00:00:00.000Z', note: 'Sky' }],
    },
    {
      iso_3166_1: 'US',
      release_dates: [
        { type: 3, release_date: '2026-06-19T00:00:00.000Z', note: '' },
        { type: 4, release_date: '2026-09-23T00:00:00.000Z', note: 'Disney+' },
        { type: 4, release_date: '2026-08-18T00:00:00.000Z', note: '' },
        { type: 5, release_date: '2026-09-01T00:00:00.000Z', note: 'Blu-ray' },
      ],
    },
  ],
};

const DETAIL = {
  ...DISCOVER,
  genre_ids: undefined,
  genres: [
    { id: 16, name: 'Animation' },
    { id: 10751, name: 'Family' },
  ],
  imdb_id: 'tt3437518',
  runtime: 98,
  tagline: ' To infinity, again. ',
  spoken_languages: [{ english_name: 'English' }],
  production_companies: [{ name: 'Pixar' }, { name: 'Disney' }, { name: 'A' }, { name: 'B' }],
  credits: {
    cast: Array.from({ length: 10 }, (_, i) => ({ name: `Actor ${i}` })),
    crew: [
      { job: 'Producer', name: 'Someone' },
      { job: 'Director', name: 'Andrew Stanton' },
    ],
  },
  videos: {
    results: [
      { type: 'Teaser', site: 'YouTube', key: 'teaser', official: true },
      { type: 'Trailer', site: 'YouTube', key: 'fan', official: false },
      { type: 'Trailer', site: 'YouTube', key: 'official', official: true },
    ],
  },
  'watch/providers': {
    results: {
      US: {
        flatrate: Array.from({ length: 8 }, (_, i) => ({ provider_name: `Service ${i}` })),
        rent: [
          { provider_name: 'Apple TV' },
          { provider_name: 'Amazon Video' },
          ...Array.from({ length: 8 }, (_, i) => ({ provider_name: `Shop ${i}` })),
        ],
        buy: [{ provider_name: 'Apple TV' }, { provider_name: 'Google Play Movies' }],
      },
      GB: { flatrate: [{ provider_name: 'Sky Go' }], buy: [{ provider_name: 'Sky Store' }] },
    },
  },
  release_dates: RELEASE_DATES,
};

describe('tmdb home releases', () => {
  test('separates rent-or-buy from the subscription service, earliest first', () => {
    expect(homeReleases(RELEASE_DATES)).toEqual({
      vod: '2026-08-18',
      streaming: { date: '2026-09-23', service: 'Disney+' },
    });
  });

  test('quotes the region it is asked for and nothing for one it has not got', () => {
    expect(homeReleases(RELEASE_DATES, { region: 'GB' })).toEqual({
      vod: null,
      streaming: { date: '2026-10-01', service: 'Sky' },
    });
    expect(homeReleases(RELEASE_DATES, { region: 'FR' })).toEqual({ vod: null, streaming: null });
    expect(homeReleases(null)).toEqual({ vod: null, streaming: null });
  });

  test('a note that is a window, a cut or a shop is not a service', () => {
    expect(namesAService('Disney+')).toBe(true);
    expect(namesAService('Apple TV, YouTube & Prime Video')).toBe(true);
    expect(namesAService('Digital HD')).toBe(false);
    expect(namesAService('PVOD Rent/Buy')).toBe(false);
    expect(namesAService('Subtitled Version')).toBe(false);
    expect(namesAService('Letterboxd Video Store - Unreleased Gems (30 days)')).toBe(false);
    expect(namesAService('Netflix / Rockstar Games official YouTube channel')).toBe(false);
    expect(namesAService('')).toBe(false);
  });
});

describe('tmdb watch providers', () => {
  test('subscription, rent and buy come apart, named, in TMDB order, capped at eight', () => {
    const p = watchProviders(DETAIL['watch/providers']);
    expect(p.stream).toHaveLength(8);
    expect(p.stream[0]).toBe('Service 0');
    expect(p.rent).toHaveLength(MAX_PROVIDERS);
    expect(p.rent.slice(0, 2)).toEqual(['Apple TV', 'Amazon Video']);
    expect(p.rent).not.toContain('Shop 7');
    expect(p.buy).toEqual(['Apple TV', 'Google Play Movies']);
  });

  test('quotes the region it is asked for; a missing region or payload is three empty lists', () => {
    expect(watchProviders(DETAIL['watch/providers'], { region: 'GB' })).toEqual({
      stream: ['Sky Go'],
      rent: [],
      buy: ['Sky Store'],
    });
    const empty = { stream: [], rent: [], buy: [] };
    expect(watchProviders(DETAIL['watch/providers'], { region: 'FR' })).toEqual(empty);
    expect(watchProviders(null)).toEqual(empty);
    expect(watchProviders({ results: { US: { flatrate: 'nope', rent: [{}] } } })).toEqual(empty);
  });

  test('rent and buy fold into one list with each shop once', () => {
    expect(rentOrBuyServices(watchProviders(DETAIL['watch/providers']))).toEqual([
      'Apple TV',
      'Amazon Video',
      ...Array.from({ length: 6 }, (_, i) => `Shop ${i}`),
      'Google Play Movies',
    ]);
    expect(rentOrBuyServices(null)).toEqual([]);
  });

  test('watch stays the six flat-rate names while providers carries all three lists', () => {
    const d = detailOf(DETAIL);
    expect(d.watch).toEqual(Array.from({ length: 6 }, (_, i) => `Service ${i}`));
    expect(d.providers.stream).toHaveLength(8);
    expect(d.providers.stream.slice(0, 6)).toEqual(d.watch);
    expect(d.providers.rent[0]).toBe('Apple TV');
    expect(d.providers.buy).toEqual(['Apple TV', 'Google Play Movies']);

    const t = tmdbTitle(DETAIL, { detail: d });
    expect(t.data.watch).toEqual(d.watch);
    expect(t.data.providers).toEqual(d.providers);
    expect(t.data.watchRegion).toBe('US');

    const gb = tmdbTitle(DETAIL, { detail: detailOf(DETAIL, { region: 'GB' }), region: 'GB' });
    expect(gb.data.watch).toEqual(['Sky Go']);
    expect(gb.data.providers).toEqual({ stream: ['Sky Go'], rent: [], buy: ['Sky Store'] });
    expect(gb.data.watchRegion).toBe('GB');
  });

  test('an undetailed title carries empty lists, one object per title', () => {
    const a = tmdbTitle(DISCOVER, { genreById: GENRES });
    const b = tmdbTitle(DISCOVER, { genreById: GENRES });
    expect(a.data.providers).toEqual({ stream: [], rent: [], buy: [] });
    expect(a.data.providers).not.toBe(b.data.providers);
    expect(a.data.watch).toEqual([]);
  });
});

describe('tmdb items', () => {
  test('a discover row becomes a thin title with genres resolved and TV Movie dropped', () => {
    const t = tmdbTitle(DISCOVER, { genreById: GENRES });
    expect(t.externalId).toBe('tmdb:title:1084242');
    expect(t.kind).toBe('title');
    expect(t.url).toBe('https://www.themoviedb.org/movie/1084242');
    expect(t.imageUrl).toBe('https://image.tmdb.org/t/p/w342/poster.jpg');
    expect(t.publishedAt).toEqual(noon('2026-06-19'));
    expect(t.timeKnown).toBe(false);
    expect(t.precision).toBe('day');
    expect(t.tags).toEqual(['title', 'film', 'tmdb', 'genre:animation', 'genre:family']);
    expect(t.data.form).toBe('movie');
    expect(t.data.year).toBe(2026);
    expect(t.data.normTitle).toBe('toy story 5');
    expect(t.data.tmdbId).toBe('1084242');
    expect(t.data.imdbId).toBeNull();
    expect(t.data.rating).toBe(7.4);
    expect(t.data.ratingCount).toBe(120);
    expect(t.data.popularity).toBe(250.5);
    expect(t.data.backdropUrl).toBe('https://image.tmdb.org/t/p/w780/backdrop.jpg');
    expect(t.data.detailed).toBe(false);
    expect(t.data.watch).toEqual([]);
  });

  test('detail adds the IMDb id, an official trailer, six providers and the home dates', () => {
    const d = detailOf(DETAIL);
    expect(d.imdbId).toBe('tt3437518');
    expect(d.runtimeMin).toBe(98);
    expect(d.tagline).toBe('To infinity, again.');
    expect(d.trailerUrl).toBe('https://www.youtube.com/watch?v=official');
    expect(d.watch).toHaveLength(6);
    expect(d.cast).toHaveLength(8);
    expect(d.director).toBe('Andrew Stanton');
    expect(d.studios).toEqual(['Pixar', 'Disney', 'A']);
    expect(d.language).toBe('English');
    expect(d.home.vod).toBe('2026-08-18');

    const t = tmdbTitle(DETAIL, { detail: d });
    expect(t.tags).toEqual(['title', 'film', 'tmdb', 'genre:animation', 'genre:family']);
    expect(t.data.imdbId).toBe('tt3437518');
    expect(t.data.trailerUrl).toBe('https://www.youtube.com/watch?v=official');
    expect(t.data.runtimeMin).toBe(98);
    expect(t.data.digitalDate).toBe('2026-08-18');
    expect(t.data.streaming).toEqual({ date: '2026-09-23', service: 'Disney+' });
    expect(t.data.detailed).toBe(true);
  });

  test('a film with no rating yet carries null rather than zero', () => {
    const t = tmdbTitle({ ...DISCOVER, vote_count: 0, vote_average: 0 }, { genreById: GENRES });
    expect(t.data.rating).toBeNull();
    expect(t.data.ratingCount).toBeNull();
  });

  test('the three release kinds are keyed apart and typed', () => {
    const rows = releaseItems(DETAIL, { detail: detailOf(DETAIL) });
    expect(rows.map((r) => r.externalId)).toEqual([
      'tmdb:release:1084242',
      'tmdb:digital:1084242',
      'tmdb:stream:1084242:disney',
    ]);
    const [theatrical, digital, stream] = rows;
    expect(theatrical.tags).toContain('type:theatrical');
    expect(theatrical.publishedAt).toEqual(noon('2026-06-19'));
    expect(theatrical.data.venue).toBe('Cinemas');
    expect(theatrical.data.titleExternalId).toBe('tmdb:title:1084242');
    expect(theatrical.data.runtimeMin).toBe(98);
    expect(theatrical.imageUrl).toBe('https://image.tmdb.org/t/p/w780/backdrop.jpg');

    expect(digital.tags).toContain('type:digital');
    expect(digital.publishedAt).toEqual(noon('2026-08-18'));
    expect(digital.data.venue).toBe('Rent or buy');
    expect(digital.data.venueRegion).toBe('US');
    // The shops that rent or sell it ride on the rent-or-buy row, each once.
    expect(digital.data.services.slice(0, 2)).toEqual(['Apple TV', 'Amazon Video']);
    expect(digital.data.services).toContain('Google Play Movies');
    expect(new Set(digital.data.services).size).toBe(digital.data.services.length);

    expect(stream.tags).toContain('type:stream');
    expect(stream.publishedAt).toEqual(noon('2026-09-23'));
    expect(stream.data.venue).toBe('Disney+');
    expect(stream.data.services).toEqual(['Disney+']);
    expect(theatrical.data.services).toEqual([]);
    for (const r of rows) {
      expect(r.kind).toBe('release');
      expect(r.timeKnown).toBe(false);
      expect(r.precision).toBe('day');
      expect(r.tags.slice(0, 3)).toEqual(['release', 'film', 'tmdb']);
      expect(r.data.season).toBeNull();
      expect(r.data.number).toBeNull();
    }
  });

  test('without detail only the theatrical row exists, and no date means no row', () => {
    expect(releaseItems(DISCOVER, { genreById: GENRES }).map((r) => r.externalId)).toEqual([
      'tmdb:release:1084242',
    ]);
    expect(releaseItems({ ...DISCOVER, release_date: '' })).toEqual([]);
  });

  test('a shop carrying the film is not a date: no type-4 entry, no digital row', () => {
    // Rent and buy providers, but the only home date names a service.
    const noVod = {
      ...DETAIL,
      release_dates: {
        results: [
          {
            iso_3166_1: 'US',
            release_dates: [
              { type: 3, release_date: '2026-06-19T00:00:00.000Z', note: '' },
              { type: 4, release_date: '2026-09-23T00:00:00.000Z', note: 'Disney+' },
            ],
          },
        ],
      },
    };
    const d = detailOf(noVod);
    expect(d.providers.rent.length).toBeGreaterThan(0);
    expect(releaseItems(noVod, { detail: d }).map((r) => r.externalId)).toEqual([
      'tmdb:release:1084242',
      'tmdb:stream:1084242:disney',
    ]);

    // The other way round: a plain digital date with no shop listed yet still
    // is a release, with nothing to name.
    const noShops = { ...DETAIL, 'watch/providers': { results: {} } };
    const rows = releaseItems(noShops, { detail: detailOf(noShops) });
    const digital = rows.find((r) => r.externalId === 'tmdb:digital:1084242');
    expect(digital.data.venue).toBe('Rent or buy');
    expect(digital.data.services).toEqual([]);
  });

  test('items survive normalisation with their tags intact', () => {
    for (const raw of [tmdbTitle(DETAIL, { detail: detailOf(DETAIL) }), ...releaseItems(DETAIL)]) {
      const n = normaliseItem(raw);
      expect(n).not.toBeNull();
      expect(n.tags).toEqual(raw.tags);
      expect(n.title.length).toBeLessThanOrEqual(500);
    }
  });

  test('cursor reading tolerates whatever an older run left, and trimming spares the queue', () => {
    expect(readCursor({})).toEqual({ seen: {}, queue: [], backPage: 1 });
    expect(readCursor({ seen: null, queue: 'x', backPage: '7' })).toEqual({
      seen: {},
      queue: [],
      backPage: 7,
    });
    const seen = { a: 0, b: 5, c: 9, d: 1 };
    trimSeen(seen, 2);
    expect(Object.keys(seen).sort()).toEqual(['a', 'c']);
  });
});

/**
 * A fake TMDB. Forward discover has one page of two films; the back catalogue has
 * two pages of one film each; detail answers for everything but 404s one id.
 */
function fakeTmdb({ detail404 = new Set() } = {}) {
  const urls = [];
  const film = (id, title, date, extra = {}) => ({
    ...DISCOVER,
    id,
    title,
    release_date: date,
    ...extra,
  });
  const forward = [film(1, 'Forward One', '2026-10-01'), film(2, 'Forward Two', '2026-11-01')];
  const back = { 1: [film(11, 'Back One', '1999-03-31')], 2: [film(12, 'Back Two', '1977-05-25')] };
  const http = {
    request: async (url) => {
      urls.push(url);
      const u = new URL(url);
      const p = u.searchParams;
      let body = null;
      let status = 200;
      if (u.pathname.endsWith('/genre/movie/list')) {
        body = { genres: [...GENRES].map(([id, name]) => ({ id, name })) };
      } else if (u.pathname.endsWith('/discover/movie')) {
        const page = Number(p.get('page'));
        if (
          p.get('primary_release_date.lte') < '2026-12-31' &&
          p.get('primary_release_date.gte') === '1970-01-01'
        ) {
          body = { page, total_pages: 2, results: back[page] ?? [] };
        } else {
          body = { page, total_pages: 1, results: forward };
        }
      } else {
        const id = Number(u.pathname.split('/').pop());
        if (detail404.has(id)) status = 404;
        else {
          const m = [...forward, ...back[1], ...back[2]].find((f) => f.id === id);
          body = { ...DETAIL, ...m, genre_ids: undefined };
        }
      }
      return { status, ok: status < 400, json: async () => body };
    },
  };
  return { http, urls };
}

const tmdbCtx = (over = {}) => ({
  config: {
    ...tmdbReleases.defaults,
    forwardPages: 1,
    backCataloguePages: 2,
    backPagesPerRun: 1,
    gapMs: 0,
  },
  cursor: {},
  env: { tmdbApiKey: 'SECRET-KEY' },
  log: () => {},
  budget: 1,
  deadline: Date.now() + 60_000,
  ...over,
});

describe('tmdb pull', () => {
  test('refuses to run without a key', async () => {
    const { http } = fakeTmdb();
    await expect(tmdbReleases.pull(tmdbCtx({ env: {}, http }))).rejects.toThrow('TMDB_API_KEY');
  });

  test('walks the back catalogue a page per run, details inside the budget, and asks to come back', async () => {
    const { http, urls } = fakeTmdb();
    const r1 = await tmdbReleases.pull(tmdbCtx({ http }));
    // Forward films first: both thin titles with a theatrical row each, one
    // back-catalogue film, and one detail call spent on the first forward film.
    const ids = r1.items.map((i) => i.externalId);
    expect(ids).toContain('tmdb:title:1');
    expect(ids).toContain('tmdb:release:1');
    expect(ids).toContain('tmdb:title:2');
    expect(ids).toContain('tmdb:title:11');
    expect(ids).not.toContain('tmdb:title:12');
    expect(ids).toContain('tmdb:digital:1');
    expect(ids).toContain('tmdb:stream:1:disney');
    expect(r1.cursor.backPage).toBe(2);
    expect(r1.cursor.seen['1']).toBeGreaterThan(0);
    expect(r1.cursor.seen['2']).toBe(0);
    expect(r1.cursor.queue).toEqual(['2', '11']);
    expect(r1.nextInMinutes).toBe(1);
    // The detailed title carries what the detail call found.
    const detailed = r1.items.filter((i) => i.externalId === 'tmdb:title:1');
    expect(detailed.at(-1).data.imdbId).toBe('tt3437518');
    // The key travels on the request and nowhere else.
    expect(urls.every((u) => u.includes('api_key=SECRET-KEY'))).toBe(true);
    expect(JSON.stringify(r1.items)).not.toContain('SECRET-KEY');
    expect(JSON.stringify(r1.cursor)).not.toContain('SECRET-KEY');

    const r2 = await tmdbReleases.pull(tmdbCtx({ http, cursor: r1.cursor }));
    const ids2 = r2.items.map((i) => i.externalId);
    // A detailed film is not re-emitted thin from the discover sweep.
    expect(ids2).not.toContain('tmdb:title:1');
    // Still-queued film 2 is re-emitted thin, then detailed in this run.
    expect(ids2.filter((i) => i === 'tmdb:title:2')).toHaveLength(2);
    expect(ids2).toContain('tmdb:title:12');
    expect(r2.cursor.backPage).toBe(3);
    expect(r2.cursor.queue).toEqual(['11', '12']);
    expect(r2.nextInMinutes).toBe(1);

    const r3 = await tmdbReleases.pull(tmdbCtx({ http, cursor: r2.cursor, budget: 10 }));
    expect(r3.cursor.queue).toEqual([]);
    expect(r3.cursor.backPage).toBe(3);
    expect(r3.nextInMinutes).toBeUndefined();
    const ids3 = r3.items.map((i) => i.externalId);
    expect(ids3).toContain('tmdb:title:11');
    expect(ids3).toContain('tmdb:title:12');
    expect(ids3).not.toContain('tmdb:title:1');
  });

  test('a 404 on detail is stamped so it is not re-asked every run', async () => {
    const { http } = fakeTmdb({ detail404: new Set([1]) });
    const r1 = await tmdbReleases.pull(
      tmdbCtx({ http, config: { ...tmdbCtx().config, backCataloguePages: 0 } }),
    );
    expect(r1.cursor.seen['1']).toBeGreaterThan(0);
    expect(r1.cursor.queue).toEqual(['2']);
    expect(r1.items.map((i) => i.externalId)).not.toContain('tmdb:digital:1');
  });

  test('stops at the deadline and keeps what it has not done for next time', async () => {
    const { http, urls } = fakeTmdb();
    const r = await tmdbReleases.pull(tmdbCtx({ http, deadline: Date.now() }));
    // Only the genre table was fetched.
    expect(urls).toHaveLength(1);
    expect(r.items).toEqual([]);
    expect(r.cursor.backPage).toBe(1);
    expect(r.nextInMinutes).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// TVmaze
// ---------------------------------------------------------------------------

const SHOW = {
  id: 44458,
  name: 'Severance',
  url: 'https://www.tvmaze.com/shows/44458/severance',
  genres: ['Drama', 'Thriller', 'Science-Fiction'],
  premiered: '2022-02-18',
  ended: null,
  status: 'Running',
  type: 'Scripted',
  language: 'English',
  averageRuntime: 55,
  weight: 99,
  officialSite: 'https://tv.apple.com/show/severance',
  rating: { average: 8.7 },
  network: null,
  webChannel: { name: 'Apple TV+', country: null },
  externals: { imdb: 'tt11280740', thetvdb: 371980 },
  image: { medium: 'https://img/m.jpg', original: 'https://img/o.jpg' },
  summary: '<p>Mark leads a team whose memories have been <b>surgically divided</b>.</p>',
  schedule: { time: '21:00', days: ['Thursday'] },
};

const EPISODE = {
  id: 3123001,
  url: 'https://www.tvmaze.com/episodes/3123001/severance-2x03',
  name: "Woe's Hollow",
  season: 2,
  number: 3,
  type: 'regular',
  airdate: '2026-09-15',
  airtime: '21:00',
  airstamp: '2026-09-16T01:00:00+00:00',
  runtime: 60,
  image: { medium: 'https://img/ep-m.jpg', original: 'https://img/ep-o.jpg' },
  summary: '<p>The team goes on a retreat.</p>',
  _embedded: { show: SHOW },
};

describe('tvmaze', () => {
  test('an episode becomes a release with season, number, venue and a real air time', () => {
    const r = tvmazeRelease(EPISODE);
    expect(r.externalId).toBe('tvmaze:episode:3123001');
    expect(r.kind).toBe('release');
    expect(r.title).toBe("Severance 2x03 — Woe's Hollow");
    expect(r.summary).toBe('The team goes on a retreat.');
    expect(r.publishedAt).toEqual(new Date('2026-09-16T01:00:00Z'));
    expect(r.timeKnown).toBe(true);
    expect(r.precision).toBe('minute');
    expect(r.imageUrl).toBe('https://img/ep-m.jpg');
    expect(r.tags).toEqual([
      'release',
      'tv',
      'tvmaze',
      'genre:drama',
      'genre:thriller',
      'genre:science-fiction',
      'type:episode',
    ]);
    expect(r.data).toMatchObject({
      provider: 'tvmaze',
      category: 'tv',
      type: 'episode',
      titleExternalId: 'tvmaze:title:44458',
      titleName: 'Severance',
      season: 2,
      number: 3,
      venue: 'Apple TV+',
      venueRegion: 'Streaming',
      runtimeMin: 60,
      episodeType: 'episode',
      backdropUrl: 'https://img/ep-o.jpg',
    });
  });

  test('an unknown slot is honest: day precision, time not known', () => {
    const r = tvmazeRelease({ ...EPISODE, airtime: '', airstamp: '2026-09-16T04:00:00+00:00' });
    expect(r.timeKnown).toBe(false);
    expect(r.precision).toBe('day');
    expect(tvmazeRelease({ ...EPISODE, airstamp: null })).toBeNull();
  });

  test('premieres are promoted and specials named', () => {
    expect(kindOf({ season: 1, number: 1 })).toBe('premiere');
    expect(kindOf({ season: 3, number: 1 })).toBe('season-premiere');
    expect(kindOf({ season: 3, number: 4 })).toBe('episode');
    expect(kindOf({ type: 'significant_special', number: 1, season: 1 })).toBe('special');
  });

  test('network beats web channel and carries its country', () => {
    expect(venueOf({ network: { name: 'ITV', country: { name: 'United Kingdom' } } })).toEqual({
      venue: 'ITV',
      venueRegion: 'United Kingdom',
    });
    expect(venueOf(SHOW)).toEqual({ venue: 'Apple TV+', venueRegion: 'Streaming' });
    expect(venueOf({})).toEqual({ venue: null, venueRegion: null });
  });

  test('anime is filed under anime, sports is dropped', () => {
    expect(classify({ genres: ['Anime', 'Action'] })).toEqual({
      category: 'anime',
      genres: ['Action'],
    });
    expect(classify({ genres: ['Sports', 'Drama'] })).toEqual({ category: null, genres: [] });
    const anime = tvmazeRelease({
      ...EPISODE,
      _embedded: { show: { ...SHOW, genres: ['Anime'] } },
    });
    expect(anime.tags).toContain('anime');
    expect(anime.tags).not.toContain('tv');
    expect(
      tvmazeRelease({ ...EPISODE, _embedded: { show: { ...SHOW, genres: ['Sports'] } } }),
    ).toBeNull();
  });

  test('a show becomes a series title with its ids and first air date', () => {
    const t = tvmazeTitle(SHOW);
    expect(t.externalId).toBe('tvmaze:title:44458');
    expect(t.title).toBe('Severance');
    expect(t.summary).toBe('Mark leads a team whose memories have been surgically divided.');
    expect(t.imageUrl).toBe('https://img/o.jpg');
    expect(t.publishedAt).toEqual(noon('2022-02-18'));
    expect(t.precision).toBe('day');
    expect(t.tags).toEqual([
      'title',
      'tv',
      'tvmaze',
      'genre:drama',
      'genre:thriller',
      'genre:science-fiction',
    ]);
    expect(t.data).toMatchObject({
      form: 'series',
      year: 2022,
      normTitle: 'severance',
      imdbId: 'tt11280740',
      tvmazeId: '44458',
      thetvdbId: '371980',
      rating: 8.7,
      popularity: 99,
      runtimeMin: 55,
      watch: ['Apple TV+'],
      language: 'English',
      status: 'Running',
    });
    expect(tvmazeTitle({ ...SHOW, premiered: null }).publishedAt).toBeNull();
  });

  test('buildItems bounds the window at both ends and lists each show once', () => {
    const from = new Date('2026-09-10T00:00:00Z');
    const at = (iso, id) => ({ ...EPISODE, id, airstamp: iso });
    const rows = [
      at('2026-09-08T01:00:00Z', 1), // two days ago: an archive, dropped
      at('2026-09-09T20:00:00Z', 2), // yesterday evening: inside the day of grace
      at('2026-09-16T01:00:00Z', 3),
      at('2027-02-01T01:00:00Z', 4), // beyond the horizon
      { ...EPISODE, id: 5, _embedded: { show: { ...SHOW, id: 9, name: 'Other' } } },
    ];
    const { titles, releases } = tvmazeBuild(rows, { from, horizonDays: 120 });
    expect(releases.map((r) => r.externalId)).toEqual([
      'tvmaze:episode:2',
      'tvmaze:episode:3',
      'tvmaze:episode:5',
    ]);
    expect(titles.map((t) => t.externalId)).toEqual(['tvmaze:title:44458', 'tvmaze:title:9']);
    expect(tvmazeBuild(null)).toEqual({ titles: [], releases: [] });
  });

  test('pull makes the single schedule call and returns titles before releases', async () => {
    let seen = null;
    const out = await tvmazeSchedule.pull({
      config: tvmazeSchedule.defaults,
      log: () => {},
      http: {
        json: async (url, opts) => {
          seen = { url, opts };
          return [EPISODE];
        },
      },
    });
    expect(seen.url).toBe('https://api.tvmaze.com/schedule/full');
    expect(seen.opts.timeoutMs).toBeGreaterThanOrEqual(60_000);
    expect(out.items.map((i) => i.kind)).toEqual(['title', 'release']);
  });
});

// ---------------------------------------------------------------------------
// AniList
// ---------------------------------------------------------------------------

const MEDIA = {
  id: 154587,
  idMal: 52991,
  title: {
    romaji: 'Sousou no Frieren',
    english: "Frieren: Beyond Journey's End",
    native: '葬送のフリーレン',
  },
  genres: ['Adventure', 'Drama', 'Fantasy'],
  format: 'TV',
  status: 'RELEASING',
  siteUrl: 'https://anilist.co/anime/154587',
  description: 'The adventure is over<br>but <i>life</i> goes on.',
  episodes: 28,
  duration: 24,
  averageScore: 91,
  popularity: 250_000,
  seasonYear: 2023,
  startDate: { year: 2023, month: 9, day: 29 },
  bannerImage: 'https://img/banner.jpg',
  coverImage: { medium: 'https://img/cover-m.jpg', large: 'https://img/cover-l.jpg' },
  trailer: { id: 'abc123', site: 'youtube' },
  studios: { nodes: [{ name: 'Madhouse' }] },
};

const AIRING = { id: 380001, airingAt: 1_789_500_000, episode: 8, media: MEDIA };

describe('anilist', () => {
  test('an airing becomes a timed release keyed on the series and episode', () => {
    const r = anilistRelease(AIRING);
    expect(r.externalId).toBe('anilist:airing:154587:8');
    expect(r.kind).toBe('release');
    expect(r.title).toBe("Frieren: Beyond Journey's End — Episode 8");
    expect(r.summary).toBe('The adventure is over but life goes on.');
    expect(r.publishedAt).toEqual(new Date(1_789_500_000 * 1000));
    expect(r.timeKnown).toBe(true);
    expect(r.precision).toBe('minute');
    expect(r.imageUrl).toBe('https://img/banner.jpg');
    expect(r.tags).toEqual([
      'release',
      'anime',
      'anilist',
      'genre:adventure',
      'genre:drama',
      'genre:fantasy',
      'type:airing',
    ]);
    expect(r.data).toMatchObject({
      provider: 'anilist',
      category: 'anime',
      type: 'airing',
      titleExternalId: 'anilist:title:154587',
      titleName: "Frieren: Beyond Journey's End",
      season: null,
      number: 8,
      venue: 'Madhouse',
      venueRegion: 'Japan',
      runtimeMin: 24,
      airingScheduleId: '380001',
      episodeType: 'episode',
      rating: 9.1,
    });
  });

  test('a film premiere is not called episode 1', () => {
    const r = anilistRelease({ ...AIRING, episode: 1, media: { ...MEDIA, format: 'MOVIE' } });
    expect(r.title).toBe("Frieren: Beyond Journey's End");
    expect(r.data.episodeType).toBe('film');
    expect(anilistRelease({ ...AIRING, airingAt: null })).toBeNull();
    expect(anilistRelease({ ...AIRING, media: { ...MEDIA, title: {} } })).toBeNull();
  });

  test('a series becomes a title with its score out of ten and its first air date', () => {
    const t = anilistTitle(MEDIA);
    expect(t.externalId).toBe('anilist:title:154587');
    expect(t.title).toBe("Frieren: Beyond Journey's End");
    expect(t.imageUrl).toBe('https://img/cover-l.jpg');
    expect(t.publishedAt).toEqual(noon('2023-09-29'));
    expect(t.precision).toBe('day');
    expect(t.tags).toEqual([
      'title',
      'anime',
      'anilist',
      'genre:adventure',
      'genre:drama',
      'genre:fantasy',
    ]);
    expect(t.data).toMatchObject({
      form: 'series',
      year: 2023,
      normTitle: 'frieren beyond journey s end',
      anilistId: '154587',
      malId: '52991',
      rating: 9.1,
      popularity: 250_000,
      backdropUrl: 'https://img/banner.jpg',
      trailerUrl: 'https://www.youtube.com/watch?v=abc123',
      runtimeMin: 24,
      episodes: 28,
      studios: ['Madhouse'],
    });
    expect(t.data.titles.native).toBe('葬送のフリーレン');
  });

  test('a partial start date keeps whatever precision AniList gave', () => {
    expect(startOf({ startDate: { year: 2027, month: 4, day: null } })).toEqual({
      publishedAt: noon('2027-04-15'),
      precision: 'month',
      year: 2027,
    });
    expect(startOf({ startDate: { year: 2027 } })).toEqual({
      publishedAt: noon('2027-07-01'),
      precision: 'year',
      year: 2027,
    });
    expect(startOf({ startDate: {}, seasonYear: 2026 })).toEqual({
      publishedAt: null,
      precision: 'year',
      year: 2026,
    });
  });

  test('buildItems lists each series once across its episodes', () => {
    const { titles, releases } = anilistBuild([AIRING, { ...AIRING, id: 380002, episode: 9 }]);
    expect(titles).toHaveLength(1);
    expect(releases.map((r) => r.externalId)).toEqual([
      'anilist:airing:154587:8',
      'anilist:airing:154587:9',
    ]);
  });

  test('pull pages until hasNextPage is false and surfaces GraphQL errors', async () => {
    const calls = [];
    const http = {
      json: async (url, opts) => {
        const { variables } = JSON.parse(opts.body);
        calls.push({
          url,
          method: opts.method,
          page: variables.page,
          window: variables.to - variables.from,
        });
        return {
          data: {
            Page: {
              pageInfo: { hasNextPage: variables.page < 2, currentPage: variables.page },
              airingSchedules: [{ ...AIRING, id: 1000 + variables.page, episode: variables.page }],
            },
          },
        };
      },
    };
    const out = await anilistAiring.pull({
      config: { ...anilistAiring.defaults, gapMs: 0 },
      http,
      log: () => {},
      deadline: Date.now() + 60_000,
    });
    expect(calls.map((c) => c.page)).toEqual([1, 2]);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].window).toBe(60 * 86_400);
    expect(out.items.filter((i) => i.kind === 'title')).toHaveLength(1);
    expect(out.items.filter((i) => i.kind === 'release')).toHaveLength(2);

    const failing = { json: async () => ({ errors: [{ message: 'Too Many Requests' }] }) };
    await expect(
      anilistAiring.pull({
        config: anilistAiring.defaults,
        http: failing,
        log: () => {},
        deadline: Date.now() + 60_000,
      }),
    ).rejects.toThrow('Too Many Requests');
  });
});

// ---------------------------------------------------------------------------
// IMDb
// ---------------------------------------------------------------------------

const BASICS_HEADER =
  'tconst\ttitleType\tprimaryTitle\toriginalTitle\tisAdult\tstartYear\tendYear\truntimeMinutes\tgenres';
const basicsLine = (
  tconst,
  type,
  title,
  year,
  { adult = '0', genres = 'Drama', runtime = '\\N', end = '\\N' } = {},
) => [tconst, type, title, title, adult, year, end, runtime, genres].join('\t');

const BASICS_ROWS = [
  basicsLine('tt0133093', 'movie', 'The Matrix', '1999', {
    genres: 'Action,Sci-Fi',
    runtime: '136',
  }),
  basicsLine('tt0000001', 'short', 'Carmencita', '1894', { genres: 'Documentary,Short' }),
  basicsLine('tt9000001', 'tvEpisode', 'Pilot', '2026', { genres: 'Drama' }),
  basicsLine('tt9000002', 'movie', 'Unrated New Film', '2026', { genres: 'Horror,Short' }),
  basicsLine('tt9000003', 'movie', 'Forgotten Old Film', '1985', { genres: 'Drama' }),
  basicsLine('tt9000004', 'movie', 'Grown Up', '2026', { adult: '1' }),
  basicsLine('tt0903747', 'tvSeries', 'Breaking Bad', '2008', {
    genres: 'Crime,Drama,Thriller',
    end: '2013',
    runtime: '49',
  }),
  basicsLine('tt9000005', 'tvMiniSeries', 'Dateless', '\\N', { genres: 'Drama' }),
];
const BASICS_TSV = `${[BASICS_HEADER, ...BASICS_ROWS].join('\n')}\n`;

const RATINGS_TSV = [
  'tconst\taverageRating\tnumVotes',
  'tt0133093\t8.7\t2100000',
  'tt0903747\t9.5\t2200000',
  'tt9000003\t6.1\t12',
  'tt9000005\t7.0\t150',
].join('\n');

const gz = (s) => Bun.gzipSync(Buffer.from(s));
const bodyOf = (s) => new Response(gz(s)).body;
const THIS_YEAR = 2026;

describe('imdb rules', () => {
  test('a TSV line is keyed by the header with \\N as null', () => {
    const row = parseTsvLine(BASICS_HEADER.split('\t'), BASICS_ROWS[0]);
    expect(row.tconst).toBe('tt0133093');
    expect(row.titleType).toBe('movie');
    expect(row.endYear).toBeNull();
    expect(row.runtimeMinutes).toBe('136');
    expect(intOf(row.runtimeMinutes)).toBe(136);
    expect(intOf(row.endYear)).toBeNull();
    expect(intOf('abc')).toBeNull();
  });

  test('ratings pack and unpack without losing a decimal', () => {
    expect(unpackRating(packRating(8.7, 2_100_000))).toEqual({ rating: 8.7, votes: 2_100_000 });
    expect(unpackRating(packRating(null, 150))).toEqual({ rating: 0, votes: 150 });
    expect(unpackRating(packRating(9.5, 20_000_000)).votes).toBe(9_999_999);
  });

  test('loadRatings keeps only titles above the vote floor', async () => {
    const map = await loadRatings(RATINGS_TSV.split('\n'), { minVotes: 100 });
    expect([...map.keys()].sort()).toEqual(['tt0133093', 'tt0903747', 'tt9000005']);
    expect(unpackRating(map.get('tt0133093'))).toEqual({ rating: 8.7, votes: 2_100_000 });
  });

  test('candidateFrom applies the two ways in and the skips', () => {
    const header = BASICS_HEADER.split('\t');
    const row = (i) => parseTsvLine(header, BASICS_ROWS[i]);
    const ctx = { thisYear: THIS_YEAR, recentYears: 2 };
    // Known: rated and old.
    const matrix = candidateFrom(row(0), { ...ctx, rated: packRating(8.7, 2_100_000) });
    expect(matrix).toMatchObject({
      tconst: 'tt0133093',
      title: 'The Matrix',
      year: 1999,
      category: 'film',
      form: 'movie',
      runtimeMin: 136,
      rating: 8.7,
      ratingCount: 2_100_000,
      genres: ['Action', 'Sci-Fi'],
    });
    // short is not a kind this keeps.
    expect(candidateFrom(row(1), { ...ctx, rated: packRating(5.7, 2000) })).toBeNull();
    // tvEpisode never.
    expect(candidateFrom(row(2), ctx)).toBeNull();
    // Recent with no rating at all: kept, with the Short genre dropped.
    expect(candidateFrom(row(3), ctx)).toMatchObject({
      tconst: 'tt9000002',
      rating: null,
      ratingCount: null,
      genres: ['Horror'],
    });
    // Old and unrated (or under the floor, which never reaches the map): out.
    expect(candidateFrom(row(4), ctx)).toBeNull();
    // Adult: out whatever else is true.
    expect(candidateFrom(row(5), { ...ctx, rated: packRating(9, 1e6) })).toBeNull();
    // A series is a series.
    const bb = candidateFrom(row(6), { ...ctx, rated: packRating(9.5, 2_200_000) });
    expect(bb).toMatchObject({ category: 'tv', form: 'series', endYear: 2013, runtimeMin: 49 });
    // No year, but rated: kept as an undated title.
    expect(candidateFrom(row(7), { ...ctx, rated: packRating(7, 150) })).toMatchObject({
      year: null,
    });
    expect(candidateFrom(null, ctx)).toBeNull();
  });

  test('a candidate becomes a year-precision title', () => {
    const header = BASICS_HEADER.split('\t');
    const c = candidateFrom(parseTsvLine(header, BASICS_ROWS[0]), {
      thisYear: THIS_YEAR,
      recentYears: 2,
      rated: packRating(8.7, 2_100_000),
    });
    const t = imdbTitle(c);
    expect(t.externalId).toBe('imdb:title:tt0133093');
    expect(t.kind).toBe('title');
    expect(t.url).toBe('https://www.imdb.com/title/tt0133093/');
    expect(t.publishedAt).toEqual(noon('1999-07-01'));
    expect(t.timeKnown).toBe(false);
    expect(t.precision).toBe('year');
    expect(t.tags).toEqual(['title', 'film', 'imdb', 'genre:action', 'genre:sci-fi']);
    expect(t.data).toMatchObject({
      provider: 'imdb',
      category: 'film',
      form: 'movie',
      year: 1999,
      normTitle: 'the matrix',
      imdbId: 'tt0133093',
      tmdbId: null,
      rating: 8.7,
      ratingCount: 2_100_000,
      runtimeMin: 136,
      titleType: 'movie',
    });
    const undated = imdbTitle({ ...c, year: null });
    expect(undated.publishedAt).toBeNull();
    expect(undated.precision).toBe('year');
    expect(normaliseItem(t).tags).toEqual(t.tags);
  });
});

describe('imdb streaming', () => {
  test('gunzipLines yields every line, including a last one with no newline', async () => {
    const lines = [];
    for await (const l of gunzipLines(bodyOf('a\tb\nc\td\ne'))) lines.push(l);
    expect(lines).toEqual(['a\tb', 'c\td', 'e']);
  });

  test('readBasics pages by offset without re-emitting or skipping a row', async () => {
    const rated = await loadRatings(RATINGS_TSV.split('\n'), { minVotes: 100 });
    const opts = { rated, thisYear: THIS_YEAR, recentYears: 2 };
    const full = await readBasics({ lines: gunzipLines(bodyOf(BASICS_TSV)), ...opts });
    expect(full.finished).toBe(true);
    expect(full.consumed).toBe(BASICS_ROWS.length);
    expect(full.items.map((i) => i.externalId)).toEqual([
      'imdb:title:tt0133093',
      'imdb:title:tt9000002',
      'imdb:title:tt0903747',
      'imdb:title:tt9000005',
    ]);

    const p1 = await readBasics({ lines: gunzipLines(bodyOf(BASICS_TSV)), limit: 2, ...opts });
    expect(p1.finished).toBe(false);
    expect(p1.items).toHaveLength(2);
    // Stopped right after the second candidate, on the fourth data line.
    expect(p1.consumed).toBe(4);
    const p2 = await readBasics({
      lines: gunzipLines(bodyOf(BASICS_TSV)),
      offset: p1.consumed,
      limit: 2,
      ...opts,
    });
    expect(p2.skipped).toBe(4);
    expect(p2.items.map((i) => i.externalId)).toEqual([
      'imdb:title:tt0903747',
      'imdb:title:tt9000005',
    ]);
    // The limit landed on the very last line, so this page cannot know the file
    // ended; the next one reads nothing and completes.
    const p3 = await readBasics({
      lines: gunzipLines(bodyOf(BASICS_TSV)),
      offset: p2.consumed,
      limit: 2,
      ...opts,
    });
    expect(p3.items).toEqual([]);
    expect(p3.finished).toBe(true);
    expect([...p1.items, ...p2.items].map((i) => i.externalId)).toEqual(
      full.items.map((i) => i.externalId),
    );
  });

  test('readBasics stops at the deadline with a resumable offset', async () => {
    const many = `${BASICS_HEADER}\n${Array.from({ length: 45_000 }, (_, i) =>
      basicsLine(`tt${String(i).padStart(7, '0')}`, 'movie', `Film ${i}`, '2026'),
    ).join('\n')}\n`;
    const out = await readBasics({
      lines: gunzipLines(bodyOf(many)),
      deadline: Date.now() - 1,
      limit: 1_000_000,
      rated: new Map(),
      thisYear: THIS_YEAR,
      recentYears: 2,
    });
    expect(out.finished).toBe(false);
    expect(out.consumed).toBe(20_000);
    expect(out.items).toHaveLength(20_000);
  });
});

describe('imdb pull', () => {
  const rows = Array.from({ length: 250 }, (_, i) =>
    basicsLine(`tt${String(i + 1).padStart(7, '0')}`, 'movie', `Film ${i + 1}`, '2026'),
  );
  const dump = (stamp) => {
    const calls = [];
    const http = {
      request: async (url) => {
        calls.push(url);
        const tsv = url.includes('ratings')
          ? RATINGS_TSV
          : `${[BASICS_HEADER, ...rows].join('\n')}\n`;
        return new Response(gz(tsv), { status: 200, headers: { 'last-modified': stamp } });
      },
    };
    return { http, calls };
  };
  const ctx = (http, cursor = {}) => ({
    config: { ...imdbRatings.defaults, perRun: 100 },
    cursor,
    http,
    log: () => {},
    deadline: Date.now() + 60_000,
  });

  test('pages through the dump a run at a time, then rests until it changes', async () => {
    const { http, calls } = dump('Wed, 09 Sep 2026 06:00:00 GMT');
    const r1 = await imdbRatings.pull(ctx(http));
    expect(r1.items).toHaveLength(100);
    expect(r1.items[0].externalId).toBe('imdb:title:tt0000001');
    expect(r1.cursor).toEqual({
      dumpDate: 'Wed, 09 Sep 2026 06:00:00 GMT',
      offset: 100,
      done: false,
    });
    expect(r1.nextInMinutes).toBe(1);
    // Basics and ratings were both fetched once.
    expect(calls.filter((u) => u.includes('ratings'))).toHaveLength(1);

    const r2 = await imdbRatings.pull(ctx(http, r1.cursor));
    expect(r2.items[0].externalId).toBe('imdb:title:tt0000101');
    expect(r2.cursor.offset).toBe(200);
    // The ratings map is kept between the runs of one walk.
    expect(calls.filter((u) => u.includes('ratings'))).toHaveLength(1);

    const r3 = await imdbRatings.pull(ctx(http, r2.cursor));
    expect(r3.items).toHaveLength(50);
    expect(r3.items.at(-1).externalId).toBe('imdb:title:tt0000250');
    expect(r3.cursor.done).toBe(true);
    expect(r3.nextInMinutes).toBeUndefined();

    const r4 = await imdbRatings.pull(ctx(http, r3.cursor));
    expect(r4.items).toEqual([]);
    expect(r4.note).toBe('dump unchanged');
    expect(r4.cursor).toEqual(r3.cursor);

    // A new dump starts the walk over, re-reading the ratings.
    const fresh = dump('Thu, 10 Sep 2026 06:00:00 GMT');
    const r5 = await imdbRatings.pull(ctx(fresh.http, r3.cursor));
    expect(r5.items).toHaveLength(100);
    expect(r5.cursor.offset).toBe(100);
    expect(r5.cursor.dumpDate).toBe('Thu, 10 Sep 2026 06:00:00 GMT');
    expect(fresh.calls.filter((u) => u.includes('ratings'))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

describe('screen adapters', () => {
  test('are named and cadenced as the consolidation contract says', () => {
    expect(tmdbReleases).toMatchObject({
      name: 'tmdb-releases',
      collection: 'screen',
      cadenceMinutes: 720,
      needsEnv: ['tmdbApiKey'],
    });
    expect(tvmazeSchedule).toMatchObject({
      name: 'tvmaze-schedule',
      collection: 'screen',
      cadenceMinutes: 180,
    });
    expect(anilistAiring).toMatchObject({
      name: 'anilist-airing',
      collection: 'screen',
      cadenceMinutes: 360,
    });
    expect(imdbRatings).toMatchObject({
      name: 'imdb-ratings',
      collection: 'screen',
      cadenceMinutes: 1440,
    });
    for (const a of [tmdbReleases, tvmazeSchedule, anilistAiring]) {
      expect(a.kinds).toEqual(['title', 'release']);
    }
    expect(imdbRatings.kinds).toEqual(['title']);
  });
});
