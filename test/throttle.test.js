/**
 * The site-wide allowance.
 *
 * The gate charges crawlers that say who they are. Nothing charged the ones
 * that do not, and nothing counted a page route at all -- which is the shape
 * that failed on coinpayportal on 2026-09-08, where a headless browser found a
 * route nobody had listed and walked 19,000 of its URLs a day for two days.
 */
import { describe, expect, test } from 'bun:test';

// The config reads the environment once at import. A gateway needs a key and a
// payTo to make a real offer; without them a refusal is a 429, which is correct
// behaviour but not what these tests are about.
const PAY_TO = '0xCC3b072391AE7A8d10cF00DdC5F61DB2cA5541E5';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';
process.env.COINPAY_X402_KEY ??= 'cp_live_test_secret_0123456789';
process.env.CRAWL_PAY_TO ??= PAY_TO;

// The site's own gateway factory, not a stand-in: the price a refusal quotes is
// the buyer's own, and that is exactly the part worth testing.
const { gatewayAt } = await import('../apps/web/src/lib/pricing.js');
const { meter } = await import('../apps/web/src/lib/throttle.js');
const BROWSER =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

/**
 * The gateway that charges this much a day -- the same one the app would pick.
 *
 * Always at a price nothing else uses. `gatewayAt` memoises one gateway per
 * price, and pricing.js builds the LIST-price one at import; if that import
 * happened before this file set the environment above, the cached gateway has
 * no key, cannot take money, and every refusal here is a 429. That is exactly
 * what happened in CI while these tests asked for the list price and passed
 * locally, where the files happened to load the other way round.
 */
const paid = (priceCents) => gatewayAt(priceCents);

const request = (path, ip, headers = {}) =>
  new Request(`https://nichedb.test${path}`, {
    headers: { 'user-agent': BROWSER, 'sec-fetch-mode': 'navigate', 'x-real-ip': ip, ...headers },
  });

/** How many land before the throttle refuses. Each case needs its own address. */
async function countUntilLimited(gateway, path, ip, attempts, headers = {}) {
  let allowed = 0;
  for (let i = 0; i < attempts; i++) {
    if (await meter(gateway, request(path, ip, headers))) break;
    allowed++;
  }
  return allowed;
}

describe('the site-wide allowance', () => {
  const gateway = paid(250);

  test('meters a page route, which nothing here did before', async () => {
    expect(await countUntilLimited(gateway, '/niches/housing', '10.5.0.1', 140)).toBe(100);
  });

  test('gives each caller its own allowance', async () => {
    expect(await countUntilLimited(gateway, '/niches/housing', '10.5.0.2', 5)).toBe(5);
    expect(await countUntilLimited(gateway, '/niches/housing', '10.5.0.3', 5)).toBe(5);
  });

  test('keeps sign-in address-bucketed however it is credentialed', async () => {
    // Or a brute-force bolts on an Authorization header and buys the member budget.
    const allowed = await countUntilLimited(gateway, '/auth/verify', '10.5.0.4', 40, {
      authorization: 'Bearer anything',
    });
    expect(allowed).toBe(10);
  });

  test('never meters the health check', async () => {
    expect(await countUntilLimited(gateway, '/healthz', '10.5.0.5', 150)).toBe(150);
  });

  test('refuses with 402 and an offer, not 429', async () => {
    for (let i = 0; i < 100; i++) await meter(gateway, request('/niches/crime', '10.5.0.6'));
    const answer = await meter(gateway, request('/niches/crime', '10.5.0.6'));
    expect(answer?.status).toBe(402);
    const body = await answer.json();
    expect(body.accepts.length).toBeGreaterThan(0);
    expect(body.error).toMatch(/100 requests per 60s/);
  });
});

describe('the price a refusal quotes', () => {
  // The price here is the buyer's own: a dollar a day at list, less the more it
  // has spent. A refusal has to quote the price THAT buyer would pay.
  test('follows the gateway the request was priced with', async () => {
    const discounted = paid(37);
    for (let i = 0; i < 100; i++) await meter(discounted, request('/niches/markets', '10.5.0.7'));
    const answer = await meter(discounted, request('/niches/markets', '10.5.0.7'));
    expect(answer?.status).toBe(402);
    expect((await answer.json()).pass.price).toBe('0.37 USD');
  });

  test('but the counting does not split along with it', async () => {
    // Or a caller crossing a discount threshold mid-window would be handed a
    // fresh hundred requests for the privilege.
    const list = paid(250);
    const discounted = paid(37);
    for (let i = 0; i < 60; i++) await meter(list, request('/niches/news', '10.5.0.8'));
    for (let i = 0; i < 40; i++) await meter(discounted, request('/niches/news', '10.5.0.8'));
    const answer = await meter(discounted, request('/niches/news', '10.5.0.8'));
    expect(answer?.status).toBe(402);
  });
});
