import { config } from '@nichedb/config';
import { slugify } from '@nichedb/core/adapter';
import { areaPath, normaliseZip, US_STATE_BY_POSTAL, zipKey } from '@nichedb/core/population';
import { areaByKey } from '@nichedb/db/population';
import { defineEnricher } from './enricher.js';

/**
 * Who lives around here, from our own population collection.
 *
 * Anything that knows where it is (a healthcare provider's practice ZIP, a
 * listing's postal code, a permit's city and state) gets the profile of the
 * smallest area we can place it in: the ZIP code, else the city, else the
 * state, else the country. Population, the year it counts, and the handful of
 * measures a reader weighs a place by: median household income, median age,
 * poverty rate, density.
 *
 * No request leaves the building. The answer is a keyed lookup against rows
 * the census-acs, worldbank-population and geonames-cities sources already
 * wrote, so the per-run allowance is a courtesy to the database rather than
 * to anybody's rate limit.
 */

const BLOCKS = ['address', 'location', 'place', 'practice'];

/** The first non-empty string among these fields of these blocks. */
function field(blocks, names) {
  for (const b of blocks) {
    for (const n of names) {
      const v = b?.[n];
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    }
  }
  return null;
}

/**
 * The keys to try for an item, most specific first. Exported for tests: the
 * address shapes differ by adapter and this is where they converge.
 */
export function candidateKeys(item) {
  const data = item?.data;
  if (!data || typeof data !== 'object') return [];
  const blocks = [data, ...BLOCKS.map((k) => data[k]).filter((b) => b && typeof b === 'object')];

  const countryRaw = field(blocks, ['countryCode', 'country']);
  const country =
    countryRaw && /^[A-Za-z]{2}$/.test(countryRaw)
      ? countryRaw.toUpperCase()
      : countryRaw && /^(usa|united states)/i.test(countryRaw)
        ? 'US'
        : null;
  const stateRaw = field(blocks, ['stateCode', 'state', 'region']);
  const usState =
    stateRaw && (country === null || country === 'US') && US_STATE_BY_POSTAL[stateRaw.toUpperCase()]
      ? US_STATE_BY_POSTAL[stateRaw.toUpperCase()]
      : null;
  const isUs = country === 'US' || (country === null && usState !== null);

  const keys = [];
  if (isUs) {
    const zip = normaliseZip(
      field(blocks, ['postalCode', 'zip', 'zipCode', 'postal_code', 'postcode']),
    );
    if (zip) keys.push(zipKey(zip));
    const city = field(blocks, ['city', 'locality', 'town']);
    if (usState) {
      const stateKey = `us-${usState.postal.toLowerCase()}`;
      if (city && slugify(city)) keys.push(`${stateKey}-${slugify(city)}`);
      keys.push(stateKey);
    }
  }
  if (country) keys.push(country.toLowerCase());
  return keys;
}

/** The block stored on the item. */
export function profileOf(row) {
  const d = row?.data ?? {};
  const m = d.measures ?? {};
  const pick = {};
  for (const k of [
    'medianHouseholdIncome',
    'medianAge',
    'povertyRate',
    'density',
    'lifeExpectancy',
  ]) {
    if (m[k] !== undefined && m[k] !== null) pick[k] = m[k];
  }
  return {
    key: d.key,
    level: d.level,
    name: row.title,
    population: d.population ?? null,
    year: d.year ?? null,
    measures: pick,
    topCoded: m.topCoded ?? undefined,
    page: `${config.siteUrl}${areaPath(d)}`,
    source: d.source ?? null,
  };
}

export const population = defineEnricher({
  name: 'population',
  title: 'Local population',
  description:
    'Who lives where this is: the population, median household income, median age, poverty rate and density of the smallest area the item can be placed in (its ZIP code, else its city, state or country), from this site’s own population collection (US Census ACS, World Bank, GeoNames). No external request.',
  // Not `health`: NPPES is eight million providers, and turning an enricher on
  // there is eight million row rewrites through the items GIN indexes. Worth
  // doing deliberately, as a backfill, rather than as a side effect of a deploy.
  collections: ['housing', 'listings', 'crime'],
  appliesTo: (item) => item?.collection_slug !== 'population' && candidateKeys(item).length > 0,
  perRun: 200,

  async enrich(item) {
    for (const key of candidateKeys(item)) {
      const row = await areaByKey(key);
      if (row) return profileOf(row);
    }
    return null;
  },
});
