import { defineAdapter, slugify } from '@nichedb/core/adapter';

/**
 * The appliances themselves: brand, model number, UPC and specification, for
 * every model certified under ENERGY STAR.
 *
 * This is the spine a parts collection hangs off. There is no free catalogue
 * of appliance *parts* — part numbers, prices and what fits what is the thing
 * PartSelect and RepairClinic sell, and nothing open replaces it. What is free
 * is the layer underneath: which models exist, who made them, what they are,
 * and what barcode is on the box. Join a parts listing to a model number and
 * the listing becomes answerable; without the model layer it is a SKU with no
 * home.
 *
 * The EPA publishes it on Socrata, keyless, and rewrites it daily. Fifty-odd
 * datasets, one per product category, each a flat table of models. `pd_id` is
 * the stable key across all of them and the `upc` column is populated on a
 * good fraction of rows, so a model here can be reached from a barcode scan.
 *
 * **Do not use the consolidated Model Index (`8wj2-sec8`).** It is the obvious
 * one to reach for — 1,796,876 rows, every category in a single table, and
 * Socrata reports `data_updated_at` as today. It is stale: measured on
 * 2026-09-25, its newest record was 2025-12-09, nine months behind. The daily
 * timestamp is a republish of unchanged content, not new data, and nothing in
 * the response says so. The per-category datasets below are the live ones and
 * were each measured the same day.
 *
 * A second trap sits next to that one: the datasets disagree about what the
 * date column is called. The index uses `date_certified`; most categories use
 * `date_qualified` and `date_available_on_market`; few carry all three. A
 * `$where` against a column a dataset does not have returns an empty page with
 * HTTP 200 rather than an error, so a wrong column name reads exactly like a
 * dataset that has stopped publishing. Every preset therefore names the column
 * that was observed to carry data, and the walk refuses a preset whose column
 * is missing rather than reporting zero rows.
 */

const DOMAIN = 'data.energystar.gov';
const PAGE = 1000;

/**
 * The catalogues worth carrying, and what each one calls its date.
 *
 * `rows` and `newestSeen` are what the dataset actually returned on
 * 2026-09-25. They are documentation, not logic, for the same reason the crime
 * presets carry them: a dataset that quietly stops publishing looks identical
 * to a category nobody certified this month, and the only way to tell the
 * difference later is to know what it used to do. The Commercial Coffee
 * Brewers dataset is the worked example — nineteen rows, newest 2021-08-27 —
 * and is deliberately absent below.
 */
export const CATALOGUES = {
  refrigerators: {
    dataset: 'p5st-her9',
    label: 'Residential refrigerators',
    dateField: 'date_qualified',
    rows: 4822,
    newestSeen: '2026-09-21',
    tags: ['refrigerator', 'kitchen'],
  },
  freezers: {
    dataset: '8t9c-g3tn',
    label: 'Residential freezers',
    dateField: 'date_qualified',
    rows: 668,
    newestSeen: '2026-09-11',
    tags: ['freezer', 'kitchen'],
  },
  'clothes-washers': {
    dataset: 'bghd-e2wd',
    label: 'Residential clothes washers',
    dateField: 'date_qualified',
    rows: 412,
    newestSeen: '2026-09-24',
    tags: ['washer', 'laundry'],
  },
  'clothes-dryers': {
    dataset: 't9u7-4d2j',
    label: 'Residential clothes dryers',
    dateField: 'date_qualified',
    rows: 679,
    newestSeen: '2026-09-22',
    tags: ['dryer', 'laundry'],
  },
  dishwashers: {
    dataset: 'q8py-6w3f',
    label: 'Residential dishwashers',
    dateField: 'date_available_on_market',
    rows: 756,
    newestSeen: '2026-09-02',
    tags: ['dishwasher', 'kitchen'],
  },
  cooking: {
    dataset: 'm6gi-ng33',
    label: 'Residential electric cooking products',
    dateField: 'date_available_on_market',
    rows: 259,
    newestSeen: '2026-09-21',
    tags: ['oven', 'cooktop', 'kitchen'],
  },
  dehumidifiers: {
    dataset: 'mgiu-hu4z',
    label: 'Dehumidifiers',
    dateField: 'date_available_on_market',
    rows: 551,
    newestSeen: '2026-09-21',
    tags: ['dehumidifier', 'air'],
  },
  'room-air-conditioners': {
    dataset: '5xn2-dv4h',
    label: 'Room air conditioners',
    dateField: 'date_certified',
    rows: 515,
    newestSeen: '2026-09-09',
    tags: ['air-conditioner', 'hvac'],
  },
  'air-cleaners': {
    dataset: 'gaa3-swy6',
    label: 'Room air cleaners',
    dateField: 'date_certified',
    rows: 246,
    newestSeen: '2026-09-22',
    tags: ['air-cleaner', 'filter', 'air'],
  },
  'ceiling-fans': {
    dataset: '2te3-nmxp',
    label: 'Ceiling fans',
    dateField: 'date_qualified',
    rows: 1447,
    newestSeen: '2026-09-22',
    tags: ['fan'],
  },
  'ventilating-fans': {
    dataset: '8dv7-nngq',
    label: 'Ventilating fans',
    dateField: 'date_qualified',
    rows: 1139,
    newestSeen: '2026-09-23',
    tags: ['fan', 'ventilation'],
  },
  'water-heaters': {
    dataset: 'pbpq-swnu',
    label: 'Water heaters',
    dateField: 'date_certified',
    rows: 1252,
    newestSeen: '2026-09-16',
    tags: ['water-heater', 'plumbing'],
  },
  furnaces: {
    dataset: 'i97v-e8au',
    label: 'Furnaces',
    dateField: 'date_qualified',
    rows: 3523,
    newestSeen: '2026-09-23',
    tags: ['furnace', 'hvac'],
  },
  boilers: {
    dataset: '6rww-hpns',
    label: 'Boilers',
    dateField: 'date_qualified',
    rows: 658,
    newestSeen: '2026-09-21',
    tags: ['boiler', 'hvac'],
  },
  'heat-pumps': {
    dataset: '83eb-xbyy',
    label: 'Heat pumps',
    dateField: 'date_certified',
    rows: 284155,
    newestSeen: '2026-09-23',
    tags: ['heat-pump', 'hvac'],
  },
  'geothermal-heat-pumps': {
    dataset: 'acvd-5wvz',
    label: 'Geothermal heat pumps',
    dateField: 'date_qualified',
    rows: 4977,
    newestSeen: '2026-08-06',
    tags: ['heat-pump', 'geothermal', 'hvac'],
  },
  'smart-thermostats': {
    dataset: '7p2p-wkbf',
    label: 'Smart thermostats',
    dateField: 'date_qualified',
    rows: 120,
    newestSeen: '2026-09-16',
    tags: ['thermostat', 'hvac'],
  },
  'pool-pumps': {
    dataset: 'm8cf-pkii',
    label: 'Pool pumps',
    dateField: 'date_qualified',
    rows: 423,
    newestSeen: '2026-08-21',
    tags: ['pool-pump', 'pump'],
  },
  televisions: {
    dataset: 'pd96-rr3d',
    label: 'Televisions',
    dateField: 'date_qualified',
    rows: 182,
    newestSeen: '2026-09-16',
    tags: ['television', 'electronics'],
  },
  'water-coolers': {
    dataset: 'qsc8-7f7k',
    label: 'Water coolers',
    dateField: 'date_qualified',
    rows: 182,
    newestSeen: '2026-08-11',
    tags: ['water-cooler'],
  },
  'commercial-ice-machines': {
    dataset: 'nak5-fsjf',
    label: 'Commercial ice machines',
    dateField: 'date_qualified',
    rows: 645,
    newestSeen: '2026-09-14',
    tags: ['ice-machine', 'commercial'],
  },
  'commercial-dishwashers': {
    dataset: 'pk8q-dim8',
    label: 'Commercial dishwashers',
    dateField: 'date_available_on_market',
    rows: 418,
    newestSeen: '2026-07-20',
    tags: ['dishwasher', 'commercial'],
  },
  'commercial-clothes-washers': {
    dataset: '9g6r-cpdt',
    label: 'Commercial clothes washers',
    dateField: 'date_qualified',
    rows: 134,
    newestSeen: '2026-08-31',
    tags: ['washer', 'laundry', 'commercial'],
  },
};

export const CATALOGUE_KEYS = Object.keys(CATALOGUES);

/** Socrata writes a calendar_date as `2026-09-21T00:00:00.000`. */
export function esDate(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? m[1] : null;
}

/**
 * A measurement, or nothing.
 *
 * A blank cell must not become zero: a refrigerator using 0 kWh a year would
 * top every "most efficient" feed this collection ever publishes, and it would
 * be an artefact of an empty string rather than a fact about the appliance.
 */
export function num(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * A UPC as printed, or nothing.
 *
 * The column is free text and arrives variously as `761101155524`, with
 * separators, or as a list when one model ships in several boxes. Only the
 * digits are kept, and only at a length a GTIN actually has — otherwise a
 * truncated cell becomes a barcode that scans as some other product.
 */
export function upcList(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return [];
  const seen = new Set();
  for (const part of s.split(/[,;/|\s]+/)) {
    const digits = part.replace(/\D/g, '');
    if ([8, 12, 13, 14].includes(digits.length)) seen.add(digits);
  }
  return [...seen];
}

/** The specification fields worth keeping, whatever the category calls them. */
export function specOf(row) {
  const pick = (...keys) => {
    for (const k of keys) {
      const v = num(row[k]);
      if (v !== null) return v;
    }
    return null;
  };
  return {
    annualEnergyKwh: pick('annual_energy_use_kwh_yr', 'estimated_annual_energy_use_kwh_yr'),
    capacityFt3: pick('capacity_total_volume_ft3', 'capacity_ft3', 'total_volume_ft3'),
    heightIn: pick('height_in'),
    widthIn: pick('width_in'),
    depthIn: pick('depth_in'),
    percentBetterThanStandard: pick('percent_less_energy_use_than_us_federal_standard'),
  };
}

export function toItem(row, catalogueKey) {
  const cat = CATALOGUES[catalogueKey];
  if (!cat) return null;

  const brand = String(row.brand_name ?? '').trim();
  const model = String(row.model_number ?? '').trim();
  if (!model) return null;

  const id = String(row.pd_id ?? row.energy_star_model_identifier ?? '').trim();
  if (!id) return null;

  const when = esDate(row[cat.dateField]);
  const spec = specOf(row);
  const upcs = upcList(row.upc);
  const type = String(row.type ?? row.product_type ?? '').trim();

  const bits = [
    type || null,
    spec.capacityFt3 ? `${spec.capacityFt3} ft³` : null,
    spec.annualEnergyKwh ? `${spec.annualEnergyKwh} kWh/yr` : null,
    spec.percentBetterThanStandard
      ? `${spec.percentBetterThanStandard}% below the federal standard`
      : null,
  ].filter(Boolean);

  return {
    externalId: `${catalogueKey}-${id}`,
    kind: 'appliance-model',
    title: [brand, model].filter(Boolean).join(' ') || model,
    summary:
      `${cat.label}${brand ? ` from ${brand}` : ''}, model ${model}` +
      (bits.length ? `. ${bits.join(', ')}.` : '.') +
      (upcs.length ? ` UPC ${upcs.join(', ')}.` : ''),
    /*
     * The product finder's model page. It is a client-rendered route, so it
     * answers 200 with an empty shell for any id at all and cannot be checked
     * from here — the id is carried in `data.pdId` as well, which is what a
     * consumer should join on rather than parsing this back out.
     */
    url: `https://www.energystar.gov/productfinder/product/certified-${slugify(cat.label)}/details/${encodeURIComponent(id)}`,
    publishedAt: when,
    timeKnown: false,
    precision: 'day',
    tags: ['appliance', 'model', catalogueKey, ...cat.tags, ...(brand ? [slugify(brand)] : [])],
    data: {
      pdId: row.pd_id ?? null,
      energyStarModelIdentifier: row.energy_star_model_identifier ?? null,
      brand: brand || null,
      modelNumber: model,
      additionalModels: row.additional_model_information ?? null,
      catalogue: catalogueKey,
      category: cat.label,
      productType: type || null,
      productClass: row.product_class ?? null,
      upcs,
      spec,
      markets: row.markets ?? null,
      mostEfficient: row.meets_most_efficient_criteria === 'Yes',
      dateAvailableOnMarket: esDate(row.date_available_on_market),
      dateQualified: esDate(row.date_qualified),
      dateCertified: esDate(row.date_certified),
      source: 'EPA ENERGY STAR certified product data (public domain)',
      dataset: `https://${DOMAIN}/resource/${cat.dataset}.json`,
    },
  };
}

/** The `$where` that resumes an incremental run, or nothing on a first walk. */
export function sinceClause(field, highWater) {
  if (!highWater) return null;
  // `>=` rather than `>`: these are dates, not timestamps, so a model added
  // later the same day would fall through a strict comparison and never be
  // seen. Upserts are idempotent, so re-reading a day costs no writes.
  return `${field} >= '${highWater}T00:00:00.000'`;
}

export const energyStarModels = defineAdapter({
  name: 'energystar-models',
  title: 'Appliance models (ENERGY STAR)',
  collection: 'parts',
  description:
    'Brand, model number, UPC and specification for every appliance certified under ENERGY STAR: refrigerators, washers, dryers, dishwashers, water heaters, furnaces, heat pumps and more. The model layer a parts catalogue joins to. Keyless, public domain, rewritten daily by the EPA.',
  docs: 'https://www.energystar.gov/productfinder/advanced',
  kinds: ['appliance-model'],
  // The EPA rewrites the datasets daily; once a day finds new models the
  // morning they land.
  cadenceMinutes: 60 * 24,
  configFields: [
    {
      key: 'catalogues',
      label: 'Catalogues',
      type: 'list',
      help: `Empty for all of: ${CATALOGUE_KEYS.join(', ')}`,
    },
    {
      key: 'appToken',
      label: 'Socrata app token',
      help: 'Optional. The API is keyless; a free token only raises the shared rate limit.',
    },
  ],
  defaults: {},
  defaultSources: [{ slug: 'energystar-appliances', name: 'Appliance models, all categories' }],
  async *pull({ config, cursor, http, log, deadline }) {
    const wanted = (Array.isArray(config.catalogues) ? config.catalogues : [])
      .map((s) => String(s).trim())
      .filter((s) => CATALOGUE_KEYS.includes(s));
    const keys = wanted.length ? wanted : CATALOGUE_KEYS;

    const state = { ...(cursor?.catalogues ?? {}) };
    const headers = { accept: 'application/json' };
    if (config.appToken) headers['X-App-Token'] = String(config.appToken);

    let wrote = 0;

    for (const key of keys) {
      const cat = CATALOGUES[key];
      const prior = state[key] ?? {};
      // A completed walk switches to reading only the newest slice; an
      // interrupted one resumes from the offset it reached.
      let offset = prior.complete ? 0 : (prior.offset ?? 0);
      const since = prior.complete ? sinceClause(cat.dateField, prior.highWater) : null;
      let highWater = prior.highWater ?? null;

      for (;;) {
        if (Date.now() > deadline) {
          log(`deadline reached during ${key}`);
          return { cursor: { catalogues: state }, note: `${wrote} model(s), stopped at ${key}` };
        }

        const params = new URLSearchParams({
          $limit: String(PAGE),
          $offset: String(offset),
          $order: `${cat.dateField} DESC`,
        });
        if (since) params.set('$where', since);

        const url = `https://${DOMAIN}/resource/${cat.dataset}.json?${params}`;
        const rows = await http.json(url, { headers, timeoutMs: 45_000 });

        if (!Array.isArray(rows)) throw new Error(`${key}: expected an array of rows`);

        /*
         * An empty first page is the failure worth catching. Socrata answers a
         * `$where` on a column the dataset does not have with 200 and `[]`, so
         * a renamed date column presents as a category nobody certified rather
         * than as an error. On a first walk that is always wrong — every
         * preset here was measured with rows in it.
         */
        if (!rows.length && offset === 0 && !since) {
          throw new Error(
            `${key}: ${cat.dataset} returned no rows ordered by ${cat.dateField}; the dataset had ${cat.rows} rows on 2026-09-25, so the column has probably been renamed`,
          );
        }

        const items = [];
        for (const row of rows) {
          const item = toItem(row, key);
          if (!item) continue;
          items.push(item);
          if (item.publishedAt && (!highWater || item.publishedAt > highWater)) {
            highWater = item.publishedAt;
          }
        }

        offset += rows.length;
        const done = rows.length < PAGE;
        state[key] = done ? { complete: true, highWater } : { offset, highWater };
        wrote += items.length;

        if (items.length) yield { items, cursor: { catalogues: state } };
        if (done) break;
      }

      log(`${key}: through ${state[key].highWater ?? 'unknown'}`);
    }

    return { cursor: { catalogues: state }, note: `${wrote} appliance model(s)` };
  },
});
