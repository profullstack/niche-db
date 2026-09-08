import { defineAdapter } from '@nichedb/core/adapter';

/**
 * The European Central Bank's daily euro reference rates.
 *
 * Around thirty currencies, published once each working day at about 16:00
 * Central European Time, free and keyless and explicitly reusable. They are
 * reference rates rather than tradeable ones — the ECB sets them from a
 * concertation between central banks at 14:15 CET and says plainly they are
 * for information rather than for transactions — and the payload repeats that,
 * because a reference rate presented as a dealing rate is a small lie that
 * costs somebody money.
 *
 * This is here because "financial data worldwide" without foreign exchange is
 * a US site with extra steps. The rates span the Americas, Asia and Africa,
 * and they are the one genuinely global price series that is given away.
 *
 * One item per day rather than one per currency. A day's rates are published
 * as a set and read as a set: thirty rows a day, every day, would bury every
 * other feed in the collection, and nobody wants a notification that the
 * Bulgarian lev is where it has been pegged since 1999.
 */

/** The reference currency. Everything is quoted as units of X per one euro. */
const BASE = 'EUR';

/**
 * The ECB publishes attribute-style XML: `<Cube currency='USD' rate='1.1622'/>`
 * nested inside `<Cube time='2026-09-07'>`. Small and fixed enough to read with
 * a pair of expressions rather than a parser.
 */
export function parseRates(xml) {
  const s = String(xml ?? '');
  const days = [];
  // Each dated Cube, with everything up to the next dated Cube.
  const dayRe = /<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]\s*>([\s\S]*?)<\/Cube>/g;
  for (let m = dayRe.exec(s); m; m = dayRe.exec(s)) {
    const date = m[1];
    const rates = {};
    const rateRe = /<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g;
    for (let r = rateRe.exec(m[2]); r; r = rateRe.exec(m[2])) {
      const value = Number(r[2]);
      if (Number.isFinite(value)) rates[r[1]] = value;
    }
    if (Object.keys(rates).length) days.push({ date, rates });
  }
  return days;
}

export function toItem({ date, rates }) {
  const currencies = Object.keys(rates).sort();
  const headline = ['USD', 'GBP', 'JPY', 'CHF']
    .filter((c) => rates[c] !== undefined)
    .map((c) => `${c} ${rates[c]}`)
    .join(', ');
  return {
    externalId: `ecb-eurofxref-${date}`,
    kind: 'fx-rate',
    title: `Euro reference rates, ${date}${headline ? `: ${headline}` : ''}`,
    summary: `The European Central Bank's euro foreign exchange reference rates for ${date}, covering ${currencies.length} currencies. Reference rates set from the daily concertation between central banks at 14:15 CET; they are published for information and are not dealing rates.`,
    url: 'https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html',
    publishedAt: date,
    timeKnown: false,
    precision: 'day',
    tags: [
      'fx',
      'ecb',
      'reference-rate',
      BASE.toLowerCase(),
      ...currencies.map((c) => c.toLowerCase()),
    ],
    data: {
      base: BASE,
      date,
      currencies: currencies.length,
      rates,
      basis: 'reference-rate',
      note: 'ECB euro foreign exchange reference rates. Published for information purposes, not as dealing rates.',
      licence: 'Free to reuse with attribution to the European Central Bank.',
    },
  };
}

export const ecbFxRates = defineAdapter({
  name: 'ecb-fx-rates',
  title: 'Euro FX reference rates (ECB)',
  collection: 'markets',
  description:
    'The European Central Bank’s daily euro foreign exchange reference rates: about thirty currencies across the Americas, Europe, Asia and Africa, one row per working day. Keyless, and free to reuse with attribution.',
  docs: 'https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html',
  kinds: ['fx-rate'],
  // Published once a working day around 16:00 CET. Hourly finds it promptly
  // without pestering a file that changes once in twenty-four hours.
  cadenceMinutes: 60,
  configFields: [
    {
      key: 'history',
      label: 'Include 90 days of history',
      type: 'select',
      options: ['', 'yes'],
      help: 'On first run, backfill the last ninety days instead of only today.',
    },
  ],
  defaults: {},
  defaultSources: [{ slug: 'euro-fx-rates', name: 'Euro foreign exchange reference rates' }],
  async pull({ config, cursor, http, log }) {
    // The ninety-day file is the same shape as the daily one, so a backfill is
    // a different URL and not a different code path. Asked for once: after the
    // first run the cursor says the history is in and the daily file is enough.
    const wantHistory = config.history === 'yes' && !cursor.backfilled;
    const url = wantHistory
      ? 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml'
      : 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';

    const xml = await http.text(url, {
      headers: { accept: 'application/xml, text/xml, */*' },
      timeoutMs: 30_000,
    });
    const days = parseRates(xml);
    if (!days.length) throw new Error('the ECB reference rate file parsed to no days');

    const items = days.map(toItem);
    log(`${items.length} day(s) of rates, newest ${days[0]?.date}`);
    return {
      items,
      cursor: { ...cursor, backfilled: cursor.backfilled || wantHistory },
      note: `${items.length} day(s)`,
    };
  },
});
