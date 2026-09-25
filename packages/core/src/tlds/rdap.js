import { domainToASCII } from 'node:url';

/**
 * Is a name registered? Asked of the registry, over RDAP (RFC 9082).
 *
 * The answer has three values and never two (OpenTLD, "Availability"):
 * `registered` on a 200, `not_registered` on a 404, and `unknown` for
 * anything else: a timeout, a 429, a label with no RDAP server. A 404 is
 * not "available": the name may be reserved, blocked or premium, which only
 * a registrar's cart can say. A failed lookup is never turned into either.
 *
 * Answers are cached for ten minutes per name, so a page reload or a second
 * reader asking the same thing costs the registry nothing.
 */

const CACHE_MS = 10 * 60_000;
const CACHE_MAX = 5000;
const cache = new Map();

/** `Foo.Watches`, `https://foo.watches/x`, `bücher.de` → `foo.watches`, `xn--bcher-kva.de`. */
export function normaliseName(input) {
  let s = String(input ?? '')
    .trim()
    .toLowerCase();
  s = s
    .replace(/^[a-z]+:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/\.$/, '');
  s = s.replace(/^www\./, '');
  if (!s || s.length > 253) return null;
  const ascii = domainToASCII(s);
  if (!ascii || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(ascii)) return null;
  return ascii;
}

/** The label a name ends in: `foo.co.uk` → `uk`. RDAP is answered per top-level domain. */
export const tldOf = (name) => name.slice(name.lastIndexOf('.') + 1);

const vcardName = (entity) => {
  const card = entity?.vcardArray?.[1] ?? [];
  const fn = card.find((f) => f[0] === 'fn');
  return fn?.[3] || null;
};

/** The facts a reader wants out of a registered name's RDAP answer. */
export function summariseRdap(json) {
  const events = Object.fromEntries((json?.events ?? []).map((e) => [e.eventAction, e.eventDate]));
  const registrar = (json?.entities ?? []).find((e) => (e.roles ?? []).includes('registrar'));
  return {
    registrar: vcardName(registrar),
    registrar_iana_id: registrar?.publicIds?.find((p) => /iana/i.test(p.type))?.identifier ?? null,
    registered: events.registration ?? null,
    expires: events.expiration ?? null,
    updated: events['last changed'] ?? null,
    epp_status: json?.status ?? [],
    nameservers: (json?.nameservers ?? []).map((n) => String(n.ldhName ?? '').toLowerCase()),
  };
}

/**
 * One name. `rdapFor(tld)` returns the RDAP base URL for a label, or null;
 * the caller owns where that comes from (the tlds table, a test's map).
 */
export async function checkName(
  input,
  { rdapFor, fetchImpl = fetch, timeoutMs = 8000, now = Date.now, userAgent } = {},
) {
  const name = normaliseName(input);
  if (!name) return { name: String(input ?? ''), status: 'invalid', reason: 'not a domain name' };
  const hit = cache.get(name);
  if (hit && now() - hit.at < CACHE_MS) return { ...hit.result, cached: true };

  const tld = tldOf(name);
  const base = await rdapFor(tld);
  let result;
  if (!base) {
    result = { name, tld, status: 'unknown', reason: `.${tld} publishes no RDAP server` };
  } else {
    const url = `${base}domain/${name}`;
    try {
      const res = await fetchImpl(url, {
        headers: {
          accept: 'application/rdap+json, application/json',
          ...(userAgent ? { 'user-agent': userAgent } : {}),
        },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
      });
      if (res.status === 200) {
        const json = await res.json().catch(() => ({}));
        result = { name, tld, status: 'registered', rdap: url, ...summariseRdap(json) };
      } else if (res.status === 404) {
        await res.body?.cancel?.().catch(() => {});
        result = {
          name,
          tld,
          status: 'not_registered',
          rdap: url,
          note: 'The registry holds no registration. It may still be reserved or premium; a registrar says whether it is for sale.',
        };
      } else {
        await res.body?.cancel?.().catch(() => {});
        result = { name, tld, status: 'unknown', rdap: url, reason: `RDAP answered ${res.status}` };
      }
    } catch (err) {
      result = {
        name,
        tld,
        status: 'unknown',
        rdap: url,
        reason: err?.name === 'TimeoutError' ? 'RDAP timed out' : `RDAP failed: ${err.message}`,
      };
    }
  }
  result.checked_at = new Date(now()).toISOString();
  // An unknown is not cached: the next ask may get through.
  if (result.status !== 'unknown') {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(name, { at: now(), result });
  }
  return result;
}

/**
 * Several names, a few at a time. `label` with `tlds` checks `label.<tld>`
 * for each; a list of full names checks those.
 */
export async function checkNames(names, opts = {}) {
  const { concurrency = 6 } = opts;
  const out = new Array(names.length);
  let i = 0;
  const worker = async () => {
    while (i < names.length) {
      const k = i++;
      out[k] = await checkName(names[k], opts);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, names.length) }, worker));
  return out;
}

export const clearRdapCache = () => cache.clear();
