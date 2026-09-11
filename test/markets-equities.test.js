import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

import {
  alpacaAssets,
  assetToItem,
  BAR_CAP,
  barTuple,
  conceptPoints,
  equityHistory,
  exchangeSlug,
  factsToItem,
  historyId,
  historyItem,
  latestFrom,
  latestSessionDay,
  mergeBars,
  money,
  nextDay,
  parseCompanyList,
  planBatch,
  secError,
  secFundamentals,
  universeFrom,
  weekStamp,
  yahooSymbol,
} from '../packages/adapters/src/equities.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const text = (body, status = 200) => new Response(body, { status });

/** The core's `http`, answering from a router and recording every URL. */
function fakeHttp(route) {
  const urls = [];
  const request = async (url, opts) => {
    urls.push({ url, opts });
    const r = await route(url, opts);
    return r ?? json({ error: 'not found' }, 404);
  };
  return {
    urls,
    request,
    async json(url, opts) {
      const res = await request(url, opts);
      if (!res.ok) throw new Error(`${res.status} from ${url.slice(0, 120)}`);
      return res.json();
    },
  };
}

const env = { alpacaKeyId: 'PKTEST', alpacaSecretKey: 'shh', contactEmail: 'ops@example.test' };
const noop = () => {};
const far = () => Date.now() + 10 * 60_000;
const NO_PREVIOUS = async () => new Map();
const DEADLINE_MARGIN = 15_000;

/* ---------------------------------------------------------------- assets -- */

const AAPL = {
  id: 'b0b6dd9d-8b9b-48a9-ba46-b9d54906e415',
  class: 'us_equity',
  exchange: 'NASDAQ',
  symbol: 'AAPL',
  name: 'Apple Inc. Common Stock',
  status: 'active',
  tradable: true,
  marginable: true,
  shortable: true,
  easy_to_borrow: true,
  fractionable: true,
  attributes: ['has_options', 'fractional_eh_enabled'],
};
const PINK = {
  id: '11111111-2222-3333-4444-555555555555',
  class: 'us_equity',
  exchange: 'OTC',
  symbol: 'TSNPD',
  name: 'Tesla Not Really',
  status: 'active',
  tradable: false,
  marginable: false,
  shortable: false,
  easy_to_borrow: false,
  fractionable: false,
};
const BTC = {
  id: '276e2673-764b-4ab6-a611-caf665ca6340',
  class: 'crypto',
  exchange: 'CRYPTO',
  symbol: 'BTC/USD',
  name: 'Bitcoin / US Dollar',
  status: 'active',
  tradable: true,
  marginable: false,
  shortable: false,
  fractionable: true,
};

describe('alpaca-assets', () => {
  test('an equity maps with its exchange, class and flags as tags and the full record as data', () => {
    const item = normaliseItem(assetToItem(AAPL));
    expect(item.externalId).toBe(`alpaca:asset:${AAPL.id}`);
    expect(item.kind).toBe('symbol');
    expect(item.title).toBe('AAPL · Apple Inc. Common Stock');
    expect(item.url).toBe('https://finance.yahoo.com/quote/AAPL');
    expect(item.publishedAt).toBeNull();
    expect(item.tags).toEqual([
      'symbol',
      'exchange:nasdaq',
      'class:us_equity',
      'tradable',
      'fractionable',
      'shortable',
    ]);
    expect(item.data).toEqual({
      assetId: AAPL.id,
      symbol: 'AAPL',
      name: 'Apple Inc. Common Stock',
      exchange: 'NASDAQ',
      assetClass: 'us_equity',
      status: 'active',
      tradable: true,
      marginable: true,
      shortable: true,
      easyToBorrow: true,
      fractionable: true,
      attributes: ['has_options', 'fractional_eh_enabled'],
    });
  });

  test('an OTC name is tagged otc and carries no flag it does not have', () => {
    const item = assetToItem(PINK);
    expect(item.tags).toEqual(['symbol', 'exchange:otc', 'class:us_equity', 'otc']);
    expect(item.data.attributes).toEqual([]);
  });

  test('a crypto pair is kept, tagged class:crypto, and links to the Yahoo spelling', () => {
    const item = assetToItem(BTC);
    expect(item.tags).toContain('class:crypto');
    expect(item.tags).toContain('exchange:crypto');
    expect(item.url).toBe('https://finance.yahoo.com/quote/BTC-USD');
    expect(yahooSymbol('BRK.B')).toBe('BRK-B');
  });

  test('exchange codes slug the way the doc says, and an unknown one still slugs', () => {
    expect(exchangeSlug('NYSEARCA')).toBe('arca');
    expect(exchangeSlug('AMEX')).toBe('amex');
    expect(exchangeSlug('Some Venue')).toBe('some-venue');
    expect(exchangeSlug(null)).toBe('unknown');
  });

  test('a row without an id or a symbol is dropped', () => {
    expect(assetToItem({ symbol: 'X' })).toBeNull();
    expect(assetToItem({ id: 'y' })).toBeNull();
  });

  test('pull reads each class once and never puts the key anywhere but the header', async () => {
    const http = fakeHttp((url) => {
      if (url.includes('asset_class=us_equity')) return json([AAPL, PINK]);
      if (url.includes('asset_class=crypto')) return json([BTC]);
      return null;
    });
    const out = await alpacaAssets.pull({ config: alpacaAssets.defaults, env, http, log: noop });
    expect(http.urls.length).toBe(2);
    expect(http.urls[0].url).toBe(
      'https://api.alpaca.markets/v2/assets?status=active&asset_class=us_equity',
    );
    expect(http.urls[0].opts.headers['APCA-API-KEY-ID']).toBe('PKTEST');
    expect(out.items.map((i) => i.data.symbol)).toEqual(['AAPL', 'TSNPD', 'BTC/USD']);
    expect(out.note).toContain('2 us_equity');
    expect(JSON.stringify(out)).not.toContain('shh');
  });

  test('pull refuses to run without a key rather than asking anonymously', async () => {
    await expect(
      alpacaAssets.pull({ config: {}, env: {}, http: fakeHttp(() => null), log: noop }),
    ).rejects.toThrow(/APCA_API_KEY_ID/);
  });
});

/* --------------------------------------------------------------- history -- */

const bar = (day, c = 100, extra = {}) => ({
  t: `${day}T04:00:00Z`,
  o: c - 1,
  h: c + 1,
  l: c - 2,
  c,
  v: 1000,
  n: 10,
  vw: c - 0.5,
  ...extra,
});

describe('equity-history: bars and the window', () => {
  test('a bar becomes a day tuple, and one without a day is dropped', () => {
    expect(barTuple(bar('2026-09-10', 150))).toEqual([
      '2026-09-10',
      149,
      151,
      148,
      150,
      1000,
      149.5,
    ]);
    expect(barTuple({ o: 1 })).toBeNull();
    expect(barTuple(bar('2026-09-10', 150, { vw: undefined }))[6]).toBeNull();
  });

  test('a new day is appended after what was held, oldest first', () => {
    const held = [barTuple(bar('2026-09-08', 1)), barTuple(bar('2026-09-09', 2))];
    const merged = mergeBars(held, [barTuple(bar('2026-09-10', 3))]);
    expect(merged.map((b) => b[0])).toEqual(['2026-09-08', '2026-09-09', '2026-09-10']);
  });

  test('a duplicate day is replaced by the newer read, not doubled', () => {
    const held = [barTuple(bar('2026-09-09', 2)), barTuple(bar('2026-09-10', 3))];
    const merged = mergeBars(held, [barTuple(bar('2026-09-10', 30))]);
    expect(merged.length).toBe(2);
    expect(merged[1][4]).toBe(30);
  });

  test('the window is capped at 400, dropping the oldest', () => {
    const held = [];
    for (let i = 0; i < 405; i++) {
      held.push(barTuple(bar(nextDayN('2024-01-01', i), i)));
    }
    const merged = mergeBars(held, [barTuple(bar('2026-01-01', 999))]);
    expect(merged.length).toBe(BAR_CAP);
    expect(merged.at(-1)[0]).toBe('2026-01-01');
    expect(merged[0][0]).toBe(nextDayN('2024-01-01', 6));
  });

  test('the item carries the window, the last day as publishedAt and the tags the doc lists', () => {
    const bars = [barTuple(bar('2026-09-09', 2)), barTuple(bar('2026-09-10', 3))];
    const item = normaliseItem(
      historyItem({ symbol: 'aapl', feed: 'iex', adjustment: 'split', bars }),
    );
    expect(item.externalId).toBe('history:AAPL');
    expect(item.kind).toBe('history');
    expect(item.title).toBe('AAPL daily bars');
    expect(item.publishedAt.toISOString()).toBe('2026-09-10T12:00:00.000Z');
    expect(item.precision).toBe('day');
    expect(item.tags).toEqual(['history', 'symbol:aapl', 'feed:iex']);
    expect(item.data).toEqual({
      symbol: 'AAPL',
      timeframe: '1Day',
      feed: 'iex',
      adjustment: 'split',
      bars,
      first: '2026-09-09',
      last: '2026-09-10',
      count: 2,
    });
    expect(historyItem({ symbol: 'X', feed: 'iex', adjustment: 'split', bars: [] })).toBeNull();
  });

  test('the universe is the active, tradable US equities off OTC, sorted', () => {
    expect(
      universeFrom([
        AAPL,
        PINK,
        BTC,
        { ...AAPL, id: 'z', symbol: 'ZZZ', tradable: false },
        { ...AAPL, id: 'q', symbol: 'AAA', status: 'inactive' },
        { ...AAPL, id: 'm', symbol: 'MSFT' },
      ]),
    ).toEqual(['AAPL', 'MSFT']);
  });
});

function nextDayN(day, n) {
  let d = day;
  for (let i = 0; i < n; i++) d = nextDay(d);
  return d;
}

describe('equity-history: the session clock', () => {
  test('a weekday evening after the extended close settles that day', () => {
    // Friday 2026-09-11 21:00 ET is 01:00Z Saturday.
    expect(latestSessionDay(Date.parse('2026-09-12T01:00:00Z'))).toBe('2026-09-11');
  });
  test('before the close it is still the previous weekday', () => {
    // Friday 2026-09-11 19:00 ET.
    expect(latestSessionDay(Date.parse('2026-09-11T23:00:00Z'))).toBe('2026-09-10');
  });
  test('a weekend rolls back to Friday, and Monday morning is still Friday', () => {
    expect(latestSessionDay(Date.parse('2026-09-13T15:00:00Z'))).toBe('2026-09-11');
    expect(latestSessionDay(Date.parse('2026-09-14T13:00:00Z'))).toBe('2026-09-11');
  });
  test('nextDay steps a calendar day, across a month end', () => {
    expect(nextDay('2026-09-30')).toBe('2026-10-01');
  });
});

describe('equity-history: batch planning', () => {
  const end = '2026-09-11';
  const backfillStart = '2025-08-07';
  const held = (sym, last, feed = 'iex') => [
    historyId(sym),
    { feed, bars: [[last, 1, 1, 1, 1, 1, 1]], last },
  ];

  test('known symbols resume after their last bar, fresh ones get the window, one group each', () => {
    const previous = new Map([held('AAPL', '2026-09-10'), held('MSFT', '2026-09-10')]);
    const groups = planBatch({
      symbols: ['AAPL', 'MSFT', 'NEWCO'],
      previous,
      feed: 'iex',
      end,
      quiet: {},
      backfillStart,
    });
    expect(groups).toEqual([
      { start: '2026-09-11', symbols: ['AAPL', 'MSFT'] },
      { start: backfillStart, symbols: ['NEWCO'] },
    ]);
  });

  test('a symbol already through the end day is not asked about at all', () => {
    const groups = planBatch({
      symbols: ['AAPL'],
      previous: new Map([held('AAPL', end)]),
      feed: 'iex',
      end,
      quiet: {},
      backfillStart,
    });
    expect(groups).toEqual([]);
  });

  test('a quiet symbol resumes after the day it was last asked about, not from the window start', () => {
    const groups = planBatch({
      symbols: ['THIN'],
      previous: new Map(),
      feed: 'iex',
      end,
      quiet: { THIN: '2026-09-09' },
      backfillStart,
    });
    expect(groups).toEqual([{ start: '2026-09-10', symbols: ['THIN'] }]);
  });

  test('a window read on another feed starts over', () => {
    const groups = planBatch({
      symbols: ['AAPL'],
      previous: new Map([held('AAPL', '2026-09-10', 'sip')]),
      feed: 'iex',
      end,
      quiet: {},
      backfillStart,
    });
    expect(groups[0].start).toBe(backfillStart);
  });

  test('stragglers pool under the earliest of their starts so a batch is never more than two series', () => {
    const previous = new Map([
      held('A', '2026-09-10'),
      held('B', '2026-09-10'),
      held('C', '2026-09-03'),
      held('D', '2026-08-20'),
    ]);
    const groups = planBatch({
      symbols: ['A', 'B', 'C', 'D', 'E'],
      previous,
      feed: 'iex',
      end,
      quiet: {},
      backfillStart,
    });
    expect(groups.length).toBe(2);
    expect(groups[0]).toEqual({ start: '2026-09-11', symbols: ['A', 'B'] });
    expect(groups[1].start).toBe(backfillStart);
    expect(groups[1].symbols.sort()).toEqual(['C', 'D', 'E']);
  });
});

describe('equity-history: the pull loop', () => {
  const assets = [AAPL, { ...AAPL, id: 'm', symbol: 'MSFT' }, { ...AAPL, id: 'n', symbol: 'NVDA' }];
  // Friday 2026-09-11, 21:00 ET: that day has settled.
  const now = Date.parse('2026-09-12T01:00:00Z');
  const config = { ...equityHistory.defaults, batchSize: 2 };

  /** Alpaca's multi-symbol bars endpoint, one bar a day a symbol, paged by symbol when asked. */
  function barsRoute(url, { pageBy = null } = {}) {
    const u = new URL(url);
    const symbols = u.searchParams.get('symbols').split(',');
    const start = u.searchParams.get('start').slice(0, 10);
    const end = u.searchParams.get('end').slice(0, 10);
    const token = u.searchParams.get('page_token');
    const days = [];
    for (let d = start; d <= end; d = nextDay(d)) {
      if (!['2026-09-05', '2026-09-06', '2026-09-12', '2026-09-13'].includes(d)) days.push(d);
    }
    const bars = {};
    const from = token ? symbols.indexOf(token) : 0;
    const to = pageBy ? Math.min(symbols.length, from + pageBy) : symbols.length;
    for (const s of symbols.slice(from, to)) bars[s] = days.map((d, i) => bar(d, 100 + i));
    return json({ bars, next_page_token: to < symbols.length ? symbols[to] : null });
  }

  test('a fresh start reads the universe once, then the window for every symbol, and completes', async () => {
    const http = fakeHttp((url) => {
      if (url.includes('/v2/assets')) return json(assets);
      if (url.includes('/v2/stocks/bars')) return barsRoute(url);
      return null;
    });
    const out = await equityHistory.pull({
      config,
      cursor: {},
      env,
      http,
      log: noop,
      deadline: far(),
      previous: NO_PREVIOUS,
      paceMs: 0,
      now,
    });
    expect(http.urls[0].url).toContain('/v2/assets?status=active&asset_class=us_equity');
    const barUrls = http.urls.slice(1).map((u) => new URL(u.url));
    expect(barUrls.length).toBe(2);
    expect(barUrls[0].searchParams.get('symbols')).toBe('AAPL,MSFT');
    expect(barUrls[0].searchParams.get('feed')).toBe('iex');
    expect(barUrls[0].searchParams.get('adjustment')).toBe('split');
    expect(barUrls[0].searchParams.get('timeframe')).toBe('1Day');
    expect(barUrls[0].searchParams.get('start')).toBe('2025-08-07T00:00:00Z');
    expect(barUrls[0].searchParams.get('end')).toBe('2026-09-11T23:59:59Z');
    expect(barUrls[1].searchParams.get('symbols')).toBe('NVDA');
    expect(out.items.map((i) => i.data.symbol)).toEqual(['AAPL', 'MSFT', 'NVDA']);
    expect(out.items[0].data.last).toBe('2026-09-11');
    expect(out.items[0].data.count).toBeGreaterThan(250);
    expect(out.items[0].data.count).toBeLessThanOrEqual(BAR_CAP);
    expect(out.cursor.lastDay).toBe('2026-09-11');
    expect(out.cursor.walk).toBeNull();
    expect(out.cursor.universe).toEqual(['AAPL', 'MSFT', 'NVDA']);
    expect(out.nextInMinutes).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain('shh');
  });

  test('the next run the same evening asks for nothing', async () => {
    const http = fakeHttp(() => null);
    const cursor = {
      universe: ['AAPL'],
      universeAt: new Date(now).toISOString(),
      lastDay: '2026-09-11',
      walk: null,
    };
    const out = await equityHistory.pull({
      config,
      cursor,
      env,
      http,
      log: noop,
      deadline: far(),
      previous: NO_PREVIOUS,
      paceMs: 0,
      now,
    });
    expect(http.urls.length).toBe(0);
    expect(out.items).toEqual([]);
    expect(out.note).toContain('nothing has settled');
  });

  test('a session later, only the new day is asked for and merged onto the held window', async () => {
    const monday = Date.parse('2026-09-15T01:00:00Z'); // Monday 2026-09-14, 21:00 ET
    const heldBars = [];
    for (let i = 0; i < 300; i++) heldBars.push(barTuple(bar(nextDayN('2025-01-01', i), i)));
    heldBars.push(barTuple(bar('2026-09-11', 500)));
    const previous = async (ids) => {
      expect(ids).toEqual(['history:AAPL']);
      return new Map([
        ['history:AAPL', { feed: 'iex', bars: heldBars, last: '2026-09-11', count: 301 }],
      ]);
    };
    const http = fakeHttp((url) => (url.includes('/v2/stocks/bars') ? barsRoute(url) : null));
    const out = await equityHistory.pull({
      config,
      cursor: {
        universe: ['AAPL'],
        universeAt: new Date(monday).toISOString(),
        lastDay: '2026-09-11',
      },
      env,
      http,
      log: noop,
      deadline: far(),
      previous,
      paceMs: 0,
      now: monday,
    });
    expect(http.urls.length).toBe(1);
    const u = new URL(http.urls[0].url);
    expect(u.searchParams.get('start')).toBe('2026-09-12T00:00:00Z');
    expect(u.searchParams.get('end')).toBe('2026-09-14T23:59:59Z');
    expect(out.items.length).toBe(1);
    const bars = out.items[0].data.bars;
    expect(bars.length).toBe(302);
    expect(bars.at(-2)[0]).toBe('2026-09-11');
    expect(bars.at(-1)[0]).toBe('2026-09-14');
    expect(out.cursor.lastDay).toBe('2026-09-14');
  });

  test('a symbol with no bars is remembered as quiet and not emitted; one that prints again is forgotten', async () => {
    const http = fakeHttp((url) => {
      if (!url.includes('/v2/stocks/bars')) return null;
      const res = barsRoute(url);
      return res.json().then((b) => {
        delete b.bars.NVDA;
        return json(b);
      });
    });
    const out = await equityHistory.pull({
      config,
      cursor: {
        universe: ['AAPL', 'NVDA'],
        universeAt: new Date(now).toISOString(),
        quiet: { AAPL: '2026-09-04' },
      },
      env,
      http,
      log: noop,
      deadline: far(),
      previous: NO_PREVIOUS,
      paceMs: 0,
      now,
    });
    expect(out.items.map((i) => i.data.symbol)).toEqual(['AAPL']);
    expect(out.cursor.quiet).toEqual({ NVDA: '2026-09-11' });
    // AAPL was quiet through the 4th, so it was asked from the 5th, not the window start.
    expect(
      http.urls.some((u) => new URL(u.url).searchParams.get('start') === '2026-09-05T00:00:00Z'),
    ).toBe(true);
  });

  test('a run that hits its deadline saves its place, asks to come back in five, and the next run finishes', async () => {
    let calls = 0;
    const http = fakeHttp((url) => {
      if (url.includes('/v2/assets')) return json(assets);
      if (url.includes('/v2/stocks/bars')) {
        calls += 1;
        return barsRoute(url);
      }
      return null;
    });
    // Enough for the universe read and one batch, then over.
    const deadline = Date.now() + DEADLINE_MARGIN;
    const first = await equityHistory.pull({
      config,
      cursor: {},
      env,
      http,
      log: noop,
      deadline,
      previous: NO_PREVIOUS,
      paceMs: 0,
      now,
    });
    expect(calls).toBe(0);
    expect(first.cursor.walk).toEqual({
      end: '2026-09-11',
      i: 0,
      startedAt: new Date(now).toISOString(),
    });
    expect(first.nextInMinutes).toBe(5);

    const second = await equityHistory.pull({
      config,
      cursor: first.cursor,
      env,
      http,
      log: noop,
      deadline: far(),
      previous: NO_PREVIOUS,
      paceMs: 0,
      now,
    });
    expect(calls).toBe(2);
    expect(second.items.length).toBe(3);
    expect(second.cursor.walk).toBeNull();
    expect(second.cursor.lastDay).toBe('2026-09-11');
    expect(second.nextInMinutes).toBeUndefined();
    // The universe was not read again: it is a day old at most.
    expect(http.urls.filter((u) => u.url.includes('/v2/assets')).length).toBe(1);
  });

  test('pages are followed until the token runs out', async () => {
    const http = fakeHttp((url) =>
      url.includes('/v2/stocks/bars') ? barsRoute(url, { pageBy: 1 }) : null,
    );
    const out = await equityHistory.pull({
      config: { ...config, batchSize: 3 },
      cursor: { universe: ['AAPL', 'MSFT', 'NVDA'], universeAt: new Date(now).toISOString() },
      env,
      http,
      log: noop,
      deadline: far(),
      previous: NO_PREVIOUS,
      paceMs: 0,
      now,
    });
    expect(http.urls.length).toBe(3);
    expect(new URL(http.urls[1].url).searchParams.get('page_token')).toBe('MSFT');
    expect(out.items.length).toBe(3);
  });

  test('the sip feed is honoured from config or the environment and tagged on the item', async () => {
    const http = fakeHttp((url) => (url.includes('/v2/stocks/bars') ? barsRoute(url) : null));
    const out = await equityHistory.pull({
      config,
      cursor: { universe: ['AAPL'], universeAt: new Date(now).toISOString() },
      env: { ...env, alpacaFeed: 'sip' },
      http,
      log: noop,
      deadline: far(),
      previous: NO_PREVIOUS,
      paceMs: 0,
      now,
    });
    expect(new URL(http.urls[0].url).searchParams.get('feed')).toBe('sip');
    expect(out.items[0].tags).toContain('feed:sip');
  });
});

/* ---------------------------------------------------------- fundamentals -- */

/** An Apple-shaped companyfacts excerpt: USD and shares units, 10-K and 10-Q, an amendment, a YTD row, an 8-K. */
const usd = (start, end, val, fy, fp, form, filed) => ({
  start,
  end,
  val,
  accn: `${filed}-acc`,
  fy,
  fp,
  form,
  filed,
});
const inst = (end, val, fy, fp, form, filed) => ({
  end,
  val,
  accn: `${filed}-acc`,
  fy,
  fp,
  form,
  filed,
});

const APPLE_FACTS = {
  cik: 320193,
  entityName: 'Apple Inc.',
  facts: {
    dei: {
      EntityCommonStockSharesOutstanding: {
        units: {
          shares: [
            inst('2023-10-20', 15552752000, 2023, 'FY', '10-K', '2023-11-03'),
            inst('2024-01-19', 15441185000, 2024, 'Q1', '10-Q', '2024-02-02'),
          ],
        },
      },
      EntityPublicFloat: {
        units: { USD: [inst('2023-03-31', 2591165000000, 2023, 'FY', '10-K', '2023-11-03')] },
      },
    },
    'us-gaap': {
      RevenueFromContractWithCustomerExcludingAssessedTax: {
        units: {
          USD: [
            // FY2022 as first reported, then restated in the FY2023 10-K (later filed wins).
            usd('2021-09-26', '2022-09-24', 394328000000, 2022, 'FY', '10-K', '2022-10-28'),
            usd('2021-09-26', '2022-09-24', 394328000001, 2023, 'FY', '10-K', '2023-11-03'),
            usd('2022-09-25', '2023-09-30', 383285000000, 2023, 'FY', '10-K', '2023-11-03'),
            // An amended 10-K/A restating the same period, filed later still.
            usd('2022-09-25', '2023-09-30', 383285000999, 2023, 'FY', '10-K/A', '2023-12-15'),
            // Q1 FY24: the three-month figure and the year-to-date figure share an end date.
            usd('2023-10-01', '2023-12-30', 119575000000, 2024, 'Q1', '10-Q', '2024-02-02'),
            // Q2 FY24: three months and six months to date, same end, same filing.
            usd('2023-12-31', '2024-03-30', 90753000000, 2024, 'Q2', '10-Q', '2024-05-03'),
            usd('2023-10-01', '2024-03-30', 210328000000, 2024, 'Q2', '10-Q', '2024-05-03'),
            // An 8-K number, which is not a report and must not appear.
            usd('2024-03-31', '2024-06-29', 1, 2024, 'Q3', '8-K', '2024-08-01'),
          ],
        },
      },
      NetIncomeLoss: {
        units: {
          USD: [
            usd('2022-09-25', '2023-09-30', 96995000000, 2023, 'FY', '10-K', '2023-11-03'),
            usd('2023-10-01', '2023-12-30', 33916000000, 2024, 'Q1', '10-Q', '2024-02-02'),
            usd('2023-12-31', '2024-03-30', 23636000000, 2024, 'Q2', '10-Q', '2024-05-03'),
            usd('2023-10-01', '2024-03-30', 57552000000, 2024, 'Q2', '10-Q', '2024-05-03'),
          ],
        },
      },
      EarningsPerShareDiluted: {
        units: {
          'USD/shares': [
            usd('2022-09-25', '2023-09-30', 6.13, 2023, 'FY', '10-K', '2023-11-03'),
            usd('2023-12-31', '2024-03-30', 1.53, 2024, 'Q2', '10-Q', '2024-05-03'),
          ],
        },
      },
      Assets: {
        units: {
          USD: [
            inst('2023-09-30', 352583000000, 2023, 'FY', '10-K', '2023-11-03'),
            inst('2024-03-30', 337411000000, 2024, 'Q2', '10-Q', '2024-05-03'),
          ],
        },
      },
      Liabilities: {
        units: { USD: [inst('2024-03-30', 263217000000, 2024, 'Q2', '10-Q', '2024-05-03')] },
      },
      StockholdersEquity: {
        units: { USD: [inst('2024-03-30', 74194000000, 2024, 'Q2', '10-Q', '2024-05-03')] },
      },
      CashAndCashEquivalentsAtCarryingValue: {
        units: { USD: [inst('2024-03-30', 32695000000, 2024, 'Q2', '10-Q', '2024-05-03')] },
      },
      NetCashProvidedByUsedInOperatingActivities: {
        units: {
          USD: [usd('2023-10-01', '2024-03-30', 62574000000, 2024, 'Q2', '10-Q', '2024-05-03')],
        },
      },
      LongTermDebtNoncurrent: {
        units: { USD: [inst('2024-03-30', 91831000000, 2024, 'Q2', '10-Q', '2024-05-03')] },
      },
      LongTermDebtCurrent: {
        units: { USD: [inst('2024-03-30', 12000000000, 2024, 'Q2', '10-Q', '2024-05-03')] },
      },
      // Not a kept concept.
      AccountsPayableCurrent: {
        units: { USD: [inst('2024-03-30', 1, 2024, 'Q2', '10-Q', '2024-05-03')] },
      },
    },
  },
};

const APPLE = {
  cik: '320193',
  symbol: 'AAPL',
  symbols: ['AAPL'],
  name: 'Apple Inc.',
  exchange: 'Nasdaq',
};

describe('sec-fundamentals: companyfacts parsing', () => {
  test('a concept keeps one point a period, the latest filing winning, reports only', () => {
    const pts = conceptPoints(
      APPLE_FACTS.facts['us-gaap'].RevenueFromContractWithCustomerExcludingAssessedTax,
    );
    expect(pts.map((p) => `${p.end}|${p.fp}`)).toEqual([
      '2022-09-24|FY',
      '2023-09-30|FY',
      '2023-12-30|Q1',
      '2024-03-30|Q2',
    ]);
    // The restated FY2022 figure from the later 10-K.
    expect(pts[0].val).toBe(394328000001);
    // The amendment, filed later, replaces the original FY2023 figure.
    expect(pts[1].val).toBe(383285000999);
    expect(pts[1].form).toBe('10-K/A');
    // The quarter's own three months, not the six months to date that shares its end.
    expect(pts[3].val).toBe(90753000000);
    expect(pts[3].start).toBe('2023-12-31');
    expect(pts.every((p) => p.unit === 'USD')).toBe(true);
    expect(pts.every((p) => p.form !== '8-K')).toBe(true);
  });

  test('the window is the last twelve periods', () => {
    const rows = [];
    for (let y = 2010; y <= 2025; y++) {
      rows.push(usd(`${y - 1}-10-01`, `${y}-09-30`, y, y, 'FY', '10-K', `${y}-11-01`));
    }
    const pts = conceptPoints({ units: { USD: rows } });
    expect(pts.length).toBe(12);
    expect(pts[0].end).toBe('2014-09-30');
    expect(pts.at(-1).end).toBe('2025-09-30');
  });

  test('an empty or malformed fact yields nothing', () => {
    expect(conceptPoints(undefined)).toEqual([]);
    expect(conceptPoints({ units: {} })).toEqual([]);
    expect(
      conceptPoints({ units: { USD: [{ end: '2024-01-01', val: 'x', form: '10-K' }] } }),
    ).toEqual([]);
  });

  test('the item carries the concepts, the headline figures and the tags the doc lists', () => {
    const item = normaliseItem(factsToItem(APPLE, APPLE_FACTS));
    expect(item.externalId).toBe('sec:facts:320193');
    expect(item.kind).toBe('fundamentals');
    expect(item.title).toBe('Apple Inc. (AAPL) fundamentals');
    expect(item.url).toBe(
      'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000320193',
    );
    // The newest `filed` among the kept points: the Q2 10-Q.
    expect(item.publishedAt.toISOString()).toBe('2024-05-03T12:00:00.000Z');
    expect(item.tags).toEqual(['fundamentals', 'symbol:aapl', 'cik:320193', 'exchange:nasdaq']);
    expect(Object.keys(item.data.concepts).sort()).toEqual(
      [
        'RevenueFromContractWithCustomerExcludingAssessedTax',
        'NetIncomeLoss',
        'EarningsPerShareDiluted',
        'Assets',
        'Liabilities',
        'StockholdersEquity',
        'CashAndCashEquivalentsAtCarryingValue',
        'NetCashProvidedByUsedInOperatingActivities',
        'LongTermDebtNoncurrent',
        'LongTermDebtCurrent',
        'EntityCommonStockSharesOutstanding',
        'EntityPublicFloat',
      ].sort(),
    );
    expect(item.data.concepts.AccountsPayableCurrent).toBeUndefined();
    expect(item.data.latest).toEqual({
      revenue: 90753000000,
      grossProfit: null,
      operatingIncome: null,
      netIncome: 23636000000,
      epsDiluted: 1.53,
      epsBasic: null,
      assets: 337411000000,
      liabilities: 263217000000,
      equity: 74194000000,
      cash: 32695000000,
      operatingCashFlow: 62574000000,
      sharesOutstanding: 15441185000,
      publicFloat: 2591165000000,
      longTermDebt: 91831000000 + 12000000000,
      period: '2024-03-30',
      fp: 'Q2',
      fy: 2024,
      form: '10-Q',
      filed: '2024-05-03',
    });
    expect(item.summary).toContain('revenue $90.8B');
    expect(item.summary).toContain('net income $23.6B');
    expect(item.summary).toContain('10-Q filed 2024-05-03');
    expect(item.data).toMatchObject({
      cik: '320193',
      symbol: 'AAPL',
      name: 'Apple Inc.',
      exchange: 'Nasdaq',
    });
  });

  test('revenue falls back through the tags a filer may use, newest date winning', () => {
    const latest = latestFrom({
      Revenues: [usd('2023-01-01', '2023-12-31', 10, 2023, 'FY', '10-K', '2024-02-01')],
      SalesRevenueNet: [usd('2024-01-01', '2024-12-31', 20, 2024, 'FY', '10-K', '2025-02-01')],
      LongTermDebt: [inst('2024-12-31', 5, 2024, 'FY', '10-K', '2025-02-01')],
    });
    expect(latest.revenue).toBe(20);
    expect(latest.longTermDebt).toBe(5);
    expect(latest.period).toBe('2024-12-31');
    expect(latest.netIncome).toBeNull();
  });

  test('a company with none of the concepts is not an item', () => {
    expect(
      factsToItem(APPLE, { facts: { 'us-gaap': { Other: { units: { USD: [] } } } } }),
    ).toBeNull();
    expect(factsToItem(APPLE, {})).toBeNull();
  });

  test('money reads like a headline', () => {
    expect(money(383285000000)).toBe('$383.3B');
    expect(money(-1234567)).toBe('$-1.2M');
    expect(money(950)).toBe('$950');
    expect(money(2.5e12)).toBe('$2.5T');
    expect(money(null)).toBeNull();
  });
});

describe('sec-fundamentals: the company list', () => {
  test('the exchange file groups tickers by CIK, first ticker as the symbol, sorted by CIK', () => {
    const list = parseCompanyList({
      fields: ['cik', 'name', 'ticker', 'exchange'],
      data: [
        [1652044, 'Alphabet Inc.', 'GOOGL', 'Nasdaq'],
        [320193, 'Apple Inc.', 'AAPL', 'Nasdaq'],
        [1652044, 'Alphabet Inc.', 'GOOG', 'Nasdaq'],
        [0, 'Nobody', 'NONE', null],
      ],
    });
    expect(list).toEqual([
      { cik: '320193', symbol: 'AAPL', symbols: ['AAPL'], name: 'Apple Inc.', exchange: 'Nasdaq' },
      {
        cik: '1652044',
        symbol: 'GOOGL',
        symbols: ['GOOGL', 'GOOG'],
        name: 'Alphabet Inc.',
        exchange: 'Nasdaq',
      },
    ]);
  });

  test('the plain file, keyed by row number, parses to the same shape without an exchange', () => {
    const list = parseCompanyList({
      0: { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' },
      1: { cik_str: 789019, ticker: 'MSFT', title: 'MICROSOFT CORP' },
    });
    expect(list.map((c) => c.symbol)).toEqual(['AAPL', 'MSFT']);
    expect(list[0].exchange).toBeNull();
  });

  test('garbage parses to nothing', () => {
    expect(parseCompanyList(null)).toEqual([]);
    expect(parseCompanyList('nope')).toEqual([]);
  });
});

describe('sec-fundamentals: refusals', () => {
  test('a 403 is the rate threshold, and says "rate limit" for the scheduler', () => {
    const err = secError(403, '<h1>Request Rate Threshold Exceeded</h1>', 'https://data.sec.gov/x');
    expect(err.message).toMatch(/rate limit/i);
    expect(secError(403, '').message).toMatch(/rate limit/i);
    expect(secError(429, '').message).toMatch(/rate limit/i);
  });
  test('a 403 for an undeclared tool names the fix instead', () => {
    const err = secError(403, 'Your Request Originates from an Undeclared Automated Tool');
    expect(err.message).not.toMatch(/rate limit/i);
    expect(err.message).toMatch(/CONTACT_EMAIL/);
  });
  test('the week stamp is the Monday', () => {
    expect(weekStamp(Date.parse('2026-09-11T10:00:00Z'))).toBe('2026-09-07');
    expect(weekStamp(Date.parse('2026-09-13T23:00:00Z'))).toBe('2026-09-07');
    expect(weekStamp(Date.parse('2026-09-14T00:30:00Z'))).toBe('2026-09-14');
  });
});

describe('sec-fundamentals: the pull loop', () => {
  const LIST = {
    fields: ['cik', 'name', 'ticker', 'exchange'],
    data: [
      [320193, 'Apple Inc.', 'AAPL', 'Nasdaq'],
      [789019, 'MICROSOFT CORP', 'MSFT', 'Nasdaq'],
      [1000000, 'A Fund With No Facts', 'FUND', 'NYSE'],
      [1652044, 'Alphabet Inc.', 'GOOGL', 'Nasdaq'],
    ],
  };
  const now = Date.parse('2026-09-11T10:00:00Z');
  const base = (http, cursor = {}, config = secFundamentals.defaults) => ({
    config,
    cursor,
    env,
    http,
    log: noop,
    deadline: far(),
    paceMs: 0,
    now,
  });
  const facts = (cik, name, symbol) => ({ ...APPLE_FACTS, cik, entityName: name, symbol });

  test('the list is read every run, the walk resumes by CIK, and a company with no facts file is skipped', async () => {
    const http = fakeHttp((url) => {
      if (url.endsWith('/company_tickers_exchange.json')) return json(LIST);
      if (url.endsWith('/CIK0000320193.json')) return json(facts(320193, 'Apple Inc.'));
      if (url.endsWith('/CIK0000789019.json')) return json(facts(789019, 'Microsoft Corp'));
      if (url.endsWith('/CIK0001652044.json')) return json(facts(1652044, 'Alphabet Inc.'));
      return null; // the fund: 404
    });
    const first = await secFundamentals.pull(base(http, {}, { perRun: 2 }));
    expect(http.urls[0].opts.headers['user-agent']).toBe('nichedb.dev (ops@example.test)');
    expect(http.urls.map((u) => u.url.split('/').at(-1))).toEqual([
      'company_tickers_exchange.json',
      'CIK0000320193.json',
      'CIK0000789019.json',
    ]);
    expect(first.items.map((i) => i.externalId)).toEqual(['sec:facts:320193', 'sec:facts:789019']);
    expect(first.items[1].title).toBe('Microsoft Corp (MSFT) fundamentals');
    expect(first.cursor).toEqual({ week: '2026-09-07', after: '789019' });
    expect(first.note).toContain('resuming after CIK 789019');

    const second = await secFundamentals.pull(base(http, first.cursor, { perRun: 2 }));
    expect(second.items.map((i) => i.externalId)).toEqual(['sec:facts:1652044']);
    expect(second.note).toContain('1 without a facts file');
    expect(second.cursor).toEqual({ week: '2026-09-07', after: null, doneWeek: '2026-09-07' });

    const third = await secFundamentals.pull(base(http, second.cursor, { perRun: 2 }));
    expect(third.items).toEqual([]);
    expect(third.note).toContain('idle');
    // Nothing was fetched: not even the list.
    expect(http.urls.length).toBe(3 + 3);

    // A new week starts the walk over.
    const nextWeek = await secFundamentals.pull({
      ...base(http, second.cursor, { perRun: 10 }),
      now: Date.parse('2026-09-15T10:00:00Z'),
    });
    expect(nextWeek.items.length).toBe(3);
    expect(nextWeek.cursor.doneWeek).toBe('2026-09-14');
  });

  test('a 403 from the SEC surfaces as a rate-limit error, and the cursor is not advanced past it', async () => {
    const http = fakeHttp((url) => {
      if (url.endsWith('/company_tickers_exchange.json')) return json(LIST);
      return text('<html>Request Rate Threshold Exceeded</html>', 403);
    });
    await expect(secFundamentals.pull(base(http))).rejects.toThrow(/rate limit/i);
  });

  test('without a contact email the adapter refuses rather than asking anonymously', async () => {
    await expect(secFundamentals.pull({ ...base(fakeHttp(() => null)), env: {} })).rejects.toThrow(
      /CONTACT_EMAIL/,
    );
  });

  test('a run past its deadline stops and resumes after the last company it read', async () => {
    const http = fakeHttp((url) => {
      if (url.endsWith('/company_tickers_exchange.json')) return json(LIST);
      return json(facts(1, 'X'));
    });
    const out = await secFundamentals.pull({
      ...base(http),
      deadline: Date.now() + DEADLINE_MARGIN,
    });
    expect(out.items.length).toBeLessThan(4);
    expect(out.cursor.doneWeek).toBeUndefined();
  });
});

/* ------------------------------------------------------- ctx.previous SQL -- */

describe('previousItemData: the statement the core runs for ctx.previous', () => {
  let db;
  beforeAll(async () => {
    db = await new PGlite({ extensions: { citext, pg_trgm } });
    const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
    for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
      await db.exec(await readFile(dir + f, 'utf8'));
    }
  }, 60_000);

  test('answers this source only, data only, absent ids simply absent', async () => {
    const rows = async (sql, params) => (await db.query(sql, params)).rows;
    const [c] = await rows(`insert into collections (slug, name) values ('mk', 'M') returning id`);
    const [s1] = await rows(
      `insert into sources (collection_id, adapter, slug, name) values ($1, 'equity-history', 'h1', 'H1') returning id`,
      [c.id],
    );
    const [s2] = await rows(
      `insert into sources (collection_id, adapter, slug, name) values ($1, 'equity-history', 'h2', 'H2') returning id`,
      [c.id],
    );
    await rows(
      `insert into items (collection_id, source_id, external_id, kind, title, data) values
       ($1, $2, 'history:AAPL', 'history', 'AAPL', '{"last":"2026-09-10"}'),
       ($1, $3, 'history:MSFT', 'history', 'MSFT', '{"last":"2026-09-10"}')`,
      [c.id, s1.id, s2.id],
    );
    const got = await rows(
      `select external_id, data from items where source_id = $1 and external_id = any($2::text[])`,
      [s1.id, '{"history:AAPL","history:MSFT","history:NOPE"}'],
    );
    expect(got).toEqual([{ external_id: 'history:AAPL', data: { last: '2026-09-10' } }]);
  });
});
