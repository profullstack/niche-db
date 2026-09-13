/**
 * nichedb's own OpenSaaS descriptor and the endpoints it names, over a fake
 * store. What would be embarrassing: an action listed that is not real, a
 * cancel a stranger can call, an export that hands back somebody else's
 * rows, a delete that happens without the link.
 */
import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';

const { descriptor, actor, SCOPES } = await import('../lib/opensaas.js');
const { registerOpenSaaS } = await import('./opensaas.js');
const { Denied } = await import('../lib/service.js');

const ALICE = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'alice@example.com',
  role: 'user',
};

function build({ user = null, principal = null } = {}) {
  const calls = [];
  const store = {
    async activePlans() {
      return [{ plan: 'premium', expires_at: '2026-10-01T00:00:00Z', terms: 1 }];
    },
    async cancelPlan(userId, plan) {
      calls.push(['cancel', userId, plan]);
      return plan === 'premium' ? [{ id: 1, plan, expires_at: 'now', cancelled_at: 'now' }] : [];
    },
    async exportAccount(userId) {
      calls.push(['export', userId]);
      return { account: { id: userId }, api_keys: [], follows: [] };
    },
    async createActionToken(userId, action) {
      calls.push(['token', userId, action]);
      return 'tok-1';
    },
    async consumeActionToken(token, action) {
      calls.push(['consume', token, action]);
      return token === 'tok-1' ? ALICE.id : null;
    },
    async deleteAccount(userId) {
      calls.push(['delete', userId]);
      return { email: ALICE.email };
    },
    async userByEmail(email) {
      return email === ALICE.email ? ALICE : null;
    },
  };
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', user);
    c.set('viaKey', false);
    await next();
  });
  app.onError((err, c) => {
    if (err instanceof Denied) return c.json({ error: err.message }, err.status ?? 400);
    throw err;
  });
  registerOpenSaaS(app, {
    store,
    actor: (c, scope) =>
      actor(c, scope, { principal: async () => principal, byEmail: store.userByEmail }),
    sendDeleteLink: async (m) => calls.push(['mail', m.email, m.url]),
  });
  return { app, calls };
}

const json = (body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json' },
  body: JSON.stringify(body),
});

describe('the descriptor', () => {
  test('served as JSON, open to any origin, and every action it lists has a page', async () => {
    const { app } = build();
    const res = await app.request('/.well-known/opensaas.json');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const doc = await res.json();
    expect(doc.opensaas).toBe('0.1');
    expect(doc.service.name).toBeTruthy();
    expect(doc.service.openaccess).toBe('https://nichedb.test/.well-known/openaccess.json');
    for (const [name, act] of Object.entries(doc.actions)) {
      expect(act.page, name).toMatch(/^https:\/\/nichedb\.test\//);
      if (act.api) expect(act.scope, name).toMatch(/^[a-z]+:[a-z]+$/);
    }
    // Export and delete are always real; the mail action is a page only.
    expect(doc.actions.export.api.url).toBe('https://nichedb.test/api/v1/account/export');
    expect(doc.actions.delete.confirm).toBe('email');
    expect(doc.actions.delete.retention).toBe('P0D');
    if (doc.actions.unsubscribe) expect(doc.actions.unsubscribe.api).toBeUndefined();
    // Nothing here renews itself, and the file says so on every plan.
    for (const plan of doc.plans) expect(plan.renews).toBe(false);
  });

  test('without payments there is no subscribe and no cancel: absence is unstated', () => {
    const doc = descriptor();
    // The test environment has no CoinPay key, so the checkout is off.
    expect(doc.plans).toEqual([]);
    expect(doc.actions.subscribe).toBeUndefined();
    expect(doc.actions.cancel).toBeUndefined();
    expect(doc.policies).toEqual({});
  });
});

describe('the way out', () => {
  test('a stranger cannot cancel, export or ask for deletion', async () => {
    const { app, calls } = build();
    for (const path of [
      '/api/v1/billing/cancel',
      '/api/v1/account/export',
      '/api/v1/account/delete',
    ]) {
      const res = await app.request(path, json({}));
      expect(res.status, path).toBe(401);
    }
    expect(calls).toEqual([]);
  });

  test('a signed-in member ends a plan with one call and is told nothing is refunded', async () => {
    const { app, calls } = build({ user: ALICE });
    const res = await app.request('/api/v1/billing/cancel', json({ plan: 'premium' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('done');
    expect(body.refund).toBe('none');
    expect(body.ended).toHaveLength(1);
    expect(calls).toEqual([['cancel', ALICE.id, 'premium']]);
    const bad = await app.request('/api/v1/billing/cancel', json({ plan: 'gold' }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).status).toBe('refused');
  });

  test('an OpenAccess bearer acts for the account its email maps to, with the scope, and no other', async () => {
    const ok = build({ principal: { sub: 'p1', scopes: [SCOPES.cancel], email: ALICE.email } });
    const res = await ok.app.request('/api/v1/billing/cancel', json({}));
    expect(res.status).toBe(200);
    expect(ok.calls.map((c) => c[0])).toEqual(['cancel', 'cancel']);
    const wrongScope = build({
      principal: { sub: 'p1', scopes: ['openprofile:edit'], email: ALICE.email },
    });
    expect((await wrongScope.app.request('/api/v1/account/export', json({}))).status).toBe(403);
    const nobody = build({
      principal: { sub: 'p2', scopes: [SCOPES.export], email: 'nobody@example.com' },
    });
    expect((await nobody.app.request('/api/v1/account/export', json({}))).status).toBe(404);
  });

  test('export hands back the caller rows and nobody else', async () => {
    const { app, calls } = build({ user: ALICE });
    const res = await app.request('/api/v1/account/export', json({}));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect((await res.json()).account.id).toBe(ALICE.id);
    expect(calls).toEqual([['export', ALICE.id]]);
  });

  test('deletion is asked, confirmed by the link, and only then done', async () => {
    const { app, calls } = build({ user: ALICE });
    const ask = await app.request('/api/v1/account/delete', json({}));
    expect(ask.status).toBe(200);
    const body = await ask.json();
    expect(body.status).toBe('pending');
    expect(body.confirm).toBe('email');
    expect(calls[0]).toEqual(['token', ALICE.id, 'delete-account']);
    expect(calls[1][0]).toBe('mail');
    expect(calls[1][2]).toBe('https://nichedb.test/account/delete/confirm?t=tok-1');
    expect(calls.some((c) => c[0] === 'delete')).toBe(false);
    const bad = await app.request('/account/delete/confirm?t=nope');
    expect(bad.status).toBe(400);
    const done = await app.request('/account/delete/confirm?t=tok-1');
    expect(done.status).toBe(200);
    expect(calls.at(-1)).toEqual(['delete', ALICE.id]);
    expect(done.headers.get('set-cookie')).toContain('=;');
  });
});
