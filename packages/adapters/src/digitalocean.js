import { defineAdapter } from '@nichedb/core/adapter';
import { countriesOf, offer, offerItem } from './hosting.js';

/**
 * DigitalOcean's Droplet sizes, with the regions each is sold in.
 *
 * `/v2/sizes` is the list behind digitalocean.com/pricing and, like every
 * DigitalOcean endpoint, it answers 401 without a token. A personal access
 * token with read scope is enough and nothing about the account is read.
 * The source is seeded paused until `DIGITALOCEAN_TOKEN` is set.
 *
 * WHAT THE RECORD SAYS
 *
 * `slug` (s-1vcpu-1gb, c-2, m-2vcpu-16gb, gpu-h100x1-80gb), `memory` in MB,
 * `vcpus`, `disk` in GB, `transfer` in TB, `price_monthly` and
 * `price_hourly` in USD, `regions[]` of region slugs, `available`, and a
 * `description` naming the family (Basic, CPU-Optimized, GPU Droplet).
 * The slug prefix says the family and is kept as a tag; a `gpu-` size is a
 * `gpu` offer, the rest are `vps`. `available: false` is `out_of_stock`.
 *
 * Region slugs to countries is a short fixed map (nyc, sfo, atl United
 * States; ams Netherlands; sgp Singapore; lon United Kingdom; fra Germany;
 * tor Canada; blr India; syd Australia). Pages follow `links.pages.next`.
 *
 * NOT YET RUN AGAINST THE LIVE API
 *
 * Written from the documented response shape (docs.digitalocean.com,
 * Sizes) because no token exists on the box that built it. The fixture
 * test pins that shape; the first real run is the check.
 */
const SIZES_URL = 'https://api.digitalocean.com/v2/sizes?per_page=200';
const PRICING_URL = 'https://www.digitalocean.com/pricing/droplets';
export const PROVIDER = 'digitalocean';
const REGION_COUNTRIES = {
  nyc: 'US',
  sfo: 'US',
  atl: 'US',
  ams: 'NL',
  sgp: 'SG',
  lon: 'GB',
  fra: 'DE',
  tor: 'CA',
  blr: 'IN',
  syd: 'AU',
};

export const regionCountry = (slug) => REGION_COUNTRIES[String(slug).replace(/\d+$/, '')] ?? null;

export function toItem(s) {
  if (!s?.slug) return null;
  const regions = Array.isArray(s.regions) ? s.regions : [];
  const family = String(s.slug).split('-')[0];
  const gpu = /^gpu/.test(family)
    ? {
        model: s.description ?? s.slug,
        count: Number(s.slug.match(/x(\d+)/)?.[1] ?? 1),
        vramMb: null,
      }
    : null;
  const o = offer({
    id: s.slug,
    name: s.description ? `${s.description} ${s.slug}` : s.slug,
    url: PRICING_URL,
    kind: gpu ? 'gpu' : 'vps',
    regions,
    countries: countriesOf(regions, regionCountry),
    vcpu: s.vcpus,
    ramMb: s.memory,
    storage: s.disk ? [{ type: 'ssd', size_gb: s.disk }] : [],
    transferGb:
      s.transfer === null || s.transfer === undefined
        ? null
        : Math.round(Number(s.transfer) * 1024),
    ipv4: true,
    ipv6: true,
    gpu,
    amount: s.price_monthly,
    currency: 'USD',
    interval: 'month',
    stock: s.available === false ? 'out_of_stock' : 'unknown',
  });
  return offerItem({
    provider: PROVIDER,
    providerName: 'DigitalOcean',
    offer: o,
    priceHourly: s.price_hourly,
    extraTags: [`family:${family}`],
    extra: { description: s.description ?? null, diskInfo: s.disk_info ?? null },
    raw: s,
  });
}

export const digitaloceanSizes = defineAdapter({
  name: 'digitalocean-sizes',
  title: 'DigitalOcean Droplet sizes',
  collection: 'hosting',
  description:
    'Every DigitalOcean Droplet size as an OpenServer offer: vCPU, RAM, disk, transfer, monthly and hourly price in USD, and the regions it is sold in. Read daily from the sizes endpoint. Needs DIGITALOCEAN_TOKEN (a read-scope personal access token); paused until it is set.',
  docs: 'https://docs.digitalocean.com/reference/api/digitalocean/#tag/Sizes',
  kinds: ['plan'],
  cadenceMinutes: 1440,
  configFields: [],
  needsEnv: ['digitaloceanToken'],
  defaultSources: [{ slug: 'digitalocean-sizes', name: 'Hosting: DigitalOcean Droplet sizes' }],
  async pull({ env, http, log }) {
    if (!env.digitaloceanToken) throw new Error('DIGITALOCEAN_TOKEN is not set');
    const headers = { authorization: `Bearer ${env.digitaloceanToken}` };
    const items = [];
    let url = SIZES_URL;
    for (let i = 0; i < 20 && url; i++) {
      const body = await http.json(url, { headers, timeoutMs: 30_000 });
      items.push(...(body?.sizes ?? []).map(toItem).filter(Boolean));
      url = body?.links?.pages?.next ?? null;
    }
    log(`${items.length} sizes`);
    return { items, note: `${items.length} sizes` };
  },
});
