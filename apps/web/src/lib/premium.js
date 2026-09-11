/**
 * Premium, per request: which plan the caller holds and what that entitles
 * them to.
 *
 * Worked out once in the middleware and kept on the context, because six
 * different handlers ask and each answer is a query. `c.get('plan')` is the
 * string, `c.get('entitlements')` the frozen table from `@nichedb/premium`.
 *
 * Nothing here decides what a plan is worth. That is the domain package, so
 * the pricing page and the gates below are reading the same object.
 */
import { config } from '@nichedb/config';
import * as premiumDb from '@nichedb/db/premium';
import { canAward, creditGrantRef, entitlements, planFor } from '@nichedb/premium';
import { wantsJson } from './http.js';
import { Denied } from './service.js';

/**
 * The caller's plan. Admins are Pro without a row; everyone else is whatever
 * unexpired terms they hold say they are.
 */
export async function planForUser(user, { now = new Date() } = {}) {
  if (!user) return 'free';
  if (user.role === 'admin') return 'pro';
  const terms = await premiumDb.activeTerms(user.id).catch(() => []);
  return planFor({ user, terms, now });
}

/** Middleware: resolve the plan once, before ads, tracking and every gate below. */
export async function loadPlan(c, next) {
  const plan = await planForUser(c.get('user'));
  c.set('plan', plan);
  c.set('entitlements', entitlements(plan));
  await next();
}

export const planOf = (c) => c.get('plan') ?? 'free';
export const entitlementsOf = (c) => c.get('entitlements') ?? entitlements('free');

/**
 * Refuse, in the same words everywhere, and put them in front of the thing
 * that would have let them through.
 *
 * An API caller gets a 402, which is the status that means "pay for this".
 * A person gets the pricing page with the reason on it rather than an error
 * flashed on the page they were already on: being told no is only useful next
 * to the thing that would make it a yes.
 */
export function requirePremium(c, what) {
  const ent = entitlementsOf(c);
  if (ent.plan !== 'free') return ent;
  const price = `$${(config.premium.dayCents / 100).toFixed(2)} a day`;
  const message = `${what} comes with Premium — ${price} at /premium.`;
  if (wantsJson(c)) throw new Denied(message, 402);
  throw Object.assign(new Error(message), {
    redirect: `/premium?notice=${encodeURIComponent(message)}`,
  });
}

/** The API allowance this plan gets, in requests an hour. */
export function apiLimitFor(plan) {
  switch (entitlements(plan).apiTier) {
    case 'pro':
      return config.api.proPerHour;
    case 'premium':
      return config.api.premiumPerHour;
    default:
      return config.api.freePerHour;
  }
}

/**
 * The credits for the calendar month, granted on first sight rather than by a
 * cron job.
 *
 * A member who does not visit in March does not need March's credits until
 * they visit, and a grant keyed by the month cannot pay twice however many
 * tabs arrive at once. Failure is a log line: nobody is shown an error page
 * because a ledger insert lost a race.
 */
export async function ensureMonthlyCredits(c) {
  const user = c.get('user');
  const ent = entitlementsOf(c);
  if (!user || !ent.monthlyCredits) return null;
  const amount = Math.min(ent.monthlyCredits, config.premium.monthlyCredits * 2);
  try {
    return await premiumDb.grantCredits({
      userId: user.id,
      amount,
      reason: `monthly:${ent.plan}`,
      ref: creditGrantRef(),
    });
  } catch (err) {
    console.error('[premium] monthly credits', err.message);
    return null;
  }
}

/** Everything the settings and lounge pages need about one member. */
export async function premiumSnapshot(c) {
  const user = c.get('user');
  const plan = planOf(c);
  if (!user) return { plan, balance: 0, terms: [], ledger: [], awards: [] };
  const [balance, terms, ledger, awards] = await Promise.all([
    premiumDb.creditBalance(user.id),
    premiumDb.activeTerms(user.id),
    premiumDb.creditLedger(user.id, { limit: 10 }),
    premiumDb.awardsGiven(user.id, { limit: 10 }),
  ]);
  return { plan, balance, terms, ledger, awards };
}

/** May this caller give this award? The domain decides; this only fetches the balance. */
export async function awardCheck(c, kind) {
  const user = c.get('user');
  if (!user) return { ok: false, reason: 'Sign in first.' };
  const balance = await premiumDb.creditBalance(user.id);
  return { ...canAward({ plan: planOf(c), balance, kind }), balance };
}
