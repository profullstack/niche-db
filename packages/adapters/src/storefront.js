import { readFileSync } from 'node:fs';
import { defineAdapter } from '@nichedb/core/adapter';
import { BROWSER_SETTLE_MS, CRAWL_BROWSER_TIMEOUT_MS } from '@nichedb/core/crawl';
import { offer, offerItem } from './hosting.js';
import { DISCOVERY_FEEDS, discover, hostList } from './storefront-discovery.js';
import {
  kindOf,
  normalisePrice,
  PARSERS,
  parseCountries,
  parseSpecs,
  slugify,
} from './storefront-parsers.js';
import {
  fingerprint,
  guessedShopOrigins,
  isChallenge,
  isListing,
  PLATFORMS,
  registrableDomain,
  robotsAllows,
  shopLinks,
  shopOrigins,
} from './storefront-platforms.js';

/**
 * The small hosts' catalogues, read off the storefront platform each one
 * runs.
 *
 * A host with no API still has a shop, and the shop is one of a few
 * off-the-shelf billing platforms rendering the same order form for
 * thousands of companies. Measured 2026-09-13 across 683 hosts, every
 * provider in the FindHost repository and every provider LowEndBox had
 * linked to in its last ten feed pages (`scripts/survey-storefronts.js`,
 * table in `test/fixtures/storefront-survey.json`, re-scored by
 * `scripts/rescore-storefront-survey.js`): WHMCS on 175 hosts, 97 of them
 * with a listing a reader can open; WooCommerce on 104, of which 16 are
 * shops that sell hosting as products and the rest WordPress marketing
 * sites carrying the plugin; then Blesta 3, HostBill 2, ClientExec 2,
 * Paymenter 1, and 340 with no storefront at all (the platforms, the
 * clouds, the custom shops). 45 hosts sit behind a bot challenge. So there
 * are three parsers (`storefront-parsers.js`): WHMCS in three readings
 * (the standard_cart markup, WHMCS's own element ids that survive a
 * restyle, and a loose reading from the order links for a fully custom
 * template), WooCommerce, and Blesta, whose one readable host in the corpus
 * forbids crawling its order pages in robots.txt, so the parser is proven
 * on a fixture and waits for a host that allows it. This adapter walks a
 * host once a day: home page, the shop it links to (or the conventional
 * billing subdomains when the home page says nothing), the product groups,
 * the products.
 *
 * MANNERS
 *
 * The user agent names the deployment. robots.txt is read once per origin
 * and honoured for every path. One request a second to any one host, hosts
 * a few at a time, and never more than `maxRequests` to one host in a run.
 * A host that answers with a bot challenge (Cloudflare's "Just a moment")
 * is left alone and noted; a browser does not get past it either (checked
 * with Obscura, stealth mode included), and pretending otherwise would be
 * exactly the kind of reading a directory should not do.
 *
 * WHEN A BROWSER IS NEEDED
 *
 * Some shops render their listing with JavaScript, so plain fetch sees an
 * empty page. When `OBSCURA_MCP_URL` names an Obscura MCP server, a listing
 * that parsed to nothing is loaded there and the rendered HTML read back
 * through `browser_evaluate`; without it the host is skipped with a note.
 * Obscura is only ever a renderer here, never a way round a refusal.
 *
 * IDS AND THE PROVIDER
 *
 * A product is `storefront:<platform>:<domain>:<product id>`, the id being
 * WHMCS's `pid`, the store slug, or a slug of the name, so tomorrow's read
 * updates it in place. `data.provider` is the FindHost id when the domain is
 * one FindHost lists (`findhost-homes.json` is that map), else the
 * registrable domain; either way every plan of a company shares it with the
 * company's register row. `data.offer` is an OpenServer offer built from
 * what the description states and nothing more: a spec the host did not
 * write is null.
 */
const fixture = (name) => {
  try {
    return JSON.parse(readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url), 'utf8'));
  } catch {
    return null;
  }
};

export const SURVEY = fixture('storefront-survey.json');
export const FINDHOST_HOMES = fixture('findhost-homes.json') ?? {};
export const SUPPORTED = Object.keys(PARSERS);

/** The hosts the survey found running a supported platform, as the default host list. */
export function surveyedHosts(survey = SURVEY) {
  return (survey?.hosts ?? [])
    .filter((h) => SUPPORTED.includes(h.platform) && !h.challenged)
    .map((h) => h.listing ?? h.origin ?? h.home)
    .filter(Boolean);
}

/** The FindHost id for a home URL's domain, when the register lists it. */
export function findhostIdFor(url, homes = FINDHOST_HOMES) {
  const domain = registrableDomain(new URL(url).hostname);
  for (const [id, home] of Object.entries(homes)) {
    try {
      if (registrableDomain(new URL(home).hostname) === domain) return id;
    } catch {}
  }
  return null;
}

/**
 * A product name with the store's stock words taken out of it.
 *
 * WHMCS themes print the quantity left beside the name ("Virtual-3 0
 * Available", "KVM-1 (Out of Stock)"), and a parser that takes the heading
 * text whole puts it in the name. Then one plan reads as a different plan
 * every time its count changes. The words go to `stock`, never the name.
 */
export function cleanName(name) {
  let n = String(name ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  let stock = null;
  let quantity = null;
  const qty = n.match(/[\s(\-–|]*\b(\d+)\s+(?:available|left|in stock|remaining)\)?\s*$/i);
  if (qty) {
    quantity = Number(qty[1]);
    stock = quantity > 0 ? 'in_stock' : 'out_of_stock';
    n = n.slice(0, qty.index);
  }
  const words = n.match(
    /[\s(\-–|[]*\b(out of stock|sold out|unavailable|agotado|in stock|available)\b[)\]]?\s*$/i,
  );
  if (words) {
    stock = /^(in stock|available)$/i.test(words[1]) ? 'in_stock' : 'out_of_stock';
    n = n.slice(0, words.index);
  }
  n = n.replace(/[\s\-–|:(]+$/, '').trim();
  return { name: n || String(name ?? '').trim(), stock, quantity };
}

/** The stored-id part a product carries on a host: `storefront:<platform>:<domain>:<id>`. */
const productKey = (item) => item.externalId.split(':').slice(3).join(':');

/**
 * Compare what a run read on each host with what the cursor remembers from
 * that host's last read (`known[domain] = { platform, ids, groups, at }`).
 *
 * - A product id the host never listed before is a NEW OFFERING: tagged
 *   `new-offering`, with `data.newOffering = { detectedAt }`, kept for seven
 *   days. A host read for the first time has nothing new: everything is
 *   simply first seen.
 * - A product group (a WHMCS `/store/<group>`) never seen on the host before
 *   tags its products `new-group`.
 * - A product the host listed last time and not now, on a read that found
 *   products, is retired: its stored row comes back marked discontinued.
 *
 * `data.firstSeenAt` is carried from the stored row, so it is when nichedb
 * first saw the offer, whatever happened since. Prices are only ever the
 * ones the host's own order form showed.
 */
export async function diffHosts(results, { known, previous, now = new Date().toISOString() }) {
  const items = [];
  const retiredIds = [];
  const perHost = [];
  for (const r of results) {
    const plans = r.items ?? [];
    if (!plans.length) continue;
    const { domain, platform } = plans[0].data;
    const before = known[domain] ?? null;
    perHost.push({ domain, platform, plans, before });
    if (before && before.platform === platform) {
      const now_ = new Set(plans.map(productKey));
      for (const id of before.ids ?? [])
        if (!now_.has(id)) retiredIds.push(`storefront:${platform}:${domain}:${id}`);
    }
  }
  const allIds = [...perHost.flatMap((h) => h.plans.map((p) => p.externalId)), ...retiredIds];
  const stored =
    typeof previous === 'function' && allIds.length ? await previous(allIds) : new Map();
  let newOfferings = 0;
  let newGroups = 0;
  const weekAgo = Date.parse(now) - 7 * 86_400_000;
  for (const { domain, platform, plans, before } of perHost) {
    const ids = new Set(before?.ids ?? []);
    const groups = new Set(before?.groups ?? []);
    for (const item of plans) {
      const prev = stored.get(item.externalId) ?? null;
      item.data.firstSeenAt = prev?.firstSeenAt ?? now;
      const fresh = before && !ids.has(productKey(item)) && !prev;
      const still =
        prev?.newOffering?.detectedAt && Date.parse(prev.newOffering.detectedAt) > weekAgo;
      if (fresh || still) {
        item.data.newOffering = { detectedAt: still ? prev.newOffering.detectedAt : now };
        item.tags = [...new Set([...item.tags, 'new-offering'])];
        if (fresh) newOfferings++;
      }
      const g = item.data.group ?? null;
      if (before && g && !groups.has(g)) {
        item.data.newGroup = g;
        item.tags = [...new Set([...item.tags, 'new-group'])];
      }
      items.push(item);
    }
    const nowGroups = [...new Set(plans.map((p) => p.data.group).filter(Boolean))];
    if (before) newGroups += nowGroups.filter((g) => !groups.has(g)).length;
    known[domain] = { platform, ids: plans.map(productKey), groups: nowGroups, at: now };
  }
  let retired = 0;
  for (const id of retiredIds) {
    const data = stored.get(id);
    if (!data?.offer || data.offer.stock === 'discontinued') continue;
    const { offer: o, provider, providerName, raw, priceHourly, ...extra } = data;
    const item = offerItem({
      provider,
      providerName,
      offer: { ...o, stock: 'discontinued' },
      priceHourly,
      extraTags: [data.platform ? `platform:${data.platform}` : null, 'discontinued'].filter(
        Boolean,
      ),
      extra: { ...extra, discontinued: true, discontinuedAt: now },
      raw,
    });
    item.externalId = id;
    items.push(item);
    retired++;
  }
  return { items, newOfferings, newGroups, retired };
}

/** One parsed product as a hosting item. */
export function productItem(product, { platform, domain, provider, providerName, fetchedAt }) {
  const cleaned = cleanName(product.name);
  // An id made from the name must not carry the stock words either, or the
  // plan becomes a new row each time its count changes.
  const id = String(product.id).replace(
    /-(?:\d+-(?:available|left|in-stock|remaining)|out-of-stock|sold-out|unavailable|in-stock|available)$/i,
    '',
  );
  product = {
    ...product,
    id: id || product.id,
    name: cleaned.name,
    stock:
      product.stock && product.stock !== 'unknown'
        ? product.stock
        : (cleaned.stock ?? product.stock),
  };
  const specs = parseSpecs(product.description);
  const countries = parseCountries(`${product.name} ${product.group ?? ''} ${product.description}`);
  const price = normalisePrice(product.price, product.cycle);
  const kind = kindOf(product.group, product.name);
  const addon = kind === 'addon';
  const o = offer({
    id: product.id,
    name: product.name,
    url: product.url,
    // An addon (a Microsoft 365 seat, an SSL certificate) is not a server, so
    // it carries no OpenServer kind; the item kind below keeps it out of the
    // plan feeds while the store is still read whole.
    kind: addon ? null : kind,
    tenancy:
      kind === 'dedicated' || kind === 'bare-metal' || kind === 'colocation'
        ? 'dedicated'
        : 'shared',
    management: kind === 'managed' || kind === 'shared' ? 'managed' : 'unmanaged',
    countries,
    vcpu: specs.vcpu,
    ramMb: specs.ramMb,
    storage: specs.disk ? [specs.disk] : [],
    bandwidthMbps: specs.bandwidthMbps,
    transferGb: specs.transferGb,
    ipv4: specs.ipv4,
    ipv6: specs.ipv6,
    gpu: specs.gpu ? { model: specs.gpu, count: null, vramMb: null } : null,
    amount: price.amount,
    // Never a guessed currency: a page that names none stays null, or a
    // Moroccan host's dirhams read as dollars (capconnect, first run).
    currency: product.price?.currency ?? null,
    interval: price.interval,
    stock: product.stock,
    updated: fetchedAt,
  });
  const item = offerItem({
    provider,
    providerName,
    offer: o,
    kind: addon ? 'addon' : 'plan',
    extraTags: [
      `platform:${platform}`,
      addon ? 'addon' : null,
      product.group ? `group:${slugify(product.group)}` : null,
      product.startingFrom ? 'starting-from' : null,
      specs.transfer === 'unmetered' ? 'unmetered' : null,
    ].filter(Boolean),
    extra: {
      platform,
      domain,
      group: product.group,
      description: product.description,
      billing: price.billing,
      startingFrom: product.startingFrom,
      specs,
      attribution: `${providerName} (${domain}), from its own order form`,
    },
    raw: product,
  });
  item.externalId = `storefront:${platform}:${domain}:${product.id}`;
  item.summary = item.summary ?? product.description.split('\n').slice(0, 4).join(', ') ?? null;
  return item;
}

/**
 * Ask an Obscura MCP server for a page's rendered HTML.
 *
 * The fleet crawler rule: 30 s for the whole render (navigate, settle, read),
 * waiting for `load` plus a bounded settle, never `networkidle` (a page with a
 * chat widget or an analytics beacon never goes idle). Running out of time
 * rejects, so the caller records a failure instead of reading half a page.
 */
export async function renderWithObscura(
  mcpUrl,
  url,
  {
    timeoutMs = CRAWL_BROWSER_TIMEOUT_MS,
    settleMs = BROWSER_SETTLE_MS,
    sleep = Bun.sleep,
    fetchImpl = fetch,
  } = {},
) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const call = async (id, name, args, signal = deadline) => {
    const res = await fetchImpl(mcpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
      signal,
    });
    const text = await res.text();
    const body = text.includes('data:') ? text.split('data:').pop() : text;
    const json = JSON.parse(body.trim());
    if (json.error) throw new Error(json.error.message ?? 'obscura error');
    return json.result?.content?.find((c) => c.type === 'text')?.text ?? '';
  };
  try {
    await call(1, 'browser_navigate', { url, waitUntil: 'load', timeout: timeoutMs });
    // Late scripts get a moment, bounded and inside the same budget.
    await Promise.race([
      sleep(Math.min(settleMs, 2_000)),
      new Promise((_, reject) =>
        deadline.addEventListener('abort', () => reject(deadline.reason), { once: true }),
      ),
    ]);
    return await call(2, 'browser_evaluate', {
      expression: 'document.documentElement.outerHTML',
    });
  } finally {
    // Close the tab whatever happened, on its own short budget.
    await call(3, 'browser_close', {}, AbortSignal.timeout(5_000)).catch(() => {});
  }
}

/**
 * Read one host: find its platform and listing, walk the groups, parse the
 * products. Returns items and a one-line note; never throws for a host
 * that is merely unhelpful.
 */
export async function readHost(
  start,
  { http, env, log, deadline, maxRequests = 40, sleep = Bun.sleep, userAgent },
) {
  const note = (s) => `${registrableDomain(new URL(start).hostname)}: ${s}`;
  const robots = new Map();
  let requests = 0;
  const get = async (url) => {
    const u = new URL(url);
    if (!robots.has(u.origin)) {
      requests++;
      const txt = await http.request(`${u.origin}/robots.txt`).then(
        (r) => (r.ok ? r.text() : ''),
        () => '',
      );
      robots.set(u.origin, txt);
    }
    if (!robotsAllows(robots.get(u.origin), u.pathname + u.search, userAgent ?? 'niche-db'))
      return null;
    if (requests >= maxRequests || Date.now() > deadline) return null;
    if (requests > 1) await sleep(1000);
    requests++;
    const res = await http.request(url, { headers: { accept: 'text/html,*/*' } });
    const html = (await res.text()).slice(0, 600_000);
    return {
      status: res.status,
      url: res.url || url,
      html,
      cookies: typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [],
    };
  };

  const home = await get(start).catch(() => null);
  if (!home) return { items: [], note: note('unreachable or disallowed') };
  if (isChallenge(home.html, home.status))
    return { items: [], note: note('bot challenge, left alone') };
  if (home.status >= 400) return { items: [], note: note(`unreachable (${home.status})`) };

  let best = { platform: null, score: 0 };
  let listing = null;
  const consider = (page) => {
    const f = fingerprint(page.html, page.url, page.cookies);
    if (f.score > best.score) best = { ...f, origin: new URL(page.url).origin };
    if (
      f.platform &&
      SUPPORTED.includes(f.platform) &&
      isListing(f.platform, page.url) &&
      page.status === 200 &&
      !listing
    )
      listing = page;
  };
  consider(home);
  // Every supported platform's own shop paths on the page's origin and the
  // billing origins it links to, then the conventional billing subdomains.
  const probes = SUPPORTED.flatMap((k) => PLATFORMS[k].probes);
  const candidates = [
    ...shopLinks(home.html, home.url, 10),
    ...shopOrigins(home.html, home.url).flatMap((o) => probes.map((p) => o + p)),
    ...guessedShopOrigins(home.url).flatMap((o) =>
      ['/cart.php', '/order/', '/cart/'].map((p) => o + p),
    ),
  ];
  const seen = new Set([home.url]);
  for (const url of candidates) {
    if (listing || seen.has(url)) continue;
    seen.add(url);
    const page = await get(url).catch(() => null);
    if (!page || page.status >= 400 || isChallenge(page.html, page.status)) continue;
    consider(page);
  }
  if (!best.platform || !SUPPORTED.includes(best.platform))
    return {
      items: [],
      note: note(best.platform ? `${best.platform}, no parser` : 'no storefront found'),
    };
  if (!listing) return { items: [], note: note(`${best.platform}, no listing found`) };

  const platform = best.platform;
  const parser = PARSERS[platform];
  const domain = registrableDomain(new URL(listing.url).hostname);
  const provider = findhostIdFor(listing.url) ?? domain;
  const providerName = providerNameOf(listing.html, domain);
  const fetchedAt = new Date().toISOString();
  const products = new Map();
  const groups = [listing.url, ...parser.groups(listing.html, listing.url)]
    .filter((g, i, a) => a.indexOf(g) === i)
    .slice(0, 25);
  let rendered = 0;
  for (const g of groups) {
    const page = g === listing.url ? listing : await get(g).catch(() => null);
    if (!page || page.status >= 400) continue;
    let parsed = parser.parse(page.html, page.url);
    if (!parsed.length && env?.obscuraMcpUrl && rendered < 5) {
      rendered++;
      const html = await renderWithObscura(env.obscuraMcpUrl, page.url).catch((err) => {
        log(note(`obscura failed on ${page.url}: ${err.message.slice(0, 60)}`));
        return '';
      });
      if (html) parsed = parser.parse(html, page.url);
    }
    for (const p of parsed) products.set(p.id, p);
    if (Date.now() > deadline) break;
  }
  // Two products with one name (the same plan in two groups or locations)
  // are two offers: say which, so they never read as a duplicate.
  const byName = new Map();
  for (const p of products.values()) {
    const n = cleanName(p.name).name.toLowerCase();
    byName.set(n, (byName.get(n) ?? 0) + 1);
  }
  const items = [...products.values()].map((p) => {
    const n = cleanName(p.name).name;
    const label = byName.get(n.toLowerCase()) > 1 && p.group ? `${n} (${p.group})` : p.name;
    return productItem(
      { ...p, name: label },
      { platform, domain, provider, providerName, fetchedAt },
    );
  });
  return {
    items,
    note: note(
      `${platform}, ${groups.length} groups, ${items.length} products${rendered ? `, ${rendered} rendered` : ''}`,
    ),
  };
}

/**
 * The company's name, off the shop page's title: a WHMCS cart is titled
 * "Shopping Cart - Servitro", a Blesta order form "Order - Northwind", so
 * the name is whichever segment is not one of the platform's own words. A
 * title that yields nothing leaves the domain, which is at least true.
 */
export function providerNameOf(html, domain) {
  const t = String(html ?? '').match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  if (!t) return domain;
  const generic =
    /^(shopping cart|cart|store|order|client area|clientarea|billing|portal|products?|packages?|home|welcome|checkout|login|my account|order form|security verification|just a moment)$/i;
  const parts = t
    .replace(/\s+/g, ' ')
    .replace(/&amp;/g, '&')
    .split(/\s*[|–—:»«-]\s*/)
    .map((s) => s.trim())
    .filter((s) => s && !generic.test(s));
  return (parts.sort((a, b) => a.length - b.length)[0] ?? domain).slice(0, 60) || domain;
}

export const storefront = defineAdapter({
  name: 'storefront',
  title: 'Hosting storefronts',
  collection: 'hosting',
  description:
    'The catalogues of the small hosts, read off the billing platform each runs: WHMCS, Blesta and WooCommerce order forms parsed into OpenServer offers with name, price and cycle, and the vCPU, RAM, disk, transfer and locations the description states. One polite visit a day per host, robots.txt honoured, bot challenges left alone. Keyless; an Obscura MCP server (OBSCURA_MCP_URL) renders the few shops that need JavaScript.',
  docs: 'https://docs.whmcs.com/8.x/products-and-services/',
  kinds: ['plan', 'addon'],
  cadenceMinutes: 1440,
  configFields: [
    {
      key: 'hosts',
      label: 'Hosts',
      type: 'list',
      placeholder: 'https://my.example.com/cart.php',
      help: 'Provider home pages or shop URLs to read. The default is every host the storefront survey found running a supported platform.',
    },
    {
      key: 'maxHosts',
      label: 'Hosts per run',
      type: 'number',
      placeholder: '60',
      help: 'How many hosts one run reads; the rest wait for the next run, in rotation.',
    },
    {
      key: 'discover',
      label: 'Discovery feeds',
      type: 'list',
      placeholder: 'les, lowendbox',
      help: 'Offer forums read for hosts not yet on the list: les (LowEndSpirit offers), lowendbox, lowendbox-gpu. Empty turns discovery off.',
    },
  ],
  defaults: { hosts: [], maxHosts: 60, discover: Object.keys(DISCOVERY_FEEDS) },
  defaultSources: [
    {
      slug: 'storefronts',
      name: 'Hosting: storefront catalogues',
      description:
        'Plans read daily off the WHMCS, Blesta and WooCommerce order forms of the small hosts the storefront survey found.',
      config: { hosts: [], maxHosts: 60, discover: Object.keys(DISCOVERY_FEEDS) },
    },
  ],
  async pull({ config, cursor, env, http, log, deadline, previous, sleep = Bun.sleep }) {
    const configured = (
      Array.isArray(config.hosts) ? config.hosts : String(config.hosts ?? '').split(',')
    )
      .map((h) => String(h).trim())
      .filter(Boolean)
      .map((h) => (/^https?:\/\//.test(h) ? h : `https://${h}/`));
    const feeds = (
      Array.isArray(config.discover) ? config.discover : String(config.discover ?? '').split(',')
    )
      .map((f) => String(f).trim())
      .filter((f) => DISCOVERY_FEEDS[f]);

    // 1. New hosts from the offer forums, only threads newer than each feed's mark.
    let discovery = {
      discovered: cursor?.discovered ?? [],
      pages: cursor?.pages ?? {},
      done: cursor?.done ?? {},
      marks: cursor?.marks ?? {},
      at: cursor?.discoveredAt ?? null,
    };
    let pending = Array.isArray(cursor?.pending) ? [...cursor.pending] : [];
    const everyMs = (Number(config.discoverEveryMinutes) || 180) * 60_000;
    const due = !discovery.at || Date.now() - Date.parse(discovery.at) >= everyMs;
    const backfilling = feeds.some((f) => !discovery.done[f]);
    let discoveryNote = '';
    if (feeds.length && (due || backfilling)) {
      const d = await discover({
        http,
        state: discovery,
        feeds,
        maxRequests: Number(config.discoveryRequests) || 20,
        deadline: Math.min(deadline, Date.now() + 90_000),
        sleep,
        log,
      });
      discovery = {
        discovered: d.discovered,
        pages: d.pages,
        done: d.done,
        marks: d.marks,
        at: new Date().toISOString(),
      };
      pending.push(...d.addedHosts.map((h) => h.start ?? `https://${h.domain}/`));
      const fresh = Object.entries(d.fresh)
        .map(([k, n]) => `${k} ${n}`)
        .join(', ');
      discoveryNote = `; forums: ${fresh || 'none'} new threads, ${d.added} new hosts (${d.discovered.length} known)`;
      log(`discovery: ${fresh} new threads, ${d.added} new hosts, ${d.requests} requests`);
    }

    // 2. Who to read: hosts never read yet first, then the daily rotation.
    const hosts = hostList(
      configured.length ? configured : surveyedHosts(),
      discovery.discovered,
      config.seeds === false ? [] : undefined,
    );
    if (!hosts.length) return { items: [], note: 'no hosts configured and no survey fixture' };
    const perRun = Math.max(1, Number(config.maxHosts) || 60);
    const firstReads = pending.slice(0, Math.ceil(perRun / 3));
    const startAt = Number(cursor?.next ?? 0) % hosts.length;
    const want = perRun - firstReads.length;
    const rotation = hosts.slice(startAt, startAt + want);
    if (rotation.length < want) rotation.push(...hosts.slice(0, want - rotation.length));
    const batch = [
      ...firstReads.map((host) => ({ host, first: true })),
      ...rotation.map((host) => ({ host, first: false })),
    ];

    // 3. Read them, a few at a time.
    const results = [];
    const notes = [];
    let readRotation = 0;
    const firstDone = new Set();
    let at = 0;
    const CONCURRENCY = 4;
    const worker = async () => {
      while (at < batch.length && Date.now() < deadline) {
        const { host, first } = batch[at++];
        const r = await readHost(host, { http, env, log, deadline, sleep }).catch((err) => ({
          items: [],
          note: `${host}: ${err.message.slice(0, 60)}`,
        }));
        results.push(r);
        notes.push(r.note);
        if (first) firstDone.add(host);
        else readRotation++;
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    pending = pending.filter((h) => !firstDone.has(h));

    // 4. What is new on each host since its last read, and what it stopped selling.
    const known = { ...(cursor?.hosts ?? {}) };
    const { items, newOfferings, newGroups, retired } = await diffHosts(results, {
      known,
      previous,
      now: new Date().toISOString(),
    });

    const withPlans = notes.filter((n) => /\d+ products/.test(n) && !/ 0 products/.test(n)).length;
    for (const n of notes) log(n);
    // A lap of the whole list a day: each run reads what fits its deadline,
    // so the source comes back as often as one lap of `hosts` needs.
    const nextAt = (startAt + readRotation) % hosts.length;
    const runsPerDay = Math.ceil(hosts.length / Math.max(1, readRotation));
    const nextInMinutes = Math.max(30, Math.min(1440, Math.floor(1440 / Math.max(1, runsPerDay))));
    return {
      items,
      cursor: {
        next: nextAt,
        pending,
        hosts: known,
        discovered: discovery.discovered,
        pages: discovery.pages,
        done: discovery.done,
        marks: discovery.marks,
        discoveredAt: discovery.at,
      },
      nextInMinutes,
      note: `${items.length} products from ${withPlans} of ${results.length} hosts (list ${hosts.length}, ${pending.length} awaiting a first read); ${newOfferings} new offerings, ${newGroups} new groups, ${retired} discontinued${discoveryNote}`,
    };
  },
});
