import { defineAdapter } from '@nichedb/core/adapter';
import { countriesOf, gbToMb, offer, offerItem, ovhCountry } from './hosting.js';

/**
 * OVHcloud VPS plans, from the public order catalogue.
 *
 * `/1.0/order/catalog/public/vps?ovhSubsidiary=XX` is the keyless document the
 * order funnel itself reads: every plan code, its pricing phases, the
 * datacentres it can be placed in, and the product it is a plan *of*. It is
 * 12 MB and mostly not servers -- of 243 plans in the US catalogue, most are
 * backup, snapshot, extra storage, licence and IP options -- so the reading is
 * a filter as much as a parse:
 *
 * - a plan is a server when its pricings include a monthly `renew` phase with
 *   a non-zero price, and the product it names describes itself as
 *   "N vCPU N GB RAM N GB disk". That sentence is the spec; the digits in
 *   the plan code are the *legacy* range a code migrated from and are wrong
 *   for the newer models, so the product description wins.
 * - `-degressivity12` / `-degressivity24` / `-10percent` variants are the same
 *   server on a commitment or a promotion, and are dropped so a server is one
 *   row. The undiscounted monthly price is what is stored.
 *
 * Prices are integers in 1e-8 of the catalogue currency, the way OVH's order
 * API counts. One source per subsidiary: US bills USD, FR bills EUR, and the
 * two catalogues list different datacentres; the subsidiary is in the offer
 * id so the two never collide.
 */
export const SUBSIDIARIES = { US: 'https://api.us.ovhcloud.com', FR: 'https://eu.api.ovh.com' };
const PRICING_URL = 'https://www.ovhcloud.com/en/vps/';
export const PROVIDER = 'ovh';

const SPEC = /(\d+)\s*vCPU\s+(\d+)\s*GB\s*RAM\s+(\d+)\s*GB\s*disk/i;
const VARIANT = /-degressivity\d+|-\d+percent/;

export function catalogUrl(subsidiary) {
  const base = SUBSIDIARIES[subsidiary] ?? SUBSIDIARIES.US;
  return `${base}/1.0/order/catalog/public/vps?ovhSubsidiary=${encodeURIComponent(subsidiary)}`;
}

const units = (price) => Math.round(Number(price) / 1e6) / 100;

/** Every monthly renewal price of a plan by commitment in months, cheapest first. */
export function renewalPrices(plan) {
  return (plan.pricings ?? [])
    .filter(
      (p) =>
        (p.capacities ?? []).includes('renew') &&
        p.intervalUnit === 'month' &&
        p.interval === 1 &&
        Number(p.price) > 0,
    )
    .map((p) => ({ commitment: Number(p.commitment) || 0, amount: units(p.price) }))
    .sort((a, b) => a.amount - b.amount);
}

/**
 * The undiscounted monthly price: the renewal with no commitment. A plan may
 * also carry 12- and 24-month rates inside the same pricing list; those are
 * kept beside the offer, not in its price, because the spec's price is one
 * amount with one commitment and month-to-month is the one everyone can buy.
 */
export function monthlyPrice(plan) {
  const all = renewalPrices(plan);
  if (all.length === 0) return null;
  return (all.find((p) => p.commitment === 0) ?? all[0]).amount;
}

export function toItem(plan, product, locale) {
  if (!plan?.planCode || VARIANT.test(plan.planCode)) return null;
  const price = monthlyPrice(plan);
  if (price === null) return null;
  const spec = SPEC.exec(product?.description ?? '');
  if (!spec) return null;
  const datacenters =
    (plan.configurations ?? []).find((c) => c.name === 'vps_datacenter')?.values ?? [];
  const subsidiary = locale?.subsidiary ?? 'US';
  const o = offer({
    id: `${subsidiary}:${plan.planCode}`,
    name: plan.invoiceName ?? plan.planCode,
    url: PRICING_URL,
    kind: 'vps',
    regions: datacenters,
    countries: countriesOf(datacenters, ovhCountry),
    vcpu: Number(spec[1]),
    ramMb: gbToMb(spec[2]),
    storage: [{ type: 'ssd', size_gb: Number(spec[3]) }],
    ipv4: true,
    ipv6: true,
    amount: price,
    currency: locale?.currencyCode ?? 'USD',
    interval: 'month',
    commitment: 0,
  });
  return offerItem({
    provider: PROVIDER,
    providerName: 'OVHcloud',
    offer: o,
    priceHourly: null,
    extraTags: [`subsidiary:${String(subsidiary).toLowerCase()}`],
    extra: {
      planCode: plan.planCode,
      product: plan.product ?? null,
      productDescription: product?.description ?? null,
      subsidiary,
      taxRate: locale?.taxRate ?? null,
      commitmentPrices: renewalPrices(plan),
    },
    raw: { plan: { ...plan, addonFamilies: undefined }, product: product ?? null },
  });
}

export function parseCatalog(catalog) {
  const products = new Map((catalog?.products ?? []).map((p) => [p.name, p]));
  const seen = new Set();
  const items = [];
  for (const plan of catalog?.plans ?? []) {
    if (seen.has(plan.planCode)) continue;
    const item = toItem(plan, products.get(plan.product), catalog?.locale);
    if (!item) continue;
    seen.add(plan.planCode);
    items.push(item);
  }
  return items;
}

export const ovhVps = defineAdapter({
  name: 'ovh-vps',
  title: 'OVHcloud VPS plans',
  collection: 'hosting',
  description:
    'Every OVHcloud VPS plan as an OpenServer offer: vCPU, RAM, disk, the undiscounted monthly price in the subsidiary’s currency, and the datacentres it can be placed in, read daily from the public order catalogue the funnel itself uses. Options, licences and commitment variants are filtered out so a server is one row. Keyless.',
  docs: 'https://api.us.ovhcloud.com/console/?section=%2Forder&branch=v1#get-/order/catalog/public/vps',
  kinds: ['plan'],
  cadenceMinutes: 1440,
  configFields: [
    {
      key: 'subsidiary',
      label: 'Subsidiary',
      type: 'select',
      options: Object.keys(SUBSIDIARIES),
      help: 'Which OVH catalogue to read. US bills in USD from api.us.ovhcloud.com; FR bills in EUR from eu.api.ovh.com.',
    },
  ],
  defaults: { subsidiary: 'US' },
  defaultSources: [
    { slug: 'ovh-vps-us', name: 'Hosting: OVHcloud VPS (US, USD)', config: { subsidiary: 'US' } },
    { slug: 'ovh-vps-eu', name: 'Hosting: OVHcloud VPS (EU, EUR)', config: { subsidiary: 'FR' } },
  ],
  async pull({ config, http, log }) {
    const subsidiary = SUBSIDIARIES[config.subsidiary] ? config.subsidiary : 'US';
    const catalog = await http.json(catalogUrl(subsidiary), { timeoutMs: 120_000 });
    const items = parseCatalog(catalog);
    log(
      `${items.length} VPS plans of ${catalog?.plans?.length ?? 0} catalogue plans (${subsidiary})`,
    );
    return {
      items,
      note: `${items.length} VPS plans (${subsidiary}, ${catalog?.locale?.currencyCode})`,
    };
  },
});
