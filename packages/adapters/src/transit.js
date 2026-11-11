import { rm } from 'node:fs/promises';
import { defineAdapter, slugify } from '@nichedb/core/adapter';
import { dumpDir, zipMemberLines } from '@nichedb/core/dump';
import { CITIES, decodeFeed, hhmm, ROUTE_TYPE, translated } from '@nichedb/core/transit';
import { splitCsv } from './trains.js';

/**
 * Public transit for big cities: lines, stations with their timetables, and
 * service alerts. Vehicles and arrivals are read live by the web app; what is
 * stored here is what changes slowly enough to be worth a row.
 *
 * TIMETABLES WITHOUT STORING THE TIMETABLE
 *
 * A GTFS stop_times.txt is every stop of every trip (37 MB for the NYC
 * subway, 130 MB for the MBTA, 195 MB for Chicago). Nobody wants it as rows.
 * What a rider asks of a station is: which lines stop here, when is the first
 * and last train, and how often do they come. So the file is streamed once and
 * each station keeps, per line, direction and day type (weekday, Saturday,
 * Sunday): first departure, last departure, trips, and the busiest hour's count.
 *
 * The day types are real dates: the next Wednesday, Saturday and Sunday, with
 * calendar.txt and calendar_dates.txt applied, so a holiday or a works weekend
 * in the feed shows up as what will actually run.
 */

const DAYS = ['weekday', 'saturday', 'sunday'];
const DOW = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** The next Wednesday, Saturday and Sunday on or after `from`, as YYYYMMDD with their weekday. */
export function sampleDates(from = new Date()) {
  const out = {};
  const want = { weekday: 3, saturday: 6, sunday: 0 };
  for (const [name, dow] of Object.entries(want)) {
    const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
    while (d.getUTCDay() !== dow) d.setUTCDate(d.getUTCDate() + 1);
    out[name] = { ymd: d.toISOString().slice(0, 10).replace(/-/g, ''), dow: DOW[dow] };
  }
  return out;
}

/** Which service_ids run on each sample date. */
export function activeServices(calendar, calendarDates, dates) {
  const out = Object.fromEntries(DAYS.map((d) => [d, new Set()]));
  for (const c of calendar) {
    for (const day of DAYS) {
      const { ymd, dow } = dates[day];
      if (c[dow] === '1' && c.start_date <= ymd && ymd <= c.end_date) out[day].add(c.service_id);
    }
  }
  for (const x of calendarDates) {
    for (const day of DAYS) {
      if (x.date !== dates[day].ymd) continue;
      if (x.exception_type === '1') out[day].add(x.service_id);
      if (x.exception_type === '2') out[day].delete(x.service_id);
    }
  }
  return out;
}

/** A small CSV file (routes, stops, trips, calendar) as objects. */
export function csvRows(text) {
  const lines = String(text).replace(/^﻿/, '').split('\n');
  const head = splitCsv(lines[0].replace(/\r$/, ''), ',').map((h) => h.trim());
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i].replace(/\r$/, '');
    if (!l) continue;
    const f = splitCsv(l, ',');
    const o = {};
    for (let j = 0; j < head.length; j++) o[head[j]] = (f[j] ?? '').trim();
    out.push(o);
  }
  return out;
}

const secs = (t) => {
  const m = /^(\d+):(\d{2}):(\d{2})$/.exec(String(t ?? '').trim());
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
};

const routeName = (r) => r.route_short_name || r.route_long_name || r.route_id;

/** Fold one departure into a station's per-line, per-direction, per-day counters. */
export function tally(acc, { station, route, dir, day, t }) {
  const st = acc.get(station) ?? new Map();
  acc.set(station, st);
  const key = `${route}\u0000${dir}\u0000${day}`;
  const c = st.get(key) ?? { route, dir, day, first: t, last: t, trips: 0, hours: {} };
  if (t < c.first) c.first = t;
  if (t > c.last) c.last = t;
  c.trips++;
  const h = Math.floor(t / 3600);
  c.hours[h] = (c.hours[h] ?? 0) + 1;
  st.set(key, c);
}

/** The counters as the station's timetable summary. */
export function summarise(counters, { routes, headsigns }) {
  const out = Object.fromEntries(DAYS.map((d) => [d, []]));
  for (const c of counters.values()) {
    const r = routes.get(c.route);
    out[c.day].push({
      route: c.route,
      line: r ? routeName(r) : c.route,
      color: r?.route_color ? `#${r.route_color}` : null,
      toward: headsigns.get(`${c.route}\u0000${c.dir}`) ?? null,
      first: hhmm(c.first),
      last: hhmm(c.last),
      trips: c.trips,
      peakPerHour: Math.max(...Object.values(c.hours)),
    });
  }
  for (const d of DAYS)
    out[d].sort(
      (a, b) =>
        String(a.line).localeCompare(String(b.line)) ||
        String(a.toward).localeCompare(String(b.toward)),
    );
  return out;
}

async function member(path, name) {
  const out = [];
  try {
    for await (const l of zipMemberLines(path, name)) out.push(l);
  } catch {
    return '';
  }
  return out.join('\n');
}

export function lineItem(city, r, { stations = 0, tripIds = null } = {}) {
  const c = CITIES[city];
  const name = routeName(r);
  const mode = ROUTE_TYPE[Number(r.route_type)] ?? 'transit';
  return {
    externalId: `${city}-line-${r.route_id}`,
    kind: 'transit-line',
    title: `${name}${r.route_long_name && r.route_long_name !== name ? ` ${r.route_long_name}` : ''} (${c.name})`,
    summary: `${name}${r.route_long_name && r.route_long_name !== name ? `, ${r.route_long_name},` : ''} is a ${mode} line of the ${c.system} in ${c.name}${stations ? `, ${stations} stations` : ''}.${r.route_desc ? ` ${r.route_desc}` : ''}`,
    url: r.route_url || null,
    publishedAt: null,
    timeKnown: false,
    precision: 'day',
    tags: [
      'transit',
      'line',
      `city-${city}`,
      `mode-${slugify(mode)}`,
      `route-${slugify(r.route_id)}`,
    ],
    data: {
      city,
      cityName: c.name,
      system: c.system,
      routeId: r.route_id,
      name,
      longName: r.route_long_name || null,
      description: r.route_desc || null,
      mode,
      color: r.route_color ? `#${r.route_color}` : null,
      textColor: r.route_text_color ? `#${r.route_text_color}` : null,
      stations,
      ...(tripIds ? { tripIds } : {}),
      source: `${c.system} GTFS`,
      dataset: c.gtfs,
    },
  };
}

export function stationItem(city, s, { lines = [], schedule = null, stopIds = [] } = {}) {
  const c = CITIES[city];
  const lat = Number(s.stop_lat);
  const lon = Number(s.stop_lon);
  const names = [...new Set(lines.map((l) => l.name))];
  return {
    externalId: `${city}-station-${s.stop_id}`,
    kind: 'transit-station',
    title: `${s.stop_name} (${c.name})`,
    summary: `${s.stop_name}, a station of the ${c.system}${names.length ? `, served by ${names.join(', ')}` : ''}.`,
    url: null,
    publishedAt: null,
    timeKnown: false,
    precision: 'day',
    tags: [
      'transit',
      'station',
      `city-${city}`,
      ...lines.map((l) => `route-${slugify(l.route)}`),
      s.wheelchair_boarding === '1' ? 'step-free' : null,
    ].filter(Boolean),
    data: {
      city,
      cityName: c.name,
      system: c.system,
      stationId: s.stop_id,
      name: s.stop_name,
      place: Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null,
      lines,
      stopIds,
      wheelchair:
        s.wheelchair_boarding === '1' ? true : s.wheelchair_boarding === '2' ? false : null,
      schedule,
      scheduleNote:
        'First and last departures, trips and the busiest hour per line and direction, from the published timetable for the next Wednesday, Saturday and Sunday.',
      source: `${c.system} GTFS`,
      dataset: c.gtfs,
    },
  };
}

export const gtfsTransit = defineAdapter({
  name: 'gtfs-transit',
  title: 'Transit lines, stations and timetables (GTFS)',
  collection: 'transit',
  description:
    "A city's rail transit from its published GTFS timetable: every line, every station with the lines that serve it, and per line and direction its first and last departure, trips and busiest hour on a weekday, Saturday and Sunday. Keyless.",
  docs: 'https://gtfs.org/schedule/',
  kinds: ['transit-line', 'transit-station'],
  cadenceMinutes: 7 * 24 * 60,
  budgetMs: 40 * 60_000,
  configFields: [
    {
      key: 'city',
      label: 'City',
      type: 'select',
      options: Object.keys(CITIES).filter((k) => CITIES[k].kind === 'gtfs'),
    },
  ],
  defaultSources: Object.entries(CITIES)
    .filter(([, c]) => c.kind === 'gtfs')
    .map(([slug, c]) => ({
      slug: `transit-${slug}`,
      name: `${c.system}: lines, stations, timetables`,
      config: { city: slug },
    })),

  async *pull({ config, http, log }) {
    const city = String(config.city);
    const c = CITIES[city];
    if (!c?.gtfs) throw new Error(`gtfs-transit has no GTFS city ${city}`);
    const dir = await dumpDir(`transit-${city}`);
    const path = `${dir}/gtfs.zip`;
    await rm(path, { force: true });
    const got = await http.download(c.gtfs, path, { timeoutMs: 10 * 60_000 });
    if (!got.complete) return { note: 'download incomplete', nextInMinutes: 30 };

    const types = new Set(c.routeTypes.map(String));
    const routes = new Map(
      csvRows(await member(path, 'routes.txt'))
        .filter((r) => types.has(String(r.route_type)))
        .map((r) => [r.route_id, r]),
    );
    const stops = csvRows(await member(path, 'stops.txt'));
    const byId = new Map(stops.map((s) => [s.stop_id, s]));
    const parentOf = (id) => {
      const s = byId.get(id);
      return s?.parent_station && byId.has(s.parent_station) ? s.parent_station : id;
    };
    const dates = sampleDates();
    const services = activeServices(
      csvRows(await member(path, 'calendar.txt')),
      csvRows(await member(path, 'calendar_dates.txt')),
      dates,
    );

    const trips = new Map();
    const headsignCount = new Map();
    const tripIdsByRoute = new Map();
    for (const t of csvRows(await member(path, 'trips.txt'))) {
      if (!routes.has(t.route_id)) continue;
      const days = DAYS.filter((d) => services[d].has(t.service_id));
      trips.set(t.trip_id, { route: t.route_id, dir: t.direction_id || '0', days });
      if (c.tripMap) {
        const l = tripIdsByRoute.get(t.route_id) ?? [];
        l.push(t.trip_id);
        tripIdsByRoute.set(t.route_id, l);
      }
      if (t.trip_headsign) {
        const k = `${t.route_id}\u0000${t.direction_id || '0'}\u0000${t.trip_headsign}`;
        headsignCount.set(k, (headsignCount.get(k) ?? 0) + 1);
      }
    }
    const headsigns = new Map();
    const best = new Map();
    for (const [k, n] of headsignCount) {
      const [route, d, sign] = k.split('\u0000');
      const rk = `${route}\u0000${d}`;
      if (n > (best.get(rk) ?? 0)) {
        best.set(rk, n);
        headsigns.set(rk, sign);
      }
    }
    log(
      `${routes.size} lines, ${trips.size} trips, services ${DAYS.map((d) => services[d].size).join('/')}`,
    );

    // One pass over stop_times. The header decides the columns; everything else is skipped cheaply.
    const acc = new Map();
    const stationRoutes = new Map();
    const stationStops = new Map();
    let cols = null;
    let seen = 0;
    for await (const raw of zipMemberLines(path, 'stop_times.txt')) {
      const line = raw.replace(/\r$/, '');
      if (!cols) {
        const h = splitCsv(line.replace(/^﻿/, ''), ',').map((x) => x.trim());
        cols = {
          trip: h.indexOf('trip_id'),
          dep: h.indexOf('departure_time'),
          arr: h.indexOf('arrival_time'),
          stop: h.indexOf('stop_id'),
        };
        continue;
      }
      const f = line.includes('"') ? splitCsv(line, ',') : line.split(',');
      const trip = trips.get(f[cols.trip]);
      if (!trip) continue;
      seen++;
      const stopId = f[cols.stop];
      const station = parentOf(stopId);
      const rs = stationRoutes.get(station) ?? new Set();
      rs.add(trip.route);
      stationRoutes.set(station, rs);
      const ss = stationStops.get(station) ?? new Set();
      ss.add(stopId);
      stationStops.set(station, ss);
      const t = secs(f[cols.dep]) ?? secs(f[cols.arr]);
      if (t === null) continue;
      for (const day of trip.days)
        tally(acc, { station, route: trip.route, dir: trip.dir, day, t });
    }
    log(`${seen} stop times on ${stationRoutes.size} stations`);

    const items = [];
    const routeStations = new Map();
    for (const [station, rs] of stationRoutes)
      for (const r of rs) routeStations.set(r, (routeStations.get(r) ?? 0) + 1);
    for (const r of routes.values()) {
      if (!routeStations.get(r.route_id)) continue;
      items.push(
        lineItem(city, r, {
          stations: routeStations.get(r.route_id),
          tripIds: c.tripMap ? (tripIdsByRoute.get(r.route_id) ?? []) : null,
        }),
      );
    }
    for (const [station, rs] of stationRoutes) {
      const s = byId.get(station);
      if (!s) continue;
      const lines = [...rs].map((id) => {
        const r = routes.get(id);
        return {
          route: id,
          name: r ? routeName(r) : id,
          color: r?.route_color ? `#${r.route_color}` : null,
        };
      });
      const schedule = acc.has(station) ? summarise(acc.get(station), { routes, headsigns }) : null;
      const item = stationItem(city, s, {
        lines,
        schedule,
        stopIds: [...(stationStops.get(station) ?? [])],
      });
      if (item) items.push(item);
    }
    await rm(path, { force: true });
    for (let i = 0; i < items.length; i += 500) yield { items: items.slice(i, i + 500) };
    return {
      note: `${routeStations.size} lines, ${stationRoutes.size} stations (${dates.weekday.ymd}/${dates.saturday.ymd}/${dates.sunday.ymd})`,
    };
  },
});

/* ---------------------------------------------------------------- alerts -- */

/** One GTFS-realtime alert entity as a row. */
export function gtfsAlertItem(
  city,
  entity,
  { ended = false, now = new Date().toISOString(), firstSeen = now } = {},
) {
  const a = entity?.alert;
  if (!a || !entity.id) return null;
  const c = CITIES[city];
  const header = translated(a.headerText);
  const text = translated(a.descriptionText);
  if (!header && !text) return null;
  const routeIds = [
    ...new Set((a.informedEntity ?? []).map((e) => e.routeId ?? e.trip?.routeId).filter(Boolean)),
  ];
  const start = a.activePeriod?.[0]?.start
    ? new Date(a.activePeriod[0].start * 1000).toISOString()
    : null;
  const end = a.activePeriod?.[a.activePeriod.length - 1]?.end
    ? new Date(a.activePeriod[a.activePeriod.length - 1].end * 1000).toISOString()
    : null;
  return {
    externalId: `${city}-alert-${entity.id}`,
    kind: 'service-alert',
    title: `${routeIds.length ? `${routeIds.slice(0, 6).join(', ')}: ` : ''}${header ?? text.slice(0, 140)} (${c.name})`,
    summary: [
      text && text !== header ? text : header,
      ended ? ` No longer in the feed as of ${now}.` : '',
    ]
      .join('')
      .slice(0, 3900),
    url: translated(a.url) ?? c.agencyUrl,
    publishedAt: start ?? firstSeen,
    timeKnown: true,
    precision: 'minute',
    tags: [
      'transit',
      'alert',
      `city-${city}`,
      ended ? 'ended' : 'active',
      a.effect && a.effect !== 'UNKNOWN_EFFECT' ? `effect-${slugify(a.effect)}` : null,
      ...routeIds.slice(0, 20).map((r) => `route-${slugify(r)}`),
    ].filter(Boolean),
    data: {
      city,
      cityName: c.name,
      header,
      description: text,
      routes: routeIds,
      cause: a.cause && a.cause !== 'UNKNOWN_CAUSE' ? a.cause : null,
      effect: a.effect && a.effect !== 'UNKNOWN_EFFECT' ? a.effect : null,
      activeFrom: start,
      activeUntil: end,
      status: ended ? 'ended' : 'active',
      firstSeenAt: firstSeen,
      lastSeenAt: now,
      source: `${c.system} GTFS-realtime alerts`,
      dataset: c.alerts,
    },
  };
}

/** A TfL line status that is not Good Service, as a row. */
export function tflStatusItem(
  line,
  status,
  { ended = false, now = new Date().toISOString(), firstSeen = now } = {},
) {
  const c = CITIES.london;
  const id = `${line.id}-${slugify(status.statusSeverityDescription)}-${status.validityPeriods?.[0]?.fromDate ?? ''}`;
  return {
    externalId: `london-alert-${id}`,
    kind: 'service-alert',
    title: `${line.name}: ${status.statusSeverityDescription} (London)`,
    summary: `${status.reason ?? `${line.name} has ${status.statusSeverityDescription}.`}${ended ? ` Cleared by ${now}.` : ''}`,
    url: `https://tfl.gov.uk/${line.modeName === 'tube' ? 'tube' : line.modeName}/status/`,
    publishedAt: status.validityPeriods?.[0]?.fromDate ?? firstSeen,
    timeKnown: true,
    precision: 'minute',
    tags: [
      'transit',
      'alert',
      'city-london',
      ended ? 'ended' : 'active',
      `effect-${slugify(status.statusSeverityDescription)}`,
      `route-${slugify(line.id)}`,
    ],
    data: {
      city: 'london',
      cityName: c.name,
      header: `${line.name}: ${status.statusSeverityDescription}`,
      description: status.reason ?? null,
      routes: [line.id],
      effect: status.statusSeverityDescription,
      activeFrom: status.validityPeriods?.[0]?.fromDate ?? null,
      activeUntil: status.validityPeriods?.[0]?.toDate ?? null,
      status: ended ? 'ended' : 'active',
      firstSeenAt: firstSeen,
      lastSeenAt: now,
      source: 'TfL Unified API line status',
      dataset: 'https://api.tfl.gov.uk/Line/Mode/{modes}/Status',
    },
  };
}

export const transitAlerts = defineAdapter({
  name: 'transit-alerts',
  title: 'Transit service alerts',
  collection: 'transit',
  description:
    "Each city's live service alerts (delays, suspensions, reroutes, station closures) from its GTFS-realtime alerts feed, or TfL's line status for London. One row per alert, written once more when it clears. Keyless, every five minutes.",
  docs: 'https://gtfs.org/realtime/',
  kinds: ['service-alert'],
  cadenceMinutes: 5,
  configFields: [{ key: 'city', label: 'City', type: 'select', options: Object.keys(CITIES) }],
  defaultSources: Object.entries(CITIES)
    .filter(([, c]) => c.alerts || c.kind === 'tfl')
    .map(([slug, c]) => ({
      slug: `transit-alerts-${slug}`,
      name: `${c.name} transit alerts`,
      config: { city: slug },
    })),

  async pull({ config, cursor, http, log }) {
    const city = String(config.city);
    const c = CITIES[city];
    const now = new Date().toISOString();
    const open = { ...(cursor.open ?? {}) };
    const items = [];
    const live = new Set();

    if (c.kind === 'tfl') {
      const lines = await http.json(
        `https://api.tfl.gov.uk/Line/Mode/${c.modes.join(',')}/Status`,
        { timeoutMs: 30_000 },
      );
      for (const line of lines ?? []) {
        for (const st of line.lineStatuses ?? []) {
          if (st.statusSeverity === 10) continue; // Good Service
          const probe = tflStatusItem(line, st, { now });
          const firstSeen = open[probe.externalId]?.firstSeen ?? now;
          const item = tflStatusItem(line, st, { now, firstSeen });
          live.add(item.externalId);
          open[item.externalId] = { firstSeen, line, status: st };
          items.push(item);
        }
      }
      for (const [id, held] of Object.entries(cursor.open ?? {})) {
        if (live.has(id)) continue;
        delete open[id];
        items.push(
          tflStatusItem(held.line, held.status, { ended: true, now, firstSeen: held.firstSeen }),
        );
      }
    } else {
      const res = await http.request(c.alerts, { timeoutMs: 30_000 });
      if (!res.ok) throw new Error(`${res.status} from ${c.alerts}`);
      const feed = decodeFeed(new Uint8Array(await res.arrayBuffer()));
      for (const e of feed.entity ?? []) {
        if (!e.alert) continue;
        const id = `${city}-alert-${e.id}`;
        const firstSeen = open[id]?.firstSeen ?? now;
        const item = gtfsAlertItem(city, e, { now, firstSeen });
        if (!item) continue;
        live.add(id);
        open[id] = {
          firstSeen,
          entity: {
            id: e.id,
            alert: {
              headerText: e.alert.headerText,
              descriptionText: e.alert.descriptionText,
              informedEntity: (e.alert.informedEntity ?? []).slice(0, 20),
              effect: e.alert.effect,
              activePeriod: e.alert.activePeriod,
            },
          },
        };
        items.push(item);
      }
      for (const [id, held] of Object.entries(cursor.open ?? {})) {
        if (live.has(id)) continue;
        delete open[id];
        const item = gtfsAlertItem(city, held.entity, {
          ended: true,
          now,
          firstSeen: held.firstSeen,
        });
        if (item) items.push(item);
      }
    }
    log(`${live.size} active alerts`);
    return { items, cursor: { open }, note: `${live.size} active` };
  },
});

/* ---------------------------------------------------------------- london -- */

/** TfL's own line colours; the API does not publish them. */
export const TFL_COLORS = {
  bakerloo: '#B36305',
  central: '#E32017',
  circle: '#FFD300',
  district: '#00782A',
  'hammersmith-city': '#F3A9BB',
  jubilee: '#A0A5A9',
  metropolitan: '#9B0056',
  northern: '#000000',
  piccadilly: '#003688',
  victoria: '#0098D4',
  'waterloo-city': '#95CDBA',
  dlr: '#00A4A7',
  elizabeth: '#6950A1',
  tram: '#84B817',
  liberty: '#61686B',
  lioness: '#FFA600',
  mildmay: '#006FE6',
  suffragette: '#18A95D',
  weaver: '#9B0058',
  windrush: '#DC241F',
};

export const tflNetwork = defineAdapter({
  name: 'tfl-network',
  title: 'London rail transit lines and stations (TfL)',
  collection: 'transit',
  description:
    'Every London Underground, DLR, Overground, Elizabeth line and tram line and station from the TfL Unified API, with the lines serving each station. Keyless, daily.',
  docs: 'https://api.tfl.gov.uk/',
  kinds: ['transit-line', 'transit-station'],
  cadenceMinutes: 24 * 60,
  defaultSources: [
    { slug: 'transit-london', name: 'London Underground, DLR, Overground, Elizabeth line, trams' },
  ],

  async pull({ http, log }) {
    const c = CITIES.london;
    const modes = c.modes.join(',');
    const lines = await http.json(`https://api.tfl.gov.uk/Line/Mode/${modes}`, {
      timeoutMs: 60_000,
    });
    const lineById = new Map((lines ?? []).map((l) => [l.id, l]));
    const sp = await http.json(`https://api.tfl.gov.uk/StopPoint/Mode/${modes}`, {
      timeoutMs: 120_000,
    });
    const stations = (sp?.stopPoints ?? []).filter(
      (s) =>
        ['NaptanMetroStation', 'NaptanRailStation'].includes(s.stopType) &&
        (s.lines ?? []).some((l) => lineById.has(l.id)),
    );
    const perLine = new Map();
    const items = [];
    const seen = new Set();
    for (const s of stations) {
      if (seen.has(s.naptanId)) continue;
      seen.add(s.naptanId);
      const ls = (s.lines ?? [])
        .filter((l) => lineById.has(l.id))
        .map((l) => ({
          route: l.id,
          name: lineById.get(l.id).name,
          color: TFL_COLORS[l.id] ?? null,
        }));
      for (const l of ls) perLine.set(l.route, (perLine.get(l.route) ?? 0) + 1);
      const name = String(s.commonName)
        .replace(/ (Underground|DLR|Rail|Tram) Station$/i, '')
        .replace(/ Station$/i, '');
      items.push(
        stationItemLondon(
          { stop_id: s.naptanId, stop_name: name, stop_lat: s.lat, stop_lon: s.lon },
          { lines: ls, stopIds: [s.naptanId] },
        ),
      );
    }
    for (const l of lines ?? []) {
      items.push({
        ...lineItem(
          'london',
          {
            route_id: l.id,
            route_short_name: l.name,
            route_type:
              l.modeName === 'tram' ? 0 : l.modeName === 'tube' || l.modeName === 'dlr' ? 1 : 2,
          },
          { stations: perLine.get(l.id) ?? 0 },
        ),
        url: `https://tfl.gov.uk/${l.modeName}/route/${l.id}/`,
      });
      items[items.length - 1].data.color = TFL_COLORS[l.id] ?? null;
    }
    log(`${lines?.length ?? 0} lines, ${seen.size} stations`);
    return { items, note: `${lines?.length ?? 0} lines, ${seen.size} stations` };
  },
});

function stationItemLondon(s, opts) {
  const item = stationItem('london', s, opts);
  item.data.source = 'TfL Unified API';
  item.data.dataset = 'https://api.tfl.gov.uk/StopPoint/Mode/{modes}';
  item.data.scheduleNote = 'Live arrivals only: TfL timetables are not summarised here.';
  return item;
}
