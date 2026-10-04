import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
const { config } = await import('@nichedb/config');
// Signed-out pages render through Redis otherwise, and there is none here.
// Set on the object, not the env: another file may have loaded config first.
config.cache.enabled = false;
const { registerCrawlStatus } = await import('./crawlstatus.js');
const { crawlHealth, fillHours } = await import('../lib/crawlstatus.js');
const { isReservedNicheSlug } = await import('@nichedb/knowledge');

const NOW = Date.parse('2026-10-04T12:30:00Z');
const minutesAgo = (m) => new Date(NOW - m * 60_000);
const status = (over = {}) => ({
  sources: {
    total: 10,
    enabled: 8,
    paused: 2,
    failing: 1,
    waiting: 0,
    ok: 7,
    overdue: 0,
    items: 1234,
  },
  day: { runs: 40, ok: 38, errors: 2, running: 0, sources: 8, seen: 900, added: 12, updated: 3 },
  hourly: [{ hour: new Date('2026-10-04T11:00:00Z'), ok: 3, errors: 1, running: 0 }],
  failing: [
    {
      slug: 'npm',
      name: 'npm registry',
      adapter: 'npm',
      collection_name: 'Packages',
      last_ok_at: minutesAgo(300),
      last_error: 'HTTP 429 <too many>',
    },
  ],
  overdue: [],
  recent: [
    {
      slug: 'npm',
      name: 'npm registry',
      adapter: 'npm',
      status: 'error',
      started_at: minutesAgo(3),
      seen: 0,
      added: 0,
      updated: 0,
      error: 'HTTP 429',
    },
  ],
  ...over,
});

describe('crawlHealth', () => {
  test('a few failing sources is still crawling', () => {
    expect(crawlHealth(status(), NOW).state).toBe('ok');
  });
  test('nothing started in two hours is stalled', () => {
    const recent = [{ ...status().recent[0], started_at: minutesAgo(121) }];
    expect(crawlHealth(status({ recent }), NOW).state).toBe('stalled');
    expect(crawlHealth(status({ recent: [] }), NOW).state).toBe('stalled');
  });
  test('a quarter of the fleet failing or overdue is degraded', () => {
    const s = status();
    expect(crawlHealth({ ...s, sources: { ...s.sources, failing: 2 } }, NOW).state).toBe(
      'degraded',
    );
    expect(crawlHealth({ ...s, sources: { ...s.sources, overdue: 2 } }, NOW).state).toBe(
      'degraded',
    );
  });
  test('no enabled sources is idle, not stalled', () => {
    const s = status();
    expect(crawlHealth({ ...s, sources: { ...s.sources, enabled: 0 } }, NOW).state).toBe('idle');
  });
});

test('fillHours gives 24 hours ending now, empty ones as zero', () => {
  const hours = fillHours(status().hourly, NOW);
  expect(hours).toHaveLength(24);
  expect(hours[23].hour.toISOString()).toBe('2026-10-04T12:00:00.000Z');
  expect(hours[22]).toMatchObject({ ok: 3, errors: 1 });
  expect(hours[0].hour.toISOString()).toBe('2026-10-03T13:00:00.000Z');
  expect(hours.filter((h) => h.ok || h.errors)).toHaveLength(1);
});

describe('routes', () => {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', null);
    await next();
  });
  registerCrawlStatus(app, { read: async () => status() });

  test('/crawlstatus renders the board', async () => {
    const res = await app.request('/crawlstatus', { headers: { accept: 'text/html' } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<h1>Crawl status</h1>');
    expect(html).toContain('href="/s/npm"');
    // Upstream error text is escaped, never markup.
    expect(html).toContain('HTTP 429 &lt;too many&gt;');
    expect(html).toContain('href="/crawlstatus"');
    expect(html).not.toContain('[object Promise]');
  });

  test('JSON on the page and under /api/v1', async () => {
    for (const path of ['/crawlstatus', '/api/v1/crawlstatus']) {
      const res = await app.request(path, { headers: { accept: 'application/json' } });
      const body = await res.json();
      expect(body.health.state).toBeDefined();
      expect(body.sources.enabled).toBe(8);
      expect(body.hourly).toHaveLength(24);
      expect(body.failing[0].slug).toBe('npm');
    }
  });

  test('/crawlstats, the sister sites name, redirects', async () => {
    const res = await app.request('/crawlstats');
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('/crawlstatus');
  });
});

test('no niche can take the page’s address', () => {
  expect(isReservedNicheSlug('crawlstatus')).toBe(true);
  expect(isReservedNicheSlug('crawlstats')).toBe(true);
});
