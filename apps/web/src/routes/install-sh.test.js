import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';
const { registerStatic } = await import('./static.js');
const { gatewayOptions } = await import('../lib/pricing.js');

/*
 * `curl -fsSL https://nichedb.dev/install.sh | sh` is the CLI's one-line
 * install. It has to come back as a shell script, not the HTML 404 page, and
 * the crawl gateway must not answer it with a 402.
 */
describe('/install.sh', () => {
  test('is served as a shell script that installs the published CLI', async () => {
    const app = new Hono();
    registerStatic(app, { robotsTxt: () => '' });
    const res = await app.request('/install.sh');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toStartWith('text/x-sh');
    const body = await res.text();
    expect(body.startsWith('#!/bin/sh')).toBe(true);
    expect(body).toContain('PKG="@profullstack/nichedb"');
  });

  test('is open past the crawl gateway', () => {
    expect(gatewayOptions(100).openPaths).toContain('/install.sh');
  });
});
