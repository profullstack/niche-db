import { defineAdapter, slugify } from '@nichedb/core/adapter';

/**
 * The two halves of what a pilot is told about the weather, from the NOAA
 * Aviation Weather Center: the hazards in the air, and the conditions on the
 * ground at every reporting airport.
 *
 * Both are keyless, both answer in JSON, and together they are what makes the
 * FAA's delay feed readable. `faa-nas-status` says ORD has a ground stop for
 * thunderstorms; `aviation-metar` has the observation at ORD in the same
 * minute and `aviation-hazards` has the convective SIGMET drawn over it. Three
 * feeds, one airport, one hour -- which is the join no single upstream offers.
 */

const HAZARD_URL = 'https://aviationweather.gov/api/data/airsigmet';
const METAR_URL = 'https://aviationweather.gov/api/data/metar';

/** Seconds since the epoch, or nothing. */
function epoch(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null;
}

const clean = (v) => {
  const s = String(v ?? '').trim();
  return s && s !== 'null' ? s : null;
};

/** Feet, or nothing. A zero altitude on a SIGMET means "not stated", not sea level. */
function feet(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * A number that may legitimately be zero.
 *
 * Temperature, dewpoint and wind direction all have a real zero, so the usual
 * `Number(v) || null` would erase a calm north wind and a freezing morning.
 */
export function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/* ---------------------------------------------------------------- hazards */

const HAZARD_NAMES = {
  CONVECTIVE: 'thunderstorms',
  TURB: 'turbulence',
  ICE: 'icing',
  IFR: 'instrument conditions',
  MTW: 'mountain wave',
  ASH: 'volcanic ash',
  TS: 'thunderstorms',
};

/**
 * The states and regions a SIGMET covers, from its own text.
 *
 * There is no `area` field. The bulletin carries the region as a bare line of
 * two-letter codes -- `MI LH` for Michigan and Lake Huron -- immediately above
 * the `FROM` line that traces the polygon, and that is the only place it
 * appears. Read from the text rather than invented, and null when the bulletin
 * is not laid out this way, because the alternative was labelling every hazard
 * in the country `KKCI`: the Aviation Weather Center that issues them all, and
 * a place no weather is ever over.
 */
export function regionsOf(raw) {
  const lines = String(raw ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim());
  const from = lines.findIndex((l) => /^FROM\b/.test(l));
  if (from < 1) return null;
  const above = lines[from - 1];
  return /^([A-Z]{2}\s+)*[A-Z]{2}$/.test(above) ? above : null;
}

/** Which way the hazard is going, in words, or nothing when it is not moving or not said. */
export function movement(row) {
  const dir = num(row?.movementDir);
  const spd = num(row?.movementSpd);
  if (dir === null || spd === null || spd <= 0) return null;
  const points = [
    'N',
    'NNE',
    'NE',
    'ENE',
    'E',
    'ESE',
    'SE',
    'SSE',
    'S',
    'SSW',
    'SW',
    'WSW',
    'W',
    'WNW',
    'NW',
    'NNW',
  ];
  return `${points[Math.round((dir % 360) / 22.5) % 16]} at ${spd} kt`;
}

/** The box the hazard's polygon fits in, so a row can be asked whether it covers an airport. */
export function bboxOf(coords) {
  const points = (Array.isArray(coords) ? coords : [])
    .map((c) => [Number(c?.lat), Number(c?.lon)])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
  if (!points.length) return null;
  const lats = points.map((p) => p[0]);
  const lons = points.map((p) => p[1]);
  return {
    minLat: Math.min(...lats),
    minLon: Math.min(...lons),
    maxLat: Math.max(...lats),
    maxLon: Math.max(...lons),
  };
}

export function hazardItem(row) {
  const id = clean(row.airSigmetId) ?? clean(row.alphaChar);
  const from = epoch(row.validTimeFrom);
  const to = epoch(row.validTimeTo);
  const type = clean(row.airSigmetType) ?? 'AIRMET';
  const hazard = clean(row.hazard) ?? 'unspecified';
  if (!from) return null;

  // A SIGMET is reissued under the same series letter every few hours, so the
  // series alone is not an identity; the issue time makes each issuance its own
  // row, which is what a reissue is.
  const key = [
    clean(row.icaoId) ?? 'unknown',
    type,
    clean(row.seriesId) ?? clean(row.alphaChar) ?? id ?? 'x',
    from,
  ].join('-');

  const label = HAZARD_NAMES[hazard.toUpperCase()] ?? hazard.toLowerCase();
  const low = feet(row.altitudeLow1 ?? row.altitudeLow2);
  const high = feet(row.altitudeHi1 ?? row.altitudeHi2);
  const band =
    low && high
      ? `between ${low.toLocaleString()} and ${high.toLocaleString()} ft`
      : high
        ? `below ${high.toLocaleString()} ft`
        : null;
  const severity = clean(row.severity);
  const area = regionsOf(row.rawAirSigmet);
  const office = clean(row.icaoId);

  return {
    externalId: `avwx-${slugify(key)}`,
    kind: 'aviation-hazard',
    title: `${type} ${clean(row.seriesId) ?? ''}: ${label}${area ? ` over ${area}` : ''}`.replace(
      /\s+/g,
      ' ',
    ),
    summary: [
      `${type} for ${label}`,
      area ? ` over ${area}` : '',
      band ? ` ${band}` : '',
      severity ? `, severity ${severity}` : '',
      movement(row) ? `, moving ${movement(row)}` : '',
      `. Valid from ${from}${to ? ` to ${to}` : ''}`,
      office ? `, issued by ${office}` : '',
      '.',
    ].join(''),
    url: 'https://aviationweather.gov/gfa/#sigmet',
    publishedAt: from,
    timeKnown: true,
    precision: 'minute',
    tags: [
      'aviation',
      'weather',
      'hazard',
      type.toLowerCase(),
      slugify(label),
      severity ? `severity:${slugify(severity)}` : null,
      ...(area ? area.split(/\s+/).map((r) => r.toLowerCase()) : []),
    ].filter(Boolean),
    data: {
      hazardType: type,
      hazard,
      hazardLabel: label,
      severity,
      series: clean(row.seriesId) ?? clean(row.alphaChar),
      issuingOffice: office,
      area,
      areaBasis: area
        ? 'The region codes on the bulletin itself. `issuingOffice` is the centre that wrote it, not a place the weather is over.'
        : null,
      movementDirectionDeg: num(row.movementDir),
      movementSpeedKt: num(row.movementSpd),
      bbox: bboxOf(row.coords),
      validFrom: from,
      validTo: to,
      altitudeLowFt: low,
      altitudeHighFt: high,
      // The polygon the hazard is drawn over, kept so a row can be asked
      // whether it covers an airport rather than only which office issued it.
      coords: Array.isArray(row.coords) ? row.coords : null,
      rawText: clean(row.rawAirSigmet),
      source: 'NOAA Aviation Weather Center',
      dataset: HAZARD_URL,
    },
  };
}

export const aviationHazards = defineAdapter({
  name: 'aviation-hazards',
  title: 'Aviation hazards (SIGMET/AIRMET)',
  collection: 'aviation',
  description:
    'Every SIGMET, AIRMET and centre weather advisory in force over the United States: thunderstorms, turbulence, icing, mountain wave and volcanic ash, each with the polygon it is drawn over and the altitude band it applies to. Keyless, from the NOAA Aviation Weather Center.',
  docs: 'https://aviationweather.gov/data/api/',
  kinds: ['aviation-hazard'],
  cadenceMinutes: 15,
  configFields: [
    {
      key: 'hazard',
      label: 'Only this hazard',
      type: 'select',
      options: ['', 'conv', 'turb', 'ice', 'ifr', 'mtw'],
      help: 'Empty means every hazard in force.',
    },
  ],
  defaults: {},
  defaultSources: [
    { slug: 'aviation-hazards-us', name: 'Aviation hazards in force (US)' },
    {
      slug: 'aviation-hazards-convective',
      name: 'Convective SIGMETs',
      config: { hazard: 'conv' },
      cadenceMinutes: 10,
    },
  ],
  async pull({ config, cursor, http, log }) {
    const params = new URLSearchParams({ format: 'json' });
    if (config.hazard) params.set('hazard', String(config.hazard));
    const rows = await http.json(`${HAZARD_URL}?${params}`, { timeoutMs: 45_000 });
    if (!Array.isArray(rows)) throw new Error('the aviation weather API did not return a list');

    const items = rows.map(hazardItem).filter(Boolean);
    const newest =
      items
        .map((i) => i.publishedAt)
        .filter(Boolean)
        .sort()
        .at(-1) ?? cursor.since;
    log(`${items.length} hazard(s) in force${newest ? `, newest issued ${newest}` : ''}`);
    return { items, cursor: { since: newest ?? null }, note: `${items.length} in force` };
  },
});

/* ------------------------------------------------------------------ METAR */

/**
 * The busiest US airports, which is what a station list should default to.
 *
 * Every one of these was in the FAA's own passenger-boardings ranking and
 * answers the METAR endpoint. A deployment that wants the whole country sets a
 * bounding box instead, and gets roughly two and a half thousand stations an
 * hour.
 */
export const HUB_STATIONS = [
  'KATL',
  'KDFW',
  'KDEN',
  'KORD',
  'KLAX',
  'KCLT',
  'KLAS',
  'KPHX',
  'KMCO',
  'KSEA',
  'KMIA',
  'KIAH',
  'KJFK',
  'KEWR',
  'KFLL',
  'KMSP',
  'KSFO',
  'KDTW',
  'KBOS',
  'KSLC',
  'KPHL',
  'KBWI',
  'KTPA',
  'KSAN',
  'KLGA',
  'KMDW',
  'KBNA',
  'KIAD',
  'KDCA',
  'KAUS',
  'KRDU',
  'KHNL',
  'KSTL',
  'KPDX',
  'KMCI',
  'KSMF',
  'KRSW',
  'KSJC',
  'KSNA',
  'KMSY',
  'KCLE',
  'KPIT',
  'KIND',
  'KCMH',
  'KSAT',
  'KJAX',
  'KOAK',
  'KMKE',
  'KABQ',
  'KBUR',
  'KANC',
  'KOMA',
  'KBUF',
  'KONT',
  'KBDL',
  'KRIC',
  'KTUS',
  'KOKC',
  'KELP',
  'KBOI',
];

/** Flight category, ordered worst first, for the "only when it matters" filter. */
const BELOW_VFR = new Set(['MVFR', 'IFR', 'LIFR']);

/**
 * The most stations one bounding box will answer with.
 *
 * Measured, not documented. A box covering the continental United States
 * returns exactly 400 stations; its eastern half returns 247 and its western
 * half 240. 487 stations do not fit in a 400-station answer, and nothing in the
 * response says so -- no error, no truncation flag, no count. A source built on
 * one national box would therefore have quietly dropped a fifth of the
 * country's airports on every run, and looked entirely healthy doing it.
 */
const BOX_CAP = 400;

/** A bounding box as the API writes it: minLat,minLon,maxLat,maxLon. */
export function parseBox(raw) {
  const parts = String(raw ?? '')
    .split(',')
    .map((n) => Number(n.trim()));
  return parts.length === 4 && parts.every(Number.isFinite) ? parts : null;
}

/** The four quadrants of a box, for when its answer came back at the cap. */
export function quarters([minLat, minLon, maxLat, maxLon]) {
  const midLat = (minLat + maxLat) / 2;
  const midLon = (minLon + maxLon) / 2;
  return [
    [minLat, minLon, midLat, midLon],
    [minLat, midLon, midLat, maxLon],
    [midLat, minLon, maxLat, midLon],
    [midLat, midLon, maxLat, maxLon],
  ];
}

/** The watermark, less the grace a late-reporting station needs to survive it. */
export function graceBefore(since, hours = 2) {
  const t = new Date(since).getTime();
  if (!Number.isFinite(t)) return '';
  return new Date(t - hours * 3_600_000).toISOString();
}

export function metarItem(row) {
  const station = clean(row.icaoId);
  const at = clean(row.reportTime) ?? epoch(row.obsTime);
  if (!station || !at) return null;

  const iso = new Date(at).toISOString();
  const cat = clean(row.fltCat);
  const temp = num(row.temp);
  const wind = num(row.wspd);
  const gust = num(row.wgst);
  const visib = clean(row.visib);
  const name = clean(row.name) ?? station;

  return {
    externalId: `metar-${station}-${iso}`,
    kind: 'observation',
    title: `${station} ${cat ?? 'observation'}: ${name}`,
    summary: [
      `${name} at ${iso.replace('T', ' ').slice(0, 16)}Z:`,
      cat ? `${cat} conditions,` : null,
      visib ? `visibility ${visib} sm,` : null,
      wind !== null
        ? `wind ${num(row.wdir) === null ? 'variable' : `${num(row.wdir)}°`} at ${wind} kt${
            gust ? ` gusting ${gust}` : ''
          },`
        : null,
      temp !== null ? `temperature ${temp}°C.` : null,
    ]
      .filter(Boolean)
      .join(' ')
      .replace(/,$/, '.'),
    url: `https://aviationweather.gov/data/metar/?ids=${encodeURIComponent(station)}`,
    publishedAt: iso,
    timeKnown: true,
    precision: 'minute',
    tags: [
      'aviation',
      'weather',
      'observation',
      station.toLowerCase(),
      cat ? cat.toLowerCase() : null,
      cat && BELOW_VFR.has(cat) ? 'below-vfr' : null,
      gust ? 'gusting' : null,
    ].filter(Boolean),
    data: {
      station,
      stationName: name,
      flightCategory: cat,
      observedAt: iso,
      temperatureC: temp,
      dewpointC: num(row.dewp),
      windDirectionDeg: num(row.wdir),
      windSpeedKt: wind,
      windGustKt: gust,
      visibilitySm: visib,
      altimeterHpa: num(row.altim),
      seaLevelPressureHpa: num(row.slp),
      cloudLayers: Array.isArray(row.clouds) ? row.clouds : null,
      place: {
        country: 'US',
        lat: num(row.lat),
        lon: num(row.lon),
        elevationM: num(row.elev),
      },
      raw: clean(row.rawOb),
      source: 'NOAA Aviation Weather Center',
      dataset: METAR_URL,
    },
  };
}

export const aviationMetar = defineAdapter({
  name: 'aviation-metar',
  title: 'Airport weather observations (METAR)',
  collection: 'aviation',
  description:
    'The hourly observation at an airport, decoded: flight category, wind, visibility, cloud layers and the raw METAR. Sixty US hubs out of the box, or any station list, or a bounding box for every reporting airport inside it. Keyless.',
  docs: 'https://aviationweather.gov/data/api/',
  kinds: ['observation'],
  cadenceMinutes: 60,
  configFields: [
    { key: 'stations', label: 'Stations', type: 'list', help: 'ICAO ids, e.g. KJFK.' },
    {
      key: 'bbox',
      label: 'Bounding box',
      help: 'minLat,minLon,maxLat,maxLon — every reporting station inside it. Overrides the station list.',
    },
    {
      key: 'belowVfrOnly',
      label: 'Only below VFR',
      type: 'select',
      options: ['', 'yes'],
      help: 'Keep only stations reporting MVFR, IFR or LIFR — the ones where the weather is in the way.',
    },
  ],
  defaults: {},
  defaultSources: [
    { slug: 'metar-us-hubs', name: 'Airport weather: 60 US hubs' },
    {
      slug: 'metar-below-vfr',
      name: 'Airports below VFR (continental US)',
      config: { bbox: '24,-125,50,-66', belowVfrOnly: 'yes' },
      cadenceMinutes: 30,
    },
  ],
  async pull({ config, cursor, http, log, deadline }) {
    const ask = async (params) => {
      const rows = await http.json(`${METAR_URL}?${params}`, { timeoutMs: 60_000 });
      if (!Array.isArray(rows)) throw new Error('the METAR API did not return a list');
      return rows;
    };

    /** One box, split as many times as it takes for the answer not to be at the cap. */
    const readBox = async (box, depth = 0) => {
      const rows = await ask(
        new URLSearchParams({ format: 'json', bbox: box.map((n) => n.toFixed(4)).join(',') }),
      );
      if (rows.length < BOX_CAP || depth >= 3 || Date.now() > deadline) {
        if (rows.length >= BOX_CAP) {
          log(
            `box ${box.join(',')} still at the ${BOX_CAP}-station cap after splitting; some stations were not read`,
          );
        }
        return rows;
      }
      const out = [];
      for (const q of quarters(box)) out.push(...(await readBox(q, depth + 1)));
      return out;
    };

    const box = parseBox(config.bbox);
    let rows;
    if (config.bbox && !box) {
      throw new Error('aviation-metar bbox must be minLat,minLon,maxLat,maxLon');
    } else if (box) {
      const found = await readBox(box);
      // Splitting can return the same station from two boxes that share an edge.
      const byStation = new Map();
      for (const r of found) byStation.set(`${r.icaoId}-${r.reportTime ?? r.obsTime}`, r);
      rows = [...byStation.values()];
    } else {
      const stations = (config.stations ?? [])
        .map((s) => String(s).trim().toUpperCase())
        .filter(Boolean);
      rows = await ask(
        new URLSearchParams({
          format: 'json',
          ids: (stations.length ? stations : HUB_STATIONS).join(','),
        }),
      );
    }

    const belowVfrOnly = String(config.belowVfrOnly ?? '') === 'yes';
    const items = rows
      .map(metarItem)
      .filter(Boolean)
      .filter((i) => !belowVfrOnly || BELOW_VFR.has(String(i.data.flightCategory)))
      /* Most of a 2,500-station answer is the same observations the last run
       * already stored, so the run is cut back to what is new. The watermark is
       * the newest report time seen, held back two hours: it is a single number
       * across stations that report at different minutes past the hour, and
       * without the grace a station whose clock or upload runs late would fall
       * behind the watermark on every run and never be stored at all. */
      .filter((i) => !cursor.since || i.publishedAt > graceBefore(cursor.since));

    const newest =
      rows
        .map((r) => clean(r.reportTime) ?? epoch(r.obsTime))
        .filter(Boolean)
        .map((d) => new Date(d).toISOString())
        .sort()
        .at(-1) ?? cursor.since;

    log(
      `${items.length} new observation(s) from ${rows.length} station(s)${
        belowVfrOnly ? ' below VFR' : ''
      }`,
    );
    return { items, cursor: { since: newest ?? null }, note: `${items.length} observations` };
  },
});
