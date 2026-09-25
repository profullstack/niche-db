import { defineEnricher } from './enricher.js';

/**
 * What the place actually looks like, from street level.
 *
 * Listing photography is the most thoroughly locked-up part of listing data,
 * and for a harder reason than the data itself: a photograph carries its own
 * copyright, owned by whoever took it, quite separately from any licence on
 * the listing. So there is no free source of interior photos and there is not
 * going to be one.
 *
 * Mapillary is the way round it for the outside. Crowdsourced street-level
 * imagery in 190-odd countries, published under CC BY-SA 4.0, free to query
 * with a token anybody can get. It will not show you the kitchen. It will show
 * you the street, the block and what is opposite — which for somewhere a
 * person is deciding whether to live is often the more useful picture, and is
 * the part a listing's own photographs are least likely to show honestly.
 *
 * It applies to anything with coordinates, not only property: a restaurant, a
 * crime report, a building permit. Anywhere the collection knows where
 * something is, this can show it.
 *
 * ## Attribution is not optional here
 *
 * CC BY-SA requires attribution and it is stored on every result: the
 * photographer's username, the image id and the licence itself. A consumer
 * that shows the picture must show the credit. Storing the URL without the
 * credit would make this the same problem it exists to avoid.
 *
 * ## The bounding box
 *
 * Mapillary formalised a limit in January 2026: a bbox query must be smaller
 * than 0.01 degrees square. That is roughly a kilometre, and it is why this
 * builds a small box around one point rather than asking for a city. The box
 * here is deliberately smaller again — a street rather than a district,
 * because an image four hundred metres away is not a picture of this address.
 */

const GRAPH = 'https://graph.mapillary.com/images';

/**
 * Half-width of the search box, in degrees.
 *
 * 0.0012° is about 130 m of latitude. Mapillary's own ceiling is 0.01° square;
 * this stays well inside it, and more importantly it keeps the answer
 * relevant: the nearest image to a house should be on its street, not in the
 * next neighbourhood.
 */
const BOX = 0.0012;

/** Metres per degree of latitude, near enough for ranking a handful of points. */
const M_PER_DEG = 111_320;

/**
 * The coordinates of an item, following the same order the database's
 * `ndb_geo_shape` uses, so an item this enricher can place is exactly an item
 * the geographic queries can already find.
 */
export function pointOf(item) {
  const data = item?.data;
  if (!data || typeof data !== 'object') return null;

  for (const block of [data.location, data.place, data.position, data.geometry, data]) {
    if (!block || typeof block !== 'object') continue;

    // GeoJSON first: [lon, lat], which is the order people most often get wrong.
    if (block.type === 'Point' && Array.isArray(block.coordinates)) {
      const [lon, lat] = block.coordinates;
      if (valid(lat, lon)) return { lat: Number(lat), lon: Number(lon) };
      continue;
    }

    const lat = num(block.lat ?? block.latitude);
    const lon = num(block.long ?? block.lon ?? block.lng ?? block.longitude);
    if (valid(lat, lon)) return { lat, lon };
  }
  return null;
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function valid(lat, lon) {
  const a = num(lat);
  const o = num(lon);
  // (0, 0) is in the Atlantic and is overwhelmingly a missing coordinate
  // rather than a place anybody listed, so it is refused.
  if (a === null || o === null) return false;
  if (Math.abs(a) > 90 || Math.abs(o) > 180) return false;
  return !(a === 0 && o === 0);
}

/** The bbox Mapillary wants: minLon,minLat,maxLon,maxLat. */
export function bboxAround({ lat, lon }, half = BOX) {
  return [lon - half, lat - half, lon + half, lat + half].map((n) => n.toFixed(6)).join(',');
}

/** Rough metres between two nearby points. Good enough to rank a dozen. */
export function distanceM(a, b) {
  const dLat = (a.lat - b.lat) * M_PER_DEG;
  const dLon = (a.lon - b.lon) * M_PER_DEG * Math.cos((a.lat * Math.PI) / 180);
  return Math.round(Math.sqrt(dLat * dLat + dLon * dLon));
}

/** One Mapillary image to the block stored on the item. */
export function toImage(raw, origin) {
  const id = raw?.id == null ? null : String(raw.id);
  const url = raw?.thumb_1024_url ?? raw?.thumb_2048_url ?? raw?.thumb_256_url ?? null;
  if (!id || !url) return null;

  const coords = Array.isArray(raw?.geometry?.coordinates) ? raw.geometry.coordinates : null;
  const at = coords && valid(coords[1], coords[0]) ? { lat: coords[1], lon: coords[0] } : null;

  return {
    id,
    url,
    page: `https://www.mapillary.com/app/?pKey=${encodeURIComponent(id)}&focus=photo`,
    capturedAt: raw?.captured_at ? new Date(Number(raw.captured_at)).toISOString() : null,
    compassAngle: num(raw?.compass_angle),
    ...(at ? { lat: at.lat, lon: at.lon, metresAway: origin ? distanceM(origin, at) : null } : {}),
    // CC BY-SA is a share-alike licence: the credit travels with the picture.
    by: raw?.creator?.username ?? null,
    license: 'CC-BY-SA-4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
  };
}

/** Newest usable image first, nearest as the tiebreak. */
export function rank(images, origin) {
  return images
    .map((raw) => toImage(raw, origin))
    .filter(Boolean)
    .sort((a, b) => {
      const near = (a.metresAway ?? 9e9) - (b.metresAway ?? 9e9);
      if (near !== 0) return near;
      return String(b.capturedAt ?? '').localeCompare(String(a.capturedAt ?? ''));
    });
}

/**
 * Is this body Mapillary saying the token is wrong?
 *
 * Code 190 is the Graph API's "invalid access token", and it arrives with a
 * 500 rather than a 401.
 */
export function isAuthError(body) {
  const err = body?.error;
  if (!err) return false;
  if (Number(err.code) === 190) return true;
  return /access token|oauth/i.test(String(err.message ?? ''));
}

export function appliesTo(item) {
  return pointOf(item) !== null;
}

export const mapillary = defineEnricher({
  name: 'mapillary',
  title: 'Street-level imagery',
  description:
    'What the place looks like from the street, from Mapillary: the nearest crowdsourced photographs to an item’s coordinates, with when each was taken, how far away it is and who took it. CC BY-SA 4.0, so the credit is stored with the picture and must be shown with it. Listing photography is separately copyrighted and has no free source; this is the outside of the building, which is the part a listing’s own photographs are least likely to show honestly. Needs MAPILLARY_TOKEN.',
  collections: ['listings', 'housing'],
  needsEnv: ['mapillaryToken'],
  appliesTo,
  // Mapillary's limits are generous but this is one request per item, and a
  // collection of several hundred thousand would be rude at any rate.
  perRun: 30,

  async enrich(item, { env, http }) {
    const token = env.mapillaryToken;
    if (!token) throw new Error('mapillary needs MAPILLARY_TOKEN');

    const origin = pointOf(item);
    if (!origin) return null;

    const qs = new URLSearchParams({
      access_token: token,
      fields: 'id,thumb_1024_url,captured_at,compass_angle,geometry,creator',
      bbox: bboxAround(origin),
      limit: '8',
    });

    const res = await http.request(`${GRAPH}?${qs}`, { timeoutMs: 20_000 });
    if (res.status === 429) throw new Error('mapillary rate limited (429)');

    /*
     * A bad token comes back as HTTP 500, not 401 -- measured against the live
     * endpoint on 2026-09-25, which answered
     *   500 {"error":{"message":"Invalid OAuth 2.0 Access Token","code":190}}
     * Reading only the status would report that as "mapillary answered 500",
     * which looks like their outage rather than our credential, and would have
     * somebody checking Mapillary's status page instead of the token. So the
     * body is read first and the error is named from it.
     */
    const body = await res.json().catch(() => null);
    if (isAuthError(body)) {
      throw new Error(`mapillary rejected the token: ${body.error.message}`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(`mapillary rejected the token (${res.status})`);
    }
    if (!res.ok) {
      const detail = body?.error?.message ? `: ${body.error.message}` : '';
      throw new Error(`mapillary answered ${res.status}${detail}`);
    }

    const images = rank(Array.isArray(body?.data) ? body.data : [], origin);

    // Nothing nearby is a real answer, and storing it stops the item being
    // asked about again on every pass.
    if (!images.length) return { images: [], searchedAt: new Date().toISOString() };

    return {
      images: images.slice(0, 4),
      nearestMetres: images[0].metresAway ?? null,
      searchedAt: new Date().toISOString(),
      source: 'Mapillary',
      license: 'CC-BY-SA-4.0',
      note: 'Street-level imagery, not the property’s own photographs. Attribution must be shown with the image.',
    };
  },
});
