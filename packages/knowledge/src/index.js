/**
 * Knowledge Influencers: the domain, with no database and no HTTP in it.
 *
 * A person who knows an industry supervises the agents building software and
 * data for it, and earns a share of what that niche makes — 20% at the start,
 * up to 80% as verified contribution accumulates. This package is the part of
 * that which is arithmetic: what a contribution is worth, what tier a score
 * has reached, what share that is, and how a settlement divides.
 *
 * Routes and tables live elsewhere on purpose. Everything here is pure, so
 * the numbers people are paid on can be replayed and checked.
 */

export {
  allocate,
  attributableNetMinor,
  CHOVY_EVENTS,
  DOMAIN_EVENT_VERSION,
  domainEvent,
  machineRevenueEvent,
  NICHEDB_EVENTS,
  PAYOUT_STATES,
  REVENUE_SOURCE_TYPES,
  splitSaleAcrossNiches,
} from './events.js';
export { dedupeKeyFor, diminishFactor, scoreContribution } from './score.js';
export {
  apportion,
  BASE_SHARE_BPS,
  CONTRIBUTION_TIERS,
  formatBps,
  formatMinor,
  MAX_SHARE_BPS,
  nextTierFor,
  shareBpsFor,
  splitShareBps,
  tierFor,
} from './tiers.js';
export {
  CONTRIBUTION_EVENT_TYPES,
  CONTRIBUTION_WEIGHTS,
  DIMINISH_WINDOW_DAYS,
  isKnownEventType,
  needsAttribution,
  TRUST_THRESHOLD,
} from './weights.js';

/**
 * Slugs a niche may never take, because its page is served from the site
 * root and one of these would shadow a real route. Checked when a niche is
 * created; the database's own shape check is the floor under it.
 */
export const RESERVED_NICHE_SLUGS = new Set([
  'about',
  'admin',
  'api',
  'assets',
  'c',
  'crawl',
  'dashboard',
  'docs',
  'f',
  'favicon.ico',
  'feeds',
  'following',
  'healthz',
  'i',
  'icons',
  'leaderboard',
  'llms.txt',
  'login',
  'logout',
  'manifest.webmanifest',
  'mcp',
  'niches',
  'opportunities',
  'pro',
  'robots.txt',
  's',
  'search',
  'sell',
  'settings',
  'sitemap.xml',
  'sources',
  'sw.js',
  'well-known',
]);

/** Is this slug safe to serve from the root? */
export const isReservedNicheSlug = (slug) =>
  RESERVED_NICHE_SLUGS.has(String(slug ?? '').toLowerCase());

/**
 * A jsonb column, as an object.
 *
 * Bun's driver passes a string parameter cast to `jsonb` straight through, so
 * a value written that way is stored as a jsonb STRING and read back as one.
 * The writes now cast through `text` and store the real structure, but rows
 * written before that fix are still strings, and a string reaching
 * `Object.keys` renders its characters as though they were fields. That is
 * exactly what shipped: two dimensions called `0` and `1`, holding a brace
 * each, on every opportunity page.
 *
 * So every read of one of these columns goes through here. It is the same
 * defence the ingest side already applies to a source's config.
 */
export function asJson(value, fallback = {}) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed === null || typeof parsed !== 'object' ? fallback : parsed;
    } catch {
      return fallback;
    }
  }
  return typeof value === 'object' ? value : fallback;
}

/** The same, for a column that should hold a list. */
export function asJsonArray(value) {
  const out = asJson(value, []);
  return Array.isArray(out) ? out : [];
}
