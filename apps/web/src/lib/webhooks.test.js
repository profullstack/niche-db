import { describe, expect, test } from 'bun:test';
import { memoryStore } from '@profullstack/webhooks';
import { Hono } from 'hono';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';
const { createHub } = await import('@nichedb/notify/hub');

/** /api/v1/webhooks: the package's routes, scoped to an API key's account and refused to a session. */
const ALICE = '11111111-1111-4111-8111-111111111111';
function hubOn(store) {
  return {
    hub: createHub({
      store,
      siteUrl: 'https://nichedb.dev',
      guard: { lookup: async () => ['93.184.215.14'] },
      fetchImpl: async () => new Response(null, { status: 204 }),
    }),
  };
}

const { mountWebhooksApi } = await import('./webhooks.js');

describe('/api/v1/webhooks', () => {
  function app(user, viaKey) {
    const { hub } = hubOn(memoryStore());
    const a = new Hono();
    a.use('*', async (c, next) => {
      c.set('user', user);
      c.set('viaKey', viaKey);
      await next();
    });
    mountWebhooksApi(a, { hub });
    return a;
  }

  test('401 without a key, and for a browser session', async () => {
    expect((await app(null, false).request('/api/v1/webhooks')).status).toBe(401);
    expect((await app({ id: ALICE }, false).request('/api/v1/webhooks')).status).toBe(401);
  });

  test('with a key: create, list, and the event types', async () => {
    const a = app({ id: ALICE }, true);
    const made = await a.request('/api/v1/webhooks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://a.example/hook', events: ['feed.item.published'] }),
    });
    expect(made.status).toBe(201);
    expect((await made.json()).secret.startsWith('whsec_')).toBe(true);
    const list = await (await a.request('/api/v1/webhooks')).json();
    expect(list.endpoints.length).toBe(1);
    expect(list.event_types).toContain('feed.item.published');
  });
});
