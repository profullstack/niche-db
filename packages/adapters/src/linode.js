import { defineAdapter } from '@nichedb/core/adapter';
import { mbToGb, offer, offerItem } from './hosting.js';

/**
 * Linode (Akamai) instance types: every plan with its base price and the
 * regions that charge more.
 *
 * `/v4/linode/types` is public and keyless; it is what linode.com/pricing
 * renders. Memory and disk arrive in MB, transfer in GB, prices in USD. The
 * list does not say which regions sell a type -- only which ones charge a
 * premium (`region_prices`) -- so the offer's regions are empty and the
 * premiums are kept under `regionPrices` instead of being mistaken for
 * availability.
 *
 * The `class` is the product line: nanode, standard, dedicated, premium,
 * highmem, gpu, accelerated. Every one is a virtual machine, so the kind is
 * `vps` (or `gpu`) throughout and the class is a tag; a `dedicated` Linode
 * has dedicated cores, not a dedicated box, so tenancy stays shared.
 */
const TYPES_URL = 'https://api.linode.com/v4/linode/types?page_size=500';
const PRICING_URL = 'https://www.linode.com/pricing/';
export const PROVIDER = 'linode';

export function toItem(t) {
  if (!t?.id) return null;
  const gpu = t.gpus > 0 ? { model: null, count: t.gpus, vramMb: null } : null;
  const o = offer({
    id: t.id,
    name: t.label ?? null,
    url: PRICING_URL,
    kind: gpu ? 'gpu' : 'vps',
    vcpu: t.vcpus,
    ramMb: t.memory,
    storage: t.disk ? [{ type: 'ssd', size_gb: mbToGb(t.disk) }] : [],
    transferGb: t.transfer,
    bandwidthMbps: t.network_out ?? null,
    ipv4: true,
    ipv6: true,
    gpu,
    // Thirty of the 75 types (the GPU lines) are billed by the hour only:
    // `monthly` is null there, so the offer's price is the hourly one and says
    // so, rather than a month at zero.
    amount: t.price?.monthly ?? t.price?.hourly ?? null,
    currency: 'USD',
    interval: t.price?.monthly === null || t.price?.monthly === undefined ? 'hour' : 'month',
  });
  return offerItem({
    provider: PROVIDER,
    providerName: 'Linode',
    offer: o,
    priceHourly: t.price?.hourly,
    extraTags: [t.class ? `class:${String(t.class).toLowerCase()}` : null].filter(Boolean),
    extra: {
      class: t.class ?? null,
      regionPrices: t.region_prices ?? [],
      successor: t.successor ?? null,
    },
    raw: t,
  });
}

export const linodeTypes = defineAdapter({
  name: 'linode-types',
  title: 'Linode instance types',
  collection: 'hosting',
  description:
    'Every Linode (Akamai) instance type as an OpenServer offer: vCPU, RAM, disk, transfer, monthly and hourly price in USD, and the regions that charge a premium. Read daily from the public types endpoint behind linode.com/pricing; a price change updates the row. Keyless.',
  docs: 'https://techdocs.akamai.com/linode-api/reference/get-linode-types',
  kinds: ['plan'],
  cadenceMinutes: 1440,
  configFields: [],
  defaultSources: [{ slug: 'linode-types', name: 'Hosting: Linode instance types' }],
  async pull({ http, log }) {
    const items = [];
    for (let page = 1; page <= 10; page++) {
      const body = await http.json(`${TYPES_URL}&page=${page}`, { timeoutMs: 30_000 });
      items.push(...(body?.data ?? []).map(toItem).filter(Boolean));
      if (page >= (body?.pages ?? 1)) break;
    }
    log(`${items.length} instance types`);
    return { items, note: `${items.length} instance types` };
  },
});
