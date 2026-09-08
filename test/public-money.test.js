import { describe, expect, test } from 'bun:test';

import { ADAPTERS, adapterByName } from '../packages/adapters/src/index.js';
import {
  amountOf,
  fmtMoney,
  toItem as ocdsItem,
  PUBLISHERS,
  stageOf,
  suppliersOf,
} from '../packages/adapters/src/ocds.js';
import { alpha2, oneOf, tedDate, toItem as tedItem, uniq } from '../packages/adapters/src/ted.js';
import { money, toItem as usaItem } from '../packages/adapters/src/usaspending.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';
const { COLLECTIONS, DEFAULT_FEEDS } = await import('../packages/core/src/seed.js');

describe('the public money collection', () => {
  test('exists, and all three adapters are registered in it, keyless', () => {
    expect(COLLECTIONS.map((c) => c.slug)).toContain('public-money');
    for (const n of ['usaspending-awards', 'ocds-tenders', 'ted-notices']) {
      const a = adapterByName(n);
      expect(a?.collection).toBe('public-money');
      // The whole point of this collection: three governments, no credentials.
      expect(a.needsEnv ?? []).toEqual([]);
    }
  });

  test('four independent sources across three governments are seeded', () => {
    const sources = ADAPTERS.filter((a) => a.collection === 'public-money').flatMap(
      (a) => a.defaultSources ?? [],
    );
    expect(sources.length).toBeGreaterThanOrEqual(6);
    expect(Object.keys(PUBLISHERS)).toEqual(['uk-contracts-finder', 'uk-find-a-tender']);
  });

  test('every feed queries a kind some adapter emits', () => {
    const emitted = new Set(
      ADAPTERS.filter((a) => a.collection === 'public-money').flatMap((a) => a.kinds),
    );
    const feeds = DEFAULT_FEEDS.filter((f) => f.collection === 'public-money');
    expect(feeds.length).toBeGreaterThan(4);
    for (const f of feeds) {
      for (const kind of f.query.kinds ?? []) expect(emitted).toContain(kind);
    }
  });

  test('every row shares one award shape, whichever government published it', () => {
    // This is what lets an award in Ohio and a tender in Estonia be read side
    // by side, so it is asserted across all three adapters at once.
    const shape = [
      'country',
      'jurisdiction',
      'id',
      'buyer',
      'buyerUnit',
      'supplier',
      'amount',
      'currency',
      'startDate',
      'endDate',
      'stage',
    ].sort();

    const us = usaItem(
      {
        'Award ID': 'X1',
        'Recipient Name': 'ACME',
        'Award Amount': 1_000_000,
        'Awarding Agency': 'Department of Energy',
        'Start Date': '2026-09-01',
      },
      'contracts',
    );
    const uk = ocdsItem(
      {
        ocid: 'ocds-1',
        id: 'r1',
        date: '2026-09-07T19:01:22+01:00',
        tag: ['award'],
        tender: { id: 'C1', title: 'A roof' },
        awards: [{ value: { amount: 35000, currency: 'GBP' }, suppliers: [{ name: 'RSK' }] }],
        buyer: { name: 'NHS' },
      },
      {
        key: 'uk-contracts-finder',
        name: 'UK Contracts Finder',
        country: 'GB',
        jurisdiction: 'United Kingdom',
      },
    );
    const eu = tedItem({
      'publication-number': '599727-2026',
      'notice-title': { eng: ['A road'] },
      'publication-date': '2026-09-01+02:00',
      'buyer-name': { deu: ['Stadt Essen'] },
      'buyer-country': ['DEU'],
      'notice-type': 'can-standard',
    });

    for (const i of [us, uk, eu]) expect(Object.keys(i.data.award).sort()).toEqual(shape);
  });
});

describe('US federal awards', () => {
  const row = (over = {}) => ({
    'Award ID': 'DENA0001942',
    'Recipient Name': 'CONSOLIDATED NUCLEAR SECURITY, LLC',
    'Award Amount': 34_650_000_000,
    'Awarding Agency': 'Department of Energy',
    'Awarding Sub Agency': 'Department of Energy',
    'Start Date': '2014-07-01',
    'End Date': '2031-06-30',
    Description: 'MANAGEMENT AND OPERATION',
    generated_internal_id: 'CONT_AWD_1',
    ...over,
  });

  test('money reads the way a headline says it', () => {
    expect(money(34_650_000_000)).toBe('$34.65bn');
    expect(money(1_500_000)).toBe('$1.5m');
    expect(money(35_000)).toBe('$35k');
    expect(money(null)).toBeNull();
  });

  test('an award names the recipient, the amount and the agency', () => {
    const i = usaItem(row(), 'contracts');
    expect(i.title).toContain('$34.65bn contract');
    expect(i.kind).toBe('contract-award');
    expect(i.tags).toContain('billion-plus');
    expect(i.url).toContain('usaspending.gov/award/CONT_AWD_1');
  });

  test('the amount says what it is, because the field name does not', () => {
    // Award Amount is the total obligated over the award's whole life. Printed
    // beside a date it reads as "awarded today", which for a 2014 contract
    // modified last week would be badly wrong.
    const i = usaItem(row(), 'contracts');
    expect(i.data.amountBasis).toBe('total-obligated-to-date');
    expect(i.data.amountNote).toContain('not the value of a single transaction');
  });

  test('an award with no start date is filed under its end date, and says so', () => {
    const i = usaItem(row({ 'Start Date': null }), 'grants');
    expect(i.publishedAt).toBe('2031-06-30');
    expect(i.data.datedBy).toBe('end-date');
    expect(usaItem(row(), 'grants').data.datedBy).toBe('start-date');
  });

  test('grants and contracts are different kinds, because they are different things', () => {
    expect(usaItem(row(), 'contracts').kind).toBe('contract-award');
    expect(usaItem(row(), 'grants').kind).toBe('grant-award');
    expect(usaItem(row(), 'loans').kind).toBe('loan');
  });

  test('a row with no recipient or id is dropped', () => {
    expect(usaItem(row({ 'Recipient Name': null }), 'contracts')).toBeNull();
    expect(usaItem(row({ 'Award ID': null }), 'contracts')).toBeNull();
  });

  test('the item survives normalisation', () => {
    expect(normaliseItem(usaItem(row(), 'contracts'))).not.toBeNull();
  });
});

describe('OCDS tenders and awards', () => {
  const publisher = {
    key: 'uk-contracts-finder',
    name: 'UK Contracts Finder',
    country: 'GB',
    jurisdiction: 'United Kingdom',
  };
  const release = (over = {}) => ({
    ocid: 'ocds-b5fd17-abc',
    id: 'rel-1',
    date: '2026-09-07T19:01:22+01:00',
    tag: ['award'],
    tender: { id: 'C470284', title: 'Wokingham Hospital OPD Roof' },
    awards: [
      {
        value: { amount: 35000.76, currency: 'GBP' },
        suppliers: [{ name: 'RSK Environment Limited' }],
      },
    ],
    buyer: { name: 'NHS PROPERTY SERVICES LIMITED' },
    ...over,
  });

  test('a tender and an award are different stages, not one flattened kind', () => {
    expect(ocdsItem(release(), publisher).kind).toBe('contract-award');
    const tender = ocdsItem(release({ tag: ['tender'], awards: [] }), publisher);
    expect(tender.kind).toBe('tender');
    expect(tender.data.award.stage).toBe('tender');
  });

  test('a tender has no winner and none is invented', () => {
    const tender = ocdsItem(release({ tag: ['tender'], awards: [] }), publisher);
    expect(tender.data.award.supplier).toBeNull();
    expect(tender.data.suppliers).toEqual([]);
    expect(tender.tags).not.toContain('has-supplier');
  });

  test('the stage is read from the tag, most advanced first', () => {
    expect(stageOf(['tender', 'award']).stage).toBe('award');
    expect(stageOf(['award', 'contract']).stage).toBe('contract');
    expect(stageOf(['planning']).stage).toBe('planning');
    // No tag at all is null rather than a guessed stage.
    expect(stageOf([])).toBeNull();
  });

  test('an award value beats a tender estimate, and says which it used', () => {
    expect(amountOf(release()).of).toBe('award');
    const est = amountOf(
      release({ awards: [], tender: { value: { amount: 9, currency: 'GBP' } } }),
    );
    expect(est).toEqual({ amount: 9, currency: 'GBP', of: 'tender' });
    expect(amountOf({ awards: [], tender: {} }).amount).toBeNull();
  });

  test('a framework awarded to several suppliers does not publish identical rows', () => {
    // Find a Tender publishes one release per supplier on a framework, all
    // sharing the tender title, so without the supplier they read as copies.
    const one = ocdsItem(release({ id: 'r1' }), publisher);
    const two = ocdsItem(
      release({
        id: 'r2',
        awards: [
          { value: { amount: 35000.76, currency: 'GBP' }, suppliers: [{ name: 'Other Ltd' }] },
        ],
      }),
      publisher,
    );
    expect(one.title).not.toBe(two.title);
    expect(one.externalId).not.toBe(two.externalId);
  });

  test('every supplier is kept even when only one fits the headline', () => {
    const many = release({
      awards: [
        {
          suppliers: [{ name: 'A Ltd' }, { name: 'B Ltd' }],
          value: { amount: 1, currency: 'GBP' },
        },
      ],
    });
    expect(suppliersOf(many)).toEqual(['A Ltd', 'B Ltd']);
    expect(ocdsItem(many, publisher).data.suppliers).toEqual(['A Ltd', 'B Ltd']);
  });

  test('money carries its currency symbol', () => {
    expect(fmtMoney(35000, 'GBP')).toBe('£35k');
    expect(fmtMoney(2_500_000, 'EUR')).toBe('€2.5m');
    expect(fmtMoney(1, 'XYZ')).toBe('1 XYZ');
    expect(fmtMoney(null, 'GBP')).toBeNull();
  });

  test('a release with no ocid or title is dropped', () => {
    expect(ocdsItem(release({ ocid: null }), publisher)).toBeNull();
    expect(ocdsItem(release({ tender: {}, awards: [] }), publisher)).toBeNull();
  });
});

describe('EU tenders (TED)', () => {
  const notice = (over = {}) => ({
    'publication-number': '599727-2026',
    'notice-title': { eng: ['Geotechnical engineering services'] },
    'publication-date': '2026-09-01+02:00',
    'buyer-name': { deu: ['Stadt Essen, Zentrales Vergabemanagement'] },
    'buyer-country': ['DEU', 'DEU'],
    'notice-type': 'can-standard',
    'contract-nature': ['services', 'services', 'services'],
    'place-of-performance': ['DEA13', 'DEU', 'DEA13'],
    ...over,
  });

  test('a multilingual value resolves to English when there is one', () => {
    expect(oneOf({ eng: ['English'], deu: ['Deutsch'] })).toBe('English');
  });

  test('and to whatever language there is when there is not', () => {
    // A German buyer name is far better than no buyer name.
    expect(oneOf({ deu: ['Stadt Essen'] })).toBe('Stadt Essen');
    expect(oneOf('plain string')).toBe('plain string');
    expect(oneOf(null)).toBeNull();
    expect(oneOf({})).toBeNull();
  });

  test('fields that repeat per lot are deduplicated', () => {
    // A tender with eight lots reports contract-nature eight times, and
    // untreated every tag would be a wall of "services".
    expect(uniq(['services', 'services', 'works'])).toEqual(['services', 'works']);
    expect(uniq('services')).toEqual(['services']);
    expect(uniq(null)).toEqual([]);
  });

  test('country codes are alpha-2, like every other collection', () => {
    // TED writes alpha-3, so a German notice would be tagged `deu` while a US
    // award is tagged `us`, and "everything in Germany" would need the reader
    // to know which standard each source happened to use.
    expect(alpha2('DEU')).toBe('DE');
    expect(alpha2('POL')).toBe('PL');
    expect(alpha2('GB')).toBe('GB');
    const i = tedItem(notice());
    expect(i.data.award.country).toBe('DE');
    expect(i.tags).toContain('de');
    // The original is kept, so nothing is lost in the conversion.
    expect(i.data.buyerCountriesAlpha3).toEqual(['DEU']);
  });

  test('an award notice and a contract notice are told apart by their code', () => {
    expect(tedItem(notice()).kind).toBe('contract-award');
    expect(tedItem(notice({ 'notice-type': 'cn-standard' })).kind).toBe('tender');
    expect(tedItem(notice()).data.noticeTypeLabel).toBe('contract award notice');
  });

  test('the winning supplier is left null rather than filled with the buyer', () => {
    // TED's search index does not carry it even on an award notice.
    expect(tedItem(notice()).data.award.supplier).toBeNull();
  });

  test('a date with an offset and no time becomes a date', () => {
    expect(tedDate('2026-09-01+02:00')).toBe('2026-09-01');
    expect(tedDate('')).toBeNull();
  });

  test('a notice with no publication number is dropped', () => {
    expect(tedItem(notice({ 'publication-number': null }))).toBeNull();
  });

  test('the item survives normalisation', () => {
    const n = normaliseItem(tedItem(notice()));
    expect(n).not.toBeNull();
    expect(n.publishedAt).toBeInstanceOf(Date);
  });
});
