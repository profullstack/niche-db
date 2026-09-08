import { describe, expect, test } from 'bun:test';

import {
  toItem as blsItem,
  periodDate as blsPeriod,
  SERIES,
} from '../packages/adapters/src/bls.js';
import {
  decodeIndex,
  toItem as esItem,
  periodDate as esPeriod,
  observations,
} from '../packages/adapters/src/eurostat.js';
import {
  parseCsv,
  pmmsDate,
  toItem as pmmsItem,
  rate,
} from '../packages/adapters/src/freddiemac.js';
import { ADAPTERS, adapterByName } from '../packages/adapters/src/index.js';
import {
  addressOf,
  postcodeArea,
  toItem as ppdItem,
  saleDate,
  unwrap,
} from '../packages/adapters/src/landregistry.js';
import {
  CITIES,
  categorise,
  cost,
  toItem as permitItem,
  placeFor as permitPlace,
} from '../packages/adapters/src/permits.js';
import {
  STATES,
  toItem as warnItem,
  placeFor as warnPlace,
} from '../packages/adapters/src/warn.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';
const { COLLECTIONS, DEFAULT_FEEDS } = await import('../packages/core/src/seed.js');

describe('the housing and jobs collections', () => {
  test('both exist, and every adapter lands in the right one', () => {
    for (const c of ['housing', 'jobs']) expect(COLLECTIONS.map((x) => x.slug)).toContain(c);
    expect(adapterByName('uk-land-registry').collection).toBe('housing');
    expect(adapterByName('freddie-mac-rates').collection).toBe('housing');
    expect(adapterByName('building-permits').collection).toBe('housing');
    expect(adapterByName('bls-series').collection).toBe('jobs');
    expect(adapterByName('warn-layoffs').collection).toBe('jobs');
  });

  test('one Eurostat adapter serves both collections', () => {
    // Unemployment and house prices are the same API with a different dataset
    // code, so the sources override the collection rather than there being two
    // near-identical adapters that drift apart.
    const sources = adapterByName('eurostat').defaultSources;
    const collections = new Set(sources.map((s) => s.collection));
    expect(collections).toEqual(new Set(['jobs', 'housing']));
  });

  test('nothing needs a credential', () => {
    // BLS v1 is keyless; a key only raises the limits.
    for (const n of [
      'bls-series',
      'eurostat',
      'warn-layoffs',
      'uk-land-registry',
      'freddie-mac-rates',
      'building-permits',
    ]) {
      expect(adapterByName(n).needsEnv ?? [], n).toEqual([]);
    }
  });

  test('every feed queries a kind some adapter in its collection emits', () => {
    for (const c of ['housing', 'jobs']) {
      const emitted = new Set(
        ADAPTERS.filter((a) =>
          (a.defaultSources ?? []).some((s) => (s.collection ?? a.collection) === c),
        ).flatMap((a) => a.kinds),
      );
      const feeds = DEFAULT_FEEDS.filter((f) => f.collection === c);
      expect(feeds.length, c).toBeGreaterThan(3);
      for (const f of feeds) {
        for (const kind of f.query.kinds ?? []) expect(emitted, `${c}/${f.slug}`).toContain(kind);
      }
    }
  });

  test('no two feeds share a slug, which the schema requires globally', () => {
    const slugs = DEFAULT_FEEDS.map((f) => f.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  test('every statistic carries the same measure shape, whoever published it', () => {
    // A US figure and a European one sit in one feed without the reader
    // translating between them.
    const shape = ['name', 'value', 'unit', 'period', 'area', 'areaCode', 'country'].sort();
    const us = blsItem(
      'LNS14000000',
      { year: '2026', period: 'M08', periodName: 'August', value: '4.1', footnotes: [] },
      SERIES.LNS14000000,
    );
    const eu = esItem(
      { at: { geo: 'DE', time: '2026-07' }, labelled: { geo: 'Germany' }, value: 3.2 },
      { collection: 'jobs', kind: 'labour-statistic', unit: '%', measure: 'unemployment rate' },
      'une_rt_m',
    );
    const rates = pmmsItem({ date: '9/3/2026', pmms30: '6.35', pmms30p: '0.6' }, 'pmms30');
    for (const i of [us, eu, rates]) expect(Object.keys(i.data.measure).sort()).toEqual(shape);
  });
});

describe('Eurostat', () => {
  test('the flat index decodes row-major, last dimension fastest', () => {
    // Getting this backwards produces plausible, wrong answers rather than an
    // error: Portugal's number quietly attributed to Poland.
    expect(decodeIndex(0, [2, 3])).toEqual([0, 0]);
    expect(decodeIndex(1, [2, 3])).toEqual([0, 1]);
    expect(decodeIndex(3, [2, 3])).toEqual([1, 0]);
    expect(decodeIndex(5, [2, 3])).toEqual([1, 2]);
  });

  test('a sparse reply attributes every value to the right country', () => {
    // Sparse because not every country reports every period, which is exactly
    // why a naive positional read goes wrong.
    const payload = {
      id: ['geo', 'time'],
      size: [3, 2],
      dimension: {
        geo: {
          category: {
            index: { PT: 0, PL: 1, DE: 2 },
            label: { PT: 'Portugal', PL: 'Poland', DE: 'Germany' },
          },
        },
        time: { category: { index: { '2026-Q1': 0, '2026-Q2': 1 } } },
      },
      // Portugal Q2 and Germany Q1 only.
      value: { 1: 4.2, 4: 9.9 },
    };
    const rows = observations(payload);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      at: { geo: 'PT', time: '2026-Q2' },
      labelled: { geo: 'Portugal', time: '2026-Q2' },
      value: 4.2,
    });
    expect(rows[1].at).toEqual({ geo: 'DE', time: '2026-Q1' });
  });

  test('a period is stamped at its start, not its end', () => {
    // Filing 2026-Q1 under March would sort it after data genuinely from March.
    expect(esPeriod('2026-Q1')).toBe('2026-01-01');
    expect(esPeriod('2026-Q4')).toBe('2026-10-01');
    expect(esPeriod('2026-07')).toBe('2026-07-01');
    expect(esPeriod('2026')).toBe('2026-01-01');
    expect(esPeriod('nonsense')).toBeNull();
  });

  test('a harmonised figure says it is harmonised', () => {
    const i = esItem(
      { at: { geo: 'DE', time: '2026-07' }, labelled: { geo: 'Germany' }, value: 3.2 },
      { collection: 'jobs', kind: 'labour-statistic', unit: '%', measure: 'unemployment rate' },
      'une_rt_m',
    );
    expect(i.data.basis).toBe('harmonised');
    // The point a reader needs: a national office may publish a different
    // number for the same period and neither is wrong.
    expect(i.data.note).toContain('national statistics office may publish a different number');
    expect(i.tags).toContain('de');
  });

  test('a row with no geography or period is dropped', () => {
    const spec = { collection: 'jobs', kind: 'labour-statistic', unit: '%', measure: 'x' };
    expect(esItem({ at: { time: '2026-07' }, labelled: {}, value: 1 }, spec, 'x')).toBeNull();
    expect(esItem({ at: { geo: 'DE' }, labelled: {}, value: 1 }, spec, 'x')).toBeNull();
  });
});

describe('BLS', () => {
  test('M13 is the annual average and is not a thirteenth month', () => {
    // Filing it as a month makes an invalid date; filing it as December
    // silently doubles December.
    expect(blsPeriod('2026', 'M08')).toBe('2026-08-01');
    expect(blsPeriod('2026', 'M12')).toBe('2026-12-01');
    expect(blsPeriod('2026', 'M13')).toBeNull();
    expect(blsPeriod('2026', 'Q02')).toBe('2026-04-01');
    expect(blsPeriod('2026', 'S01')).toBeNull();
    expect(blsPeriod('', 'M01')).toBeNull();
  });

  test('a series id becomes a sentence, since the id says nothing', () => {
    const i = blsItem(
      'LNS14000000',
      { year: '2026', period: 'M08', periodName: 'August', value: '4.1', footnotes: [] },
      SERIES.LNS14000000,
    );
    expect(i.title).toBe('US unemployment rate, August 2026: 4.1%');
    expect(i.data.measure.value).toBe(4.1);
    expect(i.tags).toContain('unemployment');
  });

  test('a preliminary figure says it will be revised', () => {
    const i = blsItem(
      'JTS000000000000000JOL',
      {
        year: '2026',
        period: 'M07',
        periodName: 'July',
        value: '7271',
        footnotes: [{ code: 'P', text: 'preliminary' }],
      },
      SERIES.JTS000000000000000JOL,
    );
    expect(i.data.preliminary).toBe(true);
    expect(i.summary).toContain('preliminary');
    expect(i.tags).toContain('preliminary');
  });

  test('an unparseable value is dropped rather than published as zero', () => {
    expect(
      blsItem('X', { year: '2026', period: 'M01', periodName: 'January', value: '-' }, null),
    ).toBeNull();
  });
});

describe('UK property sales', () => {
  const row = (over = {}) => ({
    transactionId: 'ABC-123',
    transactionDate: 'Tue, 02 Jun 2026',
    pricePaid: 175000,
    newBuild: false,
    propertyType: { label: [{ _value: 'Semi-detached', _lang: 'en' }] },
    estateType: { label: [{ _value: 'Leasehold', _lang: 'en' }] },
    propertyAddress: {
      paon: '36',
      street: 'MANSTON CLOSE',
      town: 'LEICESTER',
      district: 'LEICESTER',
      county: 'LEICESTER',
      postcode: 'LE4 9NA',
    },
    ...over,
  });

  test('a wrapped linked-data value unwraps to a string', () => {
    // Read as a string this is "[object Object]", which renders in a title and
    // never throws.
    expect(unwrap({ label: [{ _value: 'Semi-detached', _lang: 'en' }] })).toBe('Semi-detached');
    expect(unwrap('plain')).toBe('plain');
    expect(unwrap(null)).toBeNull();
    expect(unwrap({})).toBeNull();
  });

  test('the RFC date format parses, and other things do not', () => {
    expect(saleDate('Tue, 02 Jun 2026')).toBe('2026-06-02');
    expect(saleDate('2026-06-02')).toBe('2026-06-02');
    expect(saleDate('sometime last June')).toBeNull();
    expect(saleDate('')).toBeNull();
  });

  test('an address reads the way it would be written on an envelope', () => {
    const a = addressOf(row().propertyAddress);
    expect(a.line).toBe('36, MANSTON CLOSE');
    expect(a.town).toBe('LEICESTER');
    expect(a.postcode).toBe('LE4 9NA');
  });

  test('the postcode district is the bit people mean by "the area"', () => {
    expect(postcodeArea('LE4 9NA')).toBe('LE4');
    expect(postcodeArea('SW1A 1AA')).toBe('SW1A');
    expect(postcodeArea('not a postcode')).toBeNull();
  });

  test('a sale is a price, a place and a date', () => {
    const i = ppdItem(row());
    expect(i.title).toBe('£175,000 — Semi-detached, LEICESTER');
    expect(i.kind).toBe('property-sale');
    expect(i.data.price).toBe(175000);
    expect(i.publishedAt).toBe('2026-06-02');
    expect(i.tags).toContain('le4');
  });

  test('the transaction category warns against comparing unlike sales', () => {
    // Repossessions and transfers between related parties are in the data and
    // are not open-market prices.
    expect(ppdItem(row()).data.categoryNote).toContain('not comparable with open-market prices');
  });

  test('a row with no price or date is dropped', () => {
    expect(ppdItem(row({ pricePaid: null }))).toBeNull();
    expect(ppdItem(row({ transactionDate: 'nonsense' }))).toBeNull();
  });

  test('the item survives normalisation', () => {
    expect(normaliseItem(ppdItem(row()))).not.toBeNull();
  });
});

describe('US mortgage rates', () => {
  const csv =
    'date,pmms30,pmms30p,pmms15,pmms15p,pmms51,pmms51p\n9/3/2026,6.35,0.6,5.55,0.6,,\n8/27/2026,6.40,0.7,5.60,0.6,,\n';

  test('the CSV reads into rows', () => {
    const rows = parseCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0].pmms30).toBe('6.35');
  });

  test('an empty cell is nothing, never zero', () => {
    // A discontinued series left as 0 would publish a mortgage rate of 0%,
    // which is a headline and a fabricated one.
    expect(rate('')).toBeNull();
    expect(rate(null)).toBeNull();
    expect(rate('0')).toBeNull();
    expect(rate('6.35')).toBe(6.35);
  });

  test('the ARM series being blank produces no item at all', () => {
    // Freddie Mac stopped collecting it in 2022; a blank is the survey ending.
    expect(pmmsItem({ date: '9/3/2026', pmms51: '', pmms51p: '' }, 'pmms51')).toBeNull();
  });

  test('points are a fee and never read as a rate', () => {
    // pmms30 is about 6.5 and pmms30p is about 0.6; they sit next to each
    // other and mistaking one for the other is a silent order-of-magnitude error.
    const i = pmmsItem({ date: '9/3/2026', pmms30: '6.35', pmms30p: '0.6' }, 'pmms30');
    expect(i.data.ratePercent).toBe(6.35);
    expect(i.data.pointsPaid).toBe(0.6);
    expect(i.data.measure.value).toBe(6.35);
    expect(i.summary).toContain('not part of the rate');
  });

  test('the file writes M/D/YYYY', () => {
    expect(pmmsDate('9/3/2026')).toBe('2026-09-03');
    expect(pmmsDate('12/25/1971')).toBe('1971-12-25');
    expect(pmmsDate('2026-09-03')).toBeNull();
  });
});

describe('building permits', () => {
  test('every preset records when it last actually had a permit', () => {
    for (const [key, c] of Object.entries(CITIES)) {
      expect(c.newestSeen, key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  test('a cost of nothing is unstated, not free', () => {
    expect(cost(null)).toBeNull();
    expect(cost('')).toBeNull();
    expect(cost('0')).toBeNull();
    expect(cost('$1,250,000')).toBe(1250000);
  });

  test('the coarse category compares cities that word things differently', () => {
    expect(categorise('New Construction')).toBe('new-construction');
    expect(categorise('erect new 1-story type vb detached adu')).toBe('new-construction');
    expect(categorise('Bldg-Alter/Repair')).toBe('alteration');
    expect(categorise('DEMOLITION')).toBe('demolition');
    expect(categorise('something nobody mapped')).toBe('other');
  });

  test('a permit with several records is several rows, not one overwriting itself', () => {
    // San Francisco's permit number covers every record filed against that
    // permit, so without the record id its revisions collapse.
    const place = permitPlace({ city: 'san-francisco' });
    const base = {
      permit_number: '202508274032',
      filed_date: '2026-09-05T18:49:09.000',
      permit_type_definition: 'otc alterations permit',
    };
    const a = permitItem({ ...base, record_id: '1' }, place);
    const b = permitItem({ ...base, record_id: '2' }, place);
    expect(a.externalId).not.toBe(b.externalId);
    expect(permitItem({ ...base, record_id: '1' }, place).externalId).toBe(a.externalId);
  });

  test('the city’s own wording survives beside the coarse category', () => {
    const i = permitItem(
      {
        id: 'N1',
        issue_date: '2026-09-06T00:00:00.000',
        permit_type: 'PERMIT – NEW CONSTRUCTION',
        work_description: 'ERECT A 3 STORY BUILDING',
        street_number: '9106',
        street_name: 'WINCHESTER AVE',
        latitude: '41.72',
        longitude: '-87.67',
      },
      permitPlace({ city: 'chicago' }),
    );
    expect(i.data.category).toBe('new-construction');
    expect(i.data.permitType).toBe('PERMIT – NEW CONSTRUCTION');
    expect(i.data.categoryNote).toContain('authoritative');
    expect(i.data.place.lat).toBe(41.72);
  });

  test('a row with no id, date or type is dropped', () => {
    const place = permitPlace({ city: 'chicago' });
    expect(permitItem({ issue_date: '2026-09-06', permit_type: 'X' }, place)).toBeNull();
    expect(permitItem({ id: '1', permit_type: 'X' }, place)).toBeNull();
    expect(permitItem({ id: '1', issue_date: '2026-09-06' }, place)).toBeNull();
  });
});

describe('WARN layoff notices', () => {
  const place = warnPlace({ state: 'texas' });
  const row = (over = {}) => ({
    notice_date: '2026-06-23T00:00:00.000',
    job_site_name: 'JPMorgan Chase & Co.',
    city_name: 'Plano',
    county_name: 'Collin',
    total_layoff_number: '244',
    layoff_date: '2026-08-22T00:00:00.000',
    wda_name: 'North Central Texas WDA',
    ...over,
  });

  test('a notice names the company, the count and the place', () => {
    const i = warnItem(row(), place);
    expect(i.title).toBe('JPMorgan Chase & Co.: 244 jobs in Plano');
    expect(i.data.workers).toBe(244);
    expect(i.data.place.state).toBe('TX');
    expect(i.tags).toContain('hundred-plus');
  });

  test('it is filed under the notice date, and carries the layoff date too', () => {
    // Keyed on the layoff date the feed would go quiet for two months and then
    // report the news late; they are two different facts about one event.
    const i = warnItem(row(), place);
    expect(i.publishedAt).toBe('2026-06-23');
    expect(i.data.noticeDate).toBe('2026-06-23');
    expect(i.data.layoffDate).toBe('2026-08-22');
  });

  test('a notice is a plan, not a count of jobs already lost', () => {
    expect(warnItem(row(), place).data.note).toContain('not a count of jobs already lost');
  });

  test('two notices from one employer on one day stay two rows', () => {
    const a = warnItem(row(), place);
    const b = warnItem(row({ total_layoff_number: '90', layoff_date: '2026-09-30' }), place);
    expect(a.externalId).not.toBe(b.externalId);
    // And re-reading the same notice is the same row.
    expect(warnItem(row(), place).externalId).toBe(a.externalId);
  });

  test('a state preset records when it last had a notice', () => {
    for (const [key, s] of Object.entries(STATES)) {
      expect(s.newestSeen, key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  test('a row with no employer or notice date is dropped', () => {
    expect(warnItem(row({ job_site_name: null }), place)).toBeNull();
    expect(warnItem(row({ notice_date: null }), place)).toBeNull();
  });
});
