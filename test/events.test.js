import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The events collection: MusicBrainz's event dump and Wikidata's festivals.
 *
 * Both fixtures are real bytes. `musicbrainz-events-sample.tar.xz` is 191 rows
 * of the 20260923-001002 event member, the first 180 plus rows picked for the
 * cases that bite (a year of `????`, a cancelled show, one rescheduled, one
 * still to come with a ticketing link, support acts, an area with a country
 * code, a setlist, a start time), re-packed under the same member name with
 * no final newline. `wikidata-festivals-sample.json` is 35 rows of the live
 * answer of 2026-09-25, bare-Q-id labels and ended festivals included.
 */
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';

const {
  ENTITIES,
  areaCountries,
  billing,
  countriesFile,
  countryOf,
  eventItem,
  musicbrainzEvents,
  MAPPING_VERSION,
  pullEvents,
  relationsOf,
  toEventItem,
} = await import('../packages/adapters/src/musicbrainz-events.js');
const catalog = await import('../packages/adapters/src/musicbrainz-catalog.js');
const { festivalItem, pointOf, wikidataFestivals, buildQuery } = await import(
  '../packages/adapters/src/wikidata-festivals.js'
);
const { normaliseItem } = await import('../packages/core/src/adapter.js');
const { xzLines } = await import('../packages/core/src/dump.js');
const { adapterByName } = await import('../packages/adapters/src/index.js');
const { COLLECTIONS, DEFAULT_FEEDS } = await import('../packages/core/src/seed.js');

const FIXTURES = new URL('../packages/adapters/test/fixtures/', import.meta.url).pathname;
const EVENTS = join(FIXTURES, 'musicbrainz-events-sample.tar.xz');
const FESTIVALS = join(FIXTURES, 'wikidata-festivals-sample.json');
const DIR = '20260923-001002';

let tmp;
let rows;

const collect = async (gen) => {
  const batches = [];
  let r = await gen.next();
  while (!r.done) {
    batches.push(r.value);
    r = await gen.next();
  }
  return { batches, result: r.value };
};

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'nichedb-events-'));
  rows = [];
  for await (const line of xzLines(EVENTS, { member: 'mbdump/event' })) rows.push(JSON.parse(line));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const find = (pred) => {
  const row = rows.find(pred);
  if (!row) throw new Error('fixture lacks the case');
  return row;
};

describe('musicbrainz-events mapping', () => {
  test('every fixture row maps and normalises', () => {
    expect(rows.length).toBe(191);
    for (const r of rows) {
      const item = normaliseItem(eventItem(r));
      expect(item).not.toBeNull();
      expect(item.kind).toBe('event');
      expect(item.externalId).toBe(`musicbrainz:event:${r.id}`);
      expect(item.url).toBe(`https://musicbrainz.org/event/${r.id}`);
      expect(item.data.attribution).toBe('MusicBrainz, CC0');
    }
  });

  test('the CC BY-NC-SA fields never reach an item', () => {
    for (const r of rows) {
      const { data } = eventItem(r);
      for (const k of ['annotation', 'rating', 'tags', 'genres', 'relations']) {
        expect(data[k]).toBeUndefined();
      }
    }
  });

  test('a year of ???? is undated, not upcoming', () => {
    const r = find((e) => e['life-span']?.begin?.startsWith('????'));
    const item = eventItem(r);
    expect(item.publishedAt).toBeNull();
    expect(item.data.begin).toStartWith('????');
  });

  test('a dated event is a date, never a time', () => {
    const r = find((e) => /^\d{4}-\d{2}-\d{2}$/.test(e['life-span']?.begin ?? '') && e.time);
    const item = eventItem(r);
    expect(item.precision).toBe('day');
    expect(item.timeKnown).toBe(false);
    expect(item.data.time).toBe(r.time);
  });

  test('a cancelled show says so first and is tagged', () => {
    const item = eventItem(find((e) => e.cancelled));
    expect(item.tags).toContain('cancelled');
    expect(item.summary).toStartWith('Cancelled.');
  });

  test('a rescheduled show names the event it moved to', () => {
    const r = find((e) =>
      (e.relations ?? []).some((x) => x.type === 'rescheduled as' && x.direction === 'forward'),
    );
    expect(eventItem(r).data.rescheduledAs?.mbid).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('a ticketing link is kept and tagged', () => {
    const r = find((e) => !e.cancelled && (e.relations ?? []).some((x) => x.type === 'ticketing'));
    const item = eventItem(r);
    expect(item.tags).toContain('tickets');
    expect(item.data.links.ticketing[0]).toMatch(/^https?:\/\//);
  });

  test('a cancelled show keeps its ticket link but is not on sale', () => {
    const r = find((e) => !e.cancelled && (e.relations ?? []).some((x) => x.type === 'ticketing'));
    const item = eventItem({ ...r, cancelled: true });
    expect(item.tags).not.toContain('tickets');
    expect(item.tags).toContain('cancelled');
    expect(item.data.links.ticketing.length).toBeGreaterThan(0);
  });

  test('a country missing from the row comes from the area map', () => {
    const r = find((e) =>
      (e.relations ?? []).some((x) => x.type === 'held at' && x.place?.area?.id),
    );
    const areaId = r.relations.find((x) => x.type === 'held at').place.area.id;
    const without = eventItem(r);
    const withMap = eventItem(r, new Map([[areaId, 'DE']]));
    expect(withMap.data.country).toBe(without.data.country ?? 'DE');
    if (!without.data.country) expect(withMap.tags).toContain('country:de');
  });

  test('the venue carries its coordinates and city', () => {
    const r = find((e) =>
      (e.relations ?? []).some((x) => x.type === 'held at' && x.place?.coordinates),
    );
    const { place } = eventItem(r).data;
    expect(typeof place.location.lat).toBe('number');
    expect(typeof place.location.long).toBe('number');
  });

  test('headliners before support, and the billing reads like a poster', () => {
    const r = find((e) => (e.relations ?? []).some((x) => x.type === 'support act'));
    const { performers } = eventItem(r).data;
    const firstSupport = performers.findIndex((p) => p.role === 'support act');
    expect(performers.slice(0, firstSupport).every((p) => p.role === 'main performer')).toBe(true);
    expect(
      billing([
        { name: 'Metallica', role: 'main performer' },
        { name: 'Pantera', role: 'support act' },
        { name: 'Mammoth', role: 'support act' },
      ]),
    ).toBe('Metallica, with Pantera and Mammoth');
    expect(billing([{ name: 'X', role: 'support act' }])).toBe('with X');
    expect(billing([])).toBeNull();
  });

  test('a country comes from an ISO 3166-1 code, else the prefix of a 3166-2 one', () => {
    expect(countryOf({ 'iso-3166-1-codes': ['de'] })).toBe('DE');
    expect(countryOf({ 'iso-3166-2-codes': ['RU-MOW'] })).toBe('RU');
    expect(countryOf({ name: 'Bonn' })).toBeNull();
    expect(countryOf(null)).toBeNull();
  });

  test('a non-http link and an unknown relation are dropped', () => {
    const rel = relationsOf([
      { 'target-type': 'url', type: 'ticketing', url: { resource: 'javascript:alert(1)' } },
      {
        'target-type': 'url',
        type: 'purchase for mail-order',
        url: { resource: 'https://x.test' },
      },
      { 'target-type': 'artist', type: 'main performer', artist: { name: 'A', id: 'a' } },
      { 'target-type': 'artist', type: 'main performer', artist: { name: 'A', id: 'a' } },
    ]);
    expect(rel.links).toEqual({});
    expect(rel.performers.length).toBe(2);
    expect(relationsOf(null).performers).toEqual([]);
  });

  test('only event rows map', () => {
    expect(toEventItem('artist', rows[0])).toBeNull();
    expect(toEventItem('event', null)).toBeNull();
    expect(eventItem({ id: 'x' })).toBeNull();
  });
});

describe('musicbrainz-events walk', () => {
  test('walks the event archive through the shared dump walker and finishes the dump', async () => {
    const downloads = [];
    const http = {
      async text() {
        return `${DIR}\n`;
      },
      async download(url, filePath) {
        downloads.push(url);
        await copyFile(EVENTS, filePath);
        return { complete: true, bytes: 1 };
      },
    };
    const { batches, result } = await collect(
      catalog.walk(
        { config: { batchSize: 100 }, cursor: null, http, log: () => {}, deadline: Infinity },
        { dataDir: tmp, entities: ENTITIES, map: toEventItem },
      ),
    );
    expect(downloads).toEqual([catalog.dumpUrl(DIR, 'event')]);
    expect(batches.map((b) => b.items.length)).toEqual([100, 91]);
    expect(batches[0].cursor).toEqual({ dir: DIR, entity: 'event', line: 100 });
    expect(result.cursor.done).toBe(true);
    expect(result.note).toContain('event complete');
  });

  test('a walked dump is not walked again', async () => {
    const http = {
      async text() {
        return `${DIR}\n`;
      },
      async download() {
        throw new Error('should not download');
      },
    };
    const { batches, result } = await collect(
      catalog.walk(
        {
          config: {},
          cursor: { dir: DIR, entity: 'event', line: 191, done: true },
          http,
          log: () => {},
          deadline: Infinity,
        },
        { dataDir: tmp, entities: ENTITIES, map: toEventItem },
      ),
    );
    expect(batches).toEqual([]);
    expect(result.note).toBe('unchanged');
  });

  test('the catalogue walk still reads artists then release groups', () => {
    expect(catalog.resumeFrom(null, DIR)).toEqual({
      dir: DIR,
      entity: 'artist',
      line: 0,
      done: false,
    });
    expect(catalog.nextEntity('artist')).toBe('release-group');
    expect(catalog.nextEntity('event', ENTITIES)).toBeNull();
    expect(catalog.resumeFrom({ dir: DIR, entity: 'artist', line: 5 }, DIR, ENTITIES).entity).toBe(
      'event',
    );
  });
});

describe('wikidata-festivals', () => {
  let body;
  beforeAll(async () => {
    body = JSON.parse(await readFile(FESTIVALS, 'utf8'));
  });

  test('maps real rows and skips the bare Q ids', () => {
    const all = body.results.bindings;
    const items = all.map(festivalItem);
    const bare = all.filter((r) => /^Q\d+$/.test(r.itemLabel.value)).length;
    expect(bare).toBeGreaterThan(0);
    expect(items.filter((i) => i === null).length).toBe(bare);
    for (const item of items.filter(Boolean)) {
      const n = normaliseItem(item);
      expect(n.kind).toBe('festival');
      expect(n.externalId).toMatch(/^wikidata:festival:Q\d+$/);
      expect(n.tags.every((t) => !t.endsWith(':'))).toBe(true);
    }
  });

  test('a festival with a website links there and keeps its MusicBrainz series', () => {
    const row = body.results.bindings.find((r) => r.website && r.mbSeries);
    const item = festivalItem(row);
    expect(item.url).toBe(row.website.value);
    expect(item.data.musicbrainzSeries).toBe(row.mbSeries.value);
    expect(item.tags).toContain('musicbrainz');
  });

  test('an ended festival is tagged', () => {
    const row = body.results.bindings.find((r) => r.ended && !/^Q\d+$/.test(r.itemLabel.value));
    expect(festivalItem(row).tags).toContain('ended');
  });

  test('a WKT point is longitude first', () => {
    expect(pointOf('Point(5.89277778 51.96416667)')).toEqual({
      lat: 51.96416667,
      long: 5.89277778,
    });
    expect(pointOf('Point(200 10)')).toBeNull();
    expect(pointOf('nonsense')).toBeNull();
  });

  test('pull asks once, yields one batch, and throws after three failures', async () => {
    const asked = [];
    const ok = {
      async request(url, opts) {
        asked.push({ url, ua: opts.headers['user-agent'] });
        return { ok: true, status: 200, json: async () => body };
      },
    };
    const { batches, result } = await collect(
      wikidataFestivals.pull({ http: ok, log: () => {} }, { pauseMs: 0 }),
    );
    expect(asked.length).toBe(1);
    expect(asked[0].ua).toContain('nichedb');
    expect(decodeURIComponent(asked[0].url)).toContain(buildQuery());
    expect(batches.length).toBe(1);
    expect(result.note).toMatch(/^\d+ festivals, \d+ without a label$/);

    let n = 0;
    const bad = {
      async request() {
        n += 1;
        return { ok: false, status: 504 };
      },
    };
    await expect(
      collect(wikidataFestivals.pull({ http: bad, log: () => {} }, { pauseMs: 0 })),
    ).rejects.toThrow('3 asks failed');
    expect(n).toBe(3);
  });
});

describe('events collection wiring', () => {
  test('both adapters are registered to the events collection', () => {
    for (const name of ['musicbrainz-events', 'wikidata-festivals']) {
      expect(adapterByName(name)?.collection).toBe('events');
    }
    expect(musicbrainzEvents.defaultSources[0].slug).toBe('musicbrainz-events');
  });

  test('the collection is seeded and every events feed asks for a kind it carries', () => {
    expect(COLLECTIONS.some((c) => c.slug === 'events')).toBe(true);
    const feeds = DEFAULT_FEEDS.filter((f) => f.collection === 'events');
    expect(feeds.length).toBe(5);
    for (const f of feeds) {
      for (const k of f.query.kinds) expect(['event', 'festival']).toContain(k);
    }
  });
});

describe('area countries', () => {
  const AREAS = join(FIXTURES, 'musicbrainz-area-sample.tar.xz');
  const area = (id, parent = null, codes = {}) => ({
    id,
    ...codes,
    relations: parent
      ? [{ 'target-type': 'area', type: 'part of', direction: 'backward', area: { id: parent } }]
      : [],
  });
  async function* each(xs) {
    for (const x of xs) yield x;
  }

  test('a city resolves up its chain to the first area with a code', async () => {
    const map = await areaCountries(
      each([
        area('bonn', 'nrw'),
        area('nrw', 'de', { 'iso-3166-2-codes': ['DE-NW'] }),
        area('de', null, { 'iso-3166-1-codes': ['DE'] }),
        area('beuel', 'bonn'),
      ]),
    );
    expect(map.get('bonn')).toBe('DE');
    expect(map.get('beuel')).toBe('DE');
    expect(map.get('de')).toBe('DE');
  });

  test('a loop or a chain with no code resolves to nothing', async () => {
    const map = await areaCountries(each([area('a', 'b'), area('b', 'a'), area('c')]));
    expect(map.size).toBe(0);
  });

  const fakeHttp = ({ areaFails = false } = {}) => {
    const downloads = [];
    return {
      downloads,
      http: {
        async text() {
          return `${DIR}\n`;
        },
        async download(url, filePath) {
          downloads.push(url);
          if (url.endsWith('/area.tar.xz')) {
            if (areaFails) throw new Error('503');
            await copyFile(AREAS, filePath);
          } else {
            await copyFile(EVENTS, filePath);
          }
          return { complete: true, bytes: 1 };
        },
      },
    };
  };

  test('a pull resolves countries from the real area rows and caches the map', async () => {
    const dataDir = await mkdtemp(join(tmp, 'pull-'));
    const { http, downloads } = fakeHttp();
    const ctx = { config: {}, cursor: null, http, log: () => {}, deadline: Infinity };
    const { batches, result } = await collect(pullEvents(ctx, { dataDir }));
    const items = batches.flatMap((b) => b.items);
    expect(items.length).toBe(191);
    const withCountry = items.filter((i) => i.data.country).length;
    const baseline = rows.filter((r) => eventItem(r).data.country).length;
    expect(withCountry).toBeGreaterThan(baseline);
    expect(downloads.filter((u) => u.endsWith('/area.tar.xz')).length).toBe(1);
    const cached = JSON.parse(await readFile(countriesFile(dataDir, DIR), 'utf8'));
    expect(Object.keys(cached).length).toBeGreaterThan(0);
    expect(result.cursor.done).toBe(true);

    // A second walk of the same dump reads the cache, not the archive.
    const again = fakeHttp();
    await collect(pullEvents({ ...ctx, http: again.http }, { dataDir }));
    expect(again.downloads.some((u) => u.endsWith('/area.tar.xz'))).toBe(false);
  });

  test('an area outage still walks the events', async () => {
    const dataDir = await mkdtemp(join(tmp, 'outage-'));
    const { http } = fakeHttp({ areaFails: true });
    const logs = [];
    const { batches } = await collect(
      pullEvents(
        { config: {}, cursor: null, http, log: (m) => logs.push(m), deadline: Infinity },
        { dataDir },
      ),
    );
    expect(batches.flatMap((b) => b.items).length).toBe(191);
    expect(logs.some((m) => m.startsWith('area:'))).toBe(true);
  });

  test('a walked dump asks for no area archive', async () => {
    const dataDir = await mkdtemp(join(tmp, 'done-'));
    const { http, downloads } = fakeHttp();
    const { result } = await collect(
      pullEvents(
        {
          config: {},
          cursor: { dir: DIR, entity: 'event', line: 191, done: true, v: MAPPING_VERSION },
          http,
          log: () => {},
          deadline: Infinity,
        },
        { dataDir },
      ),
    );
    expect(downloads).toEqual([]);
    expect(result.note).toBe('unchanged');
  });

  test('a dump walked under an older mapping is walked again, once', async () => {
    const dataDir = await mkdtemp(join(tmp, 'remap-'));
    const { http, downloads } = fakeHttp();
    const old = { dir: DIR, entity: 'event', line: 191, done: true };
    const ctx = { config: {}, cursor: old, http, log: () => {}, deadline: Infinity };
    const { batches, result } = await collect(pullEvents(ctx, { dataDir }));
    expect(batches.flatMap((b) => b.items).length).toBe(191);
    expect(downloads.some((u) => u.endsWith('/area.tar.xz'))).toBe(true);
    expect(batches.every((b) => b.cursor.v === MAPPING_VERSION)).toBe(true);
    expect(result.cursor).toMatchObject({ dir: DIR, done: true, v: MAPPING_VERSION });

    const again = fakeHttp();
    const second = await collect(
      pullEvents({ ...ctx, cursor: result.cursor, http: again.http }, { dataDir }),
    );
    expect(second.batches).toEqual([]);
    expect(second.result.note).toBe('unchanged');
    expect(again.downloads).toEqual([]);
  });
});
