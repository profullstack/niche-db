import { defineAdapter } from '@nichedb/core/adapter';
import { bytesToMb, offer, offerItem, retireOffer } from './hosting.js';

/**
 * Scaleway instance offers, read zone by zone and folded into one row per
 * offer.
 *
 * `/instance/v1/zones/{zone}/products/servers` is keyless -- the only part of
 * the Scaleway API that is -- and is per zone, so the nine zones are read and
 * an offer sold in several of them becomes one item carrying the list, under
 * one id (`scaleway:plan:DEV1-S`) whichever zones it turns up in. The page
 * size is 50 by default and the total is ~125 in the big zones, so it is
 * paged on the `Link` header the way the API documents.
 *
 * Prices are EUR excluding VAT, RAM is bytes, and there is no disk figure: a
 * Scaleway instance boots from a block volume the buyer sizes, so storage is
 * an empty list rather than a guess. Internet bandwidth is bits a second,
 * kept as Mbps. Offers past `end_of_service` are kept and tagged, because a
 * running server still has that name.
 *
 * GPU PRICES. The products endpoint answers `monthly_price: 0` and
 * `hourly_price: 0` for every GPU offer (L4, L40S, H100, B300, RTX PRO 6000):
 * those are billed by the minute and the endpoint does not carry it. The
 * public product catalogue (`/product-catalog/v2alpha1/public-catalog/products`,
 * keyless) does, per zone, so it is read once a run and an offer the products
 * endpoint prices at zero takes the catalogue's rate as an hourly price
 * (per-minute rate x 60), stated as `interval: 'hour'` rather than a month
 * nobody quoted.
 *
 * STOCK. `/products/servers/availability` (keyless, per zone) says
 * `available`, `scarce` or `shortage` for each offer. Deployable in any zone
 * is `in_stock`, short everywhere it is sold is `out_of_stock`. A run that read
 * every zone returns `complete: true`, so an offer Scaleway stops listing is
 * marked discontinued by `retire` instead of lingering at its last price.
 */
export const ZONES = [
  'fr-par-1',
  'fr-par-2',
  'fr-par-3',
  'nl-ams-1',
  'nl-ams-2',
  'nl-ams-3',
  'pl-waw-1',
  'pl-waw-2',
  'pl-waw-3',
];
const PRICING_URL = 'https://www.scaleway.com/en/pricing/virtual-instances/';
export const PROVIDER = 'scaleway';
const CATALOG_URL = (page) =>
  `https://api.scaleway.com/product-catalog/v2alpha1/public-catalog/products?page_size=500&product_types=instance&page=${page}`;
const availabilityUrl = (zone) =>
  `https://api.scaleway.com/instance/v1/zones/${zone}/products/servers/availability?per_page=100`;
const url = (zone, page) =>
  `https://api.scaleway.com/instance/v1/zones/${zone}/products/servers?per_page=100&page=${page}`;

const mbps = (bps) => (Number.isFinite(Number(bps)) ? Math.round(Number(bps) / 1e6) : null);

const money = (p) => (p ? Number(p.units ?? 0) + Number(p.nanos ?? 0) / 1e9 : null);

/**
 * The public catalogue as a Map of offer name to its cheapest hourly EUR rate
 * across the zones it is generally available in. Catalogue rows are per zone
 * and per unit (`minute` for GPUs, `hour` for the rest); retired rows and rows
 * at zero are skipped.
 */
export function catalogRates(products) {
  const out = new Map();
  for (const p of products ?? []) {
    if (p?.product_category !== 'Instance' || p.status === 'retired') continue;
    const amount = money(p.price?.retail_price);
    const unit = p.unit_of_measure?.unit;
    const size = Number(p.unit_of_measure?.size ?? 1) || 1;
    const perUnit = { minute: 60, hour: 1 }[unit];
    if (!p.product || !amount || !perUnit) continue;
    const hourly = Math.round(((amount * perUnit) / size) * 1e6) / 1e6;
    const have = out.get(p.product);
    if (have === undefined || hourly < have) out.set(p.product, hourly);
  }
  return out;
}

/** Stock from the zones' availability words; unknown when no zone said anything. */
export function stockOf(words) {
  const known = (words ?? []).filter(Boolean);
  if (!known.length) return 'unknown';
  return known.some((w) => w === 'available' || w === 'scarce') ? 'in_stock' : 'out_of_stock';
}

export function toItem(name, s, zones, { rates = null, availability = null } = {}) {
  if (!name) return null;
  const listedMonthly = Number(s.monthly_price) > 0 ? Number(s.monthly_price) : null;
  const listedHourly = Number(s.hourly_price) > 0 ? Number(s.hourly_price) : null;
  const catalogHourly = rates?.get(name) ?? null;
  const hourly = listedHourly ?? catalogHourly;
  const gpuMemory = s.gpu_info?.gpu_memory;
  const o = offer({
    id: name,
    url: PRICING_URL,
    kind: s.gpu > 0 ? 'gpu' : 'vps',
    regions: zones,
    countries: zones.map((z) => z.slice(0, 2).toUpperCase()),
    vcpu: s.ncpus,
    ramMb: bytesToMb(s.ram),
    arch: s.arch ?? null,
    gpu:
      s.gpu > 0
        ? {
            model:
              [s.gpu_info?.gpu_manufacturer, s.gpu_info?.gpu_name ?? s.gpu_info?.gpu_type]
                .filter(Boolean)
                .join(' ') || null,
            count: s.gpu,
            vramMb: gpuMemory ? bytesToMb(gpuMemory) : null,
          }
        : null,
    storage: [],
    bandwidthMbps: mbps(s.network?.sum_internet_bandwidth),
    ipv6: s.network?.ipv6_support ?? null,
    // A month where Scaleway quotes one; otherwise the hour it does bill (GPUs), never a zero.
    amount: listedMonthly ?? hourly,
    currency: 'EUR',
    interval: listedMonthly !== null || hourly === null ? 'month' : 'hour',
    stock: s.end_of_service ? 'out_of_stock' : stockOf(availability),
  });
  return offerItem({
    provider: PROVIDER,
    providerName: 'Scaleway',
    offer: o,
    priceHourly: hourly,
    extraTags: [s.end_of_service ? 'end-of-service' : null].filter(Boolean),
    extra: {
      blockStorage: s.capabilities?.block_storage ?? null,
      endOfService: Boolean(s.end_of_service),
      altNames: s.alt_names ?? [],
      priceSource:
        listedMonthly !== null || listedHourly !== null ? 'products' : hourly ? 'catalog' : null,
      availability: availability
        ? Object.fromEntries(zones.map((z, i) => [z, availability[i] ?? null]))
        : null,
    },
    raw: s,
  });
}

/**
 * Fold per-zone listings into one record per offer, with the zones it is in.
 * `availability` is a Map of zone to { offer: word }, `rates` the catalogue's.
 */
export function merge(byZone, { rates = null, availability = null } = {}) {
  const offers = new Map();
  for (const [zone, servers] of byZone) {
    for (const [name, s] of Object.entries(servers ?? {})) {
      const have = offers.get(name);
      if (have) have.zones.push(zone);
      else offers.set(name, { server: s, zones: [zone] });
    }
  }
  return [...offers]
    .map(([name, { server, zones }]) =>
      toItem(name, server, zones, {
        rates,
        availability: availability ? zones.map((z) => availability.get(z)?.[name] ?? null) : null,
      }),
    )
    .filter(Boolean);
}

/** The public catalogue's instance rows, every page. */
export async function readCatalog(http) {
  const products = [];
  for (let page = 1; page <= 20; page++) {
    const body = await http.json(CATALOG_URL(page), { timeoutMs: 30_000 });
    const rows = body?.products ?? [];
    products.push(...rows);
    if (rows.length < 500) break;
  }
  return products;
}

async function readAvailability(http, zone) {
  const body = await http.json(availabilityUrl(zone), { timeoutMs: 30_000 });
  return Object.fromEntries(
    Object.entries(body?.servers ?? {}).map(([name, v]) => [name, v?.availability ?? null]),
  );
}

async function readZone(http, zone) {
  const servers = {};
  for (let page = 1; page <= 10; page++) {
    const res = await http.request(url(zone, page), { timeoutMs: 30_000 });
    if (!res.ok) throw new Error(`${res.status} from ${zone}`);
    const body = await res.json();
    Object.assign(servers, body?.servers ?? {});
    if (!/rel="next"/.test(res.headers.get('link') ?? '')) break;
  }
  return servers;
}

export const scalewayInstances = defineAdapter({
  name: 'scaleway-instances',
  title: 'Scaleway instances',
  collection: 'hosting',
  description:
    'Every Scaleway virtual instance offer as an OpenServer offer: vCPU, RAM, architecture, internet bandwidth, monthly and hourly price in EUR, and the zones it is sold in, folded from the nine zones into one row per offer. Read daily from the public per-zone products endpoint. Keyless.',
  docs: 'https://www.scaleway.com/en/developers/api/instance/#path-instances-list-instances-servers-types',
  kinds: ['plan'],
  cadenceMinutes: 1440,
  configFields: [],
  defaultSources: [{ slug: 'scaleway-instances', name: 'Hosting: Scaleway instances' }],
  retire: retireOffer,
  async pull({ http, log }) {
    const byZone = [];
    const failed = [];
    const availability = new Map();
    for (const zone of ZONES) {
      try {
        byZone.push([zone, await readZone(http, zone)]);
      } catch (err) {
        failed.push(`${zone} (${err.message.slice(0, 40)})`);
        continue;
      }
      try {
        availability.set(zone, await readAvailability(http, zone));
      } catch (err) {
        log(`availability for ${zone} failed: ${err.message.slice(0, 60)}`);
      }
    }
    let rates = null;
    try {
      rates = catalogRates(await readCatalog(http));
    } catch (err) {
      log(`product catalogue failed, GPU offers stay unpriced: ${err.message.slice(0, 60)}`);
    }
    const items = merge(byZone, { rates, availability });
    const unpriced = items.filter((i) => !i.data.offer.price.amount).length;
    const note = `${items.length} offers across ${byZone.length} zones${failed.length ? `; ${failed.length} zones failed` : ''}${unpriced ? `; ${unpriced} unpriced` : ''}`;
    log(`${note}${failed.length ? `: ${failed.join(', ')}` : ''}`);
    // Every zone read: an offer missing from all of them is no longer sold.
    return { items, note, complete: failed.length === 0 && items.length > 0 };
  },
});
