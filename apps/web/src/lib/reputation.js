import { isIP } from 'node:net';
import { normaliseIp } from '@nichedb/core/traffic';
import { normaliseDomain } from './business.js';

/**
 * One answer for "is this IP or domain bad?", built from what nichedb already
 * keeps: /traffic (addresses our own servers banned, each approved by a
 * person), abuse.ch (malware infrastructure the community reports) and the
 * SURBL watch rows. Nothing is looked up live here; every answer is a read.
 *
 * A miss is reported as `listed: false` with the lists that were checked,
 * never as "clean": absence from three lists is not a clean bill of health,
 * and the report says which three.
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
    { list: 'traffic', name: 'nichedb /traffic (ThreatCrush bans, approved by a person)' },
    { list: 'abusech', name: 'abuse.ch ThreatFox, URLhaus and Feodo Tracker' },
  ],
  domain: [
    { list: 'abusech', name: 'abuse.ch ThreatFox and URLhaus' },
    { list: 'surbl', name: 'SURBL (watched domains only)' },
  ],
};

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

/**
 * A rough 0-100 from the public signals, strongest one wins, plus a little
 * for corroboration. It is a sorting aid, not a verdict; the reasons are
 * returned with it so nobody has to trust the number.
 */
export function scoreOf({ traffic, indicators, surbl }) {
  const reasons = [];
  let score = 0;
  if (traffic?.listed) {
    const s = Math.min(95, 60 + 5 * Math.min(Number(traffic.servers) || 0, 5));
    score = Math.max(score, s);
    reasons.push(
      `banned by ${traffic.servers} of our servers (${traffic.blocks} bans), approved by a reviewer`,
    );
  }
  for (const row of indicators) {
    const threat = row.data?.threat;
    score = Math.max(score, THREAT_WEIGHT[threat] ?? 60);
    reasons.push(`abuse.ch ${(row.data?.feeds ?? []).join('/')}: ${row.title}`);
  }
  if (surbl?.data?.status === 'listed') {
    score = Math.max(score, 70);
    reasons.push(`SURBL lists it on ${(surbl.data.lists ?? []).join(', ') || 'a list'}`);
  }
  const signals =
    (traffic?.listed ? 1 : 0) +
    (indicators.length ? 1 : 0) +
    (surbl?.data?.status === 'listed' ? 1 : 0);
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
 * record (db/traffic lookupIp); both are injected so the logic is testable.
 */
export async function reputationReport(raw, deps) {
  const parsed = parseIndicator(raw);
  if (parsed.error) return { query: String(raw ?? ''), error: parsed.error };
  const [rows, traffic] = await Promise.all([
    deps.items(probesFor(parsed)),
    parsed.type === 'ip' ? deps.traffic(parsed.value) : Promise.resolve(null),
  ]);
  const indicators = rows.filter((r) => r.adapter === 'abusech');
  const surbl = rows.find((r) => r.adapter === 'surbl') ?? null;
  const { score, reasons } = scoreOf({ traffic, indicators, surbl });
  const listed =
    Boolean(traffic?.listed) || indicators.length > 0 || surbl?.data?.status === 'listed';
  return {
    query: parsed.value,
    type: parsed.type,
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
    checked: CHECKED[parsed.type],
    note: listed
      ? null
      : 'Not on any list checked here. That is not a clean bill of health: these lists only know what they were told.',
    deeper: DEEPER,
  };
}
