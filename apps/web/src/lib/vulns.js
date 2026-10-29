import { OPENVULN_HOUSE as HOUSE } from '@nichedb/adapters';
import { config } from '@nichedb/config';
import { buildRecord, isCve, keyOf, normaliseId, secondHopKeys } from '@nichedb/core/openvuln';
import * as reputation from '@nichedb/db/reputation';
import * as vulns from '@nichedb/db/vulns';

/**
 * /c/vulns/<id>: one OpenVuln record per vulnerability, assembled at read time
 * from the rows each source keeps (see @nichedb/core/openvuln for the merge).
 *
 * Two hops: the rows tagged with the id asked for, then the rows tagged with
 * any id, OSS-Fuzz issue or related key those rows carry, so a GHSA page finds
 * its CVE's KEV entry and an OSS-Fuzz record finds the ExploitGym task named
 * after its issue. The NVD row is read by CVE from the threats collection.
 *
 * Two live reads, both cached: FIRST EPSS (changes daily, never stored as rows:
 * 300,000 CVEs a day would be a write storm for one number each) and OSV's API
 * for an id the collection has not ingested yet, so a page works while the
 * backlog is still being walked.
 */

const EPSS_TTL_MS = 6 * 60 * 60_000;
const LIVE_TTL_MS = 30 * 60_000;
const epssCache = new Map();
const liveCache = new Map();

function remember(cache, key, value, ttl) {
  if (cache.size > 5000) cache.delete(cache.keys().next().value);
  cache.set(key, { value, until: Date.now() + ttl });
  return value;
}
const recall = (cache, key) => {
  const hit = cache.get(key);
  return hit && hit.until > Date.now() ? hit : null;
};

const ua = () => `niche-db/0.1 (+${config.siteUrl})`;

export async function epssFor(cve, { fetch: f = fetch } = {}) {
  if (!isCve(cve)) return null;
  const hit = recall(epssCache, cve);
  if (hit) return hit.value;
  try {
    const res = await f(`https://api.first.org/data/v1/epss?cve=${cve}`, {
      headers: { 'user-agent': ua() },
      signal: AbortSignal.timeout(8000),
    });
    const body = await res.json();
    const row = body?.data?.[0];
    const value = row
      ? { cve, score: Number(row.epss), percentile: Number(row.percentile), date: row.date }
      : null;
    return remember(epssCache, cve, value, EPSS_TTL_MS);
  } catch {
    return null;
  }
}

export async function osvLive(id, { fetch: f = fetch } = {}) {
  const hit = recall(liveCache, id);
  if (hit) return hit.value;
  try {
    const res = await f(`https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`, {
      headers: { 'user-agent': ua() },
      signal: AbortSignal.timeout(8000),
    });
    const value = res.ok ? await res.json() : null;
    return remember(liveCache, id, value?.id ? value : null, LIVE_TTL_MS);
  } catch {
    return null;
  }
}

export const liveDeps = {
  itemsForKeys: (keys) => vulns.itemsForKeys(keys),
  nvdFor: async (cves) =>
    cves.length
      ? reputation.itemsByAdapterIds(
          cves.slice(0, 5).map((c) => ({ adapter: 'nvd', externalId: c })),
        )
      : [],
  epss: (cve) => epssFor(cve),
  live: (id) => osvLive(id),
};

/** The OpenVuln record for an id, or `{ error, status }`. */
export async function vulnReport(raw, deps = liveDeps) {
  const id = normaliseId(raw);
  if (!id)
    return {
      error: 'Give a vulnerability id: CVE-2026-12537, GHSA-..., MAL-..., NDB-...',
      status: 400,
    };
  const first = await deps.itemsForKeys([keyOf(id), `related:${id.toLowerCase()}`]);
  let live = null;
  const hop = secondHopKeys(first);
  if (
    !first.some((r) => r.kind === 'vuln' || r.kind === 'malicious-package' || r.kind === 'openvuln')
  ) {
    live = await deps.live(id);
    if (live)
      for (const x of [live.id, ...(live.aliases ?? [])])
        hop.push(keyOf(x), `related:${String(x).toLowerCase()}`);
  }
  const seen = new Set(first.map((r) => r.id));
  const second = hop.length ? (await deps.itemsForKeys(hop)).filter((r) => !seen.has(r.id)) : [];
  const rows = [...first, ...second];

  const cveIds = new Set(
    [
      id,
      live?.id,
      ...(live?.aliases ?? []),
      ...rows
        .flatMap((r) => r.tags ?? [])
        .filter((t) => t.startsWith('id:cve-'))
        .map((t) => t.slice(3)),
    ]
      .filter(isCve)
      .map((c) => c.toUpperCase()),
  );
  const nvdRows = await deps.nvdFor([...cveIds]);
  const nvd = nvdRows.find((r) => r.external_id === id) ?? nvdRows[0] ?? null;
  const cve = isCve(id) ? id : [...cveIds][0];
  const epss = cve ? await deps.epss(cve) : null;

  const built = buildRecord(id, { rows, nvd, epss, live, siteUrl: config.siteUrl });
  if (!built) return { error: `${id} is not in nichedb.dev or OSV.dev.`, status: 404, id };
  return { id, ...built };
}

/** /.well-known/openvuln.json: our own records, and the template for any id we can answer. */
export function wellKnown() {
  const site = config.siteUrl;
  return {
    openvuln: '0.1',
    publisher: { ...HOUSE.publisher, web: site },
    updated: HOUSE.updated,
    records: HOUSE.records.map((r) => ({
      id: r.id,
      modified: r.modified,
      url: `${site}/c/vulns/${r.id}.json`,
    })),
    record_url: `${site}/c/vulns/{id}.json`,
    changes: `${site}/f/openvuln-records.json`,
  };
}
