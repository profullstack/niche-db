import { resolve4 } from 'node:dns/promises';
import { dateOnly, defineAdapter } from '@nichedb/core/adapter';

/**
 * SURBL: the public URI reputation lists, and a set of domains checked
 * against them.
 *
 * SURBL publishes six lists of domains seen in unsolicited mail (phishing,
 * malware, abuse, cracked sites, click trackers, disposable mail), combined
 * into one bitmasked DNS zone, multi.surbl.org: a query for
 * `<domain>.multi.surbl.org` answers with an A record in 127.0.0.0/8 whose
 * last octet is the sum of the lists the domain is on, or NXDOMAIN when it is
 * on none. The data changes every 30-40 seconds, the answer's TTL is a minute,
 * and there is no download: the free service is a lookup, one domain at a
 * time, and the whole list is only sold as an rsync or RPZ feed.
 *
 * So this adapter emits two kinds. `list` is the catalogue itself: one row
 * per list with its zone, its bit and what it holds, as surbl.org/lists
 * describes them. `reputation` is one row per watched domain, updated in
 * place when its standing changes: `status:clear`, or `status:listed` with a
 * `list:<code>` tag per list. A row's date is when its standing last changed,
 * not when it was last checked, so an unchanged domain costs no write.
 *
 * TERMS
 *
 * SURBL's free query service is for individuals and organisations with fewer
 * than 1,000 users or 250,000 messages a day, and its terms exclude embedding
 * the data in a product that charges a fee. The default watch list is the
 * house domains plus SURBL's own test entry (test.surbl.org, always listed,
 * which proves the lookup works); a watch list is meant to stay in the tens,
 * not the thousands. An answer of 127.0.0.1 means the resolver has been
 * blocked for over-use; the run stops and says so rather than writing a
 * false standing for every domain.
 *
 * An IPv4 address is queried with its octets reversed, as the zone expects.
 */
export const ZONE = 'multi.surbl.org';
export const LISTS_URL = 'https://surbl.org/lists';
export const ATTRIBUTION = 'SURBL, surbl.org: free query service, subject to its usage policy.';

/** The lists as surbl.org/lists documents them, with the bit each sets in the last octet. */
export const LISTS = [
  {
    code: 'multi',
    bit: null,
    zone: ZONE,
    name: 'Combined',
    about:
      'Every public SURBL list in one bitmasked answer: one entry per domain, whose last octet is the sum of the lists it is on. Updated every 30-40 seconds on average; TTL 60 seconds.',
  },
  {
    code: 'ph',
    bit: 8,
    zone: 'ph.surbl.org',
    name: 'Phishing',
    about: 'Phishing sites, from PhishTank, PhishLabs, URLAbuse and SURBL’s own research.',
  },
  {
    code: 'mw',
    bit: 16,
    zone: 'mw.surbl.org',
    name: 'Malware',
    about: 'Sites hosting malware, from abuse.ch, URLAbuse and SURBL’s own sources.',
  },
  {
    code: 'abuse',
    bit: 64,
    zone: 'abuse.surbl.org',
    name: 'Abuse',
    about:
      'Generally abused sites: pills, counterfeits, dating and the rest, with ISP and ESP data.',
  },
  {
    code: 'cr',
    bit: 128,
    zone: 'cr.surbl.org',
    name: 'Cracked',
    about:
      'Legitimate sites whose credentials or vulnerabilities were exploited to add malicious content.',
  },
  {
    code: 'ct',
    bit: 32,
    zone: 'ct.surbl.org',
    name: 'Click tracker',
    about: 'Domains that track clicks in unsolicited mail.',
  },
  {
    code: 'dm',
    bit: 4,
    zone: 'dm.surbl.org',
    name: 'Disposable mail',
    about: 'Mail domains that enable anonymous sign-ups.',
  },
];

/** The day the catalogue above was read from surbl.org/lists; a fixed date keeps the rows stable. */
export const CATALOGUE_DATE = dateOnly(2026, 9, 21);

/** The house domains, and SURBL's own always-listed test entry as a canary. */
export const DEFAULT_DOMAINS = [
  'nichedb.dev',
  'profullstack.com',
  'rssamplifier.com',
  'crawlproof.com',
  'mynaposter.com',
  'ugig.net',
  'w3bs.org',
  'r4ck.dev',
  'tipoffwatch.com',
  'genrewatch.com',
  'threatcrush.com',
  'coinpayportal.com',
  'brisk.news',
  'outreachgraph.com',
  'bittorrented.com',
  'test.surbl.org',
];

const MAX_DOMAINS = 250;
const CONCURRENCY = 5;

/** A bare host from whatever was written: a URL, an address, a name with a trailing dot. */
export function normaliseDomain(raw) {
  let s = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#]/)[0];
  if (s.includes('@')) s = s.split('@').pop();
  s = s.replace(/^www\./, '').replace(/\.$/, '');
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(s)) return null;
  return s;
}

/** The name to resolve: the domain under the zone, an IPv4 address with its octets reversed. */
export function queryName(domain) {
  const ip = String(domain).match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  const name = ip ? `${ip[4]}.${ip[3]}.${ip[2]}.${ip[1]}` : domain;
  return `${name}.${ZONE}`;
}

/** The lists an answer names, and whether it is the 127.0.0.1 that means "you are blocked". */
export function decode(addresses) {
  let blocked = false;
  const codes = new Set();
  for (const a of Array.isArray(addresses) ? addresses : []) {
    const m = String(a).match(/^127\.\d{1,3}\.\d{1,3}\.(\d{1,3})$/);
    if (!m) continue;
    const last = Number(m[1]);
    if (last === 1) {
      blocked = true;
      continue;
    }
    for (const l of LISTS) if (l.bit && last & l.bit) codes.add(l.code);
  }
  return { blocked, lists: LISTS.filter((l) => codes.has(l.code)).map((l) => l.code) };
}

const NOT_LISTED = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN']);

/** One domain's standing: clear, listed (with the lists), blocked, or error. */
export async function lookup(domain, resolve = resolve4) {
  try {
    const addrs = await resolve(queryName(domain));
    const { blocked, lists } = decode(addrs);
    return { domain, status: blocked ? 'blocked' : lists.length ? 'listed' : 'clear', lists };
  } catch (err) {
    if (NOT_LISTED.has(err?.code)) return { domain, status: 'clear', lists: [] };
    return { domain, status: 'error', lists: [], error: err?.code ?? String(err?.message ?? err) };
  }
}

export function listItem(l) {
  return {
    externalId: `surbl:list:${l.code}`,
    kind: 'list',
    title: `SURBL ${l.code.toUpperCase()}: ${l.name}`,
    summary: `${l.about}${l.bit ? ` Bit ${l.bit} of the last octet in a multi.surbl.org answer; own zone ${l.zone}.` : ''} Free DNS lookups for fewer than 1,000 users or 250,000 messages a day; the whole list is a paid rsync, RPZ or JSON feed.`,
    url: LISTS_URL,
    publishedAt: CATALOGUE_DATE,
    timeKnown: false,
    precision: 'day',
    tags: ['surbl', 'list', `list:${l.code}`],
    data: {
      code: l.code,
      name: l.name,
      zone: l.zone,
      bit: l.bit,
      multi: ZONE,
      ttlSeconds: 60,
      updates: 'every 30-40 seconds on average',
      access:
        'free DNS query under the usage policy; rsync, RPZ, DNS (PQS) and JSON feeds by subscription',
      attribution: ATTRIBUTION,
    },
  };
}

/**
 * A watched domain's row. `since` is carried over from the previous row
 * while the standing is unchanged, so the row (and its content hash) only
 * moves when the standing does.
 */
export function reputationItem(result, prev, now = new Date()) {
  const same =
    prev &&
    prev.status === result.status &&
    JSON.stringify(prev.lists ?? []) === JSON.stringify(result.lists ?? []);
  const since = same && prev.since ? prev.since : now.toISOString();
  const names = result.lists.map((c) => c.toUpperCase()).join(', ');
  const title =
    result.status === 'listed'
      ? `${result.domain}: listed on SURBL ${names}`
      : result.status === 'clear'
        ? `${result.domain}: not on SURBL`
        : `${result.domain}: SURBL lookup ${result.status}`;
  const summary =
    result.status === 'listed'
      ? `${result.domain} is on the SURBL ${names} list${result.lists.length === 1 ? '' : 's'} (${LISTS.filter(
          (l) => result.lists.includes(l.code),
        )
          .map((l) => l.name.toLowerCase())
          .join(', ')}) as of ${since.slice(0, 16).replace('T', ' ')} UTC.`
      : result.status === 'clear'
        ? `${result.domain} is on none of SURBL’s public lists, and has not been since ${since.slice(0, 10)}.`
        : `The lookup for ${result.domain} did not answer${result.error ? ` (${result.error})` : ''}.`;
  return {
    externalId: `surbl:${result.domain}`,
    kind: 'reputation',
    title,
    summary,
    url: null,
    publishedAt: since,
    tags: [
      'surbl',
      'reputation',
      `status:${result.status}`,
      ...result.lists.map((c) => `list:${c}`),
    ],
    data: {
      domain: result.domain,
      status: result.status,
      lists: result.lists,
      since,
      zone: ZONE,
      query: queryName(result.domain),
      error: result.error ?? null,
      attribution: ATTRIBUTION,
    },
  };
}

/** The config's domains, normalised, deduplicated and capped. */
export function domainsOf(config) {
  const raw = Array.isArray(config?.domains)
    ? config.domains
    : String(config?.domains ?? '').split(/[\s,]+/);
  return [...new Set(raw.map(normaliseDomain).filter(Boolean))].slice(0, MAX_DOMAINS);
}

export const surbl = defineAdapter({
  name: 'surbl',
  title: 'SURBL',
  collection: 'threats',
  description:
    'SURBL’s public URI reputation lists (phishing, malware, abuse, cracked sites, click trackers, disposable mail) as a catalogue, and the domains you name checked against them by DNS every half hour: one row per domain, updated in place when it is listed or cleared, with the lists it is on. Free lookups under SURBL’s usage policy (fewer than 1,000 users or 250,000 messages a day, not for resale); the full lists are only sold as a feed, so a watch list stays small.',
  docs: LISTS_URL,
  kinds: ['list', 'reputation'],
  cadenceMinutes: 30,
  configFields: [
    {
      key: 'domains',
      label: 'Domains to watch',
      type: 'list',
      required: true,
      placeholder: 'example.com, mail.example.org, 203.0.113.5',
      help: 'Hosts or IPv4 addresses, comma separated; a URL is reduced to its host. Keep it to the tens: SURBL’s free service is a lookup, not a download.',
    },
  ],
  defaults: { domains: DEFAULT_DOMAINS },
  defaultSources: [
    {
      slug: 'surbl-watch',
      name: 'SURBL: the lists, and the house domains checked against them',
      description:
        'The six public SURBL lists as surbl.org describes them, and the Profullstack domains looked up in multi.surbl.org every half hour, with test.surbl.org as the always-listed canary. A domain’s row changes only when its standing does.',
      config: { domains: DEFAULT_DOMAINS },
      refresh: true,
    },
  ],
  async pull({ config, previous, log, deadline, resolve = resolve4 }) {
    const domains = domainsOf(config);
    const items = LISTS.map(listItem);
    if (domains.length === 0) {
      log('no domains configured; catalogue only');
      return { items, note: `${LISTS.length} lists, no domains to check` };
    }
    const results = [];
    for (let i = 0; i < domains.length && Date.now() < deadline; i += CONCURRENCY) {
      const batch = domains.slice(i, i + CONCURRENCY);
      results.push(...(await Promise.all(batch.map((d) => lookup(d, resolve)))));
    }
    if (results.some((r) => r.status === 'blocked')) {
      log('SURBL answered 127.0.0.1: this resolver is blocked; no standings written');
      return {
        items,
        note: 'blocked by SURBL (127.0.0.1): over the free query allowance from this resolver; see surbl.org/usage-policy',
        nextInMinutes: 720,
      };
    }
    const prev =
      typeof previous === 'function'
        ? await previous(results.map((r) => `surbl:${r.domain}`))
        : new Map();
    const now = new Date();
    for (const r of results) items.push(reputationItem(r, prev?.get?.(`surbl:${r.domain}`), now));
    const listed = results.filter((r) => r.status === 'listed').length;
    const errors = results.filter((r) => r.status === 'error').length;
    log(
      `${results.length} of ${domains.length} domains checked, ${listed} listed${errors ? `, ${errors} lookups failed` : ''}`,
    );
    return {
      items,
      note: `${LISTS.length} lists; ${results.length} domains checked, ${listed} listed${errors ? `, ${errors} errors` : ''}`,
    };
  },
});
