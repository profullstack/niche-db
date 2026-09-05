import * as auth from '@nichedb/auth';
import { config } from '@nichedb/config';
import * as q from '@nichedb/db/queries';
import { connection } from '@nichedb/queue';
import { getCookie } from 'hono/cookie';
import { Denied } from './service.js';

/** Every HTML response goes through here so no page is ever served without a doctype. */
export const render = async (node) => `<!doctype html>${await node.toString()}`;

/** Does the caller want JSON? Fetch from app.js and API clients say so. */
export function wantsJson(c) {
  const accept = c.req.header('accept') ?? '';
  const ct = c.req.header('content-type') ?? '';
  return (
    accept.includes('application/json') ||
    ct.includes('application/json') ||
    c.req.header('x-requested-with') === 'fetch' ||
    c.req.path.startsWith('/api/v1')
  );
}

/**
 * Answer the caller in its own language: a browser form gets a 303 back to
 * where it came from (with a notice in the query string), a JSON caller gets JSON.
 */
export function respond(c, { json, redirectTo, status, notice, error } = {}) {
  if (wantsJson(c))
    return c.json(json ?? (error ? { error } : { ok: true }), status ?? (error ? 400 : 200));
  const to = new URL(redirectTo ?? c.req.header('referer') ?? '/', config.siteUrl);
  if (notice) to.searchParams.set('notice', notice);
  if (error) to.searchParams.set('error', error);
  return c.redirect(to.pathname + to.search, 303);
}

/** Signed-out actions send you to sign in and come back, rather than erroring. */
export function requireUser(c) {
  const user = c.get('user');
  if (!user) {
    if (wantsJson(c)) throw new Denied('Sign in or send an API key.', 401);
    throw Object.assign(new Error('auth required'), {
      redirect: `/login?next=${encodeURIComponent(c.req.path)}`,
    });
  }
  return user;
}

/** Cookie session first, then a bearer API key. Sets c.var.user and c.var.viaKey. */
export async function loadUser(c, next) {
  let user = null;
  let viaKey = false;
  const sid = getCookie(c, config.session.cookie);
  if (sid) user = await auth.userFromRequest(sid);
  if (!user) {
    const h = c.req.header('authorization') ?? '';
    const m = h.match(/^Bearer\s+(ndb_[0-9a-f]+)$/i);
    if (m) {
      user = await auth.userFromApiKey(m[1]);
      viaKey = Boolean(user);
    }
  }
  c.set('user', user);
  c.set('viaKey', viaKey);
  await next();
}

/**
 * Pages identical for every signed-out visitor are rendered once and served
 * from Redis. Signed-in pages carry follow state and are rendered fresh.
 */
export async function cached(c, key, produce, ttl = config.cache.ttlSeconds) {
  if (!config.cache.enabled || c.get('user')) return c.html(await produce());
  try {
    const hit = await connection.get(`page:${key}`);
    if (hit) {
      c.header('x-cache', 'hit');
      return c.html(hit);
    }
  } catch {}
  const body = await produce();
  connection.set(`page:${key}`, body, 'EX', ttl).catch(() => {});
  c.header('x-cache', 'miss');
  return c.html(body);
}

/** Pull `config.<key>` fields out of a posted form into an object. */
export function configFromForm(body) {
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (k.startsWith('config.')) out[k.slice(7)] = v;
  }
  return out;
}

/** Read one or many of a form field as an array. */
export const many = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]).map(String);

export const flashKey = (sid) => `flash:${sid}`;

/** A one-time message for the next page load, kept out of the URL. */
export async function setFlash(c, value) {
  const sid = getCookie(c, config.session.cookie);
  if (!sid) return;
  await connection.set(flashKey(sid), value, 'EX', 120).catch(() => {});
}

export async function takeFlash(c) {
  const sid = getCookie(c, config.session.cookie);
  if (!sid) return null;
  try {
    const v = await connection.get(flashKey(sid));
    if (v) await connection.del(flashKey(sid));
    return v;
  } catch {
    return null;
  }
}

export async function isProUser(user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return Boolean(await q.activeMembership(user.id));
}
