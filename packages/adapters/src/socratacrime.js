import { defineAdapter, slugify } from '@nichedb/core/adapter';

/**
 * City crime reports, from the open-data portals police departments publish to.
 *
 * There is no national feed of US crime incidents. The FBI publishes annual
 * aggregates a year late; what exists at the level of "somebody was robbed on
 * this street on Tuesday" is a per-city open-data portal, and a good number of
 * those run on Socrata, which speaks one query language across every city that
 * uses it.
 *
 * So this is one adapter with a field map per city rather than a file per city.
 * The portals agree on nothing: Chicago calls the offence `primary_type` and
 * the date `date`, Seattle calls them `offense_category` and `offense_date`,
 * Los Angeles calls them `nibr_description` and `date_occ` and puts the
 * coordinates in `hndrdth_lat`. A preset is nine strings, and a city nobody
 * has added yet is nine strings in a source's config rather than a pull
 * request.
 *
 * Every row is stamped with country, state, city and — where the portal gives
 * one — neighbourhood and coordinates, so the collection can be read as
 * "burglaries in Seattle" or "everything in Illinois" rather than only as one
 * undifferentiated stream.
 *
 * On which cities are here. Every preset below was queried on 2026-09-08 and
 * carries the date of the most recent incident it actually returned, because a
 * crime portal that stopped publishing does not announce it and looks exactly
 * like a quiet week. Four cities were dropped for that reason rather than
 * shipped as feeds that would never move: Los Angeles and Cincinnati are here
 * on their replacement datasets after their old ones were retired, and New
 * Orleans (last incident 2017) and Austin (2025, in a text date column) have
 * no live dataset to point at.
 */

/**
 * A city's portal, and what it calls things.
 *
 * `newestSeen` is the most recent incident date the dataset returned when the
 * preset was written. It is documentation rather than logic: it is what makes
 * a dataset that has quietly stopped checkable later against what it used to
 * do, instead of a guess about whether a portal was always this slow.
 */
export const CITIES = {
  chicago: {
    city: 'Chicago',
    state: 'IL',
    domain: 'data.cityofchicago.org',
    dataset: 'ijzp-q8t2',
    idField: 'id',
    dateField: 'date',
    offenseField: 'primary_type',
    descriptionField: 'description',
    addressField: 'block',
    latField: 'latitude',
    lonField: 'longitude',
    areaField: 'community_area',
    newestSeen: '2026-08-30',
  },
  'new-york': {
    city: 'New York',
    state: 'NY',
    domain: 'data.cityofnewyork.us',
    dataset: '5uac-w243',
    idField: 'cmplnt_num',
    dateField: 'cmplnt_fr_dt',
    offenseField: 'ofns_desc',
    descriptionField: 'pd_desc',
    addressField: 'boro_nm',
    latField: 'latitude',
    lonField: 'longitude',
    areaField: 'boro_nm',
    // The NYPD publishes this one in quarterly batches, so ten weeks behind is
    // the dataset working normally rather than the dataset having stopped.
    newestSeen: '2026-06-30',
    cadence: 'quarterly',
  },
  'los-angeles': {
    city: 'Los Angeles',
    state: 'CA',
    domain: 'data.lacity.org',
    // The LAPD's NIBRS dataset. Their long-running "Crime Data from 2020 to
    // Present" was renamed "2020 to 2024" and stopped at the end of 2024 when
    // they moved to NIBRS reporting; pointing at it would have been a feed
    // that had already been dead for twenty-one months.
    dataset: 'k7nn-b2ep',
    idField: 'uniquenibrno',
    dateField: 'date_occ',
    offenseField: 'nibr_description',
    descriptionField: 'premis_desc',
    addressField: 'hndrdth_loc_chk',
    latField: 'hndrdth_lat',
    lonField: 'hndrdth_lon',
    areaField: 'area_name',
    newestSeen: '2026-08-22',
  },
  seattle: {
    city: 'Seattle',
    state: 'WA',
    domain: 'data.seattle.gov',
    dataset: 'tazs-3rd5',
    idField: 'offense_id',
    dateField: 'offense_date',
    offenseField: 'offense_category',
    descriptionField: 'nibrs_offense_code_description',
    addressField: 'block_address',
    latField: 'latitude',
    lonField: 'longitude',
    areaField: 'neighborhood',
    newestSeen: '2026-09-06',
  },
  'san-francisco': {
    city: 'San Francisco',
    state: 'CA',
    domain: 'data.sfgov.org',
    dataset: 'wg3w-h783',
    idField: 'row_id',
    dateField: 'incident_datetime',
    offenseField: 'incident_category',
    descriptionField: 'incident_description',
    addressField: 'intersection',
    latField: 'latitude',
    lonField: 'longitude',
    areaField: 'analysis_neighborhood',
    newestSeen: '2026-09-06',
  },
  dallas: {
    city: 'Dallas',
    state: 'TX',
    domain: 'www.dallasopendata.com',
    dataset: 'qv6i-rri7',
    // One Dallas incident carries several offence rows and `incidentnum` is
    // shared between them (780 unique in a thousand); `servnumid` is the
    // per-offence id and is genuinely unique.
    idField: 'servnumid',
    dateField: 'date1',
    offenseField: 'nibrs_crime',
    descriptionField: 'offincident',
    addressField: 'incident_address',
    latField: null,
    lonField: null,
    areaField: 'division',
    newestSeen: '2026-09-06',
  },
  cincinnati: {
    city: 'Cincinnati',
    state: 'OH',
    domain: 'data.cincinnati-oh.gov',
    // Their newer STARS dataset. The older "PDI Crime Incidents" table is
    // still updated as a table but its most recent incident was January.
    dataset: '7aqy-xrv9',
    idField: 'incident_no',
    // Cincinnati has no unique column: one incident number covers every
    // offence charged in it, so the offence is part of the key. Same shape as
    // Dallas's servnumid, spelled differently.
    keyFields: ['stars_category'],
    dateField: 'datereported',
    offenseField: 'stars_category',
    descriptionField: 'type',
    addressField: 'address_x',
    latField: 'latitude_x',
    lonField: 'longitude_x',
    areaField: 'cpd_neighborhood',
    newestSeen: '2026-09-06',
  },
};

export const CITY_KEYS = Object.keys(CITIES);

/**
 * Reduce a portal's offence wording to something comparable between cities.
 *
 * Chicago says `THEFT`, Seattle says `Larceny-Theft`, Los Angeles says
 * `459.5(A) - PC - M - Petty Theft - Shoplifting - 23C`. Nobody can follow
 * "theft everywhere" across those without a shared vocabulary, so each row
 * gets a coarse category alongside the portal's own words, which are always
 * kept intact. The mapping is deliberately blunt: it is a filter, not a
 * reclassification of anybody's crime statistics, and the payload says so.
 */
const CATEGORIES = [
  [/homicid|murder|manslaughter/i, 'homicide'],
  [/\brape\b|sex offense|sexual|sodomy|prostitut/i, 'sex-offense'],
  [/robbery/i, 'robbery'],
  [/aggravated assault|assault|battery/i, 'assault'],
  [/burglary|breaking/i, 'burglary'],
  [/motor vehicle theft|stolen vehicle|auto theft|vehicle theft/i, 'vehicle-theft'],
  [/theft|larceny|shoplift|pickpocket|purse/i, 'theft'],
  [/arson/i, 'arson'],
  [/weapon|firearm|shots fired/i, 'weapons'],
  [/narcotic|drug|controlled substance/i, 'drugs'],
  [/fraud|forgery|embezzle|counterfeit|identity/i, 'fraud'],
  [/vandal|criminal damage|mischief|destruction/i, 'vandalism'],
  [/kidnap|abduct/i, 'kidnapping'],
  [/dui|driving under|intoxicat/i, 'dui'],
  [/traffic|collision/i, 'traffic'],
  [/trespass/i, 'trespass'],
  [/disorderly|disturbance|nuisance|noise/i, 'disorder'],
];

export function categorise(text) {
  const s = String(text ?? '');
  for (const [re, name] of CATEGORIES) if (re.test(s)) return name;
  return 'other';
}

/** Portals write dates half a dozen ways. Keep whatever parses, say nothing otherwise. */
export function crimeDate(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  // "2026-09-06 00:00:00.0000000" is a timestamp with more precision than
  // Date understands; "12/31/2025  23:59" is a US date in a text column.
  const iso = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(:\d{2})?)/.exec(s);
  if (iso) return `${iso[1]}T${iso[2].length === 5 ? `${iso[2]}:00` : iso[2]}`;
  const dateOnly = /^(\d{4}-\d{2}-\d{2})$/.exec(s);
  if (dateOnly) return dateOnly[1];
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/.exec(s);
  if (us) {
    const p = (n) => String(n).padStart(2, '0');
    return `${us[3]}-${p(us[1])}-${p(us[2])}${us[4] ? `T${p(us[4])}:${us[5]}:00` : ''}`;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * A coordinate, or nothing.
 *
 * Portals put several kinds of not-a-coordinate in a coordinate column.
 * Seattle writes the literal string `REDACTED` for a quarter of its rows,
 * because the address was withheld, and `-1` for a few dozen more. Both parse
 * as "there is a number here" under a careless read: `Number('REDACTED')` is
 * NaN, which is caught, but `-1` is a perfectly finite number that would have
 * pinned hundreds of Seattle crimes to a point in the Atlantic off Africa.
 * So the value has to be both a number and somewhere a crime could be.
 */
const num = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return null;
  // Null Island and the -1 sentinel are the two ways portals spell "unknown".
  if (Math.abs(n) <= 1) return null;
  if (Math.abs(n) > 180) return null;
  return n;
};

/**
 * Placeholders portals put in text columns when they have nothing.
 *
 * `FK ERROR` is a foreign-key failure that reached publication in Seattle's
 * address column. Printed as an address it reads as a place name.
 */
const JUNK = /^(redacted|unknown|not available|n\/a|none|null|fk error|-)$/i;

/** Portals pad fixed-width columns: "Central             ". */
const clean = (v) => {
  const s = String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return !s || JUNK.test(s) ? null : s;
};

export function toItem(row, place) {
  const id = clean(row[place.idField]) ?? null;
  const when = crimeDate(row[place.dateField]);
  const offense = clean(row[place.offenseField]);
  const description = place.descriptionField ? clean(row[place.descriptionField]) : null;
  if (!id || !when || !offense) return null;

  const address = place.addressField ? clean(row[place.addressField]) : null;
  const area = place.areaField ? clean(row[place.areaField]) : null;
  const lat = place.latField ? num(row[place.latField]) : null;
  const lon = place.lonField ? num(row[place.lonField]) : null;
  const category = categorise(`${offense} ${description ?? ''}`);
  const city = place.city;
  const state = place.state;

  // The portal's id, plus whatever else it takes to be unique there. Most
  // cities have a genuinely per-offence id; Cincinnati's covers the whole
  // incident, so the offence joins the key rather than three charges from one
  // burglary collapsing into a single row and overwriting each other.
  const keyExtra = (place.keyFields ?? [])
    .map((f) => slugify(clean(row[f]) ?? ''))
    .filter(Boolean)
    .join('-');

  return {
    // City plus the portal's own incident id. Two cities can and do issue the
    // same case number, so the city has to be part of the key.
    externalId: `${slugify(city)}-${id}${keyExtra ? `-${keyExtra}` : ''}`,
    kind: 'crime-report',
    title: `${offense}${address ? ` — ${address}` : ''}, ${city}`,
    summary: [
      `${offense}${description && description !== offense ? ` (${description})` : ''}`,
      `reported in ${area ? `${area}, ` : ''}${city}, ${state}`,
      address ? `at ${address}` : null,
      `on ${String(when).slice(0, 10)}`,
    ]
      .filter(Boolean)
      .join(' ')
      .concat('.'),
    url: `https://${place.domain}/resource/${place.dataset}.json?${place.idField}=${encodeURIComponent(id)}`,
    publishedAt: when,
    // Portals report the day reliably and the minute less so.
    timeKnown: String(when).includes('T'),
    precision: String(when).includes('T') ? 'minute' : 'day',
    tags: [
      'crime',
      'us',
      state.toLowerCase(),
      slugify(city),
      category,
      slugify(offense).slice(0, 40),
      area ? slugify(area).slice(0, 40) : null,
    ].filter(Boolean),
    data: {
      // The shape every crime row in this collection shares, whichever country
      // and portal it came from, so a reader can filter without knowing which.
      place: {
        country: 'US',
        state,
        city,
        area,
        address,
        lat,
        lon,
      },
      incidentId: id,
      offense,
      description,
      category,
      categoryBasis: 'nichedb-coarse-mapping',
      categoryNote:
        'A coarse category derived from the portal’s own wording so incidents can be compared between cities. The department’s original classification is kept in `offense` and is the authoritative one.',
      occurredAt: when,
      source: `${city} open data (${place.domain})`,
      dataset: `https://${place.domain}/d/${place.dataset}`,
      // Everything the portal published, unprojected.
      raw: row,
    },
  };
}

/** A source's config, over its city preset. A city nobody added is all nine fields. */
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
    offenseField: pick('offenseField'),
    descriptionField: pick('descriptionField'),
    addressField: pick('addressField'),
    latField: pick('latField'),
    lonField: pick('lonField'),
    areaField: pick('areaField'),
    keyFields: preset.keyFields ?? [],
  };
}

export const socrataCrime = defineAdapter({
  name: 'socrata-crime',
  title: 'City crime reports (open data portals)',
  collection: 'crime',
  description:
    'Incident-level crime reports from the open-data portals US police departments publish to: Chicago, New York, Los Angeles, Seattle, San Francisco, Dallas and Cincinnati out of the box, and any other Socrata city by naming its dataset and field names. Every row carries city, state, neighbourhood and coordinates where the portal provides them. Keyless.',
  docs: 'https://dev.socrata.com/docs/queries/',
  kinds: ['crime-report'],
  cadenceMinutes: 60 * 3,
  configFields: [
    {
      key: 'city',
      label: 'City',
      type: 'select',
      options: ['', ...CITY_KEYS],
      help: 'One of the built-in cities, or leave empty and fill in the fields below for any other Socrata portal.',
    },
    { key: 'domain', label: 'Portal domain', placeholder: 'data.cityofchicago.org' },
    { key: 'dataset', label: 'Dataset id', placeholder: 'ijzp-q8t2' },
    { key: 'cityName', label: 'City name', placeholder: 'Chicago' },
    { key: 'state', label: 'State code', placeholder: 'IL' },
    { key: 'idField', label: 'Incident id field', placeholder: 'id' },
    { key: 'dateField', label: 'Date field', placeholder: 'date' },
    { key: 'offenseField', label: 'Offence field', placeholder: 'primary_type' },
    { key: 'descriptionField', label: 'Description field', placeholder: 'description' },
    { key: 'addressField', label: 'Address field', placeholder: 'block' },
    { key: 'latField', label: 'Latitude field', placeholder: 'latitude' },
    { key: 'lonField', label: 'Longitude field', placeholder: 'longitude' },
    { key: 'areaField', label: 'Neighbourhood field', placeholder: 'community_area' },
    {
      key: 'appToken',
      label: 'Socrata app token',
      help: 'Optional and free. Without one the portal rate-limits by IP, which is fine at this cadence.',
    },
  ],
  defaults: {},
  defaultSources: CITY_KEYS.map((key) => ({
    slug: `crime-${key}`,
    name: `Crime reports: ${CITIES[key].city}, ${CITIES[key].state}`,
    config: { city: key },
    // New York publishes quarterly; asking every three hours for a file that
    // moves four times a year is just noise in the run log.
    ...(CITIES[key].cadence === 'quarterly' ? { cadenceMinutes: 60 * 24 } : {}),
  })),
  async pull({ config, cursor, http, log }) {
    const place = placeFor(config);
    for (const required of ['domain', 'dataset', 'idField', 'dateField', 'offenseField']) {
      if (!place[required]) throw new Error(`socrata-crime needs ${required}`);
    }

    const limit = 1000;
    const params = new URLSearchParams({
      $limit: String(limit),
      $order: `${place.dateField} DESC`,
    });
    // Resume where the last run stopped. A portal that back-fills late rows
    // will not re-offer them, which is the trade for not re-reading the whole
    // table every three hours; the overlap below softens it.
    if (cursor.since) params.set('$where', `${place.dateField} > '${cursor.since}'`);

    const headers = { accept: 'application/json' };
    if (config.appToken) headers['X-App-Token'] = String(config.appToken);

    const url = `https://${place.domain}/resource/${place.dataset}.json?${params}`;
    let rows;
    try {
      rows = await http.json(url, { headers, timeoutMs: 60_000 });
    } catch (err) {
      // Some portals keep their date in a text column, where the comparison in
      // `$where` is either rejected or quietly meaningless. Falling back to a
      // plain newest-first read keeps the city working — the content hash
      // stops the re-read from writing anything — and says so once in the log
      // rather than failing the source every three hours.
      if (!cursor.since) throw err;
      log(`incremental query refused (${err.message}); re-reading newest ${limit}`);
      params.delete('$where');
      rows = await http.json(`https://${place.domain}/resource/${place.dataset}.json?${params}`, {
        headers,
        timeoutMs: 60_000,
      });
    }

    if (!Array.isArray(rows)) throw new Error('the portal did not return a list of rows');
    const items = rows.map((r) => toItem(r, place)).filter(Boolean);

    // The newest date seen, minus a small overlap, so a row filed a minute
    // either side of the boundary is not lost for ever.
    const dates = items
      .map((i) => i.publishedAt)
      .filter(Boolean)
      .sort();
    const newest = dates.at(-1) ?? cursor.since ?? null;

    log(`${items.length} incident(s) in ${place.city}${rows.length ? `, newest ${newest}` : ''}`);
    return {
      items,
      cursor: newest ? { since: newest } : cursor,
      note: `${items.length} in ${place.city}`,
    };
  },
});
