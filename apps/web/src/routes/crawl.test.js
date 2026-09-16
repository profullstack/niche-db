import { expect, test } from 'bun:test';
import { createGateway } from '@profullstack/x402-gateway';

process.env.DATABASE_URL ??= 'postgres://localhost/unused';
const { gatewayOptions } = await import('../lib/pricing.js');
const gateway = createGateway({
  ...gatewayOptions(100),
  siteUrl: 'https://nichedb.test',
  payTo: '0x1111111111111111111111111111111111111111',
  secret: 'test-only',
  coinpay: { apiKey: 'test-only' },
});

test('crawl HTML uses shared layout and the actual multi-term offer', async () => {
  const response = await gateway.handle(
    new Request('https://nichedb.test/crawl?days=7', { headers: { accept: 'text/html' } }),
  );
  expect(response.status).toBe(402);
  const html = await response.text();
  expect(html).toContain('class="topbar"');
  expect(html).toContain('/styles.css');
  expect(html).toContain('$7.00');
  expect(html).toContain('https://nichedb.test/crawl?days=7');
  expect(html).toContain('name="robots" content="noindex"');
  expect(html).not.toContain('[object Promise]');
});

test('machine clients retain the x402 offer and term pricing', async () => {
  const response = await gateway.handle(
    new Request('https://nichedb.test/crawl?days=7', { headers: { accept: 'application/json' } }),
  );
  expect(response.status).toBe(402);
  const offer = await response.json();
  expect(offer.x402Version).toBe(2);
  expect(offer.accepts[0].amount).toBe('7000000');
  expect(offer.pass.days).toBe(7);
});
