import { defineAdapter } from '@nichedb/core/adapter';

/**
 * The FBI's Crime Data Explorer: crime by state, by year.
 *
 * The other two crime adapters answer "what happened on this street". This one
 * answers the question those cannot: how does a whole state compare, and to
 * itself five years ago. Incident feeds are the wrong instrument for that —
 * a city portal covers one city, its coverage changes when the department
 * changes systems, and counting rows across cities compares reporting
 * practices rather than crime.
 *
 * The estimates here are the FBI's own, built from agency submissions with
 * non-reporting agencies estimated in, which is what makes them comparable
 * between states in a way that summing portals never is. They are also slow:
 * a year's figures land the following autumn. That is the trade, and it is
 * why this exists alongside the incident feeds rather than instead of them.
 *
 * Needs a free api.data.gov key. Without one the source is seeded disabled and
 * the sources page says what it needs, like every other keyed adapter here.
 */

const API = 'https://api.usa.gov/crime/fbi/cde';

/** The offences the estimates cover, and how each reads in a sentence. */
const OFFENSES = {
  violent_crime: 'violent crime',
  homicide: 'homicide',
  rape_legacy: 'rape (legacy definition)',
  rape_revised: 'rape',
  robbery: 'robbery',
  aggravated_assault: 'aggravated assault',
  property_crime: 'property crime',
  burglary: 'burglary',
  larceny: 'larceny',
  motor_vehicle_theft: 'motor vehicle theft',
  arson: 'arson',
};

/** The fifty states plus DC, so a source can be seeded per region without a list elsewhere. */
export const STATES = [
  'AL',
  'AK',
  'AZ',
  'AR',
  'CA',
  'CO',
  'CT',
  'DE',
  'DC',
  'FL',
  'GA',
  'HI',
  'ID',
  'IL',
  'IN',
  'IA',
  'KS',
  'KY',
  'LA',
  'ME',
  'MD',
  'MA',
  'MI',
  'MN',
  'MS',
  'MO',
  'MT',
  'NE',
  'NV',
  'NH',
  'NJ',
  'NM',
  'NY',
  'NC',
  'ND',
  'OH',
  'OK',
  'OR',
  'PA',
  'RI',
  'SC',
  'SD',
  'TN',
  'TX',
  'UT',
  'VT',
  'VA',
  'WA',
  'WV',
  'WI',
  'WY',
];

const STATE_NAMES = {
  AL: 'Alabama',
  AK: 'Alaska',
  AZ: 'Arizona',
  AR: 'Arkansas',
  CA: 'California',
  CO: 'Colorado',
  CT: 'Connecticut',
  DE: 'Delaware',
  DC: 'District of Columbia',
  FL: 'Florida',
  GA: 'Georgia',
  HI: 'Hawaii',
  ID: 'Idaho',
  IL: 'Illinois',
  IN: 'Indiana',
  IA: 'Iowa',
  KS: 'Kansas',
  KY: 'Kentucky',
  LA: 'Louisiana',
  ME: 'Maine',
  MD: 'Maryland',
  MA: 'Massachusetts',
  MI: 'Michigan',
  MN: 'Minnesota',
  MS: 'Mississippi',
  MO: 'Missouri',
  MT: 'Montana',
  NE: 'Nebraska',
  NV: 'Nevada',
  NH: 'New Hampshire',
  NJ: 'New Jersey',
  NM: 'New Mexico',
  NY: 'New York',
  NC: 'North Carolina',
  ND: 'North Dakota',
  OH: 'Ohio',
  OK: 'Oklahoma',
  OR: 'Oregon',
  PA: 'Pennsylvania',
  RI: 'Rhode Island',
  SC: 'South Carolina',
  SD: 'South Dakota',
  TN: 'Tennessee',
  TX: 'Texas',
  UT: 'Utah',
  VT: 'Vermont',
  VA: 'Virginia',
  WA: 'Washington',
  WV: 'West Virginia',
  WI: 'Wisconsin',
  WY: 'Wyoming',
};

export const stateName = (code) => STATE_NAMES[String(code).toUpperCase()] ?? code;

/**
 * Per 100,000 people, which is the only way two states of different size compare.
 *
 * Guarded on the value before the cast. `Number(null)` is 0 and 0 is finite,
 * so a state the FBI has no figure for would otherwise be published as a rate
 * of zero — which does not read as "not reported", it reads as "no crime
 * there", and it would be the single most misleading number on the page.
 */
export function rate(count, population) {
  if (count === null || count === undefined || count === '') return null;
  if (population === null || population === undefined || population === '') return null;
  const c = Number(count);
  const p = Number(population);
  if (!Number.isFinite(c) || !Number.isFinite(p) || p <= 0) return null;
  return Math.round((c / p) * 100_000 * 10) / 10;
}

export function toItem(row, { state, offense }) {
  const year = String(row.data_year ?? row.year ?? '');
  if (!/^\d{4}$/.test(year)) return null;
  const count = Number(row[offense] ?? row.value ?? row.count);
  if (!Number.isFinite(count)) return null;
  const population = Number(row.population) || null;
  const per100k = rate(count, population);
  const label = OFFENSES[offense] ?? offense.replace(/_/g, ' ');
  const where = stateName(state);

  return {
    externalId: `fbi-${state}-${offense}-${year}`,
    kind: 'crime-estimate',
    title: `${where}, ${year}: ${count.toLocaleString('en-US')} ${label} offences${per100k ? ` (${per100k} per 100k)` : ''}`,
    summary: `The FBI estimates ${count.toLocaleString('en-US')} ${label} offences in ${where} in ${year}${population ? `, a population of ${population.toLocaleString('en-US')}` : ''}${per100k ? `, or ${per100k} per 100,000 people` : ''}. Estimates are built from agency submissions with non-reporting agencies estimated in, which is what makes them comparable between states.`,
    url: `https://cde.ucr.cjis.gov/LATEST/webapp/#/pages/explorer/crime/crime-trend`,
    // A year, stamped at its close. Nothing finer exists in this series.
    publishedAt: `${year}-12-31`,
    timeKnown: false,
    precision: 'year',
    tags: ['crime', 'us', 'estimate', state.toLowerCase(), offense.replace(/_/g, '-'), year],
    data: {
      place: { country: 'US', state, city: null, area: null, address: null, lat: null, lon: null },
      stateName: where,
      year: Number(year),
      offense,
      offenseLabel: label,
      count,
      population,
      per100k,
      basis: 'fbi-estimate',
      note: 'An FBI estimate for a whole state and year, not a count of incidents. It is comparable between states and years; the incident feeds in this collection are not.',
      source: 'FBI Crime Data Explorer',
      raw: row,
    },
  };
}

export const fbiCrimeEstimates = defineAdapter({
  name: 'fbi-crime-estimates',
  title: 'US crime by state (FBI)',
  collection: 'crime',
  description:
    'The FBI’s estimated offence counts and rates per 100,000 people, by state and year, for violent crime, homicide, robbery, assault, burglary, larceny, vehicle theft and arson. Comparable between states in a way that summing city portals is not. Needs a free api.data.gov key.',
  docs: 'https://cde.ucr.cjis.gov/LATEST/webapp/#/pages/docApi',
  kinds: ['crime-estimate'],
  // A yearly series. Checking weekly is already far more often than it moves.
  cadenceMinutes: 60 * 24 * 7,
  needsEnv: ['dataGovApiKey'],
  configFields: [
    {
      key: 'states',
      label: 'States',
      type: 'list',
      placeholder: 'CA, TX, NY',
      help: 'Empty for all fifty states and DC.',
    },
    { key: 'from', label: 'From year', type: 'number', placeholder: '2015' },
    {
      key: 'offenses',
      label: 'Offences',
      type: 'list',
      help: `Empty for all of: ${Object.keys(OFFENSES).join(', ')}`,
    },
  ],
  defaults: { from: 2015 },
  defaultSources: [{ slug: 'us-crime-by-state', name: 'US crime estimates by state and year' }],
  async pull({ config, env, http, log, deadline }) {
    if (!env.dataGovApiKey) throw new Error('fbi-crime-estimates needs DATA_GOV_API_KEY');

    const states = (Array.isArray(config.states) ? config.states : [])
      .map((s) => String(s).trim().toUpperCase())
      .filter((s) => STATES.includes(s));
    const wantedStates = states.length ? states : STATES;
    const offenses = (Array.isArray(config.offenses) ? config.offenses : [])
      .map((o) => String(o).trim())
      .filter((o) => o in OFFENSES);
    const wantedOffenses = offenses.length ? offenses : Object.keys(OFFENSES);

    const from = Number(config.from) || 2015;
    const to = new Date().getUTCFullYear();

    const items = [];
    outer: for (const state of wantedStates) {
      for (const offense of wantedOffenses) {
        // Fifty states times eleven offences is more calls than one run should
        // make, so the run stops on its deadline and the next one carries on.
        if (Date.now() > deadline) {
          log(`stopped at ${state}/${offense} on the run deadline`);
          break outer;
        }
        const url = `${API}/estimate/state/${state}?from=${from}&to=${to}&API_KEY=${encodeURIComponent(env.dataGovApiKey)}`;
        const res = await http.json(url, { timeoutMs: 30_000 }).catch(() => null);
        const rows = Array.isArray(res) ? res : (res?.data ?? res?.results ?? []);
        for (const row of rows) {
          const item = toItem(row, { state, offense });
          if (item) items.push(item);
        }
        // One call per state answers every offence, so break out of the
        // offence loop rather than asking the same URL eleven times.
        break;
      }
    }

    log(`${items.length} state-year estimate(s)`);
    return { items, note: `${items.length} estimates` };
  },
});
