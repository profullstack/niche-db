import { describe, expect, test } from 'bun:test';
import { memoryStore as affMemory } from '@profullstack/affiliates';
import { memoryStore as creditsMemory } from '@profullstack/redeem-credits';
import { Hono } from 'hono';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';
const { config } = await import('@nichedb/config');
const lib = await import('../lib/credits.js');
const { Denied } = await import('../lib/service.js');
const { registerCredits } = await import('./credits.js');

const ALICE = { id: '11111111-1111-4111-8111-111111111111', email: 'a@x.test', role: 'user' };
const ADMIN = { id: '22222222-2222-4222-8222-222222222222', email: 'b@x.test', role: 'admin' };

function build(user = ALICE) {
  const grants = [];
  const services = lib.makeCredits({
    creditStore: creditsMemory(),
    affiliateStore: affMemory(),
    grant: async (g) => grants.push(g),
    externalCodes: () => false,
    quota: 2,
    bonusDays: 7,
  });
  const flashed = {};
  const flash = {
    put: async (_c, kind, v) => {
      flashed[kind] = v;
    },
    take: async (_c, kind) => flashed[kind] ?? null,
  };
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', user);
    await next();
  });
  app.onError((err, c) => {
    if (err.redirect) return c.redirect(err.redirect, 303);
    if (err instanceof Denied) return c.json({ error: err.message }, err.status);
    throw err;
  });
  registerCredits(app, { services, flash });
  return { app, services, grants, flashed };
}
const json = (body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json' },
  body: JSON.stringify(body),
});

describe('redeem', () => {
  test('JSON: a code is worth its days, through the grant hook', async () => {
    const { app, services, grants } = build();
    const made = await lib.mintPremiumCode({ days: 14 }, services);
    const res = await app.request('/api/v1/credits/redeem', json({ code: made.code }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, unit: 'premium_days', days: 14 });
    expect(grants).toEqual([{ userId: ALICE.id, days: 14, ref: `code:${made.id}` }]);
    const again = await app.request('/api/v1/credits/redeem', json({ code: made.code }));
    expect(again.status).toBe(400);
    expect((await again.json()).reason).toBe('already_redeemed');
  });

  test('form: back to the page it came from with a notice', async () => {
    const { app, services } = build();
    const made = await lib.mintPremiumCode({ days: 3 }, services);
    const res = await app.request('/credits/redeem', {
      method: 'POST',
      body: new URLSearchParams({ code: made.code, back: '/account/billing' }),
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toStartWith('/account/billing?notice=');
    const off = await app.request('/credits/redeem', {
      method: 'POST',
      body: new URLSearchParams({ code: 'x', back: '//evil.example' }),
    });
    expect(off.headers.get('location')).toStartWith('/settings?error=');
  });

  test('signed out is told to sign in', async () => {
    const { app } = build(null);
    const res = await app.request('/api/v1/credits/redeem', json({ code: 'CR-1' }));
    expect(res.status).toBe(401);
  });
});

describe('invites', () => {
  test('create, list, quota, landing, revoke', async () => {
    const { app } = build();
    const made = await (await app.request('/api/v1/invites', json({ note: 'bob' }))).json();
    expect(made.invite.url).toStartWith(`${config.siteUrl}/i/INV-`);
    await app.request('/api/v1/invites', json({}));
    const third = await app.request('/api/v1/invites', json({}));
    expect(third.status).toBe(409);

    const mine = await (await app.request('/api/v1/invites')).json();
    expect(mine.quota).toEqual({ total: 2, used: 2, left: 0 });
    expect(mine.bonus_days).toBe(7);

    const { app: anon } = build(null);
    // anon shares nothing with app's stores, so check the landing on app itself signed out:
    const landing = await anon.request(`/i/${made.invite.code}`);
    expect(landing.status).toBe(404);

    const revoke = await app.request(`/api/v1/invites/${made.invite.id}/revoke`, json({}));
    expect(revoke.status).toBe(200);
  });

  test('/i/<code> remembers a good invite for a signed-out visitor', async () => {
    const { app, services } = build(null);
    const { invite } = await lib.createInvite(ALICE.id, '', services);
    const res = await app.request(`/i/${invite.code.toLowerCase()}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain(`ndb_invite=${invite.code}`);
    expect(await res.text()).toContain('Create your account');
  });

  test('/i/<number> is not an invite (that is an item page)', async () => {
    const { app } = build(null);
    expect((await app.request('/i/12345')).status).toBe(404);
    expect((await app.request('/i/12345')).headers.get('set-cookie')).toBeNull();
  });

  test('the invites page renders the plaintext once', async () => {
    const { app } = build();
    const res = await app.request('/invites', {
      method: 'POST',
      body: new URLSearchParams({ note: 'carol' }),
    });
    expect(res.status).toBe(303);
    const page = await (await app.request('/invites')).text();
    expect(page).toContain('/i/INV-');
    expect(page).toContain('carol');
  });
});

describe('admin mint', () => {
  test('admins only', async () => {
    const { app } = build(ALICE);
    expect((await app.request('/api/v1/admin/credits', json({ days: 5 }))).status).toBe(403);
  });

  test('mints, lists without the code, revokes', async () => {
    const { app } = build(ADMIN);
    const res = await app.request(
      '/api/v1/admin/credits',
      json({ days: 30, label: 'him', max: 1 }),
    );
    const made = await res.json();
    expect(made.code).toMatch(/^CR-/);
    expect(made.days).toBe(30);
    const { codes } = await (await app.request('/api/v1/admin/credits')).json();
    expect(codes).toHaveLength(1);
    expect(codes[0].code).toBeUndefined();
    expect((await app.request(`/api/v1/admin/credits/${made.id}/revoke`, json({}))).status).toBe(
      200,
    );
    const bad = await app.request('/api/v1/admin/credits', json({ days: 0 }));
    expect(bad.status).toBe(400);
  });
});
