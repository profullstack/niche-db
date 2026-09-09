import { defineAdapter } from '@nichedb/core/adapter';

/**
 * Every river gauge NOAA forecasts, and the ones that are in flood right now.
 *
 * The National Water Prediction Service publishes 12,000-odd gauges with an
 * observed stage, a forecast stage and, for each, the flood category that stage
 * falls in: none, action, minor, moderate, major. The National Weather Service
 * alert feed this deployment already reads says a county is under a flood
 * warning; this says which river, how high it is, and whether it is still
 * rising. They are different facts and only one of them has a number in it.
 *
 * WHY ONLY THE GAUGES IN FLOOD
 *
 * All 12,000 gauges are one 13 MB answer that takes the better part of a minute
 * to arrive, and on an ordinary day about thirty of them are above their action
 * stage. Storing the other 11,970 hourly would be a river-height archive, which
 * is a different product and one the USGS already runs. So a gauge earns a row
 * by being at or above its action stage, observed or forecast, and the rest are
 * counted in the run note and dropped.
 *
 * THE SENTINEL
 *
 * The API writes a missing reading as -999, not as null, and it does it in the
 * `primary` field that carries the stage in feet. A gauge out of service
 * therefore reads as a river 999 feet below datum unless the sentinel is caught,
 * and -999 is finite, so `Number.isFinite` does not catch it. Both are checked
 * here and the reading becomes null, which is what "we do not know" should look
 * like.
 */

/**
 * The bounding boxes a source polls.
 *
 * The API takes a bounding box and nothing else -- `state`, `wfo` and `rfc`
 * query parameters are accepted, ignored, and answered with all 12,000 gauges,
 * which is the kind of failure that looks like success -- so a region here is a
 * box, and the boxes tile the country.
 */
export const REGIONS = {
  northeast: { name: 'Northeast', bbox: [-80, 38.5, -66.5, 47.5] },
  southeast: { name: 'Southeast', bbox: [-89, 24, -75, 38.5] },
  'ohio-valley': { name: 'Ohio Valley', bbox: [-89, 36, -78, 43] },
  midwest: { name: 'Upper Midwest', bbox: [-104, 40, -84, 49.5] },
  south: { name: 'South', bbox: [-107, 25.5, -89, 40] },
  west: { name: 'West', bbox: [-125, 31, -104, 49.5] },
  alaska: { name: 'Alaska', bbox: [-170, 52, -130, 72] },
  'puerto-rico': { name: 'Puerto Rico and the Virgin Islands', bbox: [-68, 17, -64, 19] },
};

export const REGION_KEYS = Object.keys(REGIONS);

/** The categories that make a gauge worth a row, worst last. */
export const FLOOD_CATEGORIES = ['action', 'minor', 'moderate', 'major'];

const SEVERITY = {
  action: 'at its action stage',
  minor: 'in minor flood',
  moderate: 'in moderate flood',
  major: 'in major flood',
};

/**
 * A stage reading, or null.
 *
 * Two ways this reads a river that is not there. -999 is the API's "no
 * reading", and it is finite, so `Number.isFinite` waves it through as a river
 * 999 feet below datum. And `Number(null)` is 0, so an absent field waves
 * through as a gauge reading exactly zero. Both are guarded, because both
 * publish a number where there is no measurement.
 */
export function stage(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= -999) return null;
  return n;
}

/** The category, lowercased, or null for the several ways it says "nothing to report". */
export function category(raw) {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase();
  return FLOOD_CATEGORIES.includes(s) ? s : null;
}

/** A timestamp in the form a sentence wants it. */
const stamp = (iso) => `${iso.replace('T', ' ').slice(0, 16)}Z`;

/** A coordinate, or nothing. The same -999 sentinel turns up in the location. */
const coord = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && Math.abs(n) <= 180 && n > -999 ? n : null;
};

function place(gauge) {
  return {
    country: 'US',
    state: gauge.state?.abbreviation ?? null,
    stateName: gauge.state?.name ?? null,
    lat: coord(gauge.latitude),
    lon: coord(gauge.longitude),
    forecastOffice: gauge.wfo?.abbreviation ?? null,
    riverForecastCentre: gauge.rfc?.abbreviation ?? null,
  };
}

/**
 * One reading at one gauge: what the river is doing, or is forecast to do.
 *
 * Observed and forecast are separate rows on purpose. They answer different
 * questions -- "is it flooding" and "will it" -- and a forecast that turns out
 * wrong should stay in the record next to the observation that contradicted it,
 * not be overwritten by it.
 */
export function toItem(gauge, which) {
  const reading = gauge.status?.[which];
  const cat = category(reading?.floodCategory);
  const level = stage(reading?.primary);
  const at = reading?.validTime;
  if (!cat || level === null || !at || at.startsWith('0001-')) return null;

  const lid = String(gauge.lid ?? '').toUpperCase();
  if (!lid) return null;
  const when = new Date(at).toISOString();
  const unit = String(reading.primaryUnit ?? 'ft').trim();
  const name = String(gauge.name ?? lid).trim();
  const where = place(gauge);
  const observed = which === 'observed';

  return {
    externalId: `nwps-${observed ? 'obs' : 'fcst'}-${lid}-${when}`,
    kind: observed ? 'river-gauge' : 'river-forecast',
    title: `${name}${where.state ? `, ${where.state}` : ''}: ${
      observed ? SEVERITY[cat] : `forecast ${SEVERITY[cat]}`
    } at ${level} ${unit}`,
    summary: [
      `${name}${where.state ? ` in ${where.stateName ?? where.state}` : ''}`,
      observed
        ? `was ${SEVERITY[cat]} at ${level} ${unit} on ${stamp(when)}.`
        : `is forecast to be ${SEVERITY[cat]} at ${level} ${unit} at ${stamp(when)}.`,
      where.forecastOffice ? `Forecast office ${where.forecastOffice}.` : null,
    ]
      .filter(Boolean)
      .join(' '),
    url: `https://water.noaa.gov/gauges/${lid}`,
    publishedAt: when,
    timeKnown: true,
    precision: 'minute',
    tags: [
      'water',
      'flood',
      'us',
      observed ? 'observed' : 'forecast',
      `flood:${cat}`,
      where.state ? where.state.toLowerCase() : null,
      where.riverForecastCentre ? where.riverForecastCentre.toLowerCase() : null,
      cat === 'major' || cat === 'moderate' ? 'significant-flooding' : null,
    ].filter(Boolean),
    data: {
      gaugeId: lid,
      gaugeName: name,
      reading: observed ? 'observed' : 'forecast',
      floodCategory: cat,
      stage: level,
      stageUnit: unit,
      secondary: stage(reading.secondary),
      secondaryUnit: String(reading.secondaryUnit ?? '').trim() || null,
      validTime: when,
      place: where,
      categoryBasis: 'NWS flood categories for this gauge',
      source: 'NOAA National Water Prediction Service',
      dataset: 'https://api.water.noaa.gov/nwps/v1/gauges',
    },
  };
}

export const nwpsRiverGauges = defineAdapter({
  name: 'nwps-river-gauges',
  title: 'River gauges in flood',
  collection: 'water',
  description:
    'Every NOAA-forecast river gauge at or above its action stage, observed and forecast, with the height in feet and the flood category the National Weather Service assigns it. The number behind a flood warning. Keyless.',
  docs: 'https://api.water.noaa.gov/nwps/v1/docs/',
  kinds: ['river-gauge', 'river-forecast'],
  cadenceMinutes: 60,
  configFields: [
    {
      key: 'region',
      label: 'Region',
      type: 'select',
      options: ['', ...REGION_KEYS],
      help: 'One of the built-in regions, or give a bounding box below.',
    },
    { key: 'bbox', label: 'Bounding box', help: 'minLon,minLat,maxLon,maxLat' },
    {
      key: 'minimumCategory',
      label: 'Minimum flood category',
      type: 'select',
      options: ['', ...FLOOD_CATEGORIES],
      help: 'Empty means action stage and above.',
    },
  ],
  defaults: {},
  defaultSources: REGION_KEYS.map((key) => ({
    slug: `river-gauges-${key}`,
    name: `River gauges in flood: ${REGIONS[key].name}`,
    config: { region: key },
  })),
  async pull({ config, cursor, http, log }) {
    const bbox = boxFor(config);
    if (!bbox) throw new Error('nwps-river-gauges needs a region or a bounding box');
    const [xmin, ymin, xmax, ymax] = bbox;
    const url =
      `https://api.water.noaa.gov/nwps/v1/gauges?srid=EPSG_4326` +
      `&bbox.xmin=${xmin}&bbox.ymin=${ymin}&bbox.xmax=${xmax}&bbox.ymax=${ymax}`;

    const body = await http.json(url, { timeoutMs: 120_000 });
    const gauges = Array.isArray(body?.gauges) ? body.gauges : null;
    if (!gauges) throw new Error('the NWPS API did not return a gauge list');

    const floor = category(config.minimumCategory);
    const atLeast = floor ? FLOOD_CATEGORIES.indexOf(floor) : 0;
    const items = gauges
      .flatMap((g) => [toItem(g, 'observed'), toItem(g, 'forecast')])
      .filter(Boolean)
      .filter((i) => FLOOD_CATEGORIES.indexOf(i.data.floodCategory) >= atLeast);

    const newest =
      items
        .map((i) => i.publishedAt)
        .filter(Boolean)
        .sort()
        .at(-1) ?? cursor.since;
    log(`${items.length} gauge reading(s) at or above action stage, of ${gauges.length} gauges`);
    return {
      items,
      cursor: { since: newest ?? null },
      note: `${items.length} of ${gauges.length} gauges`,
    };
  },
});

/** A source's own box, or its region's. */
export function boxFor(config) {
  const raw = String(config.bbox ?? '').trim();
  if (raw) {
    const parts = raw.split(',').map((n) => Number(n.trim()));
    if (parts.length === 4 && parts.every(Number.isFinite)) return parts;
    return null;
  }
  return REGIONS[String(config.region ?? '').toLowerCase()]?.bbox ?? null;
}
