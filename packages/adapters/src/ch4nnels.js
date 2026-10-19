import { decodeEntities, defineAdapter, slugify } from '@nichedb/core/adapter';

/**
 * Seedbox providers and their plans, from the ch4nnels.com seedbox register.
 *
 * ch4nnels is a house comparison site (IPTV first, seedboxes beside it). Its
 * seedbox register is every commercial seedbox host read from the host's own
 * pricing page: datacenter countries, the apps a box ships, features, payment,
 * refund and trial, and per plan the price as quoted, the monthly price in
 * EUR, storage and disk kind, traffic, port speed and location.
 *
 * `/api/v1/seedboxes` with no filters is the whole register in one keyless,
 * CORS-open document (a few dozen providers, a few hundred plans), so a run
 * reads it once. Each provider becomes a `provider` row and each plan a `plan`
 * row pointing back at it. Unknowns arrive as null and stay null: a plan with
 * no published price has no price here, never zero. `trafficTb: -1` is the
 * register's word for unmetered.
 */

const DEFAULT_URL = 'https://ch4nnels.com/api/v1/seedboxes';
const CHECKS_URL = 'https://ch4nnels.com/api/v1/price-checks';
const PROVIDERS_URL = 'https://ch4nnels.com/api/v1/providers';

/**
 * ch4nnels' updater daemon re-reads every provider's own pricing page daily and says
 * whether the register's prices are still on it: ok, drift (re-check by hand),
 * unverifiable (no prices in the page's HTML) or down. Public and keyless, like the
 * registers; a run that cannot read it carries no verdicts rather than failing.
 */
export async function priceChecks(http, log, url = CHECKS_URL) {
  try {
    const doc = await http.json(url, { timeoutMs: 30_000 });
    const out = new Map();
    for (const c of Array.isArray(doc?.checks) ? doc.checks : []) {
      if (c?.kind && c?.slug && c?.verdict)
        out.set(`${c.kind}:${c.slug}`, {
          verdict: String(c.verdict),
          checkedAt: c.checked_at ?? null,
          pageUrl: urlOrNull(c.page_url),
        });
    }
    return out;
  } catch (err) {
    log(`price checks unreadable: ${String(err?.message ?? err).slice(0, 80)}`);
    return new Map();
  }
}
const VERDICTS = new Set(['ok', 'drift', 'unverifiable', 'down']);
const checkTag = (c) => (c && VERDICTS.has(c.verdict) ? `price:${c.verdict}` : null);

const clean = (s) => {
  const t = decodeEntities(String(s ?? ''))
    .replace(/\s+/g, ' ')
    .trim();
  return t || null;
};
const HTTP = /^https?:\/\//i;
const urlOrNull = (v) => (typeof v === 'string' && HTTP.test(v.trim()) ? v.trim() : null);
const fin = (n) => (Number.isFinite(n) ? n : null);
const strings = (v) => (Array.isArray(v) ? v : []).map(clean).filter(Boolean).slice(0, 40);
const day = (s) => {
  const d = s ? new Date(`${String(s).slice(0, 10)}T00:00:00Z`) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
};
const size = (gb) => (gb >= 1000 ? `${+(gb / 1000).toFixed(1)} TB` : `${gb} GB`);
const SYM = { EUR: '€', USD: '$', GBP: '£' };

/** One provider as the register serves it, or null without a slug and name. */
export function toProvider(p, check = null) {
  const slug = clean(p?.slug);
  const title = clean(p?.name);
  if (!slug || !title) return null;
  const locations = strings(p.locations).map((c) => c.toUpperCase());
  const apps = strings(p.apps).map((a) => a.toLowerCase());
  const features = strings(p.features).map((f) => f.toLowerCase());
  const payments = strings(p.payments).map((f) => f.toLowerCase());
  const plans = Array.isArray(p.plans) ? p.plans : [];
  const unmetered = plans.some((x) => x?.traffic_tb === -1);
  return {
    externalId: `provider:${slug}`,
    kind: 'provider',
    title,
    summary: clean(p.description)?.slice(0, 600) ?? null,
    // The register's page for the provider; the provider's own site is data.website.
    url: urlOrNull(p.page) ?? urlOrNull(p.url),
    publishedAt: day(p.checked_at),
    timeKnown: false,
    precision: 'day',
    tags: [
      'seedbox',
      ...locations.map((c) => `country:${c.toLowerCase()}`),
      ...apps.map((a) => `app:${slugify(a)}`),
      ...features.map((f) => `feature:${slugify(f)}`),
      payments.some((x) => /crypto|bitcoin|btc|usdt|eth|ltc|monero|xmr/.test(x))
        ? 'pay:crypto'
        : null,
      ...payments.filter((x) => x === 'card' || x === 'paypal').map((x) => `pay:${x}`),
      p.trial === true ? 'trial' : null,
      unmetered ? 'unmetered' : null,
      fin(p.max_port_gbps) >= 10 ? '10gbps' : null,
      p.status === 'unverified-pricing' ? 'unverified-pricing' : null,
      checkTag(check),
    ].filter(Boolean),
    data: {
      slug,
      priceCheck: check,
      website: urlOrNull(p.url),
      pricingUrl: urlOrNull(p.pricing_url),
      hq: clean(p.hq),
      locations,
      founded: fin(p.founded),
      apps,
      features,
      payments,
      refund: clean(p.refund),
      trial: typeof p.trial === 'boolean' ? p.trial : null,
      status: clean(p.status),
      checkedAt: clean(p.checked_at),
      fromEurMonthly: fin(p.monthly_eur),
      maxStorageGb: fin(p.max_storage_gb),
      maxPortGbps: fin(p.max_port_gbps),
      plans: plans.length,
      credit: 'ch4nnels.com seedbox register',
    },
  };
}

/** One plan of a provider, or null when it has nothing to name it by. */
export function toPlan(provider, x, i) {
  const slug = clean(provider?.slug);
  const pname = clean(provider?.name);
  const name = clean(x?.name);
  if (!slug || !pname || !name) return null;
  const price = fin(x.price);
  const currency = clean(x.currency)?.toUpperCase() ?? null;
  const storage = fin(x.storage_gb);
  const port = fin(x.port_gbps);
  const traffic = fin(x.traffic_tb);
  const location = clean(x.location)?.toUpperCase() ?? null;
  const type = clean(x.type)?.toLowerCase() ?? null;
  const disk = clean(x.storage_type)?.toLowerCase() ?? null;
  const facts = [
    price !== null
      ? `${SYM[currency] ?? ''}${price}${SYM[currency] ? '' : ` ${currency}`}/mo`
      : 'price not published',
    storage !== null ? `${size(storage)}${disk ? ` ${disk.toUpperCase()}` : ''}` : null,
    port !== null ? `${port} Gbps` : null,
    traffic === -1 ? 'unmetered' : traffic !== null ? `${traffic} TB traffic` : null,
    type,
    location,
  ].filter(Boolean);
  return {
    // The index keeps two plans that share a name (one per location) apart.
    externalId: `plan:${slug}:${slugify(name) || 'plan'}:${i}`,
    kind: 'plan',
    title: `${pname} ${name}`,
    summary: facts.join(', '),
    url: urlOrNull(x.url) ?? urlOrNull(provider.page) ?? urlOrNull(provider.url),
    publishedAt: day(provider.checked_at),
    timeKnown: false,
    precision: 'day',
    tags: [
      'seedbox',
      `provider:${slugify(slug)}`,
      type ? `type:${slugify(type)}` : null,
      disk ? `disk:${disk}` : null,
      location ? `country:${location.toLowerCase()}` : null,
      traffic === -1 ? 'unmetered' : null,
      port !== null && port >= 10 ? '10gbps' : null,
      price === null ? 'unpriced' : null,
    ].filter(Boolean),
    data: {
      provider: slug,
      providerName: pname,
      name,
      type,
      price,
      currency,
      billing: clean(x.billing),
      eurMonthly: fin(x.monthly_eur),
      eurPerTb: fin(x.eur_per_tb),
      storageGb: storage,
      storageType: disk,
      trafficTb: traffic,
      portGbps: port,
      location,
      orderUrl: urlOrNull(x.url),
      credit: 'ch4nnels.com seedbox register',
    },
  };
}

export const ch4nnels = defineAdapter({
  name: 'ch4nnels',
  title: 'ch4nnels seedbox register',
  collection: 'seedboxes',
  description:
    'Every seedbox provider in the ch4nnels.com register with its datacenter countries, apps, features, payment, refund and trial, and every plan with its price, monthly EUR, storage, disk, traffic, port and location, read from the keyless register API once a day.',
  docs: 'https://ch4nnels.com/docs',
  kinds: ['provider', 'plan'],
  cadenceMinutes: 360,
  configFields: [
    {
      key: 'url',
      label: 'Register URL',
      type: 'text',
      required: false,
      help: 'The register document. The whole register comes back when no filter is given.',
    },
  ],
  defaults: { url: DEFAULT_URL },
  defaultSources: [
    {
      slug: 'ch4nnels-seedboxes',
      name: 'Seedboxes: the ch4nnels register',
      config: { url: DEFAULT_URL },
    },
  ],
  async pull({ config, http, log }) {
    const url = urlOrNull(config.url) ?? DEFAULT_URL;
    const doc = await http.json(url, { timeoutMs: 30_000 });
    const providers = Array.isArray(doc?.providers) ? doc.providers : [];
    const checks = await priceChecks(http, log);
    const items = [];
    let plans = 0;
    for (const p of providers) {
      const row = toProvider(p, checks.get(`seedbox:${clean(p?.slug)}`) ?? null);
      if (!row) continue;
      items.push(row);
      (Array.isArray(p.plans) ? p.plans : []).forEach((x, i) => {
        const plan = toPlan(p, x, i);
        if (plan) {
          items.push(plan);
          plans++;
        }
      });
    }
    const note = `${items.length - plans} providers, ${plans} plans`;
    log(note);
    return { items, note };
  },
});

/**
 * IPTV and live-TV services, from the ch4nnels.com provider register: the same keyless,
 * public document the site's /providers page and API serve (37 services read from their
 * own pricing pages). Nothing private is read: no orders, customers or reseller data,
 * only the register. ArgonTV is the one ch4nnels resells; that is public and kept as
 * data.resoldByCh4nnels so a reader can weigh it.
 */
const months = (n) => (n === 1 ? '1 month' : `${n} months`);

export function toIptvProvider(p, check = null) {
  const slug = clean(p?.slug);
  const title = clean(p?.name);
  if (!slug || !title) return null;
  const countries = strings(p.countries).map((c) => c.toUpperCase());
  const payment = strings(p.payment).map((x) => x.toLowerCase());
  const apps = strings(p.apps).map((a) => a.toLowerCase());
  const kind = clean(p.kind)?.toLowerCase() ?? null;
  const res = clean(p.max_resolution)?.toUpperCase() ?? null;
  return {
    externalId: `iptv:${slug}`,
    kind: 'provider',
    title,
    summary: clean(p.notes)?.slice(0, 600) ?? null,
    url: urlOrNull(p.page) ?? urlOrNull(p.url),
    publishedAt: day(p.checked_at),
    timeKnown: false,
    precision: 'day',
    tags: [
      'iptv',
      kind ? `kind:${kind}` : null,
      ...countries.map((c) => `country:${c.toLowerCase()}`),
      ...payment.map((x) => `pay:${slugify(x)}`),
      res ? `max:${res.toLowerCase()}` : null,
      p.trial ? 'trial' : null,
      p.epg === true ? 'epg' : null,
      p.catchup === true ? 'catchup' : null,
      checkTag(check),
    ].filter(Boolean),
    data: {
      slug,
      kind,
      website: urlOrNull(p.url),
      pricingUrl: urlOrNull(p.pricing_url),
      countries,
      channels: fin(p.channels),
      vod: fin(p.vod),
      maxConnections: fin(p.max_connections),
      maxResolution: res,
      trial: clean(p.trial),
      epg: typeof p.epg === 'boolean' ? p.epg : null,
      catchup: typeof p.catchup === 'boolean' ? p.catchup : null,
      payment,
      apps,
      sports: clean(p.sports),
      fromEurMonthly: fin(p.monthly_eur),
      monthToMonthEur: fin(p.from_eur),
      plans: Array.isArray(p.plans) ? p.plans.length : 0,
      checkedAt: clean(p.checked_at),
      priceCheck: check,
      resoldByCh4nnels: p.featured === true,
      credit: 'ch4nnels.com IPTV register',
    },
  };
}

export function toIptvPlan(p, x, i) {
  const slug = clean(p?.slug);
  const pname = clean(p?.name);
  const m = fin(x?.months);
  if (!slug || !pname || !m) return null;
  const price = fin(x.price);
  const currency = clean(x.currency)?.toUpperCase() ?? null;
  const name = clean(x.name) ?? months(m);
  return {
    externalId: `iptv-plan:${slug}:${m}:${i}`,
    kind: 'plan',
    title: `${pname} ${name}`,
    summary: [
      price !== null
        ? `${SYM[currency] ?? ''}${price}${SYM[currency] ? '' : ` ${currency}`} for ${months(m)}`
        : 'price not published',
      fin(x.monthly_eur) !== null ? `€${x.monthly_eur.toFixed(2)}/mo` : null,
      fin(x.connections) ? `${x.connections} devices` : null,
    ]
      .filter(Boolean)
      .join(', '),
    url: urlOrNull(p.page) ?? urlOrNull(p.url),
    publishedAt: day(p.checked_at),
    timeKnown: false,
    precision: 'day',
    tags: [
      'iptv',
      `provider:${slugify(slug)}`,
      `months:${m}`,
      price === null ? 'unpriced' : null,
    ].filter(Boolean),
    data: {
      provider: slug,
      providerName: pname,
      name,
      months: m,
      price,
      currency,
      priceEur: fin(x.price_eur),
      eurMonthly: fin(x.monthly_eur),
      connections: fin(x.connections),
      credit: 'ch4nnels.com IPTV register',
    },
  };
}

export const ch4nnelsIptv = defineAdapter({
  name: 'ch4nnels-iptv',
  title: 'ch4nnels IPTV register',
  collection: 'iptv',
  description:
    'Every IPTV and live-TV service in the ch4nnels.com register with its countries, channel and VOD counts, devices, max resolution, trial, EPG, catch-up, payment and apps, and every plan with its price, length, monthly EUR and devices, plus the daily check of the provider’s own pricing page (ok, drift, unverifiable, down). Read from the keyless public register once every six hours.',
  docs: 'https://ch4nnels.com/docs',
  kinds: ['provider', 'plan'],
  cadenceMinutes: 360,
  configFields: [
    {
      key: 'url',
      label: 'Register URL',
      type: 'text',
      required: false,
      help: 'The public provider register.',
    },
  ],
  defaults: { url: PROVIDERS_URL },
  defaultSources: [
    {
      slug: 'ch4nnels-iptv-providers',
      name: 'IPTV: the ch4nnels register',
      config: { url: PROVIDERS_URL },
    },
  ],
  async pull({ config, http, log }) {
    const url = urlOrNull(config.url) ?? PROVIDERS_URL;
    const doc = await http.json(url, { timeoutMs: 30_000 });
    const providers = Array.isArray(doc?.providers) ? doc.providers : [];
    const checks = await priceChecks(http, log);
    const items = [];
    let plans = 0;
    for (const p of providers) {
      const row = toIptvProvider(p, checks.get(`iptv:${clean(p?.slug)}`) ?? null);
      if (!row) continue;
      items.push(row);
      (Array.isArray(p.plans) ? p.plans : []).forEach((x, i) => {
        const plan = toIptvPlan(p, x, i);
        if (plan) {
          items.push(plan);
          plans++;
        }
      });
    }
    const note = `${items.length - plans} providers, ${plans} plans`;
    log(note);
    return { items, note };
  },
});
