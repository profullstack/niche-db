import { describe, expect, test } from 'bun:test';
import {
  addDays,
  modelNumbers,
  names,
  recallDate,
  toItem as recallItem,
  units,
  upcs,
} from '../packages/adapters/src/cpsc.js';
import {
  CATALOGUE_KEYS,
  CATALOGUES,
  esDate,
  toItem as modelItem,
  num,
  sinceClause,
  specOf,
  upcList,
} from '../packages/adapters/src/energystar.js';
import { ADAPTERS, adapterByName } from '../packages/adapters/src/index.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';
const { COLLECTIONS, DEFAULT_FEEDS } = await import('../packages/core/src/seed.js');

/* A refrigerator row as the ENERGY STAR dataset returns one. */
const fridge = (over = {}) => ({
  pd_id: '4015668',
  brand_name: 'ABL',
  model_number: 'AREF18**',
  type: 'Top Freezer',
  product_class: '3 - Refrigerator-freezers',
  capacity_total_volume_ft3: '17.6',
  annual_energy_use_kwh_yr: '360',
  percent_less_energy_use_than_us_federal_standard: '4',
  height_in: '66.9',
  width_in: '28',
  date_available_on_market: '2025-04-15T00:00:00.000',
  date_qualified: '2025-04-15T00:00:00.000',
  markets: 'United States, Canada',
  energy_star_model_identifier: 'ES_1148590_AREF18**_04152025120303_80247440',
  meets_most_efficient_criteria: 'No',
  ...over,
});

/* A recall as the CPSC REST service returns one. */
const recall = (over = {}) => ({
  RecallID: 10992,
  RecallNumber: '26789',
  RecallDate: '2026-09-24T00:00:00',
  LastPublishDate: '2026-09-24T00:00:00',
  Title: 'Acme Recalls Dishwashers Due to Fire Hazard',
  Description: 'This recall involves Acme dishwashers.',
  URL: 'https://cpsc.gov/Recalls/2026/acme',
  ConsumerContact: 'Acme toll free at 800-555-0100.',
  Products: [
    {
      Name: 'Acme dishwasher',
      Model: 'WRF535SWHZ00, WRF535SWHZ01 and WRF535SWHZ02',
      Type: 'Dishwashers',
      NumberOfUnits: 'About 12,000',
    },
  ],
  Images: [{ URL: 'https://cpsc.gov/img/acme.jpg', Caption: 'Recalled dishwasher' }],
  Hazards: [{ Name: 'The heating element can overheat, posing a fire hazard.' }],
  Remedies: [{ Name: 'Consumers should stop using the dishwasher and contact Acme.' }],
  RemedyOptions: [{ Option: 'Repair' }],
  Injuries: [{ Name: 'None reported' }],
  Manufacturers: [{ Name: 'Acme Appliance Co.' }],
  ManufacturerCountries: [{ Country: 'China' }],
  ProductUPCs: [{ UPC: '761101155524' }],
  ...over,
});

describe('the parts collection is wired up', () => {
  test('the collection is seeded', () => {
    const parts = COLLECTIONS.find((c) => c.slug === 'parts');
    expect(parts).toBeTruthy();
    expect(parts.name).toBe('Parts & appliances');
  });

  test('both adapters are registered and claim the collection', () => {
    for (const name of ['energystar-models', 'cpsc-recalls']) {
      const adapter = adapterByName(name);
      expect(adapter).toBeTruthy();
      expect(adapter.collection).toBe('parts');
      expect(ADAPTERS).toContain(adapter);
    }
  });

  test('every default parts feed names a kind one of the adapters emits', () => {
    const emitted = new Set([
      ...adapterByName('energystar-models').kinds,
      ...adapterByName('cpsc-recalls').kinds,
    ]);
    const feeds = DEFAULT_FEEDS.filter((f) => f.collection === 'parts');
    expect(feeds.length).toBeGreaterThan(0);
    for (const feed of feeds) {
      for (const kind of feed.query.kinds ?? []) expect(emitted).toContain(kind);
    }
  });
});

describe('energystar presets', () => {
  test('every preset names a dataset and the date column it was measured on', () => {
    for (const key of CATALOGUE_KEYS) {
      const c = CATALOGUES[key];
      expect(c.dataset).toMatch(/^[a-z0-9]{4}-[a-z0-9]{4}$/);
      expect(['date_qualified', 'date_available_on_market', 'date_certified']).toContain(
        c.dateField,
      );
      expect(c.newestSeen).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(c.rows).toBeGreaterThan(0);
    }
  });

  test('the stale consolidated Model Index is not among them', () => {
    // 8wj2-sec8 is 1.8M rows and reports a daily update, but its newest record
    // was nine months old when the presets were measured. Reaching for it is
    // the mistake this collection exists to avoid.
    for (const key of CATALOGUE_KEYS) expect(CATALOGUES[key].dataset).not.toBe('8wj2-sec8');
  });

  test('dataset ids are unique', () => {
    const ids = CATALOGUE_KEYS.map((k) => CATALOGUES[k].dataset);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('energystar field handling', () => {
  test('a calendar_date reduces to a day', () => {
    expect(esDate('2026-09-21T00:00:00.000')).toBe('2026-09-21');
    expect(esDate('')).toBeNull();
    expect(esDate(null)).toBeNull();
  });

  test('a blank measurement is null, never zero', () => {
    expect(num('360')).toBe(360);
    expect(num('')).toBeNull();
    expect(num(null)).toBeNull();
    expect(num('  ')).toBeNull();
    expect(num('0')).toBe(0);
  });

  test('only plausible barcode lengths survive', () => {
    expect(upcList('761101155524')).toEqual(['761101155524']);
    expect(upcList('761101155524, 761101155531')).toEqual(['761101155524', '761101155531']);
    // A truncated cell would otherwise become a barcode for some other product.
    expect(upcList('7611011')).toEqual([]);
    expect(upcList('')).toEqual([]);
  });

  test('a spec keeps measurements and drops empties', () => {
    const spec = specOf(fridge());
    expect(spec.capacityFt3).toBe(17.6);
    expect(spec.annualEnergyKwh).toBe(360);
    expect(spec.depthIn).toBeNull();
  });

  test('the resume clause is inclusive of its day', () => {
    expect(sinceClause('date_qualified', '2026-09-21')).toBe(
      "date_qualified >= '2026-09-21T00:00:00.000'",
    );
    expect(sinceClause('date_qualified', null)).toBeNull();
  });
});

describe('energystar items', () => {
  test('a model becomes a storable item', () => {
    const item = normaliseItem(modelItem(fridge(), 'refrigerators'));
    expect(item).toBeTruthy();
    expect(item.externalId).toBe('refrigerators-4015668');
    expect(item.title).toBe('ABL AREF18**');
    expect(item.kind).toBe('appliance-model');
    expect(item.publishedAt).toBeTruthy();
    expect(item.tags).toContain('appliance');
    expect(item.tags).toContain('kitchen');
    expect(item.data.modelNumber).toBe('AREF18**');
    expect(item.data.brand).toBe('ABL');
  });

  test('a UPC on the row is carried onto the item', () => {
    const item = modelItem(fridge({ upc: '761101155524' }), 'refrigerators');
    expect(item.data.upcs).toEqual(['761101155524']);
    expect(item.summary).toContain('761101155524');
  });

  test('a row with no model number is dropped rather than guessed at', () => {
    expect(modelItem(fridge({ model_number: '' }), 'refrigerators')).toBeNull();
  });

  test('an unknown catalogue is refused', () => {
    expect(modelItem(fridge(), 'nope')).toBeNull();
  });
});

describe('cpsc field handling', () => {
  test('dates reduce to a day', () => {
    expect(recallDate('2026-09-24T00:00:00')).toBe('2026-09-24');
    expect(recallDate(null)).toBeNull();
  });

  test('days are added and subtracted in UTC', () => {
    expect(addDays('2026-09-24', -1)).toBe('2026-09-23');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2026-09-01', 30)).toBe('2026-10-01');
  });

  test('model numbers split out of one free-text cell', () => {
    expect(modelNumbers(recall().Products)).toEqual([
      'WRF535SWHZ00',
      'WRF535SWHZ01',
      'WRF535SWHZ02',
    ]);
  });

  test('prose in the model cell is not mistaken for a model number', () => {
    const prose = [{ Model: 'See the list of affected serial numbers on page 2' }];
    expect(modelNumbers(prose)).toEqual([]);
    expect(modelNumbers([{ Model: '' }])).toEqual([]);
    expect(modelNumbers(undefined)).toEqual([]);
  });

  test('barcodes are kept only at GTIN lengths', () => {
    expect(upcs([{ UPC: '761101155524' }])).toEqual(['761101155524']);
    expect(upcs([{ UPC: '12345' }])).toEqual([]);
    expect(upcs([])).toEqual([]);
  });

  test('names are de-duplicated and blanks dropped', () => {
    expect(names([{ Name: 'Acme' }, { Name: 'Acme' }, { Name: '' }])).toEqual(['Acme']);
    expect(names(null)).toEqual([]);
  });

  test('unit counts are kept as the prose they are', () => {
    expect(units(recall().Products)).toBe('About 12,000');
    expect(units([])).toBeNull();
  });
});

describe('cpsc items', () => {
  test('a recall becomes a storable item with its join keys', () => {
    const item = normaliseItem(recallItem(recall()));
    expect(item).toBeTruthy();
    expect(item.externalId).toBe('cpsc-26789');
    expect(item.kind).toBe('recall');
    expect(item.publishedAt).toBeTruthy();
    expect(item.url).toBe('https://cpsc.gov/Recalls/2026/acme');
    expect(item.imageUrl).toBe('https://cpsc.gov/img/acme.jpg');
    expect(item.data.modelNumbers).toContain('WRF535SWHZ00');
    expect(item.data.upcs).toEqual(['761101155524']);
    expect(item.data.remedyOptions).toEqual(['Repair']);
    expect(item.data.manufacturers).toEqual(['Acme Appliance Co.']);
  });

  test('the announcement date orders the feed, not the last edit', () => {
    const item = recallItem(recall({ LastPublishDate: '2030-01-01T00:00:00' }));
    expect(item.publishedAt).toBe('2026-09-24');
    expect(item.data.lastPublishDate).toBe('2030-01-01');
  });

  test('a recall naming no model is still an item', () => {
    const item = recallItem(recall({ Products: [{ Name: 'Helmet', Model: '', Type: 'Helmets' }] }));
    expect(item).toBeTruthy();
    expect(item.data.modelNumbers).toEqual([]);
  });

  test('a record with no title is dropped', () => {
    expect(recallItem(recall({ Title: '' }))).toBeNull();
  });
});
