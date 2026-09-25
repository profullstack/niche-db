import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cityItem, divisionItem } from '../packages/adapters/src/geonames-cities.js';
import { countryItem } from '../packages/adapters/src/worldbank-population.js';
import { normaliseItem } from '../packages/core/src/adapter.js';
import { migratedPglite, pgliteSql } from './helpers/pglite.js';

process.env.DATABASE_URL ??= 'postgres://localhost/unused';
const { areaByKey, areasIn, areasNamed, childCounts, populationStats } = await import(
  '../packages/db/src/population.js'
);
const { areaItem } = await import('../packages/adapters/src/census-acs.js');

/*
 * The drill-down reads against a migrated Postgres, with rows exactly as the
 * three adapters write them: a country from the World Bank, a state, two
 * cities and three ZIPs from the ACS, and a division and a city from GeoNames.
 */

let pg;
let db;

const acs = (rec, population) =>
  areaItem({ lat: null, long: null, alandSqmi: null, raw: { population }, ...rec }, 2024);

const ROWS = () => [
  countryItem({
    country: { iso2: 'US', iso3: 'USA', name: 'United States', lat: 38.9, long: -77 },
    stats: { measures: { population: 340_000_000 }, years: { population: 2025 }, series: {} },
    source: 'worldbank',
  }),
  countryItem({
    country: { iso2: 'GB', iso3: 'GBR', name: 'United Kingdom', lat: 51.5, long: -0.1 },
    stats: { measures: { population: 69_000_000 }, years: { population: 2025 }, series: {} },
    source: 'worldbank',
  }),
  acs(
    {
      level: 'state',
      geoId: '0400000US06',
      key: 'us-ca',
      name: 'California',
      state: 'CA',
      stateKey: 'us-ca',
      ancestors: ['us'],
    },
    39_287_377,
  ),
  acs(
    {
      level: 'city',
      geoId: '1600000US0644000',
      key: 'us-ca-los-angeles',
      name: 'Los Angeles',
      state: 'CA',
      stateKey: 'us-ca',
      ancestors: ['us', 'us-ca'],
    },
    3_857_263,
  ),
  acs(
    {
      level: 'city',
      geoId: '1600000US0667000',
      key: 'us-ca-san-francisco',
      name: 'San Francisco',
      state: 'CA',
      stateKey: 'us-ca',
      ancestors: ['us', 'us-ca'],
    },
    836_321,
  ),
  acs(
    {
      level: 'zip',
      geoId: '860Z200US90210',
      key: 'us-90210',
      name: '90210',
      zip: '90210',
      state: 'CA',
      stateKey: 'us-ca',
      cityKey: 'us-ca-los-angeles',
      cityName: 'Los Angeles',
      ancestors: ['us', 'us-ca', 'us-ca-los-angeles'],
    },
    19_004,
  ),
  acs(
    {
      level: 'zip',
      geoId: '860Z200US90011',
      key: 'us-90011',
      name: '90011',
      zip: '90011',
      state: 'CA',
      stateKey: 'us-ca',
      cityKey: 'us-ca-los-angeles',
      cityName: 'Los Angeles',
      ancestors: ['us', 'us-ca', 'us-ca-los-angeles'],
    },
    103_625,
  ),
  acs(
    {
      level: 'zip',
      geoId: '860Z200US93501',
      key: 'us-93501',
      name: '93501',
      zip: '93501',
      state: 'CA',
      stateKey: 'us-ca',
      ancestors: ['us', 'us-ca'],
    },
    3_000,
  ),
  divisionItem({
    code: 'GB.ENG',
    key: 'gb-england',
    info: { name: 'England', asciiName: 'England', geonameId: '6269131' },
    countryName: 'United Kingdom',
    cities: [{ population: 8_961_989 }],
  }),
  cityItem(
    {
      id: '2643743',
      name: 'London',
      asciiName: 'London',
      lat: 51.5,
      long: -0.12,
      featureCode: 'PPLC',
      country: 'GB',
      population: 8_961_989,
      modified: '2025-01-10',
    },
    {
      key: 'gb-england-london',
      stateKey: 'gb-england',
      stateName: 'England',
      countryName: 'United Kingdom',
    },
  ),
];

beforeAll(async () => {
  pg = await migratedPglite();
  db = pgliteSql(pg);
  const [{ id: cid }] =
    await db`insert into collections(slug, name) values ('population', 'Population') returning id`;
  const [{ id: sid }] = await db`
    insert into sources(collection_id, adapter, slug, name, enabled)
    values (${cid}, 'census-acs', 'population-test', 'Test', true) returning id`;
  for (const raw of ROWS()) {
    const item = normaliseItem(raw);
    await db`
      insert into items (collection_id, source_id, external_id, kind, title, summary, url, tags, data, published_at)
      values (${cid}, ${sid}, ${item.externalId}, ${item.kind}, ${item.title}, ${item.summary}, ${item.url},
              ${item.tags}, ${JSON.stringify(item.data)}::jsonb, ${item.publishedAt})`;
  }
}, 60_000);

afterAll(async () => pg?.close());

describe('the population tree in Postgres', () => {
  test('an area is found by its key', async () => {
    const row = await areaByKey('us-ca-los-angeles', { db });
    expect(row.title).toBe('Los Angeles, CA');
    expect(row.data.population).toBe(3_857_263);
    expect(await areaByKey('us-ca-nowhere', { db })).toBeNull();
  });

  test('children are the level asked for, inside the area asked for, largest first', async () => {
    const cities = await areasIn({ within: 'us-ca', level: 'city', db });
    expect(cities.total).toBe(2);
    expect(cities.areas.map((a) => a.data.key)).toEqual([
      'us-ca-los-angeles',
      'us-ca-san-francisco',
    ]);

    // A ZIP list at the state includes the rural ZIP that has no city.
    const zipsInState = await areasIn({ within: 'us-ca', level: 'zip', db });
    expect(zipsInState.areas.map((a) => a.data.zip)).toEqual(['90011', '90210', '93501']);
    const zipsInCity = await areasIn({ within: 'us-ca-los-angeles', level: 'zip', db });
    expect(zipsInCity.total).toBe(2);

    const countries = await areasIn({ level: 'country', db });
    expect(countries.areas.map((a) => a.data.key)).toEqual(['us', 'gb']);
  });

  test('paging keeps the total and moves the window', async () => {
    const page = await areasIn({ within: 'us-ca', level: 'zip', limit: 1, offset: 1, db });
    expect(page.total).toBe(3);
    expect(page.areas.map((a) => a.data.zip)).toEqual(['90210']);
  });

  test('a division with no published total sorts after the ones with a number', async () => {
    const states = await areasIn({ level: 'state', db });
    expect(states.areas.map((a) => a.data.key)).toEqual(['us-ca', 'gb-england']);
    expect(states.areas[1].data.population).toBeNull();
  });

  test('counts per level for the tabs', async () => {
    expect(await childCounts('us', { db })).toEqual({ country: 0, state: 1, city: 2, zip: 3 });
    expect(await childCounts('gb', { db })).toEqual({ country: 0, state: 1, city: 1, zip: 0 });
    expect(await populationStats({ db })).toEqual({ country: 2, state: 2, city: 3, zip: 3 });
  });

  test('a name finds every place called it', async () => {
    const found = await areasNamed('London', { db });
    expect(found.map((r) => r.data.key)).toEqual(['gb-england-london']);
    expect(await areasNamed('???', { db })).toEqual([]);
  });
});
