import { defineAdapter } from '@nichedb/core/adapter';
import { countriesOf, num, offer, offerItem } from './hosting.js';

/**
 * Hetzner Cloud's server types, with the price in every location each is
 * sold in.
 *
 * `/v1/server_types` is the list behind hetzner.com/cloud pricing, but unlike
 * Vultr's or Linode's it answers nothing without a token: every Hetzner Cloud
 * endpoint wants `Authorization: Bearer`, a read-only project token from the
 * console is enough, and the token names no account data this adapter
 * reads. So the source is seeded paused until `HETZNER_API_TOKEN` is set.
 *
 * WHAT THE RECORD SAYS
 *
 * `cores`, `memory` in GB (a float: 2, 3.75, 7.5), `disk` in GB,
 * `architecture` x86 or arm, `cpu_type` shared or dedicated, `storage_type`
 * local or network, and `prices[]` with one entry per location carrying
 * `price_hourly` and `price_monthly`, each as `{net, gross}` strings in EUR,
 * plus `included_traffic` in bytes. The net price is the offer's price:
 * gross adds the VAT of the customer's own country, which the API cannot
 * know. `deprecation` marks a type no longer sold, kept as `out_of_stock`.
 *
 * Locations to countries is a short fixed map (fsn1, nbg1 Germany; hel1
 * Finland; ash, hil United States; sin Singapore); an unknown location
 * carries no country rather than a guess.
 *
 * NOT YET RUN AGAINST THE LIVE API
 *
 * Written from the documented response shape (docs.hetzner.cloud, server
 * types) because no token exists on the box that built it. The fixture test
 * pins that shape; the first real run is the check.
 */
const TYPES_URL = 'https://api.hetzner.cloud/v1/server_types?per_page=50';
const PRICING_URL = 'https://www.hetzner.com/cloud/';
export const PROVIDER = 'hetzner';
export const LOCATION_COUNTRIES = {
  fsn1: 'DE',
  nbg1: 'DE',
  hel1: 'FI',
  ash: 'US',
  hil: 'US',
  sin: 'SG',
};

export function toItem(t) {
  if (!t?.name) return null;
  const prices = Array.isArray(t.prices) ? t.prices : [];
  const regions = prices.map((p) => p.location).filter(Boolean);
  const monthly = prices.map((p) => num(p.price_monthly?.net)).filter((n) => n !== null);
  const hourly = prices.map((p) => num(p.price_hourly?.net)).filter((n) => n !== null);
  const traffic = prices.map((p) => num(p.included_traffic)).filter((n) => n !== null);
  const deprecated = Boolean(t.deprecated || t.deprecation);
  const o = offer({
    id: t.name,
    name: t.name.toUpperCase(),
    url: PRICING_URL,
    kind: 'cloud',
    tenancy: t.cpu_type === 'dedicated' ? 'dedicated' : 'shared',
    regions,
    countries: countriesOf(regions, (r) => LOCATION_COUNTRIES[r] ?? null),
    vcpu: t.cores,
    cores: t.cpu_type === 'dedicated' ? t.cores : null,
    ramMb: num(t.memory) === null ? null : Math.round(num(t.memory) * 1024),
    arch:
      t.architecture === 'arm'
        ? 'arm64'
        : t.architecture === 'x86'
          ? 'x86_64'
          : (t.architecture ?? null),
    storage: t.disk
      ? [{ type: t.storage_type === 'network' ? 'block' : 'nvme', size_gb: t.disk }]
      : [],
    transferGb: traffic.length ? Math.round(Math.min(...traffic) / 1024 ** 3) : null,
    ipv4: true,
    ipv6: true,
    amount: monthly.length ? Math.min(...monthly) : null,
    currency: 'EUR',
    interval: 'month',
    stock: deprecated ? 'out_of_stock' : 'unknown',
  });
  return offerItem({
    provider: PROVIDER,
    providerName: 'Hetzner',
    offer: o,
    priceHourly: hourly.length ? Math.min(...hourly) : null,
    extraTags: [
      t.cpu_type ? `cpu:${t.cpu_type}` : null,
      t.storage_type ? `storage:${t.storage_type}` : null,
      deprecated ? 'deprecated' : null,
    ].filter(Boolean),
    extra: {
      description: t.description ?? null,
      pricesByLocation: Object.fromEntries(
        prices.map((p) => [
          p.location,
          {
            monthlyNet: num(p.price_monthly?.net),
            monthlyGross: num(p.price_monthly?.gross),
            hourlyNet: num(p.price_hourly?.net),
            includedTrafficGb:
              num(p.included_traffic) === null
                ? null
                : Math.round(num(p.included_traffic) / 1024 ** 3),
          },
        ]),
      ),
      deprecation: t.deprecation ?? null,
      priceNote: 'EUR net; gross adds the VAT of the buyer’s country',
    },
    raw: t,
  });
}

export const hetznerPlans = defineAdapter({
  name: 'hetzner-plans',
  title: 'Hetzner Cloud server types',
  collection: 'hosting',
  description:
    'Every Hetzner Cloud server type as an OpenServer offer: cores, RAM, disk, included traffic, the net monthly and hourly price in EUR at the cheapest location and the price in every location it is sold in. Read daily from the server types endpoint. Needs HETZNER_API_TOKEN (a read-only project token); paused until it is set.',
  docs: 'https://docs.hetzner.cloud/#server-types',
  kinds: ['plan'],
  cadenceMinutes: 1440,
  configFields: [],
  needsEnv: ['hetznerApiToken'],
  defaultSources: [{ slug: 'hetzner-plans', name: 'Hosting: Hetzner Cloud server types' }],
  async pull({ env, http, log }) {
    if (!env.hetznerApiToken) throw new Error('HETZNER_API_TOKEN is not set');
    const headers = { authorization: `Bearer ${env.hetznerApiToken}` };
    const items = [];
    let page = 1;
    for (let i = 0; i < 20; i++) {
      const body = await http.json(`${TYPES_URL}&page=${page}`, { headers, timeoutMs: 30_000 });
      items.push(...(body?.server_types ?? []).map(toItem).filter(Boolean));
      const next = body?.meta?.pagination?.next_page;
      if (!next) break;
      page = next;
    }
    log(`${items.length} server types`);
    return { items, note: `${items.length} server types` };
  },
});
