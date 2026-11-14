import { defineAdapter } from '@nichedb/core/adapter';
import {
  countriesOf,
  offer,
  offerItem,
  retireOffer,
  stockFrom,
  VULTR_COUNTRIES,
} from './hosting.js';

/**
 * Vultr's catalogue: every cloud compute plan and every bare metal plan, with
 * price and the locations each is sold in.
 *
 * `/v2/plans` and `/v2/plans-metal` are the two public, keyless listings
 * behind vultr.com/pricing; everything else on the API needs a key and
 * concerns an account. Both page on a cursor in `meta.links.next`; the whole
 * list fits in one page of 500 today (151 cloud, ~30 metal), and the cursor
 * is followed anyway so it keeps fitting.
 *
 * The `type` prefix says what kind of machine a plan is -- vc2 regular, vhf
 * high frequency, vhp high performance, voc optimised, vcg GPU -- and is kept
 * as a tag. RAM arrives in MB, disk and bandwidth in GB, prices in USD. A
 * bare metal plan is a dedicated box (`bare-metal`, tenancy dedicated); the
 * rest are `vps`, off-prem, unmanaged, shared tenancy, centralized.
 *
 * STOCK. `locations` is where a plan is sold, not where it can be deployed
 * today: the L40S plans list none at all. `/v2/regions/{id}/availability`
 * (keyless too) names the plans each region can deploy right now, so every
 * region is read once a run and a plan is `in_stock` where any region can take
 * it and `out_of_stock` where none can. If a region cannot be read, nothing is
 * claimed from availability and only the plain facts stand (no locations, or
 * `deploy_ondemand: false`, is out of stock; anything else is unknown).
 *
 * RETIRED PLANS. Vultr drops plans from the list (the whole first A16/A40
 * line went in 2026-10, some renamed: vcg-a16-6c-64g became -60g), and a row
 * nobody overwrites would sit in the collection forever at its old price. A
 * run that read both lists returns `complete: true`, and ingest hands each
 * stored plan the lists no longer carry to `retire`, which marks it
 * discontinued.
 */
const PLANS_URL = 'https://api.vultr.com/v2/plans?per_page=500';
const METAL_URL = 'https://api.vultr.com/v2/plans-metal?per_page=500';
const REGIONS_URL = 'https://api.vultr.com/v2/regions?per_page=500';
const PRICING_URL = 'https://www.vultr.com/pricing/';
export const PROVIDER = 'vultr';

export function toItem(p, { metal = false, available } = {}) {
  if (!p?.id) return null;
  const gpu =
    p.gpu_brand && p.gpu_brand !== 'none'
      ? {
          model: `${p.gpu_brand} ${p.gpu_type ?? ''}`.trim(),
          count: p.gpu_count ?? 1,
          vramMb: p.gpu_vram_gb ? p.gpu_vram_gb * 1024 : null,
        }
      : null;
  const regions = p.locations ?? [];
  const diskType = /nvme/i.test(p.disk_type ?? p.type ?? '')
    ? 'nvme'
    : /hdd/i.test(p.disk_type ?? '')
      ? 'hdd'
      : 'ssd';
  const o = offer({
    id: p.id,
    url: PRICING_URL,
    kind: metal ? 'bare-metal' : gpu ? 'gpu' : 'vps',
    tenancy: metal ? 'dedicated' : 'shared',
    regions,
    countries: countriesOf(regions, (r) => VULTR_COUNTRIES[r] ?? null),
    vcpu: metal ? (p.cpu_threads ?? p.cpu_count) : p.vcpu_count,
    cores: metal ? p.cpu_cores : null,
    ramMb: p.ram,
    storage: p.disk
      ? Array.from({ length: p.disk_count || 1 }, () => ({ type: diskType, size_gb: p.disk }))
      : [],
    transferGb: p.bandwidth,
    ipv4: true,
    ipv6: true,
    gpu,
    amount: p.monthly_cost,
    currency: 'USD',
    interval: 'month',
    stock: stockOf(p, available),
  });
  return offerItem({
    provider: PROVIDER,
    providerName: 'Vultr',
    offer: o,
    priceHourly: p.hourly_cost,
    extraTags: [p.type ? `type:${String(p.type).toLowerCase()}` : null].filter(Boolean),
    extra: {
      cpuVendor: p.cpu_vendor ?? p.cpu_manufacturer ?? null,
      cpuModel: p.cpu_model ?? null,
      invoiceType: p.invoice_type ?? null,
      availableIn: Array.isArray(available) ? available : null,
    },
    raw: p,
  });
}

/**
 * Out of stock when Vultr says so plainly (on-demand deploys off, or sold in
 * no location); otherwise what the availability read says, when there is one.
 */
export function stockOf(p, available) {
  if (p.deploy_ondemand === false) return 'out_of_stock';
  if (Array.isArray(available)) return stockFrom(available);
  return Array.isArray(p.locations) && !p.locations.length ? 'out_of_stock' : 'unknown';
}

/**
 * Which regions can deploy each plan now: a Map of plan id to region ids, from
 * every region's availability list. Null if any region could not be read, so a
 * partial read never makes a plan look sold out.
 */
export async function readAvailability(http, { log = () => {}, pauseMs = 300 } = {}) {
  const body = await http.json(REGIONS_URL, { timeoutMs: 30_000 });
  const regions = (body?.regions ?? []).map((r) => r.id).filter(Boolean);
  if (!regions.length) return null;
  const byPlan = new Map();
  for (const region of regions) {
    let list;
    try {
      const a = await http.json(`https://api.vultr.com/v2/regions/${region}/availability`, {
        timeoutMs: 30_000,
      });
      list = a?.available_plans;
    } catch (err) {
      log(`availability for ${region} failed: ${String(err?.message ?? err).slice(0, 80)}`);
      return null;
    }
    if (!Array.isArray(list)) return null;
    for (const plan of list) {
      if (!byPlan.has(plan)) byPlan.set(plan, []);
      byPlan.get(plan).push(region);
    }
    if (pauseMs) await Bun.sleep(pauseMs);
  }
  return byPlan;
}

async function page(http, url, key) {
  const out = [];
  let cursor = '';
  for (let i = 0; i < 20; i++) {
    const body = await http.json(cursor ? `${url}&cursor=${encodeURIComponent(cursor)}` : url, {
      timeoutMs: 30_000,
    });
    out.push(...(body?.[key] ?? []));
    cursor = body?.meta?.links?.next ?? '';
    if (!cursor) break;
  }
  return out;
}

export const vultrPlans = defineAdapter({
  name: 'vultr-plans',
  title: 'Vultr plans',
  collection: 'hosting',
  description:
    'Every Vultr cloud compute and bare metal plan as an OpenServer offer: vCPU, RAM, disk, transfer, monthly and hourly price in USD, and the locations it is sold in. Read daily from the public plans endpoints behind vultr.com/pricing; a price change updates the row. Keyless.',
  docs: 'https://www.vultr.com/api/#tag/plans',
  kinds: ['plan'],
  cadenceMinutes: 1440,
  configFields: [],
  defaultSources: [{ slug: 'vultr-plans', name: 'Hosting: Vultr plans' }],
  retire: retireOffer,
  async pull({ http, log }) {
    let metalOk = true;
    const [cloud, metal] = await Promise.all([
      page(http, PLANS_URL, 'plans'),
      page(http, METAL_URL, 'plans_metal').catch((err) => {
        metalOk = false;
        log(`bare metal list failed: ${err.message.slice(0, 80)}`);
        return [];
      }),
    ]);
    const byPlan = await readAvailability(http, { log }).catch((err) => {
      log(`availability read failed: ${String(err?.message ?? err).slice(0, 80)}`);
      return null;
    });
    const available = (id) => (byPlan ? (byPlan.get(id) ?? []) : undefined);
    const items = [
      ...cloud.map((p) => toItem(p, { available: available(p.id) })),
      ...metal.map((p) => toItem(p, { metal: true, available: available(p.id) })),
    ].filter(Boolean);
    const inStock = items.filter((i) => i.data.offer.stock === 'in_stock').length;
    const note = `${cloud.length} cloud plans, ${metal.length} bare metal, ${byPlan ? `${inStock} deployable now` : 'availability unread'}`;
    log(note);
    // Both lists read and non-empty: the catalogue is whole, so what it lacks is gone.
    return { items, note, complete: metalOk && cloud.length > 0 && metal.length > 0 };
  },
});
