import { rm } from 'node:fs/promises';
import { defineAdapter, slugify } from '@nichedb/core/adapter';
import { dumpDir, lineOffsetReader, unzipText } from '@nichedb/core/dump';
import {
  areaTags,
  censusNumber,
  cleanPlaceName,
  density,
  KIND,
  pct,
  SQMI_TO_KM2,
  TOP_CODES,
  US_STATES,
  zipKey,
} from '@nichedb/core/population';

/**
 * Who lives in every US state, city and ZIP code, from the American Community
 * Survey.
 *
 * The ACS 5-year estimates are the only survey that reaches every place in
 * the country down to the ZIP: population, age, income, housing cost,
 * poverty, education, work, race and ethnicity, pooled over five years so a
 * town of four hundred has a sample big enough to say something. Public
 * domain, from the Census Bureau.
 *
 * ## Why the Summary File and not the API
 *
 * api.census.gov started refusing keyless calls (every request 302s to
 * missing_key.html with `X-DataWebAPI-KeyError: 1`, measured 2026-09-25). The
 * table-based Summary File on www2.census.gov is the same numbers with no key
 * at all: one pipe-delimited file per table, every geography the survey
 * publishes in it, one line each:
 *
 *   GEO_ID|B19013_E001|B19013_M001
 *   0400000US06|99122|310                  California
 *   1600000US0644000|81939|742             Los Angeles city
 *   860Z200US90210|187801|18411            ZCTA 90210
 *
 * A file holds every level (block groups are most of the bytes), so a line is
 * kept only when its GEO_ID starts with one of the three prefixes above. The
 * thirteen tables read here are about 520 MB for the 2024 vintage. They change
 * once a year, each December, so a run first asks whether a newer vintage
 * exists and does nothing when it does not.
 *
 * ## Names, places and ZIPs
 *
 * The Summary File names nothing: a GEO_ID and numbers. Names and centroids
 * come from the Census Gazetteer (one small zip each for places and ZCTAs),
 * and a ZIP is placed in a state and a city by the 2020 ZCTA relationship
 * files, which say how much of each ZCTA's land lies in each county and each
 * place. A ZIP goes under the place holding most of its land, when that place
 * holds at least a tenth of it; a rural ZIP with no such place sits directly
 * under its state.
 *
 * A ZCTA is the Census Bureau's area drawn from ZIP codes, not a ZIP code:
 * PO-box-only and single-building ZIPs have none. For a person asking "how
 * many people live in 90210" it is the right answer and the only one there is.
 *
 * ## Sentinels and top codes
 *
 * See `censusNumber` and `TOP_CODES` in core/population.js. Both are the kind
 * of wrong that produces a plausible number, so both are tested.
 */

const SF = 'https://www2.census.gov/programs-surveys/acs/summary_file';
const GAZ = 'https://www2.census.gov/geo/docs/maps-data/data/gazetteer';
const REL = 'https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520';

export const PREFIX = { state: '0400000US', city: '1600000US', zip: '860Z200US' };
const LEVEL_OF_PREFIX = Object.fromEntries(Object.entries(PREFIX).map(([k, v]) => [v, k]));

/**
 * Table to the columns read from it. A leading underscore is a count used to
 * derive a rate and is not stored by itself: "12,000 people below the poverty
 * line" means nothing without the universe it came from.
 */
export const TABLES = {
  b01003: { E001: 'population', M001: 'populationMoe' },
  b01002: { E001: 'medianAge' },
  b11001: { E001: 'households' },
  b19013: { E001: 'medianHouseholdIncome' },
  b19301: { E001: 'perCapitaIncome' },
  b25077: { E001: 'medianHomeValue' },
  b25064: { E001: 'medianGrossRent' },
  b25003: { E001: '_occupied', E002: '_ownerOccupied' },
  b17001: { E001: '_povertyUniverse', E002: '_belowPoverty' },
  b15003: {
    E001: '_age25plus',
    E022: '_bachelors',
    E023: '_masters',
    E024: '_professional',
    E025: '_doctorate',
  },
  b23025: { E003: '_laborForce', E005: '_unemployed' },
  b03003: { E001: '_ethnicityTotal', E003: '_hispanic' },
  b02001: {
    E001: '_raceTotal',
    E002: '_white',
    E003: '_black',
    E004: '_nativeAmerican',
    E005: '_asian',
    E006: '_pacificIslander',
    E007: '_otherRace',
    E008: '_multiracial',
  },
};

export const LEVEL_KEYS = ['state', 'city', 'zip'];

/** The level of a Summary File GEO_ID, or null for one this does not keep. */
export function levelOfGeoId(geoId) {
  return LEVEL_OF_PREFIX[String(geoId).slice(0, 9)] ?? null;
}

/**
 * One table's header to `{ index: field }`, for the columns this reads.
 * Throws when an expected column is missing: a renamed column read as absent
 * would publish a year of nulls without an error.
 */
export function tableColumns(table, headerLine) {
  const header = headerLine.replace(/^﻿/, '').split('|');
  const wanted = TABLES[table];
  const out = {};
  for (const [suffix, field] of Object.entries(wanted)) {
    const name = `${table.toUpperCase()}_${suffix}`;
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`${table}: the Summary File has no ${name} column`);
    out[i] = field;
  }
  return out;
}

/** Everything derived from the raw counts, as the stored measures. */
export function deriveMeasures(raw) {
  const m = {};
  for (const k of [
    'medianAge',
    'households',
    'medianHouseholdIncome',
    'perCapitaIncome',
    'medianHomeValue',
    'medianGrossRent',
  ]) {
    if (raw[k] !== null && raw[k] !== undefined) m[k] = raw[k];
  }
  const topCoded = [];
  for (const [field, code] of Object.entries(TOP_CODES)) {
    if (m[field] === code) {
      m[field] = code - 1;
      topCoded.push(field);
    }
  }

  const get = (k) => (raw[k] === undefined ? null : raw[k]);
  const graduate = [
    get('_bachelors'),
    get('_masters'),
    get('_professional'),
    get('_doctorate'),
  ].every((v) => v !== null)
    ? get('_bachelors') + get('_masters') + get('_professional') + get('_doctorate')
    : null;

  const rates = {
    ownerOccupiedRate: pct(get('_ownerOccupied'), get('_occupied')),
    povertyRate: pct(get('_belowPoverty'), get('_povertyUniverse')),
    bachelorsOrHigherRate: pct(graduate, get('_age25plus')),
    unemploymentRate: pct(get('_unemployed'), get('_laborForce')),
    hispanicShare: pct(get('_hispanic'), get('_ethnicityTotal')),
  };
  for (const [k, v] of Object.entries(rates)) if (v !== null) m[k] = v;

  const race = {};
  for (const k of [
    'white',
    'black',
    'nativeAmerican',
    'asian',
    'pacificIslander',
    'otherRace',
    'multiracial',
  ]) {
    const v = pct(get(`_${k}`), get('_raceTotal'));
    if (v !== null) race[k] = v;
  }
  if (Object.keys(race).length) m.raceShares = race;
  if (topCoded.length) m.topCoded = topCoded;
  return m;
}

/** Tab-separated Gazetteer text to rows keyed by header, whitespace trimmed. */
export function parseGazetteer(text) {
  const lines = String(text ?? '')
    .replace(/^﻿/, '')
    .split('\n');
  const header = (lines.shift() ?? '').split('\t').map((h) => h.trim());
  const rows = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const cells = line.split('\t').map((c) => c.trim());
    rows.push(Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ''])));
  }
  return rows;
}

/**
 * A 2020 ZCTA relationship file to, per ZCTA, the other geography holding the
 * most of its land and the share it holds. Rows with an empty ZCTA are the
 * parts of a place outside every ZCTA, and are skipped.
 */
export function largestOverlap(text, otherGeoIdColumn) {
  const lines = String(text ?? '')
    .replace(/^﻿/, '')
    .split('\n');
  const header = (lines.shift() ?? '').split('|').map((h) => h.trim());
  const zi = header.indexOf('GEOID_ZCTA5_20');
  const zl = header.indexOf('AREALAND_ZCTA5_20');
  const oi = header.indexOf(otherGeoIdColumn);
  const pl = header.indexOf('AREALAND_PART');
  if (zi < 0 || oi < 0 || pl < 0) throw new Error(`relationship file has no ${otherGeoIdColumn}`);
  const best = new Map();
  for (const line of lines) {
    if (!line) continue;
    const c = line.split('|');
    const zcta = c[zi]?.trim();
    const other = c[oi]?.trim();
    if (!zcta || !other) continue;
    const part = Number(c[pl]) || 0;
    const land = Number(c[zl]) || 0;
    const prev = best.get(zcta);
    if (!prev || part > prev.part) {
      best.set(zcta, { geoId: other, part, share: land > 0 ? part / land : 0 });
    }
  }
  return best;
}

/**
 * City keys for every place, unique within its state. Two places in one
 * state can share a name (a city and a CDP, or two CDPs in different
 * counties); the first by GEOID keeps the plain slug and the rest carry their
 * place code, so a URL never silently changes which town it means.
 */
export function cityKeys(places) {
  const out = new Map();
  const taken = new Set();
  for (const p of [...places].sort((a, b) => a.geoid.localeCompare(b.geoid))) {
    const base = slugify(p.name) || p.geoid;
    let key = `${p.stateKey}-${base}`;
    if (taken.has(key)) key = `${key}-${p.geoid.slice(2)}`;
    taken.add(key);
    out.set(p.geoid, key);
  }
  return out;
}

const round = (v, d = 4) => (v === null || v === undefined ? null : Number(Number(v).toFixed(d)));

/** One accumulated geography to its item. */
export function areaItem(rec, vintage) {
  const raw = rec.raw;
  const population = raw.population ?? null;
  if (population === null) return null;
  const measures = deriveMeasures(raw);
  const areaKm2 = rec.alandSqmi ? round(rec.alandSqmi * SQMI_TO_KM2, 2) : null;
  const dens = density(population, areaKm2);
  if (dens !== null) measures.density = dens;

  const survey = `ACS 5-year ${vintage - 4}–${vintage}`;
  const people = Math.round(population).toLocaleString('en-US');
  const income = measures.medianHouseholdIncome
    ? `, median household income $${Math.round(measures.medianHouseholdIncome).toLocaleString('en-US')}${measures.topCoded?.includes('medianHouseholdIncome') ? '+' : ''}`
    : '';
  const title =
    rec.level === 'state'
      ? rec.name
      : rec.level === 'city'
        ? `${rec.name}, ${rec.state}`
        : `ZIP ${rec.zip}${rec.cityName ? ` (${rec.cityName}, ${rec.state})` : rec.state ? ` (${rec.state})` : ''}`;

  return {
    externalId: `acs:${rec.level}:${rec.geoId}`,
    kind: KIND,
    title,
    summary: `${title}: ${people} people${income} (${survey}).`,
    url: `https://data.census.gov/profile?g=${rec.geoId}`,
    publishedAt: `${vintage}-12-31`,
    timeKnown: false,
    precision: 'year',
    tags: [
      ...areaTags({ key: rec.key, level: rec.level, ancestors: rec.ancestors, name: rec.name }),
      ...(rec.zip ? [`zip-${rec.zip}`] : []),
    ],
    data: {
      level: rec.level,
      key: rec.key,
      parentKey: rec.ancestors[rec.ancestors.length - 1] ?? null,
      name: rec.name,
      legalName: rec.legalName ?? null,
      country: 'US',
      countryName: 'United States',
      state: rec.state ?? null,
      stateName: rec.stateName ?? null,
      stateKey: rec.stateKey ?? null,
      stateFips: rec.stateFips ?? null,
      cityKey: rec.cityKey ?? null,
      cityName: rec.cityName ?? null,
      cityShare: rec.cityShare ?? null,
      zip: rec.zip ?? null,
      geoId: rec.geoId,
      population,
      populationMoe: raw.populationMoe ?? null,
      year: vintage,
      survey,
      landAreaKm2: areaKm2,
      measures,
      location:
        rec.lat !== null && rec.long !== null && rec.lat !== undefined
          ? { lat: rec.lat, long: rec.long }
          : null,
      source: `US Census Bureau, American Community Survey ${survey} (public domain)`,
      licence: 'Public domain (US Government work)',
    },
  };
}

/** The newest vintage whose Summary File is published, probing back from last year. */
async function latestVintage(http) {
  const year = new Date().getUTCFullYear();
  for (let y = year - 1; y >= year - 4; y -= 1) {
    const res = await http.request(tableUrl(y, 'b01003'), { method: 'HEAD', timeoutMs: 20_000 });
    await res.body?.cancel().catch(() => {});
    if (res.ok) return y;
  }
  throw new Error('no ACS 5-year Summary File found in the last four years');
}

const tableUrl = (vintage, table) =>
  `${SF}/${vintage}/table-based-SF/data/5YRData/acsdt5y${vintage}-${table}.dat`;

/** The newest Gazetteer file at or before the vintage. */
async function gazetteer(http, dir, vintage, which) {
  for (let y = vintage; y >= vintage - 3; y -= 1) {
    const url = `${GAZ}/${y}_Gazetteer/${y}_Gaz_${which}_national.zip`;
    const path = `${dir}/gaz-${which}-${y}.zip`;
    const got = await http.download(url, path, { timeoutMs: 120_000 }).catch(() => null);
    if (got?.complete && got.bytes > 1000) return parseGazetteer(await unzipText(path));
    await rm(path, { force: true });
  }
  throw new Error(`no ${which} Gazetteer at or before ${vintage}`);
}

/** Every geography this run keeps, keyed by GEO_ID, before any table is read. */
export function buildRegistry({ places, zctas, zctaPlace, zctaCounty, levels }) {
  const reg = new Map();
  const stateOf = {};
  for (const [fips, [postal, name]] of Object.entries(US_STATES)) {
    const key = `us-${postal.toLowerCase()}`;
    stateOf[fips] = { postal, name, key, fips };
    if (levels.includes('state'))
      reg.set(`${PREFIX.state}${fips}`, {
        level: 'state',
        geoId: `${PREFIX.state}${fips}`,
        key,
        name,
        state: postal,
        stateName: name,
        stateKey: key,
        stateFips: fips,
        ancestors: ['us'],
        lat: null,
        long: null,
        raw: {},
      });
  }

  const placeRows = places
    .filter((p) => /^\d{7}$/.test(p.GEOID) && stateOf[p.GEOID.slice(0, 2)])
    .map((p) => ({
      geoid: p.GEOID,
      name: cleanPlaceName(p.NAME),
      legalName: p.NAME,
      stateKey: stateOf[p.GEOID.slice(0, 2)].key,
      row: p,
    }));
  const keys = cityKeys(placeRows);
  const placeByGeoid = new Map();
  for (const p of placeRows) {
    const st = stateOf[p.geoid.slice(0, 2)];
    const rec = {
      level: 'city',
      geoId: `${PREFIX.city}${p.geoid}`,
      key: keys.get(p.geoid),
      name: p.name,
      legalName: p.legalName,
      state: st.postal,
      stateName: st.name,
      stateKey: st.key,
      stateFips: st.fips,
      ancestors: ['us', st.key],
      alandSqmi: Number(p.row.ALAND_SQMI) || null,
      lat: censusNumber(p.row.INTPTLAT),
      long: censusNumber(p.row.INTPTLONG),
      raw: {},
    };
    placeByGeoid.set(p.geoid, rec);
    if (levels.includes('city')) reg.set(rec.geoId, rec);
  }

  if (levels.includes('zip')) {
    for (const z of zctas) {
      const zip = z.GEOID;
      if (!/^\d{5}$/.test(zip)) continue;
      const county = zctaCounty.get(zip);
      const st = county ? stateOf[county.geoId.slice(0, 2)] : null;
      const placed = zctaPlace.get(zip);
      const city = placed && placed.share >= 0.1 ? placeByGeoid.get(placed.geoId) : null;
      // A ZIP straddling a state line is filed where most of its land is; its
      // city must be in that same state or the tree would cross itself.
      const cityOk = city && st && city.stateKey === st.key ? city : null;
      reg.set(`${PREFIX.zip}${zip}`, {
        level: 'zip',
        geoId: `${PREFIX.zip}${zip}`,
        key: zipKey(zip),
        name: zip,
        zip,
        state: st?.postal ?? null,
        stateName: st?.name ?? null,
        stateKey: st?.key ?? null,
        stateFips: st?.fips ?? null,
        cityKey: cityOk?.key ?? null,
        cityName: cityOk?.name ?? null,
        cityShare: cityOk ? round(placed.share, 3) : null,
        ancestors: ['us', ...(st ? [st.key] : []), ...(cityOk ? [cityOk.key] : [])],
        alandSqmi: Number(z.ALAND_SQMI) || null,
        lat: censusNumber(z.INTPTLAT),
        long: censusNumber(z.INTPTLONG),
        raw: {},
      });
    }
  }
  return reg;
}

export const censusAcs = defineAdapter({
  name: 'census-acs',
  title: 'US population by state, city and ZIP (Census ACS)',
  collection: 'population',
  description:
    'Every US state, city (Census place) and ZIP code (ZCTA): population, median age, households, median household and per-capita income, median home value and rent, home ownership, poverty, education, unemployment, race and Hispanic origin, from the American Community Survey 5-year estimates. Read from the keyless Summary File, refreshed when the Census Bureau publishes a new year. Public domain.',
  docs: 'https://www.census.gov/programs-surveys/acs/data/summary-file.html',
  kinds: [KIND],
  cadenceMinutes: 60 * 24,
  budgetMs: 90 * 60 * 1000,
  configFields: [
    {
      key: 'levels',
      label: 'Levels',
      type: 'list',
      help: `Any of: ${LEVEL_KEYS.join(', ')}. Default is all three.`,
    },
    {
      key: 'vintage',
      label: 'Vintage',
      type: 'number',
      placeholder: 'latest',
      help: 'The last year of the 5-year window (2024 is 2020 to 2024). Empty follows the newest published.',
    },
  ],
  defaults: { levels: LEVEL_KEYS },
  defaultSources: [
    {
      slug: 'census-acs',
      name: 'US states, cities and ZIP codes',
      description:
        'Population, income, housing, poverty, education and work for every state, city and ZIP code in the United States.',
      config: { levels: LEVEL_KEYS },
      enabled: true,
    },
  ],

  async *pull({ config, cursor, http, log, deadline }) {
    const wanted = (Array.isArray(config.levels) ? config.levels : [])
      .map((l) => String(l).trim().toLowerCase())
      .filter((l) => LEVEL_KEYS.includes(l));
    const levels = wanted.length ? wanted : LEVEL_KEYS;
    const vintage = Number(config.vintage) || (await latestVintage(http));
    const signature = `${vintage}:${levels.join(',')}`;
    if (cursor?.done === signature) {
      return { cursor, note: `ACS ${vintage} is current`, nextInMinutes: 60 * 24 * 7 };
    }

    const dir = await dumpDir(`census-acs-${vintage}`);
    log(`vintage ${vintage}, levels ${levels.join(', ')}`);

    const places = await gazetteer(http, dir, vintage, 'place');
    const zctas = levels.includes('zip') ? await gazetteer(http, dir, vintage, 'zcta') : [];
    const zctaPlace = levels.includes('zip')
      ? largestOverlap(
          await http.text(`${REL}/tab20_zcta520_place20_natl.txt`, { timeoutMs: 120_000 }),
          'GEOID_PLACE_20',
        )
      : new Map();
    const zctaCounty = levels.includes('zip')
      ? largestOverlap(
          await http.text(`${REL}/tab20_zcta520_county20_natl.txt`, { timeoutMs: 120_000 }),
          'GEOID_COUNTY_20',
        )
      : new Map();
    const reg = buildRegistry({ places, zctas, zctaPlace, zctaCounty, levels });
    log(`${reg.size} geographies: ${places.length} places, ${zctas.length} ZCTAs in the Gazetteer`);

    for (const table of Object.keys(TABLES)) {
      if (Date.now() > deadline) {
        return {
          cursor: cursor ?? {},
          note: `downloading tables, stopped at ${table}`,
          nextInMinutes: 5,
        };
      }
      const path = `${dir}/${table}.dat`;
      const got = await http.download(tableUrl(vintage, table), path, {
        timeoutMs: Math.max(60_000, deadline - Date.now()),
      });
      if (!got.complete) {
        log(`${table}: download incomplete, resuming next run`);
        return { cursor: cursor ?? {}, note: `downloading ${table}`, nextInMinutes: 5 };
      }
      let columns = null;
      let kept = 0;
      for await (const { line } of lineOffsetReader(path)) {
        if (!columns) {
          columns = tableColumns(table, line);
          continue;
        }
        const bar = line.indexOf('|');
        if (bar < 0) continue;
        const rec = reg.get(line.slice(0, bar));
        if (!rec) continue;
        const cells = line.split('|');
        for (const [i, field] of Object.entries(columns)) {
          rec.raw[field] = censusNumber(cells[i]);
        }
        kept += 1;
      }
      log(`${table}: ${kept} rows`);
    }

    let wrote = 0;
    let batch = [];
    for (const rec of reg.values()) {
      const item = areaItem(rec, vintage);
      if (!item) continue;
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

    // The tables are half a gigabyte and will not be read again until next
    // December's vintage, which has different file names anyway.
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    return { cursor: { done: signature }, note: `${wrote} areas from ACS ${vintage}` };
  },
});
