import { defineAdapter } from '@nichedb/core/adapter';
import { countriesOf, num, offer, offerItem } from './hosting.js';

/**
 * UpCloud's preconfigured server plans, priced per zone.
 *
 * Two calls: `/1.3/plan` lists the plans (name "1xCPU-1GB", `core_number`,
 * `memory_amount` in MB, `storage_size` in GB, `storage_tier`,
 * `public_traffic_out` in GB), and `/1.3/price` lists, per zone, a
 * `server_plan_<name>` entry with the plan's `price`. Both want HTTP Basic
 * with the account's API username and password, and neither reads anything
 * about the account; the source is seeded paused until `UPCLOUD_USERNAME`
 * and `UPCLOUD_PASSWORD` are set.
 *
 * THE PRICE UNIT, READ AS DOCUMENTED AND NOT YET CONFIRMED
 *
 * UpCloud's price list quotes each item in credits per hour where one credit
 * is one US cent, so `price: 1.488` on a plan is $0.01488 an hour and
 * $10.86 a 730-hour month. That reading comes from the API documentation
 * (developers.upcloud.com, Prices), not from a run: no credentials existed on
 * the box that built this, so the conversion is pinned by the fixture test
 * and marked `priceUnit` on every row so a wrong reading is visible and
 * correctable in one place. The currency is USD in that API whatever the
 * account's billing currency; the price list says so.
 *
 * Zone names carry the country in their first two letters (fi-hel1, de-fra1,
 * us-chi1, sg-sin1, au-syd1), which is the whole country map. The offer's
 * price is the cheapest zone's; every zone's is kept beside it.
 */
const PLAN_URL = 'https://api.upcloud.com/1.3/plan';
const PRICE_URL = 'https://api.upcloud.com/1.3/price';
const PRICING_URL = 'https://upcloud.com/pricing/';
export const PROVIDER = 'upcloud';
export const HOURS_PER_MONTH = 730;

/** Cents per hour to USD per month, as the price list is documented. */
export const monthlyFromHourlyCents = (cents) =>
  num(cents) === null ? null : Math.round((num(cents) / 100) * HOURS_PER_MONTH * 100) / 100;

const zoneCountry = (zone) => {
  const cc = String(zone ?? '')
    .slice(0, 2)
    .toUpperCase();
  return /^[A-Z]{2}$/.test(cc) ? cc : null;
};

/** The price of every plan in every zone, from the price list document. */
export function pricesByPlan(priceDoc) {
  const out = {};
  const zones = priceDoc?.prices?.zone ?? [];
  for (const zone of Array.isArray(zones) ? zones : [zones]) {
    for (const [key, value] of Object.entries(zone)) {
      const plan = key.match(/^server_plan_(.+)$/)?.[1];
      if (!plan || num(value?.price) === null) continue;
      out[plan] ??= {};
      out[plan][zone.name] = num(value.price);
    }
  }
  return out;
}

export function toItem(p, prices = {}) {
  if (!p?.name) return null;
  const byZone = prices[p.name] ?? {};
  const zones = Object.keys(byZone);
  const cheapestCents = zones.length ? Math.min(...Object.values(byZone)) : null;
  const o = offer({
    id: p.name,
    url: PRICING_URL,
    kind: 'cloud',
    regions: zones,
    countries: countriesOf(zones, zoneCountry),
    vcpu: p.core_number,
    ramMb: p.memory_amount,
    storage: p.storage_size
      ? [{ type: p.storage_tier === 'hdd' ? 'hdd' : 'block', size_gb: p.storage_size }]
      : [],
    transferGb: p.public_traffic_out,
    ipv4: true,
    ipv6: true,
    amount: monthlyFromHourlyCents(cheapestCents),
    currency: 'USD',
    interval: 'month',
  });
  return offerItem({
    provider: PROVIDER,
    providerName: 'UpCloud',
    offer: o,
    priceHourly: cheapestCents === null ? null : Math.round(cheapestCents) / 100,
    extraTags: [p.storage_tier ? `storage:${p.storage_tier}` : null].filter(Boolean),
    extra: {
      pricesByZone: Object.fromEntries(
        zones.map((z) => [
          z,
          { centsPerHour: byZone[z], monthly: monthlyFromHourlyCents(byZone[z]) },
        ]),
      ),
      priceUnit:
        'credits per hour as the price list quotes them, read as US cents; unconfirmed against a live account',
    },
    raw: p,
  });
}

export const upcloudPlans = defineAdapter({
  name: 'upcloud-plans',
  title: 'UpCloud server plans',
  collection: 'hosting',
  description:
    'Every UpCloud preconfigured server plan as an OpenServer offer: cores, RAM, storage, outbound traffic, and the price per zone read from the price list, USD. Read daily. Needs UPCLOUD_USERNAME and UPCLOUD_PASSWORD (an API account); paused until they are set.',
  docs: 'https://developers.upcloud.com/1.3/6-plans/',
  kinds: ['plan'],
  cadenceMinutes: 1440,
  configFields: [],
  needsEnv: ['upcloudUsername', 'upcloudPassword'],
  defaultSources: [{ slug: 'upcloud-plans', name: 'Hosting: UpCloud server plans' }],
  async pull({ env, http, log }) {
    if (!env.upcloudUsername || !env.upcloudPassword)
      throw new Error('UPCLOUD_USERNAME and UPCLOUD_PASSWORD are not set');
    const headers = {
      authorization: `Basic ${Buffer.from(`${env.upcloudUsername}:${env.upcloudPassword}`).toString('base64')}`,
    };
    const [plans, priceDoc] = await Promise.all([
      http.json(PLAN_URL, { headers, timeoutMs: 30_000 }),
      http.json(PRICE_URL, { headers, timeoutMs: 30_000 }).catch((err) => {
        log(`price list failed: ${err.message.slice(0, 80)}`);
        return null;
      }),
    ]);
    const prices = pricesByPlan(priceDoc);
    const list = plans?.plans?.plan ?? [];
    const items = (Array.isArray(list) ? list : [list])
      .map((p) => toItem(p, prices))
      .filter(Boolean);
    log(`${items.length} plans, prices for ${Object.keys(prices).length}`);
    return { items, note: `${items.length} plans, prices for ${Object.keys(prices).length}` };
  },
});
