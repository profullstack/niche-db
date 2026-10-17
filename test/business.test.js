import { describe, expect, test } from 'bun:test';

// As in vin-history.test.js: the config reads the environment at import.
// Nothing here touches the network or a database.
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';

const {
  businessReport,
  decodeZone,
  domainSection,
  matchSanctions,
  nameMatch,
  normaliseInput,
  parseCsv,
  sanctionsIndex,
  verdictOf,
  zoneLookup,
} = await import('../apps/web/src/lib/business.js');

/** Rows the way OFAC writes them: quoted, "-0-" for empty, CRLF. */
const SDN = [
  '36,"AEROCARIBBEAN AIRLINES",-0- ,"CUBA",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ',
  '173,"ANGLO-CARIBBEAN CO., LTD.",-0- ,"CUBA",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,"Ibex House, London"',
  '9999,"ACME WIDGETS HOLDING",-0- ,"[SDGT] [IRAN]",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ',
].join('\r\n');
const ALT = '9999,101,"aka","ROADRUNNER TRADING LLC",-0- \r\n';
const CONS =
  '17000,"NORTHWIND SHIPPING CO",-0- ,"[NS-MBS]",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- \r\n';

describe('parseCsv', () => {
  test('quotes, doubled quotes, commas inside quotes and CRLF', () => {
    expect(parseCsv('a,"b, c","say ""hi"""\r\nd,e,f\r\n')).toEqual([
      ['a', 'b, c', 'say "hi"'],
      ['d', 'e', 'f'],
    ]);
  });
});

describe('names', () => {
  test('entity words and punctuation do not decide a match', () => {
    expect(nameMatch('Profullstack, Inc.', 'PROFULLSTACK INC')).toBe('exact');
    expect(nameMatch('Profullstack', 'Profullstack.com')).toBeNull();
  });
  test('one shared word is a coincidence, not a match', () => {
    expect(nameMatch('Acme', 'Acme Widgets Holding')).toBeNull();
    expect(nameMatch('Acme Widgets', 'ACME WIDGETS HOLDING')).toBe('possible');
  });
  test('input is cleaned and a missing field is null', () => {
    expect(
      normaliseInput({
        q: ' Profullstack, Inc. ',
        domain: 'https://www.Profullstack.com/x',
        ein: '832874338',
        state: 'CA',
        number: 'C4218574',
      }),
    ).toEqual({
      name: 'Profullstack, Inc.',
      domain: 'profullstack.com',
      ein: '83-2874338',
      state: 'ca',
      number: '4218574',
    });
  });
});

describe('sanctions', () => {
  const index = sanctionsIndex({ sdn: SDN, alt: ALT, cons: CONS });

  test('every entry, programs split, aliases attached', () => {
    expect(index.length).toBe(4);
    const acme = index.find((e) => e.uid === 'sdn:9999');
    expect(acme.programs).toEqual(['SDGT', 'IRAN']);
    expect(acme.aliases).toEqual(['ROADRUNNER TRADING LLC']);
  });

  test('an alias matches, and says it was the alias', () => {
    const [hit] = matchSanctions(index, 'Roadrunner Trading');
    expect(hit.uid).toBe('sdn:9999');
    expect(hit.match).toBe('exact');
    expect(hit.matchedName).toBe('ROADRUNNER TRADING LLC');
  });

  test('the consolidated list is searched too', () => {
    expect(matchSanctions(index, 'Northwind Shipping Company')[0]?.list).toBe('cons');
  });

  test('a clean name finds nothing', () => {
    expect(matchSanctions(index, 'Profullstack, Inc.')).toEqual([]);
  });
});

describe('reputation zones', () => {
  test('Spamhaus DBL codes, and its refusal range', () => {
    expect(decodeZone('dbl', ['127.0.1.2']).reasons[0].label).toBe('spam domain');
    expect(decodeZone('dbl', ['127.255.255.254'])).toEqual({ refused: true, reasons: [] });
  });
  test('ZEN PBL is policy and does not count', () => {
    const { reasons } = decodeZone('zen', ['127.0.0.2', '127.0.0.10']);
    expect(reasons.map((r) => r.policy)).toEqual([false, true]);
  });
  test('SURBL 127.0.0.254 is its test entry on every list, not a refusal', () => {
    const { refused, reasons } = decodeZone('surbl', ['127.0.0.254']);
    expect(refused).toBe(false);
    expect(reasons.length).toBe(6);
  });
  test('URIBL 127.0.0.1 is a refusal, not a listing', () => {
    expect(decodeZone('uribl', ['127.0.0.1'])).toEqual({ refused: true, reasons: [] });
    expect(decodeZone('uribl', ['127.0.0.14']).reasons.map((r) => r.label)).toEqual([
      'black',
      'grey',
      'red',
    ]);
  });

  const zone = (answers) => async (n) => {
    for (const [k, v] of Object.entries(answers)) if (n.startsWith(k)) return v;
    throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
  };

  test('a zone that does not list its own canary proves nothing', async () => {
    // This is what asking through 8.8.8.8 looks like: silence for everything.
    const r = await zoneLookup('dbl', 'example.com', { resolve: zone({}) });
    expect(r.status).toBe('unknown');
  });
  test('with the canary answering, silence is clear and an answer is listed', async () => {
    const resolve = zone({ 'dbltest.com.': ['127.0.1.2'], 'spammy.example.': ['127.0.1.2'] });
    expect((await zoneLookup('dbl', 'clean.example', { resolve })).status).toBe('clear');
    expect((await zoneLookup('dbl', 'spammy.example', { resolve })).status).toBe('listed');
  });
  test('an address is asked reversed', async () => {
    const asked = [];
    const resolve = async (n) => {
      asked.push(n);
      if (n.startsWith('2.0.0.127.')) return ['127.0.0.2'];
      throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
    };
    await zoneLookup('zen', '23.95.228.174', { resolve });
    expect(asked).toContain('174.228.95.23.zen.spamhaus.org');
  });
  test('with blocklists off the section says so and links the self checks', async () => {
    const d = await domainSection('profullstack.com', {
      blocklists: false,
      resolveA: async () => ['192.0.2.1'],
    });
    expect(d.status).toBe('unconfigured');
    expect(d.selfChecks.length).toBeGreaterThan(0);
  });
});

describe('verdict', () => {
  const ok = (extra = {}) => ({ status: 'checked', source: 's', ...extra });

  test('never clear while a list was not checked', () => {
    const v = verdictOf({
      sanctions: ok({ found: 'none', hits: [] }),
      gleif: ok({ records: [] }),
      edgar: ok({ filers: [] }),
      opencorporates: { status: 'unconfigured', source: 'OpenCorporates' },
      sam: ok({ exclusions: [] }),
      domain: { status: 'skipped' },
    });
    expect(v.standing).toBe('incomplete');
    expect(v.notChecked).toEqual(['OpenCorporates']);
  });

  test('one list that could not answer keeps it incomplete', () => {
    const v = verdictOf({
      sanctions: ok({ found: 'none', hits: [] }),
      domain: ok({
        domain: 'x.com',
        lists: [
          { list: 'Spamhaus DBL', subject: 'x.com', status: 'clear', reasons: [] },
          { list: 'SURBL', subject: 'x.com', status: 'unknown' },
        ],
      }),
    });
    expect(v.standing).toBe('incomplete');
    expect(v.notChecked).toEqual(['SURBL (x.com)']);
  });

  test('clear only when everything ran and nothing was found', () => {
    expect(
      verdictOf({
        sanctions: ok({ found: 'none', hits: [] }),
        gleif: ok({ records: [] }),
        edgar: ok({ filers: [] }),
        opencorporates: ok({ companies: [] }),
        sam: ok({ exclusions: [] }),
        domain: ok({
          lists: [{ list: 'Spamhaus DBL', subject: 'x.com', status: 'clear', reasons: [] }],
        }),
      }).standing,
    ).toBe('clear');
  });

  test('a listed domain or a suspended company flags it', () => {
    const v = verdictOf({
      sanctions: ok({ found: 'none', hits: [] }),
      opencorporates: ok({
        companies: [
          { match: 'exact', name: 'X', status: 'Suspended', jurisdiction: 'us_ca', number: '1' },
        ],
      }),
      domain: ok({
        domain: 'x.com',
        lists: [
          {
            list: 'Spamhaus DBL',
            subject: 'x.com',
            status: 'listed',
            reasons: [{ label: 'spam domain' }],
          },
        ],
      }),
    });
    expect(v.standing).toBe('flagged');
    expect(v.findings.map((f) => f.severity)).toEqual(['serious', 'warning']);
  });
});

describe('the report', () => {
  test('every section runs, and a failing one is unknown, not fatal', async () => {
    const r = await businessReport(
      { name: 'Profullstack, Inc.', domain: 'profullstack.com', state: 'ca', number: '4218574' },
      {
        noCache: true,
        loadSanctions: async () => ({
          index: sanctionsIndex({ sdn: SDN }),
          fetchedAt: '2026-10-17T00:00:00Z',
        }),
        fetchImpl: async () => {
          throw new Error('offline');
        },
        token: null,
        key: null,
        blocklists: false,
        resolveA: async () => [],
        rdap: async () => ({ status: 'registered', registrar: 'Porkbun' }),
      },
    );
    expect(r.sections.sanctions.found).toBe('none');
    expect(r.sections.gleif.status).toBe('unknown');
    expect(r.sections.domain.registration.registrar).toBe('Porkbun');
    expect(r.standing).toBe('incomplete');
    expect(r.lookUpYourself.some((l) => l.url.includes('bizfileonline'))).toBe(true);
  });

  test('nothing to look up is an error', async () => {
    await expect(businessReport({ name: 'x' }, { noCache: true })).rejects.toThrow();
  });
});
