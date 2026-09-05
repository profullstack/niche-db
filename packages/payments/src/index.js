import { CoinPayClient } from '@profullstack/coinpay';
import { verifyWebhookSignature } from '@profullstack/coinpay/webhooks';

/**
 * CoinPay: taking money, and turning exactly one settled payment into access.
 *
 * The HTTP half is @profullstack/coinpay (the SDK: checkout creation and
 * webhook signature verification). This file owns the bookkeeping: a pending
 * row before the buyer leaves, an idempotent settle, and a grant callback that
 * runs inside the same transaction so two webhooks cannot both give.
 *
 * It imports no brand package and is handed `sql` and the CoinPay settings
 * once at boot, which is what lets it be copied between sites verbatim.
 */

let deps = null;

/** @param {{sql: Function, coinpay: object, siteUrl: string}} injected */
export function configurePayments(injected) {
  deps = injected;
}

function need() {
  if (!deps) throw new Error('configurePayments() has not been called; wire it up at boot');
  return deps;
}

export function paymentsEnabled() {
  return Boolean(deps?.coinpay?.enabled);
}

let client = null;
function sdk() {
  const { coinpay } = need();
  if (!coinpay.enabled) throw new Error('CoinPay is not configured');
  if (!client)
    client = new CoinPayClient({ apiKey: coinpay.apiKey, baseUrl: `${coinpay.baseUrl}/api` });
  return client;
}

/* ----------------------------------------------------------------- checkout -- */

/**
 * Start a payment and write it down as pending.
 *
 * `metadata` is echoed back on the webhook and is the only thing linking money
 * to a purchase. The pending row is inserted BEFORE the buyer leaves: a webhook
 * can arrive before the redirect completes.
 */
export async function createCheckout({
  user,
  amountCents,
  currency = 'USD',
  description,
  metadata = {},
  blockchain,
}) {
  const { sql, coinpay } = need();
  if (!user?.id) throw new Error('a checkout needs a buyer');
  if (!Number.isFinite(amountCents) || amountCents < 0) throw new Error('bad amount');
  if (!blockchain) throw new Error('a crypto checkout needs a blockchain');

  const body = await sdk().createPayment({
    businessId: coinpay.businessId,
    amount: amountCents / 100,
    currency,
    blockchain,
    description,
    metadata: { ...metadata, user_id: user.id },
  });

  // The response is { success, payment: {...} }; the id is what the webhook echoes.
  const payment = body?.payment ?? body;
  const ref = payment?.id ?? payment?.payment_id;
  if (!ref) throw new Error('coinpay returned no payment reference');

  await sql`
    insert into payments ${sql({
      user_id: user.id,
      provider: 'coinpay',
      provider_ref: ref,
      amount_cents: amountCents,
      currency,
      status: 'pending',
      raw: body,
    })}
    on conflict (provider, provider_ref) do nothing
  `;

  const checkoutUrl = payment?.stripe_checkout_url ?? `${coinpay.baseUrl}/pay/${ref}`;
  return { checkoutUrl, paymentRef: ref };
}

/* ------------------------------------------------------------------ webhook -- */

/** Signed over the RAW request bytes; hand this the body as received. */
export function verifyWebhook({ rawBody, signatureHeader, toleranceSeconds = 300 }) {
  const { coinpay } = need();
  if (!signatureHeader || !coinpay.webhookSecret) return false;
  try {
    return verifyWebhookSignature({
      payload: rawBody,
      signature: String(signatureHeader),
      secret: coinpay.webhookSecret,
      tolerance: toleranceSeconds,
    });
  } catch {
    return false;
  }
}

/** Statuses that mean money actually arrived. A verified webhook is not a yes. */
const SETTLED = new Set(['paid', 'completed', 'confirmed', 'succeeded', 'settled']);

/**
 * Record what a webhook says and, if money arrived, grant -- atomically.
 * `grant(tx, { meta, payment, payload })` runs inside the same transaction as
 * the payment update. Idempotent: payments is unique on (provider, provider_ref).
 */
export async function settleWebhook(payload, { grant } = {}) {
  const { sql } = need();
  const data = payload?.data ?? payload;
  const meta = data?.metadata ?? payload?.metadata ?? {};
  const ref = data?.id ?? data?.payment_id ?? payload?.id;
  const status = String(data?.status ?? payload?.status ?? '').toLowerCase();

  if (!ref) throw new Error('webhook missing payment reference');
  if (!meta.user_id) throw new Error('webhook missing metadata');

  return sql.begin(async (tx) => {
    const [payment] = await tx`
      update payments set status = ${status || 'unknown'}, raw = ${payload}, updated_at = now()
      where provider = 'coinpay' and provider_ref = ${ref}
      returning id, user_id, status, amount_cents, currency
    `;
    if (!SETTLED.has(status)) return { settled: false, granted: false, reason: `status ${status}` };
    if (!grant) return { settled: true, granted: false, reason: 'nothing to grant' };
    const result = await grant(tx, { meta, payment, payload });
    return result
      ? { settled: true, granted: true, result }
      : { settled: true, granted: false, reason: 'grant declined' };
  });
}
