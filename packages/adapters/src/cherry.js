import { defineAdapter } from '@nichedb/core/adapter';
import { num, offer, offerItem, retireOffer } from './hosting.js';

/**
 * Cherry Servers' plans: bare metal, VPS and VDS, from the keyless
 * `GET https://api.cherryservers.com/v1/plans`.
 *
 * Each plan carries its CPU, memory, disks, port and bandwidth as written on
 * the order page, a pricing list (Monthly, Quarterly, ..., Hourly, Spot
 * hourly) in EUR excluding VAT, and `available_regions` with a live
 * `stock_qty` per region. The monthly price is the offer's price; a plan with
 * stock in any region is `in_stock`, listed with zero everywhere is
 * `out_of_stock`, and the regions with stock are kept. The list is read whole,
 * so a plan Cherry withdraws is retired.
 */
export const PLANS_URL = 'https://api.cherryservers.com/v1/plans';
export const PROVIDER = 'cherry-servers';

const KIND = {
  baremetal: 'dedicated',
  vps: 'vps',
  vds: 'vps',
  'arm-vds': 'vps',
  'storage-vps': 'vps',
  'premium-vds': 'vps',
  'performance-vds': 'vps',
};

const priceOf = (plan, unit) =>
  num((plan.pricing ?? []).find((p) => String(p.unit).toLowerCase() === unit)?.price);

/** "30TB" / "Unmetered" / "1000GB" to GB, or null. */
export function transferGb(name) {
  const m = String(name ?? '').match(/([\d.]+)\s*(TB|GB)/i);
  if (!m) return null;
  return Math.round(Number(m[1]) * (m[2].toUpperCase() === 'TB' ? 1000 : 1));
}

/** "1Gbps" / "10 Gbps" / "500Mbps" to Mbps, or null. */
export function portMbps(name) {
  const m = String(name ?? '').match(/([\d.]+)\s*(G|M)bps/i);
  if (!m) return null;
  return Math.round(Number(m[1]) * (m[2].toUpperCase() === 'G' ? 1000 : 1));
}

export function toItem(p) {
  if (!p?.slug) return null;
  const amount = priceOf(p, 'monthly');
  const hourly = priceOf(p, 'hourly');
  if (amount === null && hourly === null) return null;
  const s = p.specs ?? {};
  const regions = p.available_regions ?? [];
  const inStock = regions.filter((r) => num(r.stock_qty) > 0);
  const kind = KIND[p.type] ?? (p.type === 'baremetal' ? 'dedicated' : 'vps');
  const gpu = s.gpus?.count ? { model: s.gpus.name ?? null, count: s.gpus.count } : null;
  const cpuName = s.cpus?.name ?? '';
  const o = offer({
    id: p.slug,
    name: p.title ?? p.name ?? p.slug,
    url: `https://www.cherryservers.com/pricing/${kind === 'dedicated' ? 'dedicated-servers' : 'virtual-servers'}`,
    kind: gpu ? 'gpu' : kind,
    tenancy: kind === 'dedicated' ? 'dedicated' : 'shared',
    regions: regions.map((r) => String(r.slug ?? r.name).toLowerCase()),
    countries: regions.map((r) => r.region_iso_2).filter(Boolean),
    vcpu: kind === 'dedicated' ? num(s.cpus?.threads) : (num(s.cpus?.cores) ?? num(s.cpus?.count)),
    cores: kind === 'dedicated' ? num(s.cpus?.cores) * (num(s.cpus?.count) ?? 1) || null : null,
    ramMb: num(s.memory?.total) ? num(s.memory.total) * 1024 : null,
    arch: p.type === 'arm-vds' || /ampere|arm/i.test(cpuName) ? 'arm64' : 'x86_64',
    gpu,
    storage: (s.storage ?? []).flatMap((d) =>
      Array.from({ length: num(d.count) ?? 1 }, () => ({
        type: /nvme/i.test(`${d.type} ${d.name}`)
          ? 'nvme'
          : /hdd/i.test(d.type ?? '')
            ? 'hdd'
            : 'ssd',
        size_gb: String(d.unit).toUpperCase() === 'TB' ? num(d.size) * 1000 : num(d.size),
      })),
    ),
    bandwidthMbps: portMbps(s.nics?.name),
    transferGb: transferGb(s.bandwidth?.name),
    ipv4: true,
    ipv6: true,
    amount: amount ?? hourly,
    currency: 'EUR',
    interval: amount !== null ? 'month' : 'hour',
    commitment: 0,
    stock: regions.length ? (inStock.length ? 'in_stock' : 'out_of_stock') : 'unknown',
  });
  return offerItem({
    provider: PROVIDER,
    providerName: 'Cherry Servers',
    offer: o,
    priceHourly: hourly,
    extraTags: [p.category ? `category:${String(p.category).toLowerCase()}` : null].filter(Boolean),
    extra: {
      planType: p.type ?? null,
      cpu: cpuName || null,
      spotHourly: priceOf(p, 'spot hourly'),
      stockByRegion: Object.fromEntries(
        regions.map((r) => [String(r.slug ?? r.name).toLowerCase(), num(r.stock_qty)]),
      ),
    },
    raw: { ...p, softwares: undefined },
  });
}

export const cherryPlans = defineAdapter({
  name: 'cherry-plans',
  title: 'Cherry Servers plans',
  collection: 'hosting',
  description:
    'Every Cherry Servers bare-metal, VPS and VDS plan as an OpenServer offer: CPU, RAM, disks, port, bandwidth, monthly and hourly EUR price, and live stock per region. Read daily from the keyless plans endpoint.',
  docs: 'https://api.cherryservers.com/doc/#tag/Plans',
  kinds: ['plan'],
  cadenceMinutes: 1440,
  configFields: [],
  defaultSources: [{ slug: 'cherry-plans', name: 'Hosting: Cherry Servers plans' }],
  retire: retireOffer,
  async pull({ http, log }) {
    const plans = await http.json(PLANS_URL, { timeoutMs: 60_000 });
    const items = (Array.isArray(plans) ? plans : []).map(toItem).filter(Boolean);
    const note = `${items.length} plans of ${plans?.length ?? 0}`;
    log(note);
    return { items, note, complete: items.length > 0 };
  },
});
