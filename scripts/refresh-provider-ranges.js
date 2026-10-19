#!/usr/bin/env bun
/**
 * Refresh packages/core/src/traffic/providers-data.json: the address ranges
 * of the hosting and seedbox providers listed on r4ck.dev and ch4nnels.com.
 *
 * A provider owns a range when it holds the autonomous system that announces
 * it. For each provider we find its networks two ways, both checked against
 * the provider's own name or domain so a reseller never inherits its
 * upstream's ranges:
 *   - PeeringDB networks whose website is the provider's domain;
 *   - the network serving the provider's own website (RIPEstat network-info),
 *     kept only when the AS holder's name matches the provider.
 * Each accepted AS's announced prefixes come from RIPEstat. Providers that run
 * on someone else's network (most seedbox brands rent from Hetzner or OVH) get
 * no ranges and are left out.
 *
 *   bun scripts/refresh-provider-ranges.js
 */
import { resolve4 } from 'node:dns/promises';

const OUT = new URL('../packages/core/src/traffic/providers-data.json', import.meta.url);
const UA = { 'user-agent': 'nichedb.dev ip-owners (+https://nichedb.dev/ips/owners)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, { tries = 4 } = {}) {
  for (let i = 0; i < tries; i++) {
    const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30_000) }).catch(
      () => null,
    );
    if (res?.ok) return res.json();
    if (res && res.status !== 429 && res.status < 500) return null;
    await sleep(5000 * (i + 1));
  }
  return null;
}

const domainOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
};

/** Name tokens worth matching against an AS holder ("HETZNER-AS Hetzner Online GmbH"). */
const STOP = new Set(
  'the inc llc ltd gmbh sas sarl bv srl corp co company hosting host server servers cloud network networks net data center internet services service online group limited seedbox seedboxes media'.split(
    ' ',
  ),
);
const tokens = (s) =>
  String(s ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4 && !STOP.has(t));

function holderMatches(holder, provider) {
  const h = String(holder ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  if (!h) return false;
  const stem = provider.domain?.split('.').slice(-2, -1)[0] ?? '';
  const cands = [...tokens(provider.name), ...(stem.length >= 4 ? [stem] : [])];
  return cands.some((t) => h.includes(t));
}

/** r4ck.dev rows whose url is cut to a bare suffix. */
const DOMAIN_FIX = { 'ad.jp': 'sakura.ad.jp' };

/** One name for a company whose products r4ck.dev lists separately. */
const COMPANY = {
  'amazon.com': 'Amazon Web Services',
  'aws.amazon.com': 'Amazon Web Services',
  'google.com': 'Google Cloud',
  'cloud.google.com': 'Google Cloud',
  'microsoft.com': 'Microsoft Azure',
  'azure.microsoft.com': 'Microsoft Azure',
  'digitalocean.com': 'DigitalOcean',
  'cloudflare.com': 'Cloudflare',
  'github.com': 'GitHub',
};

async function providers() {
  const r4ck = await getJson('https://r4ck.dev/api/v1/providers?limit=1000');
  const ch4 = await getJson('https://ch4nnels.com/api/v1/seedboxes');
  if (!r4ck?.providers?.length || !ch4?.providers?.length)
    throw new Error('directory fetch failed');
  const out = new Map();
  for (const p of r4ck.providers) {
    // The site's own host first: r4ck's domain field can be a bare suffix (ad.jp).
    const host = domainOf(p.url) ?? p.domain;
    const domain = DOMAIN_FIX[host] ?? host;
    if (!domain) continue;
    if (out.has(domain)) continue; // products of one company (Lambda, EC2) share its network
    out.set(domain, {
      name: COMPANY[domain] ?? p.name,
      domain,
      directories: [{ site: 'r4ck.dev', url: p.page ?? `https://r4ck.dev/providers/${p.slug}` }],
    });
  }
  for (const p of ch4.providers) {
    const domain = domainOf(p.url);
    if (!domain) continue;
    const dir = { site: 'ch4nnels.com', url: `https://ch4nnels.com/seedboxes/${p.slug}` };
    if (out.has(domain)) out.get(domain).directories.push(dir);
    else out.set(domain, { name: p.name, domain, directories: [dir] });
  }
  return [...out.values()];
}

const holders = new Map();
async function holderOf(asn) {
  if (!holders.has(asn)) {
    const d = await getJson(`https://stat.ripe.net/data/as-overview/data.json?resource=AS${asn}`);
    holders.set(asn, d?.data?.holder ?? null);
  }
  return holders.get(asn);
}

async function asnsFor(p) {
  const found = new Map();
  const pdb = await getJson(
    `https://www.peeringdb.com/api/net?website__contains=${encodeURIComponent(p.domain)}&fields=asn,name,website`,
  );
  await sleep(3500); // PeeringDB allows ~20 anonymous requests a minute
  for (const n of pdb?.data ?? []) {
    // The website must be the provider's own home page, or the network named
    // for it: a personal AS with github.com/<user> as its website is not
    // GitHub's, and a suffix like ad.jp would pull in every *.ad.jp network.
    let home = false;
    try {
      const u = new URL(n.website);
      home = domainOf(n.website) === p.domain && (u.pathname === '/' || u.pathname === '');
    } catch {}
    const site = domainOf(n.website);
    const ours = site === p.domain || site?.endsWith(`.${p.domain}`);
    if (home || (ours && holderMatches(n.name, p)))
      found.set(n.asn, { asn: n.asn, holder: n.name, via: 'peeringdb' });
  }
  const ips = await resolve4(p.domain).catch(() => []);
  for (const ip of ips.slice(0, 2)) {
    const d = await getJson(`https://stat.ripe.net/data/network-info/data.json?resource=${ip}`);
    for (const a of d?.data?.asns ?? []) {
      const asn = Number(a);
      if (found.has(asn)) continue;
      const holder = await holderOf(asn);
      if (holderMatches(holder, p)) found.set(asn, { asn, holder, via: `website ${ip}` });
    }
  }
  return [...found.values()];
}

async function prefixesOf(asn) {
  const d = await getJson(
    `https://stat.ripe.net/data/announced-prefixes/data.json?resource=AS${asn}`,
  );
  return (d?.data?.prefixes ?? []).map((x) => x.prefix);
}

// --only a.com,b.net refreshes just those providers into the existing file.
const onlyArg = process.argv.indexOf('--only');
const only = onlyArg > 0 ? new Set(process.argv[onlyArg + 1].split(',')) : null;
const previous = only ? await Bun.file(OUT).json() : null;

const list = await providers();
console.log(`${list.length} providers`);
const result = only ? previous.providers.filter((p) => !only.has(p.domain)) : [];
for (const p of list) {
  if (only && !only.has(p.domain)) continue;
  const asns = await asnsFor(p);
  if (!asns.length) continue;
  const ranges = new Set();
  for (const a of asns) {
    const pfx = await prefixesOf(a.asn);
    a.prefixes = pfx.length;
    for (const r of pfx) ranges.add(r);
  }
  if (!ranges.size) continue;
  result.push({ ...p, asns, ranges: [...ranges].sort() });
  console.log(
    `${p.name}: ${asns.map((a) => `AS${a.asn} ${a.holder}`).join(', ')} -> ${ranges.size} ranges`,
  );
}
result.sort((a, b) => a.name.localeCompare(b.name));
await Bun.write(
  OUT,
  `${JSON.stringify({ fetched_at: previous?.fetched_at ?? new Date().toISOString(), checked: list.length, providers: result }, null, 2)}\n`,
);
console.log(`${result.length} of ${list.length} providers run their own network`);
