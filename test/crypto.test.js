import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

import {
  coingeckoAssets,
  coinToItem,
  cryptoPairs,
  GEMINI_QUOTES,
  krakenAsset,
  LIST_TTL_MS,
  MIN_INTERVAL_MS,
  makeCryptoClient,
  normaliseKrakenPair,
  pairItem,
  parseBinanceSymbols,
  parseBinanceTicker,
  parseCoinbaseProducts,
  parseCoinbaseStats,
  parseGeminiPricefeed,
  parseGeminiSymbol,
  parseKrakenPairs,
  parseKrakenTicker,
  pctChange,
  QUOTES,
  quotesOf,
  VENUE_SLUGS,
  venuesOf,
} from '../packages/adapters/src/crypto.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

/** Real replies trimmed to a handful of pairs each, fetched 2026-09-11. */
const fixture = async (name) =>
  JSON.parse(
    await readFile(new URL(`../packages/adapters/test/fixtures/${name}`, import.meta.url), 'utf8'),
  );

const krakenPairs = await fixture('kraken-assetpairs.json');
const krakenTicker = await fixture('kraken-ticker.json');
const cbProducts = await fixture('coinbase-products.json');
const cbStats = await fixture('coinbase-stats.json');
const busInfo = await fixture('binance-us-exchangeinfo.json');
const bus24h = await fixture('binance-us-24hr.json');
const gemSymbols = await fixture('gemini-symbols.json');
const gemFeed = await fixture('gemini-pricefeed.json');
const cgMarkets = await fixture('coingecko-markets.json');

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** An `http` helper whose `request` answers from a router, recording every call. */
function fakeHttp(route) {
  const calls = [];
  return {
    calls,
    async request(url, opts) {
      calls.push({ url, opts });
      const r = await route(url, opts);
      return r ?? json({ error: 'not found' }, 404);
    },
  };
}

/** Every venue and CoinGecko answering from the fixtures. */
const happy = (url) => {
  if (url.includes('api.kraken.com/0/public/AssetPairs')) return json(krakenPairs);
  if (url.includes('api.kraken.com/0/public/Ticker')) return json(krakenTicker);
  if (url.includes('api.exchange.coinbase.com/products/stats')) return json(cbStats);
  if (url.includes('api.exchange.coinbase.com/products')) return json(cbProducts);
  if (url.includes('api.binance.us/api/v3/exchangeInfo')) return json(busInfo);
  if (url.includes('api.binance.us/api/v3/ticker/24hr')) return json(bus24h);
  if (url.includes('api.gemini.com/v1/symbols')) return json(gemSymbols);
  if (url.includes('api.gemini.com/v1/pricefeed')) return json(gemFeed);
  if (url.includes('api.coingecko.com/api/v3/coins/markets')) return json(cgMarkets);
  return null;
};

const collect = () => {
  const lines = [];
  return { lines, log: (m) => lines.push(String(m)) };
};

const runPairs = async ({ route = happy, config = {}, cursor = {}, env = {} } = {}) => {
  const http = fakeHttp(route);
  const { lines, log } = collect();
  const result = await cryptoPairs.pull({
    config: { ...cryptoPairs.defaults, ...config },
    cursor,
    env,
    http,
    log,
    deadline: Date.now() + 60_000,
  });
  return { result, http, lines };
};

/* ------------------------------------------------------------- coingecko -- */

describe('coingecko assets', () => {
  test('one coin maps to one asset item with the market-cap facts in data', () => {
    const btc = coinToItem(cgMarkets[0]);
    expect(btc.externalId).toBe('coingecko:bitcoin');
    expect(btc.kind).toBe('asset');
    expect(btc.title).toBe('Bitcoin (BTC)');
    expect(btc.url).toBe('https://www.coingecko.com/en/coins/bitcoin');
    expect(btc.imageUrl).toMatch(/^https:\/\/coin-images\.coingecko\.com\//);
    expect(btc.publishedAt).toBe(cgMarkets[0].last_updated);
    expect(btc.tags).toEqual(['asset', 'symbol:btc', 'rank:top100']);
    expect(btc.data.rank).toBe(1);
    expect(btc.data.priceUsd).toBe(cgMarkets[0].current_price);
    expect(btc.data.marketCapUsd).toBe(cgMarkets[0].market_cap);
    expect(btc.data.fullyDilutedUsd).toBe(cgMarkets[0].fully_diluted_valuation);
    expect(btc.data.volume24hUsd).toBe(cgMarkets[0].total_volume);
    expect(btc.data.change24hPct).toBeCloseTo(cgMarkets[0].price_change_percentage_24h, 4);
    expect(btc.data.supply).toEqual({
      circulating: cgMarkets[0].circulating_supply,
      total: cgMarkets[0].total_supply,
      max: 21_000_000,
    });
    expect(btc.data.ath).toBe(cgMarkets[0].ath);
    expect(btc.data.athDate).toBe(cgMarkets[0].ath_date);
    expect(btc.data.atl).toBe(cgMarkets[0].atl);
    expect(btc.data.updatedAt).toBe(cgMarkets[0].last_updated);
    expect(btc.summary).toMatch(/^#1 by market cap, \$[\d,.]+, [-+][\d.]+% in 24h, market cap \$/);
    expect(normaliseItem(btc)).not.toBeNull();
  });

  test('rank:top100 stops at 100 and a missing max supply is null, not 0', () => {
    const outside = coinToItem(cgMarkets.find((c) => c.market_cap_rank > 100));
    expect(outside.tags).not.toContain('rank:top100');
    expect(outside.tags).toContain('asset');
    const uncapped = coinToItem(cgMarkets.find((c) => c.max_supply === null));
    expect(uncapped.data.supply.max).toBeNull();
    expect(coinToItem({ symbol: 'x' })).toBeNull();
  });

  test('the adapter reads two pages by default and sends the key only as a header', async () => {
    const http = fakeHttp(happy);
    const { lines, log } = collect();
    const result = await coingeckoAssets.pull({
      config: coingeckoAssets.defaults,
      cursor: {},
      env: { coingeckoApiKey: 'CG-SECRET-KEY' },
      http,
      log,
      deadline: Date.now() + 60_000,
    });
    // A five-coin page is short of 250, so page one ends the loop.
    expect(http.calls).toHaveLength(1);
    const call = http.calls[0];
    expect(call.url).toContain('per_page=250&page=1');
    expect(call.url).toContain('price_change_percentage=24h');
    expect(call.url).not.toContain('CG-SECRET-KEY');
    expect(call.opts.headers['x-cg-demo-api-key']).toBe('CG-SECRET-KEY');
    expect(result.items).toHaveLength(cgMarkets.length);
    expect(JSON.stringify([result, lines])).not.toContain('CG-SECRET-KEY');
  });

  test('a second page is read while the first came back full', async () => {
    const full = Array.from({ length: 250 }, (_, i) => ({
      ...cgMarkets[0],
      id: `coin-${i}`,
      name: `Coin ${i}`,
      market_cap_rank: i + 1,
    }));
    let page = 0;
    const http = fakeHttp((url) => {
      page += 1;
      return url.includes('page=1') ? json(full) : json([...full.slice(0, 3), cgMarkets[3]]);
    });
    const result = await coingeckoAssets.pull({
      config: { pages: 2 },
      cursor: {},
      env: {},
      http,
      log: () => {},
      deadline: Date.now() + 60_000,
    });
    expect(page).toBe(2);
    expect(http.calls[0].opts.headers['x-cg-demo-api-key']).toBeUndefined();
    // Three coins moved across the page boundary between reads: once each.
    expect(result.items).toHaveLength(251);
    expect(result.note).toContain('2 page(s)');
  });
});

/* ---------------------------------------------------------------- kraken -- */

describe('kraken pair normalisation', () => {
  test('legacy X/Z prefixes come off and XBT/XDG are BTC/DOGE', () => {
    expect(krakenAsset('XXBT')).toBe('BTC');
    expect(krakenAsset('XBT')).toBe('BTC');
    expect(krakenAsset('XXDG')).toBe('DOGE');
    expect(krakenAsset('XETH')).toBe('ETH');
    expect(krakenAsset('ZUSD')).toBe('USD');
    expect(krakenAsset('ZEUR')).toBe('EUR');
    expect(krakenAsset('SOL')).toBe('SOL');
    expect(krakenAsset('USDT')).toBe('USDT');
    expect(krakenAsset('PEPE')).toBe('PEPE');
  });

  test('wsname is the source of truth: XXBTZUSD is BTC/USD, XDGUSD is DOGE/USD', () => {
    expect(normaliseKrakenPair('XXBTZUSD', krakenPairs.result.XXBTZUSD)).toEqual({
      base: 'BTC',
      quote: 'USD',
      status: 'online',
      venueSymbol: 'XXBTZUSD',
    });
    expect(normaliseKrakenPair('XDGUSD', krakenPairs.result.XDGUSD)).toMatchObject({
      base: 'DOGE',
      quote: 'USD',
    });
    expect(normaliseKrakenPair('XETHZEUR', krakenPairs.result.XETHZEUR)).toMatchObject({
      base: 'ETH',
      quote: 'EUR',
    });
    // Without a wsname the base/quote fields are decoded the long way.
    expect(normaliseKrakenPair('XXBTZUSD', { base: 'XXBT', quote: 'ZUSD' })).toMatchObject({
      base: 'BTC',
      quote: 'USD',
    });
    expect(normaliseKrakenPair('nope', {})).toBeNull();
  });

  test('the cursor list keeps only wanted quotes, with status as Kraken says it', () => {
    const list = parseKrakenPairs(krakenPairs.result);
    expect(Object.keys(list).sort()).toEqual([
      'ACXEUR',
      'ETHUSDT',
      'SOLUSDC',
      'XDGUSD',
      'XETHZEUR',
      'XXBTZUSD',
    ]);
    expect(list.XXBTZUSD).toEqual(['BTC', 'USD', 'online']);
    expect(list.ACXEUR).toEqual(['ACX', 'EUR', 'cancel_only']);
    // AAVE/XBT is quoted in bitcoin, which is not a quote this adapter keeps.
    expect(list.AAVEXBT).toBeUndefined();
  });

  test('the ticker reads last, bid, ask, the 24h columns and change from open', () => {
    const t = parseKrakenTicker(krakenTicker.result.XXBTZUSD);
    expect(t.price).toBe(77268.8);
    expect(t.bid).toBe(77268.7);
    expect(t.ask).toBe(77268.8);
    expect(t.high24h).toBe(78496);
    expect(t.low24h).toBe(76466);
    expect(t.open24h).toBe(76542);
    expect(t.volume24hBase).toBeCloseTo(2495.04591358, 6);
    expect(t.vwap24h).toBeCloseTo(77185.83768, 4);
    expect(t.volume24hQuote).toBeCloseTo(2495.04591358 * 77185.83768, 0);
    expect(t.change24hPct).toBeCloseTo(((77268.8 - 76542) / 76542) * 100, 3);
    expect(pctChange(1, 0)).toBeNull();
    expect(pctChange(null, 1)).toBeNull();
  });
});

/* -------------------------------------------------------------- coinbase -- */

describe('coinbase parsing', () => {
  test('products keep online books and mark the rest; foreign quotes are dropped', () => {
    const list = parseCoinbaseProducts(cbProducts);
    expect(list['BTC-USD']).toEqual(['BTC', 'USD', 'online']);
    expect(list['ETH-EUR']).toEqual(['ETH', 'EUR', 'online']);
    expect(list['SOL-USDT']).toEqual(['SOL', 'USDT', 'online']);
    expect(list['HOPR-USDT']).toEqual(['HOPR', 'USDT', 'delisted']);
    expect(list['ETH-BTC']).toBeUndefined();
  });

  test('stats_24hour gives last, open, high, low and base volume; no bid or ask', () => {
    const t = parseCoinbaseStats(cbStats['BTC-USD']);
    const s = cbStats['BTC-USD'].stats_24hour;
    expect(t.price).toBe(Number(s.last));
    expect(t.open24h).toBe(Number(s.open));
    expect(t.high24h).toBe(Number(s.high));
    expect(t.low24h).toBe(Number(s.low));
    expect(t.volume24hBase).toBe(Number(s.volume));
    expect(t.volume24hQuote).toBeCloseTo(Number(s.volume) * Number(s.last), 0);
    expect(t.change24hPct).toBeCloseTo(
      ((Number(s.last) - Number(s.open)) / Number(s.open)) * 100,
      3,
    );
    expect(t.bid).toBeNull();
    expect(t.ask).toBeNull();
    expect(t.vwap24h).toBeNull();
  });
});

/* ------------------------------------------------------------ binance.us -- */

describe('binance.us parsing', () => {
  test('symbols split by baseAsset/quoteAsset, so BTCUSD4 is not read as USD', () => {
    const list = parseBinanceSymbols(busInfo);
    expect(list.BTCUSD).toEqual(['BTC', 'USD', 'online']);
    expect(list.ETHUSDT).toEqual(['ETH', 'USDT', 'online']);
    expect(list.SOLUSDC).toEqual(['SOL', 'USDC', 'online']);
    expect(list.BTCUSD4).toBeUndefined();
    expect(list.ETHBTC).toBeUndefined();
    expect(
      parseBinanceSymbols({
        symbols: [{ symbol: 'XUSD', baseAsset: 'X', quoteAsset: 'USD', status: 'BREAK' }],
      }).XUSD,
    ).toEqual(['X', 'USD', 'break']);
  });

  test('the 24hr ticker is the full one: bid, ask, quote volume, vwap and the reported change', () => {
    const row = bus24h.find((r) => r.symbol === 'BTCUSD');
    const t = parseBinanceTicker(row);
    expect(t.price).toBe(Number(row.lastPrice));
    expect(t.bid).toBe(Number(row.bidPrice));
    expect(t.ask).toBe(Number(row.askPrice));
    expect(t.high24h).toBe(Number(row.highPrice));
    expect(t.low24h).toBe(Number(row.lowPrice));
    expect(t.open24h).toBe(Number(row.openPrice));
    expect(t.change24hPct).toBe(Number(row.priceChangePercent));
    expect(t.volume24hBase).toBe(Number(row.volume));
    expect(t.volume24hQuote).toBe(Number(row.quoteVolume));
    expect(t.vwap24h).toBe(Number(row.weightedAvgPrice));
  });
});

/* ---------------------------------------------------------------- gemini -- */

describe('gemini parsing', () => {
  test('symbols split on the longest known quote; perpetuals are not spot', () => {
    expect(parseGeminiSymbol('btcusd')).toEqual({ base: 'BTC', quote: 'USD' });
    expect(parseGeminiSymbol('ethgbp')).toEqual({ base: 'ETH', quote: 'GBP' });
    expect(parseGeminiSymbol('solusdc')).toEqual({ base: 'SOL', quote: 'USDC' });
    expect(parseGeminiSymbol('2zusd')).toEqual({ base: '2Z', quote: 'USD' });
    // Gemini's own dollar and Ripple's, which a bare "usd" suffix would swallow.
    expect(parseGeminiSymbol('aavegusd')).toEqual({ base: 'AAVE', quote: 'GUSD' });
    expect(parseGeminiSymbol('driftrlusd')).toEqual({ base: 'DRIFT', quote: 'RLUSD' });
    expect(parseGeminiSymbol('efilfil')).toEqual({ base: 'EFIL', quote: 'FIL' });
    expect(parseGeminiSymbol('btcusdcperp')).toBeNull();
    expect(parseGeminiSymbol('usd')).toBeNull();
    expect(parseGeminiSymbol('')).toBeNull();
    expect(GEMINI_QUOTES.indexOf('GUSD')).toBeLessThan(GEMINI_QUOTES.indexOf('USD'));
  });

  test('the pricefeed change is a fraction and everything but price is null', () => {
    const t = parseGeminiPricefeed(gemFeed.find((r) => r.pair === 'BTCUSD'));
    expect(t.price).toBe(77274.71);
    expect(t.change24hPct).toBe(-1.3);
    expect(t.volume24hBase).toBeNull();
    expect(t.volume24hQuote).toBeNull();
    expect(t.bid).toBeNull();
    expect(t.high24h).toBeNull();
  });
});

/* ------------------------------------------------------------------ item -- */

describe('pair items', () => {
  const now = Date.parse('2026-09-11T06:00:00Z');

  test('one pair on one venue: id, title, trade page, tags and the ticker in data', () => {
    const item = pairItem({
      venue: 'kraken',
      base: 'BTC',
      quote: 'USD',
      venueSymbol: 'XXBTZUSD',
      status: 'online',
      ticker: parseKrakenTicker(krakenTicker.result.XXBTZUSD),
      now,
    });
    expect(item.externalId).toBe('pair:kraken:BTC-USD');
    expect(item.kind).toBe('pair');
    expect(item.title).toBe('BTC/USD on Kraken');
    expect(item.url).toBe('https://pro.kraken.com/app/trade/btc-usd');
    expect(item.publishedAt).toBe('2026-09-11T06:00:00.000Z');
    expect(item.tags).toEqual(['pair', 'venue:kraken', 'base:btc', 'quote:usd', 'stable-quote']);
    expect(item.data).toMatchObject({
      venue: 'kraken',
      venueName: 'Kraken',
      base: 'BTC',
      quote: 'USD',
      venueSymbol: 'XXBTZUSD',
      status: 'online',
      price: 77268.8,
      priceUsd: 77268.8,
      updatedAt: '2026-09-11T06:00:00.000Z',
    });
    expect(item.summary).toMatch(/^77,268\.8 USD, \+0\.95% in 24h, volume 2,495\.05 BTC$/);
    expect(normaliseItem(item)).not.toBeNull();
  });

  test('every venue has a trade page pattern, and a fiat quote is not a USD price', () => {
    const urls = Object.fromEntries(
      VENUE_SLUGS.map((v) => [
        v,
        pairItem({
          venue: v,
          base: 'ETH',
          quote: 'EUR',
          venueSymbol: 'x',
          ticker: { price: 2000 },
          now,
        }).url,
      ]),
    );
    expect(urls).toEqual({
      kraken: 'https://pro.kraken.com/app/trade/eth-eur',
      coinbase: 'https://www.coinbase.com/advanced-trade/spot/ETH-EUR',
      'binance-us': 'https://www.binance.us/spot-trade/eth_eur',
      gemini: 'https://exchange.gemini.com/trade/ETHEUR',
    });
    const eur = pairItem({
      venue: 'coinbase',
      base: 'ETH',
      quote: 'EUR',
      venueSymbol: 'ETH-EUR',
      ticker: { price: 2000 },
      now,
    });
    expect(eur.tags).not.toContain('stable-quote');
    expect(eur.data.priceUsd).toBeNull();
    expect(eur.data.price).toBe(2000);
    // A ticker with only a price still lands with every other field present and null.
    expect(eur.data.bid).toBeNull();
    expect(eur.data.volume24hQuote).toBeNull();
    for (const q of ['USD', 'USDT', 'USDC']) {
      expect(
        pairItem({
          venue: 'gemini',
          base: 'X',
          quote: q,
          venueSymbol: 'x',
          ticker: { price: 1 },
          now,
        }).data.priceUsd,
      ).toBe(1);
    }
    expect(pairItem({ venue: 'nope', base: 'X', quote: 'USD', venueSymbol: 'x', now })).toBeNull();
  });
});

/* ------------------------------------------------------------------ pull -- */

describe('crypto-pairs pull', () => {
  test('every venue lands, filtered to online pairs in a wanted quote', async () => {
    const { result, http, lines } = await runPairs();
    const ids = result.items.map((i) => i.externalId).sort();
    expect(ids).toEqual(
      [
        // Kraken: ACX/EUR is cancel_only, AAVE/XBT is bitcoin-quoted.
        'pair:kraken:BTC-USD',
        'pair:kraken:DOGE-USD',
        'pair:kraken:ETH-EUR',
        'pair:kraken:ETH-USDT',
        'pair:kraken:SOL-USDC',
        // Coinbase: HOPR-USDT is delisted, ETH-BTC is bitcoin-quoted.
        'pair:coinbase:BTC-USD',
        'pair:coinbase:ETH-EUR',
        'pair:coinbase:SOL-USDT',
        // Binance.US: BTCUSD4 is BREAK in a legacy quote, ETHBTC is bitcoin-quoted.
        'pair:binance-us:BTC-USD',
        'pair:binance-us:ETH-USDT',
        'pair:binance-us:SOL-USDC',
        // Gemini: GUSD, RLUSD and FIL quotes and the perpetual are out.
        'pair:gemini:2Z-USD',
        'pair:gemini:BTC-USD',
        'pair:gemini:ETH-GBP',
        'pair:gemini:ETH-USD',
        'pair:gemini:SOL-USDC',
      ].sort(),
    );
    expect(result.note).toMatch(/^16 pairs \(/);
    expect(result.note).not.toContain('failed');
    // Two requests per venue on a cold cursor: the list and the tickers.
    expect(http.calls).toHaveLength(8);
    // The three daily lists are in the cursor, stamped.
    expect(Object.keys(result.cursor.kraken.list)).toContain('XXBTZUSD');
    expect(result.cursor.coinbase.list['BTC-USD']).toEqual(['BTC', 'USD', 'online']);
    expect(result.cursor.binanceUs.list.BTCUSD).toEqual(['BTC', 'USD', 'online']);
    expect(Date.parse(result.cursor.kraken.at)).toBeGreaterThan(0);
    expect(result.cursor.gemini).toBeUndefined();
    for (const item of result.items) expect(normaliseItem(item)).not.toBeNull();
    expect(lines).toEqual([]);
  });

  test('the DOGE item is the Kraken ticker under its XDG name', async () => {
    const { result } = await runPairs();
    const doge = result.items.find((i) => i.externalId === 'pair:kraken:DOGE-USD');
    expect(doge.title).toBe('DOGE/USD on Kraken');
    expect(doge.data.venueSymbol).toBe('XDGUSD');
    expect(doge.data.price).toBe(0.0840878);
    expect(doge.url).toBe('https://pro.kraken.com/app/trade/doge-usd');
  });

  test('a fresh cursor skips the three list requests; a stale one refreshes them', async () => {
    const first = await runPairs();
    const warm = await runPairs({ cursor: first.result.cursor });
    expect(warm.http.calls.map((c) => new URL(c.url).pathname).sort()).toEqual([
      '/0/public/Ticker',
      '/api/v3/ticker/24hr',
      '/products/stats',
      '/v1/pricefeed',
      '/v1/symbols',
    ]);
    expect(warm.result.items).toHaveLength(16);
    expect(warm.result.cursor.kraken.at).toBe(first.result.cursor.kraken.at);

    const old = new Date(Date.now() - LIST_TTL_MS - 1000).toISOString();
    const stale = {
      kraken: { ...first.result.cursor.kraken, at: old },
      coinbase: { ...first.result.cursor.coinbase, at: old },
      binanceUs: { ...first.result.cursor.binanceUs, at: old },
    };
    const refreshed = await runPairs({ cursor: stale });
    expect(refreshed.http.calls).toHaveLength(8);
    expect(refreshed.result.cursor.kraken.at).not.toBe(old);
  });

  test('a list refresh that fails falls back to the stale list rather than losing the venue', async () => {
    const first = await runPairs();
    const old = new Date(Date.now() - LIST_TTL_MS - 1000).toISOString();
    const { result, lines } = await runPairs({
      cursor: { kraken: { ...first.result.cursor.kraken, at: old } },
      route: (url) =>
        url.includes('AssetPairs') ? json({ error: ['EService:Unavailable'] }) : happy(url),
    });
    expect(result.items.filter((i) => i.data.venue === 'kraken')).toHaveLength(5);
    expect(lines.some((l) => /kraken: list refresh failed/.test(l))).toBe(true);
    expect(result.cursor.kraken.at).toBe(old);
    expect(result.note).not.toContain('failed');
  });

  test('config narrows the quotes and the venues', async () => {
    const usd = await runPairs({ config: { quotes: ['usd'] } });
    expect(usd.result.items.map((i) => i.data.quote)).toEqual([
      'USD',
      'USD',
      'USD',
      'USD',
      'USD',
      'USD',
      'USD',
    ]);
    const gem = await runPairs({ config: { venues: ['gemini'] } });
    expect(gem.result.items.every((i) => i.data.venue === 'gemini')).toBe(true);
    expect(gem.http.calls).toHaveLength(2);
    expect(quotesOf({ quotes: ['eur', 'nope'] })).toEqual(new Set(['EUR']));
    expect(quotesOf({})).toEqual(new Set(QUOTES));
    expect(venuesOf({ venues: ['kraken', 'mars'] })).toEqual(['kraken']);
    expect(venuesOf(undefined)).toEqual(VENUE_SLUGS);
  });

  test('one venue failing is logged and skipped while the others land', async () => {
    const { result, lines } = await runPairs({
      route: (url) =>
        url.includes('api.binance.us') ? json({ msg: 'forbidden' }, 403) : happy(url),
    });
    expect(result.items).toHaveLength(13);
    expect(result.items.some((i) => i.data.venue === 'binance-us')).toBe(false);
    expect(result.note).toContain('failed: binance-us');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^binance-us: 403 from this egress/);
    expect(lines[0]).toContain('CRYPTO_PROXY_URL');
    expect(result.cursor.binanceUs).toBeUndefined();
  });

  test('a timeout on one venue is the same: skipped, the rest land', async () => {
    const { result, lines } = await runPairs({
      route: (url) => {
        if (url.includes('api.gemini.com')) throw new Error('The operation timed out');
        return happy(url);
      },
    });
    expect(result.items).toHaveLength(11);
    expect(lines[0]).toMatch(/^gemini: The operation timed out; skipped$/);
  });

  test('every venue failing throws', async () => {
    await expect(runPairs({ route: () => json({ nope: true }, 500) })).rejects.toThrow(
      /^every venue failed: kraken, coinbase, binance-us, gemini$/,
    );
  });
});

/* ------------------------------------------------------------- transport -- */

describe('crypto http client', () => {
  test('a 429 is thrown as a rate limit, on the status and on Kraken’s error array', async () => {
    const http = fakeHttp(() => json({ error: 'slow down' }, 429));
    const client = makeCryptoClient({ http, sleep: async () => {} });
    await expect(client.get('https://api.coingecko.com/api/v3/coins/markets')).rejects.toThrow(
      /rate limit/,
    );
    await expect(
      coingeckoAssets.pull({
        config: {},
        cursor: {},
        env: {},
        http,
        log: () => {},
        deadline: Date.now() + 60_000,
      }),
    ).rejects.toThrow(/rate limit/);

    const { result, lines } = await runPairs({
      route: (url) =>
        url.includes('api.kraken.com')
          ? json({ error: ['EAPI:Rate limit exceeded'], result: {} })
          : happy(url),
    });
    expect(result.items.some((i) => i.data.venue === 'kraken')).toBe(false);
    expect(lines[0]).toMatch(/^kraken: rate limit: kraken says EAPI:Rate limit exceeded; skipped$/);
  });

  test('requests to one host are spaced 100 ms apart; different hosts are not', async () => {
    const slept = [];
    let clock = 1_000_000;
    const http = fakeHttp(() => json({}));
    const client = makeCryptoClient({
      http,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
      now: () => clock,
    });
    await client.get('https://api.kraken.com/0/public/AssetPairs');
    await client.get('https://api.gemini.com/v1/symbols');
    expect(slept).toEqual([]);
    clock += 30;
    await client.get('https://api.kraken.com/0/public/Ticker');
    expect(slept).toEqual([MIN_INTERVAL_MS - 30]);
    clock += 500;
    await client.get('https://api.kraken.com/0/public/Ticker');
    expect(slept).toHaveLength(1);
  });

  test('the proxy is used for Binance.US alone, and never appears in output', async () => {
    const proxy = 'http://user:hunter2@127.0.0.1:9';
    const fetched = [];
    const fetchImpl = async (url, opts) => {
      fetched.push({ url, opts });
      return happy(url);
    };
    const http = fakeHttp(happy);
    const { lines, log } = collect();
    const client = makeCryptoClient({
      env: { cryptoProxyUrl: proxy },
      http,
      log,
      fetchImpl,
      sleep: async () => {},
    });
    expect(client.proxied).toBe(true);
    await client.get('https://api.binance.us/api/v3/ticker/24hr');
    await client.get('https://api.kraken.com/0/public/Ticker');
    expect(fetched).toHaveLength(1);
    expect(fetched[0].url).toContain('api.binance.us');
    expect(fetched[0].opts.proxy).toBe(proxy);
    expect(http.calls.map((c) => new URL(c.url).host)).toEqual(['api.kraken.com']);

    // The whole run, with a key and a proxy in the environment: nothing leaks.
    const run = await cryptoPairs.pull({
      config: cryptoPairs.defaults,
      cursor: {},
      env: { cryptoProxyUrl: proxy, coingeckoApiKey: 'CG-SECRET-KEY' },
      http: fakeHttp(happy),
      log,
      deadline: Date.now() + 60_000,
    });
    const text = JSON.stringify([run, lines]);
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('127.0.0.1:9');
    expect(text).not.toContain('CG-SECRET-KEY');
  });

  test('a proxy that is unreachable or answers 402/407 is bypassed, with no URL in the log', async () => {
    const proxy = 'http://user:hunter2@proxy.example:8080';
    const { lines, log } = collect();
    const http = fakeHttp(happy);
    const dead = makeCryptoClient({
      env: { cryptoProxyUrl: proxy },
      http,
      log,
      sleep: async () => {},
      fetchImpl: async () => {
        throw new Error(`connect ECONNREFUSED ${proxy}`);
      },
    });
    const rows = await dead.get('https://api.binance.us/api/v3/ticker/24hr');
    expect(Array.isArray(rows)).toBe(true);
    expect(http.calls).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^api\.binance\.us: proxy unreachable \(connect ECONNREFUSED \[proxy\]\); trying direct$/,
    );

    const broke = makeCryptoClient({
      env: { cryptoProxyUrl: proxy },
      http,
      log,
      sleep: async () => {},
      fetchImpl: async () => json({ error: 'bandwidth exhausted' }, 402),
    });
    await broke.get('https://api.binance.us/api/v3/ticker/24hr');
    expect(http.calls).toHaveLength(2);
    expect(lines[1]).toBe('api.binance.us: proxy answered 402; trying direct');
    expect(JSON.stringify(lines)).not.toContain('hunter2');
  });

  test('a venue refusing the proxy exit is a venue failure, not a fallback', async () => {
    const proxy = 'http://user:hunter2@proxy.example:8080';
    const client = makeCryptoClient({
      env: { cryptoProxyUrl: proxy },
      http: fakeHttp(happy),
      sleep: async () => {},
      fetchImpl: async () => json({ msg: 'no' }, 451),
    });
    await expect(client.get('https://api.binance.us/api/v3/ticker/24hr')).rejects.toThrow(
      /^api\.binance\.us 451 \(via proxy\)$/,
    );
  });
});

/* -------------------------------------------------------------- registry -- */

describe('the two adapters', () => {
  test('names, collection, kinds and cadences are as the contract says', () => {
    expect(coingeckoAssets.name).toBe('coingecko-assets');
    expect(coingeckoAssets.collection).toBe('crypto');
    expect(coingeckoAssets.kinds).toEqual(['asset']);
    expect(coingeckoAssets.cadenceMinutes).toBe(15);
    expect(cryptoPairs.name).toBe('crypto-pairs');
    expect(cryptoPairs.collection).toBe('crypto');
    expect(cryptoPairs.kinds).toEqual(['pair']);
    expect(cryptoPairs.cadenceMinutes).toBe(5);
    for (const a of [coingeckoAssets, cryptoPairs]) {
      for (const s of a.defaultSources) {
        expect(s.slug).toMatch(/^[a-z0-9-]+$/);
        for (const k of Object.keys(s.config ?? {})) {
          expect(a.configFields.map((f) => f.key)).toContain(k);
        }
      }
    }
  });
});
