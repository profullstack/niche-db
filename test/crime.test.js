import { describe, expect, test } from 'bun:test';

import { toItem as fbiItem, rate, stateName } from '../packages/adapters/src/fbicrime.js';
import { ADAPTERS, adapterByName } from '../packages/adapters/src/index.js';
import {
  CITIES,
  CITY_KEYS,
  categorise,
  crimeDate,
  placeFor,
  toItem as socrataItem,
} from '../packages/adapters/src/socratacrime.js';
import { UK_PLACES, toItem as ukItem } from '../packages/adapters/src/ukpolice.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';
const { COLLECTIONS, DEFAULT_FEEDS } = await import('../packages/core/src/seed.js');

describe('the crime collection', () => {
  test('exists, and every crime adapter is registered in it', () => {
    expect(COLLECTIONS.map((c) => c.slug)).toContain('crime');
    for (const n of ['socrata-crime', 'uk-police-crime', 'fbi-crime-estimates']) {
      expect(adapterByName(n)?.collection).toBe('crime');
    }
  });

  test('only the FBI adapter needs a key, so the incident feeds run on a bare deployment', () => {
    expect(adapterByName('fbi-crime-estimates').needsEnv).toEqual(['dataGovApiKey']);
    expect(adapterByName('socrata-crime').needsEnv ?? []).toEqual([]);
    expect(adapterByName('uk-police-crime').needsEnv ?? []).toEqual([]);
  });

  test('there is a feed per place, generated from the lists the sources come from', () => {
    // Written by hand these would drift the first time a city was added to an
    // adapter and not to the seed, so they are generated and cannot disagree.
    const slugs = new Set(DEFAULT_FEEDS.filter((f) => f.collection === 'crime').map((f) => f.slug));
    for (const key of CITY_KEYS) expect(slugs).toContain(`crime-${key}`);
    for (const p of UK_PLACES) expect(slugs).toContain(`crime-uk-${p.key}`);
  });

  test('a per-place feed queries the tag its adapter actually stamps', () => {
    const chicago = socrataItem(
      {
        id: '1',
        date: '2026-08-30T12:00:00.000',
        primary_type: 'THEFT',
        description: 'RETAIL',
        block: '001XX N STATE ST',
      },
      placeFor({ city: 'chicago' }),
    );
    const feed = DEFAULT_FEEDS.find((f) => f.slug === 'crime-chicago');
    for (const tag of feed.query.tags) expect(chicago.tags).toContain(tag);
  });

  test('every crime feed queries a kind some crime adapter emits', () => {
    const emitted = new Set(
      ADAPTERS.filter((a) => a.collection === 'crime').flatMap((a) => a.kinds),
    );
    for (const f of DEFAULT_FEEDS.filter((f) => f.collection === 'crime')) {
      for (const kind of f.query.kinds ?? []) expect(emitted).toContain(kind);
    }
  });

  test('no two feeds share a slug, which the schema requires globally', () => {
    const slugs = DEFAULT_FEEDS.map((f) => f.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});

describe('city crime portals', () => {
  test('every preset records when it last actually had data', () => {
    // A portal that stops publishing does not announce it and looks exactly
    // like a quiet week, so each preset carries what it returned when written.
    for (const [key, c] of Object.entries(CITIES)) {
      expect(c.newestSeen, key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(c.domain, key).toBeTruthy();
      expect(c.dataset, key).toBeTruthy();
    }
  });

  test('a config can describe a city nobody has added, with no preset at all', () => {
    const place = placeFor({
      cityName: 'Testville',
      state: 'ZZ',
      domain: 'data.example.gov',
      dataset: 'abcd-efgh',
      idField: 'the_id',
      dateField: 'when',
      offenseField: 'what',
    });
    expect(place.city).toBe('Testville');
    expect(place.dataset).toBe('abcd-efgh');
    expect(place.idField).toBe('the_id');
  });

  test('a config field overrides its preset', () => {
    expect(placeFor({ city: 'chicago' }).dataset).toBe('ijzp-q8t2');
    expect(placeFor({ city: 'chicago', dataset: 'zzzz-zzzz' }).dataset).toBe('zzzz-zzzz');
  });

  test('the coarse category is comparable between cities that word things differently', () => {
    expect(categorise('THEFT')).toBe('theft');
    expect(categorise('Larceny-Theft')).toBe('theft');
    expect(categorise('459.5(A) - PC - M - Petty Theft - Shoplifting - 23C')).toBe('theft');
    expect(categorise('MOTOR VEHICLE THEFT')).toBe('vehicle-theft');
    expect(categorise('CRIMINAL DAMAGE')).toBe('vandalism');
    expect(categorise('something nobody mapped')).toBe('other');
  });

  test('the department’s own wording survives beside the coarse category', () => {
    const i = socrataItem(
      {
        id: '1',
        date: '2026-08-30T12:00:00.000',
        primary_type: 'MOTOR VEHICLE THEFT',
        description: 'AUTOMOBILE',
        block: '001XX N STATE ST',
        latitude: '41.88',
        longitude: '-87.62',
        community_area: '32',
      },
      placeFor({ city: 'chicago' }),
    );
    expect(i.data.category).toBe('vehicle-theft');
    expect(i.data.offense).toBe('MOTOR VEHICLE THEFT');
    expect(i.data.categoryBasis).toBe('nichedb-coarse-mapping');
    expect(i.data.categoryNote).toContain('authoritative');
  });

  test('every row carries the same place shape whatever portal it came from', () => {
    const i = socrataItem(
      {
        id: '1',
        date: '2026-08-30T12:00:00.000',
        primary_type: 'THEFT',
        block: '001XX N STATE ST',
        latitude: '41.88',
        longitude: '-87.62',
        community_area: '32',
      },
      placeFor({ city: 'chicago' }),
    );
    expect(i.data.place).toEqual({
      country: 'US',
      state: 'IL',
      city: 'Chicago',
      area: '32',
      address: '001XX N STATE ST',
      lat: 41.88,
      lon: -87.62,
    });
    expect(i.tags).toContain('il');
    expect(i.tags).toContain('chicago');
  });

  test('a redacted or sentinel coordinate is absent, not a point in the ocean', () => {
    // Seattle publishes the string REDACTED for about a quarter of its rows and
    // -1 for a few dozen more. -1 is finite, and would have pinned hundreds of
    // Seattle crimes to a spot in the Atlantic.
    const place = placeFor({ city: 'seattle' });
    const at = (latitude, longitude) =>
      socrataItem(
        {
          offense_id: '1',
          offense_date: '2026-09-06T21:02:00.000',
          offense_category: 'ASSAULT',
          latitude,
          longitude,
        },
        place,
      ).data.place;
    expect(at('REDACTED', 'REDACTED').lat).toBeNull();
    expect(at('-1', '-1').lat).toBeNull();
    expect(at('0', '0').lat).toBeNull();
    expect(at('999', '999').lat).toBeNull();
    expect(at('47.61', '-122.33').lat).toBe(47.61);
  });

  test('a portal’s placeholder text is not published as an address', () => {
    const i = socrataItem(
      {
        offense_id: '1',
        offense_date: '2026-09-06T21:02:00.000',
        offense_category: 'ASSAULT',
        block_address: 'FK ERROR',
      },
      placeFor({ city: 'seattle' }),
    );
    expect(i.data.place.address).toBeNull();
    expect(i.title).not.toContain('FK ERROR');
  });

  test('one incident with several charges is several rows, not one that overwrites itself', () => {
    // Cincinnati has no unique column: 2026-INC-017450 covers a burglary, a
    // strangulation and a Part 2 offence, and keying on the incident number
    // alone collapsed all three into one row.
    const place = placeFor({ city: 'cincinnati' });
    const row = (stars_category) => ({
      incident_no: '2026-INC-017450',
      datereported: '2026-09-02T21:23:00.000',
      stars_category,
      type: 'x',
    });
    const ids = ['Burglary/BE', 'Strangulation', 'Part 2'].map(
      (c) => socrataItem(row(c), place).externalId,
    );
    expect(new Set(ids).size).toBe(3);
    // And the same charge read twice is still the same row.
    expect(socrataItem(row('Burglary/BE'), place).externalId).toBe(ids[0]);
  });

  test('Dallas is keyed per offence, because its incident number is not unique', () => {
    expect(CITIES.dallas.idField).toBe('servnumid');
  });

  test('two cities issuing the same case number stay two rows', () => {
    const a = socrataItem(
      { id: '7', date: '2026-08-30T12:00:00.000', primary_type: 'THEFT' },
      placeFor({ city: 'chicago' }),
    );
    const b = socrataItem(
      { offense_id: '7', offense_date: '2026-08-30T12:00:00.000', offense_category: 'THEFT' },
      placeFor({ city: 'seattle' }),
    );
    expect(a.externalId).not.toBe(b.externalId);
  });

  test('portals write dates half a dozen ways', () => {
    expect(crimeDate('2026-08-30T12:00:00.000')).toBe('2026-08-30T12:00:00');
    expect(crimeDate('2026-09-06 00:00:00.0000000')).toBe('2026-09-06T00:00:00');
    expect(crimeDate('12/31/2025  23:59')).toBe('2025-12-31T23:59:00');
    expect(crimeDate('2026-08-30')).toBe('2026-08-30');
    expect(crimeDate('')).toBeNull();
    expect(crimeDate('not a date at all')).toBeNull();
  });

  test('a row with no date, id or offence is dropped rather than half-published', () => {
    const place = placeFor({ city: 'chicago' });
    expect(socrataItem({ date: '2026-08-30', primary_type: 'THEFT' }, place)).toBeNull();
    expect(socrataItem({ id: '1', primary_type: 'THEFT' }, place)).toBeNull();
    expect(socrataItem({ id: '1', date: '2026-08-30' }, place)).toBeNull();
  });

  test('the item survives normalisation', () => {
    const n = normaliseItem(
      socrataItem(
        { id: '1', date: '2026-08-30T12:00:00.000', primary_type: 'THEFT' },
        placeFor({ city: 'chicago' }),
      ),
    );
    expect(n).not.toBeNull();
    expect(n.kind).toBe('crime-report');
  });
});

describe('UK street-level crime', () => {
  const place = UK_PLACES[0];
  const crime = (over = {}) => ({
    category: 'violent-crime',
    persistent_id: 'abc123',
    location_type: 'Force',
    location: {
      latitude: '51.512802',
      longitude: '-0.115772',
      street: { id: 1, name: 'On or near James Street' },
    },
    outcome_status: { category: 'Under investigation', date: '2026-07' },
    ...over,
  });

  test('a UK row carries the same place shape a US row does', () => {
    const i = ukItem(crime(), place, '2026-07');
    expect(i.data.place.country).toBe('GB');
    expect(i.data.place.city).toBe('London');
    // Force areas fill the same slot as US states, so filtering by region does
    // not need to know which country a row came from.
    expect(i.data.place.state).toBe('Greater London');
    expect(i.data.place.lat).toBeCloseTo(51.5128, 3);
  });

  test('UK categories map onto the same coarse vocabulary the US rows use', () => {
    expect(ukItem(crime(), place, '2026-07').data.category).toBe('assault');
    expect(ukItem(crime({ category: 'shoplifting' }), place, '2026-07').data.category).toBe(
      'theft',
    );
    expect(ukItem(crime({ category: 'vehicle-crime' }), place, '2026-07').data.category).toBe(
      'vehicle-theft',
    );
    // And the API's own word is kept beside it.
    expect(ukItem(crime(), place, '2026-07').data.ukCategory).toBe('violent-crime');
  });

  test('the fuzzed location is labelled as fuzzed', () => {
    // The coordinates look precise to six decimal places and are an anonymised
    // map point, not the scene. A reader treating them as an address would be
    // wrong in a way the numbers do not show.
    const i = ukItem(crime(), place, '2026-07');
    expect(i.data.locationBasis).toBe('anonymised-map-point');
    expect(i.data.locationNote).toContain('never the address');
  });

  test('a month is a month, not the first of it pretending to be a day', () => {
    const i = ukItem(crime(), place, '2026-07');
    expect(i.publishedAt).toBe('2026-07-01');
    expect(i.precision).toBe('month');
    expect(i.timeKnown).toBe(false);
  });

  test('an outcome is carried, and its absence is said rather than implied', () => {
    expect(ukItem(crime(), place, '2026-07').data.outcome).toBe('Under investigation');
    const none = ukItem(crime({ outcome_status: null }), place, '2026-07');
    expect(none.data.outcome).toBeNull();
    expect(none.tags).toContain('no-outcome');
    expect(none.summary).toContain('No outcome');
  });

  test('a row with no persistent id still gets a stable one', () => {
    const a = ukItem(crime({ persistent_id: '', id: 99 }), place, '2026-07');
    const b = ukItem(crime({ persistent_id: '', id: 99 }), place, '2026-07');
    expect(a.externalId).toBe(b.externalId);
  });
});

describe('FBI state estimates', () => {
  test('a rate per 100,000 is what makes two states comparable', () => {
    expect(rate(1000, 1_000_000)).toBe(100);
    expect(rate(1000, 0)).toBeNull();
    expect(rate(null, 1000)).toBeNull();
  });

  test('a state code becomes a name people recognise', () => {
    expect(stateName('CA')).toBe('California');
    expect(stateName('DC')).toBe('District of Columbia');
    expect(stateName('ZZ')).toBe('ZZ');
  });

  test('an estimate is labelled as an estimate, not as a count of incidents', () => {
    const i = fbiItem(
      { data_year: '2023', violent_crime: 100_000, population: 39_000_000 },
      { state: 'CA', offense: 'violent_crime' },
    );
    expect(i.kind).toBe('crime-estimate');
    expect(i.data.basis).toBe('fbi-estimate');
    expect(i.data.note).toContain('not a count of incidents');
    expect(i.data.per100k).toBe(256.4);
    expect(i.publishedAt).toBe('2023-12-31');
    expect(i.precision).toBe('year');
  });

  test('a row with no usable year or count is dropped', () => {
    expect(fbiItem({ violent_crime: 1 }, { state: 'CA', offense: 'violent_crime' })).toBeNull();
    expect(fbiItem({ data_year: '2023' }, { state: 'CA', offense: 'violent_crime' })).toBeNull();
  });
});
