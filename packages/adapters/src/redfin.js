import { defineAdapter, slugify } from '@nichedb/core/adapter';
import { dumpDir, gzipLines } from '@nichedb/core/dump';

/**
 * What the US housing market did, by region, from Redfin's public bucket.
 *
 * Redfin is a brokerage with MLS access, and it publishes the aggregate of
 * what it sees: median sale price, list price, price per square foot, homes
 * sold, pending sales, new listings, inventory, days on market and
 * sale-to-list, monthly from 2012, split by property type, down to
 * neighborhood. No key, no account, no terms — an open S3 bucket.
 *
 * This is the closest thing to open MLS data that exists. The listings
 * themselves are not open and will not become open: RESO tracks 484 separate
 * MLSs, each requiring a real estate licence, a signed per-MLS data agreement
 * and vendor credentials, and none of them permit redistribution. What Redfin
 * gives away is the derived market view, which is the half a person actually
 * asks for — "what are houses going for around here" rather than "list every
 * house".
 *
 * ## This is NOT a listing
 *
 * OpenListing (logicsrc, docs/openlisting) describes one thing on offer and
 * says in as many words that aggregate market data must not be published as
 * one: it has no seller and no offer. So these are `housing-market` rows in
 * their own collection, deliberately kept apart from `/c/listings`. Mixing
 * them would make both useless.
 *
 * ## The files
 *
 * Six region levels, gzipped TSV, measured 2026-09-25:
 *
 *   neighborhood  2.24 GB    zip_code  1.48 GB    city  955 MB
 *   county         230 MB    state     8.6 MB     national 0.5 MB
 *
 * Defaults to the four smaller levels. Neighborhood and zip together are 3.7
 * GB and tens of millions of rows, which is a bulk walk rather than an hourly
 * fetch, so they are opt-in.
 */

const BASE = 'https://redfin-public-data.s3.us-west-2.amazonaws.com/redfin_market_tracker';

/** Region levels, smallest file first so a budgeted run finishes something. */
export const LEVELS = {
  national: { file: 'us_national_market_tracker', label: 'United States', approxMb: 1 },
  state: { file: 'state_market_tracker', label: 'State', approxMb: 9 },
  county: { file: 'county_market_tracker', label: 'County', approxMb: 230 },
  city: { file: 'city_market_tracker', label: 'City', approxMb: 955 },
  zip: { file: 'zip_code_market_tracker', label: 'ZIP code', approxMb: 1477 },
  neighborhood: { file: 'neighborhood_market_tracker', label: 'Neighborhood', approxMb: 2245 },
};

export const LEVEL_KEYS = Object.keys(LEVELS);

/** The columns worth carrying, by their header name. */
const METRICS = [
  'MEDIAN_SALE_PRICE',
  'MEDIAN_LIST_PRICE',
  'MEDIAN_PPSF',
  'MEDIAN_LIST_PPSF',
  'HOMES_SOLD',
  'PENDING_SALES',
  'NEW_LISTINGS',
  'INVENTORY',
  'MONTHS_OF_SUPPLY',
  'MEDIAN_DOM',
  'AVG_SALE_TO_LIST',
  'SOLD_ABOVE_LIST',
  'PRICE_DROPS',
  'OFF_MARKET_IN_TWO_WEEKS',
];

/** Each metric also has MoM and YoY companions. */
const CHANGES = ['_MOM', '_YOY'];

/**
 * A TSV cell to a number, or null.
 *
 * Redfin writes an absent measure as an empty cell, and an empty cell must
 * not become zero: a ZIP with no sales that month is not a ZIP where the
 * median price was zero, and charting it as zero would put a spike through
 * every quiet market.
 */
export function num(raw) {
  const s = String(raw ?? '')
    .trim()
    .replace(/^"|"$/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function text(raw) {
  const s = String(raw ?? '')
    .trim()
    .replace(/^"|"$/g, '');
  return s || null;
}

/** The period a row covers, as its first day. */
export function periodOf(cells, index) {
  const begin = text(cells[index.PERIOD_BEGIN]);
  if (!begin) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(begin);
  return m ? m[1] : null;
}

/**
 * A stable id for one region, one period, one property type.
 *
 * TABLE_ID identifies the region within its level and is what Redfin keys on,
 * so it is preferred; the region name is the fallback for a row without one.
 * Property type is part of the identity because the same region and month
 * appears once per type, and collapsing them would silently keep whichever
 * row was read last.
 */
export function rowId(level, cells, index) {
  const region = text(cells[index.TABLE_ID]) ?? slugify(text(cells[index.REGION]) ?? 'unknown');
  const period = periodOf(cells, index) ?? 'unknown';
  const type = slugify(text(cells[index.PROPERTY_TYPE]) ?? 'all');
  return `redfin:${level}:${region}:${type}:${period}`;
}

/** Header names to their column positions. */
export function headerIndex(header) {
  const index = {};
  header.forEach((name, i) => {
    index[String(name).trim().replace(/^"|"$/g, '').toUpperCase()] = i;
  });
  for (const required of ['PERIOD_BEGIN', 'REGION', 'PROPERTY_TYPE', 'MEDIAN_SALE_PRICE']) {
    if (index[required] === undefined) {
      throw new Error(
        `Redfin file is missing the ${required} column; the market tracker layout has changed`,
      );
    }
  }
  return index;
}

export function toItem(level, cells, index) {
  const period = periodOf(cells, index);
  const region = text(cells[index.REGION]);
  if (!period || !region) return null;

  const propertyType = text(cells[index.PROPERTY_TYPE]) ?? 'All Residential';
  const state = text(cells[index.STATE_CODE]) ?? text(cells[index.STATE]);

  const measures = {};
  for (const metric of METRICS) {
    if (index[metric] === undefined) continue;
    const value = num(cells[index[metric]]);
    if (value === null) continue;
    measures[metric.toLowerCase()] = value;
    for (const suffix of CHANGES) {
      const col = index[`${metric}${suffix}`];
      if (col === undefined) continue;
      const change = num(cells[col]);
      if (change !== null) measures[`${metric}${suffix}`.toLowerCase()] = change;
    }
  }
  if (!Object.keys(measures).length) return null;

  const price = measures.median_sale_price;
  const sold = measures.homes_sold;
  const headline = [
    price ? `median ${Math.round(price).toLocaleString('en-US')}` : null,
    sold ? `${Math.round(sold).toLocaleString('en-US')} sold` : null,
    measures.median_dom ? `${Math.round(measures.median_dom)} days on market` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return {
    externalId: rowId(level, cells, index),
    kind: 'housing-market',
    title: `${region}${state && level !== 'state' ? `, ${state}` : ''}: ${propertyType}, ${period.slice(0, 7)}`,
    summary: headline || `${propertyType} in ${region}, ${period.slice(0, 7)}`,
    // Redfin's data centre is the page a person should land on; there is no
    // per-region permalink in the bucket.
    url: 'https://www.redfin.com/news/data-center/',
    publishedAt: period,
    timeKnown: false,
    precision: 'month',
    tags: [
      'housing-market',
      level,
      slugify(propertyType),
      ...(state ? [slugify(state)] : []),
      ...(region && level !== 'national' ? [slugify(region)] : []),
    ],
    data: {
      level,
      region,
      regionId: text(cells[index.TABLE_ID]),
      city: text(cells[index.CITY]),
      state,
      propertyType,
      period,
      periodEnd: text(cells[index.PERIOD_END]),
      seasonallyAdjusted: text(cells[index.IS_SEASONALLY_ADJUSTED]) === 'true',
      measures,
      source: 'Redfin Data Center, redfin.com/news/data-center',
      // Said plainly on every row, because the distinction is the one thing
      // a consumer of this collection must not get wrong.
      note: 'Aggregate market data, not a listing. It has no seller and no offer, and is not an OpenListing document.',
    },
  };
}

export const redfinMarket = defineAdapter({
  name: 'redfin-market',
  title: 'US housing market (Redfin)',
  collection: 'housing',
  description:
    'What the US housing market did, by region and month since 2012, from the open bucket Redfin publishes: median sale and list price, price per square foot, homes sold, pending sales, new listings, inventory, months of supply, days on market and sale-to-list, split by property type. Derived from MLS data by a brokerage that has access, and given away. Aggregate market data, not listings. Keyless.',
  docs: 'https://www.redfin.com/news/data-center/',
  kinds: ['housing-market'],
  cadenceMinutes: 60 * 24,
  budgetMs: 2 * 60 * 60 * 1000,
  configFields: [
    {
      key: 'levels',
      label: 'Region levels',
      type: 'list',
      help: `Any of: ${LEVEL_KEYS.join(', ')}. Default is national, state, county and city. zip is 1.5 GB and neighborhood 2.2 GB.`,
    },
    {
      key: 'sinceYear',
      label: 'Earliest year',
      type: 'number',
      placeholder: '2019',
      help: 'Rows before this are skipped. The files go back to 2012.',
    },
  ],
  defaults: { levels: ['national', 'state', 'county'], sinceYear: 2019 },
  defaultSources: [
    {
      slug: 'redfin-market',
      name: 'US housing market by region',
      description:
        'Median prices, sales, inventory and days on market for the United States, every state and every county, monthly. City, ZIP and neighborhood levels can be turned on here; they are much larger files.',
      config: { levels: ['national', 'state', 'county'], sinceYear: 2019 },
      enabled: true,
    },
  ],

  async *pull({ config, cursor, http, log, deadline }) {
    const wanted = (Array.isArray(config.levels) ? config.levels : [])
      .map((l) => String(l).trim().toLowerCase())
      .filter((l) => LEVEL_KEYS.includes(l));
    const levels = wanted.length ? wanted : ['national', 'state', 'county'];
    const sinceYear = Number(config.sinceYear) || 2019;

    const dir = await dumpDir('redfin');
    const done = new Set(cursor?.done ?? []);
    let wrote = 0;

    for (const level of levels) {
      if (done.has(level)) continue;
      if (Date.now() > deadline) {
        return { cursor: { done: [...done] }, note: `${wrote} row(s), more levels next run` };
      }

      const spec = LEVELS[level];
      const url = `${BASE}/${spec.file}.tsv000.gz`;
      const path = `${dir}/${spec.file}.tsv.gz`;

      log(`${level}: downloading ~${spec.approxMb} MB`);
      const got = await http.download(url, path, {
        timeoutMs: Math.max(60_000, deadline - Date.now()),
      });
      if (!got.complete) {
        log(`${level}: download incomplete, resuming next run`);
        return { cursor: { done: [...done] }, note: 'downloading', nextInMinutes: 10 };
      }

      let index = null;
      let batch = [];
      let rows = 0;

      for await (const line of gzipLines(path)) {
        if (!line) continue;
        const cells = line.split('\t');
        if (!index) {
          index = headerIndex(cells);
          continue;
        }
        rows += 1;

        const period = periodOf(cells, index);
        if (!period || Number(period.slice(0, 4)) < sinceYear) continue;

        const item = toItem(level, cells, index);
        if (!item) continue;
        batch.push(item);

        if (batch.length >= 500) {
          wrote += batch.length;
          yield { items: batch, cursor: { done: [...done] } };
          batch = [];
          if (Date.now() > deadline) {
            log(`${level}: deadline after ${rows} rows`);
            return { cursor: { done: [...done] }, note: `${wrote} row(s), resuming` };
          }
        }
      }

      if (batch.length) {
        wrote += batch.length;
        yield { items: batch, cursor: { done: [...done] } };
      }
      done.add(level);
      log(`${level}: ${rows} rows read`);
    }

    // A finished pass starts again next month against the refreshed files.
    return { cursor: { done: [] }, note: `${wrote} row(s) across ${levels.length} level(s)` };
  },
});
