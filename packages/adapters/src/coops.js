import { defineAdapter } from '@nichedb/core/adapter';

/**
 * The coast, measured: how high the water actually is at a NOAA tide station,
 * against the height at which that station floods.
 *
 * The river half of this collection has a flood category attached to every
 * reading because the National Weather Service assigns one. The coastal half
 * does not: `datagetter` returns a water level in feet and nothing else, and
 * whether 3.1 ft is a Tuesday or a flooded parking lot depends entirely on the
 * station. The thresholds exist, in a different service, one call per station:
 * `mdapi`'s `floodlevels` gives the minor, moderate and major heights for that
 * gauge.
 *
 * So the adapter reads the thresholds once and keeps them in its cursor. They
 * change when NOAA re-surveys a station, which is a thing that happens every
 * few years and not between two polls, so they are refreshed weekly and
 * otherwise cost nothing. This is what lets a reading be published as "Battery,
 * New York: minor coastal flooding, 10.6 ft, 0.1 ft over minor flood stage"
 * rather than as a number with no scale.
 *
 * WHAT GETS STORED
 *
 * Every reading at every configured station, not only the flooding ones. A
 * coastal water level is a continuous series whose ordinary values are what
 * make the extreme ones legible, there are around 300 stations rather than
 * 12,000, and each reading is one small row. The rivers adapter makes the
 * opposite choice for the opposite reason, and both notes say why.
 */

const DATA_URL = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter';
const META_URL = 'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations';

/**
 * The default station list: one gauge for each stretch of US coast that floods.
 *
 * Chosen so that a storm anywhere on the Atlantic, Gulf, Pacific or Great Lakes
 * shore shows up in at least one of them, and every id was confirmed to answer
 * `datagetter` with a water level and `floodlevels` with a threshold.
 */
export const DEFAULT_STATIONS = [
  '8418150', // Portland, ME
  '8443970', // Boston, MA
  '8461490', // New London, CT
  '8510560', // Montauk, NY
  '8518750', // The Battery, NY
  '8534720', // Atlantic City, NJ
  '8557380', // Lewes, DE
  '8574680', // Baltimore, MD
  '8594900', // Washington, DC
  '8638610', // Sewells Point, VA
  '8658120', // Wilmington, NC
  '8665530', // Charleston, SC
  '8670870', // Fort Pulaski, GA
  '8720218', // Mayport, FL
  '8723214', // Virginia Key, FL
  '8724580', // Key West, FL
  '8726520', // St Petersburg, FL
  '8729108', // Panama City, FL
  '8735180', // Dauphin Island, AL
  '8761724', // Grand Isle, LA
  '8770570', // Sabine Pass, TX
  '8771450', // Galveston Pier 21, TX
  '8779770', // Port Isabel, TX
  '9410170', // San Diego, CA
  '9410660', // Los Angeles, CA
  '9414290', // San Francisco, CA
  '9435380', // South Beach, OR
  '9447130', // Seattle, WA
  '9455920', // Anchorage, AK
  '9751639', // Christiansted, VI
  '9759110', // Magueyes Island, PR
  '1612340', // Honolulu, HI
];

const clean = (v) => {
  const s = String(v ?? '').trim();
  return s && s !== 'null' ? s : null;
};

export function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Worst first, because a reading over the major threshold is also over the minor one. */
const LEVELS = [
  ['major', 'major coastal flooding'],
  ['moderate', 'moderate coastal flooding'],
  ['minor', 'minor coastal flooding'],
  ['action', 'above its action stage'],
];

/**
 * Which flood threshold a reading has passed, if any.
 *
 * NOAA publishes two sets of thresholds per station, its own (`nos_*`) and the
 * National Weather Service's (`nws_*`), and they disagree by a few tenths of a
 * foot. The NWS set is preferred because it is the one the flood warnings in
 * this deployment's weather collection are written against, so a reading here
 * and an alert there agree about whether it is flooding.
 */
export function exceedance(level, thresholds) {
  if (level === null || !thresholds) return null;
  for (const [key, label] of LEVELS) {
    const t =
      num(thresholds[`nws_${key}`]) ?? num(thresholds[key]) ?? num(thresholds[`nos_${key}`]);
    if (t !== null && level >= t) {
      return { category: key, label, threshold: t, over: Number((level - t).toFixed(2)) };
    }
  }
  return null;
}

export function toItem({ station, name, state, lat, lon, reading, thresholds, datum, units }) {
  const level = num(reading?.v);
  const at = clean(reading?.t);
  if (level === null || !at) return null;

  /* datagetter writes `2026-09-09 17:06` with no zone marker at all, and it
   * answers in station local time or GMT depending on what was asked for. This
   * adapter always asks for GMT, so the Z is added here: left off, the stored
   * timestamp would be read as whatever zone the reader happened to be in, and
   * a Pacific gauge would appear to report eight hours before it did. */
  const when = `${at.replace(' ', 'T')}:00Z`;
  const flood = exceedance(level, thresholds);
  const unit = units === 'metric' ? 'm' : 'ft';

  return {
    externalId: `coops-${station}-${when}`,
    kind: 'water-level',
    title: `${name}: ${flood ? flood.label : 'water level'} ${level} ${unit}`,
    summary: [
      `${name}${state ? `, ${state}` : ''} measured ${level} ${unit} above ${datum}`,
      ` at ${when.replace('T', ' ').replace('Z', '')}Z`,
      flood
        ? `, which is ${flood.over} ${unit} over its ${flood.category} flood stage of ${flood.threshold} ${unit}.`
        : thresholds
          ? '. Below every flood threshold for this station.'
          : '. No flood thresholds are published for this station.',
    ].join(''),
    url: `https://tidesandcurrents.noaa.gov/stationhome.html?id=${station}`,
    publishedAt: when,
    timeKnown: true,
    precision: 'minute',
    tags: [
      'water',
      'coastal',
      'us',
      'water-level',
      `station:${station}`,
      state ? state.toLowerCase() : null,
      flood ? `flood:${flood.category}` : null,
      flood ? 'flooding' : null,
    ].filter(Boolean),
    data: {
      station,
      stationName: name,
      waterLevel: level,
      unit,
      datum,
      observedAt: when,
      floodCategory: flood?.category ?? null,
      floodThreshold: flood?.threshold ?? null,
      overThresholdBy: flood?.over ?? null,
      thresholds: thresholds ?? null,
      thresholdBasis: thresholds
        ? 'National Weather Service flood stages for this station where published, NOAA’s own otherwise.'
        : null,
      place: { country: 'US', state: state ?? null, lat, lon },
      source: 'NOAA Tides and Currents (CO-OPS)',
      dataset: DATA_URL,
    },
  };
}

export const coopsWaterLevels = defineAdapter({
  name: 'coops-water-levels',
  title: 'Coastal water levels',
  collection: 'water',
  description:
    'The observed water level at NOAA tide stations, measured against the height at which each station floods, so a reading arrives as “minor coastal flooding, 0.4 ft over stage” rather than as a bare number. Thirty-two gauges covering every US coast out of the box, or any station list. Keyless.',
  docs: 'https://api.tidesandcurrents.noaa.gov/api/prod/',
  kinds: ['water-level'],
  cadenceMinutes: 30,
  configFields: [
    { key: 'stations', label: 'Station ids', type: 'list', help: 'NOAA CO-OPS 7-digit ids.' },
    {
      key: 'floodingOnly',
      label: 'Only when flooding',
      type: 'select',
      options: ['', 'yes'],
      help: 'Keep only readings at or above a published flood threshold.',
    },
    {
      key: 'datum',
      label: 'Datum',
      type: 'select',
      options: ['', 'MLLW', 'MHHW', 'NAVD', 'STND'],
      help: 'MLLW unless set. The flood thresholds are published against MLLW.',
    },
  ],
  defaults: {},
  defaultSources: [
    { slug: 'coastal-water-levels', name: 'Coastal water levels: every US coast' },
    {
      slug: 'coastal-flooding',
      name: 'Coastal flooding only',
      config: { floodingOnly: 'yes' },
      cadenceMinutes: 15,
    },
  ],
  async pull({ config, cursor, http, log, deadline }) {
    const stations = (config.stations ?? []).map((s) => String(s).trim()).filter(Boolean);
    const list = stations.length ? stations : DEFAULT_STATIONS;
    const datum = clean(config.datum) ?? 'MLLW';
    const floodingOnly = String(config.floodingOnly ?? '') === 'yes';

    /* Thresholds are per station and effectively fixed, so they are read once
     * and carried in the cursor. Re-reading them on every run would triple the
     * request count for numbers that change when NOAA re-levels a benchmark. */
    const cached = cursor.thresholds ?? {};
    const fetchedAt = cursor.thresholdsAt ?? null;
    const stale = !fetchedAt || Date.now() - new Date(fetchedAt).getTime() > 7 * 24 * 3_600_000;
    const thresholds = { ...cached };

    /* The reading itself arrives with a station id, a name and coordinates and
     * no state at all, so `The Battery` would be published as a place in no
     * country. The station register carries the state and it is one request for
     * all 302 of them, so it is read with the thresholds and cached the same
     * way rather than asked per station. */
    let stationMeta = cursor.stationMeta ?? {};
    if (stale || !Object.keys(stationMeta).length) {
      const index = await http.jsonOrNull(`${META_URL}.json?type=waterlevels`, {
        timeoutMs: 60_000,
      });
      const rows = Array.isArray(index?.stations) ? index.stations : [];
      if (rows.length) {
        stationMeta = Object.fromEntries(
          rows.map((r) => [
            String(r.id),
            { name: clean(r.name), state: clean(r.state), lat: num(r.lat), lng: num(r.lng) },
          ]),
        );
      }
    }

    const items = [];
    let flooding = 0;
    for (const station of list) {
      if (Date.now() > deadline) {
        log(`out of time after ${items.length} station(s)`);
        break;
      }
      if (stale || thresholds[station] === undefined) {
        thresholds[station] =
          (await http.jsonOrNull(`${META_URL}/${station}/floodlevels.json`, {
            timeoutMs: 20_000,
          })) ?? null;
      }

      const params = new URLSearchParams({
        date: 'latest',
        station,
        product: 'water_level',
        datum,
        units: 'english',
        time_zone: 'gmt',
        format: 'json',
        application: 'nichedb',
      });
      const body = await http.jsonOrNull(`${DATA_URL}?${params}`, { timeoutMs: 20_000 });
      const reading = body?.data?.[0];
      // A station off line answers 200 with an `error` object rather than a
      // status, so an empty `data` is the normal way this fails and is not
      // worth a run failure.
      if (!reading) continue;

      const meta = stationMeta[station] ?? {};
      const item = toItem({
        station,
        name: clean(body?.metadata?.name) ?? meta.name ?? station,
        state: meta.state ?? null,
        lat: num(body?.metadata?.lat) ?? meta.lat ?? null,
        lon: num(body?.metadata?.lon) ?? meta.lng ?? null,
        reading,
        thresholds: thresholds[station],
        datum,
        units: 'english',
      });
      if (!item) continue;
      if (item.data.floodCategory) flooding += 1;
      if (floodingOnly && !item.data.floodCategory) continue;
      items.push(item);
    }

    log(`${items.length} reading(s), ${flooding} at or above a flood threshold`);
    return {
      items,
      cursor: {
        thresholds,
        stationMeta: stationMeta,
        thresholdsAt: stale ? new Date().toISOString() : fetchedAt,
      },
      note: `${items.length} readings, ${flooding} flooding`,
    };
  },
});
