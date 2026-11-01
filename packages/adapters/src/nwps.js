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

const FIM_SERVICES_URL = 'https://water.noaa.gov/fim';
const FIM_RESOURCES_URL = 'https://water.noaa.gov/about/FIMResourceInfo.html';
const GAUGE_DETAIL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DATUM_CODE = /\b(MHHW|MHW|MLHW|MSL|MLLW|MLW|MTL|NAVD\s?-?\d+|NGVD\s?-?\d+|STND)\b/i;

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
function isTideStation(gauge) {
  return /\b(?:tide|tidal) station\b/i.test(String(gauge?.name ?? ''));
}

function verticalDatum(gauge, reading, details) {
  const datumValues = details?.datums?.vertical?.value;
  const datumText = Array.isArray(datumValues)
    ? datumValues
        .map((value) => (typeof value === 'string' ? value : Object.values(value ?? {}).join(' ')))
        .join(' ')
    : '';
  const candidates = [
    reading?.primaryName,
    details?.primaryName,
    details?.stageflow?.observed?.primaryName,
    details?.stageflow?.forecast?.primaryName,
    datumText,
    gauge?.name,
  ];
  for (const candidate of candidates) {
    const match = String(candidate ?? '').match(DATUM_CODE);
    if (match) return match[1].replace(/\s+/g, '').toUpperCase();
  }
  return null;
}

function readableGaugeName(name, datum, tideStation) {
  const value = String(name ?? '').trim();
  if (!datum || !tideStation) return value;
  const match = value.match(/\s*\(in\s+([A-Z0-9 -]+)\)\s*$/i);
  const namedDatum = match?.[1]?.replace(/[\s-]/g, '').toUpperCase();
  return namedDatum === datum ? value.slice(0, match.index).trim() : value;
}

function publicGaugeDetails(details) {
  if (!details || typeof details !== 'object') return null;
  const flood = details.flood ?? {};
  return {
    flood: {
      stageUnits: flood.stageUnits ?? null,
      categories: flood.categories ?? null,
      impacts: Array.isArray(flood.impacts) ? flood.impacts : [],
    },
    dataAttribution: Array.isArray(details.dataAttribution) ? details.dataAttribution : [],
    hydronotes: Array.isArray(details.hydronotes) ? details.hydronotes : [],
    impactsLowWaters: Array.isArray(details.impactsLowWaters) ? details.impactsLowWaters : [],
    inundation: details.inundation ?? null,
    datums: details.datums ?? null,
    forecastReliability: details.forecastReliability ?? null,
  };
}

export function toItem(gauge, which, details = null) {
  const reading = gauge.status?.[which];
  const cat = category(reading?.floodCategory);
  const level = stage(reading?.primary);
  const at = reading?.validTime;
  if (!cat || level === null || !at || at.startsWith('0001-')) return null;

  const lid = String(gauge.lid ?? '').toUpperCase();
  if (!lid) return null;
  const when = new Date(at).toISOString();
  const unit = String(reading.primaryUnit ?? 'ft').trim();
  const tideStation = isTideStation(gauge);
  const datum = verticalDatum(gauge, reading, details);
  const name = readableGaugeName(gauge.name ?? lid, datum, tideStation) || lid;
  const where = place(gauge);
  const observed = which === 'observed';
  const floodThreshold = stage(details?.flood?.categories?.[cat]?.stage);
  const floodThresholdUnit = String(details?.flood?.stageUnits ?? unit).trim();
  const floodText = tideStation
    ? observed
      ? `${cat} flood category`
      : `forecast ${cat} flood category`
    : observed
      ? SEVERITY[cat]
      : `forecast ${SEVERITY[cat]}`;
  const kind = tideStation
    ? observed
      ? 'coastal-gauge'
      : 'coastal-forecast'
    : observed
      ? 'river-gauge'
      : 'river-forecast';
  const hydronotes = (details?.hydronotes ?? [])
    .map((note) => String(note?.statement ?? '').trim())
    .filter(Boolean);
  const impacts = [...(details?.flood?.impacts ?? []), ...(details?.impactsLowWaters ?? [])]
    .map((impact) => ({
      stage: impact?.stage ?? impact?.value ?? null,
      description: impact?.impact ?? null,
    }))
    .filter((impact) => impact.stage || impact.description);
  const inundation = details?.inundation;
  const inundationSummary =
    inundation?.enabled === false
      ? 'NOAA lists no inundation layer for this gauge.'
      : inundation?.enabled === true
        ? 'NOAA lists an inundation layer for this gauge.'
        : null;
  const attribution = (details?.dataAttribution ?? []).find(
    (source) => source?.text && source?.url,
  );
  const thresholdSummary =
    floodThreshold === null
      ? null
      : `NOAA's ${cat} threshold for this gauge is ${floodThreshold} ${floodThresholdUnit}${
          datum ? ` (${datum})` : ''
        }.`;

  return {
    externalId: `nwps-${observed ? 'obs' : 'fcst'}-${lid}-${when}`,
    kind,
    title: `${name}${where.state ? `, ${where.state}` : ''}: ${floodText} at ${level} ${unit}${
      datum ? ` (${datum})` : ''
    }`,
    summary: [
      tideStation
        ? null
        : `River gauge ${name}${where.state ? ` in ${where.stateName ?? where.state}` : ''}`,
      tideStation
        ? `${observed ? 'Observed' : 'Forecast'} water height: ${level} ${unit}${
            datum ? ` (${datum})` : ''
          }; the NWS flood category is ${cat}.`
        : observed
          ? `was ${SEVERITY[cat]} at ${level} ${unit}${datum ? ` (${datum})` : ''} on ${stamp(when)}.`
          : `is forecast to be ${SEVERITY[cat]} at ${level} ${unit}${datum ? ` (${datum})` : ''} at ${stamp(when)}.`,
      where.forecastOffice ? `Forecast office ${where.forecastOffice}.` : null,
      thresholdSummary,
      inundationSummary,
      hydronotes[0] ?? null,
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
      tideStation ? 'coastal' : 'river',
      tideStation ? 'tide-station' : null,
      observed ? 'observed' : 'forecast',
      `flood:${cat}`,
      where.state ? where.state.toLowerCase() : null,
      where.riverForecastCentre ? where.riverForecastCentre.toLowerCase() : null,
      cat === 'major' || cat === 'moderate' ? 'significant-flooding' : null,
    ].filter(Boolean),
    data: {
      gaugeId: lid,
      gaugeName: name,
      rawGaugeName: String(gauge.name ?? lid).trim(),
      gaugeType: tideStation ? 'tide-station' : 'river-gauge',
      reading: observed ? 'observed' : 'forecast',
      floodCategory: cat,
      stage: level,
      stageUnit: unit,
      verticalDatum: datum,
      secondary: stage(reading.secondary),
      secondaryUnit: String(reading.secondaryUnit ?? '').trim() || null,
      validTime: when,
      floodStages: details?.flood?.categories ?? null,
      floodStageUnit: details?.flood?.stageUnits ?? null,
      floodThreshold,
      floodThresholdUnit: floodThreshold === null ? null : floodThresholdUnit,
      floodThresholdDatum: floodThreshold === null ? null : datum,
      dataAttribution: (details?.dataAttribution ?? []).map((source) => ({
        provider: source?.abbrev ?? null,
        label: source?.text ?? null,
        url: source?.url ?? null,
      })),
      ...(attribution
        ? {
            credit: {
              name: attribution.abbrev ?? 'upstream provider',
              text: attribution.text,
              url: attribution.url,
            },
          }
        : {}),
      hydronotes,
      impacts,
      forecastReliability: details?.forecastReliability ?? null,
      inundationMapping: {
        station: inundation
          ? {
              enabled: inundation.enabled ?? null,
              url: inundation.url || null,
              zeroDatum: inundation.zeroDatum ?? null,
              siteSpecificInfo: inundation.siteSpecificInfo || null,
              downloads: inundation.downloads ?? null,
              dataAttribution: inundation.dataAttribution ?? [],
            }
          : null,
        servicesUrl: FIM_SERVICES_URL,
        resourcesUrl: FIM_RESOURCES_URL,
        coverageNote:
          'The NOAA NWPS gauge-page notice says its Flood Inundation Mapping services now cover nearly 100% of the U.S. (9/24 update); per-station map availability still varies.',
        note: 'Gauge stage and mapped inundation are different products; map availability varies by station. Neither assesses flood risk for an individual property, determines a FEMA flood zone, or establishes insurance eligibility.',
      },
      place: where,
      categoryBasis: 'NWS flood categories for this gauge',
      source: 'NOAA National Water Prediction Service',
      dataset: 'https://api.water.noaa.gov/nwps/v1/gauges',
    },
  };
}

export const nwpsRiverGauges = defineAdapter({
  name: 'nwps-river-gauges',
  title: 'NOAA river and tide gauges in flood',
  collection: 'water',
  description:
    'NOAA river and tide gauges at or above their action stages, with the measured level, vertical datum, NWS flood thresholds, station notes and source attribution when published. Includes whether each gauge has a Flood Inundation Mapping layer and links to NOAA’s national FIM services and technical resources. Keyless.',
  docs: 'https://api.water.noaa.gov/nwps/v1/docs/',
  kinds: ['river-gauge', 'river-forecast', 'coastal-gauge', 'coastal-forecast'],
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
  async pull({ config, cursor, http, log, budget, deadline }) {
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
    const candidates = gauges
      .flatMap((gauge) =>
        ['observed', 'forecast'].map((reading) => ({
          gauge,
          reading,
          item: toItem(gauge, reading),
        })),
      )
      .filter(({ item }) => item && FLOOD_CATEGORIES.indexOf(item.data.floodCategory) >= atLeast);

    // The regional list is deliberately compact and leaves out datum,
    // station notes, flood-impact thresholds and per-gauge FIM availability.
    // Hydrate only gauges that are producing a flood-stage row, then cache the
    // stable station metadata for a week so the hourly poll stays lightweight.
    const detailCache = { ...(cursor.gaugeDetails ?? {}) };
    const now = Date.now();
    for (const [id, saved] of Object.entries(detailCache)) {
      if (!saved?.fetchedAt || now - saved.fetchedAt > 30 * GAUGE_DETAIL_TTL_MS) {
        delete detailCache[id];
      }
    }
    const activeGaugeIds = [
      ...new Set(candidates.map(({ gauge }) => String(gauge.lid ?? '').toUpperCase())),
    ].filter(Boolean);
    const staleIds = activeGaugeIds.filter((id) => {
      const fetchedAt = detailCache[id]?.fetchedAt;
      return !fetchedAt || now - fetchedAt > GAUGE_DETAIL_TTL_MS;
    });
    const detailBudget = Math.max(0, Number(budget) || 0);
    const lookupIds = staleIds.slice(0, detailBudget);
    for (let i = 0; i < lookupIds.length && Date.now() + 8_000 < deadline; i += 6) {
      const batch = lookupIds.slice(i, i + 6);
      await Promise.all(
        batch.map(async (id) => {
          try {
            const detail = await http.jsonOrNull(
              `https://api.water.noaa.gov/nwps/v1/gauges/${encodeURIComponent(id)}`,
              { timeoutMs: 8_000 },
            );
            detailCache[id] = {
              fetchedAt: Date.now(),
              data: publicGaugeDetails(detail),
            };
          } catch (error) {
            log(`could not load extra metadata for ${id}: ${error.message}`);
          }
        }),
      );
    }

    const items = candidates.map(({ gauge, reading }) =>
      toItem(gauge, reading, detailCache[String(gauge.lid ?? '').toUpperCase()]?.data),
    );

    const newest =
      items
        .map((i) => i.publishedAt)
        .filter(Boolean)
        .sort()
        .at(-1) ?? cursor.since;
    log(
      `${items.length} gauge reading(s) at or above action stage, of ${gauges.length} gauges; ${lookupIds.length} detail lookup(s) attempted`,
    );
    return {
      items,
      cursor: { since: newest ?? null, gaugeDetails: detailCache },
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
