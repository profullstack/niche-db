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
export function toProvider(p) {
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
    ].filter(Boolean),
    data: {
      slug,
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
  cadenceMinutes: 1440,
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
    const items = [];
    let plans = 0;
    for (const p of providers) {
      const row = toProvider(p);
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
