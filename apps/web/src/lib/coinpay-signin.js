/**
 * Sign in with CoinPay: a confidential OIDC client. Authorization code + PKCE
 * S256 + state + nonce, the client secret on the code exchange, and the id_token
 * checked (issuer, audience, expiry, nonce) with a userinfo `sub` that must match.
 * The protocol half is the house package @profullstack/coinpay-onboard/oauth.
 *
 * Binding (STANDING rule): an account is found by its CoinPay `sub` only, in
 * coinpay_identities. CoinPay never verifies email addresses, so its email is
 * never matched against users.email and never becomes one. A first CoinPay
 * sign-in gets a new account with an unroutable placeholder email; an existing
 * account gets CoinPay only by connecting it while signed in.
 */
import { randomUUID } from 'node:crypto';
import {
  authorizeUrl,
  finishSignIn,
  pkce,
  randomToken,
  SIGN_IN_SCOPES,
  sameState,
} from '@profullstack/coinpay-onboard/oauth';

export const CALLBACK_PATH = '/api/v1/coinpay/oauth/callback';
export const PENDING_COOKIE = 'ndb_cp';
export const PENDING_TTL_SECONDS = 600;
export const PLACEHOLDER_DOMAIN = 'coinpay.nichedb.invalid';

// Read at request time: the app's env comes from app.env on the box.
const env = (name) => {
  const v = process.env[name];
  return typeof v === 'string' ? v.trim() : '';
};

/** Null when the client is not configured, which hides every CoinPay button. */
export function coinpayConfig(siteUrl) {
  const clientId = env('COINPAY_OAUTH_CLIENT_ID');
  const clientSecret = env('COINPAY_OAUTH_CLIENT_SECRET');
  if (!clientId || !clientSecret) return null;
  const issuer = (env('COINPAY_OAUTH_ISSUER') || 'https://coinpayportal.com').replace(/\/+$/, '');
  return {
    clientId,
    clientSecret,
    issuer,
    redirectUri: siteUrl.replace(/\/+$/, '') + CALLBACK_PATH,
  };
}

export function placeholderEmail(sub) {
  return `${String(sub)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')}@${PLACEHOLDER_DOMAIN}`;
}

export function isPlaceholderEmail(email) {
  return String(email ?? '')
    .trim()
    .toLowerCase()
    .endsWith(`@${PLACEHOLDER_DOMAIN}`);
}

/** Only same-site paths survive the round trip. */
export function safeNext(raw, fallback = '/following') {
  const s = String(raw ?? '');
  return s.startsWith('/') && !s.startsWith('//') && !s.startsWith('/\\') && !/[\t\r\n]/.test(s)
    ? s
    : fallback;
}

/** The authorize redirect plus what the callback needs back, kept server side. */
export function beginSignIn(cfg, { mode = 'login', next, userId = null } = {}) {
  const { verifier, challenge } = pkce();
  const pending = {
    state: randomToken(24),
    nonce: randomToken(24),
    verifier,
    mode: mode === 'connect' ? 'connect' : 'login',
    next: safeNext(next),
    userId,
  };
  const url = authorizeUrl({
    base: cfg.issuer,
    clientId: cfg.clientId,
    redirectUri: cfg.redirectUri,
    state: pending.state,
    challenge,
    nonce: pending.nonce,
    scopes: SIGN_IN_SCOPES,
  });
  return { id: randomUUID(), pending, url };
}

export const stateMatches = (expected, received) => sameState(expected, received);

/** Code -> tokens -> checked id_token -> userinfo. Throws on any mismatch. */
export function finishCoinpaySignIn(cfg, { code, verifier, nonce }, doFetch) {
  return finishSignIn({
    code,
    verifier,
    nonce,
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    redirectUri: cfg.redirectUri,
    base: cfg.issuer,
    fetch: doFetch,
  });
}

/**
 * The identity store over any `run(text, params) => rows` (postgres.js
 * `sql.unsafe` in the app, PGlite in tests).
 */
export function identityStore(run) {
  const one = async (text, params) => (await run(text, params))[0] ?? null;
  return {
    async userIdForSub(sub) {
      const row = await one('select user_id from coinpay_identities where sub = $1', [sub]);
      return row ? String(row.user_id) : null;
    },

    async identityFor(userId) {
      return one('select sub, email, created_at from coinpay_identities where user_id = $1', [
        userId,
      ]);
    },

    /** Sign-in: the bound account, or a new one bound to this sub. Never by email. */
    async signIn({ sub, email = null, name = null }) {
      if (!sub) throw new Error('no sub');
      const bound = await one(
        'update coinpay_identities set last_login_at = now(), email = $2 where sub = $1 returning user_id',
        [sub, email],
      );
      if (bound) return { userId: String(bound.user_id), created: false };
      // A plain user (never admin: role is fixed here, not ADMIN_EMAILS or
      // "first account"). The CTE makes the user and its binding together.
      const made = await one(
        `with u as (
           insert into users (email, role, display_name) values ($2, 'user', $4)
           on conflict (email) do nothing
           returning id
         )
         insert into coinpay_identities (sub, user_id, email, last_login_at)
         select $1, u.id, $3, now() from u
         on conflict (sub) do nothing
         returning user_id`,
        [sub, placeholderEmail(sub), email, name ? String(name).slice(0, 120) : null],
      );
      if (made) return { userId: String(made.user_id), created: true };
      // Lost a race with the same sub's first sign-in: use what it bound.
      const again = await this.userIdForSub(sub);
      if (again) return { userId: again, created: false };
      throw new Error('could not bind the CoinPay identity');
    },

    /** Connect from a signed-in session. */
    async link(userId, { sub, email = null }) {
      const existing = await one('select user_id from coinpay_identities where sub = $1', [sub]);
      if (existing)
        return String(existing.user_id) === String(userId)
          ? { ok: true }
          : { ok: false, reason: 'taken' };
      const mine = await one('select sub from coinpay_identities where user_id = $1', [userId]);
      if (mine) return { ok: false, reason: 'already_linked' };
      const row = await one(
        `insert into coinpay_identities (sub, user_id, email) values ($1, $2, $3)
         on conflict do nothing returning sub`,
        [sub, userId, email],
      );
      return row ? { ok: true } : { ok: false, reason: 'taken' };
    },

    /**
     * Disconnect, unless CoinPay is the only way in: a placeholder-email account
     * cannot get a magic link, so it needs a passkey first.
     */
    async unlink(userId) {
      const user = await one('select email::text as email from users where id = $1', [userId]);
      if (!user) return { ok: false, reason: 'no_account' };
      const status = await this.status(userId, user.email);
      if (!status.linked) return { ok: false, reason: 'not_linked' };
      if (!status.canDisconnect) return { ok: false, reason: 'only_login' };
      await run('delete from coinpay_identities where user_id = $1', [userId]);
      return { ok: true };
    },

    async status(userId, email) {
      const linked = Boolean(await this.identityFor(userId));
      let other = !isPlaceholderEmail(email);
      if (!other) {
        const pk = await one('select count(*)::int as n from passkeys where user_id = $1', [
          userId,
        ]);
        other = Number(pk?.n ?? 0) > 0;
      }
      return { linked, canDisconnect: linked && other };
    },
  };
}
