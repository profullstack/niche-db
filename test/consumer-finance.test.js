import { describe, expect, test } from 'bun:test';
import {
  toItem as complaintItem,
  daysBetween,
  nextDay,
  productFamily,
  utcDay,
} from '../packages/adapters/src/cfpb.js';
import {
  changeItem,
  familyOf,
  fdicDate,
  institutionItem,
  money,
  thousands,
} from '../packages/adapters/src/fdic.js';
import { adapterByName } from '../packages/adapters/src/index.js';
import { normaliseItem, slugify } from '../packages/core/src/adapter.js';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';
const { COLLECTIONS, DEFAULT_FEEDS } = await import('../packages/core/src/seed.js');

/* A complaint as the CFPB search returns one. */
const hit = (over = {}) => ({
  _id: '26830447',
  _source: {
    complaint_id: '26830447',
    company: 'TRANSUNION INTERMEDIATE HOLDINGS, INC.',
    product: 'Credit reporting or other personal consumer reports',
    sub_product: 'Credit reporting',
    issue: "Problem with a company's investigation into an existing problem",
    sub_issue: 'Investigation took more than 30 days',
    date_received: '2026-09-09T03:59:29.000Z',
    date_sent_to_company: '2026-09-09T03:59:50.000Z',
    state: 'IN',
    zip_code: '46307',
    company_response: 'In progress',
    timely: 'Yes',
    submitted_via: 'Web',
    has_narrative: false,
    complaint_what_happened: '',
    ...over,
  },
});

describe('the consumer finance collection', () => {
  test('exists, and every adapter in it is registered there', () => {
    expect(COLLECTIONS.map((c) => c.slug)).toContain('consumer-finance');
    for (const name of ['cfpb-complaints', 'fdic-institutions', 'fdic-structure-changes']) {
      const a = adapterByName(name);
      expect(a).not.toBeNull();
      expect(a.collection).toBe('consumer-finance');
    }
  });

  test('a complaint and an institution can be joined on the same company key', () => {
    /* This is the whole reason the FDIC feeds are in this collection. The CFPB
     * names a company and identifies it with nothing at all, so the only join
     * available is the name, and both sides have to normalise it the same way
     * or the join silently matches nothing. */
    const complaint = complaintItem(hit({ company: 'Navy Federal Credit Union' }));
    const bank = institutionItem({ data: { CERT: '5536', NAME: 'Navy Federal Credit Union' } });
    expect(complaint.data.companyKey).toBe(bank.data.nameKey);
    expect(complaint.data.companyKey).toBe(slugify('Navy Federal Credit Union'));
  });

  test('every consumer-finance feed queries kinds these adapters emit', () => {
    const kinds = new Set(
      ['cfpb-complaints', 'fdic-institutions', 'fdic-structure-changes'].flatMap(
        (n) => adapterByName(n).kinds,
      ),
    );
    const feeds = DEFAULT_FEEDS.filter((f) => f.collection === 'consumer-finance');
    expect(feeds.length).toBeGreaterThan(0);
    for (const feed of feeds) {
      for (const kind of feed.query.kinds ?? []) expect(kinds.has(kind)).toBe(true);
    }
  });
});

describe('CFPB complaints', () => {
  test('a complaint becomes a row that names the company, the product and the issue', () => {
    const item = normaliseItem(complaintItem(hit()));
    expect(item.externalId).toBe('cfpb-26830447');
    expect(item.kind).toBe('complaint');
    expect(item.publishedAt.toISOString()).toBe('2026-09-09T03:59:29.000Z');
    expect(item.data.productFamily).toBe('credit-reporting');
    expect(item.tags).toContain('in-progress');
    expect(item.tags).toContain('in');
  });

  test('an unpublished narrative is absent, not an empty string', () => {
    // has_narrative is false and complaint_what_happened is '' on most rows.
    // Storing that '' would claim the consumer said nothing.
    const quiet = complaintItem(hit());
    expect(quiet.data.narrative).toBeNull();
    expect(quiet.data.hasNarrative).toBe(false);
    expect(quiet.tags).not.toContain('has-narrative');

    const spoken = complaintItem(
      hit({ has_narrative: true, complaint_what_happened: 'They never answered.' }),
    );
    expect(spoken.data.narrative).toBe('They never answered.');
    expect(spoken.tags).toContain('has-narrative');
    expect(spoken.summary).toContain('They never answered.');
  });

  test('the product family is short enough to be a tag and stable enough to be a feed', () => {
    expect(productFamily('Credit reporting or other personal consumer reports')).toBe(
      'credit-reporting',
    );
    expect(productFamily('Debt collection')).toBe('debt-collection');
    expect(productFamily('Checking or savings account')).toBe('bank-account');
    expect(productFamily('Vehicle loan or lease')).toBe('auto-loan');
    expect(productFamily('Payday loan, title loan, personal loan, or advance loan')).toBe(
      'payday-loan',
    );
    expect(productFamily('Something new the Bureau invented')).toBe('other');
    expect(productFamily(null)).toBeNull();
  });

  test('a row with no company, id or date is not a complaint', () => {
    expect(complaintItem(hit({ company: null }))).toBeNull();
    expect(complaintItem(hit({ complaint_id: null }))).toBeNull();
    expect(complaintItem(hit({ date_received: null }))).toBeNull();
  });

  test('the day walk covers every day and stops where it is told', () => {
    /* The search accepts an offset, echoes it, and ignores it: frm=0, frm=500
     * and frm=1000 return identical pages. So the adapter walks days instead of
     * offsets, and a gap in the walk is a day of complaints nobody would ever
     * see again. */
    expect(nextDay('2026-09-09')).toBe('2026-09-10');
    expect(nextDay('2026-09-30')).toBe('2026-10-01');
    expect(nextDay('2026-12-31')).toBe('2027-01-01');
    expect(nextDay('2028-02-28')).toBe('2028-02-29');
    expect(daysBetween('2026-09-07', '2026-09-09', 10)).toEqual([
      '2026-09-07',
      '2026-09-08',
      '2026-09-09',
    ]);
    expect(daysBetween('2026-09-07', '2026-09-30', 2)).toEqual(['2026-09-07', '2026-09-08']);
    expect(daysBetween('2026-09-09', '2026-09-09', 5)).toEqual(['2026-09-09']);
    expect(daysBetween('2026-09-10', '2026-09-09', 5)).toEqual([]);
    expect(utcDay('2026-09-09T23:59:59.000Z')).toBe('2026-09-09');
  });

  test('the narratives source sweeps rather than tails, because narratives arrive late', () => {
    // Complaints received in the last month carry one narrative between them;
    // the same query from four months back returns 42,516. A source following
    // the newest rows would be permanently empty.
    const sweeper = adapterByName('cfpb-complaints').defaultSources.find(
      (s) => s.config?.narrativesOnly === 'yes',
    );
    expect(sweeper).toBeDefined();
    expect(sweeper.config.sweepDays).toBeGreaterThan(90);
  });
});

describe('FDIC', () => {
  test('the register reads its dates whichever way they are written', () => {
    expect(fdicDate('01/20/1910')).toBe('1910-01-20');
    expect(fdicDate('7/17/2026')).toBe('2026-07-17');
    expect(fdicDate('2026-09-03T00:00:00')).toBe('2026-09-03');
    expect(fdicDate('20260717')).toBe('2026-07-17');
    expect(fdicDate('0')).toBeNull();
    expect(fdicDate(null)).toBeNull();
  });

  test('assets are reported in thousands, and a bank with none is not a bank with zero', () => {
    expect(thousands(276713)).toBe(276_713_000);
    expect(thousands(null)).toBeNull();
    expect(thousands('')).toBeNull();
    expect(thousands(0)).toBe(0);
    expect(money(412_620_000_000)).toBe('$412.62bn');
  });

  test('an institution carries the charter class the API actually publishes', () => {
    /* BankFind's institution endpoint has no CLASS field; the charter class is
     * BKCLASS. Asking for CLASS files every bank in the country as
     * unclassified and raises no error doing it. */
    const item = normaliseItem(
      institutionItem({
        data: {
          CERT: '14',
          NAME: 'State Street Bank and Trust Company',
          BKCLASS: 'SM',
          REGAGNT: 'FED',
          ASSET: 412_620_000,
          CITY: 'Boston',
          STALP: 'MA',
          ACTIVE: 1,
          ESTYMD: '01/01/1792',
          RUNDATE: '09/04/2026',
          SPECGRPN: 'All Other Over 1 Billion',
        },
      }),
    );
    expect(item.data.class).toBe('SM');
    expect(item.tags).toContain('class:sm');
    expect(item.tags).toContain('assets:100bn-plus');
    expect(item.data.establishedOn).toBe('1792-01-01');
  });

  test('a structure change is keyed on the row, not on the transaction', () => {
    /* One merger writes a row for every institution and office it touches:
     * 1,702 changes read in a single run carried only 1,169 distinct
     * transaction numbers. Keyed on TRANSNUM, a third of the register would
     * overwrite the rest, and the loss would look like a quiet quarter. */
    const base = {
      TRANSNUM: 2026024801,
      INSTNAME: 'The Fidelity Bank',
      PROCDATE: '2026-09-03T00:00:00',
      EFFDATE: '2026-08-11T00:00:00',
      CHANGECODE: '713',
      CHANGECODE_DESC: 'Branch Acquired in Merger/Consolidation/Failure',
      OFF_PCITY: 'Greensboro',
      OFF_PSTALP: 'NC',
    };
    const a = changeItem({ data: { ...base, ID: 'row-one', OFF_NAME: 'WESTPORT BRANCH' } });
    const b = changeItem({ data: { ...base, ID: 'row-two', OFF_NAME: 'PISGAH BRANCH' } });
    expect(a.externalId).not.toBe(b.externalId);

    // And with no ID the office and institution numbers have to rebuild one.
    const c = changeItem({ data: { ...base, UNINUM: '1', OFF_NUM: '7' } });
    const d = changeItem({ data: { ...base, UNINUM: '1', OFF_NUM: '9' } });
    expect(c.externalId).not.toBe(d.externalId);
  });

  test('the event is the change code, which is the field the FDIC actually fills in', () => {
    /* The register also carries twenty-odd boolean flags, and they are zero on
     * the great majority of transactions, mergers included. A reader built on
     * them reports almost nothing happening. */
    expect(familyOf('713')).toBe('branch');
    expect(familyOf('223')).toBe('merger');
    expect(familyOf('520')).toBe('name-or-location');
    expect(familyOf(null)).toBe('other');

    const item = normaliseItem(
      changeItem({
        data: {
          ID: 'x',
          TRANSNUM: 1,
          INSTNAME: 'Santander Bank, N.A.',
          PROCDATE: '2026-08-28T00:00:00',
          CHANGECODE: '721',
          CHANGECODE_DESC: 'Branch Closing',
          OFF_NAME: 'WESTPORT BRANCH',
          OFF_PCITY: 'Westport',
          OFF_PSTALP: 'CT',
        },
      }),
    );
    expect(item.data.change).toBe('Branch Closing');
    expect(item.tags).toContain('branch-closing');
    expect(item.tags).toContain('ct');
    expect(item.title).toContain('WESTPORT BRANCH');
  });

  test('a change with no name, transaction or date is not a change', () => {
    expect(changeItem({ data: { TRANSNUM: 1, PROCDATE: '2026-09-03T00:00:00' } })).toBeNull();
    expect(
      changeItem({ data: { INSTNAME: 'A Bank', PROCDATE: '2026-09-03T00:00:00' } }),
    ).toBeNull();
    expect(changeItem({ data: { TRANSNUM: 1, INSTNAME: 'A Bank' } })).toBeNull();
  });
});
