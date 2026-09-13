import { defineAdapter } from '@nichedb/core/adapter';
import { bytesToMb, offer, offerItem } from './hosting.js';

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
const url = (zone, page) =>
  `https://api.scaleway.com/instance/v1/zones/${zone}/products/servers?per_page=100&page=${page}`;

const mbps = (bps) => (Number.isFinite(Number(bps)) ? Math.round(Number(bps) / 1e6) : null);

export function toItem(name, s, zones) {
  if (!name) return null;
  const o = offer({
    id: name,
    url: PRICING_URL,
    kind: s.gpu > 0 ? 'gpu' : 'vps',
    regions: zones,
    countries: zones.map((z) => z.slice(0, 2).toUpperCase()),
    vcpu: s.ncpus,
    ramMb: bytesToMb(s.ram),
    arch: s.arch ?? null,
    gpu: s.gpu > 0 ? { model: s.gpu_info?.gpu_type ?? null, count: s.gpu, vramMb: null } : null,
    storage: [],
    bandwidthMbps: mbps(s.network?.sum_internet_bandwidth),
    ipv6: s.network?.ipv6_support ?? null,
    amount: s.monthly_price,
    currency: 'EUR',
    interval: 'month',
    stock: s.end_of_service ? 'out_of_stock' : 'unknown',
  });
  return offerItem({
    provider: PROVIDER,
    providerName: 'Scaleway',
    offer: o,
    priceHourly: s.hourly_price,
    extraTags: [s.end_of_service ? 'end-of-service' : null].filter(Boolean),
    extra: {
      blockStorage: s.capabilities?.block_storage ?? null,
      endOfService: Boolean(s.end_of_service),
      altNames: s.alt_names ?? [],
    },
    raw: s,
  });
}

/** Fold per-zone listings into one record per offer, with the zones it is in. */
export function merge(byZone) {
  const offers = new Map();
  for (const [zone, servers] of byZone) {
    for (const [name, s] of Object.entries(servers ?? {})) {
      const have = offers.get(name);
      if (have) have.zones.push(zone);
      else offers.set(name, { server: s, zones: [zone] });
    }
  }
  return [...offers]
    .map(([name, { server, zones }]) => toItem(name, server, zones))
    .filter(Boolean);
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
  async pull({ http, log }) {
    const byZone = [];
    const failed = [];
    for (const zone of ZONES) {
      try {
        byZone.push([zone, await readZone(http, zone)]);
      } catch (err) {
        failed.push(`${zone} (${err.message.slice(0, 40)})`);
      }
    }
    const items = merge(byZone);
    log(
      `${items.length} offers across ${byZone.length} zones${failed.length ? `, failed: ${failed.join(', ')}` : ''}`,
    );
    return {
      items,
      note: `${items.length} offers across ${byZone.length} zones${failed.length ? `; ${failed.length} zones failed` : ''}`,
    };
  },
});
