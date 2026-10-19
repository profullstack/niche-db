import { isIP } from 'node:net';
import data from './owners-data.json' with { type: 'json' };
import providers from './providers-data.json' with { type: 'json' };

/**
 * Who owns an address, for the networks we know by name: crawlers, CDNs,
 * public resolvers and the companies that own whole blocks. Every one is
 * kept off /traffic (Anthony, 2026-10-19: "keep them off but add some sort of
 * owner list so people can find out who owns an ip"): a ban on one of these
 * blocks a search engine, a whole CDN or the internet's DNS, never one actor.
 *
 * Published lists (Applebot, Googlebot, Bingbot, Cloudflare) live in
 * owners-data.json, refreshed by `bun scripts/refresh-ip-owners.js`. The rest
 * are written here with where they come from. Any other address is looked up
 * in RDAP (rdap.js), which names the network's registrant.
 *
 * PROVIDERS are the hosting and seedbox companies listed on r4ck.dev and
 * ch4nnels.com that run their own network (providers-data.json, refreshed by
 * `bun scripts/refresh-provider-ranges.js`). They are looked up but never kept
 * off: a rented server is one actor, so a ban there is listed like any other.
 */
export const OWNERS = [
  {
    slug: 'applebot',
    name: 'Applebot (Apple)',
    kind: 'crawler',
    about: "Apple's web crawler, for Siri, Spotlight and Apple Intelligence.",
    source: 'https://search.developer.apple.com/applebot.json',
    ranges: data.ranges.applebot,
  },
  {
    slug: 'apple',
    name: 'Apple Inc.',
    kind: 'company',
    about: 'Apple has owned all of 17.0.0.0/8 since 1990 (ARIN APPLE-WWNET).',
    source: 'https://rdap.arin.net/registry/ip/17.0.0.0',
    ranges: ['17.0.0.0/8', '2620:149::/32', '2a01:b740::/32'],
  },
  {
    slug: 'googlebot',
    name: 'Googlebot (Google)',
    kind: 'crawler',
    about: "Google Search's crawler.",
    source: 'https://developers.google.com/static/search/apis/ipranges/googlebot.json',
    ranges: data.ranges.googlebot,
  },
  {
    slug: 'bingbot',
    name: 'Bingbot (Microsoft)',
    kind: 'crawler',
    about: "Bing's crawler, which also feeds DuckDuckGo and ChatGPT search.",
    source: 'https://www.bing.com/toolbox/bingbot.json',
    ranges: data.ranges.bingbot,
  },
  {
    slug: 'cloudflare',
    name: 'Cloudflare',
    kind: 'cdn',
    about: "Cloudflare's edge: every site behind Cloudflare arrives from these addresses.",
    source: 'https://www.cloudflare.com/ips/',
    ranges: data.ranges.cloudflare,
  },
  {
    slug: 'cloudflare-dns',
    name: 'Cloudflare DNS (1.1.1.1)',
    kind: 'resolver',
    about: 'Public DNS resolver.',
    source: 'https://one.one.one.one/',
    ranges: ['1.1.1.1/32', '1.0.0.1/32'],
  },
  {
    slug: 'google-dns',
    name: 'Google Public DNS',
    kind: 'resolver',
    about: 'Public DNS resolver.',
    source: 'https://developers.google.com/speed/public-dns',
    ranges: ['8.8.8.8/32', '8.8.4.4/32', '2001:4860:4860::8888/128', '2001:4860:4860::8844/128'],
  },
  {
    slug: 'quad9',
    name: 'Quad9',
    kind: 'resolver',
    about: 'Public DNS resolver.',
    source: 'https://www.quad9.net/',
    ranges: ['9.9.9.9/32', '149.112.112.112/32', '2620:fe::fe/128', '2620:fe::9/128'],
  },
  {
    slug: 'opendns',
    name: 'OpenDNS (Cisco)',
    kind: 'resolver',
    about: 'Public DNS resolver.',
    source: 'https://www.opendns.com/',
    ranges: ['208.67.222.222/32', '208.67.220.220/32'],
  },
].map((o) => ({ ...o, shared: true }));

const slugify = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

export const PROVIDERS = providers.providers.map((p) => ({
  slug: slugify(p.domain),
  name: p.name,
  kind: 'hosting',
  about: `Runs its own network: ${p.asns.map((a) => `AS${a.asn} (${a.holder})`).join(', ')}. Listed on ${p.directories.map((d) => d.site).join(' and ')}.`,
  source: `https://bgp.he.net/AS${p.asns[0].asn}`,
  website: `https://${p.domain}`,
  asns: p.asns.map(({ asn, holder }) => ({ asn, holder })),
  directories: p.directories,
  shared: false,
  ranges: p.ranges,
}));

export const OWNER_KINDS = {
  crawler: 'Search crawler',
  company: 'Company network',
  cdn: 'CDN edge',
  resolver: 'Public DNS resolver',
  hosting: 'Hosting provider',
};

/** An address as a BigInt and its width in bits, or null. */
export function ipToBigInt(ip) {
  const kind = isIP(String(ip));
  if (kind === 4)
    return [
      String(ip)
        .split('.')
        .reduce((n, o) => (n << 8n) + BigInt(o), 0n),
      32,
    ];
  if (kind !== 6) return null;
  let s = String(ip).toLowerCase();
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const [n] = ipToBigInt(v4[1]);
    s = s.replace(v4[1], `${(n >> 16n).toString(16)}:${(n & 0xffffn).toString(16)}`);
  }
  const [head, tail = null] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = tail === null ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  return [groups.reduce((n, g) => (n << 16n) + BigInt(`0x${g || '0'}`), 0n), 128];
}

function parseCidr(cidr) {
  const [base, bits] = cidr.split('/');
  const parsed = ipToBigInt(base);
  if (!parsed) throw new Error(`bad range ${cidr}`);
  const [n, width] = parsed;
  const len = bits === undefined ? width : Number(bits);
  const shift = BigInt(width - len);
  return { cidr, width, len, net: (n >> shift) << shift, shift };
}

/**
 * Ranges indexed by width and prefix length, so a lookup is one map hit per
 * distinct length rather than a scan of every range (the providers alone
 * announce thousands).
 */
function index(owners) {
  const byLen = new Map();
  for (const owner of owners)
    for (const cidr of owner.ranges) {
      const r = parseCidr(cidr);
      const key = `${r.width}/${r.len}`;
      if (!byLen.has(key)) byLen.set(key, { ...r, nets: new Map() });
      const nets = byLen.get(key).nets;
      if (!nets.has(r.net)) nets.set(r.net, { cidr, owner });
    }
  // Most specific first, so Applebot wins over Apple's /8.
  return [...byLen.values()].sort((a, b) => b.len - a.len);
}
const SHARED = index(OWNERS);
const HOSTING = index(PROVIDERS);

function find(idx, ip) {
  const parsed = ipToBigInt(ip);
  if (!parsed) return null;
  const [n, width] = parsed;
  for (const level of idx) {
    if (level.width !== width) continue;
    const hit = level.nets.get((n >> level.shift) << level.shift);
    if (hit) {
      const { ranges: _ranges, ...owner } = hit.owner;
      return { ...owner, range: hit.cidr };
    }
  }
  return null;
}

/**
 * A shared network we never list (crawler, CDN, resolver, company block):
 * { slug, name, kind, about, source, shared: true, range }, or null.
 */
export function sharedOwnerOf(ip) {
  return find(SHARED, ip);
}

/**
 * The named owner of an address: a shared network first, else a hosting
 * provider (shared: false), else null when it is not one we know by name.
 */
export function ownerOf(ip) {
  return find(SHARED, ip) ?? find(HOSTING, ip);
}

/** The registry as published on /ips/owners and its JSON. */
export function ownersList() {
  return [...OWNERS, ...PROVIDERS].map(({ ranges, ...o }) => ({
    ...o,
    kind_name: OWNER_KINDS[o.kind] ?? o.kind,
    ranges,
  }));
}

export const OWNERS_FETCHED_AT = data.fetched_at;
export const PROVIDERS_FETCHED_AT = providers.fetched_at;
export const PROVIDERS_CHECKED = providers.checked;

/** One owner by slug, with its ranges, or null. */
export function ownerBySlug(slug) {
  const o = [...OWNERS, ...PROVIDERS].find((x) => x.slug === slug);
  return o ? { ...o, kind_name: OWNER_KINDS[o.kind] ?? o.kind } : null;
}
