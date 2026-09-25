import { slugify } from './adapter.js';

/**
 * The shape every population row shares, whichever adapter wrote it.
 *
 * Population is a tree, and the whole point of the collection is walking it:
 * the world, a country, a state, a city, a ZIP code. Three upstreams fill
 * different levels (the World Bank the countries, the Census Bureau the US
 * below that, GeoNames the cities of everywhere else), so the tree cannot be
 * a foreign key in one table. It is written into the tags instead, where the
 * `(collection_id, kind, tags)` GIN index can answer it:
 *
 *   key-us-ca                 this row IS California
 *   in-us                     this row is somewhere inside the United States
 *   level-state               this row is a state
 *
 * So "the cities of California" is `tags @> {in-us-ca, level-city}` and "what
 * is 90210" is `tags @> {key-us-90210}`, both index-only. Every row carries an
 * `in-` tag for every ancestor, not just its parent, which is what lets a ZIP
 * list be asked for at the state or the country without walking the cities.
 *
 * Keys are lowercase, hyphenated and stable across refreshes:
 *
 *   country   us                     ISO 3166-1 alpha-2
 *   state     us-ca                  US: the postal code. Elsewhere: the
 *                                    GeoNames first-level division, by name
 *   city      us-ca-los-angeles      state key + name slug
 *   zip       us-90210               country + the ZIP (ZCTA), unique nationally
 */

export const KIND = 'population-area';
export const LEVELS = ['country', 'state', 'city', 'zip'];

/** What a level is called for a person, singular and plural. */
export const LEVEL_LABELS = {
  country: ['Country', 'Countries'],
  state: ['State', 'States'],
  city: ['City', 'Cities'],
  zip: ['ZIP code', 'ZIP codes'],
};

/** The level each level drills down into, in order of usefulness. */
export const CHILD_LEVELS = {
  world: ['country'],
  country: ['state', 'city'],
  state: ['city', 'zip'],
  city: ['zip'],
  zip: [],
};

export const keyTag = (key) => `key-${key}`;
export const inTag = (key) => `in-${key}`;
export const levelTag = (level) => `level-${level}`;

/** A key is a slug made of slugs; anything else never reaches a query. */
export function normaliseKey(raw) {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/\/+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return s.length > 0 && s.length <= 160 ? s : null;
}

/** A five-digit ZIP, from a ZIP+4, a number that lost its leading zero, or junk. */
export function normaliseZip(raw) {
  const m = /^\s*(\d{3,5})(?:-\d{4})?\s*$/.exec(String(raw ?? ''));
  if (!m) return null;
  return m[1].padStart(5, '0');
}

export const zipKey = (zip) => `us-${zip}`;

/**
 * Tags for one area: what it is, where it sits, and its name as a slug so a
 * place can be found by what people call it (`name-springfield` lists every
 * Springfield, which is the honest answer to the question).
 *
 * @param {{ key: string, level: string, ancestors: string[], name: string }} area
 */
export function areaTags({ key, level, ancestors = [], name }) {
  const nameSlug = slugify(name);
  return [
    'population',
    levelTag(level),
    keyTag(key),
    ...ancestors.map(inTag),
    ...(nameSlug ? [`name-${nameSlug}`] : []),
  ];
}

/**
 * A Census place name without its legal description.
 *
 * The Gazetteer and the Summary File both name a place with its LSAD glued on:
 * "Los Angeles city", "Abanda CDP", "Juneau city and borough",
 * "Nashville-Davidson metropolitan government (balance)". The description is
 * always lowercase words (or CDP) after the proper name, which is always
 * capitalised, so the trailing lowercase run is what comes off.
 */
export function cleanPlaceName(raw) {
  const s = String(raw ?? '').trim();
  const stripped = s
    .replace(/\s+CDP$/, '')
    .replace(/(?:\s+(?:[a-z][a-z-]*|\([a-z ]+\)))+$/, '')
    .trim();
  return stripped || s;
}

/**
 * The Census Bureau's sentinel values, which are numbers and must not be read
 * as numbers.
 *
 * -666666666 is "no estimate" (too few sample cases), -999999999 "not
 * applicable", -888888888 "not available", -555555555 "controlled, no margin"
 * (on a margin column), -222222222 and -333333333 margins that could not be
 * computed. B19013 alone has 39,566 of them in the 2024 file; read as numbers
 * they would make a third of American ZIP codes destitute.
 */
export function censusNumber(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  if (n <= -222222222) return null;
  return n;
}

/**
 * The medians the Census top-codes, and the value that means "this or more".
 *
 * A household income of 250001 is not an income of 250,001 dollars; it is the
 * open top bin, "250,000 or more". Stored as the floor with a flag, so the
 * page can print "$250,000+" and an average over ZIPs can be refused rather
 * than quietly biased.
 */
export const TOP_CODES = {
  medianHouseholdIncome: 250001,
  medianHomeValue: 2000001,
  medianGrossRent: 3501,
};

/** Share as a percentage, one decimal, or null when the base is missing or zero. */
export function pct(part, whole) {
  if (part === null || whole === null || !whole) return null;
  return Math.round((part / whole) * 1000) / 10;
}

/** People per square kilometre, one decimal, or null. */
export function density(population, areaKm2) {
  if (!population || !areaKm2) return null;
  return Math.round((population / areaKm2) * 10) / 10;
}

export const SQMI_TO_KM2 = 2.589988110336;

/** The US postal codes by state FIPS. The Summary File speaks FIPS; people speak postal. */
export const US_STATES = {
  '01': ['AL', 'Alabama'],
  '02': ['AK', 'Alaska'],
  '04': ['AZ', 'Arizona'],
  '05': ['AR', 'Arkansas'],
  '06': ['CA', 'California'],
  '08': ['CO', 'Colorado'],
  '09': ['CT', 'Connecticut'],
  10: ['DE', 'Delaware'],
  11: ['DC', 'District of Columbia'],
  12: ['FL', 'Florida'],
  13: ['GA', 'Georgia'],
  15: ['HI', 'Hawaii'],
  16: ['ID', 'Idaho'],
  17: ['IL', 'Illinois'],
  18: ['IN', 'Indiana'],
  19: ['IA', 'Iowa'],
  20: ['KS', 'Kansas'],
  21: ['KY', 'Kentucky'],
  22: ['LA', 'Louisiana'],
  23: ['ME', 'Maine'],
  24: ['MD', 'Maryland'],
  25: ['MA', 'Massachusetts'],
  26: ['MI', 'Michigan'],
  27: ['MN', 'Minnesota'],
  28: ['MS', 'Mississippi'],
  29: ['MO', 'Missouri'],
  30: ['MT', 'Montana'],
  31: ['NE', 'Nebraska'],
  32: ['NV', 'Nevada'],
  33: ['NH', 'New Hampshire'],
  34: ['NJ', 'New Jersey'],
  35: ['NM', 'New Mexico'],
  36: ['NY', 'New York'],
  37: ['NC', 'North Carolina'],
  38: ['ND', 'North Dakota'],
  39: ['OH', 'Ohio'],
  40: ['OK', 'Oklahoma'],
  41: ['OR', 'Oregon'],
  42: ['PA', 'Pennsylvania'],
  44: ['RI', 'Rhode Island'],
  45: ['SC', 'South Carolina'],
  46: ['SD', 'South Dakota'],
  47: ['TN', 'Tennessee'],
  48: ['TX', 'Texas'],
  49: ['UT', 'Utah'],
  50: ['VT', 'Vermont'],
  51: ['VA', 'Virginia'],
  53: ['WA', 'Washington'],
  54: ['WV', 'West Virginia'],
  55: ['WI', 'Wisconsin'],
  56: ['WY', 'Wyoming'],
  72: ['PR', 'Puerto Rico'],
};

/** FIPS by postal code, and the reverse lookup an enricher needs. */
export const US_STATE_BY_POSTAL = Object.fromEntries(
  Object.entries(US_STATES).map(([fips, [postal, name]]) => [postal, { fips, postal, name }]),
);

/** The page an area lives on, relative to the site. */
export function areaPath(data) {
  if (!data?.level) return '/population';
  if (data.level === 'zip') return `/population/zip/${data.zip}`;
  const parts = String(data.key).split('-');
  if (data.level === 'country') return `/population/${data.key}`;
  const country = parts[0];
  if (data.level === 'state') return `/population/${country}/${data.key.slice(country.length + 1)}`;
  // city: the state key is carried on the row, since a state slug may itself
  // contain hyphens (gb-northern-ireland) and the key cannot be split blindly.
  // A city with no division (83 of GeoNames' 34,000) has no state segment to
  // put in the path, and is served by key instead.
  if (!data.stateKey) return `/population/area/${data.key}`;
  const state = String(data.stateKey);
  const stateSlug = state.slice(country.length + 1);
  const citySlug = data.key.slice(state.length + 1);
  return `/population/${country}/${stateSlug}/${citySlug}`;
}
