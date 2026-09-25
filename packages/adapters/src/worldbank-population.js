import { defineAdapter } from '@nichedb/core/adapter';
import { areaTags, density, KIND } from '@nichedb/core/population';

/**
 * Every country's population, and what kind of population it is, from the
 * World Bank's World Development Indicators.
 *
 * The WDI is the reference everybody else cites: UN population estimates,
 * harmonised, one row per country per year back to 1960, keyless, CC BY 4.0.
 * This reads the headcount plus the indicators population science actually
 * works with (growth, density, urbanisation, the age structure, births,
 * deaths, migration, life expectancy, fertility) and the two economic ones a
 * reader always asks next (GDP per head and the Gini index).
 *
 * One row per country, rewritten when the figures move. The headcount carries
 * its series (every year in the window) so a trend can be drawn from one row;
 * every other indicator carries its latest non-empty year, because the WDI
 * does not publish them all at once and the newest population year is often
 * a year ahead of the newest Gini.
 *
 * ## What is not a country
 *
 * The WDI mixes 49 aggregates ("Africa Eastern and Southern", "High income",
 * "World") into the same country list, marked only by a region of
 * "Aggregates". They are dropped: an aggregate at the country level would put
 * "World" at the top of every list of countries.
 *
 * ## What the World Bank does not list
 *
 * Taiwan, Vatican City, Western Sahara and a handful of territories are not
 * WDI economies. GeoNames' countryInfo table carries a population and an area
 * for them, so they get a row from that instead, marked with its source. A
 * country missing entirely would leave the cities GeoNames files under it with
 * nowhere to hang.
 */

const WB = 'https://api.worldbank.org/v2';
const COUNTRY_INFO = 'https://download.geonames.org/export/dump/countryInfo.txt';

/** Indicator code to the field it becomes. Order is the order on the page. */
export const INDICATORS = {
  'SP.POP.TOTL': 'population',
  'SP.POP.GROW': 'growthRate',
  'EN.POP.DNST': 'density',
  'SP.URB.TOTL.IN.ZS': 'urbanShare',
  'SP.POP.0014.TO.ZS': 'under15Share',
  'SP.POP.1564.TO.ZS': 'workingAgeShare',
  'SP.POP.65UP.TO.ZS': 'over65Share',
  'SP.POP.DPND': 'dependencyRatio',
  'SP.DYN.CBRT.IN': 'birthRate',
  'SP.DYN.CDRT.IN': 'deathRate',
  'SP.DYN.TFRT.IN': 'fertilityRate',
  'SP.DYN.LE00.IN': 'lifeExpectancy',
  'SM.POP.NETM': 'netMigration',
  'NY.GDP.PCAP.CD': 'gdpPerCapita',
  'SI.POV.GINI': 'gini',
  'AG.LND.TOTL.K2': 'landAreaKm2',
};

/** A WDI value to a number or null. The API sends null for a missing year. */
const n = (v) =>
  v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null;

/**
 * The WDI's country list without its aggregates, keyed by ISO3, since the
 * indicator rows name a country by `countryiso3code`.
 */
export function countriesFrom(rows) {
  const out = new Map();
  for (const c of rows ?? []) {
    if (!c?.iso2Code || !c?.id) continue;
    if (c.region?.value === 'Aggregates' || c.region?.id === 'NA') continue;
    if (!/^[A-Z]{2}$/.test(c.iso2Code)) continue;
    out.set(c.id, {
      iso2: c.iso2Code,
      iso3: c.id,
      name: String(c.name ?? '').trim(),
      region: c.region?.value?.trim() || null,
      incomeLevel: c.incomeLevel?.value?.trim() || null,
      capital: c.capitalCity?.trim() || null,
      lat: n(c.latitude),
      long: n(c.longitude),
    });
  }
  return out;
}

/**
 * Fold one indicator's rows into the per-country accumulator: the whole
 * series for the headcount, the newest non-empty year for everything else.
 */
export function foldIndicator(acc, field, rows) {
  for (const r of rows ?? []) {
    const iso3 = r?.countryiso3code;
    const year = Number(r?.date);
    const value = n(r?.value);
    if (!iso3 || !Number.isInteger(year) || value === null) continue;
    const entry = acc.get(iso3) ?? { measures: {}, years: {}, series: {} };
    if (field === 'population') entry.series[year] = value;
    if (!(field in entry.years) || year > entry.years[field]) {
      entry.measures[field] = value;
      entry.years[field] = year;
    }
    acc.set(iso3, entry);
  }
  return acc;
}

/** GeoNames countryInfo.txt: tab-separated, `#` comments, one country a line. */
export function parseCountryInfo(text) {
  const out = new Map();
  for (const line of String(text ?? '').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const c = line.split('\t');
    if (!/^[A-Z]{2}$/.test(c[0] ?? '')) continue;
    out.set(c[0], {
      iso2: c[0],
      iso3: c[1] || null,
      name: c[4]?.trim() || c[0],
      capital: c[5]?.trim() || null,
      areaKm2: n(c[6]),
      population: n(c[7]),
      continent: c[8] || null,
    });
  }
  return out;
}

export function countryItem({ country, stats, info, source }) {
  const measures = { ...(stats?.measures ?? {}) };
  const years = { ...(stats?.years ?? {}) };
  const population = measures.population ?? info?.population ?? null;
  const areaKm2 = measures.landAreaKm2 ?? info?.areaKm2 ?? null;
  delete measures.population;
  delete measures.landAreaKm2;
  // The WDI sends modelled rates to fifteen significant figures (a growth
  // rate of 0.522468081877868). Three decimals is more than the estimate is
  // worth, and it keeps an unchanged figure from rewriting the row on every
  // run over noise in the last digit.
  for (const [k, v] of Object.entries(measures)) {
    if (!Number.isInteger(v)) measures[k] = Math.round(v * 1000) / 1000;
  }
  if (measures.density === undefined) {
    const d = density(population, areaKm2);
    if (d !== null) measures.density = d;
  }
  if (population === null) return null;

  const key = country.iso2.toLowerCase();
  const year = years.population ?? null;
  const series = Object.entries(stats?.series ?? {})
    .map(([y, v]) => [Number(y), v])
    .sort((a, b) => a[0] - b[0]);

  return {
    externalId: `country:${key}`,
    kind: KIND,
    title: country.name,
    summary: `${country.name}: ${Math.round(population).toLocaleString('en-US')} people${year ? ` (${year})` : ''}${measures.growthRate != null ? `, growing ${measures.growthRate.toFixed(2)}% a year` : ''}.`,
    url:
      source === 'worldbank'
        ? `https://data.worldbank.org/country/${country.iso2.toLowerCase()}`
        : `https://www.geonames.org/countries/${country.iso2}/`,
    publishedAt: year ? `${year}-07-01` : new Date().toISOString().slice(0, 10),
    timeKnown: false,
    precision: 'year',
    tags: [
      ...areaTags({ key, level: 'country', ancestors: [], name: country.name }),
      `iso3-${(country.iso3 ?? '').toLowerCase()}`,
    ].filter((t) => t !== 'iso3-'),
    data: {
      level: 'country',
      key,
      parentKey: null,
      name: country.name,
      country: country.iso2,
      countryName: country.name,
      iso3: country.iso3 ?? null,
      region: country.region ?? info?.continent ?? null,
      incomeLevel: country.incomeLevel ?? null,
      capital: country.capital ?? info?.capital ?? null,
      population,
      year,
      landAreaKm2: areaKm2,
      measures,
      measureYears: years,
      series,
      // The capital's coordinates: what the World Bank publishes, and close
      // enough for a map pin or a distance sort at country scale.
      location:
        country.lat !== null && country.long !== null
          ? { lat: country.lat, long: country.long }
          : null,
      source:
        source === 'worldbank'
          ? 'World Bank, World Development Indicators (CC BY 4.0)'
          : 'GeoNames countryInfo (CC BY 4.0)',
      licence: 'CC BY 4.0',
    },
  };
}

export const worldbankPopulation = defineAdapter({
  name: 'worldbank-population',
  title: 'Population by country (World Bank)',
  collection: 'population',
  description:
    'Every country: population and its yearly series, growth, density, urban share, age structure, births, deaths, fertility, life expectancy, net migration, GDP per head and the Gini index, from the World Bank World Development Indicators. Territories the World Bank does not list come from GeoNames. Keyless, CC BY 4.0.',
  docs: 'https://datahelpdesk.worldbank.org/knowledgebase/articles/889392',
  kinds: [KIND],
  cadenceMinutes: 60 * 24 * 7,
  configFields: [
    {
      key: 'sinceYear',
      label: 'Series from',
      type: 'number',
      placeholder: '1990',
      help: 'The first year of the population series kept on each country. The WDI goes back to 1960.',
    },
  ],
  defaults: { sinceYear: 1990 },
  defaultSources: [
    {
      slug: 'worldbank-population',
      name: 'Population by country',
      description:
        'Population, growth, age structure, births, deaths, migration and life expectancy for every country, from the World Bank.',
      config: { sinceYear: 1990 },
      enabled: true,
    },
  ],

  async pull({ config, http, log }) {
    const since = Number(config.sinceYear) || 1990;
    const to = new Date().getUTCFullYear();

    const [, countryRows] = await http.json(`${WB}/country?format=json&per_page=400`);
    const countries = countriesFrom(countryRows);
    log(`${countries.size} World Bank economies`);

    const stats = new Map();
    for (const [code, field] of Object.entries(INDICATORS)) {
      // The newest-value series fields need only the last few years; the
      // headcount wants the whole window for its series.
      const from = field === 'population' ? since : to - 15;
      const body = await http.json(
        `${WB}/country/all/indicator/${code}?format=json&per_page=20000&date=${from}:${to}`,
        { timeoutMs: 60_000 },
      );
      if (!Array.isArray(body) || !Array.isArray(body[1])) {
        log(`${code}: no rows (${JSON.stringify(body?.[0] ?? body).slice(0, 120)})`);
        continue;
      }
      foldIndicator(stats, field, body[1]);
    }

    const info = parseCountryInfo(await http.text(COUNTRY_INFO).catch(() => ''));
    const items = [];
    const seen = new Set();
    for (const [iso3, country] of countries) {
      const item = countryItem({
        country,
        stats: stats.get(iso3),
        info: info.get(country.iso2),
        source: 'worldbank',
      });
      if (item) {
        items.push(item);
        seen.add(country.iso2);
      }
    }
    // Territories the WDI does not carry.
    let filled = 0;
    for (const [iso2, c] of info) {
      if (seen.has(iso2) || !c.population) continue;
      const item = countryItem({
        country: { iso2, iso3: c.iso3, name: c.name, lat: null, long: null },
        stats: null,
        info: c,
        source: 'geonames',
      });
      if (item) {
        items.push(item);
        filled += 1;
      }
    }
    return { items, note: `${items.length} countries (${filled} from GeoNames)` };
  },
});
