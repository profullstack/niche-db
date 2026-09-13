import { OpenAccessApp, OpenAccessClient } from '@logicsrc/openaccess/client';
import { config } from '@nichedb/config';
import * as q from '@nichedb/db/queries';

/**
 * OpenAccess (openaccess.logicsrc.com): OAuth 2.1 with a grant you can carry.
 *
 * The descriptor at /.well-known/openaccess.json names the scopes this site
 * honours. An access token the hub minted for `nichedb.dev` is verified here
 * offline against the hub's published keys, and its scope decides what the
 * bearer may do. That is how a person edits their profile from an agent, a
 * CLI on another machine or another app, without a nichedb session cookie.
 *
 * The token names a principal at the hub, not a user here; the hub's `me`
 * says who that principal is (an email, an OpenProfile.md URL), and the email
 * is what maps to an account on this site.
 */
export const HUB = 'https://openaccess.logicsrc.com';
export const SCOPE_EDIT = 'openprofile:edit';

let app = null;
function hub() {
  if (!app) {
    const clientId = new URL(config.siteUrl).host;
    app = new OpenAccessApp({
      hub: HUB,
      clientId,
      redirectUri: `${config.siteUrl}/api/v1/openaccess/callback`,
    });
  }
  return app;
}

/** The OpenAccess bearer on a request, or null when there is none (a `ndb_` key is not one). */
export function bearerToken(c) {
  const header = c.req.header('authorization') ?? '';
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!m || /^ndb_/i.test(m[1])) return null;
  return m[1];
}

/**
 * The principal behind an OpenAccess bearer: `{ sub, scopes, email, profile }`,
 * or null for none or a bad one. `email` and `profile` come from the hub's
 * own record of the principal when the claims do not carry them.
 */
export async function bearerPrincipal(c, { fetcher = fetch } = {}) {
  const token = bearerToken(c);
  if (!token) return null;
  try {
    const claims = await hub().verify(token);
    const sub = typeof claims.sub === 'string' ? claims.sub : '';
    if (!sub) return null;
    const scopes = String(claims.scope ?? '')
      .split(/\s+/)
      .filter(Boolean);
    let email = typeof claims.email === 'string' ? claims.email : null;
    let profile = typeof claims.profile === 'string' ? claims.profile : null;
    if (!email && !profile) {
      try {
        const me = await new OpenAccessClient({ hub: HUB, token, fetch: fetcher }).me();
        email = me?.principal?.email ?? null;
        profile = me?.principal?.profile ?? null;
      } catch {}
    }
    return { sub, scopes, email: email ? email.toLowerCase() : null, profile };
  } catch {
    return null;
  }
}

/**
 * The account an OpenAccess principal with the edit scope stands for here,
 * created on first sight the way a magic link creates one. Null when the
 * bearer is absent, bad, lacks the scope or names no email.
 */
export async function userFromOpenAccess(c) {
  const principal = await bearerPrincipal(c);
  if (!principal?.scopes.includes(SCOPE_EDIT) || !principal.email) return null;
  const user = await q.findOrCreateUser(principal.email, {
    admin: config.adminEmails.includes(principal.email),
  });
  return { ...user, openaccess: principal };
}
