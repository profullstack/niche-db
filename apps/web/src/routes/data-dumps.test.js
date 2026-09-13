import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
const { config } = await import('@nichedb/config');
const { entitlements } = await import('@nichedb/premium');
const { registerDataDumps } = await import('./data-dumps.js');
const { startDataCheckout } = await import('../lib/data-checkout.js');
const { Denied } = await import('../lib/service.js');
const { DataDumpsPage, DataDumpsOffer } = await import('../views/data-dumps.jsx');
const ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const manifest = {
  id: ID,
  snapshot_at: new Date().toISOString(),
  rows: 1,
  bytes: 30,
  parts: [
    {
      file: 'part-00001.ndjson.gz',
      key: `snapshots/${ID}/part-00001.ndjson.gz`,
      rows: 1,
      bytes: 30,
      sha256: 'abc',
    },
  ],
};
const USER = { id: '11111111-1111-4111-8111-111111111111', role: 'user' };
function build(plan = 'free', user = USER, current = manifest) {
  const downloads = [];
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', user);
    c.set('entitlements', entitlements(plan));
    await next();
  });
  app.onError((err, c) =>
    err instanceof Denied
      ? c.json({ error: err.message }, err.status)
      : c.json({ error: err.message }, 500),
  );
  registerDataDumps(app, {
    latest: async () => current,
    find: async (id) => (id === ID ? current : null),
    storage: () => ({
      download: (key, ttl) => {
        downloads.push({ key, ttl });
        return 'https://storage.test/signed';
      },
    }),
  });
  return { app, downloads };
}
describe('hourly dump downloads', () => {
  test('anonymous and other paid plans cannot retrieve a manifest or sign a download', async () => {
    for (const [plan, user, status] of [
      ['free', null, 401],
      ['free', USER, 402],
      ['premium', USER, 402],
      ['pro', USER, 402],
    ]) {
      const { app, downloads } = build(plan, user);
      for (const path of ['/api/v1/dumps/latest', `/api/v1/dumps/${ID}/part-00001.ndjson.gz`])
        expect((await app.request(path, { headers: { accept: 'application/json' } })).status).toBe(
          status,
        );
      expect(downloads).toEqual([]);
    }
  });
  test('Data sees authenticated file URLs and private responses, not internal object keys', async () => {
    const { app } = build('data');
    const res = await app.request('/api/v1/dumps/latest');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const doc = await res.json();
    expect(doc.parts[0].url).toBe(`${config.siteUrl}/api/v1/dumps/${ID}/part-00001.ndjson.gz`);
    expect(doc.parts[0]).not.toHaveProperty('key');
  });
  test('a download signs only a retained manifest part for five minutes', async () => {
    const { app, downloads } = build('data');
    const res = await app.request(`/api/v1/dumps/${ID}/part-00001.ndjson.gz`);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://storage.test/signed');
    expect(downloads).toEqual([{ key: manifest.parts[0].key, ttl: 300 }]);
    expect((await app.request(`/api/v1/dumps/${ID}/secrets.env`)).status).toBe(404);
    expect((await app.request('/api/v1/dumps/not-a-uuid/part-00001.ndjson.gz')).status).toBe(404);
    expect(downloads).toHaveLength(1);
  });
  test('a missing or expired snapshot never yields a download link', async () => {
    const { app, downloads } = build('data', USER, null);
    expect((await app.request('/api/v1/dumps/latest')).status).toBe(503);
    expect((await app.request(`/api/v1/dumps/${ID}/part-00001.ndjson.gz`)).status).toBe(404);
    expect(downloads).toEqual([]);
  });
});

const keys = ['COINPAY_API_KEY', 'COINPAY_BUSINESS_ID', 'COINPAY_WEBHOOK_SECRET'];
let saved;
beforeEach(() => {
  saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) process.env[key] = 'test-only';
});
afterEach(() => {
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});
describe('Data checkout and offer', () => {
  test('the purchase charges $1,999 for exactly 30 days of the Data plan', async () => {
    const calls = [];
    const out = await startDataCheckout(USER, {
      storageReady: true,
      latest: async () => manifest,
      createCheckout: async (args) => {
        calls.push(args);
        return { checkoutUrl: 'https://pay.test/data' };
      },
    });
    expect(out.checkoutUrl).toBe('https://pay.test/data');
    expect(calls[0].amountCents).toBe(199900);
    expect(calls[0].metadata).toMatchObject({ plan: 'data', term_days: '30', kind: 'membership' });
  });
  test('a configured payment provider cannot sell dumps before the first export is ready', async () => {
    let called = false;
    await expect(
      startDataCheckout(USER, {
        storageReady: true,
        latest: async () => null,
        createCheckout: async () => {
          called = true;
        },
      }),
    ).rejects.toThrow('first hourly data dump');
    expect(called).toBe(false);
  });
  test('the offer preserves $1,999/month and a ready page exposes the actual checkout', async () => {
    expect(await DataDumpsOffer({}).toString()).toContain('$1,999');
    const page = await DataDumpsPage({
      user: USER,
      access: false,
      snapshot: null,
      ready: true,
    }).toString();
    expect(page).toContain('/api/dumps/buy');
    expect(page).toContain('30 days');
    expect(page).toContain('Every hour.');
    const warming = await DataDumpsPage({
      user: USER,
      access: false,
      snapshot: null,
      ready: false,
    }).toString();
    expect(warming).not.toContain('/api/dumps/buy');
  });
});
