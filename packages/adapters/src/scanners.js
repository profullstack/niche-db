import { defineAdapter } from '@nichedb/core/adapter';

function publicUrl(value) {
  try {
    const u = new URL(value);
    return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
}
const point = (p) =>
  Array.isArray(p) &&
  p.length >= 2 &&
  typeof p[0] === 'number' &&
  typeof p[1] === 'number' &&
  Number.isFinite(p[0]) &&
  Number.isFinite(p[1]) &&
  Math.abs(p[0]) <= 180 &&
  Math.abs(p[1]) <= 90;
export function validCoverage(g) {
  if (!g || typeof g !== 'object') return false;
  if (g.type === 'Circle')
    return (
      point(g.coordinates) && Number.isFinite(g.radius_m) && g.radius_m > 0 && g.radius_m <= 1000000
    );
  const polys =
    g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : null;
  let vertices = 0;
  return (
    Array.isArray(polys) &&
    polys.length > 0 &&
    polys.length <= 100 &&
    polys.every(
      (poly) =>
        Array.isArray(poly) &&
        poly.length > 0 &&
        poly.every((ring) => {
          if (!Array.isArray(ring) || ring.length < 4 || !ring.every(point)) return false;
          vertices += ring.length;
          return vertices <= 2000 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1];
        }),
    )
  );
}
export function toItem(row) {
  const playerUrl = publicUrl(row?.player_url);
  if (!row?.id || !row.name || !playerUrl || !row.provider || !row.access_terms) return null;
  // No ownership/permission inference from a publicly reachable audio URL.
  const streamUrl = row.stream_reuse_allowed === true ? publicUrl(row.stream_url) : null;
  const coverage = validCoverage(row.coverage) ? row.coverage : null;
  return {
    externalId: String(row.id),
    kind: 'scanner-stream',
    title: String(row.name),
    url: playerUrl,
    summary: row.description ?? 'Scanner traffic. Radio reports are not confirmed crimes.',
    publishedAt: row.updated_at ?? null,
    timeKnown: Boolean(row.updated_at),
    tags: ['scanner', row.service_type ?? 'public-safety', row.country, row.state, row.city].filter(
      Boolean,
    ),
    data: {
      provider: row.provider,
      source_id: String(row.id),
      agency: row.agency ?? null,
      jurisdiction: row.jurisdiction ?? null,
      service_type: row.service_type ?? 'public-safety',
      player_url: playerUrl,
      stream_url: streamUrl,
      access_terms: row.access_terms,
      stream_reuse_allowed: Boolean(streamUrl),
      // Null coverage means unknown, never a receiver's location masquerading as coverage.
      coverage,
      coverage_basis: coverage
        ? (row.coverage_basis ??
          (coverage.type === 'Circle' ? 'approximate-radius' : 'provider-boundary'))
        : 'unknown',
      location_precision: row.location_precision ?? null,
      location_source: row.location_source ?? row.provider,
      location_updated_at: row.updated_at ?? null,
      country: row.country ?? null,
      state: row.state ?? null,
      city: row.city ?? null,
      last_checked: row.last_checked ?? null,
    },
  };
}
export const scannerDirectory = defineAdapter({
  name: 'scanner-directory',
  title: 'Permissioned scanner directory',
  collection: 'crime',
  description:
    'An operator-supplied JSON catalog of scanner player links, permitted streams and coverage areas. Configure a catalog you may index; no third-party directory is enabled automatically.',
  kinds: ['scanner-stream'],
  cadenceMinutes: 60,
  configFields: [
    { key: 'url', label: 'Permissioned JSON catalog URL', type: 'text', required: true },
  ],
  async pull({ config, http }) {
    const url = publicUrl(config.url);
    if (!url) throw new Error('A valid HTTP(S) catalog URL is required');
    const body = await http.json(url);
    const rows = Array.isArray(body) ? body : body?.feeds;
    if (!Array.isArray(rows) || rows.length > 10000)
      throw new Error('Catalog must contain at most 10000 feeds');
    const items = rows.map(toItem).filter(Boolean);
    return {
      items,
      note: `${items.length} scanner entries; ${rows.length - items.length} invalid entries skipped`,
    };
  },
});
