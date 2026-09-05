import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '@nichedb/config';
import * as q from '@nichedb/db/queries';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { validateApiKey } from './api-keys.js';

/**
 * Magic link + passkey. No password: it is a weaker second secret whose recovery
 * path collapses back to emailing a link, so it widens the attack surface without
 * widening what an attacker has to defeat.
 *
 * API keys are the third credential, for scripts, the CLI and MCP clients. They
 * are minted from inside a session and shown once.
 */

const TOKEN_TTL_MINUTES = 20;

/** rpID must match the host the credential was created on, so it is derived from
 *  SITE_URL rather than the request. */
export const rpID = new URL(config.siteUrl).hostname;
export const rpName = config.siteName;

/** Every origin a credential may legitimately be created from: apex and www. */
export const expectedOrigins = (() => {
  const site = new URL(config.siteUrl);
  const origins = new Set([site.origin]);
  if (site.hostname.startsWith('www.')) {
    origins.add(`${site.protocol}//${site.hostname.slice(4)}`);
  } else {
    origins.add(`${site.protocol}//www.${site.hostname}`);
  }
  for (const extra of (process.env.EXTRA_WEBAUTHN_ORIGINS ?? '').split(',')) {
    const trimmed = extra.trim();
    if (trimmed) origins.add(trimmed.replace(/\/$/, ''));
  }
  return [...origins];
})();

const hashToken = (t) => createHash('sha256').update(t).digest();

/* ------------------------------------------------------------- magic link -- */

/**
 * Mint a sign-in link. Returns the URL for the caller to email.
 *
 * The caller must answer identically whether or not the address is known: a
 * different response for a registered address enumerates who has an account.
 */
export async function createLoginLink(email, { next } = {}) {
  const token = randomBytes(32).toString('base64url');
  await q.insertLoginToken({
    tokenHash: hashToken(token),
    email: email.trim().toLowerCase(),
    expiresAt: new Date(Date.now() + TOKEN_TTL_MINUTES * 60_000),
  });
  const url = new URL('/auth/magic', config.siteUrl);
  url.searchParams.set('t', token);
  if (next?.startsWith('/')) url.searchParams.set('next', next);
  return url.toString();
}

/**
 * Spend a link and return a session id. This is also the registration path: an
 * address nobody has used before gets an account here.
 */
export async function consumeLoginLink(token, { userAgent } = {}) {
  const email = await q.consumeLoginToken(hashToken(token));
  if (!email) return null;
  const user = await q.findOrCreateUser(email, {
    admin: config.adminEmails.includes(String(email).toLowerCase()),
  });
  const sessionId = await q.startSession({
    userId: user.id,
    ttlDays: config.session.ttlDays,
    userAgent,
  });
  return { user, sessionId };
}

/* ---------------------------------------------------------------- passkey -- */

export async function passkeyRegistrationOptions(user) {
  const existing = await q.listPasskeys(user.id);
  return generateRegistrationOptions({
    rpName,
    rpID,
    userName: user.email,
    userID: Buffer.from(user.id),
    attestationType: 'none',
    excludeCredentials: existing.map((p) => ({ id: p.credential_id, transports: p.transports })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });
}

export async function verifyPasskeyRegistration({ user, response, expectedChallenge }) {
  const v = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: expectedOrigins,
    expectedRPID: rpID,
  });
  if (!v.verified || !v.registrationInfo) return false;
  const { credential } = v.registrationInfo;
  await q.insertPasskey({
    credentialId: credential.id,
    userId: user.id,
    publicKey: Buffer.from(credential.publicKey),
    counter: credential.counter,
    transports: response.response?.transports ?? [],
  });
  return true;
}

export async function passkeyAuthenticationOptions() {
  return generateAuthenticationOptions({ rpID, userVerification: 'preferred' });
}

export async function verifyPasskeyAuthentication({ response, expectedChallenge, userAgent }) {
  const stored = await q.getPasskey(response.id);
  if (!stored) return null;
  const v = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: expectedOrigins,
    expectedRPID: rpID,
    credential: {
      id: stored.credential_id,
      publicKey: new Uint8Array(stored.public_key),
      counter: Number(stored.counter),
      transports: stored.transports,
    },
  });
  if (!v.verified) return null;
  await q.touchPasskey(stored.credential_id, v.authenticationInfo.newCounter);
  const sessionId = await q.startSession({
    userId: stored.user_id,
    ttlDays: config.session.ttlDays,
    userAgent,
  });
  return { userId: stored.user_id, sessionId };
}

/* --------------------------------------------------------------- sessions -- */

export async function userFromRequest(cookieValue) {
  if (!cookieValue) return null;
  return q.getSessionUser(cookieValue);
}

export function sessionCookie(sessionId, { clear = false } = {}) {
  const parts = [
    `${config.session.cookie}=${clear ? '' : sessionId}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    clear ? 'Max-Age=0' : `Max-Age=${config.session.ttlDays * 86400}`,
  ];
  if (config.isProd) parts.push('Secure');
  return parts.join('; ');
}

/* --------------------------------------------------------------- api keys -- */

export { createApiKey, listApiKeys, revokeApiKey, validateApiKey } from './api-keys.js';

/** The account behind a bearer key, or null. */
export async function userFromApiKey(key) {
  const info = await validateApiKey(key);
  if (!info) return null;
  const user = await q.getUserById(info.userId);
  return user ? { ...user, api_key_id: info.id, api_key_permissions: info.permissions } : null;
}

/** Constant-time compare for webhook signatures. */
export function safeEqualHex(a, b) {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
