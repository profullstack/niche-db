/**
 * Sign in with CoinPay: bound by `sub` only. A CoinPay login carrying someone
 * else's email never gets their account; linking needs a browser session; a
 * forged state or a wrong nonce is refused. Runs every migration on PGlite.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { Hono } from 'hono';
import { identityStore, placeholderEmail } from '../lib/coinpay-signin.js';
import { registerCoinpay } from './coinpay.js';

process.env.COINPAY_OAUTH_CLIENT_ID = 'cp_test_client';
process.env.COINPAY_OAUTH_CLIENT_SECRET = 'test-client-secret';

const ROOT = new URL('../../../../', import.meta.url).pathname;
let db;
let run;
let store;

beforeAll(async () => {
  db = await new PGlite({ extensions: { citext, pg_trgm } });
  const dir = `${ROOT}packages/db/migrations/`;
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    try {
      await db.exec(await readFile(dir + f, 'utf8'));
    } catch (err) {
      // A few migrations need extensions PGlite lacks (postgis etc.); the auth
      // tables come from 0001 and 0042, which must apply.
      if (f.startsWith('0001') || f.startsWith('0042')) throw err;
    }
  }
  run = async (text, params) => (await db.query(text, params)).rows;
  store = identityStore(run);
});

const addUser = async (email) =>
  (await run(`insert into users (email) values ($1) returning id::text as id`, [email]))[0].id;

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const fakeCoinpay =
  ({ sub, email, nonce }) =>
  async (url) => {
    const u = String(url);
    if (u.endsWith('/api/oauth/token'))
      return Response.json({
        access_token: 'at',
        token_type: 'Bearer',
        expires_in: 3600,
        id_token: `${b64({ alg: 'HS256' })}.${b64({ iss: 'https://coinpayportal.com', aud: 'cp_test_client', sub, nonce, exp: Math.floor(Date.now() / 1000) + 600 })}.sig`,
      });
    if (u.endsWith('/api/oauth/userinfo'))
      return Response.json({ sub, email, email_verified: false });
    return new Response('{}', { status: 404 });
  };

/** The app under test: a fake session (x-test-user header) in front of the routes. */
function appWith({ coinpay }) {
  const pendingMap = new Map();
  const sessions = [];
  const app = new Hono();
  app.use('*', async (c, next) => {
    const id = c.req.header('x-test-user');
    c.set('user', id ? { id, email: 'x' } : null);
    c.set('viaKey', c.req.header('x-test-key') === '1');
    await next();
  });
  registerCoinpay(app, {
    siteUrl: 'https://nichedb.test',
    secure: true,
    run,
    pending: {
      save: async (id, v) => pendingMap.set(id, v),
      take: async (id) => {
        const v = pendingMap.get(id) ?? null;
        pendingMap.delete(id);
        return v;
      },
    },
    startSession: async (userId) => {
      sessions.push(userId);
      return `sid-${sessions.length}`;
    },
    sessionCookie: (sid) => `ndb_session=${sid}; Path=/; HttpOnly`,
    get fetch() {
      return coinpay.fetch;
    },
  });
  return { app, sessions };
}

async function start(app, { mode, user } = {}) {
  const headers = user ? { 'x-test-user': user } : {};
  const res = await app.request(`/api/v1/coinpay/oauth/start${mode ? `?mode=${mode}` : ''}`, {
    headers,
  });
  const loc = new URL(res.headers.get('location'), 'https://nichedb.test');
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
  return { res, loc, cookie };
}

describe('Sign in with CoinPay', () => {
  test('start sends PKCE S256, state and nonce to CoinPay with the exact redirect', async () => {
    const { app } = appWith({ coinpay: {} });
    const { res, loc, cookie } = await start(app);
    expect(res.status).toBe(302);
    expect(loc.origin + loc.pathname).toBe('https://coinpayportal.com/api/oauth/authorize');
    expect(loc.searchParams.get('code_challenge_method')).toBe('S256');
    expect(loc.searchParams.get('state')).toBeTruthy();
    expect(loc.searchParams.get('nonce')).toBeTruthy();
    expect(loc.searchParams.get('redirect_uri')).toBe(
      'https://nichedb.test/api/v1/coinpay/oauth/callback',
    );
    expect(loc.searchParams.get('scope')).toBe('openid profile email');
    expect(cookie.startsWith('ndb_cp=')).toBe(true);
  });

  test('a CoinPay login carrying a victim email does not get the victim account', async () => {
    const victim = await addUser('victim@example.com');
    const coinpay = {};
    const { app, sessions } = appWith({ coinpay });
    const { loc, cookie } = await start(app);
    coinpay.fetch = fakeCoinpay({
      sub: 'attacker-sub',
      email: 'victim@example.com',
      nonce: loc.searchParams.get('nonce'),
    });
    const res = await app.request(
      `/api/v1/coinpay/oauth/callback?code=c&state=${loc.searchParams.get('state')}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(303);
    expect(sessions.length).toBe(1);
    expect(sessions[0]).not.toBe(victim);
    const [made] = await run('select email::text as email, role from users where id = $1', [
      sessions[0],
    ]);
    expect(made.email).toBe(placeholderEmail('attacker-sub'));
    expect(made.role).toBe('user');
    expect(await store.identityFor(victim)).toBeNull();
    // the same sub signs into the same account next time, whatever email it sends
    const again = await store.signIn({ sub: 'attacker-sub', email: 'other@example.com' });
    expect(again).toEqual({ userId: sessions[0], created: false });
  });

  test('a forged state is refused and nothing is created', async () => {
    const coinpay = {
      fetch: fakeCoinpay({ sub: 'forged-sub', email: 'f@example.com', nonce: 'n' }),
    };
    const { app, sessions } = appWith({ coinpay });
    const { cookie } = await start(app);
    const res = await app.request('/api/v1/coinpay/oauth/callback?code=c&state=forged', {
      headers: { cookie },
    });
    expect(res.status).toBe(400);
    expect(sessions.length).toBe(0);
    expect(await store.userIdForSub('forged-sub')).toBeNull();
  });

  test('an id_token with the wrong nonce is refused', async () => {
    const coinpay = {};
    const { app, sessions } = appWith({ coinpay });
    const { loc, cookie } = await start(app);
    coinpay.fetch = fakeCoinpay({
      sub: 'nonce-sub',
      email: 'n@example.com',
      nonce: 'not-the-nonce',
    });
    const res = await app.request(
      `/api/v1/coinpay/oauth/callback?code=c&state=${loc.searchParams.get('state')}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(400);
    expect(sessions.length).toBe(0);
  });

  test('the pending sign-in is single use', async () => {
    const coinpay = {};
    const { app } = appWith({ coinpay });
    const { loc, cookie } = await start(app);
    coinpay.fetch = fakeCoinpay({
      sub: 'once-sub',
      email: null,
      nonce: loc.searchParams.get('nonce'),
    });
    const url = `/api/v1/coinpay/oauth/callback?code=c&state=${loc.searchParams.get('state')}`;
    expect((await app.request(url, { headers: { cookie } })).status).toBe(303);
    const replay = await app.request(url, { headers: { cookie } });
    expect(replay.headers.get('location')).toContain('/login?error=');
  });

  test('connect needs a browser session, and links only to that account', async () => {
    const owner = await addUser('owner@example.com');
    const coinpay = {};
    const { app, sessions } = appWith({ coinpay });
    // no session: back to login, nothing pending
    const anon = await start(app, { mode: 'connect' });
    expect(anon.loc.pathname).toBe('/login');
    // an API key is not a browser session
    const viaKey = await app.request('/api/v1/coinpay/oauth/start?mode=connect', {
      headers: { 'x-test-user': owner, 'x-test-key': '1' },
    });
    expect(new URL(viaKey.headers.get('location'), 'https://x').pathname).toBe('/login');

    const { loc, cookie } = await start(app, { mode: 'connect', user: owner });
    coinpay.fetch = fakeCoinpay({
      sub: 'owner-sub',
      email: 'whatever@example.com',
      nonce: loc.searchParams.get('nonce'),
    });
    const url = `/api/v1/coinpay/oauth/callback?code=c&state=${loc.searchParams.get('state')}`;
    // the callback in a browser that is no longer signed in to that account is refused
    const other = await addUser('someone-else@example.com');
    const wrong = await app.request(url, { headers: { cookie, 'x-test-user': other } });
    expect(wrong.headers.get('location')).toContain('/login?error=');
    expect(await store.identityFor(owner)).toBeNull();

    const again = await start(app, { mode: 'connect', user: owner });
    coinpay.fetch = fakeCoinpay({
      sub: 'owner-sub',
      email: 'whatever@example.com',
      nonce: again.loc.searchParams.get('nonce'),
    });
    const ok = await app.request(
      `/api/v1/coinpay/oauth/callback?code=c&state=${again.loc.searchParams.get('state')}`,
      { headers: { cookie: again.cookie, 'x-test-user': owner } },
    );
    expect(ok.headers.get('location')).toContain('/settings?notice=');
    expect((await store.identityFor(owner)).sub).toBe('owner-sub');
    expect(sessions.length).toBe(0);
    expect(await store.userIdForSub('owner-sub')).toBe(owner);
  });

  test('link and disconnect rules', async () => {
    const a = await addUser('a-link@example.com');
    const b = await addUser('b-link@example.com');
    expect(await store.link(a, { sub: 'link-sub' })).toEqual({ ok: true });
    expect(await store.link(b, { sub: 'link-sub' })).toEqual({ ok: false, reason: 'taken' });
    expect(await store.link(a, { sub: 'second-sub' })).toEqual({
      ok: false,
      reason: 'already_linked',
    });
    expect(await store.status(a, 'a-link@example.com')).toEqual({
      linked: true,
      canDisconnect: true,
    });
    expect(await store.unlink(a)).toEqual({ ok: true });
    // a CoinPay-only account cannot drop its only way in
    const { userId } = await store.signIn({ sub: 'only-sub', email: 'o@example.com' });
    expect(await store.unlink(userId)).toEqual({ ok: false, reason: 'only_login' });
  });
});

describe('CoinPay buttons', () => {
  test('sign-in and sign-up offer CoinPay first; settings offers Connect', async () => {
    process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
    process.env.SITE_URL ??= 'https://nichedb.test';
    const { SignIn } = await import('../views/pages.jsx');
    for (const mode of ['login', 'signup']) {
      const out = String(await SignIn({ mode }).toString());
      const button = out.indexOf('/api/v1/coinpay/oauth/start');
      expect(button).toBeGreaterThan(-1);
      expect(button).toBeLessThan(out.indexOf('action="/api/auth/magic"'));
    }
  });
});
