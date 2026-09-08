import { defineAdapter } from '@nichedb/core/adapter';

/**
 * The US mortgage rate, weekly since April 1971.
 *
 * Freddie Mac's Primary Mortgage Market Survey is the number quoted whenever
 * anybody says "mortgage rates hit 7%". It is published every Thursday as a
 * plain CSV going back to the second of April 1971, free and keyless, and it
 * is the single most consequential figure in the housing collection: the
 * monthly payment on the same house at 3% and at 7% differs by more than most
 * price movements this collection will ever report.
 *
 * The file is the whole history each week rather than a delta, so the adapter
 * takes a window off the end. The content hash means re-reading the same weeks
 * costs no writes.
 *
 * The columns have a trap in them. `pmms30` is the thirty-year rate and
 * `pmms30p` is the points paid alongside it, which is a fee and not a rate —
 * about 0.6 rather than about 6.5. They sit next to each other, they are both
 * small decimals, and mistaking one for the other is a silent order-of-
 * magnitude error, so the points columns are read as points and never as
 * rates. The 5/1 ARM columns stopped being collected in 2022 and are usually
 * blank, which is not a gap in the data.
 */

const CSV = 'https://www.freddiemac.com/pmms/docs/PMMS_history.csv';

/**
 * The rate series in the file, and what each one is.
 *
 * Keyed by column, because that is what has to be read; the point columns are
 * named beside each rate rather than listed separately, so nothing can pick up
 * a fee thinking it is a rate.
 */
export const SERIES = {
  pmms30: {
    label: '30-year fixed-rate mortgage',
    short: '30-year fixed',
    pointsColumn: 'pmms30p',
    tags: ['30-year', 'fixed'],
  },
  pmms15: {
    label: '15-year fixed-rate mortgage',
    short: '15-year fixed',
    pointsColumn: 'pmms15p',
    tags: ['15-year', 'fixed'],
  },
  pmms51: {
    label: '5/1 adjustable-rate mortgage',
    short: '5/1 ARM',
    pointsColumn: 'pmms51p',
    tags: ['5-1-arm', 'adjustable'],
    // Freddie Mac stopped collecting the ARM series in November 2022, so a
    // blank here is the survey ending rather than a missing week.
    discontinued: '2022-11',
  },
};

export const SERIES_KEYS = Object.keys(SERIES);

/** The file writes dates as M/D/YYYY. */
export function pmmsDate(raw) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(raw ?? '').trim());
  if (!m) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${m[3]}-${p(m[1])}-${p(m[2])}`;
}

/**
 * A number, or nothing.
 *
 * The file leaves discontinued and not-yet-collected cells empty, and an empty
 * cell must not become zero: a mortgage rate of 0% is a headline, and it would
 * be a fabricated one.
 */
export function rate(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** A small, forgiving CSV read: this file has no quoted fields. */
export function parseCsv(text) {
  const lines = String(text ?? '')
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim());
  if (!lines.length) return [];
  const header = lines[0].split(',').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    return Object.fromEntries(header.map((h, i) => [h, (cells[i] ?? '').trim()]));
  });
}

export function toItem(row, column) {
  const spec = SERIES[column];
  const when = pmmsDate(row.date);
  const value = rate(row[column]);
  if (!spec || !when || value === null) return null;
  const points = rate(row[spec.pointsColumn]);

  return {
    externalId: `pmms-${column}-${when}`,
    kind: 'housing-statistic',
    title: `US ${spec.short} mortgage rate, ${when}: ${value}%`,
    summary: `Freddie Mac's weekly survey puts the average ${spec.label.toLowerCase()} at ${value}% for the week of ${when}${points ? `, with ${points} points paid` : ''}. Points are a fee paid up front to lower the rate, not part of the rate.`,
    url: 'https://www.freddiemac.com/pmms',
    publishedAt: when,
    timeKnown: false,
    precision: 'day',
    tags: ['housing', 'us', 'mortgage', 'statistic', ...spec.tags],
    data: {
      // The measure shape the rest of the collection uses.
      measure: {
        name: spec.label,
        value,
        unit: '%',
        period: when,
        area: 'United States',
        areaCode: 'US',
        country: 'US',
      },
      series: column,
      ratePercent: value,
      // A fee in percentage points of the loan, not a rate. Kept in its own
      // field so nothing can read it as one.
      pointsPaid: points,
      basis: 'weekly-survey',
      note: 'The Primary Mortgage Market Survey is an average of rates lenders offer to well-qualified borrowers, surveyed weekly. An individual borrower’s rate depends on credit, deposit and lender.',
      source: 'Freddie Mac Primary Mortgage Market Survey',
    },
  };
}

export const freddieMacRates = defineAdapter({
  name: 'freddie-mac-rates',
  title: 'US mortgage rates (Freddie Mac)',
  collection: 'housing',
  description:
    'The weekly US mortgage rate survey Freddie Mac has run since 1971: the 30-year and 15-year fixed averages with the points paid alongside them. The number quoted whenever anybody says rates hit a figure. Keyless.',
  docs: 'https://www.freddiemac.com/pmms',
  kinds: ['housing-statistic'],
  // Published every Thursday. Daily finds it the morning it lands.
  cadenceMinutes: 60 * 24,
  configFields: [
    {
      key: 'weeks',
      label: 'Weeks of history',
      type: 'number',
      placeholder: '52',
      help: 'How far back to read from the end of the file on each run.',
    },
    {
      key: 'series',
      label: 'Series',
      type: 'list',
      help: `Empty for all of: ${SERIES_KEYS.join(', ')}`,
    },
  ],
  defaults: { weeks: 52 },
  defaultSources: [{ slug: 'us-mortgage-rates', name: 'US mortgage rates, weekly' }],
  async pull({ config, http, log }) {
    const text = await http.text(CSV, {
      headers: { accept: 'text/csv, */*' },
      timeoutMs: 45_000,
    });
    const rows = parseCsv(text);
    if (!rows.length) throw new Error('the PMMS history file parsed to no rows');

    const weeks = Math.min(Math.max(Number(config.weeks) || 52, 1), 3000);
    const wanted = (Array.isArray(config.series) ? config.series : [])
      .map((s) => String(s).trim())
      .filter((s) => SERIES_KEYS.includes(s));
    const columns = wanted.length ? wanted : SERIES_KEYS;

    // The file is the whole history every week, newest last.
    const recent = rows.slice(-weeks);
    const items = [];
    for (const row of recent) {
      for (const column of columns) {
        const item = toItem(row, column);
        if (item) items.push(item);
      }
    }

    const newest = items
      .map((i) => i.publishedAt)
      .sort()
      .at(-1);
    log(`${items.length} weekly rate(s) from ${rows.length} rows, newest ${newest}`);
    return { items, note: `${items.length} rates to ${newest}` };
  },
});
