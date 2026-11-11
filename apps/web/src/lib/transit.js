import { CITIES, decodeFeed } from '@nichedb/core/transit';
import * as q from '@nichedb/db/queries';
import { rowOut } from './vehicles.js';

/**
 * Transit, live: vehicles on the map and the next arrivals at a station.
 *
 * Lines and stations are stored rows (gtfs-transit, tfl-network); this module
 * reads them once per ten minutes per process, then joins the agencies'
 * realtime feeds to them on each request. Feeds are cached 20 s per process,
 * so a map polling every 15 s from many browsers is still one request to the
 * agency per feed per 20 s.
 */

const UA = 'niche-db/0.1 (+https://nichedb.dev)';
const feeds = new Map();
const tables = new Map();

async function fetchCached(url, kind, ttlMs = 20_000) {
  const hit = feeds.get(url);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  let value = null;
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: kind === 'json' ? 'application/json' : '*/*' },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok)
      value =
        kind === 'json' ? await res.json() : decodeFeed(new Uint8Array(await res.arrayBuffer()));
  } catch {
    value = null;
  }
  feeds.set(url, { at: Date.now(), value });
  return value;
}

/** Every stored row of one kind for a city, paged past the 500-row page cap. */
async function cityRows(city, tag) {
  const col = await q.getCollection('transit');
  if (!col) return [];
  const out = [];
  let beforeId = null;
  for (let i = 0; i < 10; i++) {
    const page = await q
      .recentItems({
        collectionId: col.id,
        tags: [`city-${city}`, tag],
        beforeId,
        limit: 500,
        timeoutMs: 8_000,
      })
      .catch(() => []);
    out.push(...page);
    if (page.length < 500) break;
    beforeId = page[page.length - 1].id;
  }
  return out.map(rowOut);
}

/** A city's stations and lines, indexed for the live joins. Cached ten minutes. */
export async function cityTables(city) {
  const hit = tables.get(city);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.value;
  const [stations, lines] = await Promise.all([cityRows(city, 'station'), cityRows(city, 'line')]);
  return primeCity(city, { stations, lines });
}

/** Index a city's rows for the live joins and cache them (tests seed it directly). */
export function primeCity(city, { stations = [], lines = [] }) {
  const byStop = new Map();
  for (const s of stations) for (const id of s.data.stopIds ?? []) byStop.set(id, s);
  const byRoute = new Map(lines.map((l) => [l.data.routeId, l]));
  const tripRoute = new Map();
  for (const l of lines) for (const t of l.data.tripIds ?? []) tripRoute.set(t, l.data.routeId);
  const value = { stations, lines, byStop, byRoute, tripRoute };
  tables.set(city, { at: Date.now(), value });
  return value;
}

const lineOf = (t, routeId) => {
  const l = t.byRoute.get(routeId);
  return {
    route: routeId ?? null,
    line: l?.data.name ?? routeId ?? null,
    color: l?.data.color ?? null,
  };
};

/** Every vehicle the city publishes right now, as map points. */
export async function liveVehicles(city) {
  const c = CITIES[city];
  if (!c) return [];
  const out = [];
  if (c.kind === 'gtfs' && (c.vehicles || c.vehiclesFromTrips)) {
    const t = await cityTables(city);
    const urls = c.vehicles ? [c.vehicles] : c.tripFeeds;
    const msgs = await Promise.all(urls.map((u) => fetchCached(u, 'pb')));
    for (const m of msgs) {
      for (const e of m?.entity ?? []) {
        const v = e.vehicle;
        if (!v) continue;
        let lat = v.position?.latitude;
        let lon = v.position?.longitude;
        const at = v.stopId ? t.byStop.get(v.stopId) : null;
        if ((lat === undefined || lon === undefined) && at?.data.place) {
          // The NYC subway says which stop a train is at, not where it is.
          lat = at.data.place.lat;
          lon = at.data.place.lon;
        }
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        const routeId = v.trip?.routeId ?? t.tripRoute.get(v.trip?.tripId);
        out.push({
          id: v.vehicle?.id ?? e.id,
          label: v.vehicle?.label ?? null,
          ...lineOf(t, routeId),
          lat,
          lon,
          heading: v.position?.bearing ?? null,
          status: v.currentStatus ? String(v.currentStatus).toLowerCase().replace(/_/g, ' ') : null,
          stop: at?.data.name ?? null,
          at: v.timestamp ? new Date(v.timestamp * 1000).toISOString() : null,
        });
      }
    }
  } else if (c.kind === 'umoiq') {
    const body = await fetchCached(
      `https://retro.umoiq.com/service/publicJSONFeed?command=vehicleLocations&a=${c.agency}&t=0`,
      'json',
    );
    for (const v of [].concat(body?.vehicle ?? [])) {
      const lat = Number(v.lat);
      const lon = Number(v.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      out.push({
        id: v.id,
        label: v.id,
        route: v.routeTag ?? null,
        line: v.routeTag ?? null,
        color: null,
        lat,
        lon,
        heading: Number(v.heading) >= 0 ? Number(v.heading) : null,
        status: Number(v.speedKmHr) > 0 ? `moving ${v.speedKmHr} km/h` : 'stopped',
        stop: null,
        at: new Date(Date.now() - Number(v.secsSinceReport ?? 0) * 1000).toISOString(),
      });
    }
  } else if (c.kind === 'septa') {
    const [buses, trains] = await Promise.all([
      fetchCached('https://www3.septa.org/api/TransitViewAll/index.php', 'json'),
      fetchCached('https://www3.septa.org/api/TrainView/index.php', 'json'),
    ]);
    for (const group of buses?.routes ?? []) {
      for (const [route, list] of Object.entries(group)) {
        for (const v of list ?? []) {
          const lat = Number(v.lat);
          const lon = Number(v.lng);
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
          out.push({
            id: v.VehicleID,
            label: v.label,
            route,
            line: route,
            color: null,
            lat,
            lon,
            heading: Number(v.heading) >= 0 ? Number(v.heading) : null,
            status:
              `${v.Direction ?? ''} to ${v.destination ?? '?'}${Number(v.late) > 0 ? `, ${v.late} min late` : ''}`.trim(),
            stop: v.next_stop_name ?? null,
            at: v.timestamp ? new Date(v.timestamp * 1000).toISOString() : null,
          });
        }
      }
    }
    for (const v of Array.isArray(trains) ? trains : []) {
      const lat = Number(v.lat);
      const lon = Number(v.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      out.push({
        id: `rr-${v.trainno}`,
        label: `Train ${v.trainno}`,
        route: v.line,
        line: `${v.line} (Regional Rail)`,
        color: '#45637A',
        lat,
        lon,
        heading: Number(v.heading) >= 0 ? Number(v.heading) : null,
        status: `to ${v.dest}${Number(v.late) > 0 ? `, ${v.late} min late` : ', on time'}`,
        stop: v.nextstop ?? null,
        at: null,
      });
    }
  }
  return out;
}

/** The next arrivals at one station, soonest first. */
export async function liveArrivals(city, station) {
  const c = CITIES[city];
  if (!c || !station) return [];
  const now = Date.now();
  if (c.kind === 'tfl') {
    const id = station.data.stopIds?.[0];
    const body = id
      ? await fetchCached(
          `https://api.tfl.gov.uk/StopPoint/${encodeURIComponent(id)}/Arrivals`,
          'json',
          30_000,
        )
      : null;
    return (Array.isArray(body) ? body : [])
      .map((a) => ({
        line: a.lineName,
        route: a.lineId,
        color: station.data.lines?.find((l) => l.route === a.lineId)?.color ?? null,
        toward: a.destinationName ?? a.towards ?? null,
        platform: a.platformName ?? null,
        at: a.expectedArrival,
        inMinutes: Math.max(0, Math.round((Date.parse(a.expectedArrival) - now) / 60_000)),
      }))
      .sort((x, y) => Date.parse(x.at) - Date.parse(y.at))
      .slice(0, 30);
  }
  if (c.kind !== 'gtfs' || !c.tripFeeds) return [];
  const t = await cityTables(city);
  const mine = new Set(station.data.stopIds ?? []);
  const msgs = await Promise.all(c.tripFeeds.map((u) => fetchCached(u, 'pb')));
  const out = [];
  for (const m of msgs) {
    for (const e of m?.entity ?? []) {
      const tu = e.tripUpdate;
      if (!tu) continue;
      const updates = tu.stopTimeUpdate ?? [];
      const here = updates.find((u) => mine.has(u.stopId) && u.scheduleRelationship !== 'SKIPPED');
      if (!here) continue;
      const time = (here.arrival?.time ?? here.departure?.time) * 1000;
      if (!Number.isFinite(time) || time < now - 30_000) continue;
      const last = updates[updates.length - 1];
      const routeId = tu.trip?.routeId ?? t.tripRoute.get(tu.trip?.tripId);
      out.push({
        ...lineOf(t, routeId),
        toward: last && last !== here ? (t.byStop.get(last.stopId)?.data.name ?? null) : null,
        platform: null,
        delaySeconds: here.arrival?.delay ?? here.departure?.delay ?? null,
        at: new Date(time).toISOString(),
        inMinutes: Math.max(0, Math.round((time - now) / 60_000)),
      });
    }
  }
  return out.sort((x, y) => Date.parse(x.at) - Date.parse(y.at)).slice(0, 30);
}

/** Active alerts for a city, newest first. */
export async function cityAlerts(city, limit = 50) {
  const col = await q.getCollection('transit');
  if (!col) return [];
  const rows = await q
    .recentItems({
      collectionId: col.id,
      tags: [`city-${city}`, 'alert', 'active'],
      sort: 'updated',
      limit,
      timeoutMs: 8_000,
    })
    .catch(() => []);
  return rows.map(rowOut);
}

/** A station by its id within a city, or by its full row id. */
export async function findStation(city, id) {
  const t = await cityTables(city);
  const want = String(id);
  return t.stations.find((s) => s.data.stationId === want || s.externalId === want) ?? null;
}
