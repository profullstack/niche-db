import { defineAdapter, slugify } from '@nichedb/core/adapter';

/**
 * Alpaca: US equities and crypto, and only those.
 *
 * Worth stating plainly at the top of the file because the name suggests more.
 * Alpaca lists about 14,300 active assets and every one of them is American —
 * NASDAQ, NYSE, ARCA, BATS, AMEX and OTC — plus roughly seventy crypto pairs.
 * There is no London, no Tokyo, no Frankfurt. For the rest of the world's
 * exchanges see `mic.js`, which carries the register of every venue on earth
 * but no prices, because the register is public and the prices are not.
 *
 * What Alpaca is unusually good at is the part that suits a feed. A price is a
 * number that is already stale by the time anyone reads it in an RSS reader,
 * and this site is not a quote screen. A corporate action is the opposite: a
 * dated, discrete, consequential event that a person genuinely wants delivered
 * — a dividend declared, a stock split, a merger closing, a company changing
 * its name, a listing removed as worthless. Those are what these adapters take.
 *
 * Two adapters here, sharing the credentials:
 *
 *   alpaca-corporate-actions  dividends, splits, mergers, spin-offs, renames
 *   alpaca-news               market news wire, symbol-tagged
 */

const DATA = 'https://data.alpaca.markets';

function auth(env) {
  if (!env.alpacaKeyId || !env.alpacaSecretKey) {
    throw new Error('Alpaca needs APCA_API_KEY_ID and APCA_API_SECRET_KEY');
  }
  return {
    'APCA-API-KEY-ID': env.alpacaKeyId,
    'APCA-API-SECRET-KEY': env.alpacaSecretKey,
  };
}

/** YYYY-MM-DD, n days either side of today. */
export function isoDay(date) {
  return new Date(date).toISOString().slice(0, 10);
}

export function daysAgo(n, now = new Date()) {
  return isoDay(new Date(now.getTime() - n * 86_400_000));
}

/* ------------------------------------------------------ corporate actions -- */

/**
 * The action types Alpaca returns, and how each one reads in a sentence.
 *
 * The API groups its answer by type, and each group has a different shape:
 * a dividend has a rate and three dates, a split has an old and new rate, a
 * merger has an acquirer. Rather than a switch buried in the mapper, each type
 * declares its own headline and the fields worth keeping.
 */
const ACTIONS = {
  cash_dividend: {
    group: 'cash_dividends',
    kind: 'dividend',
    label: 'cash dividend',
    date: (a) => a.ex_date ?? a.payable_date ?? a.record_date,
    title: (a) =>
      `${a.symbol}: ${money(a.rate)} ${a.special ? 'special ' : ''}cash dividend${a.frequency ? `, ${frequency(a.frequency)}` : ''}`,
    summary: (a) =>
      [
        `${a.symbol} goes ex-dividend on ${a.ex_date}`,
        a.rate ? `at ${money(a.rate)} a share` : null,
        a.record_date ? `to holders of record on ${a.record_date}` : null,
        a.payable_date ? `payable ${a.payable_date}` : null,
      ]
        .filter(Boolean)
        .join(', '),
    tags: (a) => [a.special ? 'special-dividend' : null, a.foreign ? 'foreign' : null],
  },
  stock_dividend: {
    group: 'stock_dividends',
    kind: 'dividend',
    label: 'stock dividend',
    date: (a) => a.ex_date ?? a.payable_date,
    title: (a) => `${a.symbol}: stock dividend of ${a.rate} a share`,
    summary: (a) => `${a.symbol} pays a stock dividend of ${a.rate} a share, ex ${a.ex_date}.`,
  },
  forward_split: {
    group: 'forward_splits',
    kind: 'split',
    label: 'forward split',
    date: (a) => a.ex_date ?? a.payable_date,
    title: (a) => `${a.symbol}: ${ratio(a.new_rate, a.old_rate)} forward split`,
    summary: (a) =>
      `${a.symbol} splits ${ratio(a.new_rate, a.old_rate)} with an ex date of ${a.ex_date}.`,
    tags: () => ['forward-split'],
  },
  reverse_split: {
    group: 'reverse_splits',
    kind: 'split',
    label: 'reverse split',
    date: (a) => a.ex_date ?? a.payable_date,
    title: (a) => `${a.symbol}: ${ratio(a.new_rate, a.old_rate)} reverse split`,
    summary: (a) =>
      `${a.symbol} consolidates ${ratio(a.old_rate, a.new_rate)} into one, ex ${a.ex_date}. A reverse split usually follows a long fall in the share price, and often precedes a delisting notice.`,
    tags: () => ['reverse-split'],
  },
  unit_split: {
    group: 'unit_splits',
    kind: 'split',
    label: 'unit split',
    date: (a) => a.effective_date ?? a.payable_date,
    title: (a) => `${a.new_symbol ?? a.old_symbol}: unit split`,
    summary: (a) => `${a.old_symbol} splits into its constituent units.`,
  },
  cash_merger: {
    group: 'cash_mergers',
    kind: 'merger',
    label: 'cash merger',
    date: (a) => a.effective_date ?? a.payable_date,
    title: (a) => `${a.acquirer_symbol ?? 'An acquirer'} acquires ${a.acquiree_symbol} for cash`,
    summary: (a) =>
      `${a.acquiree_symbol} is acquired for ${money(a.rate)} a share in cash, effective ${a.effective_date}.`,
    tags: () => ['acquisition'],
  },
  stock_merger: {
    group: 'stock_mergers',
    kind: 'merger',
    label: 'stock merger',
    date: (a) => a.effective_date ?? a.payable_date,
    title: (a) => `${a.acquirer_symbol ?? 'An acquirer'} acquires ${a.acquiree_symbol} for stock`,
    summary: (a) =>
      `${a.acquiree_symbol} holders receive ${a.acquirer_rate} of ${a.acquirer_symbol} for every ${a.acquiree_rate} held, effective ${a.effective_date}.`,
    tags: () => ['acquisition'],
  },
  stock_and_cash_merger: {
    group: 'stock_and_cash_mergers',
    kind: 'merger',
    label: 'cash and stock merger',
    date: (a) => a.effective_date ?? a.payable_date,
    title: (a) => `${a.acquirer_symbol ?? 'An acquirer'} acquires ${a.acquiree_symbol}`,
    summary: (a) =>
      `${a.acquiree_symbol} holders receive cash and stock in ${a.acquirer_symbol}, effective ${a.effective_date}.`,
    tags: () => ['acquisition'],
  },
  spin_off: {
    group: 'spin_offs',
    kind: 'spin-off',
    label: 'spin-off',
    date: (a) => a.ex_date ?? a.payable_date,
    title: (a) => `${a.source_symbol} spins off ${a.new_symbol}`,
    summary: (a) =>
      `${a.source_symbol} distributes ${a.new_rate} of ${a.new_symbol} for every ${a.source_rate} held, ex ${a.ex_date}.`,
  },
  name_change: {
    group: 'name_changes',
    kind: 'name-change',
    label: 'name change',
    date: (a) => a.process_date,
    title: (a) => `${a.old_symbol} is now ${a.new_symbol}`,
    summary: (a) => `${a.old_symbol} changed its ticker to ${a.new_symbol} on ${a.process_date}.`,
  },
  redemption: {
    group: 'redemptions',
    kind: 'redemption',
    label: 'redemption',
    date: (a) => a.payable_date ?? a.process_date,
    title: (a) => `${a.symbol}: redeemed at ${money(a.rate)}`,
    summary: (a) => `${a.symbol} is redeemed at ${money(a.rate)} a share.`,
  },
  worthless_removal: {
    group: 'worthless_removals',
    kind: 'delisting',
    label: 'worthless removal',
    date: (a) => a.process_date,
    title: (a) => `${a.symbol}: removed as worthless`,
    summary: (a) =>
      `${a.symbol} was removed from customer accounts as worthless on ${a.process_date}. This is the end of the line for a listing, not a suspension.`,
    tags: () => ['delisting'],
  },
  rights_distribution: {
    group: 'rights_distributions',
    kind: 'rights',
    label: 'rights distribution',
    date: (a) => a.ex_date ?? a.payable_date,
    title: (a) => `${a.source_symbol}: rights distribution`,
    summary: (a) =>
      `${a.source_symbol} distributes ${a.new_rate} rights (${a.new_symbol}) for every ${a.source_rate} held, ex ${a.ex_date}.`,
  },
  capital_gains_distribution: {
    group: 'capital_gains_distributions',
    kind: 'distribution',
    label: 'capital gains distribution',
    date: (a) => a.ex_date ?? a.payable_date,
    // Not `rate`: this type splits its payment into long- and short-term,
    // because the two are taxed differently and the fund has to say which is
    // which. Adding them is the number a holder receives.
    title: (a) => `${a.symbol}: ${money(cgTotal(a))} capital gains distribution`,
    summary: (a) =>
      `${a.symbol} distributes ${money(cgTotal(a))} a share in capital gains, ex ${a.ex_date}: ${money(a.long_term_rate)} long-term and ${money(a.short_term_rate)} short-term.`,
  },
  partial_call: {
    group: 'partial_calls',
    kind: 'redemption',
    label: 'partial call',
    date: (a) => a.process_date ?? a.payable_date,
    // A partial call is settled by lottery among holders, which is why the
    // record carries a lottery date rather than a rate.
    title: (a) => `${a.symbol}: partially called at ${money(a.price)}`,
    summary: (a) =>
      `${a.symbol} was partially called at ${money(a.price)} a share, payable ${a.payable_date}. Holders are selected by lottery${a.lottery_date ? ` drawn ${a.lottery_date}` : ''}.`,
  },
  reorganization: {
    group: 'reorganizations',
    kind: 'reorganization',
    label: 'reorganization',
    date: (a) => a.process_date ?? a.effective_date ?? a.payable_date,
    title: (a) => `${a.symbol ?? a.source_symbol}: reorganization`,
    summary: (a) =>
      `${a.symbol ?? a.source_symbol} was reorganized, effective ${a.effective_date ?? a.process_date}${a.cash_rate ? `, paying ${money(a.cash_rate)} a share` : ''}.`,
  },
  contract_adjustment: {
    group: 'contract_adjustments',
    kind: 'contract-adjustment',
    label: 'contract adjustment',
    date: (a) => a.process_date ?? a.effective_date,
    title: (a) => `${a.symbol ?? a.source_symbol}: option contract adjustment`,
    summary: (a) =>
      `Option contracts on ${a.symbol ?? a.source_symbol} were adjusted, effective ${a.effective_date ?? a.process_date}.`,
  },
};

/**
 * The API asks for singular type names and answers with plural group keys.
 *
 * `types=cash_dividend` is accepted and `types=cash_dividends` is a 400, but
 * the reply arrives under `corporate_actions.cash_dividends`. The two names
 * are therefore both needed and neither can be derived from the other by
 * adding an "s" (`capital_gains_distribution` would become
 * `capital_gains_distributions`, which is right, but guessing is what put a
 * 400 in the run log in the first place), so each type declares its group.
 */
export const GROUP_TO_TYPE = Object.fromEntries(
  Object.entries(ACTIONS).map(([type, spec]) => [spec.group, type]),
);

export const ACTION_TYPES = Object.keys(ACTIONS);

/** Long-term plus short-term: what a holder actually receives. */
const cgTotal = (a) => {
  const l = Number(a.long_term_rate) || 0;
  const sh = Number(a.short_term_rate) || 0;
  return l + sh || null;
};

const money = (r) => {
  const n = Number(r);
  return Number.isFinite(n)
    ? `$${n
        .toFixed(n < 1 ? 4 : 2)
        .replace(/0+$/, '')
        .replace(/\.$/, '')}`
    : 'an undisclosed amount';
};

/** "4-for-1", the way a split is actually said. */
const ratio = (a, b) => {
  const x = Number(a);
  const y = Number(b);
  return Number.isFinite(x) && Number.isFinite(y) ? `${trim(x)}-for-${trim(y)}` : 'a';
};
const trim = (n) => String(Number(n.toFixed(4)));

const frequency = (f) =>
  ({ 1: 'annual', 2: 'semi-annual', 4: 'quarterly', 12: 'monthly' })[Number(f)] ??
  `${f} times a year`;

/** Every symbol an action touches, for tagging and for the payload. */
function symbolsOf(a) {
  return [
    ...new Set(
      [a.symbol, a.old_symbol, a.new_symbol, a.source_symbol, a.acquirer_symbol, a.acquiree_symbol]
        .filter(Boolean)
        .map((s) => String(s).toUpperCase()),
    ),
  ];
}

export function actionToItem(type, a) {
  const spec = ACTIONS[type];
  if (!spec) return null;
  const when = spec.date(a);
  const symbols = symbolsOf(a);
  if (!symbols.length) return null;
  return {
    // Alpaca gives each action a uuid, which is the right key: an action whose
    // dates are revised keeps its identity rather than arriving twice.
    externalId: a.id ? `alpaca-${a.id}` : `alpaca-${type}-${symbols[0]}-${when}`,
    kind: spec.kind,
    title: spec.title(a),
    summary: spec.summary(a),
    // Alpaca has no public page per action, so the link goes to the company's
    // SEC filings, which is where the primary document actually is.
    url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=${encodeURIComponent(symbols[0])}&type=8-K&dateb=&owner=include&count=40`,
    publishedAt: when,
    timeKnown: false,
    precision: 'day',
    tags: [
      'corporate-action',
      slugify(spec.label),
      spec.kind,
      ...symbols.map((s) => s.toLowerCase()),
      ...(spec.tags?.(a) ?? []).filter(Boolean),
    ].filter(Boolean),
    data: {
      actionId: a.id ?? null,
      type,
      actionLabel: spec.label,
      symbols,
      // The upstream record as given. Each type has different fields and the
      // useful one is always the field that was projected out.
      action: a,
      market: 'US',
      source: 'Alpaca corporate actions',
    },
  };
}

export const alpacaCorporateActions = defineAdapter({
  name: 'alpaca-corporate-actions',
  title: 'US corporate actions (Alpaca)',
  collection: 'markets',
  description:
    'Dividends, stock splits, reverse splits, mergers, spin-offs, rights, redemptions, ticker changes and worthless removals for US-listed equities, from Alpaca. One row per action with its ex, record, payable and effective dates. US listings only: Alpaca carries no non-US exchange.',
  docs: 'https://docs.alpaca.markets/reference/corporateactions-1',
  kinds: [
    'dividend',
    'split',
    'merger',
    'spin-off',
    'name-change',
    'redemption',
    'delisting',
    'rights',
    'distribution',
    'reorganization',
    'contract-adjustment',
  ],
  cadenceMinutes: 60 * 6,
  needsEnv: ['alpacaKeyId', 'alpacaSecretKey'],
  configFields: [
    {
      key: 'types',
      label: 'Action types',
      type: 'list',
      help: `Empty for all of: ${ACTION_TYPES.join(', ')}`,
    },
    {
      key: 'lookbackDays',
      label: 'Days back',
      type: 'number',
      placeholder: '30',
      help: 'Corporate actions are announced ahead and revised, so a window rather than a cursor.',
    },
    {
      key: 'aheadDays',
      label: 'Days ahead',
      type: 'number',
      placeholder: '30',
      help: 'Dividends and splits are declared before they happen; this is how far forward to look.',
    },
  ],
  defaults: { lookbackDays: 30, aheadDays: 30 },
  defaultSources: [
    { slug: 'us-corporate-actions', name: 'US corporate actions: everything' },
    {
      slug: 'us-dividends',
      name: 'US dividends declared',
      config: { types: ['cash_dividends', 'stock_dividends'] },
    },
    {
      slug: 'us-splits-and-mergers',
      name: 'US splits, mergers and spin-offs',
      config: {
        types: ['forward_splits', 'reverse_splits', 'cash_mergers', 'stock_mergers', 'spin_offs'],
      },
    },
  ],
  async pull({ config, env, http, log }) {
    const types = (Array.isArray(config.types) ? config.types : [])
      .map((t) => String(t).trim())
      .filter((t) => ACTION_TYPES.includes(t));
    const wanted = types.length ? types : ACTION_TYPES;

    const now = new Date();
    const start = daysAgo(Number(config.lookbackDays) || 30, now);
    const end = daysAgo(-(Number(config.aheadDays) || 30), now);

    const items = [];
    let pageToken = null;
    let pages = 0;
    do {
      const params = new URLSearchParams({
        types: wanted.join(','),
        start,
        end,
        limit: '1000',
      });
      if (pageToken) params.set('page_token', pageToken);
      const res = await http.json(`${DATA}/v1/corporate-actions?${params}`, {
        headers: auth(env),
        timeoutMs: 45_000,
      });
      for (const [group, rows] of Object.entries(res?.corporate_actions ?? {})) {
        // Keyed back from the plural group the response used to the singular
        // type the table is written in. An unknown group is skipped rather
        // than guessed at: Alpaca adds types, and a row we cannot describe
        // properly is worse than a row we did not publish.
        const type = GROUP_TO_TYPE[group];
        if (!type) {
          log(`unknown corporate action group from Alpaca: ${group}`);
          continue;
        }
        for (const a of rows ?? []) {
          const item = actionToItem(type, a);
          if (item) items.push(item);
        }
      }
      pageToken = res?.next_page_token ?? null;
      pages++;
      // A window this wide is a few pages at most; the guard is for the day
      // the upstream decides otherwise.
    } while (pageToken && pages < 10);

    log(`${items.length} corporate action(s) between ${start} and ${end}`);
    return { items, note: `${items.length} actions, ${start}..${end}` };
  },
});

/* ------------------------------------------------------------------ news -- */

export function newsToItem(a) {
  const symbols = (a.symbols ?? []).map((s) => String(s).toUpperCase());
  return {
    externalId: `alpaca-news-${a.id}`,
    kind: 'market-news',
    title: a.headline,
    summary:
      String(a.summary || a.content || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 800) || null,
    url: a.url ?? null,
    imageUrl: a.images?.find((i) => i.size === 'large')?.url ?? a.images?.[0]?.url ?? null,
    publishedAt: a.created_at ?? a.updated_at ?? null,
    tags: [
      'market-news',
      a.source ? slugify(a.source) : null,
      ...symbols.map((s) => s.toLowerCase()),
      // Crypto symbols come through the same wire as equities and are worth
      // telling apart, because one of them is the part that is not US-only.
      symbols.some((s) => /USD$/.test(s)) ? 'crypto' : null,
    ].filter(Boolean),
    data: {
      newsId: a.id,
      author: a.author ?? null,
      source: a.source ?? null,
      symbols,
      updatedAt: a.updated_at ?? null,
    },
  };
}

export const alpacaNews = defineAdapter({
  name: 'alpaca-news',
  title: 'Market news (Alpaca)',
  collection: 'markets',
  description:
    'The market news wire Alpaca carries, tagged with the tickers each story is about. Predominantly US equities and crypto. Optionally narrowed to the symbols you name.',
  docs: 'https://docs.alpaca.markets/reference/news-3',
  kinds: ['market-news'],
  cadenceMinutes: 20,
  needsEnv: ['alpacaKeyId', 'alpacaSecretKey'],
  configFields: [
    {
      key: 'symbols',
      label: 'Symbols',
      type: 'list',
      placeholder: 'AAPL, TSLA',
      help: 'Empty for the whole wire.',
    },
  ],
  defaults: {},
  defaultSources: [{ slug: 'market-news', name: 'Market news' }],
  async pull({ config, cursor, env, http, log }) {
    const params = new URLSearchParams({ limit: '50', sort: 'desc' });
    const symbols = (Array.isArray(config.symbols) ? config.symbols : [])
      .map((s) => String(s).trim().toUpperCase())
      .filter(Boolean);
    if (symbols.length) params.set('symbols', symbols.join(','));
    // Resume from the last story seen rather than re-reading the same fifty.
    if (cursor.since) params.set('start', cursor.since);

    const res = await http.json(`${DATA}/v1beta1/news?${params}`, {
      headers: auth(env),
      timeoutMs: 30_000,
    });
    const rows = res?.news ?? [];
    const items = rows.map(newsToItem).filter((i) => i.title);
    const newest = rows
      .map((r) => r.created_at)
      .filter(Boolean)
      .sort()
      .at(-1);

    log(`${items.length} story/stories`);
    return {
      items,
      // One second past the newest, so the boundary story is not re-sent for
      // ever while nothing new is published.
      cursor: newest ? { since: new Date(Date.parse(newest) + 1000).toISOString() } : cursor,
      note: `${items.length} stories`,
    };
  },
});
