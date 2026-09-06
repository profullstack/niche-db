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
} from './events.js';
export { dedupeKeyFor, diminishFactor, scoreContribution } from './score.js';
export {
  BASE_SHARE_BPS,
  CONTRIBUTION_TIERS,
  formatBps,
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
