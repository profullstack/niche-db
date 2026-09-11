import { dateOnly, defineAdapter, slugify } from '@nichedb/core/adapter';
import { isoDay } from './alpaca.js';

/**
 * US equities: the symbol directory, the daily price history and the SEC
 * fundamentals that advis0r.com and b1dz.com each fetched for themselves.
 *
 * Three adapters, all in `markets`:
 *
 *   alpaca-assets     every active Alpaca asset, one row a symbol, daily
 *   equity-history    the last 400 daily bars a symbol, extended each session
 *   sec-fundamentals  XBRL company facts a company, the whole list once a week
 *
 * The history adapter is the one with a design worth reading. An adapter emits
 * whole items and cannot carry 8k windows of 400 bars in its cursor, so it
 * reads the window it wrote last time back through `ctx.previous` and extends
 * it. And it walks the universe on a clock that only ticks once a US session
 * has settled, so the hourly runs outside trading hours cost nothing at all.
 */

const TRADING = 'https://api.alpaca.markets';
const DATA = 'https://data.alpaca.markets';
const SEC_FILES = 'https://www.sec.gov/files';
const SEC_XBRL = 'https://data.sec.gov/api/xbrl/companyfacts';

/** How the SEC is told who is asking. The contact is the deployment's. */
const SEC_SITE = 'nichedb.dev';

const DAY_MS = 86_400_000;

/**
 * Alpaca allows 200 requests a minute on the free tier. 325 ms between
 * requests is about 185, which leaves the retry the http helper makes after a
 * 429 inside the same minute.
 */
export const ALPACA_PACE_MS = 325;
/** The SEC allows ten a second and asks for fewer; this never passes five. */
export const SEC_PACE_MS = 200;
/** Left of the run deadline for the write. */
export const DEADLINE_MARGIN_MS = 15_000;

function auth(env) {
  if (!env.alpacaKeyId || !env.alpacaSecretKey) {
    throw new Error('Alpaca needs APCA_API_KEY_ID and APCA_API_SECRET_KEY');
  }
  return {
    'APCA-API-KEY-ID': env.alpacaKeyId,
    'APCA-API-SECRET-KEY': env.alpacaSecretKey,
  };
}

/** A gate that spaces calls at least `ms` apart, counting from the last start. */
function pacer(ms) {
  let last = 0;
  return async () => {
    const wait = last + ms - Date.now();
    if (wait > 0) await Bun.sleep(wait);
    last = Date.now();
  };
}

const clamp = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.floor(n))) : dflt;
};

/* ---------------------------------------------------------------- assets -- */

/** Alpaca's exchange codes, as the tags spell them. Anything else is slugified. */
export const EXCHANGES = {
  NASDAQ: 'nasdaq',
  NYSE: 'nyse',
  NYSEARCA: 'arca',
  ARCA: 'arca',
  BATS: 'bats',
  AMEX: 'amex',
  OTC: 'otc',
  CRYPTO: 'crypto',
};

export const exchangeSlug = (x) =>
  EXCHANGES[String(x ?? '').toUpperCase()] ?? (slugify(x) || 'unknown');

/**
 * Yahoo writes a class share with a hyphen (BRK-B) where Alpaca writes a dot
 * (BRK.B), and a crypto pair as BTC-USD where Alpaca writes BTC/USD.
 */
export const yahooSymbol = (s) => String(s).toUpperCase().replace(/[./]/g, '-');

const CLASS_LABEL = { us_equity: 'US equity', crypto: 'crypto', us_option: 'US option' };

export function assetToItem(a) {
  if (!a?.id || !a?.symbol) return null;
  const symbol = String(a.symbol).toUpperCase();
  const exchange = exchangeSlug(a.exchange);
  const assetClass = String(a.class ?? 'us_equity');
  const flags = [
    a.tradable ? 'tradable' : null,
    a.fractionable ? 'fractionable' : null,
    a.shortable ? 'shortable' : null,
  ].filter(Boolean);
  return {
    externalId: `alpaca:asset:${a.id}`,
    kind: 'symbol',
    title: `${symbol} · ${a.name ?? symbol}`,
    summary: [a.exchange, CLASS_LABEL[assetClass] ?? assetClass, ...flags]
      .filter(Boolean)
      .join(' · '),
    url: `https://finance.yahoo.com/quote/${yahooSymbol(symbol)}`,
    publishedAt: null,
    timeKnown: false,
    precision: 'day',
    tags: [
      'symbol',
      `symbol:${String(a.symbol).toLowerCase()}`,
      `exchange:${exchange}`,
      `class:${assetClass}`,
      a.tradable ? 'tradable' : null,
      exchange === 'otc' ? 'otc' : null,
      a.fractionable ? 'fractionable' : null,
      a.shortable ? 'shortable' : null,
    ].filter(Boolean),
    data: {
      assetId: a.id,
      symbol,
      name: a.name ?? null,
      exchange: a.exchange ?? null,
      assetClass,
      status: a.status ?? null,
      tradable: a.tradable === true,
      marginable: a.marginable === true,
      shortable: a.shortable === true,
      easyToBorrow: a.easy_to_borrow === true,
      fractionable: a.fractionable === true,
      attributes: Array.isArray(a.attributes) ? a.attributes : [],
    },
  };
}

const ASSET_CLASSES = ['us_equity', 'crypto'];

export const alpacaAssets = defineAdapter({
  name: 'alpaca-assets',
  title: 'US symbols (Alpaca)',
  collection: 'markets',
  description:
    'Every active asset Alpaca lists, one row a symbol: US equities across NASDAQ, NYSE, ARCA, BATS, AMEX and OTC, plus its crypto pairs, each with exchange, class and the tradable, fractionable and shortable flags. The whole directory, so a lookup by name or ticker is answered locally. Needs an Alpaca key.',
  docs: 'https://docs.alpaca.markets/reference/get-v2-assets-1',
  kinds: ['symbol'],
  cadenceMinutes: 1440,
  needsEnv: ['alpacaKeyId', 'alpacaSecretKey'],
  configFields: [
    {
      key: 'classes',
      label: 'Asset classes',
      type: 'list',
      placeholder: 'us_equity, crypto',
      help: 'One request each. Empty for both.',
    },
  ],
  defaults: { classes: ASSET_CLASSES },
  defaultSources: [{ slug: 'alpaca-assets', name: 'Markets: US symbol directory' }],
  async pull({ config, env, http, log }) {
    const headers = auth(env);
    const classes = (Array.isArray(config.classes) ? config.classes : [])
      .map((c) => String(c).trim().toLowerCase())
      .filter((c) => /^[a-z_]+$/.test(c));
    const wanted = classes.length ? classes : ASSET_CLASSES;
    const items = [];
    const counts = [];
    for (const cls of wanted) {
      const rows = await http.json(`${TRADING}/v2/assets?status=active&asset_class=${cls}`, {
        headers,
        timeoutMs: 90_000,
      });
      let n = 0;
      for (const a of Array.isArray(rows) ? rows : []) {
        const item = assetToItem(a);
        if (!item) continue;
        items.push(item);
        n++;
      }
      counts.push(`${n} ${cls}`);
    }
    log(`${items.length} active assets (${counts.join(', ')})`);
    return { items, note: `${items.length} assets: ${counts.join(', ')}` };
  },
});

/* --------------------------------------------------------------- history -- */

export const BAR_CAP = 400;
/** Pages one symbol group may take; 100 symbols × 400 days is three. */
const MAX_PAGES = 12;

export const historyId = (symbol) => `history:${String(symbol).toUpperCase()}`;

/** The day after a YYYY-MM-DD. */
export const nextDay = (day) => isoDay(Date.parse(`${day}T12:00:00Z`) + DAY_MS);

const isWeekend = (day) => {
  const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6;
};

/**
 * A daily bar is final once the extended session has closed, 20:00 ET, and
 * Alpaca has had a few minutes to seal it. Reading earlier stores a bar that
 * is still moving and then never asks for that day again.
 */
const SESSION_SETTLED_MINUTES = 20 * 60 + 15;

const ET = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

/**
 * The most recent weekday whose session has settled, in New York's calendar.
 * Holidays are not known here: a walk on one asks and finds nothing, which
 * costs a round of requests and nothing else.
 */
export function latestSessionDay(now = Date.now()) {
  const p = Object.fromEntries(ET.formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  let day = `${p.year}-${p.month}-${p.day}`;
  const minutes = Number(p.hour) * 60 + Number(p.minute);
  if (minutes < SESSION_SETTLED_MINUTES || isWeekend(day)) {
    day = isoDay(Date.parse(`${day}T12:00:00Z`) - DAY_MS);
  }
  while (isWeekend(day)) day = isoDay(Date.parse(`${day}T12:00:00Z`) - DAY_MS);
  return day;
}

/** `[day, open, high, low, close, volume, vwap]`; null for a bar with no day. */
export function barTuple(b) {
  const day = String(b?.t ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const num = (v) => (Number.isFinite(v) ? v : null);
  return [day, num(b.o), num(b.h), num(b.l), num(b.c), num(b.v), num(b.vw)];
}

/**
 * The window after new bars land: a day already held is replaced (a bar
 * re-read after a split adjustment is the newer truth), oldest first, and
 * only the last `cap` survive.
 */
export function mergeBars(held, fresh, cap = BAR_CAP) {
  const byDay = new Map();
  for (const b of Array.isArray(held) ? held : []) if (Array.isArray(b) && b[0]) byDay.set(b[0], b);
  for (const b of fresh ?? []) if (Array.isArray(b) && b[0]) byDay.set(b[0], b);
  return [...byDay.values()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).slice(-cap);
}

export function historyItem({ symbol, feed, adjustment, bars }) {
  if (!bars?.length) return null;
  const sym = String(symbol).toUpperCase();
  const first = bars[0][0];
  const last = bars.at(-1)[0];
  const [y, m, d] = last.split('-').map(Number);
  return {
    externalId: historyId(sym),
    kind: 'history',
    title: `${sym} daily bars`,
    summary: `${bars.length} daily bars, ${first} to ${last}; last close ${bars.at(-1)[4]}`,
    url: `https://finance.yahoo.com/quote/${yahooSymbol(sym)}/history`,
    publishedAt: dateOnly(y, m, d),
    timeKnown: false,
    precision: 'day',
    tags: ['history', `symbol:${sym.toLowerCase()}`, `feed:${feed}`],
    data: {
      symbol: sym,
      timeframe: '1Day',
      feed,
      adjustment,
      bars,
      first,
      last,
      count: bars.length,
    },
  };
}

/** The symbols the history follows: active, tradable US equities off the pink sheets. */
export function universeFrom(assets) {
  const out = new Set();
  for (const a of Array.isArray(assets) ? assets : []) {
    if (!a?.symbol || a.status !== 'active' || a.tradable !== true) continue;
    if ((a.class ?? 'us_equity') !== 'us_equity') continue;
    if (exchangeSlug(a.exchange) === 'otc') continue;
    out.add(String(a.symbol).toUpperCase());
  }
  return [...out].sort();
}

/**
 * Which days to ask for, per symbol, then grouped so a batch costs at most two
 * request series.
 *
 * A symbol resumes the day after the later of the last bar it holds and the
 * last day it was asked about and had nothing (`quiet`), never further back
 * than the window. One with neither is fresh and gets the whole window. A
 * window read on another feed is not a resume point: the feeds disagree about
 * the past, so the symbol starts over.
 *
 * Most of a batch shares one start; the stragglers (fresh listings, names that
 * had no print on IEX for a while) are pooled under the earliest of their
 * starts rather than costing a request each. Over-asking is bytes; asking
 * again is requests, and requests are what the tier counts.
 */
export function planBatch({ symbols, previous, feed, end, quiet, backfillStart }) {
  const starts = new Map();
  for (const sym of symbols) {
    const held = previous?.get(historyId(sym));
    const usable = held && held.feed === feed && Array.isArray(held.bars) && held.last;
    const marks = [usable ? held.last : null, quiet?.[sym] ?? null].filter(Boolean).sort();
    let start = marks.length ? nextDay(marks.at(-1)) : backfillStart;
    if (start < backfillStart) start = backfillStart;
    if (start > end) continue;
    const list = starts.get(start) ?? [];
    list.push(sym);
    starts.set(start, list);
  }
  const groups = [...starts.entries()].map(([start, syms]) => ({ start, symbols: syms }));
  if (groups.length <= 2) return groups.sort((a, b) => b.symbols.length - a.symbols.length);
  groups.sort((a, b) => b.symbols.length - a.symbols.length);
  const [main, ...rest] = groups;
  return [
    main,
    {
      start: rest.map((g) => g.start).sort()[0],
      symbols: rest.flatMap((g) => g.symbols),
    },
  ];
}

export const equityHistory = defineAdapter({
  name: 'equity-history',
  title: 'US daily price history (Alpaca)',
  collection: 'markets',
  description:
    'The last 400 daily bars of every active, tradable US equity off the OTC market, one item a symbol, extended once each session has settled. Split-adjusted, from the IEX feed by default or the SIP tape on a paid data plan. A fresh deployment backfills 400 calendar days across a few runs; after that a session costs about ninety requests and the runs outside trading hours cost none. Needs an Alpaca key.',
  docs: 'https://docs.alpaca.markets/reference/stockbars',
  kinds: ['history'],
  cadenceMinutes: 60,
  needsEnv: ['alpacaKeyId', 'alpacaSecretKey'],
  configFields: [
    {
      key: 'feed',
      label: 'Feed',
      type: 'select',
      options: ['iex', 'sip'],
      help: 'iex is free; sip is the consolidated tape and needs a paid data plan. Empty uses APCA_FEED.',
    },
    {
      key: 'batchSize',
      label: 'Symbols per request',
      type: 'number',
      placeholder: '100',
      help: 'Alpaca reads many symbols at once; a hundred keeps a day of bars to one page.',
    },
    {
      key: 'backfillDays',
      label: 'Backfill (calendar days)',
      type: 'number',
      placeholder: '400',
      help: 'How far back a symbol seen for the first time is read.',
    },
  ],
  defaults: { feed: '', batchSize: 100, backfillDays: 400 },
  defaultSources: [{ slug: 'equity-history', name: 'Markets: US daily price history' }],
  async pull(ctx) {
    const { config, cursor: prev, env, http, log, deadline } = ctx;
    const headers = auth(env);
    const feed =
      String(config.feed || env.alpacaFeed || 'iex').toLowerCase() === 'sip' ? 'sip' : 'iex';
    const adjustment = 'split';
    const batchSize = clamp(config.batchSize, 1, 200, 100);
    const backfillDays = clamp(config.backfillDays, 30, 2000, 400);
    const now = ctx.now ?? Date.now();
    const stopAt = deadline - DEADLINE_MARGIN_MS;
    const pace = pacer(ctx.paceMs ?? ALPACA_PACE_MS);
    const previous = ctx.previous ?? (async () => new Map());
    if (!ctx.previous) log('no ctx.previous from the core: every symbol reads as fresh');
    const cursor = { ...prev };
    let requests = 0;

    async function get(url) {
      await pace();
      requests += 1;
      return http.json(url, { headers, timeoutMs: 60_000 });
    }

    // The universe, once a day. This adapter cannot read the assets adapter's
    // rows, and one request a day is cheaper than a dependency.
    const universeAge = now - (Date.parse(cursor.universeAt ?? '') || 0);
    if (!Array.isArray(cursor.universe) || universeAge > DAY_MS) {
      const rows = await get(`${TRADING}/v2/assets?status=active&asset_class=us_equity`);
      cursor.universe = universeFrom(rows);
      cursor.universeAt = new Date(now).toISOString();
      const keep = new Set(cursor.universe);
      cursor.quiet = Object.fromEntries(
        Object.entries(cursor.quiet ?? {}).filter(([sym]) => keep.has(sym)),
      );
      log(`universe: ${cursor.universe.length} symbols`);
    }
    const universe = cursor.universe;

    // A walk begins when a session has settled that the last one did not cover,
    // and only then: the runs between cost nothing.
    const target = latestSessionDay(now);
    let walk = cursor.walk ?? null;
    if (!walk) {
      if (cursor.lastDay && cursor.lastDay >= target) {
        return {
          items: [],
          cursor,
          note: `through ${cursor.lastDay}; nothing has settled since (${requests} request(s))`,
        };
      }
      walk = { end: target, i: 0, startedAt: new Date(now).toISOString() };
    }
    const backfillStart = isoDay(Date.parse(`${walk.end}T12:00:00Z`) - backfillDays * DAY_MS);
    const quiet = { ...(cursor.quiet ?? {}) };
    const items = [];
    let asked = 0;
    let freshCount = 0;

    while (walk.i < universe.length) {
      if (Date.now() >= stopAt) break;
      const batch = universe.slice(walk.i, walk.i + batchSize);
      const held = await previous(batch.map(historyId));
      const groups = planBatch({
        symbols: batch,
        previous: held,
        feed,
        end: walk.end,
        quiet,
        backfillStart,
      });
      const got = new Map();
      for (const g of groups) {
        let token = null;
        let pages = 0;
        do {
          const params = new URLSearchParams({
            symbols: g.symbols.join(','),
            timeframe: '1Day',
            start: `${g.start}T00:00:00Z`,
            end: `${walk.end}T23:59:59Z`,
            limit: '10000',
            adjustment,
            feed,
            sort: 'asc',
          });
          if (token) params.set('page_token', token);
          const res = await get(`${DATA}/v2/stocks/bars?${params}`);
          for (const [sym, bars] of Object.entries(res?.bars ?? {})) {
            const key = String(sym).toUpperCase();
            got.set(key, [...(got.get(key) ?? []), ...(Array.isArray(bars) ? bars : [])]);
          }
          token = res?.next_page_token ?? null;
          pages += 1;
        } while (token && pages < MAX_PAGES);
        asked += g.symbols.length;
      }
      for (const g of groups) {
        for (const sym of g.symbols) {
          const fresh = (got.get(sym) ?? []).map(barTuple).filter(Boolean);
          const before = held.get(historyId(sym));
          const usable = before && before.feed === feed && Array.isArray(before.bars);
          if (!usable) freshCount += 1;
          if (fresh.length === 0) {
            // Remembered so the next walk resumes here rather than re-reading
            // the whole window for a name with no prints.
            quiet[sym] = walk.end;
            continue;
          }
          delete quiet[sym];
          const bars = mergeBars(usable ? before.bars : [], fresh);
          items.push(historyItem({ symbol: sym, feed, adjustment, bars }));
        }
      }
      walk.i += batch.length;
    }

    const done = walk.i >= universe.length;
    if (done) {
      cursor.lastDay = walk.end;
      cursor.walk = null;
    } else {
      cursor.walk = walk;
    }
    cursor.quiet = quiet;
    const note = `${done ? 'walked' : `walked ${walk.i} of`} ${universe.length} symbols through ${walk.end}: ${asked} asked, ${items.length} with new bars, ${freshCount} fresh, ${requests} request(s) on ${feed}${done ? '' : '; resuming'}`;
    log(note);
    return { items, cursor, note, nextInMinutes: done ? undefined : 5 };
  },
});

/* ---------------------------------------------------------- fundamentals -- */

/**
 * The XBRL concepts kept, by taxonomy. The first group is what a screen or a
 * thesis reads; the rest are the alternatives advis0r's provider fell back to
 * (a filer reports revenue under one of three tags, and long-term debt under
 * one or as current plus non-current) and the cover-page share counts, which
 * are more current than the balance-sheet ones.
 */
export const CONCEPTS = {
  'us-gaap': [
    'Revenues',
    'RevenueFromContractWithCustomerExcludingAssessedTax',
    'SalesRevenueNet',
    'GrossProfit',
    'OperatingIncomeLoss',
    'NetIncomeLoss',
    'EarningsPerShareBasic',
    'EarningsPerShareDiluted',
    'Assets',
    'Liabilities',
    'StockholdersEquity',
    'CashAndCashEquivalentsAtCarryingValue',
    'NetCashProvidedByUsedInOperatingActivities',
    'CommonStockSharesOutstanding',
    'LongTermDebt',
    'LongTermDebtNoncurrent',
    'LongTermDebtCurrent',
  ],
  dei: ['EntityCommonStockSharesOutstanding', 'EntityPublicFloat'],
};

/** Annual and quarterly reports, domestic and foreign, amendments included. */
export const REPORT_FORMS = /^(10-K|10-Q|20-F|40-F)/;
/** Points kept a concept: three years of quarters. */
export const POINTS_KEPT = 12;

const UNIT_PREFERENCE = ['USD', 'shares', 'USD/shares'];

const cik10 = (cik) => String(cik).replace(/\D/g, '').padStart(10, '0');

/** A duration point that is the period its fp says it is, not a year-to-date. */
function fits(p) {
  if (!p.start) return true;
  const days = (Date.parse(p.end) - Date.parse(p.start)) / DAY_MS;
  return p.fp === 'FY' ? days >= 300 : days <= 120;
}

/** Does `a` displace `b` for the same (end, fp)? The right period first, then the latest filing. */
function better(a, b) {
  const fa = fits(a);
  const fb = fits(b);
  if (fa !== fb) return fa;
  return String(a.filed ?? '') > String(b.filed ?? '');
}

/**
 * One concept's points: the reports only, one a period (end + fp), the latest
 * filing winning so a restatement replaces what it restated, and a quarter's
 * three-month figure beating the year-to-date one that shares its end date.
 * Oldest first, the last twelve.
 */
export function conceptPoints(fact) {
  const units = Object.entries(fact?.units ?? {}).filter(([, rows]) => Array.isArray(rows));
  if (units.length === 0) return [];
  // One unit a concept. A filer reporting in two currencies would otherwise mix them.
  units.sort((a, b) => {
    const d = b[1].length - a[1].length;
    if (d !== 0) return d;
    return (UNIT_PREFERENCE.indexOf(a[0]) + 1 || 99) - (UNIT_PREFERENCE.indexOf(b[0]) + 1 || 99);
  });
  const [unit, rows] = units[0];
  const best = new Map();
  for (const r of rows) {
    if (!r?.end || typeof r.val !== 'number' || !REPORT_FORMS.test(String(r.form ?? ''))) continue;
    const fp = String(r.fp ?? 'FY');
    const p = {
      start: r.start ?? null,
      end: r.end,
      val: r.val,
      fy: Number.isFinite(r.fy) ? r.fy : null,
      fp,
      form: r.form,
      filed: r.filed ?? null,
      unit,
    };
    const key = `${p.end}|${fp}`;
    const held = best.get(key);
    if (!held || better(p, held)) best.set(key, p);
  }
  return [...best.values()]
    .sort((a, b) => {
      if (a.end !== b.end) return a.end < b.end ? -1 : 1;
      return (a.fp === 'FY' ? 1 : 0) - (b.fp === 'FY' ? 1 : 0);
    })
    .slice(-POINTS_KEPT);
}

/** The newest point among these concepts, the first named winning a tie on date. */
function pick(concepts, ...names) {
  let best = null;
  for (const n of names) {
    const p = concepts[n]?.at(-1);
    if (p && (!best || p.end > best.end)) best = p;
  }
  return best;
}

/**
 * The headline figures: each concept's most recent reported point, which may
 * be a quarter or a year (`fp` says which, per point in `concepts`).
 * `period`, `form` and `filed` describe the newest of them.
 */
export function latestFrom(concepts) {
  const picked = {
    revenue: pick(
      concepts,
      'RevenueFromContractWithCustomerExcludingAssessedTax',
      'Revenues',
      'SalesRevenueNet',
    ),
    grossProfit: pick(concepts, 'GrossProfit'),
    operatingIncome: pick(concepts, 'OperatingIncomeLoss'),
    netIncome: pick(concepts, 'NetIncomeLoss'),
    epsDiluted: pick(concepts, 'EarningsPerShareDiluted'),
    epsBasic: pick(concepts, 'EarningsPerShareBasic'),
    assets: pick(concepts, 'Assets'),
    liabilities: pick(concepts, 'Liabilities'),
    equity: pick(concepts, 'StockholdersEquity'),
    cash: pick(concepts, 'CashAndCashEquivalentsAtCarryingValue'),
    operatingCashFlow: pick(concepts, 'NetCashProvidedByUsedInOperatingActivities'),
    sharesOutstanding: pick(
      concepts,
      'EntityCommonStockSharesOutstanding',
      'CommonStockSharesOutstanding',
    ),
    publicFloat: pick(concepts, 'EntityPublicFloat'),
  };
  const latest = Object.fromEntries(Object.entries(picked).map(([k, p]) => [k, p?.val ?? null]));
  const ltd = pick(concepts, 'LongTermDebt');
  if (ltd) latest.longTermDebt = ltd.val;
  else {
    const nc = concepts.LongTermDebtNoncurrent?.at(-1);
    const cur = concepts.LongTermDebtCurrent?.at(-1);
    latest.longTermDebt = nc || cur ? (nc?.val ?? 0) + (cur?.val ?? 0) : null;
  }
  let anchor = null;
  for (const p of Object.values(picked)) {
    if (!p) continue;
    if (!anchor || p.end > anchor.end || (p.end === anchor.end && p.filed > anchor.filed))
      anchor = p;
  }
  latest.period = anchor?.end ?? null;
  latest.fp = anchor?.fp ?? null;
  latest.fy = anchor?.fy ?? null;
  latest.form = anchor?.form ?? null;
  latest.filed = anchor?.filed ?? null;
  return latest;
}

/** $383.3B, $-1.2M, $950K: a figure as a headline says it. */
export function money(n) {
  if (!Number.isFinite(n)) return null;
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const [div, suffix] =
    abs >= 1e12
      ? [1e12, 'T']
      : abs >= 1e9
        ? [1e9, 'B']
        : abs >= 1e6
          ? [1e6, 'M']
          : abs >= 1e3
            ? [1e3, 'K']
            : [1, ''];
  const v = abs / div;
  return `$${sign}${v.toFixed(div === 1 ? 0 : 1)}${suffix}`;
}

/**
 * The SEC's ticker list, either shape: `company_tickers.json` (an object keyed
 * by row number) or `company_tickers_exchange.json` (`fields` + `data`, which
 * also carries the exchange). One entry a company, its tickers together, the
 * first listed as the symbol, sorted by CIK so a walk can resume after one.
 */
export function parseCompanyList(body) {
  const rows = [];
  if (Array.isArray(body?.fields) && Array.isArray(body?.data)) {
    const at = Object.fromEntries(body.fields.map((f, i) => [String(f).toLowerCase(), i]));
    for (const r of body.data) {
      if (!Array.isArray(r)) continue;
      rows.push({
        cik: r[at.cik],
        name: r[at.name],
        ticker: r[at.ticker],
        exchange: at.exchange === undefined ? null : r[at.exchange],
      });
    }
  } else if (body && typeof body === 'object') {
    for (const r of Object.values(body)) {
      if (r && typeof r === 'object') {
        rows.push({ cik: r.cik_str, name: r.title, ticker: r.ticker, exchange: null });
      }
    }
  }
  const byCik = new Map();
  for (const r of rows) {
    const cik = Number(r.cik);
    const ticker = String(r.ticker ?? '')
      .trim()
      .toUpperCase();
    if (!Number.isInteger(cik) || cik <= 0 || !ticker) continue;
    const held = byCik.get(cik);
    if (held) {
      if (!held.symbols.includes(ticker)) held.symbols.push(ticker);
      held.exchange ??= r.exchange || null;
      continue;
    }
    byCik.set(cik, {
      cik: String(cik),
      symbol: ticker,
      symbols: [ticker],
      name: String(r.name ?? '').trim() || ticker,
      exchange: r.exchange || null,
    });
  }
  return [...byCik.values()].sort((a, b) => Number(a.cik) - Number(b.cik));
}

export function factsToItem(company, body) {
  const concepts = {};
  let newestFiled = null;
  for (const [taxonomy, names] of Object.entries(CONCEPTS)) {
    for (const n of names) {
      const pts = conceptPoints(body?.facts?.[taxonomy]?.[n]);
      if (pts.length === 0) continue;
      concepts[n] = pts;
      for (const p of pts)
        if (p.filed && (!newestFiled || p.filed > newestFiled)) newestFiled = p.filed;
    }
  }
  if (Object.keys(concepts).length === 0) return null;
  const latest = latestFrom(concepts);
  const cik = String(Number(company.cik));
  const symbol = String(company.symbol).toUpperCase();
  const name = String(body?.entityName ?? company.name ?? symbol).trim();
  const headline = [
    latest.revenue !== null ? `revenue ${money(latest.revenue)}` : null,
    latest.netIncome !== null ? `net income ${money(latest.netIncome)}` : null,
    latest.epsDiluted !== null ? `diluted EPS ${latest.epsDiluted}` : null,
  ].filter(Boolean);
  const when = latest.period
    ? ` (${latest.fp ?? ''} to ${latest.period}, ${latest.form ?? 'report'} filed ${latest.filed ?? '?'})`
    : '';
  const [y, m, d] = (newestFiled ?? '').split('-').map(Number);
  return {
    externalId: `sec:facts:${cik}`,
    kind: 'fundamentals',
    title: `${name} (${symbol}) fundamentals`,
    summary: headline.length ? `${headline.join(', ')}${when}` : null,
    url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik10(cik)}`,
    publishedAt: newestFiled && y && m && d ? dateOnly(y, m, d) : null,
    timeKnown: false,
    precision: 'day',
    tags: [
      'fundamentals',
      ...(company.symbols ?? [symbol]).map((s) => `symbol:${String(s).toLowerCase()}`),
      `cik:${cik}`,
      company.exchange ? `exchange:${exchangeSlug(company.exchange)}` : null,
    ].filter(Boolean),
    data: {
      cik,
      symbol,
      symbols: company.symbols ?? [symbol],
      name,
      exchange: company.exchange ?? null,
      concepts,
      latest,
    },
  };
}

/**
 * The SEC's refusals, named. A 403 is the rate threshold unless it says
 * otherwise, and "rate limit" in the message is what the scheduler keys on.
 */
export function secError(status, text = '', url = '') {
  const where = url ? ` from ${String(url).slice(0, 120)}` : '';
  if (status === 403 && /undeclared automated tool/i.test(text)) {
    return new Error(`SEC 403${where}: the User-Agent is not declared; set CONTACT_EMAIL`);
  }
  if (status === 403) {
    return new Error(`SEC rate limit (403 Request Rate Threshold Exceeded)${where}`);
  }
  if (status === 429) return new Error(`SEC rate limit (429)${where}`);
  return new Error(`${status}${where}`);
}

/** Monday of the week, as a stamp for "walked this week". */
export function weekStamp(now = Date.now()) {
  const d = new Date(now);
  const dow = (d.getUTCDay() + 6) % 7;
  return isoDay(d.getTime() - dow * DAY_MS);
}

export const secFundamentals = defineAdapter({
  name: 'sec-fundamentals',
  title: 'SEC XBRL fundamentals',
  collection: 'markets',
  description:
    "Every listed company's XBRL company facts from the SEC, one item a company: revenue, net income, EPS, assets, liabilities, equity, cash, operating cash flow, shares and debt, the last twelve reported periods each plus the headline figures. The whole ticker list is walked once a week, a few hundred companies a run, never faster than five requests a second. Keyless, but the SEC requires CONTACT_EMAIL so every request says who is asking.",
  docs: 'https://www.sec.gov/search-filings/edgar-application-programming-interfaces',
  kinds: ['fundamentals'],
  cadenceMinutes: 60,
  needsEnv: ['contactEmail'],
  configFields: [
    {
      key: 'perRun',
      label: 'Companies per run',
      type: 'number',
      placeholder: '300',
      help: 'About ten thousand companies in all; three hundred an hour walks them in a day and a half, then the source idles until the next week.',
    },
  ],
  defaults: { perRun: 300 },
  defaultSources: [{ slug: 'sec-fundamentals', name: 'Markets: SEC fundamentals' }],
  async pull(ctx) {
    const { config, cursor: prev, env, http, log, deadline } = ctx;
    if (!env.contactEmail) {
      throw new Error('SEC requires CONTACT_EMAIL: every client must say who it is');
    }
    const headers = {
      'user-agent': `${SEC_SITE} (${env.contactEmail})`,
      accept: 'application/json',
    };
    const perRun = clamp(config.perRun, 1, 5000, 300);
    const now = ctx.now ?? Date.now();
    const stopAt = deadline - DEADLINE_MARGIN_MS;
    const pace = pacer(ctx.paceMs ?? SEC_PACE_MS);
    const week = weekStamp(now);
    const cursor = { ...prev };
    if (cursor.week !== week) {
      cursor.week = week;
      cursor.after = null;
    }
    if (cursor.doneWeek === week) {
      return { items: [], cursor, note: `walked the list in the week of ${week}; idle until next` };
    }

    let requests = 0;
    async function get(url) {
      await pace();
      requests += 1;
      const res = await http.request(url, { headers, timeoutMs: 60_000 });
      if (res.status === 404) return null;
      if (!res.ok) throw secError(res.status, await res.text().catch(() => ''), url);
      return res.json();
    }

    // The list every run rather than in the cursor: a resume point by CIK
    // survives the list changing under it, and the cursor stays a few bytes.
    const list = parseCompanyList(await get(`${SEC_FILES}/company_tickers_exchange.json`));
    if (list.length === 0) throw new Error('SEC company list came back empty');
    const after = Number(cursor.after) || 0;
    const todo = list.filter((c) => Number(c.cik) > after).slice(0, perRun);

    const items = [];
    let missing = 0;
    let empty = 0;
    let last = after;
    for (const c of todo) {
      if (Date.now() >= stopAt) break;
      const body = await get(`${SEC_XBRL}/CIK${cik10(c.cik)}.json`);
      last = Number(c.cik);
      if (!body) {
        missing += 1;
        continue;
      }
      const item = factsToItem(c, body);
      if (item) items.push(item);
      else empty += 1;
    }

    const done = last >= Number(list.at(-1).cik);
    cursor.after = done ? null : String(last);
    if (done) cursor.doneWeek = week;
    const note = `${items.length} companies with facts, ${missing} without a facts file, ${empty} with none of the concepts; ${requests} request(s); ${done ? 'walk complete for the week' : `resuming after CIK ${last} (${list.filter((c) => Number(c.cik) > last).length} to go)`}`;
    log(note);
    return { items, cursor, note };
  },
});
