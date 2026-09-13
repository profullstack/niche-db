import { defineAdapter } from '@nichedb/core/adapter';
import { countriesOf, offer, offerItem, VULTR_COUNTRIES } from './hosting.js';

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
 */
const PLANS_URL = 'https://api.vultr.com/v2/plans?per_page=500';
const METAL_URL = 'https://api.vultr.com/v2/plans-metal?per_page=500';
const PRICING_URL = 'https://www.vultr.com/pricing/';
export const PROVIDER = 'vultr';

export function toItem(p, { metal = false } = {}) {
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
    stock: p.deploy_ondemand === false ? 'out_of_stock' : 'unknown',
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
    },
    raw: p,
  });
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
  async pull({ http, log }) {
    const [cloud, metal] = await Promise.all([
      page(http, PLANS_URL, 'plans'),
      page(http, METAL_URL, 'plans_metal').catch((err) => {
        log(`bare metal list failed: ${err.message.slice(0, 80)}`);
        return [];
      }),
    ]);
    const items = [
      ...cloud.map((p) => toItem(p)),
      ...metal.map((p) => toItem(p, { metal: true })),
    ].filter(Boolean);
    log(`${cloud.length} cloud plans, ${metal.length} bare metal`);
    return { items, note: `${cloud.length} cloud plans, ${metal.length} bare metal` };
  },
});
