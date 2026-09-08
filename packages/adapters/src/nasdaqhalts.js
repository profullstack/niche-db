import { defineAdapter, first, xmlItems } from '@nichedb/core/adapter';

/**
 * US trading halts, as they are declared.
 *
 * When a stock is halted the exchange says so immediately and in public,
 * because everybody trading it needs to know at the same moment. Nasdaq
 * publishes the whole cross-market halt list as a feed with the fields already
 * separated out, which makes this the most genuinely real-time thing in the
 * collection and the one row here that is worth a push notification.
 *
 * The reason code is the entire story and it is published as two characters.
 * `LUDP` is the ordinary volatility pause that happens to a hundred small caps
 * a week; `T12` means the SEC has suspended trading and the company is in
 * serious trouble; `T1` means news is pending and the stock will reopen when
 * it is out. A feed that showed `T12` and `LUDP` identically would be useless,
 * so the codes are spelled out and the serious ones are tagged.
 *
 * Halts are US-only, like everything else on this side of the collection.
 * Other exchanges publish their own suspensions and none of them agree on a
 * format; the world's venues are covered as a register in `mic.js`.
 */

/**
 * Nasdaq's halt reason codes.
 *
 * The list is stable and short, and the difference between a pause and a
 * regulatory suspension is the whole value of the feed.
 */
const REASONS = {
  T1: 'news pending',
  T2: 'news released',
  T5: 'single-stock trading pause: 10% price move',
  T6: 'extraordinary market activity',
  T7: 'single-stock trading pause: quote-only period',
  T8: 'exchange-traded fund halt',
  T12: 'SEC trading suspension: additional information requested',
  H4: 'non-compliance with listing requirements',
  H9: 'not current in regulatory filings',
  H10: 'SEC trading suspension',
  H11: 'regulatory concern',
  O1: 'operational halt: not quoted or traded on this venue',
  IPO1: 'IPO not yet trading',
  M1: 'corporate action',
  M2: 'no longer assigned to this venue',
  LUDP: 'volatility trading pause',
  LUDS: 'volatility trading pause: straddle state',
  MWC1: 'market-wide circuit breaker, level 1',
  MWC2: 'market-wide circuit breaker, level 2',
  MWC3: 'market-wide circuit breaker, level 3',
  MWC0: 'market-wide circuit breaker halt',
  D: 'security deletion',
};

/** The codes that mean a regulator or the listing rules, not ordinary volatility. */
const REGULATORY = new Set(['T12', 'H4', 'H9', 'H10', 'H11', 'D']);
/** The codes that halt the entire market rather than one stock. */
const MARKET_WIDE = new Set(['MWC0', 'MWC1', 'MWC2', 'MWC3']);

/** Nasdaq writes MM/DD/YYYY and a separate HH:MM:SS, in US Eastern time. */
export function haltTime(date, time) {
  const d = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(date ?? '').trim());
  if (!d) return null;
  const day = `${d[3]}-${d[1]}-${d[2]}`;
  const t = /^(\d{2}):(\d{2}):(\d{2})/.exec(String(time ?? '').trim());
  if (!t) return day;
  // Eastern time, which is UTC-4 in the summer and UTC-5 in the winter. The
  // feed does not say which, and getting it wrong by an hour on a halt is
  // worse than saying so: the exact instant is carried unparsed in `data`.
  return `${day}T${t[1]}:${t[2]}:${t[3]}`;
}

export function toItem(it) {
  // Nasdaq writes its element names in CamelCase (`<ndaq:IssueSymbol>`), and
  // the XML reader keeps tag names exactly as they appear. Looking them up in
  // lower case therefore finds nothing at all and every field comes back null,
  // which is quiet rather than loud: the item still builds, with the symbol
  // falling back to the title and the reason gone. Matched case-insensitively
  // so a future capitalisation change is not another silent hollowing-out.
  const byLower = new Map(Object.keys(it).map((k) => [k.toLowerCase(), k]));
  const text = (f) => {
    const key = byLower.get(f.toLowerCase());
    return key ? first(it[key])?.text?.trim() || null : null;
  };
  const symbol = text('ndaq:issuesymbol') ?? text('title');
  if (!symbol) return null;
  const code = (text('ndaq:reasoncode') ?? '').toUpperCase();
  const reason = REASONS[code] ?? (code ? `reason code ${code}` : 'an unstated reason');
  const name = text('ndaq:issuename');
  const market = text('ndaq:market');
  const haltDate = text('ndaq:haltdate');
  const resumeDate = text('ndaq:resumptiondate');
  const resumeTrade = text('ndaq:resumptiontradetime');
  const resumed = Boolean(resumeDate && resumeTrade);

  return {
    // Symbol plus the halt instant: the same stock halted twice in a day is
    // two events, and a resumption filled in later is the same one updated.
    externalId: `halt-${symbol}-${haltDate ?? ''}-${text('ndaq:halttime') ?? ''}`,
    kind: 'halt',
    title: `${symbol} halted: ${reason}${resumed ? ' (resumed)' : ''}`,
    summary: [
      `${name ? `${name} (${symbol})` : symbol} was halted`,
      market ? `on ${market}` : null,
      haltDate ? `on ${haltDate}` : null,
      text('ndaq:halttime') ? `at ${text('ndaq:halttime')} ET` : null,
      `for ${reason}`,
      resumed
        ? `and resumed trading on ${resumeDate} at ${resumeTrade} ET`
        : '. No resumption time has been published yet',
    ]
      .filter(Boolean)
      .join(' ')
      .replace(' .', '.')
      .concat(resumed ? '.' : ''),
    url: 'https://www.nasdaqtrader.com/trader.aspx?id=TradeHalts',
    publishedAt: haltTime(haltDate, text('ndaq:halttime')) ?? first(it.pubdate)?.text ?? null,
    tags: [
      'halt',
      symbol.toLowerCase(),
      code ? code.toLowerCase() : null,
      market ? market.toLowerCase().replace(/\s+/g, '-') : null,
      resumed ? 'resumed' : 'open-halt',
      REGULATORY.has(code) ? 'regulatory' : null,
      MARKET_WIDE.has(code) ? 'market-wide' : null,
      code === 'IPO1' ? 'ipo' : null,
      code === 'LUDP' || code === 'LUDS' ? 'volatility-pause' : null,
    ].filter(Boolean),
    data: {
      symbol,
      issueName: name,
      market,
      reasonCode: code,
      reason,
      regulatory: REGULATORY.has(code),
      marketWide: MARKET_WIDE.has(code),
      // Carried as published: Eastern time, without a zone offset we would
      // have to guess at.
      haltDate,
      haltTimeEt: text('ndaq:halttime'),
      pauseThresholdPrice: text('ndaq:pausethresholdprice'),
      resumptionDate: resumeDate,
      resumptionQuoteTimeEt: text('ndaq:resumptionquotetime'),
      resumptionTradeTimeEt: resumeTrade,
      resumed,
      market_scope: 'US',
    },
  };
}

export const nasdaqHalts = defineAdapter({
  name: 'nasdaq-halts',
  title: 'US trading halts',
  collection: 'markets',
  description:
    'Every US trading halt as it is declared, across Nasdaq, NYSE and the other US venues, with the reason code spelled out and the resumption time when it is published. Tells a routine volatility pause apart from an SEC trading suspension. Keyless.',
  docs: 'https://www.nasdaqtrader.com/trader.aspx?id=TradeHalts',
  kinds: ['halt'],
  // The most time-sensitive row in the collection: a halt matters in the
  // minutes it is happening, not in the hour afterwards.
  cadenceMinutes: 5,
  configFields: [
    {
      key: 'regulatoryOnly',
      label: 'Regulatory halts only',
      type: 'select',
      options: ['', 'yes'],
      help: 'Exclude the ordinary volatility pauses and keep SEC suspensions and listing-rule halts.',
    },
  ],
  defaults: {},
  defaultSources: [
    { slug: 'trading-halts', name: 'US trading halts' },
    {
      slug: 'regulatory-halts',
      name: 'SEC suspensions and listing-rule halts',
      config: { regulatoryOnly: 'yes' },
      cadenceMinutes: 30,
    },
  ],
  async pull({ config, http, log }) {
    const xml = await http.text('https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts', {
      headers: { accept: 'application/rss+xml, text/xml, */*' },
      timeoutMs: 30_000,
    });
    let items = xmlItems(xml, 'item').map(toItem).filter(Boolean);
    if (config.regulatoryOnly === 'yes') items = items.filter((i) => i.data.regulatory);
    log(`${items.length} halt(s)`);
    return { items, note: `${items.length} halts` };
  },
});
