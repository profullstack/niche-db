import { describe, expect, test } from 'bun:test';
import {
  areaItem,
  buildRegistry,
  cityKeys,
  deriveMeasures,
  largestOverlap,
  levelOfGeoId,
  parseGazetteer,
  tableColumns,
} from '../packages/adapters/src/census-acs.js';
import {
  assignKeys,
  divisionItem,
  parseAdmin1,
  parseCity,
} from '../packages/adapters/src/geonames-cities.js';
import { adapterByName } from '../packages/adapters/src/index.js';
import {
  countriesFrom,
  countryItem,
  foldIndicator,
  parseCountryInfo,
} from '../packages/adapters/src/worldbank-population.js';
import {
  areaPath,
  areaTags,
  censusNumber,
  cleanPlaceName,
  normaliseKey,
  normaliseZip,
} from '../packages/core/src/population.js';
import { isReservedNicheSlug } from '../packages/knowledge/src/index.js';

process.env.DATABASE_URL ??= 'postgres://localhost/unused';
const { COLLECTIONS, DEFAULT_FEEDS } = await import('../packages/core/src/seed.js');
const { candidateKeys, profileOf, population } = await import(
  '../packages/enrichers/src/population.js'
);
const { measureRows, crumbsOf, areaOut } = await import('../apps/web/src/lib/population.js');
const { PopulationPage } = await import('../apps/web/src/views/population.jsx');
const { TOOLS } = await import('../apps/web/src/lib/mcp/tools.js');
const { run } = await import('../apps/cli/src/index.js');

describe('population keys and tags', () => {
  test('keys normalise to slugs and junk is refused', () => {
    expect(normaliseKey('US-CA')).toBe('us-ca');
    expect(normaliseKey('us/ca/los-angeles')).toBe('us-ca-los-angeles');
    expect(normaliseKey("'; drop table items")).toBe('droptableitems');
    expect(normaliseKey('')).toBeNull();
    expect(normaliseKey('---')).toBeNull();
  });

  test('ZIPs keep their leading zero and drop the +4', () => {
    expect(normaliseZip('02139')).toBe('02139');
    expect(normaliseZip(2139)).toBe('02139');
    expect(normaliseZip('90210-1234')).toBe('90210');
    expect(normaliseZip('SW1A 1AA')).toBeNull();
    expect(normaliseZip('Springfield')).toBeNull();
  });

  test('every ancestor is a tag, so any level can be listed from any height', () => {
    const tags = areaTags({
      key: 'us-90210',
      level: 'zip',
      ancestors: ['us', 'us-ca', 'us-ca-los-angeles'],
      name: '90210',
    });
    expect(tags).toEqual(
      expect.arrayContaining([
        'population',
        'level-zip',
        'key-us-90210',
        'in-us',
        'in-us-ca',
        'in-us-ca-los-angeles',
      ]),
    );
  });

  test('paths follow the tree, and a city with no division is served by key', () => {
    expect(areaPath({ level: 'country', key: 'us' })).toBe('/population/us');
    expect(areaPath({ level: 'state', key: 'us-ca' })).toBe('/population/us/ca');
    expect(areaPath({ level: 'city', key: 'us-ca-los-angeles', stateKey: 'us-ca' })).toBe(
      '/population/us/ca/los-angeles',
    );
    // A division slug with hyphens must not be split blindly.
    expect(
      areaPath({
        level: 'city',
        key: 'gb-northern-ireland-belfast',
        stateKey: 'gb-northern-ireland',
      }),
    ).toBe('/population/gb/northern-ireland/belfast');
    expect(areaPath({ level: 'city', key: 'sg-singapore', stateKey: null })).toBe(
      '/population/area/sg-singapore',
    );
    expect(areaPath({ level: 'zip', key: 'us-02139', zip: '02139' })).toBe('/population/zip/02139');
  });
});

describe('Census Summary File traps', () => {
  test('sentinels are missing values, not numbers', () => {
    expect(censusNumber('-666666666')).toBeNull();
    expect(censusNumber('-555555555')).toBeNull();
    expect(censusNumber('-222222222')).toBeNull();
    expect(censusNumber('')).toBeNull();
    expect(censusNumber('0')).toBe(0);
    expect(censusNumber('81939')).toBe(81939);
  });

  test('place names lose their legal description', () => {
    expect(cleanPlaceName('Los Angeles city')).toBe('Los Angeles');
    expect(cleanPlaceName('Abanda CDP')).toBe('Abanda');
    expect(cleanPlaceName('Juneau city and borough')).toBe('Juneau');
    expect(cleanPlaceName('Nashville-Davidson metropolitan government (balance)')).toBe(
      'Nashville-Davidson',
    );
    expect(cleanPlaceName('Boise City city')).toBe('Boise City');
    expect(cleanPlaceName('Carson City')).toBe('Carson City');
    expect(cleanPlaceName('Aguadilla zona urbana')).toBe('Aguadilla');
  });

  test('GEO_ID prefixes pick the three levels kept and nothing else', () => {
    expect(levelOfGeoId('0400000US06')).toBe('state');
    expect(levelOfGeoId('1600000US0644000')).toBe('city');
    expect(levelOfGeoId('860Z200US90210')).toBe('zip');
    expect(levelOfGeoId('1500000US060371234001')).toBeNull();
    expect(levelOfGeoId('0100000US')).toBeNull();
  });

  test('a missing column is an error, not a year of nulls', () => {
    expect(tableColumns('b19013', 'GEO_ID|B19013_E001|B19013_M001')).toEqual({
      1: 'medianHouseholdIncome',
    });
    expect(() => tableColumns('b19013', 'GEO_ID|B19013_E002')).toThrow(/B19013_E001/);
  });

  test('top-coded medians become a flagged floor, and rates need their base', () => {
    const m = deriveMeasures({
      medianHouseholdIncome: 250001,
      medianHomeValue: 2000001,
      medianGrossRent: 1800,
      _povertyUniverse: 1000,
      _belowPoverty: 125,
      _occupied: 0,
      _ownerOccupied: 0,
      _laborForce: null,
      _unemployed: 30,
    });
    expect(m.medianHouseholdIncome).toBe(250000);
    expect(m.medianHomeValue).toBe(2000000);
    expect(m.medianGrossRent).toBe(1800);
    expect(m.topCoded).toEqual(['medianHouseholdIncome', 'medianHomeValue']);
    expect(m.povertyRate).toBe(12.5);
    // A zero or missing base is no rate at all, not 0%.
    expect(m.ownerOccupiedRate).toBeUndefined();
    expect(m.unemploymentRate).toBeUndefined();
  });

  test('relationship files: BOM, rows outside every ZCTA, and the largest overlap wins', () => {
    const text = [
      '﻿OID_ZCTA5_20|GEOID_ZCTA5_20|NAMELSAD_ZCTA5_20|AREALAND_ZCTA5_20|AREAWATER_ZCTA5_20|MTFCC_ZCTA5_20|CLASSFP_ZCTA5_20|FUNCSTAT_ZCTA5_20|OID_PLACE_20|GEOID_PLACE_20|NAMELSAD_PLACE_20|AREALAND_PLACE_20|AREAWATER_PLACE_20|MTFCC_PLACE_20|CLASSFP_PLACE_20|FUNCSTAT_PLACE_20|AREALAND_PART|AREAWATER_PART',
      '||||||||1|0101852|Anniston city|1|0|G4110|C1|A|9974104|0',
      '1|90210|ZCTA5 90210|1000|0|G6350|B5|S|2|0644000|Los Angeles city|1|0|G4110|C1|A|605|0',
      '1|90210|ZCTA5 90210|1000|0|G6350|B5|S|3|0606308|Beverly Hills city|1|0|G4110|C1|A|395|0',
    ].join('\n');
    const best = largestOverlap(text, 'GEOID_PLACE_20');
    expect(best.size).toBe(1);
    expect(best.get('90210')).toEqual({ geoId: '0644000', part: 605, share: 0.605 });
  });

  test('two places with one name in a state do not share a key', () => {
    const keys = cityKeys([
      { geoid: '0612345', name: 'Springfield', stateKey: 'us-ca' },
      { geoid: '0600001', name: 'Springfield', stateKey: 'us-ca' },
      { geoid: '1700002', name: 'Springfield', stateKey: 'us-il' },
    ]);
    expect(keys.get('0600001')).toBe('us-ca-springfield');
    expect(keys.get('0612345')).toBe('us-ca-springfield-12345');
    expect(keys.get('1700002')).toBe('us-il-springfield');
  });

  test('a ZIP goes under the city holding its land, and never across a state line', () => {
    const places = parseGazetteer(
      [
        'USPS\tGEOID\tANSICODE\tNAME\tLSAD\tFUNCSTAT\tALAND\tAWATER\tALAND_SQMI\tAWATER_SQMI\tINTPTLAT\tINTPTLONG    ',
        'CA\t0644000\t1\tLos Angeles city\t25\tA\t1\t1\t470.52\t1\t34.019394\t-118.410825   ',
        'NV\t3240000\t1\tLas Vegas city\t25\tA\t1\t1\t141.8\t1\t36.2\t-115.2   ',
      ].join('\n'),
    );
    const zctas = parseGazetteer(
      [
        'GEOID\tALAND\tAWATER\tALAND_SQMI\tAWATER_SQMI\tINTPTLAT\tINTPTLONG',
        '90210\t1\t1\t10.748\t0\t34.1\t-118.4',
        '96107\t1\t1\t500\t0\t38.5\t-119.5',
        '93501\t1\t1\t300\t0\t35.0\t-118.2',
      ].join('\n'),
    );
    const zctaPlace = new Map([
      ['90210', { geoId: '0644000', part: 605, share: 0.605 }],
      // Mostly in California by county, but its largest place is in Nevada.
      ['96107', { geoId: '3240000', part: 400, share: 0.8 }],
      // A sliver of a place is not a city.
      ['93501', { geoId: '0644000', part: 1, share: 0.01 }],
    ]);
    const zctaCounty = new Map([
      ['90210', { geoId: '06037', part: 1, share: 1 }],
      ['96107', { geoId: '06051', part: 1, share: 1 }],
      ['93501', { geoId: '06029', part: 1, share: 1 }],
    ]);
    const reg = buildRegistry({
      places,
      zctas,
      zctaPlace,
      zctaCounty,
      levels: ['state', 'city', 'zip'],
    });
    expect(reg.get('0400000US06').key).toBe('us-ca');
    expect(reg.get('1600000US0644000').key).toBe('us-ca-los-angeles');
    expect(reg.get('860Z200US90210').ancestors).toEqual(['us', 'us-ca', 'us-ca-los-angeles']);
    expect(reg.get('860Z200US96107').ancestors).toEqual(['us', 'us-ca']);
    expect(reg.get('860Z200US93501').cityKey).toBeNull();

    const la = reg.get('1600000US0644000');
    la.raw = { population: 3857263, populationMoe: 151, medianHouseholdIncome: 81939 };
    const item = areaItem(la, 2024);
    expect(item.externalId).toBe('acs:city:1600000US0644000');
    expect(item.title).toBe('Los Angeles, CA');
    expect(item.data.survey).toBe('ACS 5-year 2020–2024');
    expect(item.data.location).toEqual({ lat: 34.019394, long: -118.410825 });
    expect(item.data.measures.density).toBeCloseTo(3857263 / (470.52 * 2.589988110336), 0);
    expect(item.url).toBe('https://data.census.gov/profile?g=1600000US0644000');

    // No population estimate, no row: an empty area is not an area of zero people.
    expect(areaItem(reg.get('860Z200US93501'), 2024)).toBeNull();
  });
});

describe('World Bank countries', () => {
  test('aggregates are not countries', () => {
    const c = countriesFrom([
      {
        id: 'USA',
        iso2Code: 'US',
        name: 'United States',
        region: { id: 'NAC', value: 'North America' },
        latitude: '38.8895',
        longitude: '-77.032',
      },
      { id: 'WLD', iso2Code: '1W', name: 'World', region: { id: 'NA', value: 'Aggregates' } },
      {
        id: 'AFE',
        iso2Code: 'ZH',
        name: 'Africa Eastern and Southern',
        region: { id: 'NA', value: 'Aggregates' },
      },
    ]);
    expect([...c.keys()]).toEqual(['USA']);
    expect(c.get('USA').lat).toBe(38.8895);
  });

  test('the headcount keeps its series; other indicators keep their newest year', () => {
    const acc = new Map();
    foldIndicator(acc, 'population', [
      { countryiso3code: 'USA', date: '2025', value: 340000000 },
      { countryiso3code: 'USA', date: '2024', value: 337000000 },
      { countryiso3code: 'USA', date: '2023', value: null },
    ]);
    foldIndicator(acc, 'gini', [
      { countryiso3code: 'USA', date: '2025', value: null },
      { countryiso3code: 'USA', date: '2022', value: 41.8 },
      { countryiso3code: 'USA', date: '2021', value: 39.7 },
    ]);
    const usa = acc.get('USA');
    expect(usa.series).toEqual({ 2024: 337000000, 2025: 340000000 });
    expect(usa.measures).toEqual({ population: 340000000, gini: 41.8 });
    expect(usa.years).toEqual({ population: 2025, gini: 2022 });

    const item = countryItem({
      country: { iso2: 'US', iso3: 'USA', name: 'United States', lat: 38.9, long: -77 },
      stats: { ...usa, measures: { ...usa.measures, landAreaKm2: 9147420 } },
      info: null,
      source: 'worldbank',
    });
    expect(item.data.key).toBe('us');
    expect(item.data.population).toBe(340000000);
    expect(item.data.series).toEqual([
      [2024, 337000000],
      [2025, 340000000],
    ]);
    expect(item.data.measures.density).toBeCloseTo(37.2, 1);
    expect(item.tags).toContain('key-us');
    expect(item.tags).toContain('level-country');
  });

  test('GeoNames fills the territories the World Bank does not list', () => {
    const info = parseCountryInfo(
      '#ISO\tISO3\n' +
        'TW\tTWN\t158\tTW\tTaiwan\tTaipei\t35980\t23451837\tAS\t.tw\tTWD\tDollar\t886\t\t\tzh-TW\t1668284\t\t\n',
    );
    const tw = info.get('TW');
    const item = countryItem({
      country: { iso2: 'TW', iso3: tw.iso3, name: tw.name, lat: null, long: null },
      stats: null,
      info: tw,
      source: 'geonames',
    });
    expect(item.data.population).toBe(23451837);
    expect(item.data.source).toContain('GeoNames');
    expect(item.data.measures.density).toBeCloseTo(651.8, 0);
  });
});

describe('GeoNames cities', () => {
  const line = (id, name, cc, admin1, pop) =>
    [
      id,
      name,
      name,
      '',
      '51.5',
      '-0.12',
      'P',
      'PPLC',
      cc,
      '',
      admin1,
      '',
      '',
      '',
      String(pop),
      '',
      '25',
      'Europe/London',
      '2025-01-10',
    ].join('\t');

  test('a city line parses, and 00 means no division', () => {
    const c = parseCity(line('2643743', 'London', 'GB', 'ENG', 8961989));
    expect(c).toMatchObject({ id: '2643743', country: 'GB', admin1: 'ENG', population: 8961989 });
    expect(parseCity(line('1', 'X', 'SG', '00', 5)).admin1).toBeNull();
    expect(parseCity('garbage')).toBeNull();
  });

  test('keys are unique across divisions and cities, largest city keeps the plain slug', () => {
    const admin1 = parseAdmin1('GB.ENG\tEngland\tEngland\t6269131\nSG.01\tCentral\tCentral\t1\n');
    const cities = [
      parseCity(line('1', 'Newport', 'GB', 'ENG', 25000)),
      parseCity(line('2', 'Newport', 'GB', 'ENG', 150000)),
      parseCity(line('3', 'Singapore', 'SG', '00', 5600000)),
    ];
    const { stateKeys, cityKeys: keys } = assignKeys({ cities, admin1 });
    expect(stateKeys.get('GB.ENG')).toBe('gb-england');
    expect(keys.get('2')).toBe('gb-england-newport');
    expect(keys.get('1')).toBe('gb-england-newport-1');
    expect(keys.get('3')).toBe('sg-singapore');
  });

  test('a division has no invented population, only its listed cities', () => {
    const item = divisionItem({
      code: 'GB.ENG',
      key: 'gb-england',
      info: { name: 'England', asciiName: 'England', geonameId: '6269131' },
      countryName: 'United Kingdom',
      cities: [{ population: 100 }, { population: 50 }],
    });
    expect(item.data.population).toBeNull();
    expect(item.data.listedCityPopulation).toBe(150);
    expect(item.tags).toContain('in-gb');
  });
});

describe('population enricher', () => {
  test('NPPES address: ZIP, then city, then state, then country', () => {
    const keys = candidateKeys({
      data: { address: { city: 'Los Angeles', state: 'CA', postalCode: '90210', country: 'US' } },
    });
    expect(keys).toEqual(['us-90210', 'us-ca-los-angeles', 'us-ca', 'us']);
  });

  test('OpenListing location with a ZIP+4 and a full country name', () => {
    expect(
      candidateKeys({
        data: {
          location: {
            locality: 'Boston',
            region: 'MA',
            postalCode: '02139-4307',
            country: 'United States',
          },
        },
      }),
    ).toEqual(['us-02139', 'us-ma-boston', 'us-ma', 'us']);
  });

  test('a non-US address falls back to its country and never reads a postcode as a ZIP', () => {
    expect(candidateKeys({ data: { postalCode: '10115', city: 'Berlin', country: 'DE' } })).toEqual(
      ['de'],
    );
  });

  test('nothing locatable, or a population row itself, does not apply', () => {
    expect(population.appliesTo({ data: { title: 'x' } })).toBe(false);
    expect(
      population.appliesTo({ collection_slug: 'population', data: { country: 'US', state: 'CA' } }),
    ).toBe(false);
    expect(population.collections).not.toContain('health');
  });

  test('the stored block is small and points at the page', () => {
    const block = profileOf({
      title: 'ZIP 90210',
      data: {
        key: 'us-90210',
        level: 'zip',
        zip: '90210',
        population: 19004,
        year: 2024,
        measures: { medianHouseholdIncome: 187801, households: 8000, density: 681 },
      },
    });
    expect(block.measures).toEqual({ medianHouseholdIncome: 187801, density: 681 });
    expect(block.page).toEndWith('/population/zip/90210');
  });
});

describe('registration and surfaces', () => {
  test('three adapters in one collection, and the collection is seeded once', () => {
    for (const name of ['worldbank-population', 'census-acs', 'geonames-cities']) {
      expect(adapterByName(name).collection).toBe('population');
    }
    expect(COLLECTIONS.filter((c) => c.slug === 'population')).toHaveLength(1);
    const feeds = DEFAULT_FEEDS.filter((f) => f.collection === 'population');
    expect(feeds.map((f) => f.slug)).toEqual([
      'population-countries',
      'population-us',
      'population-world-cities',
    ]);
    expect(isReservedNicheSlug('population')).toBe(true);
  });

  test('a top-coded median prints as a floor', () => {
    const rows = measureRows({
      measures: {
        medianHouseholdIncome: 250000,
        topCoded: ['medianHouseholdIncome'],
        medianAge: 41.25,
      },
    });
    expect(rows.find((r) => r.key === 'medianHouseholdIncome').value).toBe('$250,000+');
    expect(rows.find((r) => r.key === 'medianAge').value).toBe('41.3');
  });

  test('the trail runs from the world to the city a ZIP is in', () => {
    const trail = crumbsOf({
      level: 'zip',
      country: 'US',
      countryName: 'United States',
      stateKey: 'us-ca',
      stateName: 'California',
      cityKey: 'us-ca-los-angeles',
      cityName: 'Los Angeles',
    });
    expect(trail.map((t) => t.path)).toEqual([
      '/population',
      '/population/us',
      '/population/us/ca',
      '/population/us/ca/los-angeles',
    ]);
  });

  test('the page renders an area and its children', async () => {
    const row = {
      title: 'California',
      summary: 'California: 39,287,377 people.',
      data: {
        level: 'state',
        key: 'us-ca',
        name: 'California',
        country: 'US',
        countryName: 'United States',
        stateKey: 'us-ca',
        population: 39287377,
        year: 2024,
        survey: 'ACS 5-year 2020–2024',
        measures: { medianHouseholdIncome: 99122 },
      },
    };
    const child = {
      title: 'Los Angeles, CA',
      data: {
        level: 'city',
        key: 'us-ca-los-angeles',
        stateKey: 'us-ca',
        name: 'Los Angeles',
        population: 3857263,
        measures: { density: 3165.1 },
      },
    };
    const html = (
      await PopulationPage({
        user: null,
        row,
        level: 'city',
        levels: ['city', 'zip'],
        counts: { city: 1600, zip: 1760 },
        list: { total: 1600, areas: [child] },
      })
    ).toString();
    expect(html).toContain('39,287,377');
    expect(html).toContain('href="/population/us/ca/los-angeles"');
    expect(html).toContain('href="/population/us/ca?level=zip"');
    expect(html).toContain('$99,122');
    expect(html).toContain('9.8%');
  });

  test('the API shape carries the page and the API address', () => {
    const out = areaOut({ title: 'Texas', data: { level: 'state', key: 'us-tx', population: 1 } });
    expect(out.page).toEndWith('/population/us/tx');
    expect(out.api).toEndWith('/api/v1/population/us-tx');
  });

  test('the MCP tool is listed', () => {
    const tool = TOOLS.find((t) => t.name === 'population');
    expect(tool).toBeDefined();
    expect(Object.keys(tool.inputSchema.properties)).toEqual([
      'key',
      'zip',
      'q',
      'level',
      'limit',
      'offset',
    ]);
  });

  test('the CLI walks the tree by key, ZIP and name', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(new URL(url));
      return new Response(JSON.stringify({ areas: [], countries: [] }));
    };
    const quiet = { write: () => true };
    for (const args of [
      ['population'],
      ['population', 'us', 'ca', 'los-angeles', '--level', 'zip'],
      ['population', 'zip', '02139'],
      ['population', 'find', 'springfield'],
    ]) {
      await run([...args, '--api', 'https://example.test', '--json'], { fetchImpl, stdout: quiet });
    }
    expect(calls.map((u) => u.pathname + u.search)).toEqual([
      '/api/v1/population',
      '/api/v1/population/us-ca-los-angeles?level=zip',
      '/api/v1/population/zip/02139',
      '/api/v1/population/search?q=springfield',
    ]);
  });
});
