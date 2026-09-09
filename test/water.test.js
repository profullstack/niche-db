import { describe, expect, test } from 'bun:test';
import { toItem as coopsItem, exceedance } from '../packages/adapters/src/coops.js';
import {
  byClass,
  CLASSES,
  toItem as droughtItem,
  STATE_FIPS,
  worstClass,
} from '../packages/adapters/src/droughtmonitor.js';
import { ADAPTERS, adapterByName } from '../packages/adapters/src/index.js';
import {
  boxFor,
  category,
  FLOOD_CATEGORIES,
  toItem as gaugeItem,
  REGIONS,
  stage,
} from '../packages/adapters/src/nwps.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';
const { COLLECTIONS, DEFAULT_FEEDS } = await import('../packages/core/src/seed.js');

/* A gauge as the NWPS API returns one, including the sentinel it uses for a
 * reading it does not have. */
const gauge = (over = {}) => ({
  lid: 'PISt2',
  name: 'Pine Island Bayou near Sour Lake',
  wfo: { abbreviation: 'LCH', name: 'Lake Charles' },
  rfc: { abbreviation: 'WGRFC', name: 'West Gulf River Forecast Center' },
  state: { abbreviation: 'TX', name: 'Texas' },
  latitude: 30.13,
  longitude: -94.4,
  status: {
    observed: {
      primary: 25.79,
      primaryUnit: 'ft',
      secondary: -999,
      secondaryUnit: 'kcfs',
      floodCategory: 'minor',
      validTime: '2026-09-09T16:45:00Z',
    },
    forecast: {
      primary: -999,
      primaryUnit: '',
      floodCategory: 'fcst_not_current',
      validTime: '0001-01-01T00:00:00Z',
    },
  },
  ...over,
});

describe('the water collection', () => {
  test('exists, and every water adapter is registered in it', () => {
    expect(COLLECTIONS.map((c) => c.slug)).toContain('water');
    for (const name of ['nwps-river-gauges', 'coops-water-levels', 'drought-monitor']) {
      const a = adapterByName(name);
      expect(a).not.toBeNull();
      expect(a.collection).toBe('water');
    }
  });

  test('every water feed queries kinds these adapters emit', () => {
    const kinds = new Set(ADAPTERS.filter((a) => a.collection === 'water').flatMap((a) => a.kinds));
    const feeds = DEFAULT_FEEDS.filter((f) => f.collection === 'water');
    expect(feeds.length).toBeGreaterThan(0);
    for (const feed of feeds) {
      for (const kind of feed.query.kinds ?? []) expect(kinds.has(kind)).toBe(true);
    }
  });

  test('the regions tile the country, and each has a usable box', () => {
    for (const [key, region] of Object.entries(REGIONS)) {
      const [xmin, ymin, xmax, ymax] = region.bbox;
      expect(xmin).toBeLessThan(xmax);
      expect(ymin).toBeLessThan(ymax);
      expect(boxFor({ region: key })).toEqual(region.bbox);
    }
    expect(boxFor({ bbox: '-100,30,-95,35' })).toEqual([-100, 30, -95, 35]);
    expect(boxFor({ bbox: 'not,a,box' })).toBeNull();
    expect(boxFor({ region: 'atlantis' })).toBeNull();
  });
});

describe('river gauges', () => {
  test('the -999 sentinel is a missing reading, not a river below datum', () => {
    // It is finite, so Number.isFinite lets it through; only naming it stops
    // "out of service" being published as a stage of minus 999 feet.
    expect(stage(-999)).toBeNull();
    expect(stage('-999.0')).toBeNull();
    expect(stage(0)).toBe(0);
    expect(stage(25.79)).toBe(25.79);
    expect(stage(null)).toBeNull();
  });

  test('only a real flood category counts', () => {
    for (const c of FLOOD_CATEGORIES) expect(category(c)).toBe(c);
    for (const c of ['no_flooding', 'not_defined', 'obs_not_current', 'out_of_service', '']) {
      expect(category(c)).toBeNull();
    }
  });

  test('an observed gauge in flood becomes a row with the number in it', () => {
    const item = normaliseItem(gaugeItem(gauge(), 'observed'));
    expect(item.kind).toBe('river-gauge');
    expect(item.data.stage).toBe(25.79);
    expect(item.data.floodCategory).toBe('minor');
    expect(item.data.secondary).toBeNull();
    expect(item.data.place.state).toBe('TX');
    expect(item.tags).toContain('flood:minor');
    expect(item.summary).toContain('was in minor flood at 25.79 ft');
  });

  test('a forecast with no reading and a year-zero timestamp is not a row', () => {
    expect(gaugeItem(gauge(), 'forecast')).toBeNull();
  });

  test('observed and forecast are different rows for the same gauge', () => {
    const g = gauge({
      status: {
        ...gauge().status,
        forecast: {
          primary: 25.7,
          primaryUnit: 'ft',
          floodCategory: 'minor',
          validTime: '2026-09-09T18:00:00Z',
        },
      },
    });
    const observed = normaliseItem(gaugeItem(g, 'observed'));
    const forecast = normaliseItem(gaugeItem(g, 'forecast'));
    expect(observed.externalId).not.toBe(forecast.externalId);
    expect(forecast.kind).toBe('river-forecast');
    expect(forecast.summary).toContain('is forecast to be');
  });

  test('a gauge whose only news is that it is fine is dropped', () => {
    const fine = gauge({
      status: {
        ...gauge().status,
        observed: { ...gauge().status.observed, floodCategory: 'no_flooding' },
      },
    });
    expect(gaugeItem(fine, 'observed')).toBeNull();
  });
});

describe('coastal water levels', () => {
  const thresholds = {
    nos_minor: 10.19,
    nos_moderate: 11.12,
    nos_major: 12.39,
    nws_minor: 10.49,
    nws_moderate: 11.74,
    nws_major: 13.24,
    action: 10.29,
  };

  test('the worst threshold passed is the one reported', () => {
    // A reading over the major stage is over the minor one too; reporting the
    // minor would understate a flood by two categories.
    expect(exceedance(13.5, thresholds).category).toBe('major');
    expect(exceedance(11.9, thresholds).category).toBe('moderate');
    expect(exceedance(10.6, thresholds).category).toBe('minor');
    expect(exceedance(10.3, thresholds).category).toBe('action');
    expect(exceedance(4.2, thresholds)).toBeNull();
  });

  test('the NWS stage is preferred, so a reading and a flood warning agree', () => {
    // 10.3 clears NOAA's own minor stage of 10.19 but not the NWS's 10.49.
    // The alerts in the weather collection are written against the NWS one.
    expect(exceedance(10.3, thresholds).category).toBe('action');
    expect(exceedance(10.6, thresholds).threshold).toBe(10.49);
  });

  test('a station with no published thresholds says so instead of guessing', () => {
    expect(exceedance(9.9, null)).toBeNull();
    const item = coopsItem({
      station: '8518750',
      name: 'The Battery',
      state: 'NY',
      lat: 40.7,
      lon: -74.01,
      reading: { t: '2026-09-09 17:06', v: '0.65' },
      thresholds: null,
      datum: 'MLLW',
      units: 'english',
    });
    expect(item.data.floodCategory).toBeNull();
    expect(item.summary).toContain('No flood thresholds are published');
  });

  test('a reading is stamped as GMT, because that is what was asked for', () => {
    // datagetter writes `2026-09-09 17:06` with no zone at all. Stored without
    // the Z, a Pacific gauge reads as having reported eight hours early.
    const item = normaliseItem(
      coopsItem({
        station: '8518750',
        name: 'The Battery',
        state: 'NY',
        lat: 40.7,
        lon: -74.01,
        reading: { t: '2026-09-09 17:06', v: '10.62' },
        thresholds,
        datum: 'MLLW',
        units: 'english',
      }),
    );
    expect(item.publishedAt.toISOString()).toBe('2026-09-09T17:06:00.000Z');
    expect(item.data.floodCategory).toBe('minor');
    expect(item.data.overThresholdBy).toBe(0.13);
    expect(item.tags).toContain('flooding');
  });
});

describe('the drought monitor', () => {
  const row = {
    mapDate: '2026-09-01T00:00:00',
    stateAbbreviation: 'DE',
    none: 5.51,
    d0: 94.49,
    d1: 48.8,
    d2: 10.79,
    d3: 0,
    d4: 0,
    validStart: '2026-09-01T00:00:00',
    validEnd: '2026-09-07T23:59:59',
  };

  test('the classes are cumulative, and the per-class share is derived, not assumed', () => {
    // d0 is "D0 or worse". Adding d0..d4 would report 154% of Delaware in
    // drought, which is the standard mistake with this dataset.
    const inClass = byClass(row);
    expect(inClass.d0).toBe(45.69);
    expect(inClass.d1).toBe(38.01);
    expect(inClass.d2).toBe(10.79);
    expect(inClass.d3).toBe(0);
    const total = Object.values(inClass).reduce((a, b) => a + b, 0) + row.none;
    expect(total).toBeCloseTo(100, 1);
  });

  test('rounding that crosses never produces a negative share', () => {
    expect(byClass({ d0: 10.0, d1: 10.01, d2: 0, d3: 0, d4: 0 }).d0).toBe(0);
  });

  test('the worst class with any area in it is the headline', () => {
    expect(worstClass(row)).toMatchObject({ key: 'd2', label: 'severe drought' });
    expect(worstClass({ d0: 0, d1: 0, d2: 0, d3: 0, d4: 0 })).toBeNull();
    expect(CLASSES).toHaveLength(5);
  });

  test('a state row carries both readings of the numbers', () => {
    const item = normaliseItem(
      droughtItem(row, { area: 'Delaware', areaType: 'state', fips: '10-delaware' }),
    );
    expect(item.title).toContain('94.49% abnormally dry or worse');
    expect(item.data.cumulative.d0).toBe(94.49);
    expect(item.data.inClass.d0).toBe(45.69);
    expect(item.data.cumulativeNote).toContain('OR WORSE');
    expect(item.tags).toContain('drought:d2');
  });

  test('the areas of interest are FIPS numbers, because postal codes return nothing', () => {
    // `aoi=IA` is accepted and answers `[]`, which looks exactly like a week
    // with no drought in Iowa rather than like a wrong request.
    const keys = Object.keys(STATE_FIPS);
    expect(keys).toHaveLength(52);
    for (const k of keys) expect(k).toMatch(/^\d{2}$/);
    expect(STATE_FIPS['19']).toBe('Iowa');
  });
});
