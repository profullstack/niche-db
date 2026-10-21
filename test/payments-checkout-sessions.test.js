import { afterEach, describe, expect, test } from 'bun:test';

/*
 * Version 2 of the shared payments file: checkout is a CoinPay hosted checkout
 * session. Copied verbatim between brands along with the file it tests, so it
 * names no brand and wires the package the same way an app does.
 */
const pay = await import('../packages/payments/src/index.js');

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A fake `sql` that records every statement and every object helper call. */
function fakeSql(
  rows = [{ id: 7, user_id: 'u1', status: 'pending', amount_cents: 500, currency: 'USD' }],
) {
  const calls = [];
  const sql = (strings, ...values) => {
    if (!Array.isArray(strings)) return { __obj: strings };
    calls.push({ text: strings.join('?'), values });
    return rows;
  };
  sql.begin = async (fn) => fn(sql);
  return { sql, calls };
}

function wire({ sql = fakeSql().sql, siteUrl = 'https://www.example.test/', property } = {}) {
  pay.configurePayments({
    sql,
    coinpay: {
      apiKey: `cp_live_${'a'.repeat(32)}`,
      businessId: 'biz_test',
      webhookSecret: 'whsec_test',
      baseUrl: 'https://coinpay.example',
      enabled: true,
    },
    siteUrl,
    ...(property ? { property } : {}),
  });
}

function mockFetch(
  answer = { id: 'cs_abc123', url: 'https://coinpay.example/checkout/cs_abc123' },
  status = 201,
) {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init, body: init?.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify(answer), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return seen;
}

describe('createCheckout opens a hosted checkout session', () => {
  test('posts the contract fields with the business key', async () => {
    const { sql, calls } = fakeSql();
    wire({ sql });
    const seen = mockFetch();
    const out = await pay.createCheckout({
      user: { id: 'u1', email: 'buyer@example.com' },
      amountCents: 500,
      description: 'A thing',
      metadata: { kind: 'membership', plan: 7 },
      successUrl: 'https://example.test/ok?s={CHECKOUT_SESSION_ID}',
      cancelUrl: 'https://example.test/back',
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('https://coinpay.example/api/checkout/sessions');
    expect(seen[0].init.method).toBe('POST');
    expect(seen[0].init.headers.authorization).toBe(`Bearer cp_live_${'a'.repeat(32)}`);
    const b = seen[0].body;
    expect(b.amount).toBe(5);
    expect(b.currency).toBe('USD');
    expect(b.customer_email).toBe('buyer@example.com');
    expect(b.account_id).toBe('u1');
    expect(b.property).toBe('www.example.test');
    expect(b.metadata).toMatchObject({
      kind: 'membership',
      plan: '7',
      user_id: 'u1',
      email: 'buyer@example.com',
    });
    expect(b.success_url).toContain('{CHECKOUT_SESSION_ID}');
    expect(b.expires_in_minutes).toBe(60);
    expect(b.blockchain).toBeUndefined();
    expect(b.merchant_wallet_address).toBeUndefined();

    expect(out).toEqual({
      checkoutUrl: 'https://coinpay.example/checkout/cs_abc123',
      paymentRef: 'cs_abc123',
      sessionId: 'cs_abc123',
    });
    // The pending row is written under the session id.
    const insert = calls.find((c) => c.text.includes('insert into payments'));
    expect(insert.values[0].__obj).toMatchObject({
      provider_ref: 'cs_abc123',
      user_id: 'u1',
      status: 'pending',
    });
  });

  test('a configured property wins over the site url', async () => {
    wire({ property: 'https://shop.example.org/x' });
    const seen = mockFetch();
    await pay.createCheckout({
      user: { id: 1, email: 'a@b.co' },
      amountCents: 100,
      description: 'x',
    });
    expect(seen[0].body.property).toBe('shop.example.org');
    expect(seen[0].body.account_id).toBe('1');
  });

  test('an explicit email and account override the user', async () => {
    wire();
    const seen = mockFetch();
    await pay.createCheckout({
      user: { id: 'u1', email: 'old@example.com' },
      email: 'new@example.com',
      accountId: 'handle',
      amountCents: 100,
      description: 'x',
    });
    expect(seen[0].body.customer_email).toBe('new@example.com');
    expect(seen[0].body.account_id).toBe('handle');
  });

  test('a guest with no account is filed under the email', async () => {
    wire();
    const seen = mockFetch();
    await pay.createCheckout({ email: 'guest@example.com', amountCents: 100, description: 'x' });
    expect(seen[0].body.account_id).toBe('guest@example.com');
    expect(seen[0].body.metadata.user_id).toBeUndefined();
  });

  test('refuses without a valid buyer email, before calling CoinPay', async () => {
    wire();
    const seen = mockFetch();
    for (const email of [undefined, '', 'nope', 'a@b']) {
      await expect(
        pay.createCheckout({ user: { id: 'u1', email }, amountCents: 100, description: 'x' }),
      ).rejects.toThrow("buyer's email");
    }
    expect(seen).toHaveLength(0);
  });

  test('old callers that pass a chain and payee still work, and neither is sent', async () => {
    wire();
    const seen = mockFetch();
    await pay.createCheckout({
      user: { id: 'u1', email: 'a@b.co' },
      amountCents: 100,
      description: 'x',
      blockchain: 'BTC',
      payTo: 'bc1qxyz',
      paymentMethod: 'crypto',
    });
    expect(seen[0].body.blockchain).toBeUndefined();
    expect(seen[0].body.merchant_wallet_address).toBeUndefined();
  });

  test('never redirects a buyer off CoinPay', async () => {
    wire();
    mockFetch({ id: 'cs_evil', url: 'https://evil.example/phish' });
    const out = await pay.createCheckout({
      user: { id: 'u1', email: 'a@b.co' },
      amountCents: 100,
      description: 'x',
    });
    expect(out.checkoutUrl).toBe('https://coinpay.example/checkout/cs_evil');
  });

  test('a CoinPay refusal surfaces as an error', async () => {
    wire();
    mockFetch({ error: 'No payment method', code: 'NO_PAYMENT_METHODS' }, 400);
    await expect(
      pay.createCheckout({
        user: { id: 'u1', email: 'a@b.co' },
        amountCents: 100,
        description: 'x',
      }),
    ).rejects.toThrow('coinpay 400');
  });
});

describe('webhooks from a checkout session', () => {
  const sessionEvent = (status, extra = {}) => ({
    id: `evt_pay_9_${Math.floor(Date.now() / 1000)}`,
    type: `payment.${status}`,
    data: {
      payment_id: 'pay_9',
      status,
      amount: 5,
      amount_usd: 5,
      checkout_session_id: 'cs_abc123',
      customer_email: 'buyer@example.com',
      account_id: 'u1',
      property: 'example.test',
      metadata: { kind: 'membership', user_id: 'u1', checkout_session_id: 'cs_abc123' },
      ...extra,
    },
    business_id: 'biz_test',
  });

  test('readWebhook surfaces the session and buyer fields', () => {
    wire();
    const w = pay.readWebhook(sessionEvent('confirmed'));
    expect(w.ref).toBe('pay_9');
    expect(w.sessionId).toBe('cs_abc123');
    expect(w.email).toBe('buyer@example.com');
    expect(w.accountId).toBe('u1');
    expect(w.property).toBe('example.test');
    expect(w.meta.kind).toBe('membership');
  });

  test('session fields on data alone are still read', () => {
    wire();
    const ev = sessionEvent('confirmed', { metadata: { user_id: 'u1' } });
    expect(pay.readWebhook(ev).sessionId).toBe('cs_abc123');
  });

  test('settles by session id or payment id, and grants on a paid status', async () => {
    const { sql, calls } = fakeSql();
    wire({ sql });
    let granted = 0;
    const out = await pay.settleWebhook(sessionEvent('confirmed'), {
      grant: async (_tx, { meta, payment }) => {
        granted++;
        expect(meta.user_id).toBe('u1');
        expect(payment.id).toBe(7);
        return { ok: true };
      },
    });
    expect(out.granted).toBe(true);
    expect(granted).toBe(1);
    const upd = calls.find((c) => c.text.includes('update payments'));
    expect(upd.values).toContain('cs_abc123');
    expect(upd.values).toContain('pay_9');
    // A settled row is never un-settled by a later attempt's status.
    expect(upd.text).toContain("when status in ('paid', 'completed', 'confirmed', 'forwarded'");
  });

  test('an old in-flight payment (no session) still settles by payment id', async () => {
    const { sql, calls } = fakeSql();
    wire({ sql });
    const legacy = {
      id: 'evt_pay_old_1',
      type: 'payment.forwarded',
      data: {
        payment_id: 'pay_old',
        status: 'forwarded',
        metadata: { user_id: 'u1', kind: 'membership' },
      },
    };
    const out = await pay.settleWebhook(legacy, { grant: async () => ({ ok: true }) });
    expect(out.granted).toBe(true);
    const upd = calls.find((c) => c.text.includes('update payments'));
    expect(upd.values.filter((v) => v === 'pay_old')).toHaveLength(2);
  });

  test('an unpaid status never grants', async () => {
    wire({ sql: fakeSql().sql });
    for (const s of ['pending', 'detected', 'expired', 'failed', '']) {
      let granted = 0;
      const out = await pay.settleWebhook(sessionEvent(s), {
        grant: async () => {
          granted++;
          return true;
        },
      });
      expect(granted).toBe(0);
      expect(out.settled).toBe(false);
    }
  });

  test('an unknown session answers plainly instead of granting', async () => {
    wire({ sql: fakeSql([]).sql });
    const out = await pay.settleWebhook(sessionEvent('confirmed'), { grant: async () => true });
    expect(out).toMatchObject({ settled: false, granted: false });
    expect(out.reason).toContain('unknown payment');
  });
});

describe('the shared file stays copyable', () => {
  test('imports only node builtins', async () => {
    const src = await Bun.file(
      new URL('../packages/payments/src/index.js', import.meta.url),
    ).text();
    const imports = [...src.matchAll(/^import .* from '([^']+)';/gm)].map((m) => m[1]);
    for (const spec of imports) expect(spec.startsWith('node:')).toBe(true);
    expect(src).toContain('/api/checkout/sessions');
    expect(src).not.toContain('/api/payments/create');
  });
});
