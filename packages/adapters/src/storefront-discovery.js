import { registrableDomain } from './storefront-platforms.js';

/**
 * Where the storefront source finds hosts it has not read before.
 *
 * The survey list (`storefront-survey.json`) was a snapshot of 683 hosts in
 * 2026-09, and only ~100 of them had a shop worth reading. The small hosts
 * that matter announce themselves in the offer forums, every week, with a
 * link to their own order page. So the storefront source reads those
 * announcements and keeps every provider they link to:
 *
 * - LowEndSpirit's Offers category (`lowendspirit.com/categories/offers`),
 *   whose RSS pages back to 2022 answer keyless. Posting there needs a
 *   provider tag the moderators hand out, so nearly every post is a host.
 *   Its Vanilla API (`/api/v2`) answers 403, the RSS is what it offers.
 * - LowEndBox's feed (`lowendbox.com/feed/?paged=N`), deal posts plus
 *   editorial, so a LowEndBox post counts only when it links a host's own
 *   order page (cart, store, order form).
 *
 * LowEndTalk and WebHostingTalk would be the obvious next two, and both
 * answer every path, robots.txt and RSS included, with a Cloudflare
 * challenge (checked 2026-11-15). A challenge is a refusal and is left
 * alone, the same rule the storefront reader follows for hosts.
 *
 * Only the provider's DOMAIN and the address of its own shop are kept: no
 * prices, specs or text from the forum post. The plans come from the host's
 * own order form when the storefront reader visits it.
 *
 * Discovery state lives in the source cursor: `discovered` is the list of
 * hosts in the order they were found (so the rotation index stays stable as
 * it grows), `pages` how far back each feed's backfill has reached.
 */

/** Feeds the storefront source reads for hosts. `page` is 1-based. */
export const DISCOVERY_FEEDS = {
  les: {
    name: 'LowEndSpirit offers',
    url: (page) => `https://lowendspirit.com/categories/offers/p${page}/feed.rss`,
    // Every post is a provider's own announcement: the most-linked domain is the host.
    needsOrderLink: false,
    maxPages: 80,
  },
  lowendbox: {
    name: 'LowEndBox',
    url: (page) => `https://lowendbox.com/feed/?paged=${page}`,
    // Editorial too: only a post linking a host's order page counts.
    needsOrderLink: true,
    maxPages: 120,
  },
};

/**
 * Hosts named by hand: independent VPS, dedicated and GPU sellers that a
 * reader of r4ck would expect and that run a shop the storefront reader can
 * try. Home pages only; the reader finds the shop.
 */
export const SEED_HOSTS = [
  'https://racknerd.com/',
  'https://buyvm.net/',
  'https://greencloudvps.com/',
  'https://hosthatch.com/',
  'https://www.interserver.net/',
  'https://www.hostwinds.com/',
  'https://servarica.com/',
  'https://www.time4vps.com/',
  'https://webdock.io/',
  'https://hosteons.com/',
  'https://www.netcup.com/',
  'https://contabo.com/',
  'https://www.kamatera.com/',
  'https://www.leaseweb.com/',
  'https://phoenixnap.com/',
  'https://dedirock.com/',
  'https://www.dedispec.com/',
  'https://www.ioflood.com/',
  'https://www.reliablesite.net/',
  'https://www.hivelocity.net/',
  'https://www.colocrossing.com/',
  'https://www.quickpacket.com/',
  'https://www.spartanhost.net/',
  'https://www.cloudcone.com/',
  'https://www.virmach.com/',
  'https://www.hostdare.com/',
  'https://clouvider.com/',
  'https://www.terrahost.com/',
  'https://crunchbits.com/',
  'https://www.advinservers.com/',
  'https://www.nexusbytes.com/',
  'https://www.ethernetservers.com/',
  'https://www.kuroit.com/',
  'https://www.alexhost.com/',
  'https://www.hostsailor.com/',
  'https://www.vpsdime.com/',
  'https://www.letbox.com/',
  'https://www.inceptionhosting.com/',
  'https://www.liteserver.nl/',
  'https://www.misaka.io/',
];

/** Hosts that are never a provider's own shop: forums, socials, tools, the big clouds already read by API. */
const NOT_A_HOST =
  /(^|\.)(lowendspirit|lowendtalk|lowendbox|webhostingtalk|serverhunter|imgur|github|githubusercontent|gitlab|twitter|x|facebook|fb|t|telegram|discord|discordapp|youtube|youtu|linkedin|google|googleusercontent|gstatic|cloudflare|he|bgp|ipinfo|trustpilot|wikipedia|reddit|redd|instagram|tiktok|speedtest|hetrixtools|uptimerobot|statuspage|ripe|arin|apnic|peeringdb|archive|paypal|stripe|imgbb|ibb|postimg|postimages|gravatar|w3|apple|microsoft|amazon|amazonaws|nodeseek|hostloc|pastebin|ptpimg|vgy|bit|tinyurl|geekbench|whois|mxtoolbox|namecheap|letsencrypt|proxmox|debian|ubuntu|centos|freebsd|netbsd|openbsd|rockylinux|almalinux|virtualizor|solusvm|whmcs|cpanel|directadmin|plesk|kernel|vultr|ovh|ovhcloud|hetzner|scaleway|linode|akamai|digitalocean|intel|amd|nvidia|wordpress|wp|gmpg|feedburner|porkbun|godaddy|imunify360|cloudlinux|litespeedtech|serververify|yabs|bench|dropbox|mega|wetransfer|gofile|catbox|tenor|giphy|vimeo|twitch|spotify|medium|substack|ghost|notion|docs|forms|calendly|zoom|mailchimp|sendgrid|wa|whatsapp|wechat|qq|baidu|yandex|vk|ok|bing|duckduckgo|chatgpt|openai|anthropic|claude)\.[a-z.]+$/i;

const ORDER_LINK =
  /cart\.php|\/store\/|\/order(?:\/|\.php|$)|\/cart\/|index\.php\?rp=\/store|[?&]cmd=cart|\/billing\/|\/clients?\/(?:cart|store|index)/i;

const decode = (s) =>
  String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&');

/** A link's registrable domain, or null for anything that is not a provider's own host. */
export function providerDomain(link) {
  let host;
  try {
    host = new URL(link).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!host.includes('.') || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;
  const domain = registrableDomain(host);
  if (!domain || NOT_A_HOST.test(domain)) return null;
  return domain;
}

/**
 * Providers announced in one RSS page: `[{ domain, start, title }]`, one per
 * post at most. A post's host is the domain it links most; `start` is the
 * origin of the shop it links (a billing subdomain says where the order form
 * is), or the domain's home page.
 */
export function providersInFeed(xml, { needsOrderLink = false } = {}) {
  const out = [];
  for (const [, item] of String(xml ?? '').matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const body = decode(item);
    const title = body.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/)?.[1]?.trim();
    const date = Date.parse(body.match(/<pubDate>([^<]+)<\/pubDate>/)?.[1] ?? '');
    const publishedAt = Number.isFinite(date) ? new Date(date).toISOString() : null;
    const guid = body.match(/<guid[^>]*>([^<]+)<\/guid>/)?.[1]?.trim() ?? null;
    const counts = new Map();
    const shops = new Map();
    for (const [, link] of body.matchAll(/href=["'](https?:\/\/[^"'\s<>]+)["']/gi)) {
      const domain = providerDomain(link);
      if (!domain) continue;
      counts.set(domain, (counts.get(domain) ?? 0) + 1);
      if (!shops.has(domain) && ORDER_LINK.test(link)) shops.set(domain, new URL(link).origin);
    }
    if (!counts.size) {
      out.push({ domain: null, start: null, title, publishedAt, guid });
      continue;
    }
    const ranked = [...counts].sort((a, b) => b[1] - a[1]);
    const withShop = ranked.find(([d]) => shops.has(d));
    const [domain] = needsOrderLink ? (withShop ?? []) : (withShop ?? ranked[0]);
    out.push({
      domain: domain ?? null,
      start: domain ? (shops.get(domain) ? `${shops.get(domain)}/` : `https://${domain}/`) : null,
      title,
      publishedAt,
      guid,
    });
  }
  return out;
}

/** Add `found` to the discovered list, one entry per domain, keeping the order hosts were first seen. */
export function mergeDiscovered(discovered, found, via) {
  const list = Array.isArray(discovered) ? [...discovered] : [];
  const have = new Set(list.map((h) => h.domain));
  let added = 0;
  for (const f of found) {
    if (!f.domain || have.has(f.domain)) continue;
    have.add(f.domain);
    list.push({ domain: f.domain, start: f.start, via });
    added++;
  }
  return { list, added };
}

/**
 * One discovery pass, incremental.
 *
 * Each feed keeps a high-water mark, `marks[feed]`: the newest post date it
 * has processed. A pass reads the feed from page 1 and keeps paging only
 * while a page still holds posts newer than the mark (the feeds sort by last
 * activity, so an old thread bumped to the top does not end the walk early),
 * so only NEW threads are looked at and a second pass in a row reads one page
 * and finds nothing new. Once, on the first
 * runs, the archive behind the mark is walked a slice per run (`pages`
 * remembers how deep it got, `done` that it reached the end); after that,
 * never again. Never throws; a feed that fails keeps its mark and is tried
 * next run.
 */
export async function discover({
  http,
  state = {},
  feeds = Object.keys(DISCOVERY_FEEDS),
  maxRequests = 30,
  deadline = Date.now() + 60_000,
  sleep = Bun.sleep,
  log = () => {},
}) {
  let discovered = state.discovered ?? [];
  const pages = { ...(state.pages ?? {}) };
  const done = { ...(state.done ?? {}) };
  const marks = { ...(state.marks ?? {}) };
  const fresh = {};
  let requests = 0;
  let added = 0;
  const addedHosts = [];
  const take = (key, found) => {
    const merged = mergeDiscovered(discovered, found, key);
    addedHosts.push(...merged.list.slice(discovered.length));
    discovered = merged.list;
    added += merged.added;
  };
  const read = async (key, page) => {
    const feed = DISCOVERY_FEEDS[key];
    if (requests > 0) await sleep(1000);
    requests++;
    const res = await http.request(feed.url(page), {
      headers: { accept: 'application/rss+xml, text/xml, */*' },
      timeoutMs: 30_000,
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${res.status}`);
    return providersInFeed(await res.text(), feed);
  };
  const active = feeds.filter((k) => DISCOVERY_FEEDS[k]);

  // New threads since the mark.
  for (const key of active) {
    const mark = marks[key] ?? null;
    let newest = mark;
    fresh[key] = 0;
    for (let page = 1; page <= DISCOVERY_FEEDS[key].maxPages; page++) {
      if (requests >= maxRequests || Date.now() > deadline) break;
      let found;
      try {
        found = await read(key, page);
      } catch (err) {
        log(`discovery ${key} p${page} failed: ${err.message}`);
        break;
      }
      if (!found?.length) break;
      const unseen = found.filter((f) => !mark || !f.publishedAt || f.publishedAt > mark);
      fresh[key] += unseen.length;
      take(key, unseen);
      for (const f of found)
        if (f.publishedAt && (!newest || f.publishedAt > newest)) newest = f.publishedAt;
      // No mark yet: page 1 sets it and the archive is the backfill's job.
      if (!mark || unseen.length === 0) break;
    }
    if (newest) marks[key] = newest;
    if (!mark && pages[key] === undefined) pages[key] = 1;
  }

  // The archive, once, a slice per run, round robin across feeds.
  let progress = true;
  while (progress && requests < maxRequests && Date.now() < deadline) {
    progress = false;
    for (const key of active) {
      if (done[key] || requests >= maxRequests || Date.now() > deadline) continue;
      const page = (pages[key] ?? 1) + 1;
      if (page > DISCOVERY_FEEDS[key].maxPages) {
        done[key] = true;
        continue;
      }
      let found;
      try {
        found = await read(key, page);
      } catch (err) {
        log(`discovery ${key} p${page} failed: ${err.message}`);
        continue;
      }
      if (!found) done[key] = true;
      else {
        take(key, found);
        pages[key] = page;
      }
      progress = true;
    }
  }
  return { discovered, pages, done, marks, fresh, added, addedHosts, requests };
}

/** The storefront host list: configured or surveyed hosts, then the seeds, then everything discovered, one per domain. */
export function hostList(base, discovered = [], seeds = SEED_HOSTS) {
  const seen = new Set();
  const out = [];
  const add = (url) => {
    let domain;
    try {
      domain = registrableDomain(new URL(url).hostname);
    } catch {
      return;
    }
    if (!domain || seen.has(domain)) return;
    seen.add(domain);
    out.push(url);
  };
  for (const h of base) add(h);
  for (const h of seeds) add(h);
  for (const h of discovered) add(h.start ?? `https://${h.domain}/`);
  return out;
}
