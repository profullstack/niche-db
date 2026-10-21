import { expect, test } from 'bun:test';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';
const { renderCrawlPage } = await import('../apps/web/src/views/crawl.jsx');

const ctx = {
  siteName: 'NicheDB',
  siteUrl: 'https://nichedb.dev',
  buyUrl: 'https://nichedb.dev/crawl',
  price: '1.00 USD',
  total: '1.00 USD',
  minutes: 1440,
  days: 1,
  maxDays: 30,
  header: 'x-crawl-pass',
  enabled: true,
  training: ['GPTBot'],
  retrieval: ['OAI-SearchBot'],
};

test('the Buy a day pass form posts to the gateway checkout when CoinPay serves it', () => {
  const html = renderCrawlPage({
    ...ctx,
    checkout: { action: '/crawl/checkout', from: '/games', days: 1 },
  });
  expect(html).toContain('Buy a day pass');
  expect(html).toContain('action="/crawl/checkout"');
  expect(html).toContain('name="from" value="/games"');
  expect(html).toContain('name="email"');
});

test('no form while checkout is unavailable', () => {
  const html = renderCrawlPage({ ...ctx, checkout: null });
  expect(html).not.toContain('/crawl/checkout');
});
