import { describe, expect, test } from 'bun:test';
import { ADAPTERS, adapterByName } from '../packages/adapters/src/index.js';
import {
  addressOf,
  assertLayout,
  COL,
  candidateFiles,
  displayName,
  isActive,
  monthlyFile,
  npiDate,
  pickMainMember,
  splitCsvLine,
  TAXONOMY_FIRST,
  TAXONOMY_SLOTS,
  TAXONOMY_STRIDE,
  taxonomiesOf,
  toItem,
} from '../packages/adapters/src/nppes.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';
const { COLLECTIONS } = await import('../packages/core/src/seed.js');

/* The code set, as the run fetches it from NUCC. */
const NAMES = new Map([
  ['207X00000X', 'Orthopaedic Surgery Physician'],
  ['251G00000X', 'Community Based Hospice Care Agency'],
  ['207Q00000X', 'Family Medicine Physician'],
]);

/** A 330-column row with only the fields under test set. */
function row(fields = {}) {
  const cells = new Array(330).fill('');
  for (const [k, v] of Object.entries(fields)) cells[Number(k)] = v;
  return cells;
}

/*
 * Two real records, read out of the September 2026 V2 file on 2026-09-25.
 * Real values rather than invented ones, so the column map is tested against
 * what CMS actually ships.
 */
const DAVID = row({
  [COL.npi]: '1679576722',
  [COL.entityType]: '1',
  [COL.lastName]: 'WIEBE',
  [COL.firstName]: 'DAVID',
  [COL.credential]: 'M.D.',
  [COL.practiceStreet1]: '3500 CENTRAL AVE',
  [COL.practiceCity]: 'KEARNEY',
  [COL.practiceState]: 'NE',
  [COL.practicePostal]: '688472944',
  [COL.practicePhone]: '3088652512',
  [COL.enumerationDate]: '05/23/2005',
  [TAXONOMY_FIRST]: '207X00000X',
  [TAXONOMY_FIRST + 3]: 'Y',
});

const HOSPICE = row({
  [COL.npi]: '1497758544',
  [COL.entityType]: '2',
  [COL.orgName]: 'CUMBERLAND COUNTY HOSPITAL SYSTEM, INC',
  [COL.practiceStreet1]: '150 ROBESON ST',
  [COL.practiceCity]: 'FAYETTEVILLE',
  [COL.practiceState]: 'NC',
  [COL.practicePostal]: '283041824',
  [COL.enumerationDate]: '05/23/2005',
  [TAXONOMY_FIRST]: '251G00000X',
  [TAXONOMY_FIRST + 3]: 'Y',
});

describe('the column map, against the real file layout', () => {
  test('the header check passes the layout this was written for', () => {
    const header = new Array(330).fill('');
    header[0] = 'NPI';
    header[1] = 'Entity Type Code';
    header[4] = 'Provider Organization Name (Legal Business Name)';
    header[5] = 'Provider Last Name (Legal Name)';
    header[6] = 'Provider First Name';
    header[30] = 'Provider Business Practice Location Address City Name';
    header[31] = 'Provider Business Practice Location Address State Name';
    header[47] = 'Healthcare Provider Taxonomy Code_1';
    expect(() => assertLayout(header)).not.toThrow();
  });

  test('a shifted column fails loudly instead of writing the wrong field', () => {
    // This is the failure mode worth catching: a 330-column government file
    // gains a column and every name silently becomes a middle name.
    const header = new Array(330).fill('');
    header[0] = 'NPI';
    header[1] = 'Entity Type Code';
    header[6] = 'Provider Middle Name';
    expect(() => assertLayout(header)).toThrow(/layout has changed/);
  });

  test('taxonomy slots are four columns apart, fifteen of them', () => {
    expect(TAXONOMY_FIRST).toBe(47);
    expect(TAXONOMY_STRIDE).toBe(4);
    expect(TAXONOMY_SLOTS).toBe(15);
  });
});

describe('npiDate', () => {
  test('reads the slash form the file uses', () => {
    expect(npiDate('05/23/2005')).toBe('2005-05-23');
  });

  test('reads a plain YYYYMMDD', () => {
    expect(npiDate('20260913')).toBe('2026-09-13');
  });

  test('is empty rather than wrong for a blank', () => {
    expect(npiDate('')).toBeNull();
    expect(npiDate(null)).toBeNull();
    expect(npiDate('not a date')).toBeNull();
  });
});

describe('splitCsvLine', () => {
  test('keeps commas inside quotes', () => {
    expect(splitCsvLine('"a,b",c')).toEqual(['a,b', 'c']);
  });

  test('unescapes a doubled quote', () => {
    expect(splitCsvLine('"he said ""hi""",x')).toEqual(['he said "hi"', 'x']);
  });
});

describe('names', () => {
  test('an individual reads as a person, with credentials', () => {
    expect(displayName(DAVID)).toBe('DAVID WIEBE, M.D.');
  });

  test('an organization reads as its legal name', () => {
    expect(displayName(HOSPICE)).toBe('CUMBERLAND COUNTY HOSPITAL SYSTEM, INC');
  });
});

describe('taxonomies', () => {
  test('a code becomes a specialty a person can read', () => {
    const [primary] = taxonomiesOf(DAVID, NAMES);
    expect(primary.code).toBe('207X00000X');
    expect(primary.name).toBe('Orthopaedic Surgery Physician');
    expect(primary.primary).toBe(true);
  });

  test('the primary sorts first even when it is not listed first', () => {
    const cells = row({
      [TAXONOMY_FIRST]: '207Q00000X',
      [TAXONOMY_FIRST + 3]: 'N',
      [TAXONOMY_FIRST + TAXONOMY_STRIDE]: '207X00000X',
      [TAXONOMY_FIRST + TAXONOMY_STRIDE + 3]: 'Y',
    });
    expect(taxonomiesOf(cells, NAMES)[0].code).toBe('207X00000X');
  });

  test('an unknown code keeps the code rather than dropping the row', () => {
    const cells = row({ [TAXONOMY_FIRST]: '999ZZZZZZX' });
    const [t] = taxonomiesOf(cells, NAMES);
    expect(t.code).toBe('999ZZZZZZX');
    expect(t.name).toBeNull();
  });
});

describe('the privacy decision', () => {
  test("an individual's street address is withheld by default", () => {
    const a = addressOf(DAVID);
    expect(a.street).toBeUndefined();
    expect(a.streetWithheld).toBe(true);
    expect(a.city).toBe('KEARNEY');
    expect(a.state).toBe('NE');
  });

  test('the ZIP is cut to five digits, since ZIP+4 is nearly a building', () => {
    expect(addressOf(DAVID).postalCode).toBe('68847');
  });

  test("an individual's phone is withheld with the street", () => {
    expect(addressOf(DAVID).phone).toBeUndefined();
  });

  test('an organization keeps its full address', () => {
    const a = addressOf(HOSPICE);
    expect(a.street).toBeDefined();
    expect(a.streetWithheld).toBeUndefined();
  });

  test('the withholding can be turned off deliberately', () => {
    const a = addressOf(DAVID, { includeIndividualStreet: true });
    expect(a.street).toEqual(['3500 CENTRAL AVE']);
    expect(a.streetWithheld).toBeUndefined();
  });

  test('a built item never carries an individual street by default', () => {
    const item = toItem(DAVID, NAMES);
    expect(JSON.stringify(item)).not.toContain('3500 CENTRAL AVE');
  });
});

describe('active and deactivated', () => {
  test('a record with no deactivation date is active', () => {
    expect(isActive(DAVID)).toBe(true);
  });

  test('a deactivated NPI is not active', () => {
    expect(isActive(row({ [COL.deactivationDate]: '20200101' }))).toBe(false);
  });

  test('a reactivation after the deactivation makes it active again', () => {
    const cells = row({ [COL.deactivationDate]: '20200101', [COL.reactivationDate]: '20210301' });
    expect(isActive(cells)).toBe(true);
  });
});

describe('toItem', () => {
  test('an individual becomes a storable item', () => {
    const item = normaliseItem(toItem(DAVID, NAMES));
    expect(item.externalId).toBe('npi-1679576722');
    expect(item.title).toBe('DAVID WIEBE, M.D.');
    expect(item.kind).toBe('provider');
    expect(item.url).toBe('https://npiregistry.cms.hhs.gov/provider-view/1679576722');
    expect(item.summary).toContain('Orthopaedic Surgery Physician');
    expect(item.summary).toContain('KEARNEY, NE');
    expect(item.tags).toContain('individual');
    expect(item.tags).toContain('ne');
  });

  test('an organization becomes a storable item', () => {
    const item = normaliseItem(toItem(HOSPICE, NAMES));
    expect(item.title).toBe('CUMBERLAND COUNTY HOSPITAL SYSTEM, INC');
    expect(item.tags).toContain('organization');
    expect(item.data.entityType).toBe('organization');
  });

  test('a deactivated shell row is dropped rather than stored nameless', () => {
    // 2,353 of the first 24,000 rows have a blank entity type and no name:
    // NPIs that were deactivated and stripped. They are not providers.
    expect(toItem(row({ [COL.npi]: '1234567890' }), NAMES)).toBeNull();
  });

  test('a row with no valid NPI is dropped', () => {
    expect(toItem(row({ [COL.npi]: 'nope', [COL.lastName]: 'X' }), NAMES)).toBeNull();
  });
});

describe('the monthly file', () => {
  test('is named for its month', () => {
    expect(monthlyFile(new Date(Date.UTC(2026, 8, 14)))).toBe(
      'NPPES_Data_Dissemination_September_2026_V2.zip',
    );
  });

  test('candidates walk back, because the current month may not be posted yet', () => {
    const files = candidateFiles(new Date(Date.UTC(2026, 0, 3)), 3);
    expect(files[0]).toContain('January_2026');
    expect(files[1]).toContain('December_2025');
    expect(files[2]).toContain('November_2025');
  });
});

describe('picking the data member out of the archive', () => {
  test('takes the data file, not the same-named header file', () => {
    // The archive ships npidata_pfile_<range>_fileheader.csv alongside the
    // data: one row, the header. Reading it instead would look like an empty
    // but successful walk.
    const members = [
      'pl_pfile_20050523-20260913.csv',
      'npidata_pfile_20050523-20260913_fileheader.csv',
      'npidata_pfile_20050523-20260913.csv',
      'NPPES_Data_Dissemination_Readme_v.2.pdf',
    ];
    expect(pickMainMember(members)).toBe('npidata_pfile_20050523-20260913.csv');
  });

  test('is null when the archive holds no data file', () => {
    expect(pickMainMember(['readme.pdf'])).toBeNull();
  });
});

describe('registration', () => {
  test('the adapter is registered in the health collection', () => {
    const adapter = adapterByName('nppes-providers');
    expect(adapter).toBeTruthy();
    expect(adapter.collection).toBe('health');
    expect(adapter.kinds).toEqual(['provider']);
    expect(ADAPTERS).toContain(adapter);
  });

  test('it declares a budget, because a 4 GB walk is not a few minutes', () => {
    expect(adapterByName('nppes-providers').budgetMs).toBeGreaterThan(60 * 60 * 1000);
  });

  test('it withholds individual streets unless configured otherwise', () => {
    expect(adapterByName('nppes-providers').defaults.includeIndividualStreet).toBe('no');
  });

  test('the health collection exists', () => {
    expect(COLLECTIONS.some((c) => c.slug === 'health')).toBe(true);
  });
});
