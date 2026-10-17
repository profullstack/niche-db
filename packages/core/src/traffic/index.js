import { isIP } from 'node:net';
import { config } from '@nichedb/config';
import * as store from '@nichedb/db/traffic';

/**
 * Bad traffic: addresses our own servers banned, imported from ThreatCrush and
 * published on /traffic only after a reviewer approved them.
 *
 * The feed is ThreatCrush's /api/v1/ban-candidates, which aggregates every
 * ban across the fleet per address (first and last seen, how many boxes, which
 * rules) and already leaves out private ranges, our own servers, allowlists
 * and offenders whose only sin was hammering a paywall. Everything it sends
 * lands here as `pending`; this module never approves anything.
 */

export const SOURCE = 'threatcrush';

/** What each ThreatCrush rule means to a reader, strongest first. */
const RULE_CATEGORY = [
  ['web-sqli-attack', 'exploit'],
  ['web-xss-attack', 'exploit'],
  ['exploit-probe-pattern', 'exploit'],
  ['web-path-traversal', 'exploit'],
  ['ssh-brute-force', 'brute-force'],
  ['ssh-root-login', 'brute-force'],
  ['ssh-user-enumeration', 'brute-force'],
  ['web-scanner-detection', 'scanner'],
  ['web-scanner-user-agent', 'scanner'],
  ['quoted-user-agent', 'scanner'],
  ['submission-campaign-403', 'spam'],
];

export const CATEGORIES = {
  exploit: 'Exploit attempts (SQL injection, XSS, path traversal, known exploit paths)',
  'brute-force': 'SSH brute force and root login attempts',
  scanner: 'Vulnerability and admin-panel scanners',
  spam: 'Form and submission spam',
  other: 'Other abuse',
};

export function categoryFor(rules = []) {
  for (const [rule, category] of RULE_CATEGORY) if (rules.includes(rule)) return category;
  // Bans recorded without a rule id come through as `attack-<kind>`, read from
  // the reason ("Attack [PATH_TRAVERSAL]: GET /.env"): secret-file and exploit probes.
  if (rules.some((r) => r.startsWith('attack-'))) return 'exploit';
  return 'other';
}

/** A canonical public address, or null for anything that is not one. */
export function normaliseIp(input) {
  const raw = String(input ?? '')
    .trim()
    .replace(/^\[|\]$/g, '');
  const kind = isIP(raw);
  if (!kind) return null;
  const ip = kind === 6 ? raw.toLowerCase() : raw;
  return isPublicIp(ip) ? ip : null;
}

/** Private, loopback, link-local, CGNAT, documentation and multicast space is never published. */
export function isPublicIp(ip) {
  const kind = isIP(ip);
  if (kind === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0 || a >= 224) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 169 && b === 254) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 192 && b === 0) return false;
    if (a === 198 && (b === 18 || b === 19 || b === 51)) return false;
    if (a === 203 && b === 0) return false;
    return true;
  }
  if (kind === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return false;
    if (/^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || /^ff/.test(lower)) return false;
    if (lower.startsWith('2001:db8')) return false;
    return true;
  }
  return false;
}

/** One feed candidate as a traffic_ips row, or null to drop it. */
export function toRow(candidate) {
  const ip = normaliseIp(candidate?.ip);
  if (!ip) return null;
  const rules = Array.isArray(candidate.rules)
    ? candidate.rules.filter((r) => typeof r === 'string').slice(0, 20)
    : [];
  return {
    ip,
    score: Number.isFinite(candidate.score) ? Math.round(candidate.score) : 0,
    category: categoryFor(rules),
    first_seen: candidate.first_seen ?? null,
    last_seen: candidate.last_seen ?? null,
    blocks: Number(candidate.blocks) || 0,
    servers: Number(candidate.servers) || 0,
    rules,
    max_severity: candidate.max_severity ?? null,
    evidence: {
      titles: Array.isArray(candidate.titles)
        ? candidate.titles.slice(0, 5).map((t) => String(t).slice(0, 200))
        : [],
      paths: Array.isArray(candidate.paths)
        ? candidate.paths.slice(0, 5).map((t) => String(t).slice(0, 200))
        : [],
    },
  };
}

/**
 * Pull the feed and merge it. Returns a summary for the worker log. Pages
 * through the feed with its cursor so a first import of tens of thousands of
 * addresses does not arrive as one response.
 */
export async function syncTraffic({
  log = console.log,
  fetchImpl = fetch,
  db,
  maxPages = 50,
  feedUrl = config.traffic.feedUrl,
  feedToken = config.traffic.feedToken,
} = {}) {
  if (!feedUrl || !feedToken) return { skipped: 'TRAFFIC_FEED_URL or TRAFFIC_FEED_TOKEN unset' };
  let cursor = null;
  let count = 0;
  let added = 0;
  try {
    for (let page = 0; page < maxPages; page++) {
      const url = new URL(feedUrl);
      url.searchParams.set('limit', '1000');
      if (cursor) url.searchParams.set('cursor', cursor);
      const res = await fetchImpl(url, {
        headers: { authorization: `Bearer ${feedToken}`, accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`feed answered ${res.status}`);
      const body = await res.json();
      const rows = (body.candidates ?? []).map(toRow).filter(Boolean);
      count += rows.length;
      added += await store.upsertCandidates(rows, db ? { db } : undefined);
      cursor = body.next_cursor ?? null;
      if (!cursor) break;
    }
    await store.setSync({ source: SOURCE, count, added }, db ? { db } : undefined);
    log('[traffic]', `${count} candidates, ${added} new`);
    return { count, added };
  } catch (err) {
    await store
      .setSync(
        { source: SOURCE, count, added, error: String(err.message ?? err) },
        db ? { db } : undefined,
      )
      .catch(() => {});
    throw err;
  }
}
