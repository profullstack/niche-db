import { decodeEntities, stripHtml } from '@nichedb/core/adapter';
import { num } from './hosting.js';

/**
 * Product listings as the storefront platforms render them, read into one
 * product shape.
 *
 * Each parser takes the HTML of a listing page and the URL it was read from,
 * and returns products: name, group, description, price with its billing
 * cycle, currency, the specs the description states, stock and the product
 * URL. Nothing is fetched here; the `storefront` adapter does the walking
 * (which groups exist, which page is next) with these functions doing the
 * reading, so every parser is testable from a saved page.
 *
 * WHAT A PRICE MEANS
 *
 * A storefront quotes the cheapest cycle it sells -- "$24.00 USD Annually"
 * -- and OpenServer wants an amount and an interval from hour, month, year,
 * once. Monthly and annual quotes are stored as given. A quarterly,
 * semi-annual, biennial or triennial quote is stored per month or per year
 * as the nearest of those, with the amount divided by the cycle's length,
 * and the quote as written is kept beside it as `billing`. So `$24 annually`
 * is `{amount: 24, interval: 'year'}` and `$30 quarterly` is `{amount: 10,
 * interval: 'month'}`, and a reader who wants the original has it.
 *
 * WHAT A DESCRIPTION SAYS
 *
 * Specs come from the description as free text: "1 vCores", "4 GB DDR4
 * RAM", "25 GB SSD", "1 TB Traffic", "1x IPv4". The readers below take the
 * first plausible statement of each and leave null where there is none. A
 * host that writes "Unmetered" for bandwidth gets null transfer and the word
 * kept in `data.specs.transfer`; nothing is invented.
 */

export const CYCLES = {
  hourly: { interval: 'hour', divisor: 1 },
  monthly: { interval: 'month', divisor: 1 },
  quarterly: { interval: 'month', divisor: 3 },
  'semi-annually': { interval: 'month', divisor: 6 },
  semiannually: { interval: 'month', divisor: 6 },
  annually: { interval: 'year', divisor: 1 },
  yearly: { interval: 'year', divisor: 1 },
  biennially: { interval: 'year', divisor: 2 },
  triennially: { interval: 'year', divisor: 3 },
  'one time': { interval: 'once', divisor: 1 },
  onetime: { interval: 'once', divisor: 1 },
  'one-time': { interval: 'once', divisor: 1 },
  'per month': { interval: 'month', divisor: 1 },
  'per year': { interval: 'year', divisor: 1 },
  '/mo': { interval: 'month', divisor: 1 },
  '/yr': { interval: 'year', divisor: 1 },
  '/month': { interval: 'month', divisor: 1 },
  '/year': { interval: 'year', divisor: 1 },
  '/ mois': { interval: 'month', divisor: 1 },
  '/mois': { interval: 'month', divisor: 1 },
  'par mois': { interval: 'month', divisor: 1 },
  '/ année': { interval: 'year', divisor: 1 },
  '/ an': { interval: 'year', divisor: 1 },
  'par an': { interval: 'year', divisor: 1 },
  'pro monat': { interval: 'month', divisor: 1 },
  'pro jahr': { interval: 'year', divisor: 1 },
  'per maand': { interval: 'month', divisor: 1 },
  'per jaar': { interval: 'year', divisor: 1 },
};

const CURRENCY_SYMBOLS = {
  $: 'USD',
  '€': 'EUR',
  '£': 'GBP',
  '₹': 'INR',
  '¥': 'JPY',
  R$: 'BRL',
  A$: 'AUD',
  C$: 'CAD',
  CA$: 'CAD',
  AU$: 'AUD',
  NZ$: 'NZD',
  S$: 'SGD',
  zł: 'PLN',
  'Rs.': 'INR',
  '₽': 'RUB',
  '₺': 'TRY',
};
/** The currency a WHMCS page is showing, from its currency selector; null when it has none. */
export function pageCurrency(html) {
  const select = String(html ?? '').match(
    /<select[^>]*name="currency"[^>]*>([\s\S]*?)<\/select>/i,
  )?.[1];
  if (!select) return null;
  const selected = select.match(/<option[^>]*\bselected\b[^>]*>([\s\S]*?)<\/option>/i)?.[1];
  const code = stripHtml(selected ?? '').match(/\b([A-Z]{3})\b/)?.[1];
  return code ?? null;
}

export const CURRENCY_CODES =
  'USD|EUR|GBP|INR|AUD|CAD|BRL|JPY|SGD|NZD|PLN|CHF|SEK|NOK|DKK|CZK|HUF|RUB|TRY|ZAR|MXN|HKD|IDR|PHP|MYR|THB|VND|KRW|CNY|AED|SAR|ILS|NGN|KES|PKR|BDT|EGP|UAH|RON|BGN|ARS|CLP|COP|PEN|UYU|PYG|BOB|VES|DOP|CRC|GTQ|HNL|NIO|UGX|TZS|GHS|XOF|XAF|MAD|LKR|NPR|ISK|RSD|KZT|TWD|QAR|KWD|BHD|OMR|JOD';
const CURRENCY_CODE = new RegExp(`\\b(${CURRENCY_CODES})\\b`);

/** The amount and currency out of a quoted price: "$24.00 USD", "€3,49", "Rs. 199". */
export function parsePrice(text) {
  const s = decodeEntities(String(text ?? ''))
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;
  const code = s.match(CURRENCY_CODE)?.[1] ?? null;
  const symbol = Object.keys(CURRENCY_SYMBOLS)
    .sort((a, b) => b.length - a.length)
    .find((sym) => s.includes(sym));
  const numMatch = s.match(/(\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)/);
  if (!numMatch) return null;
  let n = numMatch[1];
  // "1.234,56" and "3,49" are European; "1,234.56" and "24.00" are not.
  if (/^\d{1,3}(?:\.\d{3})+,\d{1,2}$/.test(n) || /^\d+,\d{1,2}$/.test(n))
    n = n.replace(/\./g, '').replace(',', '.');
  else n = n.replace(/,/g, '');
  const amount = num(n);
  if (amount === null) return null;
  return { amount, currency: code ?? (symbol ? CURRENCY_SYMBOLS[symbol] : null) };
}

/** A billing cycle word to an OpenServer interval, with the divisor that brings the amount to it. */
export function parseCycle(text) {
  const s = String(text ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  for (const [word, cycle] of Object.entries(CYCLES).sort((a, b) => b[0].length - a[0].length)) {
    if (s.includes(word)) return { cycle: word, ...cycle };
  }
  return null;
}

/** The OpenServer price for a quoted amount on a cycle, and the quote as written. */
export function normalisePrice(price, cycle) {
  if (!price || price.amount === null) return { amount: null, interval: null, billing: null };
  // A price whose cycle the page does not state is stored with no interval:
  // OpenServer reads an absent interval as unstated, and a monthly guess
  // would put a "$5 starting at" dedicated box in the under-$5 feed.
  if (!cycle)
    return { amount: price.amount, interval: null, billing: { amount: price.amount, cycle: null } };
  return {
    amount: Math.round((price.amount / cycle.divisor) * 100) / 100,
    interval: cycle.interval,
    billing: { amount: price.amount, cycle: cycle.cycle ?? null },
  };
}

const toMb = (n, unit) => {
  const v = num(n);
  if (v === null) return null;
  const u = unit.toLowerCase();
  if (u.startsWith('t')) return Math.round(v * 1024 * 1024);
  if (u.startsWith('g')) return Math.round(v * 1024);
  return Math.round(v);
};
const toGb = (n, unit) => {
  const v = num(n);
  if (v === null) return null;
  const u = unit.toLowerCase();
  if (u.startsWith('t')) return Math.round(v * 1024);
  if (u.startsWith('m')) return Math.round((v / 1024) * 10) / 10;
  return v;
};

/**
 * Specs stated in a product description, as free text.
 * @param {string} text  plain text, one statement per line or comma
 */
export function parseSpecs(text) {
  const t = decodeEntities(String(text ?? '')).replace(/\s+/g, ' ');
  const cpu = t.match(/(\d+)\s*(?:x\s*)?(?:vcpu|vcore|v-core|core|cpu)s?\b/i);
  const cpuAlt = t.match(/\b(?:vcpu|vcore|core|cpu)s?\s*[:x-]?\s*(\d+)\b/i);
  const ram = t.match(/(\d+(?:\.\d+)?)\s*(gb|mb|tb)\s*(?:[a-z0-9-]+\s+){0,2}?(?:ram|memory)\b/i);
  const ramAlt = t.match(/\b(?:ram|memory)\s*[:-]?\s*(\d+(?:\.\d+)?)\s*(gb|mb|tb)\b/i);
  const disk = t.match(
    /(\d+(?:\.\d+)?)\s*(gb|tb|mb)\s*(?:[a-z0-9-]+\s+){0,2}?(nvme|ssd|hdd|sas|disk|storage|space)\b/i,
  );
  const diskAlt = t.match(
    /\b(nvme|ssd|hdd|disk|storage)\s*[:-]?\s*(\d+(?:\.\d+)?)\s*(gb|tb|mb)\b/i,
  );
  const transfer = t.match(
    /(\d+(?:\.\d+)?)\s*(tb|gb)\s*(?:of\s*)?(?:premium\s*)?(?:monthly\s*)?(?:bandwidth|traffic|transfer|data)\b/i,
  );
  const unmetered = /\b(unmetered|unlimited)\s*(?:bandwidth|traffic|transfer)\b/i.test(t);
  const port = t.match(/(\d+(?:\.\d+)?)\s*(gbps|gbit|gb\/s|mbps|mbit|mb\/s)\b/i);
  const ipv4 = t.match(/(\d+)\s*(?:x\s*)?(?:dedicated\s*)?ipv4/i);
  const ipv6 = /ipv6/i.test(t);
  const gpu = t.match(
    /\b(?:nvidia|amd|rtx|gtx|tesla|a100|h100|l40s?|a\d{2,4}|rx\s?\d{3,4})\b[^,.;]{0,40}/i,
  );
  const portMbps = port
    ? /g/i.test(port[2])
      ? Math.round(num(port[1]) * 1000)
      : Math.round(num(port[1]))
    : null;
  return {
    vcpu: cpu ? num(cpu[1]) : cpuAlt ? num(cpuAlt[1]) : null,
    ramMb: ram ? toMb(ram[1], ram[2]) : ramAlt ? toMb(ramAlt[1], ramAlt[2]) : null,
    disk: disk
      ? { size_gb: toGb(disk[1], disk[2]), type: diskType(disk[3]) }
      : diskAlt
        ? { size_gb: toGb(diskAlt[2], diskAlt[3]), type: diskType(diskAlt[1]) }
        : null,
    transferGb: transfer ? toGb(transfer[1], transfer[2]) : null,
    transfer: unmetered
      ? 'unmetered'
      : transfer
        ? `${transfer[1]} ${transfer[2].toUpperCase()}`
        : null,
    bandwidthMbps: portMbps,
    ipv4: ipv4 ? num(ipv4[1]) : null,
    ipv6: ipv6 ? true : null,
    gpu: gpu ? gpu[0].trim() : null,
  };
}

function diskType(word) {
  const w = String(word ?? '').toLowerCase();
  if (w === 'nvme') return 'nvme';
  if (w === 'ssd') return 'ssd';
  if (w === 'hdd' || w === 'sas') return 'hdd';
  return null;
}

/** The OpenServer kind a product group or name implies. */
export function kindOf(...names) {
  const s = names.filter(Boolean).join(' ').toLowerCase();
  if (/colocation|colo\b/.test(s)) return 'colocation';
  if (/bare.?metal/.test(s)) return 'bare-metal';
  if (/dedicated/.test(s)) return 'dedicated';
  if (/gpu/.test(s)) return 'gpu';
  if (/storage|backup|object/.test(s)) return 'storage';
  if (/managed|cpanel|plesk|wordpress|directadmin/.test(s) && !/vps|vds|kvm|cloud|server/.test(s))
    return 'managed';
  if (/shared|reseller|web ?hosting|cpanel hosting|email/.test(s) && !/vps|vds|kvm|server/.test(s))
    return 'shared';
  if (/vps|vds|kvm|openvz|lxc|virtual|cloud|instance|server/.test(s)) return 'vps';
  return 'vps';
}

/** Countries named in a description, as ISO codes; the few a hosting listing actually writes. */
const COUNTRY_WORDS = {
  usa: 'US',
  'united states': 'US',
  'u\\.s\\.': 'US',
  us: 'US',
  america: 'US',
  canada: 'CA',
  quebec: 'CA',
  montreal: 'CA',
  toronto: 'CA',
  germany: 'DE',
  frankfurt: 'DE',
  nuremberg: 'DE',
  falkenstein: 'DE',
  düsseldorf: 'DE',
  dusseldorf: 'DE',
  netherlands: 'NL',
  amsterdam: 'NL',
  'the netherlands': 'NL',
  france: 'FR',
  paris: 'FR',
  strasbourg: 'FR',
  gravelines: 'FR',
  roubaix: 'FR',
  uk: 'GB',
  'united kingdom': 'GB',
  london: 'GB',
  england: 'GB',
  india: 'IN',
  mumbai: 'IN',
  bangalore: 'IN',
  bengaluru: 'IN',
  delhi: 'IN',
  noida: 'IN',
  singapore: 'SG',
  japan: 'JP',
  tokyo: 'JP',
  osaka: 'JP',
  australia: 'AU',
  sydney: 'AU',
  melbourne: 'AU',
  finland: 'FI',
  helsinki: 'FI',
  sweden: 'SE',
  stockholm: 'SE',
  norway: 'NO',
  oslo: 'NO',
  poland: 'PL',
  warsaw: 'PL',
  spain: 'ES',
  madrid: 'ES',
  italy: 'IT',
  milan: 'IT',
  switzerland: 'CH',
  zurich: 'CH',
  austria: 'AT',
  vienna: 'AT',
  romania: 'RO',
  bucharest: 'RO',
  bulgaria: 'BG',
  sofia: 'BG',
  turkey: 'TR',
  istanbul: 'TR',
  russia: 'RU',
  moscow: 'RU',
  brazil: 'BR',
  'são paulo': 'BR',
  'sao paulo': 'BR',
  mexico: 'MX',
  chile: 'CL',
  argentina: 'AR',
  'hong kong': 'HK',
  taiwan: 'TW',
  korea: 'KR',
  seoul: 'KR',
  vietnam: 'VN',
  indonesia: 'ID',
  jakarta: 'ID',
  'south africa': 'ZA',
  johannesburg: 'ZA',
  nigeria: 'NG',
  lagos: 'NG',
  israel: 'IL',
  uae: 'AE',
  dubai: 'AE',
  'los angeles': 'US',
  'new york': 'US',
  dallas: 'US',
  chicago: 'US',
  miami: 'US',
  seattle: 'US',
  atlanta: 'US',
  'san jose': 'US',
  'kansas city': 'US',
  buffalo: 'US',
  ashburn: 'US',
  denver: 'US',
  phoenix: 'US',
  'salt lake': 'US',
};
const COUNTRY_RE = new RegExp(
  `\\b(${Object.keys(COUNTRY_WORDS)
    .sort((a, b) => b.length - a.length)
    .join('|')})\\b`,
  'gi',
);

export function parseCountries(text) {
  const out = new Set();
  const t = decodeEntities(String(text ?? ''));
  for (const m of t.matchAll(COUNTRY_RE)) {
    const key = Object.keys(COUNTRY_WORDS).find((k) => new RegExp(`^${k}$`, 'i').test(m[1]));
    if (key) out.add(COUNTRY_WORDS[key]);
  }
  return [...out];
}

const attr = (tag, name) => {
  const m = String(tag).match(
    new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'),
  );
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3]) : null;
};

/** Text of the first element matching a class word inside a block: its inner HTML, stripped. */
function inner(block, re) {
  const m = block.match(re);
  return m ? stripHtml(m[1]).replace(/\s+/g, ' ').trim() : null;
}

/** Stripped text with line breaks kept as newlines, so a spec list reads one per line. */
function textWithBreaks(html) {
  return stripHtml(
    String(html ?? '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|li|div|tr)>/gi, '\n'),
  )
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

/**
 * WHMCS, standard_cart order form (the default since WHMCS 7, and what the
 * `/store/<group>` pages render): one `div.product` per product with a
 * header name, a `p` description, a `div.product-pricing` holding the
 * price span and the cycle, and an order button whose href carries the
 * product id (`cart.php?a=add&pid=42`) or the store slug
 * (`/store/virtual-servers/usd1-server`). The page's group is the `/store/`
 * segment of its own URL or the `gid` in it.
 *
 * Group discovery is a separate function: the sidebar lists every group as
 * `/store/<slug>` or `cart.php?gid=N` links, and the adapter walks them.
 */
export function parseWhmcs(html, pageUrl) {
  const products = [];
  const src = String(html ?? '');
  const group = whmcsGroupOf(pageUrl, src);
  const re = /<div[^>]*class="[^"]*\bproduct\b[^"]*"[^>]*>([\s\S]*?)<\/footer>\s*<\/div>/gi;
  for (const m of src.matchAll(re)) {
    const block = m[1];
    const name = inner(block, /<header[^>]*>([\s\S]*?)<\/header>/i);
    if (!name) continue;
    const descHtml =
      block.match(
        /<div[^>]*class="[^"]*product-desc[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<footer/i,
      )?.[1] ?? '';
    const description = textWithBreaks(descHtml);
    const pricing =
      block.match(/<div[^>]*class="[^"]*product-pricing[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? '';
    const priceText = inner(
      pricing,
      /<span[^>]*class="[^"]*\bprice\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i,
    );
    const cycleText = stripHtml(
      pricing.replace(/<span[^>]*class="[^"]*\bprice\b[^"]*"[^>]*>[\s\S]*?<\/span>/i, ' '),
    )
      .replace(/\s+/g, ' ')
      .trim();
    const button = block.match(/<a[^>]*href="([^"]*)"[^>]*>/i);
    const href = button ? attr(button[0], 'href') : null;
    const url = href ? safeUrl(href, pageUrl) : pageUrl;
    const pid = href?.match(/[?&]pid=(\d+)/)?.[1] ?? null;
    const slug = href?.match(/\/store\/[^/]+\/([a-z0-9_-]+)/i)?.[1] ?? null;
    const outOfStock = /out of stock|sold out|unavailable/i.test(stripHtml(block));
    products.push({
      id: pid ? `pid-${pid}` : (slug ?? slugify(name)),
      name,
      group,
      description,
      price: parsePrice(priceText),
      cycle: parseCycle(cycleText),
      startingFrom: /starting (?:from|at)/i.test(cycleText),
      stock: outOfStock ? 'out_of_stock' : 'unknown',
      url,
    });
  }
  return products;
}

export function whmcsGroupOf(pageUrl, html = '') {
  try {
    const u = new URL(pageUrl);
    const store = u.pathname.match(/\/store\/([a-z0-9_-]+)/i)?.[1];
    if (store) return store;
    const gid = u.searchParams.get('gid');
    if (gid) {
      const named = String(html).match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
      return named ? slugify(stripHtml(named)) : `gid-${gid}`;
    }
  } catch {}
  return null;
}

/** Every product-group listing a WHMCS page links to, absolute and deduplicated. */
export function whmcsGroups(html, pageUrl) {
  const out = new Map();
  const src = String(html ?? '');
  const re = /href\s*=\s*["']([^"'#]+)["']/gi;
  for (const m of src.matchAll(re)) {
    const url = safeUrl(decodeEntities(m[1]), pageUrl);
    if (!url) continue;
    const u = new URL(url);
    const store =
      u.pathname.match(/\/store\/([a-z0-9_-]+)\/?$/i)?.[1] ??
      u.searchParams.get('rp')?.match(/^\/store\/([a-z0-9_-]+)\/?$/i)?.[1];
    const gid = /\/cart\.php$/i.test(u.pathname) ? u.searchParams.get('gid') : null;
    if (store && !/^(domain|ssl|addon)/.test(store))
      out.set(
        store,
        u.searchParams.get('rp')
          ? `${u.origin}${u.pathname}?rp=/store/${store}`
          : `${u.origin}${u.pathname.replace(/\/?$/, '/')}`,
      );
    else if (gid && /^\d+$/.test(gid)) out.set(`gid-${gid}`, `${u.origin}${u.pathname}?gid=${gid}`);
  }
  // A custom template often lists the groups in a <select name="gid"> instead of links.
  const select = src.match(/<select[^>]*name="gid"[^>]*>([\s\S]*?)<\/select>/i)?.[1];
  if (select) {
    const base = new URL(pageUrl);
    for (const o of select.matchAll(/<option[^>]*value="(\d+)"/gi)) {
      if (!out.has(`gid-${o[1]}`))
        out.set(
          `gid-${o[1]}`,
          `${base.origin}${base.pathname.replace(/[^/]*$/, 'cart.php')}?gid=${o[1]}`,
        );
    }
  }
  return [...out.values()];
}

/**
 * WHMCS templates that keep WHMCS's own element ids. Every order-form
 * template WHMCS ships (standard_cart, the slider, the comparison tables,
 * boxes) writes `id="product<N>-name"`, `product<N>-description`,
 * `product<N>-price` and `product<N>-order-button` even when the host has
 * restyled everything around them, so the ids are read directly, one
 * product per `-name`. Used when the standard_cart reader found nothing and
 * before the loose one; what it reads is exact.
 */
export function parseWhmcsIds(html, pageUrl) {
  const src = String(html ?? '');
  const group = whmcsGroupOf(pageUrl, src);
  const shown = pageCurrency(src);
  const products = [];
  const part = (n, what) => {
    const m = src.match(
      new RegExp(`<([a-z0-9]+)[^>]*\\bid="product${n}-${what}"[^>]*>([\\s\\S]*?)<\\/\\1>`, 'i'),
    );
    return m ? m[2] : null;
  };
  for (const m of src.matchAll(/\bid="product(\d+)-name"/gi)) {
    const n = m[1];
    const name = stripHtml(part(n, 'name') ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!name) continue;
    const priceHtml = part(n, 'price') ?? '';
    const priceText = stripHtml(priceHtml).replace(/\s+/g, ' ').trim();
    const parsed = parsePrice(priceText);
    const price =
      parsed && shown && !new RegExp(`\\b${shown}\\b`).test(priceText)
        ? { ...parsed, currency: shown }
        : parsed;
    const button = src.match(new RegExp(`<a[^>]*\\bid="product${n}-order-button"[^>]*>`, 'i'))?.[0];
    const href = button ? attr(button, 'href') : null;
    const pid = href?.match(/[?&]pid=(\d+)/)?.[1] ?? n;
    products.push({
      id: `pid-${pid}`,
      name,
      group,
      description: textWithBreaks(part(n, 'description') ?? ''),
      price,
      cycle: parseCycle(priceText),
      startingFrom: /starting (?:from|at)|\bdesde\b|a partir/i.test(priceText),
      stock: /out of stock|sold out|agotado/i.test(stripHtml(priceHtml))
        ? 'out_of_stock'
        : 'unknown',
      url: href ? (safeUrl(decodeEntities(href), pageUrl) ?? pageUrl) : pageUrl,
    });
  }
  return products;
}

/**
 * WHMCS with a custom template, which most established hosts have: the
 * order form is the host's own HTML with nothing of standard_cart in it,
 * and the only mark WHMCS leaves is the order link, `cart.php?a=add&pid=N`,
 * one per product. Two layouts cover what hosts do: a `<form action=…pid=N>`
 * that WRAPS the product, so the name and specs follow the tag, or an
 * "Order now" `href` that ENDS the product, so they precede it. The page is
 * cut at the order tags, each product is the stretch on the right side of
 * its own tag, its name is the nearest short heading in that stretch, its
 * description the text, its price the first quoted amount. Used only when
 * the standard_cart reader found nothing, and `loose: true` says so.
 */
export function parseWhmcsLoose(html, pageUrl) {
  const src = String(html ?? '');
  const group = whmcsGroupOf(pageUrl, src);
  const shown = pageCurrency(src);
  const priceRe = new RegExp(
    `(?:${CURRENCY_CODES})\\s?\\d[\\d.,]*|(?:[$€£₹¥]|R\\$|A\\$|C\\$|Rs\\.?)\\s?\\d[\\d.,]*(?:\\s?(?:${CURRENCY_CODES}))?|\\d[\\d.,]*\\s?(?:${CURRENCY_CODES})\\b`,
  );
  const tags = [
    ...src.matchAll(
      /<(a|form)\b[^>]*(?:href|action)\s*=\s*["']([^"']*cart\.php\?a=add&(?:amp;)?pid=(\d+)[^"']*)["'][^>]*>/gi,
    ),
  ];
  const products = new Map();
  tags.forEach((m, i) => {
    const pid = m[3];
    if (products.has(pid)) return;
    const forward = m[1].toLowerCase() === 'form';
    const from = forward
      ? m.index + m[0].length
      : (tags[i - 1]?.index ?? Math.max(0, m.index - 3000));
    const to = forward ? (tags[i + 1]?.index ?? Math.min(src.length, m.index + 4000)) : m.index;
    const stretch = src.slice(
      Math.max(from, forward ? from : to - 3000),
      forward ? Math.min(to, from + 4000) : to,
    );
    const headings = [...stretch.matchAll(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/gi)]
      .map((h) => ({
        text: stripHtml(h[1]).replace(/\s+/g, ' ').trim(),
        index: h.index,
        length: h[0].length,
      }))
      .filter((h) => h.text && h.text.length <= 60);
    const heading = forward ? headings[0] : headings.at(-1);
    if (!heading) return;
    const body = forward
      ? stretch.slice(heading.index + heading.length)
      : stretch.slice(heading.index + heading.length);
    const text = textWithBreaks(body);
    const priceText = text.match(priceRe)?.[0] ?? null;
    const parsed = parsePrice(priceText);
    const price =
      parsed && shown && !new RegExp(`\\b${shown}\\b`).test(priceText ?? '')
        ? { ...parsed, currency: shown }
        : parsed;
    const at = priceText ? text.indexOf(priceText) : -1;
    products.set(pid, {
      id: `pid-${pid}`,
      name: heading.text,
      group,
      description: text.slice(0, 1200),
      price,
      cycle: at >= 0 ? parseCycle(text.slice(at, at + 80)) : null,
      startingFrom: /starting (?:from|at)|\bdesde\b|a partir/i.test(text),
      stock: /out of stock|sold out|agotado/i.test(text) ? 'out_of_stock' : 'unknown',
      url: safeUrl(decodeEntities(m[2]), pageUrl) ?? pageUrl,
      loose: true,
    });
  });
  return [...products.values()];
}

/**
 * Blesta's order plugin, as its `standard` template renders a package list.
 *
 * `/order/` (or `/order/forms/`) lists the order forms and the package
 * groups inside each as `/order/main/index/<form>` links; a group page
 * (`/order/main/packages/<form>/?group_id=N`) shows one `div.package.card`
 * per package: `.package-name h4` is the name, `.price-box` holds
 * "Starting at" and the price, and the `<p>` after it is the spec list,
 * one line per `<br>`. The cycle is chosen on the next step, not shown
 * here, so the price is recorded with no interval rather than an assumed
 * one. `data-pricing-id` is Blesta's own id for the package's default
 * pricing and is the stable id. Read off KnownHost's order form, 2026-09-13.
 */
export function parseBlesta(html, pageUrl) {
  const products = [];
  const src = String(html ?? '');
  const u = new URL(pageUrl);
  const form = u.pathname.match(/\/order\/main\/(?:packages|index)\/([a-z0-9_-]+)/i)?.[1] ?? null;
  const groupId = u.searchParams.get('group_id');
  const group = form ? (groupId ? `${form}/${groupId}` : form) : (groupId ?? null);
  const re =
    /<div[^>]*class="[^"]*\bpackage\b[^"]*card[^"]*"([^>]*)>([\s\S]*?)<div[^>]*class="[^"]*card-footer[^"]*"/gi;
  for (const m of src.matchAll(re)) {
    const attrs = m[1];
    const block = m[2];
    const name = inner(block, /<div[^>]*class="[^"]*package-name[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    if (!name) continue;
    const priceBox =
      block.match(/<div[^>]*class="[^"]*price-box[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? '';
    const priceText = inner(priceBox, /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i) ?? stripHtml(priceBox);
    const boxEnd = block.search(/class="[^"]*price-box[^"]*"[^>]*>[\s\S]*?<\/div>/i);
    const after = boxEnd >= 0 ? block.slice(boxEnd).replace(/^[\s\S]*?<\/div>/i, '') : block;
    const description = textWithBreaks(after.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? '');
    const pricingId = attrs.match(/data-pricing-id="(\d+)"/i)?.[1] ?? null;
    const cycle = parseCycle(stripHtml(priceBox));
    products.push({
      id: pricingId ? `pricing-${pricingId}` : slugify(name),
      name,
      group,
      description,
      price: parsePrice(priceText),
      cycle,
      startingFrom: /starting (?:at|from)/i.test(stripHtml(priceBox)),
      stock: /out of stock|sold out/i.test(stripHtml(block)) ? 'out_of_stock' : 'unknown',
      url: pageUrl,
    });
  }
  return products;
}

export function blestaGroups(html, pageUrl) {
  const out = new Map();
  for (const m of String(html ?? '').matchAll(
    /href\s*=\s*["']([^"'#]*\/order\/main\/(?:index|packages)\/[a-z0-9_-]+\/?(?:\?group_id=\d+)?)["']/gi,
  )) {
    const url = safeUrl(decodeEntities(m[1]), pageUrl);
    if (!url) continue;
    const key = url
      .replace(/\/order\/main\/(?:index|packages)\//, '/order/main/index/')
      .replace(/\?.*$/, '');
    if (!/domain|ssl|workspace|addon/i.test(key)) out.set(key, url);
  }
  return [...out.values()];
}

/**
 * WooCommerce, as a shop or category page lists products: one `li.product`
 * per product with the loop link, an `h2.woocommerce-loop-product__title`,
 * a `span.price` holding one or two `.woocommerce-Price-amount` values
 * (two when the first is struck through), and a `.woocommerce-price-suffix`
 * such as "/ mois" or "per month" that carries the cycle. "From" or "À
 * partir de" before the price marks a variable product whose cheapest
 * variation is quoted. The post id in the `li`'s classes is the stable id;
 * the category slugs in the same classes name the group. Read off
 * WPServeur's shop, 2026-09-13.
 */
export function parseWoocommerce(html, pageUrl) {
  const products = [];
  const src = String(html ?? '');
  const pageGroup =
    new URL(pageUrl).pathname.match(/\/product-category\/([a-z0-9_-]+)/i)?.[1] ?? null;
  for (const m of src.matchAll(/<li[^>]*class="([^"]*\bproduct\b[^"]*)"[^>]*>([\s\S]*?)<\/li>/gi)) {
    const classes = m[1];
    const block = m[2];
    const name = inner(
      block,
      /<h\d[^>]*class="[^"]*loop-product__title[^"]*"[^>]*>([\s\S]*?)<\/h\d>/i,
    );
    if (!name) continue;
    const postId = classes.match(/\bpost-(\d+)\b/)?.[1] ?? null;
    const cats = [...classes.matchAll(/\bproduct_cat-([a-z0-9_-]+)/gi)].map((c) => c[1]);
    const priceSpan = block.match(
      /<span[^>]*class="[^"]*\bprice\b[^"]*"[^>]*>([\s\S]*?)<\/span>\s*<\/a>|<span[^>]*class="[^"]*\bprice\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|li)>/i,
    );
    const priceHtml = priceSpan?.[1] ?? priceSpan?.[2] ?? '';
    const current =
      priceHtml.match(/<ins[^>]*>([\s\S]*?)<\/ins>/i)?.[1] ??
      priceHtml.replace(/<del[\s\S]*?<\/del>/gi, '');
    const amountText =
      inner(
        current,
        /<(?:span|bdi)[^>]*class="[^"]*Price-amount[^"]*"[^>]*>([\s\S]*?)<\/(?:span|bdi)>/i,
      ) ?? stripHtml(current);
    const suffix =
      inner(priceHtml, /<[^>]*class="[^"]*price-suffix[^"]*"[^>]*>([\s\S]*?)<\/[a-z]+>/i) ?? '';
    const priceLine = stripHtml(priceHtml).replace(/\s+/g, ' ').trim();
    const href = block.match(
      /<a[^>]*class="[^"]*LoopProduct-link[^"]*"[^>]*href="([^"]*)"|<a[^>]*href="([^"]*)"[^>]*class="[^"]*LoopProduct-link/i,
    );
    const link = href?.[1] ?? href?.[2] ?? block.match(/<a[^>]*href="([^"]*)"/i)?.[1] ?? null;
    const outOfStock =
      /\boutofstock\b/.test(classes) || /out of stock|rupture de stock/i.test(stripHtml(block));
    products.push({
      id: postId ? `post-${postId}` : slugify(name),
      name,
      group: pageGroup ?? cats[0] ?? null,
      description: textWithBreaks(
        block.match(
          /<(?:p|div)[^>]*class="[^"]*(?:short-description|excerpt)[^"]*"[^>]*>([\s\S]*?)<\/(?:p|div)>/i,
        )?.[1] ?? '',
      ),
      price: parsePrice(amountText),
      cycle: parseCycle(suffix) ?? parseCycle(priceLine),
      startingFrom: /(?:^|\s)(?:from|à partir de|vanaf|desde)(?:\s|:|$)|\bab\s+[€$£]/i.test(
        stripHtml(block),
      ),
      stock: outOfStock ? 'out_of_stock' : /\binstock\b/.test(classes) ? 'in_stock' : 'unknown',
      url: link ? (safeUrl(decodeEntities(link), pageUrl) ?? pageUrl) : pageUrl,
      categories: cats,
    });
  }
  return products;
}

export function woocommerceGroups(html, pageUrl) {
  const out = new Set();
  for (const m of String(html ?? '').matchAll(
    /href\s*=\s*["']([^"'#]*\/product-category\/[a-z0-9_-]+\/?)["']/gi,
  )) {
    const url = safeUrl(decodeEntities(m[1]), pageUrl);
    if (url) out.add(url.replace(/\/?$/, '/'));
  }
  return [...out];
}

export const PARSERS = {
  whmcs: {
    parse: (html, url) => {
      const strict = parseWhmcs(html, url);
      if (strict.length) return strict;
      const byId = parseWhmcsIds(html, url);
      return byId.length ? byId : parseWhmcsLoose(html, url);
    },
    groups: whmcsGroups,
  },
  blesta: { parse: parseBlesta, groups: blestaGroups },
  woocommerce: { parse: parseWoocommerce, groups: woocommerceGroups },
};

export function slugify(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export function safeUrl(href, base) {
  try {
    const u = new URL(href, base);
    if (!/^https?:$/.test(u.protocol)) return null;
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}
