/** Shared public contract. Does not depend on a web framework or a database. */
export class GeoQueryError extends Error {
  status = 400;
  toolError = true;
}
const fail = (message) => {
  throw new GeoQueryError(message);
};
const present = (v) => v !== undefined && v !== null;
function number(v, name, min, max) {
  if (!['number', 'string'].includes(typeof v) || String(v).trim() === '')
    fail(`${name} must be a number`);
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) fail(`${name} must be between ${min} and ${max}`);
  return n;
}
export const GEO_KEYS = ['lat', 'long', 'radius', 'unit', 'bbox'];
export function parseGeoQuery(raw = {}) {
  const center = present(raw.lat) || present(raw.long);
  const box = present(raw.bbox);
  if (!center && !box) {
    if (present(raw.radius) || present(raw.unit) || raw.sort === 'distance')
      fail('lat and long are required for radius, unit or sort=distance');
    return null;
  }
  if (box) {
    if (center || present(raw.radius) || present(raw.unit) || raw.sort === 'distance')
      fail('bbox cannot be combined with lat, long, radius, unit or sort=distance');
    const b = Array.isArray(raw.bbox) ? raw.bbox : String(raw.bbox).split(',');
    if (b.length !== 4) fail('bbox must be west,south,east,north');
    const bbox = b.map((v, i) =>
      number(v, 'bbox coordinate', i % 2 ? -90 : -180, i % 2 ? 90 : 180),
    );
    if (bbox[1] > bbox[3]) fail('bbox south must not exceed north');
    return { bbox };
  }
  if (!present(raw.lat) || !present(raw.long)) fail('lat and long must be supplied together');
  const lat = number(raw.lat, 'lat', -90, 90);
  const long = number(raw.long, 'long', -180, 180);
  const unit = raw.unit ?? 'km';
  if (!['km', 'mi'].includes(unit)) fail('unit must be km or mi');
  const radius = number(raw.radius ?? 10, 'radius', 0.001, unit === 'km' ? 1000 : 1000 / 1.609344);
  return { lat, long, radius, unit };
}
export function geoQueryFields(raw = {}) {
  const geo = parseGeoQuery(raw);
  return { ...geo, ...(raw.sort === 'distance' ? { sort: 'distance' } : {}) };
}
export const geoSchema = {
  lat: {
    type: 'number',
    minimum: -90,
    maximum: 90,
    description: 'Query center latitude; requires long',
  },
  long: {
    type: 'number',
    minimum: -180,
    maximum: 180,
    description: 'Query center longitude; requires lat',
  },
  radius: { type: 'number', exclusiveMinimum: 0, description: 'Default 10; maximum 1000 km' },
  unit: { type: 'string', enum: ['km', 'mi'], description: 'Default km' },
  bbox: {
    type: 'string',
    description: 'west,south,east,north; west > east crosses the antimeridian',
  },
  sort: { type: 'string', enum: ['id', 'published', 'updated', 'distance'] },
};
