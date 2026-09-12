/**
 * The modules a response carries: ads and tracking.
 *
 * Free is free because the pages carry an ad and a tracker. A paid plan
 * carries neither, ever — Premium at a dollar a day and Pro alike, which is
 * the whole of what "ad-free" means here and is why it is decided in one
 * function rather than checked at each place an ad could appear. An agent that
 * paid for a crawl pass has paid, so it may switch either off for its own
 * requests with `?disable=ads,tracking` (or an `x-disable` header) — the pass
 * is what makes the request paid, and the parameter is what says which modules
 * to drop.
 *
 * Kept in AsyncLocalStorage so the layout and the feed builders can ask
 * without every page having to hand it down.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from '@nichedb/config';
import { entitlements, isPlan } from '@nichedb/premium';
import { readPass } from '@profullstack/x402-gateway';

export const MODULES = ['ads', 'tracking'];

const storage = new AsyncLocalStorage();

/** Everything on: what a stranger gets. */
export const ALL_ON = Object.freeze({
  ads: true,
  tracking: true,
  paid: false,
  pro: false,
  premium: false,
  plan: 'free',
});

/** "ads, Tracking,x" → Set{'ads','tracking'}; unknown names are ignored. */
export function parseDisable(raw) {
  const wanted = new Set();
  for (const part of String(raw ?? '').split(',')) {
    const name = part.trim().toLowerCase();
    if (name === 'all') for (const m of MODULES) wanted.add(m);
    else if (MODULES.includes(name)) wanted.add(name);
  }
  return wanted;
}

/**
 * Decide the modules for a request. Pure given its inputs, so it is testable:
 * `plan` is what the signed-in member holds; `paid` is a valid crawl pass.
 *
 * A member never sees an ad and is never asked to pass a parameter to say so.
 * A pass holder is paid but not a member, so it keeps the choice it bought.
 */
export function decideModules({ plan = 'free', paid, disable }) {
  const ent = entitlements(isPlan(plan) ? plan : 'free');
  if (ent.plan !== 'free')
    return {
      ads: false,
      tracking: false,
      paid: true,
      pro: ent.plan === 'pro',
      premium: true,
      plan: ent.plan,
    };
  if (!paid) return ALL_ON;
  const off = parseDisable(disable);
  return {
    ads: !off.has('ads'),
    tracking: !off.has('tracking'),
    paid: true,
    pro: false,
    premium: false,
    plan: 'free',
  };
}

/** The pass a request presents, if any and if it verifies. */
async function holdsPass(c) {
  const secret = config.x402.coinpayKey;
  if (!secret) return false;
  const direct = c.req.header('x-crawl-pass');
  const bearer = /^Bearer\s+(cp_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(
    c.req.header('authorization') ?? '',
  );
  const token = (direct ?? bearer?.[1] ?? '').trim();
  if (!token) return false;
  return Boolean(await readPass(token, { secret }));
}

/** Work out the modules for this request, given the plan loadPlan resolved. */
export async function modulesFor(c, plan = 'free') {
  const member = entitlements(isPlan(plan) ? plan : 'free').plan !== 'free';
  const paid = member || (await holdsPass(c));
  const disable = c.req.query('disable') ?? c.req.header('x-disable');
  return decideModules({ plan, paid, disable });
}

/** Run `fn` with these modules current. */
export const withModules = (modules, fn) => storage.run(modules, fn);

/** The modules of the response being built. Everything on outside a request. */
export const currentModules = () => storage.getStore() ?? ALL_ON;
