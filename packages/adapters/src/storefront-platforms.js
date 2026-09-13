/**
 * Which storefront a hosting provider runs, read off its own pages.
 *
 * The small hosts -- the ones with no API, the ones LowEndBox writes about --
 * do not build their own shop. They install a billing platform and let it
 * render the order form, and there are only a handful of those platforms.
 * That is the whole reason a directory can read their prices: one parser per
 * platform reads every host that runs it, where one parser per host would be
 * a thousand parsers. The measurement of which platforms those are is
 * `scripts/survey-storefronts.js`, and its result table is a fixture the
 * `storefront` adapter reads its default host list from.
 *
 * A platform is recognised by the marks it leaves that a host does not edit:
 * the paths its order form lives at (`/cart.php?gid=` is WHMCS and nothing
 * else), the theme directories it ships, the cookie it sets, its own name in
 * a script path or a footer credit. Any one of them is a hint; a decision
 * needs a strong mark or two weak ones, because "cart" and "order" appear on
 * every shop on earth.
 *
 * Nothing here fetches. Detection is a function of HTML, its URL and its
 * response headers, so it is testable from saved pages; the fetching, with its
 * robots check and its one-request-a-second manners, is in the survey script
 * and the adapter.
 */

/**
 * The platforms, with the marks that identify them. `strong` marks decide on
 * their own; `weak` ones need company. `listing` is the path pattern a product
 * listing answers at, used both to recognise a page as a listing and to find
 * one from a home page's links.
 */
export const PLATFORMS = {
  whmcs: {
    name: 'WHMCS',
    strong: [
      /cart\.php\?(?:a=|gid=|rp=)/i,
      /clientarea\.php/i,
      /\/templates\/(?:six|twenty-one|lagom2?|standard_cart|orderforms)\//i,
      /index\.php\?rp=\/(?:store|login|knowledgebase)/i,
      /\bWHMCS\b/,
    ],
    weak: [/\/store\/[a-z0-9-]+/i, /csrfToken/, /submitticket\.php/i, /knowledgebase\.php/i],
    cookie: /^WHMCS/i,
    listing: /\/cart\.php(?:\?gid=\d+)?$|\/cart\.php\?gid=\d+|\/store\/[a-z0-9-]+\/?$/i,
    probes: ['/cart.php', '/store/', '/clientarea.php', '/index.php?rp=/store'],
  },
  blesta: {
    name: 'Blesta',
    strong: [/\/order\/main\/(?:index|packages|configure)\//i, /\bBlesta\b/, /\/plugins\/order\//i],
    weak: [/\/client\/login\/?/i, /\/order\/?["']/i],
    cookie: /^blesta_sid$/i,
    listing: /\/order\/main\/(?:index|packages)\/[a-z0-9_-]+\/?$|\/order\/forms\/?$|\/order\/?$/i,
    probes: ['/order/', '/order/forms/', '/client/login/'],
  },
  hostbill: {
    name: 'HostBill',
    strong: [/\bHostBill\b/i, /index\.php\?\/cart\//i, /\/cart\/&step=/i, /hostbillapp/i],
    weak: [/\/clientarea\/?["']/i, /\/cart\/?["']/i],
    cookie: /^HBSESSID|^hb_/i,
    listing: /\/cart\/[a-z0-9_-]+\/?$|\/cart\/?$|index\.php\?\/cart\//i,
    probes: ['/cart/', '/clientarea/'],
  },
  paymenter: {
    name: 'Paymenter',
    strong: [/\bPaymenter\b/i],
    weak: [/wire:snapshot/, /\/products\/[a-z0-9-]+/i],
    cookie: /^paymenter_session$/i,
    listing: /\/products\/[a-z0-9-]+\/?$/i,
    probes: ['/products', '/login'],
  },
  fossbilling: {
    name: 'FOSSBilling',
    strong: [/\bFOSSBilling\b/i, /\bBoxBilling\b/i, /\/themes\/huraga\//i],
    // `_url=/order` is Phalcon's router, which FOSSBilling uses and so do
    // unrelated sites (jimdo.com, hollywoodreporter.com scored on it), so it
    // is a hint and not a decision.
    weak: [/_url=\/order/i, /\/order\/[a-z0-9-]+["']/i],
    cookie: /^BOXCLR$/i,
    listing: /\/order\/?$|_url=\/order/i,
    probes: ['/index.php?_url=/order', '/order'],
  },
  clientexec: {
    name: 'ClientExec',
    strong: [/\bClientExec\b/i, /index\.php\?fuse=/i],
    weak: [],
    cookie: /^CE_/i,
    listing: /fuse=home&controller=packages|fuse=home$/i,
    probes: ['/index.php?fuse=home&controller=packages'],
  },
  upmind: {
    name: 'Upmind',
    strong: [/\bupmind\.com\b/i, /\bUpmind\b/],
    weak: [],
    cookie: /^upmind/i,
    listing: /\/store\/?$/i,
    probes: ['/store/'],
  },
  woocommerce: {
    name: 'WooCommerce',
    strong: [/\bwoocommerce\b/i],
    weak: [/\/product-category\//i, /\/product\/[a-z0-9-]+/i],
    cookie: /^woocommerce_/i,
    listing: /\/product-category\/[a-z0-9-]+\/?$|\/shop\/?$/i,
    probes: ['/shop/'],
  },
};

export const PLATFORM_NAMES = Object.keys(PLATFORMS);

/**
 * What a page says about the platform that rendered it.
 *
 * Every platform is scored -- 2 a strong mark, 1 a weak one, 2 for its
 * cookie -- and the best wins, but only with a strong mark or the cookie
 * among its evidence: two weak marks never decide, because `/store/` and a
 * csrfToken are what half the web's marketing sites carry (weebly.com scored
 * "WHMCS" that way in the first survey pass). The evidence is the marks that matched, as
 * strings, so a survey row can be read back and argued with.
 *
 * @param {string} html
 * @param {string} url            the URL the page was read from, after redirects
 * @param {string[]} [setCookies] the response's set-cookie headers
 * @returns {{platform: string|null, score: number, evidence: string[]}}
 */
export function fingerprint(html, url = '', setCookies = []) {
  const text = String(html ?? '').slice(0, 400_000);
  const cookieNames = setCookies.map((c) => String(c).split('=')[0].trim());
  let best = { platform: null, score: 0, evidence: [] };
  for (const [key, p] of Object.entries(PLATFORMS)) {
    const evidence = [];
    let score = 0;
    for (const re of p.strong) {
      if (re.test(text) || re.test(url)) {
        score += 2;
        evidence.push(`strong:${re.source.slice(0, 40)}`);
      }
    }
    for (const re of p.weak) {
      if (re.test(text)) {
        score += 1;
        evidence.push(`weak:${re.source.slice(0, 40)}`);
      }
    }
    if (p.cookie && cookieNames.some((n) => p.cookie.test(n))) {
      score += 2;
      evidence.push('cookie');
    }
    if (score > best.score) best = { platform: key, score, evidence };
  }
  const decided =
    best.score >= 2 && best.evidence.some((e) => e.startsWith('strong:') || e === 'cookie');
  return decided ? best : { platform: null, score: best.score, evidence: best.evidence };
}

/** True when this URL looks like the platform's product listing. */
export function isListing(platform, url) {
  const p = PLATFORMS[platform];
  if (!p) return false;
  try {
    const u = new URL(url);
    return p.listing.test(u.pathname + u.search);
  } catch {
    return false;
  }
}

const BILLING_HINT =
  /cart\.php|clientarea|\/store\/|\/order\/|\/client\/login|\/cart\/|\/products\b|_url=\/order|fuse=|\/shop\/|\/pricing|\/plans|\/vps|\/dedicated|\/hosting/i;
const BILLING_HOST =
  /^(?:billing|my|clients?|portal|manage|secure|account|cp|panel|shop|store|order)\./i;

/**
 * The links on a page that could lead to a shop: order-form paths, pricing
 * pages, and any link into a billing subdomain of the same registrable
 * domain. Absolute, deduplicated, same site only, at most `limit`.
 *
 * @param {string} html
 * @param {string} baseUrl
 * @param {number} [limit]
 * @returns {string[]}
 */
export function shopLinks(html, baseUrl, limit = 40) {
  const out = new Set();
  const base = new URL(baseUrl);
  const site = registrableDomain(base.hostname);
  const re = /href\s*=\s*["']([^"'#]+)["']/gi;
  for (const m of String(html ?? '').matchAll(re)) {
    let u = null;
    try {
      u = new URL(m[1].trim(), base);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(u.protocol)) continue;
    if (registrableDomain(u.hostname) !== site) continue;
    const path = u.pathname + u.search;
    if (BILLING_HINT.test(path) || BILLING_HOST.test(u.hostname)) {
      u.hash = '';
      out.add(u.href);
      if (out.size >= limit) break;
    }
  }
  return [...out];
}

/** Origins worth probing for a shop: the page's own and every billing subdomain it links to. */
export function shopOrigins(html, baseUrl, limit = 3) {
  const origins = new Set([new URL(baseUrl).origin]);
  for (const link of shopLinks(html, baseUrl, 200)) {
    const u = new URL(link);
    if (
      BILLING_HOST.test(u.hostname) ||
      /cart\.php|clientarea|\/order\/|\/cart\//i.test(u.pathname)
    )
      origins.add(u.origin);
    if (origins.size >= limit) break;
  }
  return [...origins];
}

/**
 * The subdomains hosts conventionally put the billing platform on, for when
 * the home page said nothing: it was a challenge page, a JavaScript shell,
 * or a marketing site that links to the shop by a button no regex finds.
 */
export const BILLING_SUBDOMAINS = [
  'my',
  'billing',
  'clients',
  'client',
  'portal',
  'manage',
  'secure',
];

export function guessedShopOrigins(baseUrl) {
  const host = registrableDomain(new URL(baseUrl).hostname);
  return BILLING_SUBDOMAINS.map((s) => `https://${s}.${host}`);
}

/** A bot-challenge interstitial (Cloudflare and kin), which says nothing about the site behind it. */
export function isChallenge(html, status) {
  return (
    (status === 403 || status === 503 || status === 429) &&
    /just a moment|cf-challenge|challenge-platform|_cf_chl|attention required|ddos-guard|checking your browser/i.test(
      String(html ?? '').slice(0, 20_000),
    )
  );
}

/**
 * The registrable domain, near enough: the last two labels, or three when the
 * second-level label is a public one (`co.uk`, `com.au`). Enough to say that
 * `billing.example.com` and `www.example.com` are one host and
 * `example.co.uk` is not `co.uk`.
 */
export function registrableDomain(hostname) {
  const labels = String(hostname ?? '')
    .toLowerCase()
    .replace(/\.$/, '')
    .split('.');
  if (labels.length <= 2) return labels.join('.');
  const [tld, sld] = [labels.at(-1), labels.at(-2)];
  const publicSld = /^(co|com|net|org|ac|gov|edu|or|ne|go|in)$/.test(sld) && tld.length === 2;
  return labels.slice(publicSld ? -3 : -2).join('.');
}

/**
 * A robots.txt reader that answers one question: may `userAgent` fetch
 * `path`? Groups are matched on the token in our agent name, then `*`;
 * the longest matching rule wins, Allow beating Disallow on a tie, which
 * is the Google reading and the one most sites are written against.
 */
export function robotsAllows(robotsTxt, path, userAgent = '*') {
  const groups = [];
  let current = null;
  for (const raw of String(robotsTxt ?? '').split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      if (!current || current.rules.length) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if ((key === 'allow' || key === 'disallow') && current) {
      current.rules.push({ allow: key === 'allow', pattern: value });
    }
  }
  const token = String(userAgent).toLowerCase().split(/[\s/]/)[0];
  const pick =
    groups.find((g) => g.agents.some((a) => a !== '*' && token.includes(a))) ??
    groups.find((g) => g.agents.includes('*'));
  if (!pick) return true;
  let winner = null;
  for (const rule of pick.rules) {
    if (!rule.pattern) continue;
    if (matchRobots(rule.pattern, path)) {
      if (
        !winner ||
        rule.pattern.length > winner.pattern.length ||
        (rule.pattern.length === winner.pattern.length && rule.allow)
      )
        winner = rule;
    }
  }
  return winner ? winner.allow : true;
}

function matchRobots(pattern, path) {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = new RegExp(
    `^${body
      .split('*')
      .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}${anchored ? '$' : ''}`,
  );
  return re.test(path);
}
