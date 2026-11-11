import { defineAdapter, slugify } from '@nichedb/core/adapter';

/**
 * Trains: what is running now, and where every station is.
 *
 *   amtraker            Amtrak + VIA Rail runs, live (api-v3.amtraker.com, keyless, community)
 *   fintraffic-rail     every Finnish passenger train today, stop by stop (Fintraffic, CC BY 4.0)
 *   trainline-stations  71,819 European stations (trainline-eu/stations, ODbL)
 *
 * A RUN, NOT A TRAIN NUMBER
 *
 * "Amtrak 5" leaves Chicago every day and takes two and a half days, so two or
 * three of them are on the line at once. A row is one run: the number plus the
 * date it left its origin. It is rewritten every poll while it runs, and keeps
 * its last state when it drops off the feed.
 *
 * LATENESS
 *
 * Neither feed says "12 minutes late" as one number. Amtraker gives each stop's
 * scheduled and actual-or-estimated times; Fintraffic gives differenceInMinutes
 * on each stop it has passed. The row's `delayMinutes` is the latest known:
 * the next stop's estimate for Amtrak, the last passed stop for Finland.
 *
 * Fintraffic answers 406 without `Accept-Encoding: gzip`, like its marine API,
 * and asks for a `Digitraffic-User` header.
 */

const AMTRAKER = 'https://api-v3.amtraker.com/v3';
export const FINTRAFFIC_RAIL = 'https://rata.digitraffic.fi/api/v1';
export const FINTRAFFIC_HEADERS = {
  'accept-encoding': 'gzip',
  'digitraffic-user': 'nichedb.dev',
};
const STATIONS_CSV = 'https://raw.githubusercontent.com/trainline-eu/stations/master/stations.csv';

const minutes = (a, b) => {
  const d = (Date.parse(a) - Date.parse(b)) / 60_000;
  return Number.isFinite(d) ? Math.round(d) : null;
};

/** "12 min late", "on time", "3 min early". */
export function lateness(m) {
  if (m === null || m === undefined) return null;
  if (Math.abs(m) <= 1) return 'on time';
  return m > 0 ? `${m} min late` : `${-m} min early`;
}

/* -------------------------------------------------------------- amtraker -- */

/** Where an Amtraker run is: the last stop it left and the next it is due at, with lateness. */
export function amtrakProgress(stations = []) {
  // The next stop is the first one after the last departed, not the first one
  // marked Enroute: Amtraker leaves some passed stops without a Departed status.
  let lastAt = -1;
  stations.forEach((s, i) => {
    if (s.status === 'Departed') lastAt = i;
  });
  const last = lastAt >= 0 ? stations[lastAt] : null;
  const next = stations.slice(lastAt + 1).find((s) => s.status !== 'Departed') ?? null;
  const delay = next?.arr
    ? minutes(next.arr, next.schArr)
    : last?.dep
      ? minutes(last.dep, last.schDep)
      : null;
  return { last, next, delay };
}

export function amtrakItem(t) {
  if (!t?.trainNum) return null;
  const stops = Array.isArray(t.stations) ? t.stations : [];
  const startedOn = String(stops[0]?.schDep ?? t.createdAt ?? '').slice(0, 10) || null;
  const provider = t.provider === 'Via' ? 'VIA Rail' : (t.provider ?? 'Amtrak');
  const key = slugify(t.providerShort ?? provider);
  const { last, next, delay } = amtrakProgress(stops);
  const lat = Number(t.lat);
  const lon = Number(t.lon);
  const running = t.trainState === 'Active';
  const name = `${provider} ${t.trainNum}`;
  return {
    externalId: `${key}-${t.trainNum}-${startedOn ?? t.trainID}`,
    kind: 'train-run',
    title: `${name}${t.routeName ? ` ${t.routeName}` : ''}: ${t.origName ?? '?'} to ${t.destName ?? '?'}${startedOn ? ` (${startedOn})` : ''}`,
    summary: [
      `${name}${t.routeName ? `, the ${t.routeName},` : ''} from ${t.origName} to ${t.destName}`,
      startedOn ? ` that left on ${startedOn}` : '',
      running ? ' is running' : ` is ${String(t.trainState ?? 'listed').toLowerCase()}`,
      delay !== null ? `, ${lateness(delay)}` : '',
      last ? `. Last left ${last.name}` : '',
      next ? `; next stop ${next.name}` : '',
      next?.arr ? ` at ${String(next.arr).slice(11, 16)} local` : '',
      Number.isFinite(Number(t.velocity)) && running
        ? `, moving at ${Math.round(t.velocity)} mph`
        : '',
      '.',
    ].join(''),
    url: `https://amtraker.com/trains/${encodeURIComponent(t.trainNum)}/${encodeURIComponent(String(t.trainID).split('-')[1] ?? '')}`,
    publishedAt: startedOn,
    timeKnown: false,
    precision: 'day',
    tags: [
      'trains',
      key,
      t.routeName ? `route-${slugify(t.routeName)}` : null,
      `train-${String(t.trainNum).toLowerCase()}`,
      running ? 'running' : slugify(t.trainState ?? 'unknown'),
      delay !== null && delay > 15 ? 'late' : null,
      Array.isArray(t.alerts) && t.alerts.length ? 'alert' : null,
    ].filter(Boolean),
    data: {
      operator: provider,
      trainNumber: String(t.trainNum),
      runId: t.trainID,
      route: t.routeName ?? null,
      origin: { code: t.origCode, name: t.origName, tz: t.originTZ },
      destination: { code: t.destCode, name: t.destName, tz: t.destTZ },
      startedOn,
      state: t.trainState ?? null,
      running,
      delayMinutes: delay,
      delay: lateness(delay),
      lastStop: last
        ? { code: last.code, name: last.name, departed: last.dep, scheduled: last.schDep }
        : null,
      nextStop: next
        ? {
            code: next.code,
            name: next.name,
            due: next.arr,
            scheduled: next.schArr,
            platform: next.platform || null,
          }
        : null,
      speedMph: Number.isFinite(Number(t.velocity)) ? Math.round(Number(t.velocity)) : null,
      heading: t.heading ?? null,
      place: Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null,
      positionAt: t.lastValTS ?? t.updatedAt ?? null,
      alerts: (t.alerts ?? []).map((a) => a?.message ?? String(a)).slice(0, 5),
      stops: stops.map((s) => ({
        code: s.code,
        name: s.name,
        scheduledArrival: s.schArr ?? null,
        arrival: s.arr ?? null,
        scheduledDeparture: s.schDep ?? null,
        departure: s.dep ?? null,
        status: s.status ?? null,
        platform: s.platform || null,
      })),
      source: 'Amtraker (community API over Amtrak and VIA Rail data)',
      dataset: `${AMTRAKER}/trains`,
    },
  };
}

export const amtraker = defineAdapter({
  name: 'amtraker',
  title: 'Amtrak and VIA Rail trains running now',
  collection: 'trains',
  description:
    'Every Amtrak and VIA Rail train on the line, from the Amtraker API: one row per run with its route, where it is, its last and next stop, how late it is and every stop’s scheduled and actual time. Keyless, refreshed every ten minutes.',
  docs: 'https://github.com/piemadd/amtrak',
  kinds: ['train-run'],
  cadenceMinutes: 10,
  defaultSources: [{ slug: 'amtraker-trains', name: 'Amtrak + VIA Rail trains (live)' }],
  async pull({ http, log }) {
    const body = await http.json(`${AMTRAKER}/trains`, { timeoutMs: 60_000 });
    const runs = Object.values(body ?? {}).flat();
    const items = runs.map(amtrakItem).filter(Boolean);
    log(`${items.length} runs`);
    return {
      items,
      note: `${items.length} runs, ${items.filter((i) => i.data.running).length} running`,
    };
  },
});

/* ------------------------------------------------------------ fintraffic -- */

const PASSENGER = new Set(['Long-distance', 'Commuter']);

/** One Finnish train of one day as a row, given station names and its GPS fix. */
export function finnishItem(t, { names = new Map(), location = null } = {}) {
  if (!t?.trainNumber || !PASSENGER.has(t.trainCategory)) return null;
  const rows = Array.isArray(t.timeTableRows) ? t.timeTableRows : [];
  const stops = rows.filter((r) => r.commercialStop !== false && r.trainStopping !== false);
  const first = rows[0];
  const lastRow = rows[rows.length - 1];
  const nameOf = (code) => names.get(code) ?? code;
  let passed = null;
  for (const r of rows) if (r.actualTime) passed = r;
  const next = rows.find((r) => !r.actualTime && r.commercialStop && !r.cancelled) ?? null;
  const delay = passed ? (passed.differenceInMinutes ?? null) : null;
  const label = t.commuterLineID
    ? `${t.commuterLineID} train ${t.trainNumber}`
    : `${t.trainType} ${t.trainNumber}`;
  const from = nameOf(first?.stationShortCode);
  const to = nameOf(lastRow?.stationShortCode);
  const finished = Boolean(lastRow?.actualTime);
  const state = t.cancelled
    ? 'cancelled'
    : finished
      ? 'arrived'
      : t.runningCurrently
        ? 'running'
        : 'scheduled';
  const [lon, lat] = location?.location?.coordinates ?? [];
  return {
    externalId: `fi-${t.departureDate}-${t.trainNumber}`,
    kind: 'train-run',
    title: `${label}: ${from} to ${to} (${t.departureDate})`,
    summary: [
      `${label} (${t.operatorShortCode?.toUpperCase() ?? 'VR'}) from ${from} to ${to} on ${t.departureDate}`,
      ` is ${state}`,
      delay !== null && !t.cancelled ? `, ${lateness(delay)}` : '',
      passed ? `. Last passed ${nameOf(passed.stationShortCode)}` : '',
      next
        ? `; next stop ${nameOf(next.stationShortCode)} at ${String(next.liveEstimateTime ?? next.scheduledTime).slice(11, 16)} UTC`
        : '',
      location?.speed ? `, moving at ${location.speed} km/h` : '',
      '.',
    ].join(''),
    url: `https://www.junat.net/en/train/${t.trainNumber}/${t.departureDate}`,
    publishedAt: t.departureDate,
    timeKnown: false,
    precision: 'day',
    tags: [
      'trains',
      'finland',
      slugify(t.operatorShortCode ?? 'vr'),
      slugify(t.trainCategory),
      `train-${t.trainNumber}`,
      t.trainType ? `type-${slugify(t.trainType)}` : null,
      t.commuterLineID ? `line-${slugify(t.commuterLineID)}` : null,
      state,
      delay !== null && delay > 15 ? 'late' : null,
    ].filter(Boolean),
    data: {
      operator: t.operatorShortCode === 'vr' ? 'VR' : (t.operatorShortCode ?? null),
      trainNumber: String(t.trainNumber),
      trainType: t.trainType ?? null,
      category: t.trainCategory,
      commuterLine: t.commuterLineID || null,
      origin: { code: first?.stationShortCode, name: from },
      destination: { code: lastRow?.stationShortCode, name: to },
      startedOn: t.departureDate,
      state,
      running: state === 'running',
      cancelled: Boolean(t.cancelled),
      delayMinutes: delay,
      delay: lateness(delay),
      lastStop: passed
        ? {
            code: passed.stationShortCode,
            name: nameOf(passed.stationShortCode),
            at: passed.actualTime,
            scheduled: passed.scheduledTime,
          }
        : null,
      nextStop: next
        ? {
            code: next.stationShortCode,
            name: nameOf(next.stationShortCode),
            due: next.liveEstimateTime ?? null,
            scheduled: next.scheduledTime,
            platform: next.commercialTrack || null,
          }
        : null,
      speedKmh: location?.speed ?? null,
      place: Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null,
      positionAt: location?.timestamp ?? null,
      stops: stops
        .filter(
          (r, i, a) =>
            i === 0 || r.stationShortCode !== a[i - 1].stationShortCode || r.type !== a[i - 1].type,
        )
        .map((r) => ({
          code: r.stationShortCode,
          name: nameOf(r.stationShortCode),
          type: r.type === 'ARRIVAL' ? 'arrival' : 'departure',
          scheduled: r.scheduledTime,
          actual: r.actualTime ?? null,
          estimate: r.liveEstimateTime ?? null,
          lateMinutes: r.differenceInMinutes ?? null,
          platform: r.commercialTrack || null,
          cancelled: Boolean(r.cancelled),
        })),
      source: 'Fintraffic Digitraffic rail, CC BY 4.0',
      dataset: `${FINTRAFFIC_RAIL}/trains/${t.departureDate}`,
    },
  };
}

export const fintrafficRail = defineAdapter({
  name: 'fintraffic-rail',
  title: 'Finnish trains today (Fintraffic)',
  collection: 'trains',
  description:
    'Every passenger train in Finland today, long-distance and commuter: one row per train with every stop’s scheduled, estimated and actual time, how late it is, the platform, cancellations, and its GPS position and speed while it runs. Fintraffic open data (CC BY 4.0), keyless, every fifteen minutes.',
  docs: 'https://www.digitraffic.fi/en/railway-traffic/',
  kinds: ['train-run'],
  cadenceMinutes: 15,
  defaultSources: [{ slug: 'fintraffic-trains', name: 'Finnish passenger trains (live)' }],
  async pull({ http, log }) {
    const headers = FINTRAFFIC_HEADERS;
    const day = new Date().toISOString().slice(0, 10);
    const [trains, stations, locations] = await Promise.all([
      http.json(`${FINTRAFFIC_RAIL}/trains/${day}`, { headers, timeoutMs: 120_000 }),
      http
        .json(`${FINTRAFFIC_RAIL}/metadata/stations`, { headers, timeoutMs: 60_000 })
        .catch(() => []),
      http
        .json(`${FINTRAFFIC_RAIL}/train-locations/latest`, { headers, timeoutMs: 60_000 })
        .catch(() => []),
    ]);
    const names = new Map(
      (stations ?? []).map((s) => [
        s.stationShortCode,
        String(s.stationName).replace(/ asema$/, ''),
      ]),
    );
    const where = new Map((locations ?? []).map((l) => [`${l.departureDate}-${l.trainNumber}`, l]));
    const items = (trains ?? [])
      .map((t) =>
        finnishItem(t, { names, location: where.get(`${t.departureDate}-${t.trainNumber}`) }),
      )
      .filter(Boolean);
    log(`${items.length} passenger trains of ${trains?.length ?? 0}, ${where.size} positions`);
    return { items, note: `${items.length} trains on ${day}` };
  },
});

/* -------------------------------------------------------------- stations -- */

/** A semicolon CSV line, honouring quotes. trainline's file quotes names with semicolons. */
export function splitCsv(line, sep = ';') {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

const OPERATORS = [
  ['sncf', 'SNCF'],
  ['db', 'Deutsche Bahn'],
  ['cff', 'SBB CFF FFS'],
  ['obb', 'ÖBB'],
  ['trenitalia', 'Trenitalia'],
  ['ntv', 'Italo'],
  ['renfe', 'Renfe'],
  ['atoc', 'National Rail (GB)'],
  ['benerail', 'SNCB/NMBS'],
  ['entur', 'Entur (NO)'],
  ['westbahn', 'Westbahn'],
  ['flixbus', 'FlixBus'],
];

export function stationItem(row) {
  const lat = Number(row.latitude);
  const lon = Number(row.longitude);
  if (
    !row.id ||
    !row.name ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    (lat === 0 && lon === 0)
  )
    return null;
  const served = OPERATORS.filter(([k]) => row[`${k}_is_enabled`] === 't').map(([, n]) => n);
  const t = (k) => row[k] === 't';
  return {
    externalId: `trainline-${row.id}`,
    kind: 'station',
    title: `${row.name} (${row.country})`,
    summary: `${row.name}, a ${t('is_airport') ? 'station at an airport' : t('is_city') ? 'city (all its stations)' : t('is_main_station') ? 'main station' : 'station'} in ${row.country}${row.uic ? `, UIC ${row.uic}` : ''}${served.length ? `, sold by ${served.join(', ')}` : ''}.`,
    url: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}`,
    publishedAt: null,
    timeKnown: false,
    precision: 'day',
    tags: [
      'trains',
      'station',
      `country-${String(row.country).toLowerCase()}`,
      t('is_main_station') ? 'main-station' : null,
      t('is_city') ? 'city' : null,
      t('is_airport') ? 'airport' : null,
      row.uic ? `uic-${row.uic}` : null,
      ...served.map((n) => `served-${slugify(n)}`),
    ].filter(Boolean),
    data: {
      trainlineId: row.id,
      name: row.name,
      slug: row.slug,
      uic: row.uic || null,
      country: row.country,
      timeZone: row.time_zone || null,
      parentStationId: row.parent_station_id || null,
      isCity: t('is_city'),
      isMainStation: t('is_main_station'),
      isAirport: t('is_airport'),
      servedBy: served,
      place: { lat, lon },
      source: 'trainline-eu/stations (ODbL 1.0): © Trainline and contributors',
      license: 'ODbL-1.0',
      dataset: STATIONS_CSV,
    },
  };
}

export const trainlineStations = defineAdapter({
  name: 'trainline-stations',
  title: 'European railway stations (Trainline)',
  collection: 'trains',
  description:
    'Every station in Trainline’s open station list, about 70,000 across Europe (Switzerland, Germany, France, Sweden, Spain, Italy, Britain and more): name, country, UIC code, coordinates, time zone, the city it belongs to and which rail operators sell tickets to it. ODbL 1.0, refreshed weekly.',
  docs: 'https://github.com/trainline-eu/stations',
  kinds: ['station'],
  cadenceMinutes: 7 * 24 * 60,
  budgetMs: 20 * 60_000,
  defaultSources: [
    { slug: 'trainline-stations', name: 'European railway stations (Trainline, ODbL)' },
  ],
  async *pull({ http, log }) {
    const text = await http.text(STATIONS_CSV, { timeoutMs: 5 * 60_000 });
    const lines = text.split('\n');
    const head = splitCsv(lines[0]);
    let batch = [];
    let wrote = 0;
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i]) continue;
      const f = splitCsv(lines[i].replace(/\r$/, ''));
      const row = Object.fromEntries(head.map((h, j) => [h, f[j] ?? '']));
      const item = stationItem(row);
      if (!item) continue;
      batch.push(item);
      if (batch.length >= 1000) {
        wrote += batch.length;
        yield { items: batch };
        batch = [];
      }
    }
    if (batch.length) {
      wrote += batch.length;
      yield { items: batch };
    }
    log(`${wrote} stations`);
    return { note: `${wrote} stations` };
  },
});
