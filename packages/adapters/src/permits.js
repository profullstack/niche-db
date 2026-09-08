import { defineAdapter, slugify } from '@nichedb/core/adapter';

/**
 * Building permits: what is about to be built, before it is built.
 *
 * A permit is the earliest public signal that housing supply is changing. It
 * is filed months before a foundation is poured and years before anyone moves
 * in, which makes it the leading indicator the price series in this collection
 * are the lagging half of: prices tell you what happened, permits tell you
 * what is coming.
 *
 * Cities publish them on the same open-data portals the crime reports come
 * from, and agree on field names about as much — Chicago says `issue_date` and
 * `work_description`, Seattle says `issueddate` and `permittypedesc`, Los
 * Angeles says `issue_date` and puts its coordinates in `lat`/`lon`. So this
 * is one adapter with a field map per city, and a city nobody has added is a
 * source's config rather than a pull request.
 *
 * Every preset was queried on 2026-09-08 and carries the date of the most
 * recent permit it actually returned. New York was dropped for failing that
 * check: its job-application dataset is enormous and well known and has not
 * had a filing since June 2020, which looks exactly like a city that stopped
 * building rather than a dataset that stopped being written to.
 */

export const CITIES = {
  chicago: {
    city: 'Chicago',
    state: 'IL',
    domain: 'data.cityofchicago.org',
    dataset: 'ydr8-5enu',
    idField: 'id',
    dateField: 'issue_date',
    typeField: 'permit_type',
    descriptionField: 'work_description',
    streetNumberField: 'street_number',
    streetNameField: 'street_name',
    latField: 'latitude',
    lonField: 'longitude',
    statusField: 'permit_status',
    newestSeen: '2026-09-06',
  },
  'san-francisco': {
    city: 'San Francisco',
    state: 'CA',
    domain: 'data.sfgov.org',
    dataset: 'i98e-djp9',
    idField: 'permit_number',
    // A San Francisco permit number covers every record filed against that
    // permit, so it repeats; `record_id` is the individual row.
    keyFields: ['record_id'],
    dateField: 'filed_date',
    typeField: 'permit_type_definition',
    descriptionField: 'description',
    streetNumberField: 'street_number',
    streetNameField: 'street_name',
    costField: 'estimated_cost',
    statusField: 'status',
    unitsField: 'proposed_units',
    newestSeen: '2026-09-05',
  },
  seattle: {
    city: 'Seattle',
    state: 'WA',
    domain: 'data.seattle.gov',
    dataset: '76t5-zqzr',
    idField: 'permitnum',
    dateField: 'issueddate',
    typeField: 'permittypedesc',
    descriptionField: 'description',
    addressField: 'originaladdress1',
    latField: 'latitude',
    lonField: 'longitude',
    costField: 'estprojectcost',
    statusField: 'statuscurrent',
    unitsField: 'housingunits',
    classField: 'permitclassmapped',
    newestSeen: '2026-09-05',
  },
  'los-angeles': {
    city: 'Los Angeles',
    state: 'CA',
    domain: 'data.lacity.org',
    dataset: 'pi9x-tg5x',
    idField: 'permit_nbr',
    dateField: 'issue_date',
    typeField: 'permit_type',
    descriptionField: 'permit_sub_type',
    latField: 'lat',
    lonField: 'lon',
    areaField: 'cpa',
    classField: 'permit_group',
    newestSeen: '2026-09-05',
  },
};

export const CITY_KEYS = Object.keys(CITIES);

/**
 * What is being built, from whatever words the city used.
 *
 * A city's own permit type is kept intact; this is a coarse category so that
 * "new housing everywhere" is one query rather than four spellings of it.
 */
const CATEGORIES = [
  [/new construction|new building|erect|new single|new multi|newconst/i, 'new-construction'],
  [/demolit|wreck|raze/i, 'demolition'],
  [/addition|alter|remodel|renovat|repair|tenant improvement/i, 'alteration'],
  [/electrical/i, 'electrical'],
  [/plumb/i, 'plumbing'],
  [/mechanical|hvac|boiler/i, 'mechanical'],
  [/sign|awning/i, 'signage'],
  [/grading|excavat|shoring/i, 'sitework'],
  [/deck|fence|pool|garage|shed/i, 'accessory'],
  [/roof/i, 'roofing'],
];

export function categorise(text) {
  const s = String(text ?? '');
  for (const [re, name] of CATEGORIES) if (re.test(s)) return name;
  return 'other';
}

/** Portals write dates several ways; keep what parses. */
export function permitDate(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const iso = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(:\d{2})?)/.exec(s);
  if (iso) return `${iso[1]}T${iso[2].length === 5 ? `${iso[2]}:00` : iso[2]}`;
  const dateOnly = /^(\d{4}-\d{2}-\d{2})$/.exec(s);
  if (dateOnly) return dateOnly[1];
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (us) {
    const p = (n) => String(n).padStart(2, '0');
    return `${us[3]}-${p(us[1])}-${p(us[2])}`;
  }
  return null;
}

const JUNK = /^(unknown|not available|n\/a|none|null|-|0)$/i;

const clean = (v) => {
  const s = String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return !s || JUNK.test(s) ? null : s;
};

/** A coordinate, or nothing. Sentinels and Null Island are not locations. */
const coord = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || Math.abs(n) <= 1 || Math.abs(n) > 180) return null;
  return n;
};

/**
 * A project cost, or nothing.
 *
 * Guarded before the cast, because `Number(null)` is 0 and a permit reported
 * as a $0 project reads as a free one rather than as one with no cost stated.
 */
export function cost(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[$,]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function toItem(row, place) {
  const id = clean(row[place.idField]);
  const when = permitDate(row[place.dateField]);
  const type = clean(row[place.typeField]);
  if (!id || !when || !type) return null;

  const description = place.descriptionField ? clean(row[place.descriptionField]) : null;
  const address = place.addressField
    ? clean(row[place.addressField])
    : [
        clean(row[place.streetNumberField]),
        clean(row[place.streetDirectionField]),
        clean(row[place.streetNameField]),
      ]
        .filter(Boolean)
        .join(' ') || null;
  const value = place.costField ? cost(row[place.costField]) : null;
  const units = place.unitsField ? cost(row[place.unitsField]) : null;
  const category = categorise(`${type} ${description ?? ''} ${row[place.classField] ?? ''}`);
  const status = place.statusField ? clean(row[place.statusField]) : null;
  // Whatever else it takes to be unique on this portal. Most cities issue one
  // row per permit; San Francisco issues one per record against a permit, so
  // without the record id its revisions collapse into a single overwritten row.
  const keyExtra = (place.keyFields ?? [])
    .map((f) => slugify(clean(row[f]) ?? ''))
    .filter(Boolean)
    .join('-');

  return {
    externalId: `permit-${slugify(place.city)}-${id}${keyExtra ? `-${keyExtra}` : ''}`,
    kind: 'building-permit',
    title: `${type}${address ? ` — ${address}` : ''}, ${place.city}${value ? ` (${money(value)})` : ''}`,
    summary: [
      `${type}${description && description !== type ? `: ${description}` : ''}`,
      `permitted in ${place.city}, ${place.state}`,
      address ? `at ${address}` : null,
      `on ${String(when).slice(0, 10)}`,
      value ? `. Estimated project cost ${money(value)}` : null,
      units ? `. ${units} housing unit${units === 1 ? '' : 's'}` : null,
    ]
      .filter(Boolean)
      .join(' ')
      .replace(' .', '.')
      .concat('.'),
    url: `https://${place.domain}/resource/${place.dataset}.json?${place.idField}=${encodeURIComponent(id)}`,
    publishedAt: when,
    timeKnown: String(when).includes('T'),
    precision: String(when).includes('T') ? 'minute' : 'day',
    tags: [
      'housing',
      'us',
      'permit',
      place.state.toLowerCase(),
      slugify(place.city),
      category,
      slugify(type).slice(0, 40),
      units ? 'housing-units' : null,
      value && value >= 1e6 ? 'million-plus' : null,
    ].filter(Boolean),
    data: {
      place: {
        country: 'US',
        state: place.state,
        city: place.city,
        area: place.areaField ? clean(row[place.areaField]) : null,
        address,
        lat: place.latField ? coord(row[place.latField]) : null,
        lon: place.lonField ? coord(row[place.lonField]) : null,
      },
      permitId: id,
      permitType: type,
      description,
      category,
      categoryBasis: 'nichedb-coarse-mapping',
      categoryNote:
        'A coarse category derived from the city’s own wording so permits can be compared between cities. The city’s classification is kept in `permitType` and is the authoritative one.',
      status,
      estimatedCost: value,
      housingUnits: units,
      filedAt: when,
      source: `${place.city} open data (${place.domain})`,
      dataset: `https://${place.domain}/d/${place.dataset}`,
      raw: row,
    },
  };
}

function money(n) {
  if (!Number.isFinite(n)) return null;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}bn`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}m`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}k`;
  return `$${Math.round(n)}`;
}

/** A source's config over its city preset. */
export function placeFor(config) {
  const preset = CITIES[String(config.city ?? '').toLowerCase()] ?? {};
  const pick = (k, fallback = null) => {
    const v = config[k];
    return v === undefined || v === '' ? (preset[k] ?? fallback) : v;
  };
  return {
    city: pick('cityName', preset.city ?? config.city ?? 'Unknown'),
    state: pick('state', preset.state ?? ''),
    domain: pick('domain'),
    dataset: pick('dataset'),
    idField: pick('idField'),
    dateField: pick('dateField'),
    typeField: pick('typeField'),
    descriptionField: pick('descriptionField'),
    addressField: pick('addressField'),
    streetNumberField: pick('streetNumberField'),
    streetDirectionField: pick('streetDirectionField'),
    streetNameField: pick('streetNameField'),
    latField: pick('latField'),
    lonField: pick('lonField'),
    costField: pick('costField'),
    statusField: pick('statusField'),
    unitsField: pick('unitsField'),
    areaField: pick('areaField'),
    classField: pick('classField'),
    keyFields: preset.keyFields ?? [],
  };
}

export const buildingPermits = defineAdapter({
  name: 'building-permits',
  title: 'Building permits',
  collection: 'housing',
  description:
    'Building permits as cities issue them: what is being built, where, what it is expected to cost and how many homes it adds. The leading indicator of housing supply, filed months before ground is broken. Chicago, San Francisco, Seattle and Los Angeles out of the box, and any other Socrata city by naming its dataset and fields. Keyless.',
  docs: 'https://dev.socrata.com/docs/queries/',
  kinds: ['building-permit'],
  cadenceMinutes: 60 * 6,
  configFields: [
    {
      key: 'city',
      label: 'City',
      type: 'select',
      options: ['', ...CITY_KEYS],
      help: 'One of the built-in cities, or fill in the fields below for another Socrata portal.',
    },
    { key: 'domain', label: 'Portal domain' },
    { key: 'dataset', label: 'Dataset id' },
    { key: 'cityName', label: 'City name' },
    { key: 'state', label: 'State code' },
    { key: 'idField', label: 'Permit id field' },
    { key: 'dateField', label: 'Date field' },
    { key: 'typeField', label: 'Permit type field' },
    { key: 'descriptionField', label: 'Description field' },
    { key: 'addressField', label: 'Address field' },
    { key: 'costField', label: 'Estimated cost field' },
    { key: 'minimumCost', label: 'Minimum project cost', type: 'number' },
    { key: 'appToken', label: 'Socrata app token', help: 'Optional and free.' },
  ],
  defaults: {},
  defaultSources: [
    ...CITY_KEYS.map((key) => ({
      slug: `permits-${key}`,
      name: `Building permits: ${CITIES[key].city}, ${CITIES[key].state}`,
      config: { city: key },
    })),
    {
      slug: 'permits-big-projects',
      name: 'Building permits over $1m (Seattle)',
      config: { city: 'seattle', minimumCost: 1_000_000 },
      cadenceMinutes: 60 * 12,
    },
  ],
  async pull({ config, cursor, http, log }) {
    const place = placeFor(config);
    for (const required of ['domain', 'dataset', 'idField', 'dateField', 'typeField']) {
      if (!place[required]) throw new Error(`building-permits needs ${required}`);
    }

    const limit = 1000;
    /* Socrata omits a null field from its JSON entirely rather than sending
     * null, and it sorts nulls to the front on a DESC order. A dataset where
     * most permits have not been issued yet therefore answers a newest-first
     * query with a page of rows that have no date key at all — which is not an
     * error and not empty, just useless. Seattle and San Francisco both do
     * this. Excluding the undated rows in the query is what makes both work,
     * and it costs nothing anywhere else: a permit with no date could not be
     * published as a dated item regardless. */
    const clauses = [`${place.dateField} IS NOT NULL`];
    if (cursor.since) clauses.push(`${place.dateField} > '${cursor.since}'`);
    const params = new URLSearchParams({
      $limit: String(limit),
      $order: `${place.dateField} DESC`,
      $where: clauses.join(' AND '),
    });

    const headers = { accept: 'application/json' };
    if (config.appToken) headers['X-App-Token'] = String(config.appToken);

    const url = `https://${place.domain}/resource/${place.dataset}.json?${params}`;
    let rows;
    try {
      rows = await http.json(url, { headers, timeoutMs: 60_000 });
    } catch (err) {
      // Some portals keep the date in a text column, where the comparison in
      // `$where` is rejected. A plain newest-first read keeps the city working
      // and the content hash stops it from writing anything twice.
      if (!cursor.since) throw err;
      log(`incremental query refused (${err.message}); re-reading newest ${limit}`);
      params.set('$where', `${place.dateField} IS NOT NULL`);
      rows = await http.json(`https://${place.domain}/resource/${place.dataset}.json?${params}`, {
        headers,
        timeoutMs: 60_000,
      });
    }
    if (!Array.isArray(rows)) throw new Error('the portal did not return a list of rows');

    const floor = Number(config.minimumCost) || 0;
    const items = rows
      .map((r) => toItem(r, place))
      .filter(Boolean)
      .filter((i) => !floor || (i.data.estimatedCost ?? 0) >= floor);

    const newest =
      items
        .map((i) => i.publishedAt)
        .filter(Boolean)
        .sort()
        .at(-1) ?? cursor.since;
    log(`${items.length} permit(s) in ${place.city}${newest ? `, newest ${newest}` : ''}`);
    return {
      items,
      cursor: newest ? { since: newest } : cursor,
      note: `${items.length} in ${place.city}`,
    };
  },
});
