import {
  amtrakItem,
  DIGITRAFFIC,
  DIGITRAFFIC_HEADERS,
  FINTRAFFIC_HEADERS,
  FINTRAFFIC_RAIL,
  finnishItem,
  NAV_STATUS,
} from '@nichedb/adapters';
import { config } from '@nichedb/config';
import * as q from '@nichedb/db/queries';
import {
  degreesLat,
  degreesLong,
  eciToGeodetic,
  gstime,
  propagate,
  twoline2satrec,
} from 'satellite.js';

/**
 * Airplanes, satellites and ships: what the three pages ask besides the
 * stored rows. The register row is ours (FAA, GCAT, AIS); where the thing is
 * right now is asked live, and cached a short while per process so a page
 * that is shared around does not become our traffic on someone else's API.
 *
 *   airplanes  adsb.lol /v2/hex|reg|callsign   (community ADS-B, keyless)
 *   satellites SatNOGS DB /api/tle             (CC BY-SA, keyless) + SGP4 here
 *   ships      Digitraffic /locations?mmsi=     (CC BY 4.0, keyless)
 */

const UA = 'niche-db/0.1 (+https://nichedb.dev)';
const cache = new Map();

async function cachedJson(url, { ttlMs = 30_000, headers = {} } = {}) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  let value = null;
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'application/json', ...headers },
      signal: AbortSignal.timeout(8_000),
    });
    value = res.ok ? await res.json() : null;
  } catch {
    value = null;
  }
  if (cache.size > 2000) cache.clear();
  cache.set(url, { at: Date.now(), value });
  return value;
}

/* ------------------------------------------------------------ airplanes -- */

/** What a typed query is: an N-number, an ICAO hex, or a callsign. */
export function parseAircraftQuery(raw) {
  const s = String(raw ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
  if (!s) return null;
  if (/^N[1-9][0-9A-Z]{0,4}$/.test(s)) return { type: 'reg', value: s };
  if (/^[0-9A-F]{6}$/.test(s) && /[A-F]/.test(s)) return { type: 'hex', value: s.toLowerCase() };
  if (/^[1-9][0-9A-Z]{0,4}$/.test(s) && /^\d/.test(s)) return { type: 'reg', value: `N${s}` };
  if (/^[A-Z0-9]{2,8}$/.test(s)) return { type: 'callsign', value: s };
  return { type: 'text', value: String(raw).trim() };
}

/** Aircraft adsb.lol can see now for a hex, registration or callsign. */
export async function liveAircraft({ type, value }) {
  const path = { hex: 'hex', reg: 'reg', callsign: 'callsign' }[type];
  if (!path) return [];
  const body = await cachedJson(`https://api.adsb.lol/v2/${path}/${encodeURIComponent(value)}`, {
    ttlMs: 15_000,
  });
  return Array.isArray(body?.ac) ? body.ac.map(aircraftNow) : [];
}

export function aircraftNow(ac) {
  const lat = Number(ac.lat);
  const lon = Number(ac.lon);
  return {
    hex: ac.hex ?? null,
    callsign: String(ac.flight ?? '').trim() || null,
    registration: ac.r ?? null,
    type: ac.t ?? null,
    description: ac.desc ?? null,
    operator: ac.ownOp ?? null,
    altitudeFt:
      ac.alt_baro === 'ground'
        ? 0
        : Number.isFinite(Number(ac.alt_baro))
          ? Number(ac.alt_baro)
          : null,
    onGround: ac.alt_baro === 'ground',
    groundSpeedKt: Number.isFinite(Number(ac.gs)) ? Number(ac.gs) : null,
    trackDeg: Number.isFinite(Number(ac.track)) ? Number(ac.track) : null,
    squawk: ac.squawk ?? null,
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
    seenSecondsAgo: Number.isFinite(Number(ac.seen_pos ?? ac.seen))
      ? Number(ac.seen_pos ?? ac.seen)
      : null,
    map: ac.hex ? `https://globe.adsb.lol/?icao=${encodeURIComponent(ac.hex)}` : null,
  };
}

/** The register row for an N-number or a hex. */
export async function aircraftRow(parsed) {
  if (parsed?.type === 'reg') return q.itemByExternalId('aircraft', parsed.value);
  if (parsed?.type === 'hex') {
    const col = await q.getCollection('aircraft');
    if (!col) return null;
    const [row] = await q.recentItems({
      collectionId: col.id,
      tags: [`hex-${parsed.value}`],
      limit: 1,
      timeoutMs: 8_000,
    });
    return row ?? null;
  }
  return null;
}

/* ----------------------------------------------------------- satellites -- */

/** A NORAD number, an international designator (1998-067A) or a name. */
export function parseSatelliteQuery(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (/^\d{1,6}$/.test(s)) return { type: 'norad', value: Number(s) };
  if (/^\d{4}-\d{3}[A-Z]{0,3}$/i.test(s)) return { type: 'designator', value: s.toUpperCase() };
  return { type: 'text', value: s };
}

/** GCAT's id for a NORAD number: S00001, S25544, S123456. */
export const jcatFor = (norad) => `S${String(norad).padStart(5, '0')}`;

export async function satelliteRow(parsed) {
  if (parsed?.type === 'norad') return q.itemByExternalId('satellites', jcatFor(parsed.value));
  return null;
}

/** The newest TLE SatNOGS holds for a NORAD number, or null. */
export async function satelliteTle(norad) {
  const body = await cachedJson(
    `https://db.satnogs.org/api/tle/?norad_cat_id=${encodeURIComponent(norad)}&format=json`,
    { ttlMs: 60 * 60_000 },
  );
  const t = Array.isArray(body) ? body[0] : null;
  return t?.tle1 && t?.tle2
    ? {
        name: t.tle0?.replace(/^0 /, '') ?? null,
        line1: t.tle1,
        line2: t.tle2,
        source: t.tle_source ?? null,
        updated: t.updated ?? null,
      }
    : null;
}

/**
 * Where a TLE puts the satellite at `at`: the point on Earth under it, its
 * height and its speed. SGP4 from a TLE is good to a few kilometres for a day
 * or two around the element set's epoch and drifts after that, so the epoch's
 * age goes with the answer.
 */
export function subpoint(tle, at = new Date()) {
  try {
    const rec = twoline2satrec(tle.line1, tle.line2);
    const pv = propagate(rec, at);
    if (!pv?.position || typeof pv.position === 'boolean') return null;
    const geo = eciToGeodetic(pv.position, gstime(at));
    const v = pv.velocity;
    const speed = v ? Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) : null;
    const epochYear = rec.epochyr < 57 ? 2000 + rec.epochyr : 1900 + rec.epochyr;
    const epoch = new Date(Date.UTC(epochYear, 0, 1) + (rec.epochdays - 1) * 86_400_000);
    return {
      at: at.toISOString(),
      lat: Number(degreesLat(geo.latitude).toFixed(4)),
      lon: Number(degreesLong(geo.longitude).toFixed(4)),
      altitudeKm: Number(geo.height.toFixed(1)),
      speedKmS: speed === null ? null : Number(speed.toFixed(3)),
      periodMin: Number(((2 * Math.PI) / rec.no).toFixed(1)),
      tleEpoch: epoch.toISOString(),
      tleAgeDays: Number(((at - epoch) / 86_400_000).toFixed(1)),
    };
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- ships -- */

/** An MMSI (9 digits), an IMO number (7 digits, optionally "IMO ...") or a name. */
export function parseShipQuery(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (/^\d{9}$/.test(s)) return { type: 'mmsi', value: Number(s) };
  const imo = /^(?:IMO\s*)?(\d{7})$/i.exec(s);
  if (imo) return { type: 'imo', value: Number(imo[1]) };
  return { type: 'text', value: s };
}

export async function shipRow(parsed) {
  if (parsed?.type === 'mmsi') return q.itemByExternalId('ships', `mmsi-${parsed.value}`);
  if (parsed?.type === 'imo') {
    const col = await q.getCollection('ships');
    if (!col) return null;
    const [row] = await q.recentItems({
      collectionId: col.id,
      tags: [`imo-${parsed.value}`],
      limit: 1,
      timeoutMs: 8_000,
    });
    return row ?? null;
  }
  return null;
}

/** A vessel's position now, from Digitraffic, or null when it is out of range. */
export async function liveShip(mmsi) {
  const body = await cachedJson(`${DIGITRAFFIC}/locations?mmsi=${encodeURIComponent(mmsi)}`, {
    ttlMs: 30_000,
    headers: DIGITRAFFIC_HEADERS,
  });
  const f = body?.features?.[0];
  if (!f) return null;
  const p = f.properties ?? {};
  const [lon, lat] = f.geometry?.coordinates ?? [];
  return {
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
    speedKn: Number.isFinite(p.sog) && p.sog !== 102.3 ? p.sog : null,
    courseDeg: Number.isFinite(p.cog) && p.cog !== 360 ? p.cog : null,
    headingDeg: Number.isFinite(p.heading) && p.heading !== 511 ? p.heading : null,
    navStatus: NAV_STATUS[p.navStat] ?? null,
    at: p.timestampExternal ? new Date(p.timestampExternal).toISOString() : null,
  };
}

/** An OpenStreetMap link for a point, for "where is it". */
export const osm = (lat, lon, zoom = 8) =>
  lat === null || lon === null || lat === undefined || lon === undefined
    ? null
    : `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=${zoom}/${lat}/${lon}`;

/* -------------------------------------------------------------- shared -- */

/** The stored counts for a collection: items, and the tags asked for with their counts. */
export async function collectionCounts(slug, wanted = []) {
  const col = await q.getCollection(slug);
  if (!col) return { items: 0, tags: {} };
  const stats = await q.storedCollectionStats(col.id).catch(() => null);
  const tags = {};
  // The stored list has been seen double-encoded (a JSON string inside jsonb).
  let list = stats?.tags ?? [];
  for (let i = 0; i < 2 && typeof list === 'string'; i++) list = JSON.parse(list);
  for (const t of Array.isArray(list) ? list : []) {
    const name = t.tag;
    const n = Number(t.n);
    if (!wanted.length || wanted.includes(name)) tags[name] = n;
  }
  return {
    collection: col,
    items: Number(stats?.items ?? 0),
    computedAt: stats?.computed_at ?? null,
    tags,
  };
}

/** Search one collection by words, bounded so a slow plan never holds a page. */
export async function searchCollection(slug, text, limit = 25) {
  const col = await q.getCollection(slug);
  if (!col) return [];
  return q.searchItems(text, { collectionId: col.id, limit, timeoutMs: 8_000 }).catch(() => []);
}

/* ------------------------------------------------------------ reports -- */

const parse = (v) => {
  let d = v;
  for (let i = 0; i < 2 && typeof d === 'string'; i++) {
    try {
      d = JSON.parse(d);
    } catch {
      return {};
    }
  }
  return d ?? {};
};

/** The fields of a stored row the pages and the API use. */
export const rowOut = (row) =>
  row
    ? {
        id: Number(row.id),
        externalId: row.external_id,
        title: row.title,
        summary: row.summary,
        url: row.url,
        page: `${config.siteUrl}/i/${row.id}`,
        tags: row.tags ?? [],
        updatedAt: row.updated_at ?? null,
        data: parse(row.data),
      }
    : null;

/* ----------------------------------------------------------- resolvers -- */

export async function airplaneReport(raw) {
  const parsed = parseAircraftQuery(raw);
  if (!parsed) return { error: 'Type an N-number, a Mode S hex or a callsign.', status: 400 };
  if (parsed.type === 'text') {
    return {
      query: raw,
      parsed,
      matches: (await searchCollection('aircraft', parsed.value)).map(rowOut),
    };
  }
  let record = rowOut(await aircraftRow(parsed));
  const live = await liveAircraft(
    record?.data?.icaoHex ? { type: 'hex', value: record.data.icaoHex } : parsed,
  );
  // A callsign names a flight, not an airframe: find the airframe by the hex it is flying.
  if (!record && live[0]?.hex)
    record = rowOut(await aircraftRow({ type: 'hex', value: live[0].hex }));
  if (!record && !live.length)
    return {
      query: raw,
      parsed,
      error: `Nothing on the US register or in the air right now for ${parsed.value}.`,
      status: 404,
    };
  return { query: raw, parsed, record, live };
}

export async function satelliteReport(raw) {
  const parsed = parseSatelliteQuery(raw);
  if (!parsed)
    return { error: 'Type a NORAD number, a designator like 1998-067A, or a name.', status: 400 };
  if (parsed.type !== 'norad') {
    const text = parsed.type === 'designator' ? `"${parsed.value}"` : parsed.value;
    return {
      query: raw,
      parsed,
      matches: (await searchCollection('satellites', text)).map(rowOut),
    };
  }
  const record = rowOut(await satelliteRow(parsed));
  const tle = record?.data?.inOrbit === false ? null : await satelliteTle(parsed.value);
  const position = tle ? subpoint(tle) : null;
  if (!record && !tle)
    return {
      query: raw,
      parsed,
      error: `No object with NORAD number ${parsed.value}.`,
      status: 404,
    };
  return { query: raw, parsed, record, tle, position };
}

export async function shipReport(raw) {
  const parsed = parseShipQuery(raw);
  if (!parsed) return { error: 'Type an MMSI, an IMO number or a ship name.', status: 400 };
  if (parsed.type === 'text') {
    return {
      query: raw,
      parsed,
      matches: (await searchCollection('ships', parsed.value)).map(rowOut),
    };
  }
  const record = rowOut(await shipRow(parsed));
  const mmsi = record?.data?.mmsi ?? (parsed.type === 'mmsi' ? parsed.value : null);
  const live = mmsi ? await liveShip(mmsi) : null;
  if (!record && !live)
    return {
      query: raw,
      parsed,
      error: `No vessel ${parsed.type.toUpperCase()} ${parsed.value} in range or on record.`,
      status: 404,
    };
  return { query: raw, parsed, record, live };
}

/* --------------------------------------------------------------- trains -- */

/** A stored row id (amtk-5-2026-11-09, fi-2026-11-11-1, trainline-3389), a train number, or words. */
export function parseTrainQuery(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (/^(amtk|via|fi|trainline)-[\w-]+$/i.test(s)) return { type: 'id', value: s.toLowerCase() };
  const num = /^(?:(amtrak|via|ic|s|pyo|hdm|ak|pvv|[a-z])\s*)?(\d{1,5})$/i.exec(s);
  if (num) return { type: 'number', value: num[2], operator: num[1]?.toLowerCase() ?? null };
  return { type: 'text', value: s };
}

/** Rows for a train number: the runs that carry it, newest first. */
export async function trainRuns(number) {
  const col = await q.getCollection('trains');
  if (!col) return [];
  return q
    .recentItems({
      collectionId: col.id,
      tags: [`train-${String(number).toLowerCase()}`],
      sort: 'updated',
      limit: 12,
      timeoutMs: 8_000,
    })
    .catch(() => []);
}

/** The same row rebuilt from the upstream right now, so a page is never ten minutes old. */
export async function liveTrain(record) {
  const d = record?.data ?? {};
  if (!d.trainNumber) return null;
  if (record.externalId.startsWith('fi-')) {
    const [trains, locs] = await Promise.all([
      cachedJson(`${FINTRAFFIC_RAIL}/trains/${d.startedOn}/${d.trainNumber}`, {
        ttlMs: 30_000,
        headers: FINTRAFFIC_HEADERS,
      }),
      cachedJson(`${FINTRAFFIC_RAIL}/train-locations/latest/${d.trainNumber}`, {
        ttlMs: 30_000,
        headers: FINTRAFFIC_HEADERS,
      }),
    ]);
    const t = Array.isArray(trains) ? trains[0] : null;
    if (!t) return null;
    const names = new Map(
      [...(d.stops ?? []), d.origin, d.destination].filter(Boolean).map((x) => [x.code, x.name]),
    );
    const location = Array.isArray(locs) ? locs.find((l) => l.departureDate === d.startedOn) : null;
    return finnishItem(t, { names, location })?.data ?? null;
  }
  const body = await cachedJson(
    `https://api-v3.amtraker.com/v3/trains/${encodeURIComponent(d.trainNumber)}`,
    { ttlMs: 30_000 },
  );
  const runs = Object.values(body ?? {}).flat();
  const same = runs.map(amtrakItem).find((i) => i?.externalId === record.externalId);
  return same?.data ?? null;
}

export async function trainReport(raw) {
  const parsed = parseTrainQuery(raw);
  if (!parsed)
    return { error: 'Type a train number (Amtrak 5, IC 1), a station or a route.', status: 400 };
  if (parsed.type === 'text') {
    return {
      query: raw,
      parsed,
      matches: (await searchCollection('trains', parsed.value)).map(rowOut),
    };
  }
  if (parsed.type === 'number') {
    let runs = (await trainRuns(parsed.value)).map(rowOut);
    const op = parsed.operator;
    if (op === 'amtrak') runs = runs.filter((r) => r.externalId.startsWith('amtk-'));
    else if (op === 'via') runs = runs.filter((r) => r.externalId.startsWith('via-'));
    else if (op) runs = runs.filter((r) => r.externalId.startsWith('fi-'));
    if (runs.length === 1) return trainReport(runs[0].externalId);
    if (!runs.length)
      return {
        query: raw,
        parsed,
        error: `No train ${parsed.value} running or on record today.`,
        status: 404,
      };
    return { query: raw, parsed, matches: runs };
  }
  const record = rowOut(await q.itemByExternalId('trains', parsed.value));
  if (!record)
    return { query: raw, parsed, error: `No train or station ${parsed.value}.`, status: 404 };
  const live = record.externalId.startsWith('trainline-') ? null : await liveTrain(record);
  return { query: raw, parsed, record, live };
}
