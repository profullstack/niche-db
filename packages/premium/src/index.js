/**
 * Premium: the membership a person buys, and everything it entitles them to.
 *
 * Pure. No database, no HTTP, no environment — prices and limits arrive as
 * arguments. That is what lets the entitlement table be tested on its own and
 * read straight onto the pricing page, so what the page promises and what the
 * code enforces are the same object rather than two lists that drift.
 *
 * Three plans, in order:
 *
 *   free     reads everything, pages and feeds carry one ad and a tracker
 *   premium  a dollar a day: no ads, the badge, the lounge, credits, early
 *            access, the appearance settings, the bigger API allowance
 *   pro      everything Premium has plus the operator tier: the top API
 *            allowance and a crawl pass for the whole term
 *
 * Pro is deliberately a superset. Somebody paying $120 a month must never
 * discover that the $30 tier had something theirs does not.
 */

export const PLANS = ['free', 'premium', 'pro'];

/** Higher wins when two things both say what a user is. */
const RANK = { free: 0, premium: 1, pro: 2 };

export const isPlan = (plan) => PLANS.includes(plan);

/** The better of two plans; unknown names count as free. */
export function bestPlan(a, b) {
  const left = RANK[a] ?? 0;
  const right = RANK[b] ?? 0;
  return left >= right ? (isPlan(a) ? a : 'free') : isPlan(b) ? b : 'free';
}

export const atLeast = (plan, floor) => (RANK[plan] ?? 0) >= (RANK[floor] ?? 0);

/**
 * What a user is, given their row and the membership terms they hold.
 *
 * An admin is Pro: the people running the deployment are not asked to buy
 * their own product. Terms are rows from `memberships` that have not expired;
 * the best plan among them wins, so a Premium member who buys Pro is Pro for
 * the overlap rather than being demoted by whichever row sorted first.
 */
export function planFor({ user, terms = [], now = new Date() } = {}) {
  if (!user) return 'free';
  if (user.role === 'admin') return 'pro';
  let plan = 'free';
  for (const term of terms) {
    if (term?.expires_at && new Date(term.expires_at) <= now) continue;
    plan = bestPlan(plan, term?.plan ?? 'pro');
  }
  return plan;
}

/* ------------------------------------------------------------ entitlements -- */

/** How many credits a month each plan is granted. Reddit's retired coin drip was 700. */
export const MONTHLY_CREDITS = { free: 0, premium: 1000, pro: 2000 };

/**
 * The whole entitlement table, one object per plan.
 *
 * `apiTier` names which of the configured per-hour limits applies rather than
 * carrying a number, because the numbers are deployment configuration and this
 * file is not allowed to read configuration.
 */
export function entitlements(plan = 'free') {
  const name = isPlan(plan) ? plan : 'free';
  const paid = name !== 'free';
  return Object.freeze({
    plan: name,
    /** Does a page or feed for this user carry the sponsored unit? */
    ads: !paid,
    tracking: !paid,
    /** The mark beside their name, and null when there is nothing to show. */
    badge: paid ? name : null,
    lounge: paid,
    earlyAccess: paid,
    /** May give an award to an item or a contribution. */
    awards: paid,
    /** May choose a theme and an app icon. */
    appearance: paid,
    /** Their own contributions are lifted in a list. */
    highlight: paid,
    monthlyCredits: MONTHLY_CREDITS[name],
    unlimitedFeeds: paid,
    ownSources: paid,
    /** A signed crawl pass for the whole term. The operator tier only. */
    crawlPass: name === 'pro',
    apiTier: name === 'pro' ? 'pro' : name === 'premium' ? 'premium' : 'free',
  });
}

/* ------------------------------------------------------------------ credits -- */

/**
 * Credits are granted once per calendar month and the grant is keyed by the
 * month, so a double-run of the granter is a no-op rather than free money.
 * The ledger's unique index on (user_id, ref) is what actually enforces it;
 * this only has to produce the same string twice.
 */
export const creditGrantRef = (at = new Date()) => `grant:${at.toISOString().slice(0, 7)}`;

/** What an award costs the giver. Kept small and whole so a balance reads easily. */
export const AWARD_KINDS = Object.freeze({
  useful: { label: 'Useful', credits: 50, note: 'This answered the question.' },
  verified: { label: 'Verified', credits: 100, note: 'I checked this against the source.' },
  scoop: { label: 'Scoop', credits: 250, note: 'Nobody else had this yet.' },
});

export const awardKinds = () => Object.entries(AWARD_KINDS).map(([id, meta]) => ({ id, ...meta }));

export const isAwardKind = (kind) => Object.hasOwn(AWARD_KINDS, String(kind));

export const awardCost = (kind) => AWARD_KINDS[String(kind)]?.credits ?? null;

/**
 * May this user give this award right now?
 *
 * Returns a reason rather than a bare false, because every caller of this has
 * to tell somebody why, and inventing that message at each call site is how
 * two parts of a site come to disagree about the rules.
 */
export function canAward({ plan, balance = 0, kind }) {
  if (!isAwardKind(kind)) return { ok: false, reason: 'No such award.' };
  if (!entitlements(plan).awards)
    return { ok: false, reason: 'Awards come with Premium.', upsell: true };
  const cost = awardCost(kind);
  if (balance < cost)
    return { ok: false, reason: `That award costs ${cost} credits and you have ${balance}.` };
  return { ok: true, cost };
}

/* --------------------------------------------------------------- appearance -- */

/**
 * The themes and app icons Premium unlocks.
 *
 * Every theme is a class the stylesheet already defines and every icon is a
 * file that ships in the image, so an unknown value can never reach the page:
 * the setter validates against these lists and the layout reads only what the
 * setter stored.
 */
export const THEMES = Object.freeze([
  { id: 'default', label: 'Amber (default)', free: true },
  { id: 'mint', label: 'Mint' },
  { id: 'ultraviolet', label: 'Ultraviolet' },
  { id: 'ember', label: 'Ember' },
  { id: 'paper', label: 'Paper (light)' },
  { id: 'mono', label: 'Monochrome' },
]);

export const APP_ICONS = Object.freeze([
  { id: 'default', label: 'The logo', file: 'logo.svg', free: true },
  { id: 'mint', label: 'Mint', file: 'icons/app-mint.svg' },
  { id: 'ultraviolet', label: 'Ultraviolet', file: 'icons/app-ultraviolet.svg' },
  { id: 'ember', label: 'Ember', file: 'icons/app-ember.svg' },
  { id: 'mono', label: 'Monochrome', file: 'icons/app-mono.svg' },
]);

export const isTheme = (id) => THEMES.some((t) => t.id === id);
export const isAppIcon = (id) => APP_ICONS.some((i) => i.id === id);

/** The theme actually applied: the stored one when they are entitled to it, else the default. */
export function themeFor({ plan, theme }) {
  if (theme === 'default' || !isTheme(theme)) return 'default';
  return entitlements(plan).appearance ? theme : 'default';
}

/** The icon file actually linked. Same rule, and it never returns a path we do not ship. */
export function appIconFor({ plan, icon }) {
  const chosen = APP_ICONS.find((i) => i.id === icon);
  if (!chosen || chosen.free) return APP_ICONS[0].file;
  return entitlements(plan).appearance ? chosen.file : APP_ICONS[0].file;
}

/* ------------------------------------------------------------------- terms -- */

/**
 * What Premium costs, from the deployment's three numbers.
 *
 * A day is the unit. The month and the year are the same dollar a day with the
 * discount for paying up front stated rather than implied, which is the number
 * a buyer actually compares.
 */
export function termOptions({ dayCents, monthCents, yearCents }) {
  const list = [
    { id: 'day', days: 1, cents: dayCents, label: 'a day' },
    { id: 'month', days: 30, cents: monthCents, label: 'a month' },
    { id: 'year', days: 365, cents: yearCents, label: 'a year' },
  ].filter((t) => Number.isFinite(t.cents) && t.cents > 0);
  return list.map((term) => {
    const atDayRate = dayCents * term.days;
    return {
      ...term,
      perDayCents: term.cents / term.days,
      savedCents: Math.max(0, atDayRate - term.cents),
      savedPercent: atDayRate > 0 ? Math.round((1 - term.cents / atDayRate) * 100) : 0,
    };
  });
}

/** The term a buyer asked for, or null. Never trust a form to name a real one. */
export function termById(id, prices) {
  return termOptions(prices).find((t) => t.id === String(id)) ?? null;
}
