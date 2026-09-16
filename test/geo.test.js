import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { POLICE_CITIES, policeItem } from '../packages/adapters/src/police-updates.js';
import { toItem, validCoverage } from '../packages/adapters/src/scanners.js';
import { geoQueryFields, parseGeoQuery } from '../packages/core/src/geo.js';

process.env.DATABASE_URL ??= 'postgres://localhost/unused';
const q = await import('../packages/db/src/queries.js');
const { normaliseQuery } = await import('../apps/web/src/lib/service.js');
const { itemOut } = await import('../apps/web/src/lib/serialize.js');
function pgliteSql(db) {
  class Fragment {
    constructor(strings, values) {
      this.strings = strings;
      this.values = values;
    }
    compile(params) {
      let text = '';
      this.strings.forEach((s, i) => {
        text += s;
        if (i >= this.values.length) return;
        const v = this.values[i];
        if (v instanceof Fragment) text += v.compile(params);
        else {
          params.push(v);
          text += `$${params.length}`;
        }
      });
      return text;
    }
    // biome-ignore lint/suspicious/noThenProperty: a query is awaited, as Bun's is
    then(resolve, reject) {
      const params = [];
      const text = this.compile(params);
      return db
        .query(text, params)
        .then((r) => r.rows)
        .then(resolve, reject);
    }
  }
  return (strings, ...values) => new Fragment(strings, values);
}

let db, sql, crime, weather, source;
const center = { lat: 41.88, long: -87.62 };
const circle = { type: 'Circle', coordinates: [-87.62, 41.88], radius_m: 3000 };
const polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [-87.64, 41.86],
      [-87.6, 41.86],
      [-87.6, 41.9],
      [-87.64, 41.9],
      [-87.64, 41.86],
    ],
  ],
};
const near = { place: { lat: 41.881, lon: -87.62 } };
const far = { place: { lat: 42.88, lon: -87.62 } };
const one = async (text, values = []) => (await db.query(text, values)).rows[0];
let seq = 0;
async function item(
  data,
  { collection = crime, kind = 'crime-report', at = '2026-08-01', title = 'Test report' } = {},
) {
  return Number(
    (
      await one(
        `insert into items (collection_id,source_id,external_id,kind,title,data,published_at) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
        [collection, source, String(++seq), kind, title, JSON.stringify(data), at],
      )
    ).id,
  );
}
beforeAll(async () => {
  db = await new PGlite({ extensions: { citext, pg_trgm } });
  const dir = new URL('../packages/db/migrations/', import.meta.url);
  for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort())
    await db.exec(await readFile(new URL(f, dir), 'utf8'));
  sql = pgliteSql(db);
  crime = Number(
    (await one("insert into collections(slug,name) values ('crime','Crime') returning id")).id,
  );
  weather = Number((await one("select id from collections where slug='weather'")).id);
  source = Number(
    (
      await one(
        "insert into sources(collection_id,adapter,slug,name) values ($1,'scanner-directory','test-geo','Test') returning id",
        [crime],
      )
    ).id,
  );
}, 60000);
afterAll(async () => {
  await db?.close();
});

describe('geographic contract', () => {
  test('zero coordinates, defaults and saved feed roundtrip', () => {
    expect(parseGeoQuery({ lat: '0', long: '0' })).toEqual({
      lat: 0,
      long: 0,
      radius: 10,
      unit: 'km',
    });
    expect(parseGeoQuery({})).toBeNull();
    const raw = { ...center, radius: 2, unit: 'mi', sort: 'distance', tags: ['theft'] };
    const saved = normaliseQuery(raw);
    expect(q.feedQuery({ query: JSON.stringify(saved) })).toMatchObject(raw);
    expect(itemOut({ distance_m: 0 }, 'https://test').distance_m).toBe(0);
  });
  test('invalid or ambiguous requests fail instead of returning unfiltered data', () => {
    for (const raw of [
      { lat: 1 },
      { long: 1 },
      { lat: '', long: 0 },
      { lat: true, long: 0 },
      { lat: 91, long: 0 },
      { lat: 0, long: 181 },
      { lat: 'NaN', long: 0 },
      { lat: 0, long: 0, radius: 0 },
      { lat: 0, long: 0, radius: 1001 },
      { lat: 0, long: 0, unit: 'm' },
      { radius: 10 },
      { unit: 'km' },
      { sort: 'distance' },
      { bbox: '1,2,3' },
      { bbox: '1,4,3,2' },
      { bbox: '1,2,3,4', lat: 0, long: 0 },
    ]) {
      expect(() => parseGeoQuery(raw)).toThrow();
    }
    expect(geoQueryFields({ bbox: '170,-10,-170,10' })).toEqual({ bbox: [170, -10, -170, 10] });
  });
});

describe('database geo filtering', () => {
  test('police announcements match the linked California radius by jurisdiction, and stay out of incident-only feeds', async () => {
    const city = POLICE_CITIES.find((c) => c.name === 'Palo Alto');
    const update = policeItem({ title: 'Police advisory', publishedAt: '2026-09-01' }, city);
    const id = await item(update.data, { kind: update.kind });
    const options = {
      collectionId: crime,
      lat: 37.243507,
      long: -121.942648,
      radius: 100,
      db: sql,
    };
    const rows = await q.recentItems(options);
    expect(rows.map((r) => Number(r.id))).toContain(id);
    expect(rows.find((r) => Number(r.id) === id).data.location_precision).toBe('jurisdiction');
    const incidentFeed = { collection_id: crime, query: { ...options, kinds: ['crime-report'] } };
    delete incidentFeed.query.db;
    expect((await q.feedItems(incidentFeed, { db: sql })).map((r) => Number(r.id))).not.toContain(
      id,
    );
  });
  test('existing coordinate shapes, malformed values and unknown locations', async () => {
    for (const d of [
      near,
      { lat: '41.881', longitude: '-87.62' },
      { location: { latitude: 41.881, lng: -87.62 } },
      { geometry: { type: 'Point', coordinates: [-87.62, 41.881] } },
    ]) {
      const row = await one('select ndb_geo_distance($1::jsonb,-87.62,41.88) as d', [
        JSON.stringify(d),
      ]);
      expect(row.d).toBeCloseTo(111.195, 2);
    }
    for (const d of [
      {},
      { place: { lat: null, lon: null } },
      { lat: '', lon: ' ' },
      { lat: 'REDACTED', lon: 2 },
      { lat: 100, lon: 0 },
      { lat: 'Infinity', lon: 0 },
      { geometry: { type: 'Point', coordinates: ['bad', 0] } },
      { coverage: { type: 'Unknown' }, ...near },
    ]) {
      expect((await one('select ndb_geo_box($1::jsonb) as b', [JSON.stringify(d)])).b).toBeNull();
    }
  });
  test('radius filters run before limits across collections; distances sort and paginate', async () => {
    const nearId = await item(near);
    const closeId = await item({ lat: 41.88, lon: -87.62 }, { collection: weather });
    for (let i = 0; i < 4; i++) await item(far);
    await item({});
    const options = { ...center, radius: 1, sort: 'distance', db: sql, limit: 1 };
    expect((await q.recentItems(options)).map((r) => Number(r.id))).toEqual([closeId]);
    expect((await q.recentItems({ ...options, offset: 1 })).map((r) => Number(r.id))).toEqual([
      nearId,
    ]);
    expect(
      (await q.recentItems({ ...options, collectionId: crime })).map((r) => Number(r.id)),
    ).toEqual([nearId]);
    expect((await q.recentItems({ db: sql, limit: 1 }))[0].data).toEqual({});
    await expect(q.recentItems({ ...options, beforeId: 100 })).rejects.toThrow('offset');
  });
  test('miles conversion and exact radius excludes bbox corner', async () => {
    const edge = await item({ lat: 41.9, lon: -87.62 });
    expect(
      (await q.recentItems({ ...center, radius: 2, unit: 'km', db: sql })).some(
        (r) => Number(r.id) === edge,
      ),
    ).toBe(false);
    expect(
      (await q.recentItems({ ...center, radius: 2, unit: 'mi', db: sql })).some(
        (r) => Number(r.id) === edge,
      ),
    ).toBe(true);
    const corner = await item({ lat: 41.888, lon: -87.61 });
    expect(
      (await q.recentItems({ ...center, radius: 1, db: sql })).some((r) => Number(r.id) === corner),
    ).toBe(false);
  });
  test('antimeridian and polar radius searches', async () => {
    const dateline = await item({ lat: 0, lon: -179.99 });
    expect(
      (await q.recentItems({ lat: 0, long: 179.99, radius: 5, db: sql })).map((r) => Number(r.id)),
    ).toContain(dateline);
    expect(
      (await q.recentItems({ bbox: '179,-1,-179,1', db: sql })).map((r) => Number(r.id)),
    ).toContain(dateline);
    const pole = await item({ lat: 89.99, lon: 170 });
    expect(
      (await q.recentItems({ lat: 89.99, long: -10, radius: 5, db: sql })).map((r) => Number(r.id)),
    ).toContain(pole);
  });
  test('coverage supersedes a distant receiver, holes and multiple polygons work', async () => {
    const scanner = await item(
      { coverage: circle, place: { lat: 0, lon: 0 } },
      { kind: 'scanner-stream' },
    );
    expect(
      (await q.recentItems({ ...center, radius: 1, kind: 'scanner-stream', db: sql })).map((r) =>
        Number(r.id),
      ),
    ).toContain(scanner);
    expect(
      (
        await one('select ndb_geo_distance($1::jsonb,-87.62,41.88) as d', [
          JSON.stringify({ coverage: polygon }),
        ])
      ).d,
    ).toBe(0);
    const hole = [
      [-87.625, 41.875],
      [-87.615, 41.875],
      [-87.615, 41.885],
      [-87.625, 41.885],
      [-87.625, 41.875],
    ];
    const hollow = { type: 'Polygon', coordinates: [...polygon.coordinates, hole] };
    expect(
      (
        await one('select ndb_geo_distance($1::jsonb,-87.62,41.88) as d', [
          JSON.stringify({ coverage: hollow }),
        ])
      ).d,
    ).toBeGreaterThan(400);
    const multi = { type: 'MultiPolygon', coordinates: [polygon.coordinates] };
    expect(
      (
        await one('select ndb_geo_distance($1::jsonb,-87.62,41.88) as d', [
          JSON.stringify({ coverage: multi }),
        ])
      ).d,
    ).toBe(0);
  });
  test('crossing polygon containment does not match the opposite hemisphere', async () => {
    const coverage = {
      type: 'Polygon',
      coordinates: [
        [
          [179, -1],
          [-179, -1],
          [-179, 1],
          [179, 1],
          [179, -1],
        ],
      ],
    };
    expect(
      (await one('select ndb_geo_distance($1::jsonb,180,0) as d', [JSON.stringify({ coverage })]))
        .d,
    ).toBe(0);
    expect(
      (await one('select ndb_geo_distance($1::jsonb,0,0) as d', [JSON.stringify({ coverage })])).d,
    ).toBeGreaterThan(19000000);
  });
  test('saved feed geography is intersected; notifications preserve id cursor order', async () => {
    const a = await item({ lat: 41.881, lon: -87.62 }, { at: '2099-01-03' });
    const b = await item({ lat: 41.88, lon: -87.62 }, { at: '2099-01-01' });
    const feed = {
      collection_id: crime,
      query: { ...center, radius: 1, sort: 'distance', upcoming: true },
    };
    const delivered = await q.feedItems(feed, { db: sql, afterId: a - 1 });
    expect(delivered.map((r) => Number(r.id))).toEqual([a, b]);
    expect((await q.feedItems(feed, { db: sql }))[0].id).toBe(b);
    expect(await q.feedItems(feed, { db: sql, lat: 0, long: 0, radius: 10 })).toEqual([]);
    await expect(q.feedItems(feed, { db: sql, beforeId: b })).rejects.toThrow('offset');
  });
  test('search/upcoming/match use the same geographic filter', async () => {
    const id = await item(near, { at: '2099-01-01', title: 'Unique geographic marker' });
    await item(far, { at: '2099-01-01', title: 'Unique geographic marker' });
    for (const rows of [
      await q.searchItems('Unique geographic', { ...center, radius: 1, db: sql }),
      await q.upcomingItems({ ...center, radius: 1, days: 40000, db: sql }),
      await q.matchItems('Unique geographic marker', { ...center, radius: 1, db: sql }),
    ]) {
      expect(rows.map((r) => Number(r.id))).toContain(id);
      expect(rows.every((r) => r.distance_m <= 1000)).toBe(true);
    }
  });
  test('crime context uses coverage, date window, incident kinds and location precision', async () => {
    const id = await item({ ...near, locationBasis: 'anonymised-map-point' }, { at: '2026-09-01' });
    await item(near, { kind: 'crime-estimate', at: '2026-09-01' });
    await item(far, { at: '2026-09-01' });
    const rows = await q.nearbyCrime(
      { data: { coverage: circle } },
      { db: sql, from: '2026-09-01', to: '2026-09-02' },
    );
    expect(rows.map((r) => Number(r.id))).toEqual([id]);
    expect(rows[0].data.locationBasis).toBe('anonymised-map-point');
    expect(await q.nearbyCrime({ data: {} }, { db: sql })).toEqual([]);
  });
  test('expression index is available to geographic queries', async () => {
    await db.exec('set enable_seqscan=off');
    const rows = (
      await db.query(
        'explain select id from items where ndb_geo_box(data) is not null and ndb_geo_box(data) && ndb_radius_box(-87.62,41.88,1000)',
      )
    ).rows;
    expect(JSON.stringify(rows)).toContain('items_geo_box_idx');
    await db.exec('reset enable_seqscan');
  });
});

describe('permissioned scanner adapter', () => {
  const row = {
    id: 'scanner-1',
    name: 'Community dispatch',
    provider: 'Operator',
    access_terms: 'Permission to index',
    player_url: 'https://example.com/listen',
    coverage: circle,
  };
  test('streams require explicit permission; player links and source attribution remain', () => {
    const i = toItem({ ...row, stream_url: 'https://example.com/audio.mp3' });
    expect(i.data.stream_url).toBeNull();
    expect(i.data.coverage_basis).toBe('approximate-radius');
    expect(
      toItem({ ...row, stream_url: 'https://example.com/audio.mp3', stream_reuse_allowed: true })
        .data.stream_url,
    ).toBe('https://example.com/audio.mp3');
    expect(toItem({ ...row, player_url: 'javascript:alert(1)' })).toBeNull();
    expect(toItem({ ...row, access_terms: '' })).toBeNull();
  });
  test('invalid coverage stays unknown and receiver coordinates do not substitute', () => {
    expect(validCoverage(polygon)).toBe(true);
    expect(
      validCoverage({
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
          ],
        ],
      }),
    ).toBe(false);
    expect(toItem({ ...row, coverage: null, lat: 1, long: 2 }).data.coverage).toBeNull();
  });
});

test('bounded enrichment preserves round-robin selection across collections', async () => {
  await item({}, { collection: crime });
  await item({}, { collection: weather });
  await item({}, { collection: weather });
  const { rows: expected } = await db.query(`
    select id from (
      select id, row_number() over (partition by collection_id order by id desc) rn
      from items where enriched_at is null
    ) ranked where rn <= 2 order by rn, id desc limit 5
  `);
  const actual = await q.itemsNeedingEnrichment({ limit: 5, perCollection: 2, db: sql });
  expect(actual.map((row) => String(row.id))).toEqual(expected.map((row) => String(row.id)));
  expect(await q.itemsNeedingEnrichment({ limit: 0, db: sql })).toEqual([]);
});
