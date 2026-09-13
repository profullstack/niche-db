import { defineAdapter } from '@nichedb/core/adapter';
import { gbToMb, offer, offerItem } from './hosting.js';
import { renderWithObscura } from './storefront.js';

/**
 * BuyVPS (buyvps.com): fourteen KVM plans in Amsterdam and New York, read
 * off the comparison table on /plans/.
 *
 * The page is WordPress and the table is in the HTML as served: one row per
 * plan with `data-base-usd` and `data-base-eur` on the price cell, so no
 * rendering is needed. An Obscura MCP server (OBSCURA_MCP_URL) is used when
 * one is configured, for the day the table moves behind JavaScript, and the
 * plain page otherwise. robots.txt welcomes crawlers by name, including
 * Claude's; the terms say nothing against reading a price list.
 *
 * Three tiers, told apart by the plan's letter: S is shared vCPU on EPYC
 * Milan (shared 1:2 to 1:4), D is physical cores pinned 1:1 on EPYC Genoa
 * with DDR5 ECC, H is the high-memory pool at 8 GB per vCPU on Milan. Every
 * plan is NVMe RAID10, unmetered traffic, one IPv4, sold in both cities. The
 * table shows the monthly price; the yearly terms are up to 15% and 20% off
 * and the S and small D plans offer the first month for a dollar, all kept
 * under `data` rather than folded into the price.
 */
export const PROVIDER = 'buyvps';
export const PROVIDER_NAME = 'BuyVPS';
export const PLANS_URL = 'https://www.buyvps.com/plans/';
export const REGIONS = ['ams', 'nyc'];
export const COUNTRIES = ['nl', 'us'];

const TIERS = {
  S: { tier: 'standard', tenancy: 'shared', cpu: 'AMD EPYC Milan', ratio: 'shared 1:2 to 1:4' },
  D: { tier: 'dedicated', tenancy: 'dedicated', cpu: 'AMD EPYC Genoa', ratio: 'pinned 1:1' },
  H: { tier: 'high-memory', tenancy: 'shared', cpu: 'AMD EPYC Milan', ratio: '8 GB RAM per vCPU' },
};

const text = (html) =>
  String(html ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&euro;/g, '€')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

const num = (s) => {
  const m = String(s ?? '').match(/[\d.]+/);
  return m ? Number(m[0]) : null;
};

/** "30 GB" or "1.4 TB" as gigabytes. */
export function gigabytes(s) {
  const m = String(s ?? '').match(/([\d.]+)\s*(TB|GB|MB)/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toUpperCase();
  return unit === 'TB' ? Math.round(n * 1000) : unit === 'MB' ? Math.round(n / 1024) : n;
}

/**
 * The plan rows of the comparison table: id, tier, vCPU, RAM, disk,
 * bandwidth, the base prices in both currencies, and whether the first
 * month is offered for a dollar. Pure, so the fixture proves it.
 */
export function parsePlans(html) {
  const out = [];
  for (const m of String(html ?? '').matchAll(
    /<tr class="bvps-pl-row[^"]*"[^>]*>([\s\S]*?)<\/tr>/g,
  )) {
    const row = m[1];
    const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => c[1]);
    if (cells.length < 7) continue;
    const id = (text(cells[0]).match(/^([SDH]-\d+)/) ?? [])[1];
    if (!id) continue;
    const usd = num((row.match(/data-base-usd="([^"]+)"/) ?? [])[1]);
    const eur = num((row.match(/data-base-eur="([^"]+)"/) ?? [])[1]);
    out.push({
      id,
      tier: TIERS[id[0]]?.tier ?? 'standard',
      description: text(cells[1]).replace(/^(Standard|Dedicated|Memory)\s+/, ''),
      vcpu: num(text(cells[2])),
      ramGb: gigabytes(text(cells[3])),
      diskGb: gigabytes(text(cells[4])),
      bandwidth: text(cells[5]),
      usd: usd ?? num(text(cells[6])),
      eur,
      trial: /first month/i.test(text(cells[0])),
      pid: (row.match(/pid=(\d+)/) ?? [])[1] ?? null,
    });
  }
  return out;
}

/** The yearly terms the page advertises, as it words them. */
export const TERMS = [
  { interval: 'month', months: 1, discount: 0 },
  { interval: 'year', months: 12, discount: 0.15, note: 'up to 15% off' },
  { interval: 'year', months: 24, discount: 0.2, note: 'up to 20% off' },
];

/** One plan as an OpenServer offer, and the row the table stores. */
export function toItem(plan, fetchedAt = new Date()) {
  if (!plan?.id) return null;
  const tier = TIERS[plan.id[0]] ?? TIERS.S;
  const o = offer({
    id: plan.id,
    name: `${plan.id} ${tier.tier}`,
    url: `${PLANS_URL}#compare`,
    kind: 'vps',
    tenancy: tier.tenancy,
    regions: REGIONS,
    countries: COUNTRIES,
    vcpu: plan.vcpu,
    cores: tier.tenancy === 'dedicated' ? plan.vcpu : null,
    ramMb: gbToMb(plan.ramGb),
    arch: 'x86_64',
    storage: plan.diskGb ? [{ type: 'nvme', size_gb: plan.diskGb, raid: 'raid10' }] : [],
    transferGb: /unlimited|unmetered/i.test(plan.bandwidth) ? null : gigabytes(plan.bandwidth),
    ipv4: true,
    ipv6: true,
    amount: plan.usd,
    currency: 'USD',
    interval: 'month',
    stock: 'in_stock',
    updated: fetchedAt.toISOString(),
  });
  return offerItem({
    provider: PROVIDER,
    providerName: PROVIDER_NAME,
    offer: o,
    extraTags: [
      `tier:${tier.tier}`,
      /unlimited|unmetered/i.test(plan.bandwidth) ? 'transfer:unmetered' : null,
      plan.trial ? 'trial' : null,
    ].filter(Boolean),
    extra: {
      tier: tier.tier,
      cpuModel: tier.cpu,
      cpuRatio: tier.ratio,
      priceEur: plan.eur,
      terms: TERMS,
      trial: plan.trial
        ? { amount: 1, currency: 'USD', months: 1, note: 'first month, one per customer' }
        : null,
      order: plan.pid ? `https://order.buyvps.com/trial?pid=${plan.pid}` : null,
      description: plan.description,
    },
    raw: plan,
  });
}

export const buyvps = defineAdapter({
  name: 'buyvps',
  title: 'BuyVPS plans',
  collection: 'hosting',
  description:
    'Every BuyVPS plan as an OpenServer offer, read off the comparison table at buyvps.com/plans: fourteen KVM plans in three tiers (shared EPYC Milan, dedicated EPYC Genoa cores, high memory), vCPU, RAM, NVMe RAID10 disk, unmetered traffic, the monthly price in USD with the EUR price beside it, the yearly terms and the one-dollar first month where offered, in Amsterdam and New York. Read daily; a price change updates the row. Keyless; an Obscura MCP server (OBSCURA_MCP_URL) renders the page when one is configured.',
  docs: PLANS_URL,
  kinds: ['plan'],
  cadenceMinutes: 24 * 60,
  configFields: [
    {
      key: 'url',
      label: 'Plans page',
      type: 'text',
      help: 'The page with the comparison table.',
      placeholder: PLANS_URL,
    },
  ],
  defaults: { url: PLANS_URL },
  defaultSources: [
    {
      slug: 'buyvps-plans',
      name: 'BuyVPS: every plan',
      description:
        'The fourteen BuyVPS plans with their vCPU, RAM, NVMe disk and price in USD and EUR, in Amsterdam and New York, as the comparison table lists them.',
      config: { url: PLANS_URL },
      enabled: true,
    },
  ],
  async pull({ config, env, http, log }) {
    const url = String(config.url ?? PLANS_URL);
    let html = '';
    let via = 'fetch';
    if (env?.obscuraMcpUrl) {
      html = await renderWithObscura(env.obscuraMcpUrl, url).catch((err) => {
        log(`obscura failed (${err.message.slice(0, 60)}); reading the page as served`);
        return '';
      });
      if (html) via = 'obscura';
    }
    if (!html) html = await http.text(url, { headers: { accept: 'text/html' }, timeoutMs: 30_000 });
    const fetchedAt = new Date();
    const plans = parsePlans(html);
    const items = plans.map((p) => toItem(p, fetchedAt)).filter(Boolean);
    log(`${plans.length} plans via ${via}`);
    return { items, note: `${items.length} plans via ${via}` };
  },
});
