import { describe, expect, test } from 'bun:test';

import {
  ACTION_TYPES,
  actionToItem,
  daysAgo,
  GROUP_TO_TYPE,
  newsToItem,
} from '../packages/adapters/src/alpaca.js';
import { toItem as ecbItem, parseRates } from '../packages/adapters/src/ecb.js';
import { ADAPTERS, adapterByName } from '../packages/adapters/src/index.js';
import { micDate, toItem as micItem, parseCsv, website } from '../packages/adapters/src/mic.js';
import { toItem as haltItem, haltTime } from '../packages/adapters/src/nasdaqhalts.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

// The seed module reaches the database package, which reads the environment at
// import. It needs the variable to exist, not to connect.
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';
const { COLLECTIONS, DEFAULT_FEEDS } = await import('../packages/core/src/seed.js');

describe('the markets collection', () => {
  test('exists, and every markets adapter is registered in it', () => {
    expect(COLLECTIONS.map((c) => c.slug)).toContain('markets');
    for (const name of [
      'iso-mic-exchanges',
      'alpaca-corporate-actions',
      'alpaca-news',
      'nasdaq-halts',
      'ecb-fx-rates',
    ]) {
      expect(adapterByName(name)?.collection).toBe('markets');
    }
  });

  test('only the Alpaca adapters need a credential, so the rest run on a bare deployment', () => {
    const needs = (n) => adapterByName(n).needsEnv ?? [];
    expect(needs('alpaca-corporate-actions')).toEqual(['alpacaKeyId', 'alpacaSecretKey']);
    expect(needs('alpaca-news')).toEqual(['alpacaKeyId', 'alpacaSecretKey']);
    for (const n of ['iso-mic-exchanges', 'nasdaq-halts', 'ecb-fx-rates']) {
      expect(needs(n)).toEqual([]);
    }
  });

  test('every markets feed queries a kind some markets adapter emits', () => {
    const emitted = new Set(
      ADAPTERS.filter((a) => a.collection === 'markets').flatMap((a) => a.kinds),
    );
    const feeds = DEFAULT_FEEDS.filter((f) => f.collection === 'markets');
    expect(feeds.length).toBeGreaterThan(8);
    for (const f of feeds) {
      for (const kind of f.query.kinds ?? []) expect(emitted).toContain(kind);
    }
  });

  test('no two feeds share a slug, which the schema requires globally', () => {
    const slugs = DEFAULT_FEEDS.map((f) => f.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});

describe('the world exchange register', () => {
  test('a quoted comma does not shift every column after it', () => {
    // The case that motivated writing a parser rather than splitting on commas:
    // "OMIP - POLO PORTUGUES, S.G.M.R., S.A." would otherwise file a Portuguese
    // energy market under a country code taken from the middle of its own name.
    const rows = parseCsv(
      'MIC,NAME,COUNTRY\nOMIP,"OMIP - POLO PORTUGUES, S.G.M.R., S.A.",PT\nXNAI,NAIROBI SECURITIES EXCHANGE,KE\n',
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      MIC: 'OMIP',
      NAME: 'OMIP - POLO PORTUGUES, S.G.M.R., S.A.',
      COUNTRY: 'PT',
    });
    expect(rows[1].COUNTRY).toBe('KE');
  });

  test('a doubled quote inside a field is one literal quote', () => {
    const rows = parseCsv('A,B\n"say ""hi""",2\n');
    expect(rows[0].A).toBe('say "hi"');
  });

  test('a trailing newline is not a row', () => {
    expect(parseCsv('A,B\n1,2\n')).toHaveLength(1);
  });

  test('ISO dates have no separators, and are often blank', () => {
    expect(micDate('20260731')).toBe('2026-07-31');
    expect(micDate('')).toBeNull();
    expect(micDate('2026-07-31')).toBeNull();
  });

  test('the register writes websites in capitals and without a scheme', () => {
    expect(website('WWW.THECSE.COM')).toBe('https://www.thecse.com');
    expect(website('https://X.COM')).toBe('https://x.com');
    expect(website('')).toBeNull();
    expect(website('N/A')).toBeNull();
  });

  const row = (over = {}) => ({
    MIC: 'XNAI',
    'OPERATING MIC': 'XNAI',
    'OPRT/SGMT': 'OPRT',
    'MARKET NAME-INSTITUTION DESCRIPTION': 'NAIROBI SECURITIES EXCHANGE',
    'LEGAL ENTITY NAME': 'NAIROBI SECURITIES EXCHANGE PLC',
    LEI: '5493001VPFHOBJ0FQI47',
    'MARKET CATEGORY CODE': 'RMKT',
    ACRONYM: 'NSE',
    'ISO COUNTRY CODE (ISO 3166)': 'KE',
    CITY: 'NAIROBI',
    WEBSITE: 'WWW.NSE.CO.KE',
    STATUS: 'ACTIVE',
    'CREATION DATE': '20050415',
    'LAST UPDATE DATE': '20260731',
    'LAST VALIDATION DATE': '20260731',
    'EXPIRY DATE': '',
    COMMENTS: '',
    ...over,
  });

  test('a venue anywhere in the world reads the same as one in New York', () => {
    const i = micItem(row());
    expect(i.title).toBe('XNAI — NAIROBI SECURITIES EXCHANGE');
    expect(i.kind).toBe('exchange');
    expect(i.tags).toContain('ke');
    expect(i.tags).toContain('regulated-market');
    expect(i.data.lei).toBe('5493001VPFHOBJ0FQI47');
    expect(i.data.city).toBe('Nairobi');
    expect(i.url).toBe('https://www.nse.co.ke');
  });

  test('an exchange that closed is news, not a row to be filtered away', () => {
    const i = micItem(row({ STATUS: 'EXPIRED', 'EXPIRY DATE': '20260630' }));
    expect(i.title).toContain('(expired)');
    expect(i.tags).toContain('expired');
    expect(i.data.expires).toBe('2026-06-30');
  });

  test('a row is keyed by when the register last touched it, so a still row is quiet', () => {
    const a = micItem(row());
    expect(micItem(row()).externalId).toBe(a.externalId);
    expect(micItem(row({ 'LAST UPDATE DATE': '20260831' })).externalId).not.toBe(a.externalId);
  });

  test('a segment says it trades under another venue', () => {
    const i = micItem(row({ MIC: 'XNAB', 'OPRT/SGMT': 'SGMT', 'OPERATING MIC': 'XNAI' }));
    expect(i.data.segment).toBe(true);
    expect(i.data.operatingMic).toBe('XNAI');
    expect(i.summary).toContain('operated under XNAI');
  });

  test('the item survives normalisation', () => {
    const n = normaliseItem(micItem(row()));
    expect(n).not.toBeNull();
    expect(n.publishedAt).toBeInstanceOf(Date);
  });
});

describe('Alpaca corporate actions', () => {
  test('the request name is singular and the response key is plural', () => {
    // The mismatch that produced a 400: `types=cash_dividends` is rejected and
    // `types=cash_dividend` is accepted, but the reply arrives under
    // `corporate_actions.cash_dividends`.
    expect(ACTION_TYPES).toContain('cash_dividend');
    expect(ACTION_TYPES).not.toContain('cash_dividends');
    expect(GROUP_TO_TYPE.cash_dividends).toBe('cash_dividend');
    expect(GROUP_TO_TYPE.capital_gains_distributions).toBe('capital_gains_distribution');
  });

  test('every type Alpaca accepts is mapped, so nothing arrives undescribed', () => {
    // The full list, from the API's own error message on an invalid type.
    const accepted = [
      'forward_split',
      'reverse_split',
      'stock_dividend',
      'spin_off',
      'cash_merger',
      'stock_merger',
      'stock_and_cash_merger',
      'unit_split',
      'cash_dividend',
      'redemption',
      'name_change',
      'worthless_removal',
      'rights_distribution',
      'contract_adjustment',
      'partial_call',
      'reorganization',
      'capital_gains_distribution',
    ];
    for (const t of accepted) expect(ACTION_TYPES).toContain(t);
  });

  test('a dividend reads as a sentence with its dates in it', () => {
    const i = actionToItem('cash_dividend', {
      id: 'abc',
      symbol: 'AA',
      rate: 0.1,
      ex_date: '2026-08-11',
      record_date: '2026-08-11',
      payable_date: '2026-08-27',
      special: false,
      foreign: false,
    });
    expect(i.kind).toBe('dividend');
    expect(i.title).toBe('AA: $0.1 cash dividend');
    expect(i.summary).toContain('payable 2026-08-27');
    expect(i.publishedAt).toBe('2026-08-11');
    expect(i.tags).toContain('aa');
  });

  test('a capital gains distribution adds its two differently-taxed halves', () => {
    // It carries long_term_rate and short_term_rate and no `rate` at all, so
    // reading `rate` published every one of these as an undisclosed amount.
    const i = actionToItem('capital_gains_distribution', {
      id: 'x',
      symbol: 'DHIAX',
      long_term_rate: 0.1495,
      short_term_rate: 0.0252,
      ex_date: '2026-09-03',
    });
    expect(i.title).toContain('$0.1747');
    expect(i.summary).toContain('long-term');
  });

  test('a partial call is a lottery, and says so', () => {
    const i = actionToItem('partial_call', {
      id: 'x',
      symbol: 'AXICY',
      price: 10.190891,
      lottery_date: '2026-08-18',
      payable_date: '2026-09-02',
      process_date: '2026-09-02',
    });
    expect(i.summary).toContain('lottery');
    expect(i.title).toContain('$10.19');
  });

  test('a reverse split carries the warning that goes with it', () => {
    const i = actionToItem('reverse_split', {
      id: 'x',
      symbol: 'ZZZ',
      old_rate: 5,
      new_rate: 1,
      ex_date: '2026-08-26',
    });
    expect(i.title).toBe('ZZZ: 1-for-5 reverse split');
    expect(i.summary).toContain('delisting notice');
    expect(i.tags).toContain('reverse-split');
  });

  test('a merger is tagged with both sides, because either may be what you follow', () => {
    const i = actionToItem('cash_merger', {
      id: 'x',
      acquirer_symbol: 'BIG',
      acquiree_symbol: 'SMALL',
      rate: 42,
      effective_date: '2026-09-01',
    });
    expect(i.tags).toContain('big');
    expect(i.tags).toContain('small');
    expect(i.data.symbols).toEqual(['BIG', 'SMALL']);
  });

  test('an unknown type is skipped rather than half-described', () => {
    expect(actionToItem('something_new', { symbol: 'X' })).toBeNull();
  });

  test('an action with no symbol at all is dropped', () => {
    expect(actionToItem('cash_dividend', { id: 'x', rate: 1 })).toBeNull();
  });

  test('the window looks forward as well as back, because actions are declared early', () => {
    const now = new Date('2026-09-08T00:00:00Z');
    expect(daysAgo(30, now)).toBe('2026-08-09');
    expect(daysAgo(-30, now)).toBe('2026-10-08');
  });
});

describe('market news', () => {
  test('a story is tagged with every symbol it names', () => {
    const i = newsToItem({
      id: 1,
      headline: 'A headline',
      summary: 'A <b>summary</b> with markup.',
      url: 'https://example.com/x',
      created_at: '2026-09-08T02:15:38Z',
      source: 'benzinga',
      symbols: ['NVDA', 'BTCUSD'],
      images: [{ size: 'large', url: 'https://example.com/i.png' }],
    });
    expect(i.tags).toContain('nvda');
    expect(i.tags).toContain('crypto');
    expect(i.summary).toBe('A summary with markup.');
    expect(i.imageUrl).toBe('https://example.com/i.png');
  });
});

describe('US trading halts', () => {
  // Nasdaq writes CamelCase element names. Reading them in lower case found
  // nothing and hollowed out every item without failing, which is why the
  // lookup is case-insensitive and why this fixture is in the exact case the
  // upstream uses.
  const halt = (over = {}) => ({
    title: { text: 'TXXD', attrs: {} },
    'ndaq:IssueSymbol': { text: 'TXXD', attrs: {} },
    'ndaq:IssueName': { text: '21Shares 2x Long Dogecoin ETF', attrs: {} },
    'ndaq:Market': { text: 'NASDAQ', attrs: {} },
    'ndaq:ReasonCode': { text: 'T1', attrs: {} },
    'ndaq:HaltDate': { text: '09/04/2026', attrs: {} },
    'ndaq:HaltTime': { text: '19:50:00.000', attrs: {} },
    ...over,
  });

  test('the CamelCase fields are actually read', () => {
    const i = haltItem(halt());
    expect(i.title).toBe('TXXD halted: news pending');
    expect(i.data.reasonCode).toBe('T1');
    expect(i.data.market).toBe('NASDAQ');
    expect(i.data.issueName).toContain('21Shares');
    expect(i.publishedAt).toBe('2026-09-04T19:50:00');
  });

  test('a regulator suspending trading is not the same row as a price moving fast', () => {
    const suspension = haltItem(halt({ 'ndaq:ReasonCode': { text: 'T12', attrs: {} } }));
    expect(suspension.data.regulatory).toBe(true);
    expect(suspension.tags).toContain('regulatory');
    expect(suspension.title).toContain('SEC trading suspension');

    const pause = haltItem(halt({ 'ndaq:ReasonCode': { text: 'LUDP', attrs: {} } }));
    expect(pause.data.regulatory).toBe(false);
    expect(pause.tags).toContain('volatility-pause');
  });

  test('a market-wide circuit breaker is flagged as market-wide', () => {
    const i = haltItem(halt({ 'ndaq:ReasonCode': { text: 'MWC1', attrs: {} } }));
    expect(i.data.marketWide).toBe(true);
    expect(i.tags).toContain('market-wide');
  });

  test('a resumption turns the same halt into a resolved one', () => {
    const i = haltItem(
      halt({
        'ndaq:ResumptionDate': { text: '09/04/2026', attrs: {} },
        'ndaq:ResumptionTradeTime': { text: '20:05:00.000', attrs: {} },
      }),
    );
    expect(i.data.resumed).toBe(true);
    expect(i.title).toContain('(resumed)');
    expect(i.tags).toContain('resumed');
  });

  test('an unknown reason code is reported rather than silently dropped', () => {
    const i = haltItem(halt({ 'ndaq:ReasonCode': { text: 'ZZ9', attrs: {} } }));
    expect(i.title).toContain('reason code ZZ9');
  });

  test('Eastern time is kept unparsed rather than guessed into UTC', () => {
    expect(haltTime('09/04/2026', '19:50:00.000')).toBe('2026-09-04T19:50:00');
    expect(haltTime('09/04/2026', '')).toBe('2026-09-04');
    expect(haltTime('', '')).toBeNull();
    const i = haltItem(halt());
    expect(i.data.haltTimeEt).toBe('19:50:00.000');
  });
});

describe('euro FX reference rates', () => {
  const xml = `<Cube><Cube time='2026-09-07'>
      <Cube currency='USD' rate='1.1622'/>
      <Cube currency='JPY' rate='179.85'/>
      <Cube currency='GBP' rate='0.85894'/>
    </Cube></Cube>`;

  test('the nested attribute XML is read as days of rates', () => {
    const days = parseRates(xml);
    expect(days).toHaveLength(1);
    expect(days[0].date).toBe('2026-09-07');
    expect(days[0].rates).toEqual({ USD: 1.1622, JPY: 179.85, GBP: 0.85894 });
  });

  test('a day is one item, not thirty', () => {
    const i = ecbItem(parseRates(xml)[0]);
    expect(i.kind).toBe('fx-rate');
    expect(i.title).toContain('USD 1.1622');
    expect(i.data.currencies).toBe(3);
    expect(i.tags).toContain('gbp');
  });

  test('a reference rate never presents itself as a dealing rate', () => {
    const i = ecbItem(parseRates(xml)[0]);
    expect(i.summary).toContain('not dealing rates');
    expect(i.data.basis).toBe('reference-rate');
  });

  test('a file with no days is not silently an empty success', () => {
    expect(parseRates('<Cube></Cube>')).toEqual([]);
  });
});
