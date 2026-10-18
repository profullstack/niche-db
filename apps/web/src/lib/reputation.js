import { isIP } from 'node:net';
import { normaliseIp } from '@nichedb/core/traffic';
import { normaliseDomain } from './business.js';

/**
 * One answer for "is this IP or domain bad?", built from what nichedb already
 * keeps: /traffic (addresses our own servers banned, each approved by a
 * person), abuse.ch (malware infrastructure the community reports) and the
 * SURBL watch rows, plus live DNS blocklist lookups (./dnsbl.js: Spamhaus,
 * SpamCop, PSBL, Mailspike for addresses; Spamhaus DBL, URIBL, SURBL for a
 * domain and its parents) when the caller supplies `deps.dnsbl`.
 *
 * A domain is also resolved (A and AAAA, `deps.resolve`) and every address
 * check runs on each address it serves from, so a host on a listed server is
 * not reported as unlisted just because the NAME is on no list. Each hit says
 * which address it was.
 *
 * A miss is reported as `listed: false` with the lists that were checked,
 * never as "clean": absence from a few lists is not a clean bill of health,
 * and the report says which ones. A list that could not be asked (its test
 * entry failed) is named under `unknown`, never counted as a miss.
 *
 * Deeper analysis (history past the public window, the /24 around an
 * address, network owner, a watch list that alerts) is ThreatCrush's paid
 * tier; the report links there and says what it adds.
 */

export const DEEPER = {
  url: 'https://threatcrush.com/reputation',
  name: 'ThreatCrush Reputation Pro',
  adds: [
    'full sighting history across the ThreatCrush network',
    'the /24 neighbourhood: how many nearby addresses are listed',
    'network owner and country',
    'a 0-100 threat score with the reasons behind it',
    'watch lists that alert when an address or domain is listed',
    'higher API volume',
  ],
};

export const CHECKED = {
  ip: [
    { list: 'traffic', name: 'nichedb /traffic (ThreatCrush bans, approved on the evidence)' },
    { list: 'abusech', name: 'abuse.ch ThreatFox, URLhaus and Feodo Tracker' },
  ],
  domain: [
    { list: 'abusech', name: 'abuse.ch ThreatFox and URLhaus' },
    { list: 'surbl', name: 'SURBL (watched domains only)' },
  ],
};

/**
 * What a lookup of this type checks: the stored lists, the live DNS lists
 * `dnsbl` will ask (by name), and, for a domain, every address check again
 * on the addresses it resolves to.
 */
export function checkedFor(type, dnsbl) {
  const live = (t) =>
    (dnsbl?.lists(t) ?? []).map((name) => ({ list: 'dnsbl', name: `${name} (live DNS)` }));
  if (type === 'ip') return [...CHECKED.ip, ...live('ip')];
  const onAddresses = [...CHECKED.ip, ...live('ip')].map((c) => c.name).join('; ');
  return [
    ...CHECKED.domain,
    ...live('domain'),
    { list: 'addresses', name: `its A/AAAA addresses, against: ${onAddresses}` },
  ];
}

/** What was asked: `{ type: 'ip'|'domain', value }`, or `{ error }`. */
export function parseIndicator(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { error: 'Give an IP address or a domain.' };
  const bare = text.replace(/^\[|\]$/g, '');
  if (isIP(bare)) {
    const ip = normaliseIp(bare);
    return ip ? { type: 'ip', value: ip } : { error: 'That is not a public IP address.' };
  }
  const domain = normaliseDomain(text);
  return domain
    ? { type: 'domain', value: domain }
    : { error: 'That is not an IP address or a domain.' };
}

/** The domain and every parent with two labels or more: a.b.evil.example → b.evil.example → evil.example. */
export function domainChain(domain) {
  const labels = domain.split('.');
  const out = [];
  for (let i = 0; i + 2 <= labels.length; i++) out.push(labels.slice(i).join('.'));
  return out;
}

/** The rows to read for one indicator, as `{ adapter, externalId }` probes. */
export function probesFor({ type, value }) {
  if (type === 'ip') return [{ adapter: 'abusech', externalId: `ip:${value}` }];
  return [
    ...domainChain(value).map((d) => ({ adapter: 'abusech', externalId: `domain:${d}` })),
    { adapter: 'surbl', externalId: `surbl:${value}` },
  ];
}

const THREAT_WEIGHT = { botnet_cc: 85, cc_skimming: 80, payload_delivery: 70, malware_host: 65 };

/** How much one live-list reason weighs, by list and what it says. */
const DNSBL_WEIGHT = {
  'Spamhaus ZEN': 75,
  'Spamhaus DBL': 70,
  URIBL: 65,
  SURBL: 65,
  SpamCop: 60,
  Mailspike: 55,
  PSBL: 50,
};
const SEVERE = /phish|malware|botnet|DROP|C&C/i;

const listedOn = (dnsbl) => (dnsbl ?? []).filter((d) => d.status === 'listed');
const counted = (d) => (d.reasons ?? []).filter((r) => !r.policy).map((r) => r.label);

/** One line per live listing: the list, the subject when it is not the query, and what it says. */
function dnsblReasons(dnsbl, { query, via } = {}) {
  return listedOn(dnsbl).map((d) => {
    const subject = d.subject === query ? '' : via ? ` (${d.subject}, ${via})` : ` (${d.subject})`;
    return `${d.list}${subject}: ${counted(d).join(', ')}`;
  });
}

/**
 * A rough 0-100 from the public signals, strongest one wins, plus a little
 * for corroboration. It is a sorting aid, not a verdict; the reasons are
 * returned with it so nobody has to trust the number. A listing found on an
 * address a domain resolves to weighs a little less than one on the name
 * itself: the server is shared more often than the name is.
 */
export function scoreOf({ traffic, indicators, surbl, dnsbl = [], addresses = [], query }) {
  const reasons = [];
  let score = 0;
  let signals = 0;
  if (traffic?.listed) {
    const s = Math.min(95, 60 + 5 * Math.min(Number(traffic.servers) || 0, 5));
    score = Math.max(score, s);
    signals++;
    reasons.push(
      `banned by ${traffic.servers} of our servers (${traffic.blocks} bans), approved by a reviewer`,
    );
  }
  for (const row of indicators) {
    const threat = row.data?.threat;
    score = Math.max(score, THREAT_WEIGHT[threat] ?? 60);
    reasons.push(`abuse.ch ${(row.data?.feeds ?? []).join('/')}: ${row.title}`);
  }
  if (indicators.length) signals++;
  if (surbl?.data?.status === 'listed') {
    score = Math.max(score, 70);
    signals++;
    reasons.push(`SURBL lists it on ${(surbl.data.lists ?? []).join(', ') || 'a list'}`);
  }
  const weigh = (list, factor) => {
    for (const d of listedOn(list)) {
      const base = DNSBL_WEIGHT[d.list] ?? 55;
      score = Math.max(
        score,
        Math.round((counted(d).some((l) => SEVERE.test(l)) ? base + 10 : base) * factor),
      );
      signals++;
    }
  };
  weigh(dnsbl, 1);
  reasons.push(...dnsblReasons(dnsbl, { query }));
  for (const a of addresses) {
    const via = `${a.ip.includes(':') ? 'AAAA' : 'A'} record`;
    if (a.traffic?.listed) {
      score = Math.max(score, 60);
      signals++;
      reasons.push(`${a.ip} (${via}): banned by ${a.traffic.servers} of our servers`);
    }
    for (const i of a.indicators) {
      score = Math.max(score, Math.round((THREAT_WEIGHT[i.threat] ?? 60) * 0.85));
      reasons.push(`${a.ip} (${via}): abuse.ch ${i.feeds.join('/')}: ${i.title}`);
    }
    if (a.indicators.length) signals++;
    weigh(a.dnsbl, 0.85);
    reasons.push(
      ...listedOn(a.dnsbl).map((d) => `${a.ip} (${via}) on ${d.list}: ${counted(d).join(', ')}`),
    );
  }
  if (signals > 1) score = Math.min(100, score + 10 * (signals - 1));
  return { score, reasons };
}

const indicatorOut = (row) => ({
  indicator: row.data?.indicator ?? row.external_id.split(':').slice(1).join(':'),
  title: row.title,
  summary: row.summary,
  threat: row.data?.threat ?? null,
  malware: row.data?.malware ?? [],
  feeds: row.data?.feeds ?? [],
  confidence: row.data?.confidence ?? null,
  first_seen: row.data?.firstSeen ?? row.published_at ?? null,
  last_listed: row.data?.lastListed ?? null,
  url: row.url,
});

/**
 * The report for one indicator. `deps.items(probes)` reads stored rows
 * (db/reputation itemsByAdapterIds) and `deps.traffic(ip)` the /traffic
 * record (db/traffic lookupIp). `deps.resolve(domain)` (its addresses) and
 * `deps.dnsbl` (live lists, see dnsbl.js liveReputationDeps) are optional:
 * without them a domain is not resolved and no live list is asked, and the
 * report's `checked` says so by leaving them out. All injected so the logic
 * is testable.
 */
export async function reputationReport(raw, deps) {
  const parsed = parseIndicator(raw);
  if (parsed.error) return { query: String(raw ?? ''), error: parsed.error };
  const { type, value } = parsed;
  const dnsblCheck = (t, subject) =>
    deps.dnsbl ? deps.dnsbl.check(t, subject).catch(() => []) : Promise.resolve([]);

  // The addresses a domain serves from, public ones only, each checked like an IP query.
  const ips =
    type === 'domain' && deps.resolve
      ? [
          ...new Set(
            (await deps.resolve(value).catch(() => []))
              .map((ip) => normaliseIp(ip))
              .filter(Boolean),
          ),
        ]
      : [];
  const subjects = type === 'domain' ? domainChain(value).slice(0, 4) : [value];
  const [rows, traffic, ownDnsbl, perAddress] = await Promise.all([
    deps.items([
      ...probesFor(parsed),
      ...ips.map((ip) => ({ adapter: 'abusech', externalId: `ip:${ip}` })),
    ]),
    type === 'ip' ? deps.traffic(value) : Promise.resolve(null),
    Promise.all(subjects.map((d) => dnsblCheck(type, d))).then((r) => r.flat()),
    Promise.all(
      ips.map(async (ip) => ({
        ip,
        traffic: await deps.traffic(ip).catch(() => null),
        dnsbl: await dnsblCheck('ip', ip),
      })),
    ),
  ]);
  const own = (r) => !ips.some((ip) => r.external_id === `ip:${ip}`);
  const indicators = rows.filter((r) => r.adapter === 'abusech' && own(r));
  const surbl = rows.find((r) => r.adapter === 'surbl') ?? null;
  const addresses = perAddress.map((a) => {
    const hits = rows.filter((r) => r.adapter === 'abusech' && r.external_id === `ip:${a.ip}`);
    const out = {
      ip: a.ip,
      traffic: a.traffic?.listed ? a.traffic : null,
      indicators: hits.map(indicatorOut),
      dnsbl: a.dnsbl,
    };
    out.listed = Boolean(out.traffic) || hits.length > 0 || listedOn(a.dnsbl).length > 0;
    return out;
  });
  const { score, reasons } = scoreOf({
    traffic,
    indicators,
    surbl,
    dnsbl: ownDnsbl,
    addresses,
    query: value,
  });
  const listed =
    Boolean(traffic?.listed) ||
    indicators.length > 0 ||
    surbl?.data?.status === 'listed' ||
    listedOn(ownDnsbl).length > 0 ||
    addresses.some((a) => a.listed);
  const unknown = [
    ...new Set(
      [...ownDnsbl, ...addresses.flatMap((a) => a.dnsbl)]
        .filter((d) => d.status === 'unknown')
        .map((d) => d.list),
    ),
  ];
  return {
    query: value,
    type,
    listed,
    score,
    reasons,
    traffic: traffic?.listed ? traffic : null,
    indicators: indicators.map(indicatorOut),
    surbl: surbl
      ? {
          status: surbl.data?.status ?? null,
          lists: surbl.data?.lists ?? [],
          checked: surbl.updated_at,
        }
      : null,
    dnsbl: ownDnsbl,
    addresses: type === 'domain' ? addresses : undefined,
    unknown,
    checked: checkedFor(type, deps.dnsbl),
    note: listed
      ? null
      : `Not on any list checked here. That is not a clean bill of health: these lists only know what they were told.${unknown.length ? ` Could not ask: ${unknown.join(', ')}.` : ''}`,
    deeper: DEEPER,
  };
}
