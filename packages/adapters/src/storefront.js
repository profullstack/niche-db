import { readFileSync } from 'node:fs';
import { defineAdapter } from '@nichedb/core/adapter';
import { offer, offerItem } from './hosting.js';
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

/** One parsed product as a hosting item. */
export function productItem(product, { platform, domain, provider, providerName, fetchedAt }) {
  const specs = parseSpecs(product.description);
  const countries = parseCountries(`${product.name} ${product.group ?? ''} ${product.description}`);
  const price = normalisePrice(product.price, product.cycle);
  const kind = kindOf(product.group, product.name);
  const o = offer({
    id: product.id,
    name: product.name,
    url: product.url,
    kind,
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
    currency: product.price?.currency ?? 'USD',
    interval: price.interval,
    stock: product.stock,
    updated: fetchedAt,
  });
  const item = offerItem({
    provider,
    providerName,
    offer: o,
    extraTags: [
      `platform:${platform}`,
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

/** Ask an Obscura MCP server for a page's rendered HTML. */
export async function renderWithObscura(mcpUrl, url, { timeoutMs = 60_000 } = {}) {
  const call = async (id, name, args) => {
    const res = await fetch(mcpUrl, {
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
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    const body = text.includes('data:') ? text.split('data:').pop() : text;
    const json = JSON.parse(body.trim());
    if (json.error) throw new Error(json.error.message ?? 'obscura error');
    return json.result?.content?.find((c) => c.type === 'text')?.text ?? '';
  };
  await call(1, 'browser_navigate', { url, waitUntil: 'networkidle' });
  const html = await call(2, 'browser_evaluate', {
    expression: 'document.documentElement.outerHTML',
  });
  await call(3, 'browser_close', {}).catch(() => {});
  return html;
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
      const txt = await http.request(`${u.origin}/robots.txt`, { timeoutMs: 15_000 }).then(
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
    const res = await http.request(url, {
      headers: { accept: 'text/html,*/*' },
      timeoutMs: 15_000,
    });
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
  const items = [...products.values()].map((p) =>
    productItem(p, { platform, domain, provider, providerName, fetchedAt }),
  );
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
  kinds: ['plan'],
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
  ],
  defaults: { hosts: [], maxHosts: 60 },
  defaultSources: [
    {
      slug: 'storefronts',
      name: 'Hosting: storefront catalogues',
      description:
        'Plans read daily off the WHMCS, Blesta and WooCommerce order forms of the small hosts the storefront survey found.',
      config: { hosts: [], maxHosts: 60 },
    },
  ],
  async pull({ config, cursor, env, http, log, deadline, sleep = Bun.sleep }) {
    const configured = (
      Array.isArray(config.hosts) ? config.hosts : String(config.hosts ?? '').split(',')
    )
      .map((h) => String(h).trim())
      .filter(Boolean)
      .map((h) => (/^https?:\/\//.test(h) ? h : `https://${h}/`));
    const hosts = configured.length ? configured : surveyedHosts();
    if (!hosts.length) return { items: [], note: 'no hosts configured and no survey fixture' };
    const perRun = Math.max(1, Number(config.maxHosts) || 60);
    const startAt = Number(cursor?.next ?? 0) % hosts.length;
    const batch = hosts.slice(startAt, startAt + perRun);
    if (batch.length < perRun) batch.push(...hosts.slice(0, perRun - batch.length));
    const items = [];
    const notes = [];
    let read = 0;
    const CONCURRENCY = 4;
    let next = 0;
    const worker = async () => {
      while (next < batch.length && Date.now() < deadline) {
        const host = batch[next++];
        const r = await readHost(host, { http, env, log, deadline, sleep }).catch((err) => ({
          items: [],
          note: `${host}: ${err.message.slice(0, 60)}`,
        }));
        items.push(...r.items);
        notes.push(r.note);
        read++;
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    const withPlans = notes.filter((n) => /\d+ products$/.test(n) && !/ 0 products/.test(n)).length;
    for (const n of notes) log(n);
    return {
      items,
      cursor: { next: (startAt + read) % hosts.length },
      note: `${items.length} products from ${withPlans} of ${read} hosts`,
    };
  },
});
