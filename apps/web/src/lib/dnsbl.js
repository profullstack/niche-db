import { Resolver } from 'node:dns/promises';
import { isIPv4, isIPv6 } from 'node:net';
import { config } from '@nichedb/config';

/**
 * Live DNS blocklist (DNSBL) lookups: the lists mail servers ask about an
 * address (Spamhaus ZEN, SpamCop, PSBL, Mailspike) and about a domain in a
 * link (Spamhaus DBL, URIBL, SURBL). Shared by /business and /reputation.
 *
 * Every answer is asked of the zone's own nameservers, never of the system
 * resolver: public resolvers (8.8.8.8, 1.1.1.1) are refused by the lists, and
 * a refusal reads as "not listed" to anyone who forgets to look (Spamhaus
 * answers nothing at all through 8.8.8.8, even for its own test entry; URIBL
 * answers 127.0.0.1 for everything). So each zone is proven with its
 * always-listed test entry before an answer from it is believed, and a zone
 * that fails its test is `unknown`, never `clear`.
 *
 * Answers are held an hour (the lists' own TTLs are minutes to an hour, and
 * the free services ask for restraint); a proven test entry an hour, a failed
 * one five minutes.
 */

const TIMEOUT_MS = 2000;
const HOUR = 60 * 60_000;
const RETRY = 5 * 60_000;

/**
 * The zones, how each says "listed", and the entry each always lists so a
 * zone that answers nothing can be told from a zone that refused. `subject`
 * says what it lists; `ns` names the zone's servers where the parent zone's
 * NS lookup would not find them (delegations a non-recursive answer never
 * names).
 */
export const ZONES = {
  dbl: {
    zone: 'dbl.spamhaus.org',
    dqs: 'dbl.dq.spamhaus.net',
    canary: 'dbltest.com',
    name: 'Spamhaus DBL',
    subject: 'domain',
    spamhaus: true,
  },
  zen: {
    zone: 'zen.spamhaus.org',
    dqs: 'zen.dq.spamhaus.net',
    canary: '127.0.0.2',
    name: 'Spamhaus ZEN',
    subject: 'ip',
    ipv6: true,
    spamhaus: true,
  },
  uribl: { zone: 'multi.uribl.com', canary: 'test.uribl.com', name: 'URIBL', subject: 'domain' },
  // multi.surbl.org is delegated to its own servers, which a resolver that
  // will not recurse never names; ask them directly.
  surbl: {
    zone: 'multi.surbl.org',
    canary: 'test.surbl.org',
    name: 'SURBL',
    subject: 'domain',
    ns: ['b.surbl.org', 'c.surbl.org', 'd.surbl.org'],
  },
  spamcop: {
    zone: 'bl.spamcop.net',
    canary: '127.0.0.2',
    name: 'SpamCop',
    subject: 'ip',
    ns: ['blns100.spamcop.net'],
  },
  psbl: {
    zone: 'psbl.surriel.com',
    canary: '127.0.0.2',
    name: 'PSBL',
    subject: 'ip',
    ns: ['rbldnsd.surriel.com', 'ns-kam.surriel.com'],
  },
  mailspike: {
    zone: 'bl.mailspike.net',
    canary: '127.0.0.2',
    name: 'Mailspike',
    subject: 'ip',
    ns: ['a.ns.mailspike.net', 'b.ns.mailspike.net', 'c.ns.mailspike.net'],
  },
};

const DBL_CODES = {
  2: 'spam domain',
  4: 'phishing domain',
  5: 'malware domain',
  6: 'botnet C&C domain',
  102: 'abused legitimate spam',
  103: 'abused spammed redirector',
  104: 'abused legitimate phish',
  105: 'abused legitimate malware',
  106: 'abused legitimate botnet C&C',
};
const ZEN_CODES = {
  2: 'SBL (Spamhaus block list)',
  3: 'SBL CSS (snowshoe spam)',
  4: 'XBL (exploited host)',
  5: 'XBL (exploited host)',
  6: 'XBL (exploited host)',
  7: 'XBL (exploited host)',
  9: 'SBL DROP (hijacked or criminal network)',
  10: 'PBL (end-user address, policy only)',
  11: 'PBL (end-user address, policy only)',
};
// Mailspike's combined zone: 2 is its blocklist, 10-20 its reputation scale
// (L5 worst … H5 best). Only the bad end counts against an address.
const MAILSPIKE_CODES = {
  2: ['Mailspike BL (recent spam source)', false],
  10: ['worst reputation (L5)', false],
  11: ['very bad reputation (L4)', false],
  12: ['bad reputation (L3)', false],
  13: ['suspicious reputation (L2)', true],
  14: ['neutral reputation (L1)', true],
};
const URIBL_BITS = [
  [2, 'black'],
  [4, 'grey'],
  [8, 'red'],
];
const SURBL_BITS = [
  [4, 'disposable mail'],
  [8, 'phishing'],
  [16, 'malware'],
  [32, 'click tracker'],
  [64, 'abuse'],
  [128, 'cracked'],
];

/**
 * What one zone's answer means: `refused` when the zone declined to answer
 * this resolver, otherwise the reasons it is listed (empty when none). PBL is
 * a statement about the kind of address, not about behaviour, so it is kept
 * but marked `policy` and does not count against anyone.
 */
export function decodeZone(kind, addresses) {
  const reasons = [];
  let refused = false;
  for (const a of Array.isArray(addresses) ? addresses : []) {
    const m = String(a).match(/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m) continue;
    const [, b, c, d] = m.map(Number);
    if (kind === 'dbl' || kind === 'zen') {
      if (b === 255 && c === 255) {
        refused = true;
        continue;
      }
      const code = kind === 'dbl' ? (c === 1 ? d : null) : c === 0 ? d : null;
      const label = (kind === 'dbl' ? DBL_CODES : ZEN_CODES)[code];
      if (label)
        reasons.push({ code: a, label, policy: kind === 'zen' && (code === 10 || code === 11) });
    } else if (kind === 'uribl' || kind === 'surbl') {
      // 127.0.0.1 is the refusal on both. SURBL's test entry is on every list,
      // so its 127.0.0.254 is all bits set, a real answer.
      if (d === 1) {
        refused = true;
        continue;
      }
      for (const [bit, label] of kind === 'uribl' ? URIBL_BITS : SURBL_BITS)
        if (d & bit) reasons.push({ code: a, label, policy: false });
    } else if (kind === 'mailspike') {
      const hit = MAILSPIKE_CODES[d];
      if (hit) reasons.push({ code: a, label: hit[0], policy: hit[1] });
    } else if (d === 2) {
      reasons.push({ code: a, label: 'listed', policy: false });
    }
  }
  return { refused, reasons };
}

/** The label to ask under a zone: an IPv4 address octet-reversed, IPv6 nibble-reversed, a domain as is. */
export function reverseName(subject) {
  if (isIPv4(subject)) return subject.split('.').reverse().join('.');
  if (isIPv6(subject)) {
    const [head, tail = ''] = subject.split('::');
    const h = head ? head.split(':') : [];
    const t = tail ? tail.split(':') : [];
    const groups = subject.includes('::')
      ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t]
      : h;
    return groups
      .map((g) => g.padStart(4, '0'))
      .join('')
      .split('')
      .reverse()
      .join('.');
  }
  return subject;
}

const NOT_LISTED = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN']);

const zoneResolvers = new Map();

/** A resolver pointed at the zone's own nameservers, so the answer is the list's, not 8.8.8.8's. */
export async function authoritativeResolver(zone) {
  if (zoneResolvers.has(zone)) return zoneResolvers.get(zone);
  const p = (async () => {
    const sys = new Resolver({ timeout: TIMEOUT_MS, tries: 2 });
    const labels = zone.split('.');
    let ns = Object.values(ZONES).find((z) => z.zone === zone)?.ns ?? [];
    for (let i = 0; i < labels.length - 1 && !ns.length; i++)
      ns = await sys.resolveNs(labels.slice(i).join('.')).catch(() => []);
    const ips = (
      await Promise.all(ns.slice(0, 3).map((h) => sys.resolve4(h).catch(() => [])))
    ).flat();
    if (!ips.length) throw new Error(`no nameserver address for ${zone}`);
    const r = new Resolver({ timeout: TIMEOUT_MS, tries: 2 });
    r.setServers(ips);
    return r;
  })();
  zoneResolvers.set(zone, p);
  p.catch(() => zoneResolvers.delete(zone));
  return p;
}

/** The question for one zone: the DQS zone under the key when there is one, else the public zone. */
function zoneQuery(kind, subject, dqsKey) {
  const z = ZONES[kind];
  const name = reverseName(subject);
  return dqsKey && z.dqs ? `${name}.${dqsKey}.${z.dqs}` : `${name}.${z.zone}`;
}

/** A small expiring map: `get(key)` or undefined, `set(key, value, ttlMs)`. */
export function ttlCache({ now = () => Date.now(), max = 5000 } = {}) {
  const m = new Map();
  return {
    get(key) {
      const hit = m.get(key);
      if (!hit) return undefined;
      if (hit.until > now()) return hit.value;
      m.delete(key);
      return undefined;
    },
    set(key, value, ttl) {
      if (m.size >= max) m.delete(m.keys().next().value);
      m.set(key, { value, until: now() + ttl });
    },
  };
}

/**
 * One subject against one zone, with the canary proving the zone answers us.
 * With a `cache`, the canary and the answer are each held (see the top).
 */
export async function zoneLookup(kind, subject, { resolve, dqsKey, cache } = {}) {
  const z = ZONES[kind];
  const ask = async (s) => {
    try {
      return { addrs: await resolve(zoneQuery(kind, s, dqsKey)) };
    } catch (err) {
      return NOT_LISTED.has(err?.code)
        ? { addrs: [] }
        : { error: err?.code ?? String(err?.message ?? err) };
    }
  };
  const held = cache?.get(`${kind}:${subject}`);
  if (held) return held;
  const proveCanary = async () => {
    const c = await ask(z.canary);
    const tested = c.error ? null : decodeZone(kind, c.addrs);
    return Boolean(tested && !tested.refused && tested.reasons.length > 0);
  };
  const cachedCanary = cache?.get(`canary:${kind}`);
  const [proven, answer] = await Promise.all([cachedCanary ?? proveCanary(), ask(subject)]);
  if (cachedCanary === undefined) cache?.set(`canary:${kind}`, proven, proven ? HOUR : RETRY);
  let result;
  if (!proven)
    result = {
      list: z.name,
      subject,
      status: 'unknown',
      note: 'The list did not answer its own test entry, so silence from it means nothing.',
    };
  else if (answer.error) result = { list: z.name, subject, status: 'unknown', error: answer.error };
  else {
    const { refused, reasons } = decodeZone(kind, answer.addrs);
    if (refused)
      result = {
        list: z.name,
        subject,
        status: 'unknown',
        note: 'Refused by the list (over its free allowance, or this server must register).',
      };
    else {
      const counted = reasons.filter((r) => !r.policy);
      result = { list: z.name, subject, status: counted.length ? 'listed' : 'clear', reasons };
    }
  }
  cache?.set(`${kind}:${subject}`, result, result.status === 'unknown' ? RETRY : HOUR);
  return result;
}

/** The zone a lookup is asked under: the licensed DQS zone with a key, else the public one. */
export const zoneFor = (kind, dqsKey) =>
  dqsKey && ZONES[kind].dqs ? ZONES[kind].dqs : ZONES[kind].zone;

/** The default resolver factory: one zone's authoritative servers, A records. */
export const authoritativeResolveFor = (dqsKey) => async (kind) => {
  const r = await authoritativeResolver(zoneFor(kind, dqsKey));
  return (n) => r.resolve4(n);
};

/** Several zones at once; a zone that throws comes back `unknown`, never missing. */
export async function zonesLookup(kinds, subject, { resolveFor, dqsKey, cache } = {}) {
  return Promise.all(
    kinds.map(async (k) => {
      try {
        return await zoneLookup(k, subject, { resolve: await resolveFor(k), dqsKey, cache });
      } catch (err) {
        return {
          list: ZONES[k].name,
          subject,
          status: 'unknown',
          error: String(err?.message ?? err),
        };
      }
    }),
  );
}

/* ------------------------------------------------------------ /reputation -- */

/**
 * The zones /reputation asks for one kind of subject, as the operator allows:
 * REPUTATION_DNSBL turns live lookups off altogether, and
 * REPUTATION_SPAMHAUS_DNSBL drops Spamhaus alone (its free service excludes
 * commercial use; with SPAMHAUS_DQS_KEY the licensed zones are asked instead).
 * An IPv6 address only goes to the zones that list IPv6.
 */
export function reputationZones(type, { ipv6 = false, opts = config.reputation } = {}) {
  if (!opts?.dnsbl) return [];
  return Object.entries(ZONES)
    .filter(([, z]) => z.subject === type)
    .filter(([, z]) => opts.spamhausDnsbl || !z.spamhaus)
    .filter(([, z]) => !ipv6 || z.ipv6)
    .map(([k]) => k);
}

const reputationCache = ttlCache();

/** A domain's public addresses (A and AAAA), a few of each; none when it does not resolve. */
export async function resolveAddresses(domain) {
  const r = new Resolver({ timeout: TIMEOUT_MS, tries: 2 });
  const [v4, v6] = await Promise.all([
    r.resolve4(domain).catch(() => []),
    r.resolve6(domain).catch(() => []),
  ]);
  return [...v4.slice(0, 4), ...v6.slice(0, 2)];
}

/**
 * The live dependencies /reputation is given in production: `resolve` (a
 * domain's addresses) and `dnsbl` (`check(type, subject)` and `lists(type)`,
 * the zone names it will ask). Tests inject their own.
 */
export const liveReputationDeps = {
  resolve: resolveAddresses,
  dnsbl: {
    lists: (type) => reputationZones(type).map((k) => ZONES[k].name),
    check: (type, subject) => {
      const dqsKey = config.business?.spamhausDqsKey ?? null;
      return zonesLookup(reputationZones(type, { ipv6: isIPv6(subject) }), subject, {
        resolveFor: authoritativeResolveFor(dqsKey),
        dqsKey,
        cache: reputationCache,
      });
    },
  },
};
