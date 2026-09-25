import { domainToUnicode } from 'node:url';

/**
 * Where the top-level domain data comes from, and how each upstream is read.
 *
 * Three IANA files make the record (OpenTLD's "top-level domain record"):
 * the list itself, the root zone database for type and manager, and the RDAP
 * bootstrap for the server that answers "is this name taken". Then one reader
 * per registrar, each turning that registrar's own price list into OpenTLD
 * price rows: one year, the registrar's currency, `renew` beside `register`.
 * Every parser here is a pure function of the upstream's body, so the tests
 * hold a sample of each and no network.
 */

export const IANA_LIST_URL = 'https://data.iana.org/TLD/tlds-alpha-by-domain.txt';
export const IANA_ROOT_DB_URL = 'https://www.iana.org/domains/root/db';
export const IANA_RDAP_URL = 'https://data.iana.org/rdap/dns.json';

/* ------------------------------------------------------------------ IANA -- */

/**
 * `# Version 2026092500, Last Updated Fri Sep 25 07:07:01 2026 UTC` then one
 * upper-case label per line. The version is the only change signal IANA gives.
 */
export function parseTldList(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const head = lines[0]?.startsWith('#') ? lines[0] : '';
  const version = head.match(/Version\s+(\d+)/i)?.[1] ?? null;
  const updated = head.match(/Last Updated\s+(.+)$/i)?.[1]?.trim() ?? null;
  const labels = [];
  for (const line of lines) {
    const l = line.trim().toLowerCase();
    if (!l || l.startsWith('#')) continue;
    if (!/^[a-z0-9-]+$/.test(l)) continue;
    labels.push(l);
  }
  return { version, updated, labels: [...new Set(labels)] };
}

/** `xn--p1ai` → `рф`; anything else → null, so a plain label carries no copy of itself. */
export function unicodeOf(tld) {
  if (!tld?.startsWith('xn--')) return null;
  const u = domainToUnicode(tld);
  return u && u !== tld ? u : null;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export const decodeEntities = (s) =>
  String(s ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();

/**
 * The root zone database page: one table row per label with its type and
 * manager. The link, not the text, carries the ASCII label: an IDN row shows
 * `.рф` and links to `xn--p1ai.html`. "Not assigned" is IANA's word for a
 * retired label, kept as the manager so a reader sees it.
 */
export function parseRootDb(html) {
  const out = [];
  const re =
    /href="\/domains\/root\/db\/([^"/]+)\.html"[^>]*>[\s\S]*?<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>/g;
  for (const m of String(html ?? '').matchAll(re)) {
    const tld = decodeURIComponent(m[1]).toLowerCase();
    if (!/^[a-z0-9-]+$/.test(tld)) continue;
    out.push({ tld, type: decodeEntities(m[2]) || null, manager: decodeEntities(m[3]) || null });
  }
  return out;
}

/** RFC 9224 bootstrap: `services: [[labels], [urls]]`. The https URL wins, always with a trailing slash. */
export function parseRdapBootstrap(json) {
  const out = [];
  for (const [labels, urls] of json?.services ?? []) {
    const url = (urls ?? []).find((u) => u.startsWith('https://')) ?? urls?.[0];
    if (!url) continue;
    const base = url.endsWith('/') ? url : `${url}/`;
    for (const l of labels ?? []) out.push({ tld: String(l).toLowerCase(), rdap: base });
  }
  return out;
}

/**
 * Today's list against what is held. A first read is a baseline. A list
 * much shorter than what is held is a broken download, not a mass
 * retirement, and is refused (OpenTLD, directory rule 4).
 */
export function diffList(held, labels, { minRatio = 0.9 } = {}) {
  const now = new Set(labels);
  const byTld = new Map(held.map((r) => [r.tld, r.status]));
  const delegated = held.filter((r) => r.status === 'delegated').length;
  if (delegated > 0 && labels.length < delegated * minRatio) {
    throw new Error(
      `IANA list has ${labels.length} labels against ${delegated} held; refusing it as a short download`,
    );
  }
  const added = [];
  const returned = [];
  const removed = [];
  for (const l of labels) {
    const s = byTld.get(l);
    if (s === undefined) added.push(l);
    else if (s === 'removed') returned.push(l);
  }
  for (const [tld, status] of byTld) if (status === 'delegated' && !now.has(tld)) removed.push(tld);
  return { added, returned, removed, baseline: held.length === 0 };
}

/* ------------------------------------------------------------ registrars -- */

const money = (v) => {
  if (v === null || v === undefined) return null;
  const n = Number(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) && n >= 0 && String(v).trim() !== '-1' && String(v).trim() !== ''
    ? Math.round(n * 100) / 100
    : null;
};
const label = (t) =>
  String(t ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\./, '');

/** Porkbun's keyless pricing endpoint. Coupons are codes, not prices, so they ride in `extra`. */
export function parsePorkbun(json) {
  const out = [];
  for (const [tld, p] of Object.entries(json?.pricing ?? {})) {
    out.push({
      tld: label(tld),
      currency: 'USD',
      register: money(p.registration),
      renew: money(p.renewal),
      transfer: money(p.transfer),
      privacy: 'included',
      url: `https://porkbun.com/tld/${label(tld)}`,
      extra: p.coupons?.length ? { coupons: p.coupons } : {},
    });
  }
  return out;
}

/**
 * Dynadot's price page is a Nuxt app, and its data is the `__NUXT_DATA__`
 * payload: devalue's flat array in which every object's values are indexes
 * into the same array. Resolve it, then take every object that has both a
 * `name` and a `reg_price`. `original_*` is "-1" unless the shown price is a
 * sale, in which case it is the regular price and the shown one is `promo`.
 *
 * The page is not always in dollars. The same URL, from the same box, came
 * back in USD and then, an hour later and on every retry, in CNY: `$10.88`
 * became `¥73.80`, and a parser that assumed dollars stored seventy-three of
 * them for a .com. The currency is read from each row (its `google_data`
 * says it, or failing that the price's symbol), a page that mixes currencies or uses
 * one it cannot name is refused, and prices are kept in whatever currency
 * Dynadot chose, never converted.
 */
const SYMBOLS = { $: 'USD', '¥': 'CNY', '€': 'EUR', '£': 'GBP', '₹': 'INR', R$: 'BRL', Rp: 'IDR' };
export function currencyOfPrice(v) {
  const s = String(v ?? '').trim();
  for (const [sym, code] of Object.entries(SYMBOLS).sort((a, b) => b[0].length - a[0].length))
    if (s.startsWith(sym)) return code;
  return null;
}

export function parseDynadot(html) {
  const m = String(html ?? '').match(/<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('Dynadot page has no __NUXT_DATA__ payload');
  const arr = JSON.parse(m[1]);
  const WRAP = new Set([
    'ShallowReactive',
    'Reactive',
    'Ref',
    'ShallowRef',
    'EmptyRef',
    'EmptyShallowRef',
  ]);
  const memo = new Map();
  const resolve = (i) => {
    if (typeof i !== 'number' || i < 0 || i >= arr.length) return null;
    if (memo.has(i)) return memo.get(i);
    const v = arr[i];
    let out;
    if (Array.isArray(v)) {
      if (typeof v[0] === 'string' && WRAP.has(v[0])) {
        memo.set(i, null);
        out = resolve(v[1]);
      } else {
        out = [];
        memo.set(i, out);
        for (const x of v) out.push(resolve(x));
      }
    } else if (v && typeof v === 'object') {
      out = {};
      memo.set(i, out);
      for (const [k, x] of Object.entries(v)) out[k] = resolve(x);
    } else out = v;
    memo.set(i, out);
    return out;
  };
  const rows = new Map();
  const seen = new Set();
  const currencies = new Set();
  const walk = (o) => {
    if (!o || typeof o !== 'object' || seen.has(o)) return;
    seen.add(o);
    if (!Array.isArray(o) && typeof o.name === 'string' && 'reg_price' in o) {
      const tld = label(o.name);
      const declared = String(o.google_data?.currency ?? '').toUpperCase() || null;
      const shown = currencyOfPrice(o.reg_price) ?? currencyOfPrice(o.renew_price);
      const currency = declared ?? shown;
      if (!currency) throw new Error(`Dynadot .${tld} has no currency: ${o.reg_price}`);
      currencies.add(currency);
      const reg = money(o.reg_price);
      const regularReg = money(o.original_reg_price);
      const ren = money(o.renew_price);
      const regularRen = money(o.original_renew_price);
      const promo = {};
      if (regularReg !== null && reg !== null && reg < regularReg) promo.register = reg;
      if (regularRen !== null && ren !== null && ren < regularRen) promo.renew = ren;
      rows.set(tld, {
        tld,
        currency,
        register: regularReg ?? reg,
        renew: regularRen ?? ren,
        transfer: money(o.tr_price),
        restore: money(o.restore),
        promo: Object.keys(promo).length ? promo : null,
        privacy: o.privacy === 'Yes' ? 'included' : o.privacy === 'No' ? 'unavailable' : null,
        idn: o.idn === 'Yes' ? true : o.idn === 'No' ? false : null,
        restrictions: o.restrictions && o.restrictions !== '-' ? String(o.restrictions) : null,
        extra: {
          ...(o.usage ? { usage: o.usage } : {}),
          ...(o.grace_period ? { grace_days: Number(o.grace_period) } : {}),
          ...(o.google_data?.brand ? { registry: o.google_data.brand } : {}),
        },
      });
    }
    for (const v of Array.isArray(o) ? o : Object.values(o)) walk(v);
  };
  walk(resolve(0));
  if (currencies.size > 1)
    throw new Error(`Dynadot page mixes currencies: ${[...currencies].join(', ')}`);
  return [...rows.values()];
}

/**
 * Cloudflare Registrar sells at cost with no markup, so registration and
 * renewal are the same number, and a transfer in is charged as one year's
 * renewal. Cloudflare publishes no keyless list; cfdomainpricing.com mirrors
 * it daily as MIT-licensed JSON, and the date it last saw each price is kept.
 */
export function parseCloudflare(json) {
  const out = [];
  for (const [tld, p] of Object.entries(json ?? {})) {
    if (!p || typeof p !== 'object') continue;
    const renew = money(p.renewal);
    out.push({
      tld: label(tld),
      currency: 'USD',
      register: money(p.registration),
      renew,
      transfer: renew,
      privacy: 'included',
      extra: p.updatedAt ? { mirrored_at: p.updatedAt } : {},
    });
  }
  return out;
}

/**
 * OVHcloud's public order catalogue, one plan per label, each price in
 * hundred-millionths of the currency and before VAT. Second-level plans
 * (`co.uk`, `com.fr`) are not top-level domains and are skipped. A create's
 * phase 0 is the first year and phase 1 the renewal; a restore's phase 1 is
 * the redemption fee with its year.
 */
export function parseOvh(json) {
  const currency = json?.locale?.currencyCode ?? 'EUR';
  const out = [];
  for (const plan of json?.plans ?? []) {
    const tld = label(plan.planCode);
    if (!/^[a-z0-9-]+$/.test(tld)) continue;
    const find = (mode, phase) => {
      const p = (plan.pricings ?? []).find((x) => x.mode === mode && x.phase === phase);
      return p && Number(p.price) > 0 && Number(p.price) < 9e13
        ? Math.round(Number(p.price) / 1e6) / 100
        : null;
    };
    const register = find('create-default', 0);
    const renew = find('create-default', 1);
    if (register === null && renew === null) continue;
    out.push({
      tld,
      currency,
      register,
      renew,
      transfer: find('transfer-default', 0),
      restore: find('restore-default', 1),
      url: `https://www.ovhcloud.com/en-ie/domains/tld/${tld}/`,
      extra: { tax: 'excluded' },
    });
  }
  return out;
}

/**
 * An OpenTLD price list, as a registrar serves it at /.well-known/opentld.json.
 * The reader for every registrar that publishes its own; the four above are
 * this directory's reading of registrars that do not yet.
 */
export function parseOpenTld(json) {
  const currency = String(json?.currency ?? '').toUpperCase();
  if (!json?.registrar?.name || !currency) throw new Error('not an OpenTLD price list');
  const out = new Map();
  for (const p of json.prices ?? []) {
    const tld = label(p.tld);
    if (!/^[a-z0-9-]+$/.test(tld)) continue;
    const promo =
      p.promo && (!p.promo.ends || Date.parse(p.promo.ends) > Date.now()) ? p.promo : null;
    out.set(tld, {
      tld,
      currency,
      register: money(p.register),
      renew: money(p.renew),
      transfer: money(p.transfer),
      restore: money(p.restore),
      promo,
      privacy: p.privacy ?? null,
      idn: typeof p.idn === 'boolean' ? p.idn : null,
      premium: p.premium ?? null,
      restrictions: p.restrictions ?? null,
      url: p.url ?? null,
      extra: {},
    });
  }
  return { registrar: json.registrar, rows: [...out.values()] };
}

/**
 * The registrars read every day. `read(http)` returns OpenTLD price rows.
 * A new keyless registrar is one entry here; a registrar that serves its own
 * OpenTLD file needs no entry at all (config `tlds.openTldUrls`).
 */
export const REGISTRARS = [
  {
    slug: 'porkbun',
    name: 'Porkbun',
    web: 'https://porkbun.com',
    sourceUrl: 'https://api.porkbun.com/api/json/v3/pricing/get',
    sourceKind: 'api',
    currency: 'USD',
    attribution: "Porkbun's public pricing API",
    read: async (http) =>
      parsePorkbun(
        await http.json('https://api.porkbun.com/api/json/v3/pricing/get', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
          timeoutMs: 60_000,
        }),
      ),
  },
  {
    slug: 'dynadot',
    name: 'Dynadot',
    web: 'https://www.dynadot.com',
    sourceUrl: 'https://www.dynadot.com/domain/prices',
    sourceKind: 'page',
    currency: 'USD',
    attribution: "Dynadot's public price page",
    read: async (http) =>
      parseDynadot(
        await http.text('https://www.dynadot.com/domain/prices', {
          headers: { accept: 'text/html' },
          timeoutMs: 60_000,
        }),
      ),
  },
  {
    slug: 'cloudflare',
    name: 'Cloudflare',
    web: 'https://www.cloudflare.com/products/registrar/',
    sourceUrl: 'https://cfdomainpricing.com/prices.json',
    sourceKind: 'mirror',
    currency: 'USD',
    attribution: 'Cloudflare at-cost prices, mirrored by cfdomainpricing.com (MIT)',
    read: async (http) =>
      parseCloudflare(
        await http.json('https://cfdomainpricing.com/prices.json', { timeoutMs: 60_000 }),
      ),
  },
  {
    slug: 'ovh',
    name: 'OVHcloud',
    web: 'https://www.ovhcloud.com',
    sourceUrl: 'https://eu.api.ovh.com/1.0/order/catalog/public/domain?ovhSubsidiary=IE',
    sourceKind: 'api',
    currency: 'EUR',
    attribution: "OVHcloud's public order catalogue (Ireland, EUR, before VAT)",
    read: async (http) =>
      parseOvh(
        await http.json('https://eu.api.ovh.com/1.0/order/catalog/public/domain?ovhSubsidiary=IE', {
          timeoutMs: 180_000,
        }),
      ),
  },
];

/** A registrar from its own OpenTLD file. The slug is its host, so two files never collide. */
export function openTldRegistrar(url) {
  const host = new URL(url).hostname.replace(/^www\./, '');
  return {
    slug: host.replace(/[^a-z0-9]+/g, '-'),
    name: host,
    web: new URL(url).origin,
    sourceUrl: url,
    sourceKind: 'opentld',
    currency: null,
    attribution: `${host}'s own OpenTLD price list`,
    opentld: true,
    read: async (http) => {
      const { registrar, rows } = parseOpenTld(await http.json(url, { timeoutMs: 60_000 }));
      return Object.assign(rows, { registrar });
    },
  };
}
