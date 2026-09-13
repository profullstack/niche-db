import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';
const { config } = await import('@nichedb/config');
const { membershipTerm } = await import('@nichedb/payments/membership');
const { entitlements } = await import('@nichedb/premium');
const { startPremiumCheckout, prices } = await import('../lib/premium-checkout.js');
const { Denied } = await import('../lib/service.js');
const { registerPremium } = await import('./premium.js');
const { registerOpenSaaS } = await import('./opensaas.js');

const USER = { id: '11111111-1111-4111-8111-111111111111', role: 'user' };
const CHECKOUT = 'https://coinpayportal.com/pay/test-payment';
const KEYS = ['COINPAY_API_KEY', 'COINPAY_BUSINESS_ID', 'COINPAY_WEBHOOK_SECRET'];
let saved;
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) process.env[key] = 'test-only';
});
afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function build(user = USER) {
  const calls = [];
  const checkout = (buyer, term) =>
    startPremiumCheckout(buyer, term, {
      createCheckout: async (args) => {
        calls.push(args);
        return { checkoutUrl: CHECKOUT };
      },
    });
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', user);
    c.set('plan', 'free');
    c.set('entitlements', entitlements('free'));
    await next();
  });
  app.onError((err, c) => {
    if (err.redirect) return c.redirect(err.redirect, 303);
    if (err instanceof Denied) return c.json({ error: err.message }, err.status);
    throw err;
  });
  registerPremium(app, { checkout });
  registerOpenSaaS(app, { premiumCheckout: checkout, actor: async () => ({ user }) });
  return { app, calls };
}
const form = (term) => ({ method: 'POST', body: new URLSearchParams({ term }) });
const json = (body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe('Premium checkout', () => {
  test('all three forms buy membership and redirect to the actual payment provider', async () => {
    const { app, calls } = build();
    for (const [term, days, cents] of [
      ['day', 1, prices().dayCents],
      ['month', 30, prices().monthCents],
      ['year', 365, prices().yearCents],
    ]) {
      const res = await app.request('/api/premium/buy', form(term));
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe(CHECKOUT);
      const purchase = calls.at(-1);
      expect(purchase.amountCents).toBe(cents);
      expect(purchase.metadata).toMatchObject({
        kind: 'membership',
        plan: 'premium',
        term_days: String(days),
        list_price_cents: String(cents),
      });
      // The exact metadata emitted by checkout is what settlement resolves.
      expect(membershipTerm(purchase.metadata, config.membership.termDays)).toEqual({
        plan: 'premium',
        days,
      });
    }
  });
  test('JSON buyers can choose a day instead of silently getting a month', async () => {
    const { app, calls } = build();
    const res = await app.request('/api/premium/buy', json({ term: 'day' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ checkoutUrl: CHECKOUT });
    expect(calls[0].metadata.term_days).toBe('1');
  });
  test('signed-out, invalid-term and disabled-payment requests never create a payment', async () => {
    const guest = build(null);
    expect(
      (
        await guest.app.request('/api/premium/buy', {
          ...form('day'),
          headers: { accept: 'application/json' },
        })
      ).status,
    ).toBe(401);
    expect(guest.calls).toEqual([]);
    const { app, calls } = build();
    expect((await app.request('/api/premium/buy', form('forever'))).status).toBe(400);
    delete process.env.COINPAY_API_KEY;
    expect((await app.request('/api/premium/buy', form('day'))).status).toBe(400);
    expect(calls).toEqual([]);
  });
  test('the advertised daily OpenSaaS plan uses membership checkout', async () => {
    const { app, calls } = build();
    const descriptor = await (await app.request('/.well-known/opensaas.json')).json();
    const day = descriptor.plans.find((p) => p.id === 'premium-day');
    expect(day.price).toBe(prices().dayCents / 100);
    expect(day.url).toBe(`${config.siteUrl}/premium?term=day#plans`);
    expect(day.renews).toBe(false);
    const res = await app.request('/api/v1/billing/subscribe', json({ plan: day.id }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(CHECKOUT);
    expect(calls[0].metadata.term_days).toBe('1');
  });
  test('the pricing API distinguishes account membership from an anonymous crawl pass', async () => {
    const { app } = build();
    const result = await (await app.request('/api/v1/premium')).json();
    expect(result.pricing.renews).toBe(false);
    expect(result.pricing.purchase).toEndWith('/api/premium/buy');
    expect(result.pricing.crawl_pass.includes_account_perks).toBe(false);
    expect(result.compared_with.rows.map((r) => r.feature)).toEqual(
      expect.arrayContaining(['AI search', 'New comment highlighting', 'Performance analytics']),
    );
  });
  test('unknown settlement terms cannot silently become a longer or higher plan', () => {
    expect(membershipTerm({}, 30)).toEqual({ plan: 'pro', days: 30 });
    for (const meta of [
      { plan: 'premium' },
      { plan: 'premium', term_days: '2' },
      { plan: 'pro', term_days: '1' },
      { plan: 'platinum', term_days: '365' },
    ]) {
      expect(() => membershipTerm(meta, 30)).toThrow('Unknown membership');
    }
  });
});
