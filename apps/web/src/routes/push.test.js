import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { Hono } from 'hono';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';
const { generateVapidKeys } = await import('@profullstack/notifications/server');
const { registerAuth } = await import('./auth.js');
const { registerStatic } = await import('./static.js');

/*
 * The push key is served at runtime rather than written into the page. A key
 * baked in at render or build time is how push broke on a sibling site: it was
 * empty in production, and every browser was told push was not supported.
 */
const KEYS = ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'];
let saved;
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
});
afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function build() {
  const app = new Hono();
  registerAuth(app);
  registerStatic(app, { robotsTxt: () => '' });
  return app;
}

describe('push', () => {
  test('the public key is read from the environment on each request', async () => {
    const keys = generateVapidKeys();
    process.env.VAPID_PUBLIC_KEY = keys.publicKey;
    process.env.VAPID_PRIVATE_KEY = keys.privateKey;
    const res = await build().request('/api/push/vapid-public-key');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ publicKey: keys.publicKey });
  });

  test('without a key pair it says so instead of serving an empty key', async () => {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    const res = await build().request('/api/push/vapid-public-key');
    expect(res.status).toBe(503);
    expect((await res.json()).publicKey).toBeNull();
  });

  test('the browser client is served from the package', async () => {
    const res = await build().request('/vendor-notifications.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/javascript');
    expect(await res.text()).toContain('export function pushSupport');
  });

  test('the page no longer carries the key, and app.js asks for it', async () => {
    const layout = await readFile(new URL('../views/Layout.jsx', import.meta.url), 'utf8');
    expect(layout).not.toContain('__VAPID');
    const app = await readFile(new URL('../../public/app.js', import.meta.url), 'utf8');
    expect(app).toContain("import('/vendor-notifications.js')");
    expect(app).not.toContain('__VAPID');
  });
});
