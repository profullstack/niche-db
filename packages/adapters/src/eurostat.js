import { defineAdapter, slugify } from '@nichedb/core/adapter';

/**
 * Eurostat: the same statistic, measured the same way, across 38 countries.
 *
 * This is the adapter that makes the housing and jobs collections comparable
 * rather than parochial. A national statistics office publishes its own
 * unemployment rate on its own definition; Eurostat publishes everybody's on
 * one harmonised definition, monthly or quarterly, keyless, and it covers the
 * EU plus the EEA, Switzerland, the candidate countries and often the US and
 * Japan for reference. "Is housing more expensive in Portugal or Poland" is a
 * question only a source like this can answer honestly.
 *
 * One adapter serves both collections. Unemployment and house prices are the
 * same API with a different dataset code, so the seeded sources point at
 * `une_rt_m` under jobs and `prc_hpi_q` under housing, and a deployment that
 * wants industrial production adds a source rather than a file.
 *
 * The format is JSON-stat 2.0, which is a genuinely good design and a slightly
 * awkward one to read. Values are not a list of records: they are a sparse map
 * keyed by a single flat integer index into the cross-product of every
 * dimension, in row-major order. So a reply covering 38 countries and one
 * quarter has keys like `"25": 4.2`, and 25 has to be decoded back into
 * "Portugal, 2026-Q1" against the dimension sizes. Sparse because not every
 * country reports every period, which is also why the count of values is
 * usually smaller than the product of the sizes and why a naive positional
 * read silently attributes Portugal's number to Poland.
 */

const API = 'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data';

/**
 * Decode JSON-stat's flat index into one position per dimension.
 *
 * Row-major: the last dimension varies fastest. This is the whole trick of the
 * format and getting it backwards produces plausible, wrong answers rather
 * than an error, so it is a named function with a test rather than three lines
 * inline.
 */
export function decodeIndex(flat, sizes) {
  const out = new Array(sizes.length);
  let rest = Number(flat);
  for (let d = sizes.length - 1; d >= 0; d--) {
    out[d] = rest % sizes[d];
    rest = Math.floor(rest / sizes[d]);
  }
  return out;
}

/** `{ "PT": 25 }` inverted to `{ 25: "PT" }`, once per dimension rather than per value. */
export function positionToCode(category) {
  const out = [];
  for (const [code, pos] of Object.entries(category?.index ?? {})) out[Number(pos)] = code;
  return out;
}

/**
 * Turn a JSON-stat reply into flat observations.
 *
 * Each observation carries every dimension it was filed under, by code and by
 * label, so an item does not have to know which dataset it came from to say
 * what it means.
 */
export function observations(payload) {
  const dimIds = payload?.id ?? [];
  const sizes = payload?.size ?? [];
  if (!dimIds.length || dimIds.length !== sizes.length) return [];

  const codes = dimIds.map((id) => positionToCode(payload.dimension?.[id]?.category));
  const labels = dimIds.map((id) => payload.dimension?.[id]?.category?.label ?? {});
  const values = payload.value ?? {};

  const rows = [];
  for (const [flat, value] of Object.entries(values)) {
    if (value === null || value === undefined) continue;
    const positions = decodeIndex(flat, sizes);
    const at = {};
    const labelled = {};
    for (let d = 0; d < dimIds.length; d++) {
      const code = codes[d]?.[positions[d]];
      if (code === undefined) continue;
      at[dimIds[d]] = code;
      labelled[dimIds[d]] = labels[d]?.[code] ?? code;
    }
    rows.push({ at, labelled, value: Number(value) });
  }
  return rows;
}

/** The datasets seeded by default. Any other Eurostat code is a source away. */
export const DATASETS = {
  une_rt_m: {
    collection: 'jobs',
    kind: 'labour-statistic',
    name: 'Unemployment rate, monthly',
    unit: '%',
    measure: 'unemployment rate',
    // Seasonally adjusted, both sexes, total age: the headline figure people
    // mean when they say "the unemployment rate".
    params: { s_adj: 'SA', sex: 'T', age: 'TOTAL', unit: 'PC_ACT' },
    periods: 2,
  },
  prc_hpi_q: {
    collection: 'housing',
    kind: 'housing-statistic',
    name: 'House price index, quarterly',
    unit: '% change on a year earlier',
    measure: 'house prices',
    params: { purchase: 'TOTAL', unit: 'RCH_A' },
    periods: 2,
  },
  prc_hpi_a: {
    collection: 'housing',
    kind: 'housing-statistic',
    name: 'House price index, annual',
    unit: '% change on a year earlier',
    measure: 'house prices',
    params: { purchase: 'TOTAL', unit: 'RCH_A' },
    periods: 2,
  },
  lfsi_emp_q: {
    collection: 'jobs',
    kind: 'labour-statistic',
    name: 'Employment rate, quarterly',
    unit: '%',
    measure: 'employment rate',
    params: { s_adj: 'SA', sex: 'T', age: 'Y20-64', unit: 'PC_POP', indic_em: 'EMP_LFS' },
    periods: 2,
  },
};

export const DATASET_KEYS = Object.keys(DATASETS);

/** Direction reads better than a sign when the number is a rate of change. */
function movement(value, unit) {
  if (!unit.includes('change')) return null;
  if (value > 0) return 'rising';
  if (value < 0) return 'falling';
  return 'flat';
}

export function toItem(row, spec, code) {
  const geo = row.at.geo;
  const time = row.at.time;
  if (!geo || !time) return null;
  const where = row.labelled.geo ?? geo;
  const dir = movement(row.value, spec.unit);

  return {
    // One item per country per period. A revision to a published figure
    // rewrites the same row rather than arriving as a second observation.
    externalId: `eurostat-${code}-${geo}-${time}`,
    kind: spec.kind,
    title: `${where}, ${time}: ${spec.measure} ${row.value}${spec.unit === '%' ? '%' : ''}${dir ? ` (${dir})` : ''}`,
    summary: `Eurostat puts ${spec.measure} in ${where} at ${row.value} ${spec.unit} for ${time}, on the harmonised definition it applies to every country it covers. Harmonised figures are comparable between countries in a way that each country's own national statistic is not.`,
    url: `https://ec.europa.eu/eurostat/databrowser/view/${code}/default/table?lang=en`,
    publishedAt: periodDate(time),
    timeKnown: false,
    precision: /Q\d/.test(time) ? 'month' : time.length === 4 ? 'year' : 'month',
    tags: [
      spec.collection,
      'eurostat',
      'statistic',
      geo.toLowerCase(),
      slugify(where).slice(0, 40),
      slugify(spec.measure),
      dir,
    ].filter(Boolean),
    data: {
      // The shape both collections share, so a statistic reads the same
      // whether it is about rent or about work.
      measure: {
        name: spec.measure,
        value: row.value,
        unit: spec.unit,
        period: time,
        area: where,
        areaCode: geo,
        country: geo,
      },
      dataset: code,
      datasetName: spec.name,
      dimensions: row.at,
      dimensionLabels: row.labelled,
      basis: 'harmonised',
      note: 'Eurostat harmonises national submissions onto one definition, which is what makes countries comparable. A national statistics office may publish a different number for the same period on its own definition, and neither is wrong.',
      source: 'Eurostat',
      licence: 'Free reuse with attribution, Commission decision 2011/833/EU',
    },
  };
}

/**
 * A Eurostat period to a date: `2026-Q1`, `2026-06` or `2026`.
 *
 * Stamped at the START of the period, not the end. A quarter's figure describes
 * that quarter, and filing 2026-Q1 under March would sort it after data that
 * genuinely is from March.
 */
export function periodDate(period) {
  const p = String(period ?? '').trim();
  const q = /^(\d{4})-?Q([1-4])$/.exec(p);
  if (q) return `${q[1]}-${String((Number(q[2]) - 1) * 3 + 1).padStart(2, '0')}-01`;
  const m = /^(\d{4})-(\d{2})$/.exec(p);
  if (m) return `${m[1]}-${m[2]}-01`;
  const y = /^(\d{4})$/.exec(p);
  if (y) return `${y[1]}-01-01`;
  return null;
}

export const eurostat = defineAdapter({
  name: 'eurostat',
  title: 'European statistics (Eurostat)',
  collection: 'jobs',
  description:
    'Harmonised European statistics: unemployment and employment rates, house price indices and any other Eurostat dataset by code, across the EU, the EEA, Switzerland and the candidate countries. Comparable between countries in a way each nation’s own statistic is not. Keyless.',
  docs: 'https://wikis.ec.europa.eu/display/EUROSTATHELP/API+-+Detailed+guidelines+-+API+Statistics',
  kinds: ['labour-statistic', 'housing-statistic'],
  // Monthly and quarterly series. Twice a day catches a release the day it
  // lands without asking a static table hourly.
  cadenceMinutes: 60 * 12,
  configFields: [
    {
      key: 'dataset',
      label: 'Dataset code',
      placeholder: 'une_rt_m',
      help: `One of the built-in codes (${DATASET_KEYS.join(', ')}), or any other Eurostat dataset code.`,
    },
    {
      key: 'geo',
      label: 'Country code',
      placeholder: 'DE',
      help: 'Optional; empty for every country the dataset covers.',
    },
    {
      key: 'periods',
      label: 'Periods to read',
      type: 'number',
      placeholder: '2',
      help: 'How many of the most recent periods to fetch on each run.',
    },
  ],
  defaults: {},
  defaultSources: [
    {
      slug: 'eu-unemployment',
      name: 'Unemployment rate across Europe',
      config: { dataset: 'une_rt_m' },
      collection: 'jobs',
    },
    {
      slug: 'eu-employment-rate',
      name: 'Employment rate across Europe',
      config: { dataset: 'lfsi_emp_q' },
      collection: 'jobs',
    },
    {
      slug: 'eu-house-prices',
      name: 'House prices across Europe',
      config: { dataset: 'prc_hpi_q' },
      collection: 'housing',
    },
  ],
  async pull({ config, http, log }) {
    const code = String(config.dataset ?? 'une_rt_m').trim();
    const spec = DATASETS[code] ?? {
      collection: 'jobs',
      kind: 'labour-statistic',
      name: code,
      unit: '',
      measure: code,
      params: {},
      periods: 2,
    };

    const params = new URLSearchParams({ format: 'JSON' });
    params.set('lastTimePeriod', String(Number(config.periods) || spec.periods || 2));
    for (const [k, v] of Object.entries(spec.params)) params.set(k, v);
    if (config.geo) params.set('geo', String(config.geo).trim().toUpperCase());

    const payload = await http.json(`${API}/${encodeURIComponent(code)}?${params}`, {
      timeoutMs: 45_000,
    });
    const rows = observations(payload);
    if (!rows.length) throw new Error(`${code} returned no observations`);

    const items = rows.map((r) => toItem(r, spec, code)).filter(Boolean);
    log(`${items.length} observation(s) from ${code}, updated ${payload.updated ?? 'unknown'}`);
    return { items, note: `${items.length} from ${code}` };
  },
});
