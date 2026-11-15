import { defineAdapter } from '@nichedb/core/adapter';
import { num, offer, offerItem, retireOffer } from './hosting.js';

/**
 * OVHcloud dedicated servers, Kimsufi and So you Start included, from the
 * public order catalogues the order funnels read.
 *
 * `/1.0/order/catalog/public/eco` is the budget lines (Kimsufi, So you
 * Start, Rise) and `/1.0/order/catalog/public/baremetalServers` the rest
 * (Advance, Scale, High Grade, Game, GPU), both keyless, per subsidiary. A
 * server plan is sold as a chassis plus MANDATORY add-on families -- memory,
 * storage, bandwidth, sometimes vRack and GPU -- each with a `default`
 * add-on, so the price of the box as it is first offered is the plan's
 * monthly renewal plus each mandatory family's default add-on renewal, and
 * the specs (RAM, disks, port speed, GPU) are read off those default add-ons'
 * own product blobs. Commitment and upfront variants are left out: the price
 * is month to month.
 *
 * Kimsufi and So you Start are OVH brands with their own sites and shops, so
 * their plans carry their own provider slugs (`kimsufi`, `soyoustart`); the
 * rest is `ovh`, the same company as the `ovh-vps` plans.
 *
 * STOCK comes from `/1.0/dedicated/server/datacenter/availabilities` (keyless,
 * every configuration in every datacentre with a delivery time or
 * `unavailable`). A plan deliverable anywhere is `in_stock`; listed but
 * unavailable everywhere is `out_of_stock`; the datacentres that can deliver
 * are kept. Both catalogues are read whole, so a plan OVH stops selling is
 * retired.
 *
 * OVH Public Cloud (`/cloud`) is per-hour cloud and deliberately not read.
 */
export const SUBSIDIARIES = {
  US: { api: 'https://api.us.ovhcloud.com', currency: 'USD' },
  FR: { api: 'https://eu.api.ovh.com', currency: 'EUR' },
};
export const CATALOGS = ['eco', 'baremetalServers'];

export const BRANDS = {
  kimsufi: { provider: 'kimsufi', name: 'Kimsufi', url: 'https://www.kimsufi.com/' },
  soyoustart: { provider: 'soyoustart', name: 'So you Start', url: 'https://www.soyoustart.com/' },
};
const OVH = { provider: 'ovh', name: 'OVHcloud', url: 'https://www.ovhcloud.com/en/bare-metal/' };

const DC_COUNTRY = {
  gra: 'FR',
  sbg: 'FR',
  rbx: 'FR',
  par: 'FR',
  fra: 'DE',
  lim: 'DE',
  lon: 'GB',
  eri: 'GB',
  waw: 'PL',
  bhs: 'CA',
  tor: 'CA',
  vin: 'US',
  hil: 'US',
  sgp: 'SG',
  syd: 'AU',
  ynm: 'IN',
  mum: 'IN',
};
export const dcCountry = (dc) => {
  const d = String(dc ?? '').toLowerCase();
  if (d.startsWith('eu-west-par')) return 'FR';
  return DC_COUNTRY[d.slice(0, 3)] ?? null;
};

const units = (price) => Math.round(Number(price) / 1e6) / 100;

/** The month-to-month renewal price of a plan or add-on, or null. */
export function monthly(plan) {
  const p = (plan?.pricings ?? []).find(
    (x) =>
      (x.capacities ?? []).includes('renew') &&
      x.intervalUnit === 'month' &&
      x.interval === 1 &&
      (Number(x.commitment) || 0) === 0 &&
      (x.mode ?? 'default') === 'default',
  );
  return p ? units(p.price) : null;
}

/** The one-time installation fee, or null. */
export function setupFee(plan) {
  const p = (plan?.pricings ?? []).find(
    (x) => (x.capacities ?? []).includes('installation') && (x.mode ?? 'default') === 'default',
  );
  return p ? units(p.price) : null;
}

const technical = (product) => product?.blobs?.technical ?? {};

/** Disks off a storage add-on blob, as OpenServer storage entries. */
export function disksOf(storageBlob) {
  return (storageBlob?.disks ?? []).flatMap((d) =>
    Array.from({ length: num(d.number) ?? 1 }, () => ({
      type: /nvme/i.test(d.interface ?? '')
        ? 'nvme'
        : /hdd/i.test(d.technology ?? '')
          ? 'hdd'
          : 'ssd',
      size_gb: num(d.capacity),
    })),
  );
}

/** "2x NVIDIA L40S 48GB" -> { model, count, vramMb } */
export function gpuOf(text) {
  const m = String(text ?? '').match(/^(\d+)\s*x\s*(.+?)(?:\s+(\d+)\s*GB)?$/i);
  if (!m) return text ? { model: String(text), count: 1, vramMb: null } : null;
  return { model: m[2].trim(), count: Number(m[1]), vramMb: m[3] ? Number(m[3]) * 1024 : null };
}

/** Per plan code: the datacentres that can deliver now, from the availabilities list. */
export function availabilityByPlan(rows) {
  const out = new Map();
  for (const r of rows ?? []) {
    if (!r?.planCode) continue;
    const have = out.get(r.planCode) ?? new Set();
    for (const d of r.datacenters ?? [])
      if (d.availability && !/unavailable|comingsoon/i.test(d.availability)) have.add(d.datacenter);
    out.set(r.planCode, have);
  }
  return out;
}

/** One server plan as an item, or null for anything that is not a priced server. */
export function toItem(plan, { products, addons, locale, availability = null }) {
  const product = products.get(plan?.product);
  const server = technical(product).server;
  if (!plan?.planCode || !server?.cpu) return null;
  const base = monthly(plan);
  if (base === null) return null;
  let price = base;
  let setup = setupFee(plan) ?? 0;
  let ramGb = null;
  let storage = [];
  let bandwidth = null;
  let gpu = null;
  const chosen = {};
  for (const fam of plan.addonFamilies ?? []) {
    if (!fam.mandatory) continue;
    const code = fam.default ?? fam.addons?.[0];
    const addon = addons.get(code);
    if (!addon) continue;
    chosen[fam.name] = code;
    price += monthly(addon) ?? 0;
    setup += setupFee(addon) ?? 0;
    const t = technical(products.get(addon.product));
    if (t.memory?.size) ramGb = num(t.memory.size);
    if (t.storage) storage = disksOf(t.storage);
    if (t.bandwidth?.level) bandwidth = num(t.bandwidth.level);
    if (fam.name === 'gpu' || t.gpu) gpu = gpuOf(products.get(addon.product)?.description);
  }
  const range = String(server.range ?? '').toLowerCase();
  const brand = BRANDS[range] ?? OVH;
  const dcs =
    (plan.configurations ?? []).find((c) => c.name === 'dedicated_datacenter')?.values ?? [];
  const deliverable = availability?.get(plan.planCode);
  const subsidiary = locale?.subsidiary ?? 'US';
  const cpu = [server.cpu.brand, server.cpu.model].filter(Boolean).join(' ');
  const o = offer({
    id: `${subsidiary}:${plan.planCode}`,
    name: plan.invoiceName ?? plan.planCode,
    url: brand.url,
    kind: gpu ? 'gpu' : 'dedicated',
    tenancy: 'dedicated',
    regions: dcs,
    countries: dcs.map(dcCountry).filter(Boolean),
    vcpu: num(server.cpu.threads),
    cores:
      num(server.cpu.cores) && num(server.cpu.number)
        ? num(server.cpu.cores) * num(server.cpu.number)
        : num(server.cpu.cores),
    ramMb: ramGb ? ramGb * 1024 : null,
    arch: /ampere|arm/i.test(cpu) ? 'arm64' : 'x86_64',
    gpu,
    storage,
    bandwidthMbps: bandwidth,
    ipv4: true,
    ipv6: true,
    amount: Math.round(price * 100) / 100,
    currency: locale?.currencyCode ?? SUBSIDIARIES[subsidiary]?.currency ?? 'USD',
    interval: 'month',
    setup: Math.round(setup * 100) / 100,
    commitment: 0,
    stock: deliverable ? (deliverable.size ? 'in_stock' : 'out_of_stock') : 'unknown',
  });
  return offerItem({
    provider: brand.provider,
    providerName: brand.name,
    offer: o,
    extraTags: [`subsidiary:${subsidiary.toLowerCase()}`, range ? `range:${range}` : null].filter(
      Boolean,
    ),
    extra: {
      planCode: plan.planCode,
      range: range || null,
      cpu,
      cpuScore: num(server.cpu.score),
      defaultAddons: chosen,
      chassisMonthly: base,
      deliverableIn: deliverable ? [...deliverable] : null,
      subsidiary,
    },
    raw: { plan: { ...plan, pricings: undefined }, product: product ?? null },
  });
}

export function parseCatalog(catalog, availability = null, seen = new Set()) {
  const products = new Map((catalog?.products ?? []).map((p) => [p.name, p]));
  const addons = new Map((catalog?.addons ?? []).map((a) => [a.planCode, a]));
  const items = [];
  for (const plan of catalog?.plans ?? []) {
    if (seen.has(plan.planCode)) continue;
    const item = toItem(plan, { products, addons, locale: catalog?.locale, availability });
    if (!item) continue;
    seen.add(plan.planCode);
    items.push(item);
  }
  return items;
}

export const ovhDedicated = defineAdapter({
  name: 'ovh-dedicated',
  title: 'OVHcloud, Kimsufi and So you Start dedicated servers',
  collection: 'hosting',
  description:
    'Every OVHcloud bare-metal plan (Advance, Scale, High Grade, Game, GPU) and every Kimsufi, So you Start and Rise server as an OpenServer offer: CPU, cores and threads, RAM, disks, port speed and GPU of the default configuration, its month-to-month price with the mandatory add-ons, setup fee, the datacentres it is sold in and live stock. Read daily from the public order catalogues and the datacentre availability list. Keyless.',
  docs: 'https://eu.api.ovh.com/console/?section=%2Forder&branch=v1#get-/order/catalog/public/eco',
  kinds: ['plan'],
  cadenceMinutes: 1440,
  budgetMs: 8 * 60_000,
  configFields: [
    {
      key: 'subsidiary',
      label: 'Subsidiary',
      type: 'select',
      options: Object.keys(SUBSIDIARIES),
      help: 'US bills USD from api.us.ovhcloud.com; FR bills EUR from eu.api.ovh.com.',
    },
  ],
  defaults: { subsidiary: 'US' },
  defaultSources: [
    {
      slug: 'ovh-dedicated-us',
      name: 'Hosting: OVHcloud / Kimsufi / So you Start dedicated (US, USD)',
      config: { subsidiary: 'US' },
    },
    {
      slug: 'ovh-dedicated-eu',
      name: 'Hosting: OVHcloud / Kimsufi / So you Start dedicated (EU, EUR)',
      config: { subsidiary: 'FR' },
    },
  ],
  retire: retireOffer,
  async pull({ config, http, log }) {
    const subsidiary = SUBSIDIARIES[config.subsidiary] ? config.subsidiary : 'US';
    const { api } = SUBSIDIARIES[subsidiary];
    let availability = null;
    try {
      availability = availabilityByPlan(
        await http.json(`${api}/1.0/dedicated/server/datacenter/availabilities`, {
          timeoutMs: 120_000,
        }),
      );
    } catch (err) {
      log(`availabilities failed, stock stays unknown: ${err.message.slice(0, 60)}`);
    }
    const items = [];
    // A plan code both catalogues list (the Rise line does, in FR) is one row.
    const seen = new Set();
    let complete = true;
    for (const name of CATALOGS) {
      try {
        const catalog = await http.json(
          `${api}/1.0/order/catalog/public/${name}?ovhSubsidiary=${subsidiary}`,
          { timeoutMs: 180_000 },
        );
        const got = parseCatalog(catalog, availability, seen);
        log(`${name}: ${got.length} servers of ${catalog?.plans?.length ?? 0} plans`);
        items.push(...got);
      } catch (err) {
        complete = false;
        log(`${name} failed: ${err.message.slice(0, 80)}`);
      }
    }
    const note = `${items.length} dedicated servers (${subsidiary})${complete ? '' : ', a catalogue failed'}`;
    return { items, note, complete: complete && items.length > 0 };
  },
});
