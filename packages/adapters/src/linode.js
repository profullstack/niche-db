import { defineAdapter } from '@nichedb/core/adapter';
import { mbToGb, offer, offerItem, retireOffer, stockFrom } from './hosting.js';

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
 *
 * STOCK. `/v4/regions/availability` (public, keyless, paged) names every
 * region and plan pair with `available: true|false`. A plan deployable in any
 * region is `in_stock` and carries those regions (and their countries, from
 * `/v4/regions`); one Linode lists but no region can take is `out_of_stock`.
 * If the availability pages cannot all be read, nothing is claimed.
 *
 * A run returns `complete: true`, so a type Linode stops listing is marked
 * discontinued by `retire` rather than kept at its last price.
 */
const TYPES_URL = 'https://api.linode.com/v4/linode/types?page_size=500';
const AVAILABILITY_URL = 'https://api.linode.com/v4/regions/availability?page_size=500';
const REGIONS_URL = 'https://api.linode.com/v4/regions?page_size=500';
const PRICING_URL = 'https://www.linode.com/pricing/';
export const PROVIDER = 'linode';

export function toItem(t, { available, countryOf = () => null } = {}) {
  if (!t?.id) return null;
  const gpu = t.gpus > 0 ? { model: null, count: t.gpus, vramMb: null } : null;
  const o = offer({
    id: t.id,
    name: t.label ?? null,
    url: PRICING_URL,
    kind: gpu ? 'gpu' : 'vps',
    regions: available ?? [],
    countries: (available ?? []).map(countryOf).filter(Boolean),
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
    stock: stockFrom(available),
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
      availableIn: Array.isArray(available) ? available : null,
    },
    raw: t,
  });
}

/**
 * Plan id to the regions that can deploy it now, from every availability page.
 * A plan the pages never mention maps to nothing (undefined: unknown); one
 * they mention only as unavailable maps to []. Null if a page failed.
 */
export function availabilityByPlan(rows) {
  const out = new Map();
  for (const r of rows ?? []) {
    if (!r?.plan || !r.region) continue;
    if (!out.has(r.plan)) out.set(r.plan, []);
    if (r.available === true) out.get(r.plan).push(r.region);
  }
  return out;
}

async function readAll(http, url) {
  const rows = [];
  for (let page = 1; page <= 50; page++) {
    const body = await http.json(`${url}&page=${page}`, { timeoutMs: 30_000 });
    rows.push(...(body?.data ?? []));
    if (page >= (body?.pages ?? 1)) break;
  }
  return rows;
}

export const linodeTypes = defineAdapter({
  name: 'linode-types',
  title: 'Linode instance types',
  collection: 'hosting',
  description:
    'Every Linode (Akamai) instance type as an OpenServer offer: vCPU, RAM, disk, transfer, monthly and hourly price in USD, the regions that charge a premium, and the regions that can deploy it now. Read daily from the public types and region availability endpoints behind linode.com/pricing; a price change updates the row. Keyless.',
  docs: 'https://techdocs.akamai.com/linode-api/reference/get-linode-types',
  kinds: ['plan'],
  cadenceMinutes: 1440,
  configFields: [],
  defaultSources: [{ slug: 'linode-types', name: 'Hosting: Linode instance types' }],
  retire: retireOffer,
  async pull({ http, log }) {
    const types = await readAll(http, TYPES_URL);
    let byPlan = null;
    let countries = new Map();
    try {
      byPlan = availabilityByPlan(await readAll(http, AVAILABILITY_URL));
      countries = new Map(
        (await readAll(http, REGIONS_URL)).map((r) => [
          r.id,
          String(r.country ?? '').toUpperCase(),
        ]),
      );
    } catch (err) {
      log(`availability read failed: ${String(err?.message ?? err).slice(0, 80)}`);
    }
    const items = types
      .map((t) =>
        toItem(t, {
          available: byPlan ? byPlan.get(t.id) : undefined,
          countryOf: (r) => countries.get(r) || null,
        }),
      )
      .filter(Boolean);
    const inStock = items.filter((i) => i.data.offer.stock === 'in_stock').length;
    const note = `${items.length} instance types, ${byPlan ? `${inStock} deployable now` : 'availability unread'}`;
    log(note);
    return { items, note, complete: items.length > 0 };
  },
});
