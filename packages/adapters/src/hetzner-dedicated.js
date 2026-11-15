import { defineAdapter } from '@nichedb/core/adapter';
import { num, offer, offerItem, retireOffer } from './hosting.js';

/**
 * Hetzner dedicated servers: the current root-server line-up and the server
 * auction, from the two keyless JSON files hetzner.com's own pages read.
 *
 * - `/_resources/app/data/app/live_data_en_EUR.json` is the server finder
 *   behind hetzner.com/dedicated-rootserver: one record per model (AX42,
 *   EX44, GEX44 ...) with the monthly and hourly price, setup fee, CPU, the
 *   RAM and drive variations, the datacentres it is sold in, and
 *   `instantAvailable`.
 * - `/_resources/app/data/app/live_data_sb.json` is the server auction
 *   (hetzner.com/sb): one record per physical machine, priced monthly in EUR
 *   and USD, with its datacentre, CPU, RAM, disks and a falling price. An
 *   auction machine sells once, so its row is retired as soon as the file
 *   stops listing it.
 *
 * Both are read whole every run, so `complete: true` lets ingest mark a model
 * Hetzner stops selling, or an auction machine someone bought, as
 * discontinued rather than leave it at its last price.
 *
 * The cloud server types (`hetzner-plans`) are a different product and need
 * an API token; this adapter is the dedicated side only. Prices are net of
 * VAT, without the monthly IPv4 charge Hetzner lists separately (kept in
 * `data.ipv4Monthly`).
 */
const BASE = 'https://www.hetzner.com/_resources/app/data/app';
export const LINEUP_URL = `${BASE}/live_data_en_EUR.json`;
export const AUCTION_URL = `${BASE}/live_data_sb.json`;
export const PROVIDER = 'hetzner';

const DC_COUNTRY = { FSN: 'DE', NBG: 'DE', HEL: 'FI', ASH: 'US', HIL: 'US', SIN: 'SG' };
export const dcCountry = (dc) =>
  DC_COUNTRY[
    String(dc ?? '')
      .slice(0, 3)
      .toUpperCase()
  ] ?? null;

/** A GPU named in a description line, e.g. "GPU - Nvidia GeForce RTX 4000 SFF Ada" */
export function gpuFrom(lines) {
  const line = (lines ?? []).find((l) => /\bGPU\b|nvidia|geforce|rtx\s?\d/i.test(String(l)));
  if (!line) return null;
  const model = String(line)
    .replace(/^.*?GPU\s*[-:]?\s*/i, '')
    .trim();
  return { model: model || String(line).trim(), count: 1 };
}

/** One model from the server finder. */
export function lineupItem(s) {
  if (!s?.name || !s.priceData) return null;
  const v = s.variations?.[0] ?? {};
  const ramGb = (v.ram ?? []).reduce((a, r) => a + (num(r.Size) ?? 0) * (num(r.Amount) ?? 1), 0);
  const drives = (v.drive ?? []).flatMap((d) =>
    Array.from({ length: num(d.Amount) ?? 1 }, () => ({
      type: String(d.Type ?? '')
        .toLowerCase()
        .includes('nvme')
        ? 'nvme'
        : /hdd/i.test(d.Type ?? '')
          ? 'hdd'
          : 'ssd',
      size_gb:
        String(d.SizeUnit).toUpperCase() === 'TB' ? Math.round(num(d.Size) * 1000) : num(d.Size),
    })),
  );
  const dcs = Object.keys(s.details?.datacenter ?? {});
  // `gpuData.gpu` is the card as written, "4x NVIDIA RTX PRO™ 6000 ..." for several.
  const gpuText = String(s.gpuData?.gpu ?? s.gpuData?.name ?? '')
    .replace(/™|®/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const gpuCount = Number(gpuText.match(/^(\d+)\s*x\s*/i)?.[1] ?? 1);
  const gpu = gpuText
    ? { model: gpuText.replace(/^\d+\s*x\s*/i, ''), count: gpuCount, vramMb: null }
    : null;
  const o = offer({
    id: `dedicated:${s.name.toLowerCase()}`,
    name: s.name,
    url: s.product?.link ?? 'https://www.hetzner.com/dedicated-rootserver/',
    kind: gpu ? 'gpu' : 'dedicated',
    tenancy: 'dedicated',
    regions: dcs.map((d) => d.toLowerCase()),
    countries: (s.details?.countries ?? []).map((c) => String(c.shortcode).toUpperCase()),
    vcpu: num(s.cpuData?.threads),
    cores: num(s.cpuData?.cores),
    ramMb: ramGb ? ramGb * 1024 : null,
    arch: /ampere|altra|arm/i.test(s.cpuData?.cpu ?? '') ? 'arm64' : 'x86_64',
    gpu,
    storage: drives,
    bandwidthMbps: num(s.details?.bandwidth),
    ipv4: true,
    ipv6: true,
    amount: num(s.priceData.price),
    currency: 'EUR',
    interval: 'month',
    setup: num(s.priceData.setupPrice),
    commitment: 0,
    stock: s.product?.instantAvailable === false ? 'out_of_stock' : 'in_stock',
  });
  return offerItem({
    provider: PROVIDER,
    providerName: 'Hetzner',
    offer: o,
    priceHourly: num(s.priceData.hourPrice),
    extraTags: [
      'hetzner-dedicated',
      /unlimited/i.test(s.details?.traffic ?? '') ? 'unmetered' : null,
    ].filter(Boolean),
    extra: {
      cpu: s.cpuData?.cpuName ?? s.cpuData?.cpu ?? null,
      category: s.product?.category ?? null,
      ipv4Monthly: num(s.priceData.ipPrice?.Monthly),
      maxPrice: num(s.priceData.maxPrice),
      variations: s.product?.variationCount ?? null,
      specials: s.specials ?? [],
    },
    raw: s,
  });
}

/** One machine from the server auction. */
export function auctionItem(s) {
  if (!s?.Id || !s.Prices?.monthly) return null;
  const hw = s.Hardware ?? {};
  const det = hw.Storage?.Details ?? {};
  const storage = [
    ...(det.nvme ?? []).map((g) => ({ type: 'nvme', size_gb: num(g) })),
    ...(det.sata ?? []).map((g) => ({ type: 'ssd', size_gb: num(g) })),
    ...(det.hdd ?? []).map((g) => ({ type: 'hdd', size_gb: num(g) })),
  ];
  const dc = s.Details?.Datacenter?.Name ?? '';
  const gpu = gpuFrom(s.Details?.Description);
  const cpu = hw.CPU?.Name ?? null;
  const ramGb = num(hw.RAM?.Size);
  const usd = num(s.Prices.monthly.USD);
  const o = offer({
    id: `auction:${s.Id}`,
    name: `Server Auction #${s.Id} ${cpu ?? ''}`.trim(),
    url: 'https://www.hetzner.com/sb/',
    kind: gpu ? 'gpu' : 'dedicated',
    tenancy: 'dedicated',
    regions: dc ? [dc.toLowerCase()] : [],
    countries: [dcCountry(dc)].filter(Boolean),
    ramMb: ramGb ? ramGb * 1024 : null,
    arch: 'x86_64',
    gpu,
    storage,
    bandwidthMbps: num(s.Details?.Bandwidth),
    ipv4: true,
    ipv6: true,
    amount: num(s.Prices.monthly.EUR),
    currency: 'EUR',
    interval: 'month',
    setup: num(s.Prices.setup?.EUR),
    commitment: 0,
    stock: 'in_stock',
  });
  return offerItem({
    provider: PROVIDER,
    providerName: 'Hetzner',
    offer: o,
    priceHourly: num(s.Prices.hourly?.EUR),
    extraTags: [
      'hetzner-auction',
      'auction',
      hw.RAM?.ecc ? 'ecc' : null,
      /unlimited/i.test(s.Details?.Traffic ?? '') ? 'unmetered' : null,
    ].filter(Boolean),
    extra: {
      cpu,
      cpuCount: num(hw.CPU?.CoreCount),
      ecc: Boolean(hw.RAM?.ecc),
      disks: hw.Storage?.Disks ?? [],
      priceUsd: usd,
      ipv4Monthly: num(s.IPPrices?.monthly?.EUR),
      nextPriceDropAt: s.Timer?.ReduceNextTimestamp
        ? new Date(s.Timer.ReduceNextTimestamp * 1000).toISOString()
        : null,
      fixedPrice: Boolean(s.Prices.fixed),
    },
    raw: s,
  });
}

export function parse(lineup, auction) {
  return [
    ...(lineup?.server ?? []).map(lineupItem),
    ...(auction?.server ?? []).map(auctionItem),
  ].filter(Boolean);
}

export const hetznerDedicated = defineAdapter({
  name: 'hetzner-dedicated',
  title: 'Hetzner dedicated servers and server auction',
  collection: 'hosting',
  description:
    'Every Hetzner dedicated root server model (AX, EX, SX, GEX) and every machine in the Hetzner server auction as an OpenServer offer: CPU, cores and threads, RAM, drives, datacentre, monthly EUR price and setup fee, stock. Read daily from the keyless JSON files hetzner.com itself loads; an auction machine that sells is retired.',
  docs: 'https://www.hetzner.com/sb/',
  kinds: ['plan'],
  cadenceMinutes: 1440,
  configFields: [],
  defaultSources: [{ slug: 'hetzner-dedicated', name: 'Hosting: Hetzner dedicated + auction' }],
  retire: retireOffer,
  async pull({ http, log }) {
    const lineup = await http.json(LINEUP_URL, { timeoutMs: 60_000 });
    const auction = await http.json(AUCTION_URL, { timeoutMs: 60_000 });
    const items = parse(lineup, auction);
    const nLine = lineup?.server?.length ?? 0;
    const nAuc = auction?.server?.length ?? 0;
    const note = `${items.length} offers: ${nLine} line-up models, ${nAuc} auction machines`;
    log(note);
    return { items, note, complete: nLine > 0 && nAuc > 0 && items.length > 0 };
  },
});
