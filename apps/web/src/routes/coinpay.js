import { saveOpenProfileContact } from '@profullstack/profile';
import { getCookie, setCookie } from 'hono/cookie';
import {
  beginSignIn,
  coinpayConfig,
  finishCoinpaySignIn,
  identityStore,
  PENDING_COOKIE,
  PENDING_TTL_SECONDS,
  stateMatches,
} from '../lib/coinpay-signin.js';

/**
 * The app's own wiring. Loaded lazily so tests (and pages that never touch
 * CoinPay) do not open Postgres or Redis by importing this module.
 */
async function defaultDeps() {
  const [{ config }, { sql }, q, auth, { connection }] = await Promise.all([
    import('@nichedb/config'),
    import('@nichedb/db'),
    import('@nichedb/db/queries'),
    import('@nichedb/auth'),
    import('@nichedb/queue'),
  ]);
  const key = (id) => `cp:pending:${id}`;
  return {
    siteUrl: config.siteUrl,
    secure: config.isProd,
    run: (text, params) => sql.unsafe(text, params),
    pending: {
      save: (id, value) =>
        connection.set(key(id), JSON.stringify(value), 'EX', PENDING_TTL_SECONDS),
      // Single use: read and delete in one step.
      take: async (id) => {
        const raw = await connection.getdel(key(id));
        return raw ? JSON.parse(raw) : null;
      },
    },
    startSession: (userId, userAgent) =>
      q.startSession({ userId, ttlDays: config.session.ttlDays, userAgent }),
    sessionCookie: (sid) => auth.sessionCookie(sid),
    fetch: undefined,
  };
}

/**
 * Sign in with CoinPay:
 *   GET  /api/v1/coinpay/oauth/start?next=/x          sign in / sign up
 *   GET  /api/v1/coinpay/oauth/start?mode=connect     link to the signed-in account
 *   GET  /api/v1/coinpay/oauth/callback
 *   POST /api/v1/coinpay/disconnect
 * Registered before the /api/v1 meter: these are browser redirects, not API calls.
 */
export function registerCoinpay(app, overrides = null) {
  let depsPromise = null;
  const deps = () => {
    depsPromise ??= overrides ? Promise.resolve(overrides) : defaultDeps();
    return depsPromise;
  };
  const back = (to, msg, kind = 'error') => `${to}?${kind}=${encodeURIComponent(msg)}`;

  app.get('/api/v1/coinpay/oauth/start', async (c) => {
    const d = await deps();
    const cfg = coinpayConfig(d.siteUrl);
    if (!cfg) return c.text('Sign in with CoinPay is not configured.', 503);
    const mode = c.req.query('mode') === 'connect' ? 'connect' : 'login';
    const user = c.get('user');
    let userId = null;
    if (mode === 'connect') {
      // A browser session, not an API key: linking changes how the account signs in.
      if (!user || c.get('viaKey')) return c.redirect('/login?next=/settings', 303);
      userId = String(user.id);
    }
    const { id, pending, url } = beginSignIn(cfg, {
      mode,
      next: mode === 'connect' ? '/settings' : c.req.query('next'),
      userId,
    });
    await d.pending.save(id, pending);
    setCookie(c, PENDING_COOKIE, id, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: PENDING_TTL_SECONDS,
      secure: d.secure,
    });
    return c.redirect(url, 302);
  });

  app.get('/api/v1/coinpay/oauth/callback', async (c) => {
    const d = await deps();
    const cfg = coinpayConfig(d.siteUrl);
    if (!cfg) return c.text('Sign in with CoinPay is not configured.', 503);
    const id = getCookie(c, PENDING_COOKIE);
    setCookie(c, PENDING_COOKIE, '', { path: '/', maxAge: 0 });
    const pending = id ? await d.pending.take(id) : null;
    if (!pending) return c.redirect(back('/login', 'That sign-in expired. Try again.'), 303);
    if (c.req.query('error'))
      return c.redirect(back('/login', 'CoinPay sign-in was cancelled.'), 303);
    if (!stateMatches(pending.state, c.req.query('state')))
      return c.text('CoinPay sign-in failed: state mismatch.', 400);
    const code = c.req.query('code');
    if (!code) return c.text('CoinPay sign-in failed: no code.', 400);

    let who;
    try {
      who = await finishCoinpaySignIn(
        cfg,
        { code, verifier: pending.verifier, nonce: pending.nonce },
        d.fetch,
      );
    } catch (err) {
      console.error('[coinpay] sign-in refused:', err.message);
      return c.text('CoinPay sign-in could not be verified.', 400);
    }
    const store = identityStore(d.run);

    if (pending.mode === 'connect') {
      const user = c.get('user');
      if (!user || c.get('viaKey') || String(user.id) !== String(pending.userId))
        return c.redirect(back('/login', 'Sign in first, then connect CoinPay.'), 303);
      const r = await store.link(user.id, { sub: who.sub, email: who.email });
      if (r.ok) {
        const openprofileUrl = who.userinfo?.openprofile_url;
        if (typeof openprofileUrl === 'string') {
          try {
            const { profiles } = await import('../lib/profile.js');
            await saveOpenProfileContact(profiles, String(user.id), openprofileUrl);
          } catch (err) {
            console.warn(
              '[coinpay] OpenProfile import skipped:',
              err instanceof Error ? err.message : err,
            );
          }
        }
        return c.redirect(back('/settings', 'CoinPay connected.', 'notice'), 303);
      }
      const why =
        r.reason === 'taken'
          ? 'That CoinPay account is already linked to another nichedb account.'
          : 'This account already has a different CoinPay account connected.';
      return c.redirect(back('/settings', why), 303);
    }

    const { userId } = await store.signIn({ sub: who.sub, email: who.email, name: who.name });
    const sid = await d.startSession(userId, c.req.header('user-agent'));
    c.header('set-cookie', d.sessionCookie(sid), { append: true });
    return c.redirect(pending.next || '/following', 303);
  });

  app.post('/api/v1/coinpay/disconnect', async (c) => {
    const d = await deps();
    const user = c.get('user');
    if (!user || c.get('viaKey')) return c.redirect('/login?next=/settings', 303);
    const r = await identityStore(d.run).unlink(user.id);
    if (r.ok) return c.redirect(back('/settings', 'CoinPay disconnected.', 'notice'), 303);
    const why =
      r.reason === 'only_login'
        ? 'CoinPay is the only way into this account. Add a passkey first.'
        : 'CoinPay is not connected.';
    return c.redirect(back('/settings', why), 303);
  });
}
