import { rm } from 'node:fs/promises';
import { defineAdapter, slugify } from '@nichedb/core/adapter';
import { dumpDir, unzipText } from '@nichedb/core/dump';
import { areaTags, KIND } from '@nichedb/core/population';
import { parseCountryInfo } from './worldbank-population.js';

/**
 * The cities of the world outside the United States, and the states,
 * provinces and regions they sit in, from GeoNames.
 *
 * GeoNames publishes every populated place it knows with a population and
 * its first-level administrative division, under CC BY 4.0, as flat files:
 * `cities15000` is every place of 15,000 or more (about 34,000, a 3.4 MB zip),
 * `cities5000` and `cities1000` go further down. That is what fills the
 * population tree below the country for everywhere the Census Bureau does not
 * reach. The US and Puerto Rico are skipped by default because the ACS has
 * every place there already, with far more than a headcount.
 *
 * ## Divisions have no population here
 *
 * GeoNames names a first-level division in admin1CodesASCII but carries its
 * population only on the feature itself, in the 400 MB allCountries dump.
 * Rather than invent one, a division row has `population: null` and reports
 * what it can honestly say: how many listed cities it holds and how many
 * people live in them (`listedCityPopulation`). That is a floor, labelled as
 * one, and never summed into anything.
 *
 * A city's population is GeoNames' figure, usually the latest census or an
 * official estimate, and its year is not recorded upstream; the row carries
 * the date GeoNames last modified the entry instead.
 */

const DUMP = 'https://download.geonames.org/export/dump';

export const FILES = { 15000: 'cities15000', 5000: 'cities5000', 1000: 'cities1000' };

/** One line of a GeoNames cities file, or null. */
export function parseCity(line) {
  const c = line.split('\t');
  if (c.length < 19) return null;
  const population = Number(c[14]);
  const lat = Number(c[4]);
  const long = Number(c[5]);
  if (!c[0] || !/^[A-Z]{2}$/.test(c[8] ?? '')) return null;
  return {
    id: c[0],
    name: c[1],
    asciiName: c[2] || c[1],
    lat: Number.isFinite(lat) ? lat : null,
    long: Number.isFinite(long) ? long : null,
    featureCode: c[7],
    country: c[8],
    admin1: c[10] && c[10] !== '00' ? c[10] : null,
    population: Number.isFinite(population) && population > 0 ? population : null,
    elevation: c[15] ? Number(c[15]) : null,
    timezone: c[17] || null,
    modified: /^\d{4}-\d{2}-\d{2}$/.test(c[18]?.trim() ?? '') ? c[18].trim() : null,
  };
}

/** admin1CodesASCII.txt to `CC.code` → { name, asciiName, geonameId }. */
export function parseAdmin1(text) {
  const out = new Map();
  for (const line of String(text ?? '').split('\n')) {
    const c = line.split('\t');
    if (!/^[A-Z]{2}\.[^\t]+$/.test(c[0] ?? '')) continue;
    out.set(c[0], { name: c[1], asciiName: c[2] || c[1], geonameId: c[3]?.trim() || null });
  }
  return out;
}

/**
 * Keys for divisions and cities, unique within their parent and never equal
 * to a key already taken (a city with no division sits beside the divisions
 * of its country, so the two share a namespace).
 */
export function assignKeys({ cities, admin1 }) {
  const taken = new Set();
  const stateKeys = new Map();
  const divisions = [
    ...new Set(cities.filter((c) => c.admin1).map((c) => `${c.country}.${c.admin1}`)),
  ].sort();
  for (const code of divisions) {
    const [cc, a1] = code.split('.');
    const name = admin1.get(code)?.asciiName ?? a1;
    let key = `${cc.toLowerCase()}-${slugify(name) || slugify(a1)}`;
    if (taken.has(key)) key = `${key}-${slugify(a1)}`;
    taken.add(key);
    stateKeys.set(code, key);
  }
  const cityKeys = new Map();
  // Largest first, so the city people mean keeps the plain slug.
  for (const c of [...cities].sort(
    (a, b) => (b.population ?? 0) - (a.population ?? 0) || a.id.localeCompare(b.id),
  )) {
    const parent = c.admin1 ? stateKeys.get(`${c.country}.${c.admin1}`) : c.country.toLowerCase();
    let key = `${parent}-${slugify(c.asciiName) || c.id}`;
    if (taken.has(key)) key = `${key}-${c.id}`;
    taken.add(key);
    cityKeys.set(c.id, key);
  }
  return { stateKeys, cityKeys };
}

const licence = 'CC BY 4.0, GeoNames (geonames.org)';

export function cityItem(c, { key, stateKey, stateName, countryName }) {
  const country = c.country.toLowerCase();
  const ancestors = [country, ...(stateKey ? [stateKey] : [])];
  const where = [stateName, countryName].filter(Boolean).join(', ');
  return {
    externalId: `geonames:city:${c.id}`,
    kind: KIND,
    title: `${c.name}${where ? `, ${where}` : ''}`,
    summary: `${c.name}: ${Math.round(c.population).toLocaleString('en-US')} people.`,
    url: `https://www.geonames.org/${c.id}`,
    publishedAt: c.modified ?? new Date().toISOString().slice(0, 10),
    timeKnown: false,
    precision: 'day',
    tags: areaTags({ key, level: 'city', ancestors, name: c.asciiName }),
    data: {
      level: 'city',
      key,
      parentKey: ancestors[ancestors.length - 1],
      name: c.name,
      asciiName: c.asciiName,
      country: c.country,
      countryName: countryName ?? null,
      stateKey: stateKey ?? null,
      stateName: stateName ?? null,
      geonameId: c.id,
      featureCode: c.featureCode,
      population: c.population,
      year: null,
      modified: c.modified,
      elevation: c.elevation,
      timezone: c.timezone,
      measures: {},
      location: c.lat !== null && c.long !== null ? { lat: c.lat, long: c.long } : null,
      source: 'GeoNames cities (CC BY 4.0)',
      licence,
    },
  };
}

export function divisionItem({ code, key, info, countryName, cities }) {
  const [cc, a1] = code.split('.');
  const listed = cities.reduce((s, c) => s + (c.population ?? 0), 0);
  const name = info?.name ?? a1;
  return {
    externalId: `geonames:admin1:${code}`,
    kind: KIND,
    title: `${name}${countryName ? `, ${countryName}` : ''}`,
    summary: `${name}: ${cities.length} listed ${cities.length === 1 ? 'city' : 'cities'} with ${Math.round(listed).toLocaleString('en-US')} people between them. The division's own total is not published by GeoNames.`,
    url: info?.geonameId
      ? `https://www.geonames.org/${info.geonameId}`
      : `https://www.geonames.org/countries/${cc}/`,
    publishedAt: new Date().toISOString().slice(0, 10),
    timeKnown: false,
    precision: 'day',
    tags: areaTags({
      key,
      level: 'state',
      ancestors: [cc.toLowerCase()],
      name: info?.asciiName ?? name,
    }),
    data: {
      level: 'state',
      key,
      parentKey: cc.toLowerCase(),
      name,
      country: cc,
      countryName: countryName ?? null,
      stateKey: key,
      admin1Code: a1,
      geonameId: info?.geonameId ?? null,
      population: null,
      year: null,
      listedCities: cities.length,
      listedCityPopulation: listed,
      measures: {},
      location: null,
      source: 'GeoNames admin1 codes and cities (CC BY 4.0)',
      licence,
    },
  };
}

export const geonamesCities = defineAdapter({
  name: 'geonames-cities',
  title: 'Cities of the world (GeoNames)',
  collection: 'population',
  description:
    'Every city outside the United States above a population threshold (15,000 by default, down to 1,000), with its population, coordinates, elevation and time zone, filed under its state, province or region, from GeoNames. Keyless, CC BY 4.0.',
  docs: 'https://download.geonames.org/export/dump/readme.txt',
  kinds: [KIND],
  cadenceMinutes: 60 * 24 * 7,
  configFields: [
    {
      key: 'minPopulation',
      label: 'Smallest city',
      type: 'select',
      options: Object.keys(FILES),
      help: '15000 is about 34,000 cities; 5000 about 68,000; 1000 about 160,000.',
    },
    {
      key: 'skipCountries',
      label: 'Countries to skip',
      type: 'list',
      help: 'ISO codes. US and PR by default, which the Census ACS source covers in far more detail.',
    },
  ],
  defaults: { minPopulation: 15000, skipCountries: ['US', 'PR'] },
  defaultSources: [
    {
      slug: 'geonames-cities',
      name: 'Cities of the world',
      description: 'Every city of 15,000 or more outside the United States, with its region.',
      config: { minPopulation: 15000, skipCountries: ['US', 'PR'] },
      enabled: true,
    },
  ],

  async *pull({ config, http, log }) {
    const file = FILES[String(config.minPopulation)] ?? FILES[15000];
    const skip = new Set(
      (Array.isArray(config.skipCountries) ? config.skipCountries : ['US', 'PR']).map((c) =>
        String(c).trim().toUpperCase(),
      ),
    );
    const dir = await dumpDir('geonames');
    const path = `${dir}/${file}.zip`;
    // GeoNames regenerates these nightly; start from a fresh copy each run.
    await rm(path, { force: true });
    const got = await http.download(`${DUMP}/${file}.zip`, path, { timeoutMs: 10 * 60_000 });
    if (!got.complete) return { note: `${file}: download incomplete`, nextInMinutes: 30 };

    const cities = (await unzipText(path))
      .split('\n')
      .filter(Boolean)
      .map(parseCity)
      .filter((c) => c?.population && !skip.has(c.country));
    const admin1 = parseAdmin1(
      await http.text(`${DUMP}/admin1CodesASCII.txt`, { timeoutMs: 60_000 }),
    );
    const countries = parseCountryInfo(await http.text(`${DUMP}/countryInfo.txt`).catch(() => ''));
    log(`${cities.length} cities, ${admin1.size} divisions`);

    const { stateKeys, cityKeys } = assignKeys({ cities, admin1 });
    const byDivision = new Map();
    for (const c of cities) {
      if (!c.admin1) continue;
      const code = `${c.country}.${c.admin1}`;
      if (!byDivision.has(code)) byDivision.set(code, []);
      byDivision.get(code).push(c);
    }

    function* rows() {
      for (const [code, key] of stateKeys) {
        yield divisionItem({
          code,
          key,
          info: admin1.get(code),
          countryName: countries.get(code.slice(0, 2))?.name,
          cities: byDivision.get(code) ?? [],
        });
      }
      for (const c of cities) {
        const code = c.admin1 ? `${c.country}.${c.admin1}` : null;
        yield cityItem(c, {
          key: cityKeys.get(c.id),
          stateKey: code ? stateKeys.get(code) : null,
          stateName: code ? (admin1.get(code)?.name ?? null) : null,
          countryName: countries.get(c.country)?.name,
        });
      }
    }

    let batch = [];
    let wrote = 0;
    for (const item of rows()) {
      batch.push(item);
      if (batch.length >= 500) {
        wrote += batch.length;
        yield { items: batch };
        batch = [];
      }
    }
    if (batch.length) {
      wrote += batch.length;
      yield { items: batch };
    }
    return { note: `${wrote} rows: ${stateKeys.size} divisions, ${cities.length} cities` };
  },
});
