import { describe, expect, test } from 'bun:test';
import {
  complaintItem,
  complaintNumber,
  soqlTimestamp,
} from '../packages/adapters/src/fcc-unwanted-calls.js';
import { adapterByName } from '../packages/adapters/src/index.js';
import {
  areaCodeItem,
  blockFromRecord,
  exchangeFromCo,
  exchangeItem,
  nanpaDate,
} from '../packages/adapters/src/nanpa.js';
import { COL as NPPES_COL, toItem as nppesItem } from '../packages/adapters/src/nppes.js';
import {
  carrierName,
  lineTypeGuess,
  numberTag,
  toE164,
} from '../packages/adapters/src/phone-common.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

process.env.DATABASE_URL ??= 'postgres://localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';
const { COLLECTIONS, DEFAULT_FEEDS } = await import('../packages/core/src/seed.js');
const { isReservedNicheSlug } = await import('../packages/knowledge/src/index.js');
const { parseNumber } = await import('../apps/web/src/lib/phone.js');

describe('phone collection', () => {
  test('both adapters feed the phone collection, which exists with its feeds and a reserved slug', () => {
    expect(adapterByName('nanpa').collection).toBe('phone');
    expect(adapterByName('fcc-unwanted-calls').collection).toBe('phone');
    expect(COLLECTIONS.some((c) => c.slug === 'phone')).toBe(true);
    const feeds = DEFAULT_FEEDS.filter((f) => f.collection === 'phone').map((f) => f.slug);
    expect(feeds).toEqual(['fcc-unwanted-calls', 'fcc-robocalls', 'nanp-exchanges']);
    expect(isReservedNicheSlug('phone')).toBe(true);
  });
});

describe('phone-common', () => {
  test('numbers normalise to E.164 and tag by their digits', () => {
    expect(toE164('(520) 655-1816')).toBe('+15206551816');
    expect(toE164('+44 20 7946 0000')).toBe('+442079460000');
    expect(toE164('0044 20 7946 0000')).toBe('+442079460000');
    expect(toE164('112')).toBeNull();
    expect(numberTag('+15206551816')).toBe('num-15206551816');
  });

  test('the line type is guessed from the carrier name, landline by default', () => {
    expect(lineTypeGuess('CELLCO PARTNERSHIP DBA VERIZON WIRELESS')).toBe('wireless');
    expect(lineTypeGuess('OMNIPOINT COMMUNICATIONS CAP OPERATIONS, LLC')).toBe('wireless');
    expect(lineTypeGuess('ONVOY, LLC - WY')).toBe('voip');
    expect(lineTypeGuess('TELNYX LLC')).toBe('voip');
    expect(lineTypeGuess('VERIZON WASHINGTON DC, INC.')).toBe('landline');
    expect(lineTypeGuess('')).toBeNull();
  });

  test('carrier names read as names', () => {
    expect(carrierName('"CELLCO PARTNERSHIP DBA VERIZON WIRELESS"   ')).toBe(
      'Cellco Partnership DBA Verizon Wireless',
    );
    expect(carrierName('TELNYX LLC')).toBe('Telnyx LLC');
  });
});

describe('nanpa', () => {
  test('dates in both NANPA forms', () => {
    expect(nanpaDate('02/21/2006')).toBe('2006-02-21');
    expect(nanpaDate('01-Jan-1947')).toBe('1947-01-01');
    expect(nanpaDate('   ')).toBeNull();
  });

  test('an npa_report row becomes an area code; an unassigned one does not', () => {
    const it = areaCodeItem({
      NPA_ID: '202',
      type_of_code: 'General Purpose Code',
      ASSIGNED: 'Yes',
      ASSIGNMENT_DT: '01-Jan-1947',
      LOCATION: 'DC',
      COUNTRY: 'US',
      IN_SERVICE: 'Y',
      IN_SERVICE_DT: '01-Jan-1947',
      OVERLAY: 'Yes',
      OVERLAY_COMPLEX: '202/771',
      TIME_ZONE: 'E',
    });
    expect(it.externalId).toBe('nanp:202');
    expect(it.kind).toBe('area-code');
    expect(it.tags).toContain('state-dc');
    expect(it.data.timeZones).toEqual(['Eastern']);
    expect(it.data.overlay).toBe('202/771');
    expect(normaliseItem(it)).not.toBeNull();
    expect(areaCodeItem({ NPA_ID: '200', ASSIGNED: 'No' })).toBeNull();
  });

  test('a CO code line (tab-separated, padded) becomes an exchange', () => {
    const cells =
      'AK   \t907-201\t6563\t"CELLCO PARTNERSHIP DBA VERIZON WIRELESS"     \tELMEDRFAFB\t             \tAS \t09/18/2014   \tI             \tY           \tYes      '.split(
        '\t',
      );
    const ex = exchangeFromCo(cells);
    expect(ex).toMatchObject({
      npa: '907',
      nxx: '201',
      state: 'AK',
      ocn: '6563',
      company: 'Cellco Partnership DBA Verizon Wireless',
      rateCenter: 'ELMEDRFAFB',
      assignedAt: '2014-09-18',
      pooled: true,
      inService: true,
    });
    expect(exchangeFromCo(['State', 'NPA-NXX'])).toBeNull();
  });

  test('a pooled exchange carries its blocks and names each block’s carrier', () => {
    const rec = (x, status, company, ocn) => [
      'MA',
      'DC',
      '202',
      '200',
      x,
      status,
      '',
      '',
      '',
      'WSHNGTNZN1',
      '03/20/2011',
      '',
      company,
      ocn,
      '01/25/2011',
    ];
    const blocks = [
      blockFromRecord(rec('0', 'AS', 'OMNIPOINT COMMUNICATIONS CAP OPERATIONS, LLC', '6855')),
      blockFromRecord(rec('1', 'AS', 'METROPCS, INC.', '5562')),
      blockFromRecord(rec('2', 'RT', 'VERIZON WASHINGTON DC, INC.', '9211')),
    ];
    expect(blocks[1]).toMatchObject({
      x: '1',
      status: 'assigned',
      ocn: '5562',
      assignedAt: '2011-01-25',
    });
    expect(blocks[2].status).toBe('retained by the code holder');
    const it = exchangeItem(
      {
        npa: '202',
        nxx: '200',
        state: 'DC',
        ocn: '6855',
        company: 'Omnipoint',
        rateCenter: 'WSHNGTNZN1',
        pooled: true,
      },
      blocks,
    );
    expect(it.externalId).toBe('nanp:202-200');
    expect(it.data.blocks).toHaveLength(3);
    expect(it.data.lineTypeGuess).toBe('wireless');
    expect(it.tags).toEqual(
      expect.arrayContaining(['pooled', 'nxx-202-200', 'npa-202', 'line-guess-wireless']),
    );
    expect(it.summary).toContain('3 blocks of 1,000 across 3 carriers');
    expect(normaliseItem(it)).not.toBeNull();
  });
});

describe('fcc-unwanted-calls', () => {
  const row = {
    id: '9400249',
    ticket_created: '2026-11-25T04:54:38.000Z',
    issue: 'Unwanted Calls',
    method: 'Wireless (cell phone/other mobile device)',
    caller_id_number: '520-655-1816',
    type_of_call_or_messge: 'Live Voice',
    advertiser_business_phone_number: '571-704-8960',
    city: 'Scottsdale',
    state: 'AZ',
    zip: '85262',
    location_1: { latitude: '33.74', longitude: '-111.84' },
    type_of_property_goods_or_services: 'Irs Services',
  };

  test('a damaged cursor never reaches the SoQL query', async () => {
    expect(soqlTimestamp('2026-11-25T01:00:00.000')).toBe('2026-11-25T01:00:00.000');
    expect(soqlTimestamp("2026' OR '1'='1")).toBeNull();
    const asked = [];
    const http = {
      json: async (url) => (asked.push(decodeURIComponent(url.replace(/\+/g, ' '))), []),
    };
    const gen = adapterByName('fcc-unwanted-calls').pull({
      cursor: { since: "x' OR 1=1 --" },
      http,
      log: () => {},
    });
    while (!(await gen.next()).done);
    expect(asked[0]).toContain("ticket_created > '2016-01-01T00:00:00.000'");
    expect(asked[0]).not.toContain('OR 1=1');
  });

  test('only real ten-digit NANP numbers count', () => {
    expect(complaintNumber('520-655-1816')).toBe('+15206551816');
    expect(complaintNumber('1-520-655-1816')).toBe('+15206551816');
    expect(complaintNumber('000-000-0000')).toBeNull();
    expect(complaintNumber('Unknown')).toBeNull();
  });

  test('a complaint is tagged by both numbers and keeps only the complainant’s state', () => {
    const it = complaintItem(row);
    expect(it.externalId).toBe('fcc:9400249');
    expect(it.kind).toBe('call-complaint');
    expect(it.tags).toEqual(
      expect.arrayContaining(['num-15206551816', 'num-15717048960', 'call-live-voice', 'state-az']),
    );
    expect(it.data).toMatchObject({
      caller: '+15206551816',
      callback: '+15717048960',
      state: 'AZ',
    });
    const text = JSON.stringify(it);
    expect(text).not.toContain('Scottsdale');
    expect(text).not.toContain('85262');
    expect(text).not.toContain('33.74');
    expect(normaliseItem(it)).not.toBeNull();
    expect(complaintItem({ ...row, caller_id_number: '' })).toBeNull();
  });

  test('pull walks pages by ticket_created and never moves the cursor backwards', async () => {
    const pages = [
      Array.from({ length: 2 }, (_, i) => ({
        ...row,
        id: String(i),
        ticket_created: `2026-11-25T0${i}:00:00.000Z`,
      })),
    ];
    const asked = [];
    const http = {
      json: async (url) => (
        asked.push(decodeURIComponent(url.replace(/\+/g, ' '))), pages.shift() ?? []
      ),
    };
    const out = [];
    const gen = adapterByName('fcc-unwanted-calls').pull({ cursor: {}, http, log: () => {} });
    let r = await gen.next();
    while (!r.done) {
      out.push(r.value);
      r = await gen.next();
    }
    expect(out[0].items).toHaveLength(2);
    expect(asked[0]).toContain("ticket_created > '2016-01-01T00:00:00.000'");
    expect(r.value.cursor.since).toBe('2026-11-25T01:00:00.000');
  });
});

describe('nppes phones', () => {
  test('an organisation is tagged by its practice phone, an individual never', () => {
    const row = (type) => {
      const c = new Array(330).fill('');
      c[NPPES_COL.npi] = '1234567893';
      c[NPPES_COL.entityType] = type;
      c[NPPES_COL.orgName] = 'Example Clinic';
      c[NPPES_COL.firstName] = 'Pat';
      c[NPPES_COL.lastName] = 'Doe';
      c[NPPES_COL.practiceState] = 'CA';
      c[NPPES_COL.practicePhone] = '4155550143';
      return c;
    };
    const org = nppesItem(row('2'), new Map());
    expect(org.tags).toContain('num-14155550143');
    const person = nppesItem(row('1'), new Map());
    expect(person.tags.some((t) => t.startsWith('num-'))).toBe(false);
    expect(JSON.stringify(person)).not.toContain('4155550143');
  });
});

describe('/phone parsing', () => {
  test('North American numbers split into area code, exchange and block', () => {
    const n = parseNumber('(202) 555-0143');
    expect(n).toMatchObject({
      e164: '+12025550143',
      digits: '12025550143',
      nanp: true,
      npa: '202',
      nxx: '555',
      block: '0',
    });
    expect(parseNumber('1 202 555 0143').e164).toBe('+12025550143');
  });

  test('other countries keep their own line type', () => {
    const uk = parseNumber('+44 7400 123456');
    expect(uk.country).toBe('GB');
    expect(uk.type).toBe('mobile');
    expect(uk.nanp).toBe(false);
    expect(uk.npa).toBeNull();
  });

  test('garbage is not a number', () => {
    expect(parseNumber('hello')).toBeNull();
    expect(parseNumber('12')).toBeNull();
  });
});
