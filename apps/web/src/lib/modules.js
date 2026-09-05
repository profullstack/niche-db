/**
 * The modules a response carries: ads and tracking.
 *
 * Free is free because the pages carry an ad and a tracker. Pro carries
 * neither, ever. An agent that paid for a crawl pass has paid, so it may
 * switch either off for its own requests with `?disable=ads,tracking` (or an
 * `x-disable` header) — the pass is what makes the request paid, and the
 * parameter is what says which modules to drop.
 *
 * Kept in AsyncLocalStorage so the layout and the feed builders can ask
 * without every page having to hand it down.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from '@nichedb/config';
import { readPass } from '@profullstack/x402-gateway';

export const MODULES = ['ads', 'tracking'];

const storage = new AsyncLocalStorage();

/** Everything on: what a stranger gets. */
export const ALL_ON = Object.freeze({ ads: true, tracking: true, paid: false, pro: false });

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
 * `pro` is the signed-in member; `paid` is a valid crawl pass.
 */
export function decideModules({ pro, paid, disable }) {
  if (pro) return { ads: false, tracking: false, paid: true, pro: true };
  if (!paid) return ALL_ON;
  const off = parseDisable(disable);
  return { ads: !off.has('ads'), tracking: !off.has('tracking'), paid: true, pro: false };
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

/** Work out the modules for this request, given the user loadUser found. */
export async function modulesFor(c, isPro) {
  const user = c.get('user');
  const pro = user ? await isPro(user) : false;
  const paid = pro || (await holdsPass(c));
  const disable = c.req.query('disable') ?? c.req.header('x-disable');
  return decideModules({ pro, paid, disable });
}

/** Run `fn` with these modules current. */
export const withModules = (modules, fn) => storage.run(modules, fn);

/** The modules of the response being built. Everything on outside a request. */
export const currentModules = () => storage.getStore() ?? ALL_ON;
