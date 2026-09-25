import { describe, expect, test } from 'bun:test';
import { ADAPTERS, adapterByName } from '../packages/adapters/src/index.js';
import {
  headerIndex,
  LEVEL_KEYS,
  LEVELS,
  num,
  periodOf,
  rowId,
  text,
  toItem,
} from '../packages/adapters/src/redfin.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';
const { COLLECTIONS, DEFAULT_FEEDS } = await import('../packages/core/src/seed.js');

/*
 * The real header and a real row, read out of
 * state_market_tracker.tsv000.gz on 2026-09-25. Only the leading columns are
 * reproduced; the file has 58.
 */
const HEADER = [
  'PERIOD_BEGIN',
  'PERIOD_END',
  'PERIOD_DURATION',
  'REGION_TYPE',
  'REGION_TYPE_ID',
  'TABLE_ID',
  'IS_SEASONALLY_ADJUSTED',
  'REGION',
  'CITY',
  'STATE',
  'STATE_CODE',
  'PROPERTY_TYPE',
  'PROPERTY_TYPE_ID',
  'MEDIAN_SALE_PRICE',
  'MEDIAN_SALE_PRICE_MOM',
  'MEDIAN_SALE_PRICE_YOY',
  'MEDIAN_LIST_PRICE',
  'HOMES_SOLD',
  'MEDIAN_DOM',
];

const ROW = [
  '2012-04-01',
  '2012-04-30',
  '30',
  'state',
  '4',
  '17',
  'false',
  'Columbia',
  '',
  'Columbia',
  'DC',
  'All Residential',
  '-1',
  '440000',
  '0.05',
  '0.12',
  '450000',
  '318',
  '21',
];

const index = headerIndex(HEADER);

describe('headerIndex', () => {
  test('maps the columns the adapter reads', () => {
    expect(index.PERIOD_BEGIN).toBe(0);
    expect(index.REGION).toBe(7);
    expect(index.MEDIAN_SALE_PRICE).toBe(13);
  });

  test('throws when a column it depends on is gone', () => {
    // Redfin restructuring the tracker should fail loudly, not silently
    // produce rows with every measure missing.
    expect(() => headerIndex(['PERIOD_BEGIN', 'REGION'])).toThrow(/layout has changed/);
  });

  test('is case- and quote-insensitive, as a TSV header may be either', () => {
    const i = headerIndex(['"period_begin"', 'region', 'PROPERTY_TYPE', 'median_sale_price']);
    expect(i.PERIOD_BEGIN).toBe(0);
  });
});

describe('num', () => {
  test('reads a number', () => {
    expect(num('440000')).toBe(440000);
    expect(num('0.05')).toBe(0.05);
    expect(num('-0.03')).toBe(-0.03);
  });

  test('an empty cell is null, never zero', () => {
    // A ZIP with no sales that month is not a ZIP where the median price was
    // zero; charting it as zero puts a spike through every quiet market.
    expect(num('')).toBeNull();
    expect(num(null)).toBeNull();
    expect(num('   ')).toBeNull();
  });

  test('strips the quotes a TSV cell may carry', () => {
    expect(num('"440000"')).toBe(440000);
    expect(text('"Columbia"')).toBe('Columbia');
  });
});

describe('periodOf and rowId', () => {
  test('the period is the first day it covers', () => {
    expect(periodOf(ROW, index)).toBe('2012-04-01');
  });

  test('the id is region, property type and period together', () => {
    const id = rowId('state', ROW, index);
    expect(id).toBe('redfin:state:17:all-residential:2012-04-01');
  });

  test('property type is part of the identity, so types do not overwrite each other', () => {
    const condo = [...ROW];
    condo[index.PROPERTY_TYPE] = 'Condo/Co-op';
    expect(rowId('state', condo, index)).not.toBe(rowId('state', ROW, index));
  });

  test('a row without a table id falls back to the region name', () => {
    const noId = [...ROW];
    noId[index.TABLE_ID] = '';
    expect(rowId('state', noId, index)).toContain('columbia');
  });
});

describe('toItem', () => {
  test('a real row becomes a storable item', () => {
    const item = normaliseItem(toItem('state', ROW, index));
    expect(item.kind).toBe('housing-market');
    expect(item.title).toContain('Columbia');
    expect(item.title).toContain('All Residential');
    expect(item.publishedAt).toBeTruthy();
    expect(item.tags).toContain('housing-market');
    expect(item.tags).toContain('state');
  });

  test('the summary reads in plain numbers', () => {
    const item = toItem('state', ROW, index);
    expect(item.summary).toContain('median 440,000');
    expect(item.summary).toContain('318 sold');
    expect(item.summary).toContain('21 days on market');
  });

  test('measures carry their month-over-month and year-over-year companions', () => {
    const item = toItem('state', ROW, index);
    expect(item.data.measures.median_sale_price).toBe(440000);
    expect(item.data.measures.median_sale_price_mom).toBe(0.05);
    expect(item.data.measures.median_sale_price_yoy).toBe(0.12);
  });

  test('an absent measure is simply not there', () => {
    const blank = [...ROW];
    blank[index.MEDIAN_DOM] = '';
    const item = toItem('state', blank, index);
    expect(item.data.measures.median_dom).toBeUndefined();
    expect(item.data.measures.median_sale_price).toBe(440000);
  });

  test('a row with no measures at all is dropped rather than stored empty', () => {
    const empty = [...ROW];
    for (const c of [
      index.MEDIAN_SALE_PRICE,
      index.MEDIAN_LIST_PRICE,
      index.HOMES_SOLD,
      index.MEDIAN_DOM,
    ]) {
      empty[c] = '';
    }
    expect(toItem('state', empty, index)).toBeNull();
  });

  test('a row with no region or period is dropped', () => {
    const noRegion = [...ROW];
    noRegion[index.REGION] = '';
    expect(toItem('state', noRegion, index)).toBeNull();
  });

  test('every row says plainly that it is not a listing', () => {
    // OpenListing forbids publishing aggregate market data as a listing; this
    // is the collection that must not be confused with /c/listings.
    const item = toItem('state', ROW, index);
    expect(item.data.note).toMatch(/not a listing/i);
  });
});

describe('levels', () => {
  test('every level names a file and a rough size', () => {
    for (const key of LEVEL_KEYS) {
      expect(LEVELS[key].file).toMatch(/market_tracker$/);
      expect(LEVELS[key].approxMb).toBeGreaterThan(0);
    }
  });

  test('the two enormous levels are not on by default', () => {
    // zip is 1.5 GB and neighborhood 2.2 GB, measured 2026-09-25.
    const defaults = adapterByName('redfin-market').defaults.levels;
    expect(defaults).not.toContain('zip');
    expect(defaults).not.toContain('neighborhood');
    expect(defaults).toContain('state');
  });
});

describe('registration', () => {
  test('the adapter joins the existing housing collection', () => {
    const a = adapterByName('redfin-market');
    expect(a.collection).toBe('housing');
    expect(ADAPTERS).toContain(a);
  });

  test('housing is defined exactly once', () => {
    // It already existed for Land Registry, Eurostat, permits and mortgage
    // rates; Redfin joins it rather than creating a second one.
    expect(COLLECTIONS.filter((c) => c.slug === 'housing')).toHaveLength(1);
  });

  test('it declares a budget, because these are bulk files', () => {
    expect(adapterByName('redfin-market').budgetMs).toBeGreaterThan(60 * 60 * 1000);
  });

  test('its feeds exist', () => {
    const slugs = DEFAULT_FEEDS.filter((f) => f.collection === 'housing').map((f) => f.slug);
    expect(slugs).toContain('housing-market');
    expect(slugs).toContain('housing-by-state');
  });
});
