/**
 * What the hosting collection's plan adapters share: one offer shape, the
 * OpenServer one.
 *
 * Four providers publish their catalogue keyless -- Vultr, Linode, Scaleway
 * and OVHcloud -- and each names the same facts differently: Vultr's `ram` is
 * megabytes, Scaleway's is bytes, Linode's disk is megabytes and Vultr's is
 * gigabytes, OVH writes the whole thing into a sentence. A reader comparing a
 * $5 box across them wants one shape, and the shape is not ours to invent:
 * OpenServer (logicsrc) is the descriptor a provider will serve at
 * `/.well-known/openserver.json`, and a row read from a provider's API today
 * is stored under the same field names so the day a provider serves the
 * descriptor itself, nothing downstream changes. `data.offer` here IS an
 * OpenServer offer; `data.provider` is the provider slug every row of that
 * company shares, plan or register entry.
 *
 * THE PROVIDER SLUG IS THE FINDHOST ID
 *
 * The FindHost register describes the company; these adapters describe what it
 * sells. Both land in one collection and must be one company, so the slug on a
 * plan is the id FindHost gives the provider -- `vultr`, `linode`, `scaleway`,
 * `ovh` (checked in providers.json, 2026-09-13) -- and `data.provider` joins
 * them. Item ids stay per-source (`vultr:plan:vc2-1c-1gb`), which is what
 * makes tomorrow's re-read update the row in place rather than add one.
 *
 * WHY THESE PROVIDERS AND NOT THE OBVIOUS OTHERS
 *
 * The upstream must answer without a key and must permit the reading. Checked
 * 2026-09-13: Hetzner (/v1/pricing), DigitalOcean (/v2/sizes) and UpCloud
 * (/1.3/plan) all answer 401 anonymously, so they are not here. Server Hunter
 * aggregates 81,000 offers and its terms forbid "any automated or scripted way
 * of collecting any information" and any commercial reuse, so it is not here
 * and must not be added: this deployment sells passes.
 *
 * A plan has no date of its own. `publishedAt` is left null so the row sorts
 * by when it was first seen; a price change is a content-hash change and
 * updates the row in place.
 */

/** OpenServer offer kinds. */
export const OFFER_KINDS = [
  'cloud',
  'vps',
  'dedicated',
  'bare-metal',
  'colocation',
  'on-prem',
  'shared',
  'managed',
  'paas',
  'serverless',
  'storage',
  'gpu',
  'edge',
  'p2p',
  'hybrid',
];

/** Monthly price, in the provider's currency, to a bucket tag a feed can filter on. */
export function priceBucket(monthly) {
  const p = num(monthly);
  if (p === null) return null;
  if (p === 0) return 'price:free';
  if (p < 5) return 'price:under-5';
  if (p < 10) return 'price:5-10';
  if (p < 25) return 'price:10-25';
  if (p < 50) return 'price:25-50';
  if (p < 100) return 'price:50-100';
  return 'price:over-100';
}

/** A number, or null for anything that is not one -- null and '' included, which Number() would make 0. */
export const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export const gbToMb = (gb) => (num(gb) === null ? null : Math.round(num(gb) * 1024));
export const bytesToMb = (b) => (num(b) === null ? null : Math.round(num(b) / 1024 / 1024));
export const mbToGb = (mb) => (num(mb) === null ? null : Math.round((num(mb) / 1024) * 10) / 10);

/** Human summary of an offer, in the order a pricing page lists it. */
export function describeOffer(offer) {
  const c = offer.compute ?? {};
  const parts = [];
  if (c.vcpu !== null && c.vcpu !== undefined) parts.push(`${c.vcpu} vCPU`);
  if (c.ram_mb) parts.push(c.ram_mb >= 1024 ? `${mbToGb(c.ram_mb)} GB RAM` : `${c.ram_mb} MB RAM`);
  const disk = (offer.storage ?? []).reduce((a, s) => a + (num(s.size_gb) ?? 0), 0);
  if (disk) parts.push(`${disk} GB ${offer.storage?.[0]?.type ?? 'disk'}`);
  if (offer.network?.transfer_gb) parts.push(`${offer.network.transfer_gb} GB transfer`);
  if (c.gpu) parts.push(`GPU: ${c.gpu.count ? `${c.gpu.count}× ` : ''}${c.gpu.model ?? ''}`.trim());
  if (offer.price?.amount !== null && offer.price?.amount !== undefined)
    parts.push(`${offer.price.amount} ${offer.price.currency}/${offer.price.interval}`);
  const n = offer.location?.regions?.length ?? 0;
  if (n) parts.push(`${n} region${n === 1 ? '' : 's'}`);
  return parts.join(', ');
}

/**
 * One offer as an item.
 *
 * `offer` is an OpenServer offer, complete: id, name, url, kind, premises,
 * management, tenancy, model, location, compute, storage, network, price,
 * stock, updated. Missing facts are null, never guessed.
 *
 * @param {object} p
 * @param {string} p.provider       the FindHost id of the company
 * @param {string} p.providerName
 * @param {object} p.offer          an OpenServer offer
 * @param {number|null} [p.priceHourly]  the hourly rate, where the provider bills one
 * @param {string[]} [p.extraTags]
 * @param {object} [p.extra]        provider-specific facts kept beside the offer
 * @param {object} p.raw            the record as the provider sent it
 */
export function offerItem(p) {
  const offer = p.offer;
  const regions = [...new Set((offer.location?.regions ?? []).map((r) => String(r).toLowerCase()))];
  const countries = [
    ...new Set((offer.location?.countries ?? []).map((r) => String(r).toLowerCase())),
  ];
  const name = offer.name && offer.name !== offer.id ? `${offer.name} (${offer.id})` : offer.id;
  const monthly = offer.price?.interval === 'month' ? num(offer.price.amount) : null;
  return {
    externalId: `${p.provider}:plan:${offer.id}`,
    kind: 'plan',
    title: `${p.providerName} ${name}`,
    summary: describeOffer(offer) || null,
    url: offer.url,
    publishedAt: null,
    timeKnown: false,
    precision: 'day',
    tags: [
      'plan',
      `provider:${p.provider}`,
      `kind:${offer.kind}`,
      priceBucket(monthly),
      offer.price?.currency ? `currency:${String(offer.price.currency).toLowerCase()}` : null,
      offer.compute?.arch ? `arch:${String(offer.compute.arch).toLowerCase()}` : null,
      offer.compute?.gpu ? 'gpu' : null,
      ...regions.map((r) => `region:${r}`),
      ...countries.map((c) => `country:${c}`),
      ...(p.extraTags ?? []),
    ].filter(Boolean),
    data: {
      provider: p.provider,
      providerName: p.providerName,
      offer,
      priceHourly: num(p.priceHourly),
      ...(p.extra ?? {}),
      raw: p.raw,
    },
  };
}

/** An OpenServer offer with every field present, so a reader can rely on the shape. */
export function offer({
  id,
  name = null,
  url,
  kind = 'vps',
  premises = 'off-prem',
  management = 'unmanaged',
  tenancy = 'shared',
  model = 'centralized',
  regions = [],
  countries = [],
  vcpu = null,
  cores = null,
  ramMb = null,
  arch = null,
  gpu = null,
  storage = [],
  bandwidthMbps = null,
  transferGb = null,
  ipv4 = null,
  ipv6 = null,
  amount = null,
  currency = 'USD',
  interval = 'month',
  setup = null,
  commitment = null,
  stock = 'unknown',
  updated = null,
}) {
  return {
    id: String(id),
    name: name ?? String(id),
    url,
    kind,
    premises,
    management,
    tenancy,
    model,
    location: { regions: [...regions], countries: [...new Set(countries)].filter(Boolean) },
    compute: {
      vcpu: num(vcpu),
      cores: num(cores),
      ram_mb: num(ramMb),
      arch,
      gpu: gpu
        ? { model: gpu.model ?? null, count: num(gpu.count), vram_mb: num(gpu.vramMb) }
        : null,
    },
    storage: storage
      .filter((s) => s && (s.size_gb ?? s.sizeGb) !== undefined)
      .map((s) => ({
        type: s.type ?? null,
        size_gb: num(s.size_gb ?? s.sizeGb),
      })),
    network: {
      bandwidth_mbps: num(bandwidthMbps),
      transfer_gb: num(transferGb),
      ipv4,
      ipv6,
    },
    price: {
      amount: num(amount),
      currency,
      interval,
      setup: num(setup),
      commitment: num(commitment),
    },
    stock,
    updated,
  };
}

/** Vultr's location codes to ISO countries, from its own regions list. */
export const VULTR_COUNTRIES = {
  ams: 'NL',
  atl: 'US',
  blr: 'IN',
  bom: 'IN',
  cdg: 'FR',
  del: 'IN',
  dfw: 'US',
  ewr: 'US',
  fra: 'DE',
  hnl: 'US',
  icn: 'KR',
  itm: 'JP',
  jnb: 'ZA',
  lax: 'US',
  lhr: 'GB',
  mad: 'ES',
  man: 'GB',
  mel: 'AU',
  mex: 'MX',
  mia: 'US',
  nrt: 'JP',
  ord: 'US',
  osk: 'JP',
  sao: 'BR',
  scl: 'CL',
  sea: 'US',
  sgp: 'SG',
  sjc: 'US',
  sto: 'SE',
  syd: 'AU',
  tlv: 'IL',
  tor: 'CA',
  waw: 'PL',
  yto: 'CA',
};

/** OVH datacentre codes to ISO countries; the Local Zone codes carry the country or city. */
export function ovhCountry(dc) {
  const d = String(dc).toUpperCase();
  const fixed = {
    DE: 'DE',
    GRA: 'FR',
    SBG: 'FR',
    RBX: 'FR',
    UK: 'GB',
    WAW: 'PL',
    BHS: 'CA',
    SGP: 'SG',
    SYD: 'AU',
    YNM: 'IN',
    MIL: 'IT',
    PRG: 'CZ',
    MAD: 'ES',
    AMS: 'NL',
    BRU: 'BE',
    MRS: 'FR',
    VIE: 'AT',
    ZRH: 'CH',
    ERI: 'GB',
    LIM: 'DE',
  };
  if (/^US-/.test(d)) return 'US';
  if (/^CA-/.test(d)) return 'CA';
  const last = d.split('-').pop();
  return fixed[d] ?? fixed[last] ?? null;
}

export const countriesOf = (regions, lookup) => [
  ...new Set(regions.map((r) => lookup(r)).filter(Boolean)),
];
