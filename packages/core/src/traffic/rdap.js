import { isIP } from 'node:net';

/**
 * Who holds any address, from RDAP (the JSON successor to whois): rdap.org
 * redirects to the registry that allocated it (ARIN, RIPE, APNIC, LACNIC,
 * AFRINIC). Answers are cached in memory for a day; a lookup that fails or
 * times out answers null and is not cached.
 */
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX = 5000;
const cache = new Map();

const vcard = (entity, field) =>
  (entity?.vcardArray?.[1] ?? []).find((x) => x[0] === field)?.[3] ?? null;

/** Every entity, nested ones included, with its roles. */
function entities(list, out = []) {
  for (const e of list ?? []) {
    out.push(e);
    entities(e.entities, out);
  }
  return out;
}

/** The fields we publish, from one RDAP ip network object. */
export function parseRdap(doc) {
  if (!doc || doc.objectClassName !== 'ip network') return null;
  const all = entities(doc.entities);
  const withRole = (role) => all.find((e) => e.roles?.includes(role));
  // RIPE lists maintainers as registrants too: the organisation is the one of kind "org".
  const registrants = all.filter((e) => e.roles?.includes('registrant'));
  const registrant = registrants.find((e) => vcard(e, 'kind') === 'org') ?? registrants[0];
  const abuse = withRole('abuse');
  const cidrs = (doc.cidr0_cidrs ?? [])
    .map((c) => `${c.v4prefix ?? c.v6prefix}/${c.length}`)
    .filter((c) => !c.startsWith('undefined'));
  const remark = (doc.remarks ?? []).flatMap((r) => r.description ?? [])[0] ?? null;
  return {
    owner: vcard(registrant, 'fn') ?? remark ?? doc.name ?? null,
    network: doc.name ?? null,
    handle: doc.handle ?? null,
    range: cidrs[0] ?? (doc.startAddress ? `${doc.startAddress} - ${doc.endAddress}` : null),
    country: doc.country ?? null,
    abuse_email: vcard(abuse, 'email'),
    registry: doc.port43 ?? null,
    source: (doc.links ?? []).find((l) => l.rel === 'self')?.href ?? null,
  };
}

/** RDAP for one address, or null. `fetchImpl` is for tests. */
export async function rdapLookup(ip, { fetchImpl = fetch, timeoutMs = 4000 } = {}) {
  if (!isIP(String(ip))) return null;
  const hit = cache.get(ip);
  if (hit && hit.at > Date.now() - TTL_MS) return hit.value;
  try {
    const res = await fetchImpl(`https://rdap.org/ip/${ip}`, {
      headers: { accept: 'application/rdap+json, application/json' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const value = parseRdap(await res.json());
    if (cache.size >= MAX) cache.delete(cache.keys().next().value);
    cache.set(ip, { at: Date.now(), value });
    return value;
  } catch {
    return null;
  }
}
