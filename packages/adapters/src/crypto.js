import { defineAdapter } from '@nichedb/core/adapter';

/**
 * The crypto universe, into `crypto`: every asset by market cap, and every spot
 * pair on the four US venues b1dz.com trades, each with its 24-hour ticker.
 *
 * Ported from b1dz's `pair-discovery.ts`, which every five minutes asked
 * CoinGecko for the top 500 by market cap and each venue for its 24h tickers,
 * then kept the pairs listed on two or more venues with $50k of volume and a
 * $10M market cap. That filtering was the site's business, not the data's, so
 * it is not repeated here: this keeps everything the venues list and lets a
 * reader apply its own floor. advis0r.com's static pair list is the same set.
 *
 * Two adapters:
 *
 *   coingecko-assets   one item per coin, 500 by default, every 15 minutes
 *   crypto-pairs       one item per (venue, pair), ~2,400 of them, every 5 minutes
 *
 * Every endpoint is public and keyless. CoinGecko takes an optional demo key
 * for a higher rate; Binance.US refuses datacenter egress (403 or 451), so
 * `CRYPTO_PROXY_URL` names a residential proxy used for that one host and no
 * other. Neither the key nor the proxy ever appears in an item, a cursor, a log
 * line or an error.
 */

export const COLLECTION = 'crypto';

/** The quotes a pair may be priced in to be kept. Everything else is skipped. */
export const QUOTES = ['USD', 'USDT', 'USDC', 'EUR', 'GBP'];
export const STABLE_QUOTES = new Set(['USD', 'USDT', 'USDC']);

export const VENUES = {
  kraken: {
    name: 'Kraken',
    tradeUrl: (b, q) => `https://pro.kraken.com/app/trade/${b.toLowerCase()}-${q.toLowerCase()}`,
  },
  coinbase: {
    name: 'Coinbase',
    tradeUrl: (b, q) => `https://www.coinbase.com/advanced-trade/spot/${b}-${q}`,
  },
  'binance-us': {
    name: 'Binance.US',
    tradeUrl: (b, q) => `https://www.binance.us/spot-trade/${b.toLowerCase()}_${q.toLowerCase()}`,
  },
  gemini: {
    name: 'Gemini',
    tradeUrl: (b, q) => `https://exchange.gemini.com/trade/${b}${q}`,
  },
};
export const VENUE_SLUGS = Object.keys(VENUES);

const KRAKEN = 'https://api.kraken.com/0/public';
const COINBASE = 'https://api.exchange.coinbase.com';
const BINANCE_US = 'https://api.binance.us/api/v3';
const GEMINI = 'https://api.gemini.com/v1';
const COINGECKO = 'https://api.coingecko.com/api/v3';

/** How long a venue's pair list (AssetPairs, products, exchangeInfo) lives in the cursor. */
export const LIST_TTL_MS = 24 * 60 * 60_000;

/* ------------------------------------------------------------------ http -- */

/** Requests to one host are spaced this far apart, as b1dz's `feeds/http.ts` did. */
export const MIN_INTERVAL_MS = 100;

/** The one host that blocks datacenter IPs; the proxy is used for it and nothing else. */
const PROXIED_HOSTS = new Set(['api.binance.us']);
/** A 402/407 is the proxy refusing us (billing, auth), not the venue; go direct. */
const PROXY_FAULT = new Set([402, 407]);
/** The venue refusing this egress outright, which a proxy is the answer to. */
const BLOCKED = new Set([403, 451]);

/**
 * One GET, paced per host, through the proxy for the hosts that need one.
 *
 * The direct path goes through the core http helper, which carries the
 * deployment's UA and waits once on a 429; a second 429 arrives here and is
 * thrown as a rate limit so the run log says so in words. The proxied path is
 * a bare fetch with Bun's `proxy` option, because the helper cannot route.
 * `sleep` and `now` are injectable so a test can see the pacing without paying
 * for it.
 */
export function makeCryptoClient({
  env = {},
  http,
  log = () => {},
  fetchImpl = fetch,
  sleep = (ms) => Bun.sleep(ms),
  now = Date.now,
} = {}) {
  const proxy = env.cryptoProxyUrl ?? env.CRYPTO_PROXY_URL ?? null;
  const lastAt = new Map();

  /**
   * The proxy URL carries a host and credentials, and a connection error names
   * the host on its own ("getaddrinfo ENOTFOUND proxy.example"), so every part
   * of it is struck from anything logged, not just the whole string.
   */
  const secrets = [];
  if (proxy) {
    secrets.push(proxy);
    try {
      const u = new URL(proxy);
      for (const part of [u.host, u.hostname, u.username, u.password]) {
        if (part) secrets.push(part, decodeURIComponent(part));
      }
    } catch {
      /* not a URL: the whole string is still struck */
    }
  }
  const scrub = (s) =>
    [...new Set(secrets)]
      .filter((sec) => sec.length > 2)
      .sort((a, b) => b.length - a.length)
      .reduce((acc, sec) => acc.split(sec).join('[proxy]'), String(s));

  async function pace(host) {
    const wait = MIN_INTERVAL_MS - (now() - (lastAt.get(host) ?? 0));
    if (wait > 0) await sleep(wait);
    lastAt.set(host, now());
  }

  async function direct(url, headers, timeoutMs) {
    if (http?.request) return http.request(url, { headers, timeoutMs });
    return fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  }

  async function get(url, { headers = {}, timeoutMs = 30_000 } = {}) {
    const host = new URL(url).host;
    await pace(host);
    const h = { accept: 'application/json', ...headers };
    let res = null;
    let viaProxy = false;
    if (proxy && PROXIED_HOSTS.has(host)) {
      viaProxy = true;
      try {
        res = await fetchImpl(url, { proxy, headers: h, signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        log(`${host}: proxy unreachable (${scrub(err?.message ?? err)}); trying direct`);
        res = null;
        viaProxy = false;
      }
      if (res && PROXY_FAULT.has(res.status)) {
        log(`${host}: proxy answered ${res.status}; trying direct`);
        res = null;
        viaProxy = false;
      }
    }
    if (!res) res = await direct(url, h, timeoutMs);
    if (res.status === 429) {
      const err = new Error(`rate limit: ${host} answered 429`);
      err.status = 429;
      throw err;
    }
    if (!res.ok) {
      const err = new Error(`${host} ${res.status}${viaProxy ? ' (via proxy)' : ''}`);
      err.status = res.status;
      err.blocked = BLOCKED.has(res.status);
      throw err;
    }
    return res.json();
  }

  return { get, proxied: Boolean(proxy) };
}

/** How long one request may take, inside what is left of the run. */
const budgetMs = (deadline) =>
  Number.isFinite(deadline)
    ? Math.min(30_000, Math.max(5_000, deadline - Date.now() - 10_000))
    : 30_000;

/* --------------------------------------------------------------- numbers -- */

/** A number a venue ships as a string, a float, an empty string or not at all. */
export const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const round = (n, places) => (n === null ? null : Number(n.toFixed(places)));

/** Percentage change from open to last, or null when either is missing or open is 0. */
export const pctChange = (last, open) =>
  last === null || open === null || open === 0 ? null : round(((last - open) / open) * 100, 4);

/** "77,268.8" for a price, "0.08409" for one under a dollar. */
export function fmtNum(n) {
  if (n === null) return null;
  if (Math.abs(n) >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return n.toLocaleString('en-US', { maximumSignificantDigits: 4 });
}

/** "$1.55T", "$29.8B", "$7.2M" for the sizes a market cap comes in. */
export function fmtCompactUsd(n) {
  if (n === null) return null;
  const abs = Math.abs(n);
  const unit =
    abs >= 1e12
      ? [1e12, 'T']
      : abs >= 1e9
        ? [1e9, 'B']
        : abs >= 1e6
          ? [1e6, 'M']
          : abs >= 1e3
            ? [1e3, 'K']
            : null;
  if (!unit) return `$${fmtNum(n)}`;
  const v = n / unit[0];
  return `$${v.toLocaleString('en-US', { maximumFractionDigits: v < 10 ? 2 : 1 })}${unit[1]}`;
}

const signed = (pct) => (pct === null ? null : `${pct > 0 ? '+' : ''}${round(pct, 2)}%`);

/* -------------------------------------------------------------- coingecko -- */

/**
 * One coin from `/coins/markets`, as CoinGecko lists it (fields verified live
 * 2026-09-11). Ranked by market cap, which is what the `rank:top100` tag reads.
 */
export function coinToItem(c) {
  if (!c?.id || !c?.name) return null;
  const symbol = String(c.symbol ?? '').toLowerCase();
  const rank = num(c.market_cap_rank);
  const priceUsd = num(c.current_price);
  const marketCapUsd = num(c.market_cap);
  const change24hPct = num(
    c.price_change_percentage_24h_in_currency ?? c.price_change_percentage_24h,
  );
  return {
    externalId: `coingecko:${c.id}`,
    kind: 'asset',
    title: `${c.name} (${symbol.toUpperCase()})`,
    summary:
      [
        rank !== null ? `#${rank} by market cap` : null,
        priceUsd !== null ? `$${fmtNum(priceUsd)}` : null,
        change24hPct !== null ? `${signed(change24hPct)} in 24h` : null,
        marketCapUsd !== null ? `market cap ${fmtCompactUsd(marketCapUsd)}` : null,
      ]
        .filter(Boolean)
        .join(', ') || null,
    url: `https://www.coingecko.com/en/coins/${c.id}`,
    imageUrl: c.image ?? null,
    publishedAt: c.last_updated ?? null,
    tags: [
      'asset',
      symbol ? `symbol:${symbol}` : null,
      rank !== null && rank <= 100 ? 'rank:top100' : null,
    ].filter(Boolean),
    data: {
      id: c.id,
      symbol,
      name: c.name,
      rank,
      priceUsd,
      marketCapUsd,
      fullyDilutedUsd: num(c.fully_diluted_valuation),
      volume24hUsd: num(c.total_volume),
      change24hPct,
      high24h: num(c.high_24h),
      low24h: num(c.low_24h),
      supply: {
        circulating: num(c.circulating_supply),
        total: num(c.total_supply),
        max: num(c.max_supply),
      },
      ath: num(c.ath),
      athDate: c.ath_date ?? null,
      atl: num(c.atl),
      atlDate: c.atl_date ?? null,
      updatedAt: c.last_updated ?? null,
    },
  };
}

export const COINGECKO_PER_PAGE = 250;

export const coingeckoAssets = defineAdapter({
  name: 'coingecko-assets',
  title: 'Crypto assets by market cap (CoinGecko)',
  collection: COLLECTION,
  description:
    'Every crypto asset CoinGecko ranks by market cap, 500 by default: price, market cap, fully diluted valuation, 24-hour volume, high, low and change, circulating, total and max supply, and the all-time high and low. One item per coin, refreshed every fifteen minutes. Keyless; a free demo key (COINGECKO_API_KEY) raises the rate limit.',
  docs: 'https://docs.coingecko.com/reference/coins-markets',
  kinds: ['asset'],
  cadenceMinutes: 15,
  configFields: [
    {
      key: 'pages',
      label: 'Pages of 250',
      type: 'number',
      placeholder: '2',
      help: 'How many pages of 250 coins, from the top by market cap. Two is the top 500, which is what b1dz filtered against; the free tier allows about 30 requests a minute, so ten is still nothing.',
    },
  ],
  defaults: { pages: 2 },
  defaultSources: [{ slug: 'coingecko-assets', name: 'Crypto: every asset by market cap' }],
  async pull({ config, env, http, log, deadline }) {
    const client = makeCryptoClient({ env, http, log });
    const pages = Math.min(Math.max(Number(config.pages) || 2, 1), 10);
    const headers = env.coingeckoApiKey ? { 'x-cg-demo-api-key': env.coingeckoApiKey } : {};
    // Keyed by id: the ranking moves between two page reads, so a coin on the
    // boundary can arrive on both.
    const byId = new Map();
    let read = 0;
    for (let page = 1; page <= pages; page++) {
      const params = new URLSearchParams({
        vs_currency: 'usd',
        order: 'market_cap_desc',
        per_page: String(COINGECKO_PER_PAGE),
        page: String(page),
        sparkline: 'false',
        price_change_percentage: '24h',
      });
      const rows = await client.get(`${COINGECKO}/coins/markets?${params}`, {
        headers,
        timeoutMs: budgetMs(deadline),
      });
      if (!Array.isArray(rows)) throw new Error('coingecko: unexpected reply shape');
      read += 1;
      for (const c of rows) {
        const item = coinToItem(c);
        if (item && !byId.has(item.externalId)) byId.set(item.externalId, item);
      }
      if (rows.length < COINGECKO_PER_PAGE) break;
    }
    const items = [...byId.values()];
    log(`${items.length} assets over ${read} page(s)`);
    return { items, note: `${items.length} assets, ${read} page(s)` };
  },
});

/* ------------------------------------------------------------------ kraken -- */

/** Kraken's own names for two coins everyone else calls BTC and DOGE. */
export const KRAKEN_RENAME = { XBT: 'BTC', XDG: 'DOGE' };

/**
 * A Kraken asset code as the rest of the world spells it.
 *
 * Legacy listings wear a class prefix, X for crypto and Z for fiat: XXBT, XETH,
 * XXDG, ZUSD, ZEUR. Four letters starting X or Z is that form; a newer listing
 * (SOL, USDT, PEPE) has no prefix, and a real three-letter code is left alone.
 * Only a fallback: every pair carries a `wsname` ("XBT/USD") that already has
 * the prefixes off, and that is what `normaliseKrakenPair` reads first.
 */
export function krakenAsset(code) {
  let s = String(code ?? '').toUpperCase();
  if (s.length === 4 && /^[XZ]/.test(s)) s = s.slice(1);
  return KRAKEN_RENAME[s] ?? s;
}

/** `XXBTZUSD` + its AssetPairs entry -> { base: 'BTC', quote: 'USD', status }. */
export function normaliseKrakenPair(key, p) {
  let base;
  let quote;
  if (typeof p?.wsname === 'string' && p.wsname.includes('/')) {
    [base, quote] = p.wsname.split('/').map((s) => {
      const u = s.trim().toUpperCase();
      return KRAKEN_RENAME[u] ?? u;
    });
  } else if (p?.base && p?.quote) {
    base = krakenAsset(p.base);
    quote = krakenAsset(p.quote);
  } else {
    return null;
  }
  if (!base || !quote) return null;
  return { base, quote, status: p.status ?? null, venueSymbol: String(key) };
}

/**
 * The AssetPairs result as the compact list the cursor keeps for a day:
 * `{ [venueSymbol]: [base, quote, status] }`, kept to the quotes this adapter
 * emits so the cursor holds ~1,300 pairs rather than every BTC- and ETH-quoted
 * one as well. Status is kept as Kraken says it (online, cancel_only,
 * post_only) and filtered at emit time.
 */
export function parseKrakenPairs(result) {
  const out = {};
  for (const [key, p] of Object.entries(result ?? {})) {
    if (p?.aclass_base && p.aclass_base !== 'currency') continue;
    const n = normaliseKrakenPair(key, p);
    if (!n || !QUOTES.includes(n.quote)) continue;
    out[key] = [n.base, n.quote, n.status];
  }
  return out;
}

/**
 * One Ticker entry. Second elements are the last 24 hours (the first is
 * today since 00:00 UTC), except `o`, which Kraken defines as today's opening
 * price; so the change here is since midnight UTC, not a rolling day.
 */
export function parseKrakenTicker(t) {
  const price = num(t?.c?.[0]);
  const open24h = num(t?.o);
  const volume24hBase = num(t?.v?.[1]);
  const vwap24h = num(t?.p?.[1]);
  return {
    price,
    bid: num(t?.b?.[0]),
    ask: num(t?.a?.[0]),
    high24h: num(t?.h?.[1]),
    low24h: num(t?.l?.[1]),
    open24h,
    change24hPct: pctChange(price, open24h),
    volume24hBase,
    // Kraken reports no quote volume; base volume at the 24h VWAP is the same number.
    volume24hQuote:
      volume24hBase !== null && vwap24h !== null ? round(volume24hBase * vwap24h, 2) : null,
    vwap24h,
  };
}

/** Kraken answers 200 with an `error` array; a rate limit is one of its strings. */
function krakenCheck(res) {
  const errors = Array.isArray(res?.error) ? res.error.filter(Boolean) : [];
  if (!errors.length) return;
  const msg = errors.join('; ');
  if (/rate ?limit|too many requests/i.test(msg)) {
    const err = new Error(`rate limit: kraken says ${msg}`);
    err.status = 429;
    throw err;
  }
  throw new Error(`kraken: ${msg}`);
}

/* ---------------------------------------------------------------- coinbase -- */

/**
 * `/products` from the Exchange API, as the cursor keeps it. A product is
 * online when Coinbase says so and trading is not disabled; post-only and
 * limit-only books are still online (the venue takes orders on them).
 */
export function parseCoinbaseProducts(list) {
  const out = {};
  for (const p of list ?? []) {
    if (!p?.id || !p.base_currency || !p.quote_currency) continue;
    const quote = String(p.quote_currency).toUpperCase();
    if (!QUOTES.includes(quote)) continue;
    const status =
      p.status === 'online' && !p.trading_disabled ? 'online' : String(p.status ?? 'unknown');
    out[p.id] = [String(p.base_currency).toUpperCase(), quote, status];
  }
  return out;
}

/**
 * One `/products/stats` value: `stats_24hour` is open, high, low, last and
 * volume in base units. No bid, ask or quote volume on this endpoint; the quote
 * volume is base volume at the last price, which is approximate.
 */
export function parseCoinbaseStats(s) {
  const d = s?.stats_24hour ?? s ?? {};
  const price = num(d.last);
  const open24h = num(d.open);
  const volume24hBase = num(d.volume);
  return {
    price,
    bid: null,
    ask: null,
    high24h: num(d.high),
    low24h: num(d.low),
    open24h,
    change24hPct: pctChange(price, open24h),
    volume24hBase,
    volume24hQuote:
      volume24hBase !== null && price !== null ? round(volume24hBase * price, 2) : null,
    vwap24h: null,
  };
}

/* -------------------------------------------------------------- binance.us -- */

/**
 * `/exchangeInfo` symbols as the cursor keeps them. `BTCUSD` splits by the
 * baseAsset and quoteAsset fields, never by suffix: Binance.US also lists a
 * legacy `USD4` quote (BTCUSD4, all in BREAK) that a suffix match would read
 * as USD.
 */
export function parseBinanceSymbols(info) {
  const out = {};
  for (const s of info?.symbols ?? []) {
    if (!s?.symbol || !s.baseAsset || !s.quoteAsset) continue;
    const quote = String(s.quoteAsset).toUpperCase();
    if (!QUOTES.includes(quote)) continue;
    const status = s.status === 'TRADING' ? 'online' : String(s.status ?? 'unknown').toLowerCase();
    out[s.symbol] = [String(s.baseAsset).toUpperCase(), quote, status];
  }
  return out;
}

/** One `/ticker/24hr` row: the fullest ticker of the four venues. */
export function parseBinanceTicker(t) {
  const price = num(t?.lastPrice);
  const open24h = num(t?.openPrice);
  const reported = num(t?.priceChangePercent);
  return {
    price,
    bid: num(t?.bidPrice),
    ask: num(t?.askPrice),
    high24h: num(t?.highPrice),
    low24h: num(t?.lowPrice),
    open24h,
    change24hPct: reported !== null ? round(reported, 4) : pctChange(price, open24h),
    volume24hBase: num(t?.volume),
    volume24hQuote: num(t?.quoteVolume),
    vwap24h: num(t?.weightedAvgPrice),
  };
}

/* ------------------------------------------------------------------ gemini -- */

/**
 * The quotes Gemini prices in, longest first, because its symbols have no
 * separator: `aavegusd` is AAVE/GUSD (Gemini's own dollar), not AAVEG/USD, and
 * `driftrlusd` is DRIFT/RLUSD. A `perp` suffix is a perpetual, not spot.
 * Checked against the live list 2026-09-11: no USD-quoted base ends in G or RL,
 * so longest-suffix is unambiguous today.
 */
export const GEMINI_QUOTES = [
  'RLUSD',
  'GUSD',
  'USDC',
  'USDT',
  'USD',
  'EUR',
  'GBP',
  'SGD',
  'BTC',
  'ETH',
  'SOL',
  'FIL',
];

/** `btcusd` -> { base: 'BTC', quote: 'USD' }; null for a perpetual or an unknown quote. */
export function parseGeminiSymbol(sym) {
  const s = String(sym ?? '').toUpperCase();
  if (!s || s.endsWith('PERP')) return null;
  for (const q of GEMINI_QUOTES) {
    if (s.endsWith(q) && s.length > q.length) return { base: s.slice(0, -q.length), quote: q };
  }
  return null;
}

/**
 * One `/pricefeed` row. Price and a 24h change as a fraction (-0.013 is
 * -1.3%); Gemini's only all-pairs endpoint carries no volume, bid, ask, high
 * or low. `/v1/symbols/details/<symbol>` has more but is one request per pair,
 * which is 300 a run, so those stay null and `data` says so.
 */
export function parseGeminiPricefeed(row) {
  const price = num(row?.price);
  const frac = num(row?.percentChange24h);
  return {
    price,
    bid: null,
    ask: null,
    high24h: null,
    low24h: null,
    open24h: null,
    change24hPct: frac === null ? null : round(frac * 100, 4),
    volume24hBase: null,
    volume24hQuote: null,
    vwap24h: null,
  };
}

/* -------------------------------------------------------------------- item -- */

const EMPTY_TICKER = parseGeminiPricefeed({});

/** One (venue, pair) with its ticker. `publishedAt` is the run, because the ticker is. */
export function pairItem({ venue, base, quote, venueSymbol, status = 'online', ticker, now }) {
  const v = VENUES[venue];
  if (!v) return null;
  const t = { ...EMPTY_TICKER, ...ticker };
  const stable = STABLE_QUOTES.has(quote);
  const at = new Date(now ?? Date.now()).toISOString();
  return {
    externalId: `pair:${venue}:${base}-${quote}`,
    kind: 'pair',
    title: `${base}/${quote} on ${v.name}`,
    summary:
      [
        t.price !== null ? `${fmtNum(t.price)} ${quote}` : null,
        t.change24hPct !== null ? `${signed(t.change24hPct)} in 24h` : null,
        t.volume24hBase !== null ? `volume ${fmtNum(t.volume24hBase)} ${base}` : null,
      ]
        .filter(Boolean)
        .join(', ') || null,
    url: v.tradeUrl(base, quote),
    publishedAt: at,
    tags: [
      'pair',
      `venue:${venue}`,
      `base:${base.toLowerCase()}`,
      `quote:${quote.toLowerCase()}`,
      stable ? 'stable-quote' : null,
    ].filter(Boolean),
    data: {
      venue,
      venueName: v.name,
      base,
      quote,
      venueSymbol,
      status,
      price: t.price,
      bid: t.bid,
      ask: t.ask,
      high24h: t.high24h,
      low24h: t.low24h,
      open24h: t.open24h,
      change24hPct: t.change24hPct,
      volume24hBase: t.volume24hBase,
      volume24hQuote: t.volume24hQuote,
      vwap24h: t.vwap24h,
      priceUsd: stable ? t.price : null,
      updatedAt: at,
    },
  };
}

/* ----------------------------------------------------------------- venues -- */

/**
 * A venue's pair list from the cursor while it is under a day old, else
 * refetched. A refresh that fails falls back to the stale list rather than
 * losing the venue for the run, because the tickers are the part that matters
 * every five minutes.
 */
async function cachedList(slot, { name, fetchList, log, now }) {
  const at = Date.parse(slot?.at ?? '');
  if (slot?.list && Number.isFinite(at) && now - at < LIST_TTL_MS) {
    return { list: slot.list, at: slot.at, fetched: false };
  }
  try {
    const list = await fetchList();
    return { list, at: new Date(now).toISOString(), fetched: true };
  } catch (err) {
    if (slot?.list) {
      log(`${name}: list refresh failed (${err?.message ?? err}); using the list from ${slot.at}`);
      return { list: slot.list, at: slot.at, fetched: false };
    }
    throw err;
  }
}

/** Items for every listed pair that is online, wanted and has a ticker. */
function emit({ venue, list, quotes, tickerFor, now }) {
  const items = [];
  for (const [venueSymbol, [base, quote, status]] of Object.entries(list)) {
    if (status !== 'online' || !quotes.has(quote)) continue;
    const ticker = tickerFor(venueSymbol);
    if (!ticker) continue;
    const item = pairItem({ venue, base, quote, venueSymbol, status, ticker, now });
    if (item) items.push(item);
  }
  return items;
}

async function pullKraken({ client, cursor, quotes, now, log, deadline }) {
  const { list, at } = await cachedList(cursor.kraken, {
    name: 'kraken',
    log,
    now,
    fetchList: async () => {
      const res = await client.get(`${KRAKEN}/AssetPairs`, { timeoutMs: budgetMs(deadline) });
      krakenCheck(res);
      return parseKrakenPairs(res.result);
    },
  });
  cursor.kraken = { list, at };
  const res = await client.get(`${KRAKEN}/Ticker`, { timeoutMs: budgetMs(deadline) });
  krakenCheck(res);
  const tickers = res.result ?? {};
  return emit({
    venue: 'kraken',
    list,
    quotes,
    now,
    tickerFor: (key) => (tickers[key] ? parseKrakenTicker(tickers[key]) : null),
  });
}

async function pullCoinbase({ client, cursor, quotes, now, log, deadline }) {
  const { list, at } = await cachedList(cursor.coinbase, {
    name: 'coinbase',
    log,
    now,
    fetchList: async () =>
      parseCoinbaseProducts(
        await client.get(`${COINBASE}/products`, { timeoutMs: budgetMs(deadline) }),
      ),
  });
  cursor.coinbase = { list, at };
  const stats = await client.get(`${COINBASE}/products/stats`, { timeoutMs: budgetMs(deadline) });
  return emit({
    venue: 'coinbase',
    list,
    quotes,
    now,
    tickerFor: (id) => (stats?.[id] ? parseCoinbaseStats(stats[id]) : null),
  });
}

async function pullBinanceUs({ client, cursor, quotes, now, log, deadline }) {
  const { list, at } = await cachedList(cursor.binanceUs, {
    name: 'binance-us',
    log,
    now,
    fetchList: async () =>
      parseBinanceSymbols(
        await client.get(`${BINANCE_US}/exchangeInfo`, { timeoutMs: budgetMs(deadline) }),
      ),
  });
  cursor.binanceUs = { list, at };
  const rows = await client.get(`${BINANCE_US}/ticker/24hr`, { timeoutMs: budgetMs(deadline) });
  const bySymbol = new Map((Array.isArray(rows) ? rows : []).map((r) => [r?.symbol, r]));
  return emit({
    venue: 'binance-us',
    list,
    quotes,
    now,
    tickerFor: (sym) => (bySymbol.has(sym) ? parseBinanceTicker(bySymbol.get(sym)) : null),
  });
}

/**
 * Gemini's symbol list is 4 KB and is also its only statement of what is live
 * (the pricefeed carries no status), so it is read every run rather than cached.
 */
async function pullGemini({ client, quotes, now, deadline }) {
  const symbols = await client.get(`${GEMINI}/symbols`, { timeoutMs: budgetMs(deadline) });
  const feed = await client.get(`${GEMINI}/pricefeed`, { timeoutMs: budgetMs(deadline) });
  const byPair = new Map(
    (Array.isArray(feed) ? feed : []).map((r) => [String(r?.pair ?? '').toUpperCase(), r]),
  );
  const list = {};
  for (const sym of Array.isArray(symbols) ? symbols : []) {
    const p = parseGeminiSymbol(sym);
    if (p && QUOTES.includes(p.quote)) list[String(sym)] = [p.base, p.quote, 'online'];
  }
  return emit({
    venue: 'gemini',
    list,
    quotes,
    now,
    tickerFor: (sym) => {
      const row = byPair.get(sym.toUpperCase());
      return row ? parseGeminiPricefeed(row) : null;
    },
  });
}

const PULLERS = {
  kraken: pullKraken,
  coinbase: pullCoinbase,
  'binance-us': pullBinanceUs,
  gemini: pullGemini,
};

const listOf = (v, allowed) =>
  (Array.isArray(v) ? v : []).map((s) => String(s).trim()).filter((s) => allowed.includes(s));

/** The venues a source polls: the ones named in config, else all four. */
export function venuesOf(config) {
  const picked = listOf(config?.venues, VENUE_SLUGS);
  return picked.length ? picked : VENUE_SLUGS;
}

/** The quotes a source keeps: the ones named in config, else all five. */
export function quotesOf(config) {
  const picked = listOf(
    (Array.isArray(config?.quotes) ? config.quotes : []).map((q) => String(q).toUpperCase()),
    QUOTES,
  );
  return new Set(picked.length ? picked : QUOTES);
}

export const cryptoPairs = defineAdapter({
  name: 'crypto-pairs',
  title: 'Crypto spot pairs on US venues',
  collection: COLLECTION,
  description:
    'Every spot pair on Kraken, Coinbase, Binance.US and Gemini that is quoted in USD, USDT, USDC, EUR or GBP and open for trading, one item per pair per venue with its latest 24-hour ticker: price, bid and ask, high, low, open, change, base and quote volume and VWAP where the venue reports them. Refreshed every five minutes from one or two public requests per venue; a venue that fails is skipped for the run and the others still land. Keyless. Binance.US refuses datacenter egress, so set CRYPTO_PROXY_URL to a residential proxy on a hosted deployment or it is skipped with a note.',
  docs: 'https://docs.kraken.com/api/docs/rest-api/get-ticker-information',
  kinds: ['pair'],
  cadenceMinutes: 5,
  configFields: [
    {
      key: 'venues',
      label: 'Venues',
      type: 'list',
      placeholder: VENUE_SLUGS.join(', '),
      help: `Any of ${VENUE_SLUGS.join(', ')}. Empty for all four.`,
    },
    {
      key: 'quotes',
      label: 'Quote currencies',
      type: 'list',
      placeholder: QUOTES.join(', '),
      help: `Any of ${QUOTES.join(', ')}. Empty for all five.`,
    },
  ],
  defaults: { venues: [], quotes: [] },
  defaultSources: [
    {
      slug: 'crypto-pairs',
      name: 'Crypto: every spot pair on Kraken, Coinbase, Binance.US and Gemini',
    },
  ],
  async pull({ config, cursor: prev, env, http, log, deadline }) {
    const client = makeCryptoClient({ env, http, log });
    const now = Date.now();
    const venues = venuesOf(config);
    const quotes = quotesOf(config);
    const cursor = { ...(prev ?? {}) };
    const got = new Map();

    // Venues in parallel: the pacing is per host, so nothing is gained by
    // queueing Coinbase behind Kraken. Each puller writes only its own cursor
    // key, and the results are read back in configured order so the note and
    // the error read the same way every run.
    await Promise.all(
      venues.map(async (venue) => {
        try {
          got.set(venue, await PULLERS[venue]({ client, cursor, quotes, now, log, deadline }));
        } catch (err) {
          got.set(venue, null);
          if (err?.blocked && venue === 'binance-us' && !client.proxied) {
            log(
              `binance-us: ${err.status} from this egress (Binance.US blocks datacenter IPs); set CRYPTO_PROXY_URL to reach it. Skipped.`,
            );
          } else {
            log(`${venue}: ${err?.message ?? err}; skipped`);
          }
        }
      }),
    );

    const failed = venues.filter((v) => got.get(v) === null);
    if (failed.length === venues.length) {
      throw new Error(`every venue failed: ${failed.join(', ')}`);
    }
    const items = venues.flatMap((v) => got.get(v) ?? []);
    const counts = venues.filter((v) => got.get(v)).map((v) => `${v} ${got.get(v).length}`);
    return {
      items,
      cursor,
      note: `${items.length} pairs (${counts.join(', ')})${failed.length ? `; failed: ${failed.join(', ')}` : ''}`,
    };
  },
});
