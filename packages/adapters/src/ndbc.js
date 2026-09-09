import { defineAdapter, slugify } from '@nichedb/core/adapter';

/**
 * Every buoy NOAA is listening to, and what the sea is doing under it.
 *
 * The National Data Buoy Center publishes the newest observation from all of
 * its stations in a single hundred-kilobyte file: 853 reports, 184 of them
 * carrying a wave height. Wind, gust, wave height, dominant and average period,
 * mean wave direction, pressure, air and water temperature. One request, the
 * whole ocean, keyless.
 *
 * WHY THIS IS ALSO THE SURF REPORT
 *
 * A surf report is three numbers and everything else is presentation: how big
 * the swell is (WVHT), how far apart the waves are (DPD), and where they are
 * coming from (MWD). A two-metre swell at 18 seconds and a two-metre swell at 6
 * seconds are completely different days in the water, and the period is what
 * separates them. So a buoy reporting waves is published with those three read
 * out in words as well as stored as numbers, and `nws-surf-zone` carries the
 * forecaster's own prose beside it.
 *
 * THE MISSING VALUE IS THE WHOLE PROBLEM
 *
 * NDBC writes a missing reading as `MM`, in a fixed-width table, in every
 * column. `Number('MM')` is NaN, which is at least loud -- but a reader that
 * reaches for `|| 0` or `parseFloat` without checking turns "this buoy has no
 * anemometer" into a flat calm and "no wave sensor" into a dead-flat sea. Most
 * stations are missing most columns: of 853 observations, 669 report no wave
 * height at all. Every field here is read through one guard that returns null
 * for `MM`, and null means the buoy did not say.
 */

const LATEST = 'https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt';
const STATIONS = 'https://www.ndbc.noaa.gov/activestations.xml';

/**
 * The columns of `latest_obs.txt`, in order.
 *
 * The file is whitespace-aligned rather than delimited, and the header names
 * are repeated in two comment rows, so the order is the contract. Splitting on
 * runs of whitespace gives exactly 22 fields per row.
 */
const COLUMNS = [
  'station',
  'lat',
  'lon',
  'year',
  'month',
  'day',
  'hour',
  'minute',
  'windDirection',
  'windSpeed',
  'gust',
  'waveHeight',
  'dominantPeriod',
  'averagePeriod',
  'waveDirection',
  'pressure',
  'pressureTendency',
  'airTemp',
  'waterTemp',
  'dewpoint',
  'visibility',
  'tide',
];

/**
 * A reading, or null.
 *
 * `MM` is NDBC's missing value and it appears in every column. Anything that
 * coerces it to a number silently reports a calm sea at a station with no wave
 * sensor.
 */
export function reading(v) {
  const s = String(v ?? '').trim();
  if (!s || s === 'MM' || s === 'N/A') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** One row of the fixed-width table, or null if it is not a row. */
export function parseRow(line) {
  const t = String(line ?? '').trim();
  if (!t || t.startsWith('#')) return null;
  const parts = t.split(/\s+/);
  if (parts.length < COLUMNS.length) return null;
  const row = {};
  COLUMNS.forEach((name, i) => {
    row[name] = name === 'station' ? parts[i] : reading(parts[i]);
  });
  return row.station ? row : null;
}

export function parseLatest(text) {
  return String(text ?? '')
    .split('\n')
    .map(parseRow)
    .filter(Boolean);
}

/**
 * The station register, which is where the names live.
 *
 * `latest_obs.txt` identifies a buoy by a five-character id and nothing else,
 * so without this every row would be titled `46221`. The register is one
 * request for all 1,353 stations and it changes when NOAA moors or retires a
 * buoy, so it is read once and kept in the cursor.
 *
 * Parsed by attribute rather than with the shared XML reader: every station is
 * a self-closing tag with no body, and a reader that looks for `<station>` and
 * a matching close tag finds nothing at all.
 */
export function parseStations(xml) {
  const out = {};
  for (const m of String(xml ?? '').matchAll(/<station\s([^>]*?)\/?>/g)) {
    const attrs = {};
    for (const a of m[1].matchAll(/([\w:.-]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
    if (!attrs.id) continue;
    /* The register really does carry `name=""` -- 15009 in the Atlantic array
     * is one of many. An empty string is not a name, and left as one it wins
     * over the fallback and titles the row with nothing at all. */
    const named = (v) => {
      const t = String(v ?? '').trim();
      return t || null;
    };
    out[attrs.id] = {
      name: named(attrs.name),
      owner: named(attrs.owner),
      type: named(attrs.type),
      program: named(attrs.pgm),
    };
  }
  return out;
}

const metresToFeet = (m) => (m === null ? null : Number((m * 3.28084).toFixed(1)));
const msToKnots = (m) => (m === null ? null : Number((m * 1.94384).toFixed(1)));

/** The compass point a swell is coming from, which is how a surf report says it. */
export function compass(deg) {
  if (deg === null || !Number.isFinite(deg)) return null;
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
  return points[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

/**
 * How a surfer would describe the swell, from the three numbers that decide it.
 *
 * Period is the discriminator and it is the one people leave out. Under 8
 * seconds is local windswell; over 14 is groundswell that has travelled and
 * will break with some force.
 */
export function swellDescription(heightM, periodS) {
  if (heightM === null) return null;
  const ft = metresToFeet(heightM);
  /* A period under two seconds is not a wave. Some stations report 0 or 1 for
   * a flat sea or a sensor that is not measuring period, and classifying that
   * as "windswell" states something about the water that nobody measured. */
  if (periodS === null || periodS < 2) return `${ft} ft`;
  const kind =
    periodS >= 14
      ? 'long-period groundswell'
      : periodS >= 10
        ? 'groundswell'
        : periodS >= 8
          ? 'mixed swell'
          : 'windswell';
  return `${ft} ft at ${periodS} s, ${kind}`;
}

function observedAt(row) {
  const { year, month, day, hour, minute } = row;
  if ([year, month, day, hour, minute].some((v) => v === null)) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${year}-${p(month)}-${p(day)}T${p(hour)}:${p(minute)}:00Z`;
}

export function toItem(row, station = null) {
  const when = observedAt(row);
  if (!when) return null;

  const name = station?.name ?? `Station ${row.station}`;
  const flat = row.waveHeight === 0;
  const waves = row.waveHeight !== null;
  const swell = swellDescription(row.waveHeight, row.dominantPeriod);
  const from = compass(row.waveDirection);
  const windKt = msToKnots(row.windSpeed);
  const gustKt = msToKnots(row.gust);

  return {
    externalId: `ndbc-${row.station}-${when}`,
    kind: waves ? 'sea-state' : 'marine-observation',
    title: `${name}: ${waves ? swell : 'marine observation'}${from && waves ? ` from the ${from}` : ''}`,
    summary: [
      `${name} reported at ${when.replace('T', ' ').slice(0, 16)}Z:`,
      waves ? ` ${swell}${from ? ` out of the ${from}` : ''}.` : '',
      windKt !== null
        ? ` Wind ${compass(row.windDirection) ?? 'variable'} at ${windKt} kt${gustKt !== null ? `, gusting ${gustKt}` : ''}.`
        : '',
      row.waterTemp !== null ? ` Water ${row.waterTemp}°C.` : '',
      row.airTemp !== null ? ` Air ${row.airTemp}°C.` : '',
    ]
      .join('')
      .trim(),
    url: `https://www.ndbc.noaa.gov/station_page.php?station=${encodeURIComponent(row.station)}`,
    publishedAt: when,
    timeKnown: true,
    precision: 'minute',
    tags: [
      'water',
      'marine',
      'buoy',
      `station:${slugify(row.station)}`,
      waves ? 'waves' : null,
      flat ? 'flat' : null,
      waves && row.dominantPeriod !== null && row.dominantPeriod >= 14 ? 'groundswell' : null,
      waves && row.waveHeight !== null && row.waveHeight >= 2.5 ? 'big-surf' : null,
      from ? `swell:${from.toLowerCase()}` : null,
      station?.type ? slugify(station.type) : null,
    ].filter(Boolean),
    data: {
      station: row.station,
      stationName: name,
      owner: station?.owner ?? null,
      stationType: station?.type ?? null,
      observedAt: when,
      /*
       * Waves in metres as NDBC publishes them and in feet beside it, because
       * every surf forecast in the United States is in feet and converting at
       * read time is how a six-foot day becomes a two-foot day.
       */
      waveHeightM: row.waveHeight,
      waveHeightFt: metresToFeet(row.waveHeight),
      dominantPeriodS: row.dominantPeriod,
      averagePeriodS: row.averagePeriod,
      waveDirectionDeg: row.waveDirection,
      waveDirection: from,
      swell,
      windSpeedKt: windKt,
      windGustKt: gustKt,
      windDirectionDeg: row.windDirection,
      pressureHpa: row.pressure,
      pressureTendencyHpa: row.pressureTendency,
      airTempC: row.airTemp,
      waterTempC: row.waterTemp,
      dewpointC: row.dewpoint,
      visibilityNmi: row.visibility,
      tideFt: row.tide,
      missingNote:
        'NDBC writes an absent reading as MM and most stations carry no wave sensor; a null here means the buoy did not report that field, never that the value was zero.',
      place: { country: null, lat: row.lat, lon: row.lon },
      source: 'NOAA National Data Buoy Center',
      dataset: LATEST,
    },
  };
}

export const ndbcBuoys = defineAdapter({
  name: 'ndbc-buoys',
  title: 'Ocean buoys',
  collection: 'water',
  description:
    'The newest observation from every NOAA buoy, in one request: wave height, the period that decides whether it is groundswell or windswell, the direction it is coming from, wind, pressure and water temperature. The raw material of every surf report, keyless.',
  docs: 'https://www.ndbc.noaa.gov/docs/ndbc_web_data_guide.pdf',
  kinds: ['sea-state', 'marine-observation'],
  cadenceMinutes: 60,
  configFields: [
    {
      key: 'wavesOnly',
      label: 'Only buoys reporting waves',
      type: 'select',
      options: ['', 'yes'],
      help: 'Two thirds of stations carry no wave sensor.',
    },
    {
      key: 'minWaveHeightM',
      label: 'Minimum wave height (m)',
      type: 'number',
      help: 'Keep only seas at or above this.',
    },
    { key: 'stations', label: 'Only these stations', type: 'list', help: 'NDBC station ids.' },
  ],
  defaults: {},
  defaultSources: [
    { slug: 'buoys-all', name: 'Every NOAA buoy' },
    {
      slug: 'buoys-waves',
      name: 'Buoys reporting waves',
      config: { wavesOnly: 'yes' },
      cadenceMinutes: 30,
    },
    {
      slug: 'buoys-big-seas',
      name: 'Big seas (2.5 m and over)',
      config: { wavesOnly: 'yes', minWaveHeightM: 2.5 },
      cadenceMinutes: 30,
    },
  ],
  async pull({ config, cursor, http, log }) {
    /* The register is read once and kept; it changes when NOAA moors or
     * retires a buoy, which is not something that happens between two polls. */
    let stations = cursor.stations ?? null;
    const stale =
      !cursor.stationsAt || Date.now() - new Date(cursor.stationsAt).getTime() > 7 * 24 * 3_600_000;
    if (!stations || stale) {
      const xml = await http.text(STATIONS, { timeoutMs: 60_000 });
      const parsed = parseStations(xml);
      if (Object.keys(parsed).length) stations = parsed;
    }

    const text = await http.text(LATEST, { timeoutMs: 60_000 });
    const rows = parseLatest(text);
    if (!rows.length) throw new Error('the buoy file held no observations');

    const only = (config.stations ?? []).map((s) => String(s).trim().toUpperCase()).filter(Boolean);
    const wavesOnly = String(config.wavesOnly ?? '') === 'yes';
    const floor = Number(config.minWaveHeightM) || 0;

    const items = rows
      .filter((r) => !only.length || only.includes(r.station.toUpperCase()))
      .filter((r) => !wavesOnly || r.waveHeight !== null)
      .filter((r) => !floor || (r.waveHeight ?? 0) >= floor)
      .map((r) => toItem(r, stations?.[r.station] ?? null))
      .filter(Boolean);

    const withWaves = items.filter((i) => i.data.waveHeightM !== null).length;
    log(`${items.length} buoy observation(s) of ${rows.length}, ${withWaves} reporting waves`);
    return {
      items,
      cursor: {
        stations,
        stationsAt: stale || !cursor.stationsAt ? new Date().toISOString() : cursor.stationsAt,
      },
      note: `${items.length} buoys, ${withWaves} with waves`,
    };
  },
});
