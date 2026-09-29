import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

/**
 * The radio collection: Radio Browser's station directory.
 *
 * `radiobrowser-stations.json` is 29 real rows of the live answer of
 * 2026-09-29 (`/json/stations?order=changetimestamp&limit=5000`): the first 20
 * plus one each of the cases that bite -- coordinates, a failing stream, an
 * http favicon, 38 genre tags, a thousand votes, HLS, several languages, an
 * UNKNOWN codec, no homepage.
 */
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';

const {
  MAX_GENRES,
  MIRRORS,
  PAGE,
  genreTag,
  pageUrl,
  pickMirror,
  pointOf,
  radiobrowser,
  stationItem,
} = await import('../packages/adapters/src/radiobrowser.js');
const { normaliseItem } = await import('../packages/core/src/adapter.js');
const { adapterByName } = await import('../packages/adapters/src/index.js');
const { COLLECTIONS, DEFAULT_FEEDS } = await import('../packages/core/src/seed.js');

const FIXTURE = new URL(
  '../packages/adapters/test/fixtures/radiobrowser-stations.json',
  import.meta.url,
).pathname;
const stations = JSON.parse(await readFile(FIXTURE, 'utf8'));
const find = (f) => stations.find(f);

const drain = async (gen) => {
  const batches = [];
  let r = await gen.next();
  while (!r.done) {
    batches.push(r.value);
    r = await gen.next();
  }
  return { batches, result: r.value };
};

describe('stationItem', () => {
  test('every fixture row becomes a storable station', () => {
    for (const s of stations) {
      const it = normaliseItem(stationItem(s));
      expect(it).not.toBeNull();
      expect(it.kind).toBe('station');
      expect(it.externalId).toBe(s.stationuuid);
      expect(it.tags.length).toBeLessThanOrEqual(40);
      expect(it.tags).toContain('radio-browser');
      expect(it.publishedAt).toBeInstanceOf(Date);
    }
  });

  test('the homepage is the url, the stream is data', () => {
    const s = find((x) => x.homepage);
    const it = stationItem(s);
    expect(it.url).toBe(s.homepage);
    expect(it.data.stream).toBe(s.url_resolved || s.url);
  });

  test('no homepage falls back to the stream', () => {
    const s = find((x) => !x.homepage);
    expect(stationItem(s).url).toBe(s.url_resolved || s.url);
  });

  test('a failing stream is kept and tagged offline', () => {
    const it = stationItem(find((x) => !x.lastcheckok));
    expect(it.tags).toContain('offline');
    expect(it.tags).not.toContain('online');
    expect(it.data.online).toBe(false);
    expect(it.summary).toContain('failing');
  });

  test('coordinates land where ndb_geo_shape reads them', () => {
    const s = find((x) => x.geo_lat !== null && x.geo_lat !== 0);
    const it = stationItem(s);
    expect(it.data.lat).toBe(s.geo_lat);
    expect(it.data.long).toBe(s.geo_long);
    expect(it.tags).toContain('geo');
  });

  test('no point for 0,0, nulls or out of range', () => {
    expect(pointOf({ geo_lat: 0, geo_long: 0 })).toBeNull();
    expect(pointOf({ geo_lat: null, geo_long: 3 })).toBeNull();
    expect(pointOf({ geo_lat: 91, geo_long: 3 })).toBeNull();
    expect(pointOf({ geo_lat: 52.5, geo_long: 13.4 })).toEqual({ lat: 52.5, long: 13.4 });
    const it = stationItem({ ...stations[0], geo_lat: 0, geo_long: 0 });
    expect(it.data.lat).toBeUndefined();
    expect(it.tags).not.toContain('geo');
  });

  test('only an https favicon is shown', () => {
    const s = find((x) => x.favicon.startsWith('http:'));
    const it = stationItem(s);
    expect(it.imageUrl).toBeNull();
    expect(it.data.favicon).toBe(s.favicon);
  });

  test('genre tags are capped and deduplicated', () => {
    const s = find((x) => x.tags.split(',').length > 25);
    const it = stationItem(s);
    expect(it.data.genres.length).toBe(MAX_GENRES);
    expect(new Set(it.data.genres).size).toBe(it.data.genres.length);
    expect(normaliseItem(it).tags.length).toBeLessThanOrEqual(40);
  });

  test('popular on votes or on the last day of listens', () => {
    expect(stationItem(find((x) => x.votes >= 1000)).tags).toContain('popular');
    const quiet = { ...stations[0], votes: 3, clickcount: 2 };
    expect(stationItem(quiet).tags).not.toContain('popular');
    expect(stationItem({ ...quiet, clickcount: 250 }).tags).toContain('popular');
  });

  test('country, codec and languages become namespaced tags', () => {
    const s = find((x) => x.language.includes(','));
    const it = stationItem(s);
    expect(it.tags).toContain(`country:${s.countrycode.toLowerCase()}`);
    expect(it.data.languages.length).toBeGreaterThan(1);
    expect(it.tags.filter((t) => t.startsWith('lang:')).length).toBeGreaterThan(1);
    const unknown = stationItem(find((x) => x.codec === 'UNKNOWN'));
    expect(unknown.tags.some((t) => t.startsWith('codec:'))).toBe(false);
  });

  test('a row without a uuid or a name is dropped', () => {
    expect(stationItem({ ...stations[0], stationuuid: '' })).toBeNull();
    expect(stationItem({ ...stations[0], name: '  ' })).toBeNull();
  });

  test('genreTag strips punctuation but keeps talk & speech', () => {
    expect(genreTag(' Talk & Speech ')).toBe('talk & speech');
    expect(genreTag('#rock!')).toBe('rock');
    expect(genreTag('música')).toBe('música');
  });
});

describe('pull', () => {
  const statsOk = { status: 'OK', stations: 3 };

  test('picks the first mirror that answers and stays on it', async () => {
    const asked = [];
    const http = {
      jsonOrNull: async (url) => {
        asked.push(url);
        if (url.startsWith(MIRRORS[0])) throw new Error('ENOTFOUND');
        return statsOk;
      },
    };
    const { base } = await pickMirror(http);
    expect(base).toBe(MIRRORS[1]);
    expect(asked).toHaveLength(2);
  });

  test('pages until a short page, and every page comes from one mirror', async () => {
    const pages = [];
    const full = Array.from({ length: PAGE }, (_, i) => ({ ...stations[0], stationuuid: `a${i}` }));
    const http = {
      jsonOrNull: async () => statsOk,
      json: async (url) => {
        pages.push(url);
        return pages.length === 1 ? full : stations.slice(0, 7);
      },
    };
    const { batches, result } = await drain(
      radiobrowser.pull({ config: {}, cursor: {}, http, log: () => {} }),
    );
    expect(pages).toEqual([pageUrl(MIRRORS[0], 0), pageUrl(MIRRORS[0], PAGE)]);
    const items = batches.flatMap((b) => b.items);
    expect(items).toHaveLength(PAGE + 7);
    expect(result.note).toBe(`${PAGE + 7} stations`);
    expect(result.cursor).toEqual({});
  });

  test('a deadline stops between pages and resumes the same day at its offset', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const pages = [];
    const http = {
      jsonOrNull: async () => statsOk,
      json: async (url) => {
        pages.push(url);
        return [];
      },
    };
    const stopped = await drain(
      radiobrowser.pull({ config: {}, cursor: {}, http, log: () => {}, deadline: Date.now() - 1 }),
    );
    expect(stopped.result.cursor).toEqual({ day: today, offset: 0 });

    await drain(
      radiobrowser.pull({
        config: {},
        cursor: { day: today, offset: 10000 },
        http,
        log: () => {},
      }),
    );
    expect(pages.at(-1)).toBe(pageUrl(MIRRORS[0], 10000));

    await drain(
      radiobrowser.pull({
        config: {},
        cursor: { day: '2000-01-01', offset: 10000 },
        http,
        log: () => {},
      }),
    );
    expect(pages.at(-1)).toBe(pageUrl(MIRRORS[0], 0));
  });
});

describe('seeding', () => {
  test('the adapter is registered for the radio collection', () => {
    expect(adapterByName('radiobrowser')).toBe(radiobrowser);
    expect(radiobrowser.collection).toBe('radio');
    expect(radiobrowser.defaultSources.map((s) => s.slug)).toEqual(['radio-browser-stations']);
  });

  test('the collection and its feeds are seeded', () => {
    expect(COLLECTIONS.map((c) => c.slug)).toContain('radio');
    const feeds = DEFAULT_FEEDS.filter((f) => f.collection === 'radio');
    expect(feeds.length).toBeGreaterThan(10);
    for (const f of feeds) {
      expect(f.slug.startsWith('radio-')).toBe(true);
      expect(f.query.kinds).toEqual(['station']);
    }
  });
});
