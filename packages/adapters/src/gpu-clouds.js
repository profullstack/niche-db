import { defineAdapter } from '@nichedb/core/adapter';
import { num, offer, offerItem, retireOffer } from './hosting.js';

/**
 * GPU sellers that publish their catalogue keyless: the Vast.ai marketplace,
 * RunPod, DataCrunch (Verda), Thunder Compute and TensorDock. Every price is
 * the seller's own, read from its own API or page, per hour in USD, because
 * that is how every one of them bills; nothing is converted to a month here.
 *
 * Checked 2026-11-15: Lambda (`/api/v1/instance-types`) and Latitude.sh
 * (`/plans`) answer 401 without a key; TensorDock's marketplace API answers
 * an empty list without one, so its row set is the three "from" prices and
 * the availability counts on its own GPU page; Crunchbits answers every path
 * with a Cloudflare challenge (left alone); puregpu.com has no web server.
 */

const UA_NOTE = 'Read daily from the seller’s own keyless catalogue.';

// ---------------------------------------------------------------- Vast.ai

/**
 * GPU models asked for one at a time. Vast answers an anonymous search with
 * at most 64 offers, so one search per model (cheapest first) is how the
 * whole range is seen; models found in the open search are added to these.
 */
export const VAST_GPUS = [
  'RTX 5090',
  'RTX 5080',
  'RTX 5070 Ti',
  'RTX 5060 Ti',
  'RTX 4090',
  'RTX 4080S',
  'RTX 4080',
  'RTX 4070 Ti',
  'RTX 4060 Ti',
  'RTX 3090',
  'RTX 3090 Ti',
  'RTX 3080',
  'RTX 3070',
  'RTX 3060',
  'RTX A4000',
  'RTX A5000',
  'RTX A6000',
  'RTX 6000Ada',
  'RTX 4000Ada',
  'RTX PRO 6000 S',
  'RTX PRO 6000 WS',
  'RTX PRO 6000 Max-Q',
  'RTX PRO 5000',
  'RTX PRO 4500',
  'RTX PRO 4000',
  'L40S',
  'L40',
  'L4',
  'A40',
  'A10',
  'A100 PCIE',
  'A100 SXM4',
  'A100X',
  'H100 PCIE',
  'H100 SXM',
  'H100 NVL',
  'H200',
  'H200 NVL',
  'B200',
  'GH200 SXM',
  'Tesla V100',
  'Tesla T4',
  'Q RTX 8000',
  'Titan RTX',
  'InstinctMI300X',
];

const vastQuery = (extra) =>
  `https://console.vast.ai/api/v0/bundles/?q=${encodeURIComponent(
    JSON.stringify({
      rentable: { eq: true },
      rented: { eq: false },
      type: 'on-demand',
      order: [['dph_total', 'asc']],
      limit: 64,
      ...extra,
    }),
  )}`;

const countryOf = (geo) => {
  const c = String(geo ?? '')
    .split(',')
    .pop()
    .trim()
    .toUpperCase();
  return /^[A-Z]{2}$/.test(c) ? c : null;
};

const slug = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/**
 * Offers folded into one row per GPU model x GPU count x country: the
 * cheapest hourly price on offer, how many machines offer it, and the specs
 * of that cheapest machine. A marketplace offer is one host's listing that
 * comes and goes by the minute; the fold is what stays put from day to day.
 */
export function foldVast(offers) {
  const groups = new Map();
  for (const o of offers ?? []) {
    if (!o?.gpu_name || !num(o.num_gpus) || num(o.dph_total) === null) continue;
    const country = countryOf(o.geolocation);
    const key = `${slug(o.gpu_name)}-x${o.num_gpus}-${(country ?? 'xx').toLowerCase()}`;
    const g = groups.get(key);
    if (!g) groups.set(key, { key, country, best: o, count: 1, ids: new Set([o.id]) });
    else if (!g.ids.has(o.id)) {
      g.ids.add(o.id);
      g.count++;
      if (num(o.dph_total) < num(g.best.dph_total)) g.best = o;
    }
  }
  return [...groups.values()].map(({ key, country, best: o, count }) => {
    const price = Math.round(num(o.dph_total) * 10000) / 10000;
    const off = offer({
      id: key,
      name: `${o.num_gpus}x ${o.gpu_name}${country ? ` (${country})` : ''}`,
      url: 'https://cloud.vast.ai/create/',
      kind: 'gpu',
      tenancy: 'shared',
      model: 'p2p',
      regions: country ? [country.toLowerCase()] : [],
      countries: country ? [country] : [],
      vcpu: num(o.cpu_cores_effective) >= 1 ? Math.floor(num(o.cpu_cores_effective)) : null,
      ramMb: num(o.cpu_ram),
      arch: o.cpu_arch === 'arm64' ? 'arm64' : 'x86_64',
      gpu: {
        model: `${/instinct|radeon|^mi\d/i.test(o.gpu_name) ? 'AMD' : 'NVIDIA'} ${o.gpu_name}`,
        count: num(o.num_gpus),
        vramMb: num(o.gpu_ram),
      },
      storage: num(o.disk_space) ? [{ type: 'ssd', size_gb: Math.round(num(o.disk_space)) }] : [],
      bandwidthMbps: num(o.inet_down) ? Math.round(num(o.inet_down)) : null,
      amount: price,
      currency: 'USD',
      interval: 'hour',
      stock: 'in_stock',
    });
    return offerItem({
      provider: 'vast-ai',
      providerName: 'Vast.ai',
      offer: off,
      priceHourly: price,
      extraTags: ['marketplace', o.verification === 'verified' ? 'verified' : null].filter(Boolean),
      extra: {
        offersAtLeast: count,
        cheapestOfferId: o.id,
        reliability: num(o.reliability2 ?? o.reliability),
        cpu: o.cpu_name ?? null,
        dlperf: num(o.dlperf),
        cudaMax: num(o.cuda_max_good),
      },
      raw: {
        gpu_name: o.gpu_name,
        num_gpus: o.num_gpus,
        geolocation: o.geolocation,
        dph_total: o.dph_total,
      },
    });
  });
}

export const vastOffers = defineAdapter({
  name: 'vast-offers',
  title: 'Vast.ai GPU marketplace',
  collection: 'hosting',
  description: `The Vast.ai GPU marketplace, one row per GPU model, GPU count and country: the cheapest on-demand hourly USD price listed now, how many machines offer it, and that machine's vCPU, RAM, disk and network. ${UA_NOTE}`,
  docs: 'https://docs.vast.ai/search-filters',
  kinds: ['plan'],
  cadenceMinutes: 720,
  budgetMs: 6 * 60_000,
  configFields: [],
  defaultSources: [{ slug: 'vast-offers', name: 'Hosting: Vast.ai GPU marketplace' }],
  retire: retireOffer,
  async pull({ http, log, sleep = Bun.sleep, deadline }) {
    const offers = [];
    const open = await http.json(vastQuery({}), { timeoutMs: 60_000 });
    offers.push(...(open?.offers ?? []));
    const names = [...new Set([...VAST_GPUS, ...offers.map((o) => o.gpu_name)])];
    let failed = 0;
    for (const name of names) {
      if (Date.now() > deadline - 30_000) {
        failed++;
        continue;
      }
      await sleep(1000);
      try {
        const body = await http.json(vastQuery({ gpu_name: { eq: name } }), { timeoutMs: 60_000 });
        offers.push(...(body?.offers ?? []));
      } catch (err) {
        failed++;
        log(`${name}: ${err.message.slice(0, 60)}`);
      }
    }
    const items = foldVast(offers);
    const note = `${items.length} GPU rows from ${offers.length} offers across ${names.length} models${failed ? `, ${failed} failed` : ''}`;
    log(note);
    return { items, note, complete: failed === 0 && items.length > 0 };
  },
});

// ---------------------------------------------------------------- RunPod

export const RUNPOD_QUERY =
  '{ gpuTypes { id displayName memoryInGb secureCloud communityCloud securePrice communityPrice secureSpotPrice communitySpotPrice lowestPrice(input:{gpuCount:1}){ uninterruptablePrice stockStatus } } }';

const RUNPOD_STOCK = { High: 'in_stock', Medium: 'in_stock', Low: 'in_stock' };

export function runpodItems(gpuTypes) {
  const out = [];
  for (const g of gpuTypes ?? []) {
    if (!g?.id) continue;
    for (const cloud of ['secure', 'community']) {
      if (!g[`${cloud}Cloud`]) continue;
      const price = num(g[`${cloud}Price`]);
      if (!price) continue;
      const stock = g.lowestPrice?.stockStatus
        ? (RUNPOD_STOCK[g.lowestPrice.stockStatus] ?? 'unknown')
        : 'out_of_stock';
      const o = offer({
        id: `${slug(g.id)}-${cloud}`,
        name: `${g.displayName} (${cloud === 'secure' ? 'Secure Cloud' : 'Community Cloud'})`,
        url: 'https://www.runpod.io/pricing',
        kind: 'gpu',
        tenancy: 'shared',
        model: cloud === 'community' ? 'p2p' : 'centralized',
        gpu: { model: g.id, count: 1, vramMb: num(g.memoryInGb) ? num(g.memoryInGb) * 1024 : null },
        amount: price,
        currency: 'USD',
        interval: 'hour',
        stock,
      });
      out.push(
        offerItem({
          provider: 'runpod',
          providerName: 'RunPod',
          offer: o,
          priceHourly: price,
          extraTags: [`cloud:${cloud}`],
          extra: {
            spotHourly: num(g[`${cloud}SpotPrice`]),
            stockStatus: g.lowestPrice?.stockStatus ?? null,
          },
          raw: g,
        }),
      );
    }
  }
  return out;
}

export const runpodGpus = defineAdapter({
  name: 'runpod-gpus',
  title: 'RunPod GPU pods',
  collection: 'hosting',
  description: `Every RunPod GPU type on Secure Cloud and Community Cloud: VRAM, on-demand and spot hourly USD price, and RunPod's own stock level. ${UA_NOTE}`,
  docs: 'https://docs.runpod.io/sdks/graphql/manage-pods',
  kinds: ['plan'],
  cadenceMinutes: 720,
  configFields: [],
  defaultSources: [{ slug: 'runpod-gpus', name: 'Hosting: RunPod GPU pods' }],
  retire: retireOffer,
  async pull({ http, log }) {
    const res = await http.request('https://api.runpod.io/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: RUNPOD_QUERY }),
      timeoutMs: 60_000,
    });
    if (!res.ok) throw new Error(`RunPod ${res.status}`);
    const body = await res.json();
    const items = runpodItems(body?.data?.gpuTypes);
    const note = `${items.length} GPU offers of ${body?.data?.gpuTypes?.length ?? 0} types`;
    log(note);
    return { items, note, complete: items.length > 0 };
  },
});

// ---------------------------------------------------------------- DataCrunch / Verda

const DATACRUNCH_COUNTRY = { FIN: 'FI', ICE: 'IS', NOR: 'NO', SWE: 'SE', DEU: 'DE', USA: 'US' };

export function datacrunchItems(types) {
  return (types ?? [])
    .map((t) => {
      if (!t?.instance_type) return null;
      const price = num(t.price_per_hour);
      if (!price) return null;
      const locs = (t.location_prices ?? []).map((l) => l.location_code).filter(Boolean);
      const isGpu = num(t.gpu?.number_of_gpus) > 0;
      // CPU-only instance types are per-hour cloud, not what this source is for.
      if (!isGpu) return null;
      const o = offer({
        id: t.instance_type,
        name: t.name ?? t.instance_type,
        url: 'https://datacrunch.io/products',
        kind: isGpu ? 'gpu' : 'cloud',
        tenancy: /dedicated/i.test(t.description ?? '') ? 'dedicated' : 'shared',
        regions: locs.map((l) => l.toLowerCase()),
        countries: locs.map((l) => DATACRUNCH_COUNTRY[l.slice(0, 3)]).filter(Boolean),
        vcpu: num(t.cpu?.number_of_cores),
        ramMb: num(t.memory?.size_in_gigabytes) ? num(t.memory.size_in_gigabytes) * 1024 : null,
        arch: /grace|gh200|gb200|gb300/i.test(t.model ?? '') ? 'arm64' : 'x86_64',
        gpu: isGpu
          ? {
              model: [t.manufacturer, t.model].filter(Boolean).join(' '),
              count: num(t.gpu.number_of_gpus),
              vramMb: num(t.gpu_memory?.size_in_gigabytes)
                ? Math.round(
                    (num(t.gpu_memory.size_in_gigabytes) / num(t.gpu.number_of_gpus)) * 1024,
                  )
                : null,
            }
          : null,
        amount: price,
        currency: String(t.currency ?? 'usd').toUpperCase(),
        interval: 'hour',
      });
      return offerItem({
        provider: 'datacrunch',
        providerName: 'DataCrunch (Verda)',
        offer: o,
        priceHourly: price,
        extra: { spotHourly: num(t.spot_price), p2p: t.p2p ?? null },
        raw: { ...t, supported_os: undefined },
      });
    })
    .filter(Boolean);
}

export const datacrunchInstances = defineAdapter({
  name: 'datacrunch-instances',
  title: 'DataCrunch (Verda) GPU instances',
  collection: 'hosting',
  description: `Every DataCrunch (now Verda) instance type, GPU nodes first: GPU model and count, VRAM, vCPU, RAM, on-demand and spot hourly price, and the locations it runs in. ${UA_NOTE}`,
  docs: 'https://api.datacrunch.io/v1/docs',
  kinds: ['plan'],
  cadenceMinutes: 1440,
  configFields: [],
  defaultSources: [{ slug: 'datacrunch-instances', name: 'Hosting: DataCrunch GPU instances' }],
  retire: retireOffer,
  async pull({ http, log }) {
    const types = await http.json('https://api.datacrunch.io/v1/instance-types', {
      timeoutMs: 60_000,
    });
    const items = datacrunchItems(types);
    const note = `${items.length} instance types`;
    log(note);
    return { items, note, complete: items.length > 0 };
  },
});

// ---------------------------------------------------------------- Thunder Compute

export function thunderItems(pricing, specs) {
  return Object.entries(specs ?? {})
    .map(([key, s]) => {
      const price = num(pricing?.[key]);
      if (!price || /^sandbox_/.test(key)) return null;
      const vcpu = num(s.vcpuOptions?.[0]);
      const o = offer({
        id: key,
        name: `${s.gpuCount}x ${s.displayName}`,
        url: 'https://www.thundercompute.com/pricing',
        kind: 'gpu',
        tenancy: 'shared',
        regions: [],
        countries: ['US'],
        vcpu,
        ramMb: vcpu && num(s.ramPerVCPUGiB) ? vcpu * num(s.ramPerVCPUGiB) * 1024 : null,
        gpu: {
          model: s.displayName,
          count: num(s.gpuCount),
          vramMb: num(s.vramGB) ? num(s.vramGB) * 1024 : null,
        },
        storage: num(s.storageGB?.min) ? [{ type: 'ssd', size_gb: num(s.storageGB.min) }] : [],
        amount: price,
        currency: 'USD',
        interval: 'hour',
      });
      return offerItem({
        provider: 'thunder-compute',
        providerName: 'Thunder Compute',
        offer: o,
        priceHourly: price,
        extra: {
          vcpuOptions: s.vcpuOptions ?? [],
          extraVcpuHourly: num(pricing?.additional_vcpus),
          diskGbHourly: num(pricing?.disk_gb),
        },
        raw: { key, spec: s, price },
      });
    })
    .filter(Boolean);
}

export const thunderGpus = defineAdapter({
  name: 'thunder-gpus',
  title: 'Thunder Compute GPU instances',
  collection: 'hosting',
  description: `Every Thunder Compute GPU configuration (A100, H100, L40, A6000 in 1 to 8 GPU sizes): VRAM, the base vCPU and RAM, and the hourly USD price. ${UA_NOTE}`,
  docs: 'https://www.thundercompute.com/docs',
  kinds: ['plan'],
  cadenceMinutes: 1440,
  configFields: [],
  defaultSources: [{ slug: 'thunder-gpus', name: 'Hosting: Thunder Compute GPUs' }],
  retire: retireOffer,
  async pull({ http, log }) {
    const base = 'https://api.thundercompute.com:8443/v2';
    const pricing = (await http.json(`${base}/pricing`, { timeoutMs: 30_000 }))?.pricing;
    const specs = (await http.json(`${base}/specs`, { timeoutMs: 30_000 }))?.specs;
    const items = thunderItems(pricing, specs);
    const note = `${items.length} GPU configurations`;
    log(note);
    return { items, note, complete: items.length > 0 };
  },
});

// ---------------------------------------------------------------- TensorDock

/**
 * TensorDock's GPU page (`/cloud-gpus.html`) states a "From $X/hr" price per
 * featured model and prints live counts as `H100_80GB: {available_now: 47,
 * ...}`. Both are read; a model with zero available now is out of stock.
 */
export function tensordockItems(html) {
  const text = String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/\s+/g, ' ');
  const avail = new Map();
  for (const [, model, now] of text.matchAll(/([A-Z0-9_]+):\s*\{\s*available_now:\s*(\d+)/g))
    avail.set(model, Number(now));
  const seen = new Set();
  const out = [];
  for (const [, name, price] of text.matchAll(
    /((?:H100|H200|A100|L40S?|A6000|A40|RTX\s?\d{4}|V100)[A-Za-z0-9 ]{0,12}?)\s+From\s+\$([\d.]+)\s*\/\s*hr/g,
  )) {
    const model = name.trim();
    if (seen.has(model)) continue;
    seen.add(model);
    const token = model.match(/H100|H200|A100|L40S?|A6000|A40|\d{4}|V100/)?.[0];
    const count = [...avail].find(([k]) => token && k.includes(token))?.[1];
    const o = offer({
      id: slug(model),
      name: model,
      url: 'https://www.tensordock.com/cloud-gpus.html',
      kind: 'gpu',
      tenancy: 'shared',
      gpu: { model, count: 1 },
      amount: num(price),
      currency: 'USD',
      interval: 'hour',
      stock: count === undefined ? 'unknown' : count > 0 ? 'in_stock' : 'out_of_stock',
    });
    out.push(
      offerItem({
        provider: 'tensordock',
        providerName: 'TensorDock',
        offer: o,
        priceHourly: num(price),
        extraTags: ['starting-from'],
        extra: { availableNow: count ?? null, startingFrom: true },
        raw: { model, price, availableNow: count ?? null },
      }),
    );
  }
  return out;
}

export const tensordockGpus = defineAdapter({
  name: 'tensordock-gpus',
  title: 'TensorDock GPU cloud',
  collection: 'hosting',
  description: `TensorDock's featured GPU models with the "from" hourly USD price and the live available-now count from its own GPU page. ${UA_NOTE}`,
  docs: 'https://www.tensordock.com/cloud-gpus.html',
  kinds: ['plan'],
  cadenceMinutes: 1440,
  configFields: [],
  defaultSources: [{ slug: 'tensordock-gpus', name: 'Hosting: TensorDock GPUs' }],
  retire: retireOffer,
  async pull({ http, log }) {
    const res = await http.request('https://www.tensordock.com/cloud-gpus.html', {
      headers: { accept: 'text/html' },
      timeoutMs: 30_000,
    });
    if (!res.ok) throw new Error(`TensorDock ${res.status}`);
    const items = tensordockItems(await res.text());
    const note = `${items.length} GPU models`;
    log(note);
    return { items, note, complete: items.length > 0 };
  },
});
