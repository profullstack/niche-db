import { isIP } from 'node:net';
import { defineAdapter } from '@nichedb/core/adapter';
import { isSharedIp } from '@nichedb/core/traffic/shared';

/**
 * abuse.ch: the malware infrastructure the security community reports, as
 * one row per IP address or domain.
 *
 * Three keyless downloads, read hourly:
 *
 * - ThreatFox `export/json/recent/`: every indicator shared in the last 48
 *   hours, as `{ "<id>": [ { ioc_value, ioc_type, threat_type, malware_printable,
 *   confidence_level, first_seen_utc, last_seen_utc, tags, reporter } ] }`. Only
 *   `ip:port` (botnet C2 and payload delivery) and `domain` rows are kept;
 *   hashes and full URLs are not addresses anyone can look up or block.
 * - URLhaus host file: `127.0.0.1<TAB><host>` per host currently serving malware.
 * - Feodo Tracker IP blocklist: one botnet C2 address per line.
 *
 * A row's id is the address itself (`ip:203.0.113.5`, `domain:evil.example`),
 * so the same host named by two feeds is one row listing both, and a host the
 * feeds drop keeps its row with the day it was last listed: the history is the
 * point of keeping it. ThreatFox's recent export only covers two days, so a
 * long-lived C2 is refreshed every run it is still being reported.
 *
 * Shared infrastructure is never listed as a whole: Cloudflare's ranges and
 * the big public resolvers (abuse.ch reports the C2 behind a CDN by the CDN's
 * address often enough), and platform suffixes like workers.dev or github.io
 * (a specific subdomain stays). Private and documentation space never appears.
 *
 * TERMS: abuse.ch publishes these feeds for free use, commercial included,
 * and asks for credit. Every row carries the attribution.
 */
export const FEEDS = {
  threatfox: 'https://threatfox.abuse.ch/export/json/recent/',
  urlhaus: 'https://urlhaus.abuse.ch/downloads/hostfile/',
  feodo: 'https://feodotracker.abuse.ch/downloads/ipblocklist.txt',
};
export const ATTRIBUTION = 'abuse.ch (ThreatFox, URLhaus, Feodo Tracker), free to use with credit.';
export const DOCS = 'https://abuse.ch/';

/** Below this ThreatFox confidence an indicator is somebody's guess, not a listing. */
export const MIN_CONFIDENCE = 75;

const THREAT_WORDS = {
  botnet_cc: 'botnet command-and-control server',
  payload_delivery: 'malware download host',
  cc_skimming: 'card-skimming host',
  malware_host: 'malware download host',
};

/** Domains that host other people's content: the suffix itself is never listed. */
export const SHARED_DOMAINS = new Set([
  'workers.dev',
  'pages.dev',
  'github.io',
  'githubusercontent.com',
  'herokuapp.com',
  'vercel.app',
  'netlify.app',
  'azurewebsites.net',
  'blob.core.windows.net',
  'amazonaws.com',
  'cloudfront.net',
  'googleusercontent.com',
  'appspot.com',
  'firebaseapp.com',
  'web.app',
  'r2.dev',
  'ngrok.io',
  'ngrok-free.app',
  'duckdns.org',
  'discord.com',
  'discordapp.com',
  'telegram.org',
  'dropbox.com',
  'google.com',
]);

/** Private, loopback, link-local, CGNAT, documentation, multicast: never an indicator. */
function isPublicV4(ip) {
  const [a, b] = ip.split('.').map(Number);
  if (a === 10 || a === 127 || a === 0 || a >= 224) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 168 || b === 0)) return false;
  if (a === 169 && b === 254) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return false;
  if (a === 203 && b === 0) return false;
  return true;
}

export { isSharedIp };

/** A public, listable address from `1.2.3.4`, `1.2.3.4:443` or `[2001:db8::1]:80`, or null. */
export function cleanIp(value) {
  const raw = String(value ?? '').trim();
  const v6 = /^\[([^\]]+)\](?::\d+)?$/.exec(raw);
  let ip = v6 ? v6[1] : raw;
  if (!v6 && isIP(ip) !== 6) ip = ip.replace(/:\d+$/, '');
  const kind = isIP(ip);
  if (!kind) return null;
  if (kind === 4) return isPublicV4(ip) && !isSharedIp(ip) ? ip : null;
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::' || /^f[cdf]|^fe[89ab]|^2001:db8/.test(lower)) return null;
  return isSharedIp(lower) ? null : lower;
}

/** A listable host name, or null for an address, a bare word or a shared platform suffix. */
export function cleanDomain(value) {
  const d = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
  if (!d || d === 'localhost' || isIP(d)) return null;
  if (!/^[a-z0-9_.-]+\.[a-z0-9-]{2,}$/.test(d)) return null;
  if (SHARED_DOMAINS.has(d)) return null;
  return d;
}

const dayOf = (s) => {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(String(s ?? ''));
  return m ? new Date(`${m[1]}T${m[2]}Z`) : null;
};

/**
 * Fold one feed's sightings into the accumulator: one record per address,
 * every feed that named it, the strongest threat, the earliest first sighting.
 */
function add(acc, type, value, sighting) {
  const key = `${type}:${value}`;
  const row = acc.get(key) ?? {
    type,
    value,
    feeds: new Set(),
    malware: new Set(),
    threats: new Set(),
    ports: new Set(),
    confidence: null,
    firstSeen: null,
    lastSeen: null,
    reference: null,
  };
  row.feeds.add(sighting.feed);
  if (sighting.malware) row.malware.add(sighting.malware);
  if (sighting.threat) row.threats.add(sighting.threat);
  if (sighting.port) row.ports.add(sighting.port);
  if (sighting.confidence != null)
    row.confidence = Math.max(row.confidence ?? 0, sighting.confidence);
  if (sighting.firstSeen && (!row.firstSeen || sighting.firstSeen < row.firstSeen))
    row.firstSeen = sighting.firstSeen;
  if (sighting.lastSeen && (!row.lastSeen || sighting.lastSeen > row.lastSeen))
    row.lastSeen = sighting.lastSeen;
  row.reference ??= sighting.reference ?? null;
  acc.set(key, row);
}

/** ThreatFox recent export: ip:port and domain indicators at or above MIN_CONFIDENCE. */
export function parseThreatFox(text, acc = new Map(), { minConfidence = MIN_CONFIDENCE } = {}) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return acc;
  }
  for (const entries of Object.values(doc ?? {})) {
    for (const ioc of Array.isArray(entries) ? entries : []) {
      const confidence = Number(ioc?.confidence_level) || 0;
      if (confidence < minConfidence) continue;
      const threat = String(ioc.threat_type ?? '');
      const sighting = {
        feed: 'threatfox',
        malware:
          ioc.malware_printable && ioc.malware_printable !== 'Unknown malware'
            ? String(ioc.malware_printable)
            : null,
        threat,
        confidence,
        firstSeen: dayOf(ioc.first_seen_utc),
        lastSeen: dayOf(ioc.last_seen_utc) ?? dayOf(ioc.first_seen_utc),
        reference:
          typeof ioc.reference === 'string' && /^https:\/\//.test(ioc.reference)
            ? ioc.reference
            : null,
      };
      const value = String(ioc.ioc_value ?? '');
      if (ioc.ioc_type === 'ip:port') {
        if (threat !== 'botnet_cc' && threat !== 'payload_delivery') continue;
        const ip = cleanIp(value);
        const port = Number(/:(\d+)$/.exec(value)?.[1]) || null;
        if (ip) add(acc, 'ip', ip, { ...sighting, port });
      } else if (ioc.ioc_type === 'domain') {
        const domain = cleanDomain(value);
        if (domain) add(acc, 'domain', domain, sighting);
      }
    }
  }
  return acc;
}

/** The URLhaus host file: hosts serving malware now. An IP host is an IP row. */
export function parseUrlhausHosts(text, acc = new Map()) {
  for (const line of String(text ?? '').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const host = t.split(/\s+/)[1] ?? '';
    const sighting = { feed: 'urlhaus', threat: 'malware_host' };
    const ip = cleanIp(host);
    if (ip) add(acc, 'ip', ip, sighting);
    else {
      const domain = cleanDomain(host);
      if (domain) add(acc, 'domain', domain, sighting);
    }
  }
  return acc;
}

/** The Feodo Tracker blocklist: one botnet C2 address per line. */
export function parseFeodo(text, acc = new Map()) {
  for (const line of String(text ?? '').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const ip = cleanIp(t);
    if (ip) add(acc, 'ip', ip, { feed: 'feodo', threat: 'botnet_cc' });
  }
  return acc;
}

const FEED_NAMES = { threatfox: 'ThreatFox', urlhaus: 'URLhaus', feodo: 'Feodo Tracker' };

/** Where a reader checks the listing for themselves. */
export function referenceUrl(row) {
  if (row.reference) return row.reference;
  if (row.feeds.has('urlhaus')) return `https://urlhaus.abuse.ch/host/${row.value}/`;
  if (row.feeds.has('feodo')) return `https://feodotracker.abuse.ch/browse/host/${row.value}/`;
  return `https://threatfox.abuse.ch/browse.php?search=ioc%3A${encodeURIComponent(row.value)}`;
}

const strongestThreat = (threats) =>
  ['botnet_cc', 'cc_skimming', 'payload_delivery', 'malware_host'].find((t) => threats.has(t)) ??
  [...threats][0] ??
  'malware_host';

/** One accumulated address as an item. `today` is the day it was last seen in a feed. */
export function indicatorItem(row, today) {
  const threat = strongestThreat(row.threats);
  const malware = [...row.malware].sort();
  const feeds = [...row.feeds].sort();
  const what = THREAT_WORDS[threat] ?? threat.replace(/_/g, ' ');
  const family = malware.length ? ` for ${malware.join(', ')}` : '';
  const seen = (row.firstSeen ?? today).toISOString().slice(0, 10);
  const listedBy = feeds.map((f) => FEED_NAMES[f] ?? f).join(', ');
  return {
    externalId: `${row.type}:${row.value}`,
    kind: 'indicator',
    title: `${row.value}: ${what}${family}`,
    summary: `abuse.ch ${listedBy} lists ${row.type === 'ip' ? 'the address' : 'the domain'} ${row.value} as a ${what}${family}${row.confidence != null ? ` (confidence ${row.confidence}%)` : ''}, first seen ${seen}.`,
    url: referenceUrl(row),
    publishedAt: row.firstSeen ?? today,
    timeKnown: Boolean(row.firstSeen),
    precision: row.firstSeen ? 'minute' : 'day',
    tags: [
      'abusech',
      `ioc:${row.type}`,
      `threat:${threat}`,
      ...feeds.map((f) => `feed:${f}`),
      ...malware.map((m) => `malware:${m}`),
    ],
    data: {
      indicator: row.value,
      type: row.type,
      threat,
      threats: [...row.threats].sort(),
      malware,
      feeds,
      ports: [...row.ports].sort((a, b) => a - b),
      confidence: row.confidence,
      firstSeen: row.firstSeen?.toISOString() ?? null,
      lastSeen: row.lastSeen?.toISOString() ?? null,
      lastListed: today.toISOString().slice(0, 10),
      attribution: ATTRIBUTION,
    },
  };
}

export const abusech = defineAdapter({
  name: 'abusech',
  title: 'abuse.ch',
  collection: 'threats',
  description:
    'Malware infrastructure the security community reports to abuse.ch, one row per IP address or domain: botnet command-and-control servers and malware download hosts from ThreatFox (last 48 hours, confidence 75% and up), the hosts URLhaus sees serving malware now, and the Feodo Tracker botnet C2 list. Read hourly; a host the feeds drop keeps its row with the day it was last listed. CDN ranges, public resolvers and shared platform suffixes are never listed. Free to use with credit to abuse.ch.',
  docs: DOCS,
  kinds: ['indicator'],
  cadenceMinutes: 60,
  defaultSources: [
    {
      slug: 'abusech-indicators',
      name: 'abuse.ch: malware IPs and domains',
      description:
        'ThreatFox, URLhaus and Feodo Tracker merged into one row per address, refreshed hourly: what nichedb.dev/reputation answers from for malware infrastructure.',
      config: {},
    },
  ],
  async pull({ http, log, now = new Date() }) {
    const acc = new Map();
    const notes = [];
    const read = async (feed, parse) => {
      try {
        const before = acc.size;
        parse(await http.text(FEEDS[feed], { timeoutMs: 90_000 }), acc);
        notes.push(`${feed} +${acc.size - before}`);
      } catch (err) {
        log(`${feed} failed: ${err?.message ?? err}`);
        notes.push(`${feed} failed`);
      }
    };
    await read('threatfox', parseThreatFox);
    await read('urlhaus', parseUrlhausHosts);
    await read('feodo', parseFeodo);
    const today = new Date(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
    const items = [...acc.values()].map((row) => indicatorItem(row, today));
    const ips = items.filter((i) => i.data.type === 'ip').length;
    log(`${items.length} indicators (${ips} IPs, ${items.length - ips} domains)`);
    if (notes.every((n) => n.endsWith('failed'))) throw new Error('every abuse.ch feed failed');
    return { items, note: `${ips} IPs, ${items.length - ips} domains; ${notes.join(', ')}` };
  },
});
