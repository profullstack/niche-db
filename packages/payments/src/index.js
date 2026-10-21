import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * CoinPay: taking money, and turning exactly one settled payment into access.
 *
 * ---------------------------------------------------------------------------
 * THIS FILE IS SHARED VERBATIM BETWEEN BRANDS. Do not import a brand package.
 * ---------------------------------------------------------------------------
 *
 * Every other package here imports its own brand's db and config by name, which is
 * exactly what stops a file being copied between siblings: one source cannot name
 * two different scopes. So this one imports nothing but node:crypto and is handed
 * what it needs once, at boot, by whichever app is starting.
 *
 * That is the whole reason for `configurePayments`. It is not a testing seam or a
 * fashion -- it is what lets `cp packages/payments/src/index.js` be the entire port
 * between siblings, now and every time this changes again.
 *
 * The module is also deliberately narrow. It can start a checkout, verify a
 * webhook, and settle one. It knows nothing about what is being sold and nothing
 * about how much of it there is. Anything brand-specific arrives as a callback
 * from the caller, which is what keeps "what is for sale" out of a file that is
 * copied around.
 *
 * Version 2 (2026-10-21): a checkout is a CoinPay hosted checkout SESSION
 * (POST /api/checkout/sessions). The buyer picks any coin the business holds a
 * wallet for, or PayPal, on CoinPay's page; this file no longer picks a chain.
 * Every session carries who paid (customer_email, account_id) and for which site
 * (property), and CoinPay copies those onto every webhook.
 */

/* ------------------------------------------------------------------- wiring -- */

/** @type {{sql: Function, coinpay: object, siteUrl: string, property?: string} | null} */
let deps = null;

/**
 * Hand the module its brand's database handle and settings. Called once at boot.
 *
 * `coinpay` is passed as the OBJECT rather than as unpacked values, and that is
 * load-bearing: its api key, business id and webhook secret are getters that read
 * the environment on every access. Snapshotting them here would reintroduce the
 * bug their comment in config warns about, where the value depended on which
 * module imported config first and the signature tests became a coin flip decided
 * by the rest of the suite.
 *
 * `property` is the site hostname CoinPay files every payment under. Omitted, it is
 * `coinpay.property` when the config carries one, else the hostname of `siteUrl`.
 *
 * @param {{sql: Function, coinpay: object, siteUrl: string, property?: string}} injected
 */
export function configurePayments(injected) {
  deps = injected;
}

function need() {
  if (!deps) {
    // A clear sentence, because the alternative is `undefined is not a function`
    // three frames into a webhook at two in the morning.
    throw new Error('configurePayments() has not been called; wire it up at boot');
  }
  return deps;
}

/** Whether money can be taken at all. Every caller checks this before offering to. */
export function paymentsEnabled() {
  return Boolean(deps?.coinpay?.enabled);
}

/** The hostname CoinPay records this site's payments under. */
export function paymentProperty() {
  const { coinpay, siteUrl, property } = need();
  const explicit = String(property ?? coinpay?.property ?? '').trim();
  if (explicit) return hostOf(explicit);
  const host = hostOf(String(siteUrl ?? ''));
  if (!host)
    throw new Error('payments need a property: pass siteUrl or property to configurePayments');
  return host;
}

function hostOf(value) {
  const v = String(value).trim();
  if (!v) return '';
  try {
    return new URL(/^[a-z]+:\/\//i.test(v) ? v : `https://${v}`).hostname.toLowerCase();
  } catch {
    return v.toLowerCase();
  }
}

function baseUrlOf(coinpay) {
  return String(coinpay.baseUrl || 'https://coinpayportal.com')
    .replace(/\/+$/, '')
    .replace(/\/api$/, '');
}

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;

/** Same rule CoinPay applies, so a bad address fails here and not at CoinPay. */
export function isValidEmail(value) {
  return typeof value === 'string' && value.length <= 320 && EMAIL_RE.test(value.trim());
}

/**
 * Constant-time hex compare.
 *
 * Inlined rather than imported from the brand's auth package -- four lines is a
 * cheaper price than a scoped import in a file that has to be copyable.
 * Variable-time comparison of a signature is how a forgery gets found one byte at
 * a time.
 */
function safeEqualHex(a, b) {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/* ----------------------------------------------------------------- checkout -- */

/**
 * Open a hosted checkout session and write it down as pending.
 *
 * Nothing here knows what is being bought. `description` is what the buyer reads
 * on the checkout page and `metadata` is echoed back on the webhook -- and that
 * echo is the only thing linking money to a purchase, so a settled payment with
 * empty metadata cannot be attributed to anything and is unrecoverable without a
 * human.
 *
 * WHO PAID is required, not optional: CoinPay refuses a session without
 * `customer_email` and `account_id`. The email comes from `email` or the signed-in
 * `user.email`; the account is `accountId`, else `user.id`, else (a guest with no
 * account) the email itself.
 *
 * The pending row is inserted BEFORE the buyer leaves, under the SESSION id
 * (cs_...). A webhook can arrive before the redirect completes, and settling a
 * payment we have no record of would mean dropping money that genuinely arrived.
 * The webhook names both the underlying payment and the session, and settlement
 * matches either, so rows written by the old per-coin checkout still settle.
 *
 * `blockchain`, `paymentMethod` and `payTo` are no longer read: the buyer picks
 * the coin (or PayPal) on CoinPay's page, and the payee is always the business's
 * own wallet for that coin. Old callers that still pass them keep working.
 *
 * @param {object} args
 * @param {{id?: string|number, email?: string} | null} [args.user]
 * @param {string} [args.email]  buyer email; defaults to user.email
 * @param {string} [args.accountId]  defaults to user.id, then the email
 * @param {number} args.amountCents
 * @param {string} [args.currency]
 * @param {string} args.description  shown to the buyer on the checkout page
 * @param {Record<string,string>} [args.metadata]  echoed back on the webhook
 * @param {string} [args.successUrl]  may contain {CHECKOUT_SESSION_ID}
 * @param {string} [args.cancelUrl]
 * @param {number} [args.expiresInMinutes]  15-120, default 60
 * @returns {Promise<{checkoutUrl: string, paymentRef: string, sessionId: string}>}
 */
export async function createCheckout({
  user = null,
  email,
  accountId,
  amountCents,
  currency = 'USD',
  description,
  metadata = {},
  successUrl,
  cancelUrl,
  expiresInMinutes = 60,
}) {
  const { sql, coinpay } = need();
  if (!coinpay.enabled) throw new Error('CoinPay is not configured');
  if (!Number.isFinite(amountCents) || amountCents <= 0) throw new Error('bad amount');

  const buyerEmail = String(email ?? user?.email ?? '').trim();
  if (!isValidEmail(buyerEmail)) throw new Error("a checkout needs the buyer's email");
  const userId = user?.id ?? null;
  const account = String(accountId ?? userId ?? buyerEmail).trim();
  if (!account) throw new Error('a checkout needs a buyer account');

  const property = paymentProperty();
  const base = baseUrlOf(coinpay);

  // Strings only: metadata is echoed through JSON and compared as text.
  const meta = {};
  for (const [k, v] of Object.entries(metadata ?? {})) {
    if (v !== undefined && v !== null) meta[k] = String(v);
  }
  if (userId !== null) meta.user_id = String(userId);
  meta.email = buyerEmail;
  meta.property = property;

  const res = await fetch(`${base}/api/checkout/sessions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${coinpay.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      amount: amountCents / 100,
      currency,
      description,
      customer_email: buyerEmail,
      account_id: account,
      property,
      metadata: meta,
      success_url: successUrl,
      cancel_url: cancelUrl,
      expires_in_minutes: Math.min(120, Math.max(15, Math.round(expiresInMinutes))),
    }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) throw new Error(`coinpay ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  const sessionId = body?.id;
  if (!sessionId || !String(sessionId).startsWith('cs_')) {
    throw new Error('coinpay returned no checkout session');
  }

  await sql`
    insert into payments ${sql({
      user_id: userId,
      provider: 'coinpay',
      provider_ref: sessionId,
      amount_cents: amountCents,
      currency,
      status: 'pending',
      raw: body,
    })}
    on conflict (provider, provider_ref) do nothing
  `;

  /*
   * Only ever send a buyer to CoinPay's own origin. The URL comes from CoinPay,
   * but a redirect is the one thing here an attacker would want to steer, so it is
   * rebuilt from our own config when it points anywhere else.
   */
  let checkoutUrl = `${base}/checkout/${encodeURIComponent(sessionId)}`;
  try {
    const u = new URL(String(body.url), base);
    if (u.origin === new URL(base).origin) checkoutUrl = u.toString();
  } catch {
    // keep the one built from config
  }
  return { checkoutUrl, paymentRef: sessionId, sessionId };
}

/**
 * Read a checkout session back (status, and the payment ids once one exists).
 * Used by a return page that wants to say "paid" before the webhook lands; never
 * a substitute for the webhook, which is what grants.
 */
export async function getCheckoutSession(sessionId) {
  const { coinpay } = need();
  if (!/^cs_[A-Za-z0-9]+$/.test(String(sessionId ?? ''))) return null;
  const res = await fetch(`${baseUrlOf(coinpay)}/api/checkout/sessions/${sessionId}`, {
    headers: { authorization: `Bearer ${coinpay.apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  return body?.session ?? body;
}

/* ------------------------------------------------------------------ webhook -- */

/**
 * Verify a CoinPay webhook signature.
 *
 * Signed over the RAW request bytes. Re-serialising the parsed JSON changes key
 * order and whitespace and the signature stops matching -- which reads as a forged
 * request rather than the bug it is, so every caller must hand this the body it
 * received rather than one it rebuilt.
 *
 * The timestamp window is what stops a captured webhook being replayed later; the
 * signature alone proves origin, not freshness.
 */
export function verifyWebhook({ rawBody, signatureHeader, toleranceSeconds = 300 }) {
  const { coinpay } = need();
  if (!signatureHeader || !coinpay.webhookSecret) return false;

  const parts = Object.fromEntries(
    String(signatureHeader)
      .split(',')
      .map((kv) => kv.split('=').map((s) => s.trim())),
  );
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isFinite(t) || !v1) return false;
  if (Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;

  const expected = createHmac('sha256', coinpay.webhookSecret)
    .update(`${parts.t}.${rawBody}`)
    .digest('hex');

  try {
    return safeEqualHex(expected, v1);
  } catch {
    // A malformed v1 that is not valid hex throws in Buffer.from. That is a no.
    return false;
  }
}

/**
 * Statuses that mean money actually arrived.
 *
 * A webhook fires for failures and cancellations too, and granting on any VERIFIED
 * webhook is the mistake this set exists to prevent: the signature proves the
 * message is genuine, never that it says yes.
 *
 * `forwarded` is here because CoinPay sends TWO events for one payment --
 * payment.confirmed, then payment.forwarded once the funds have gone on to the
 * merchant wallet -- and forwarded is strictly later than confirmed, so it is paid
 * by definition. Leaving it out is not a harmless omission: CoinPay's durable
 * retry queue (webhook_deliveries, backing off for about a day) is where a failed
 * payment.forwarded waits, while a failed payment.confirmed is only re-sent while
 * the monitor still sees the payment as unsettled (about twelve minutes). A
 * receiver that settles on confirmed alone loses a real payment for good once
 * confirmed has failed. Both count; every grant is idempotent per payment, so
 * receiving both grants once.
 *
 * The SQL below repeats this list as a literal on purpose: binding a JS array is
 * not portable across the Postgres clients these brands run on.
 */
const SETTLED = new Set(['paid', 'completed', 'confirmed', 'forwarded', 'succeeded', 'settled']);

export function isSettledStatus(status) {
  return SETTLED.has(String(status ?? '').toLowerCase());
}

/**
 * Pull the payment out of a webhook body, whichever envelope it arrived in.
 *
 * THE LIVE SHAPE IS NESTED. CoinPay sends:
 *
 *   { id: "evt_<paymentId>_<unixTs>",
 *     type: "payment.confirmed",
 *     data: { payment_id, status, amount, amount_usd, metadata,
 *             checkout_session_id, customer_email, account_id, property, ... },
 *     created_at, business_id }
 *
 * The top-level `id` is the EVENT, not the payment. Reading the flat fields FIRST
 * would match the event id and settle against a reference that belongs to
 * nothing, so `data` wins wherever it exists; the flat shape stays supported
 * because the older test-webhook sender still uses it.
 *
 * A session payment's metadata is ours plus CoinPay's checkout_session_id,
 * customer_email, account_id and property; they are also copied to the top of
 * `data`, and either place is read.
 *
 * @param {object} payload the parsed webhook body
 */
export function readWebhook(payload) {
  const data = payload?.data ?? payload;
  const ref = data?.payment_id ?? (payload?.data ? data?.id : payload?.id) ?? null;
  const status = String(data?.status ?? '').toLowerCase();
  const meta = { ...(data?.metadata ?? payload?.metadata ?? {}) };
  for (const k of ['checkout_session_id', 'customer_email', 'account_id', 'property']) {
    if (meta[k] == null && data?.[k] != null) meta[k] = data[k];
  }
  const sessionId = meta.checkout_session_id ?? null;
  const event = String(payload?.type ?? payload?.event ?? '');
  return {
    ref: ref ? String(ref) : null,
    sessionId: sessionId ? String(sessionId) : null,
    status,
    meta,
    event,
    email: meta.customer_email ?? meta.email ?? null,
    accountId: meta.account_id ?? null,
    property: meta.property ?? null,
  };
}

/**
 * Record what a webhook says and, if money arrived, grant access -- atomically.
 *
 * The grant is a callback because what is being sold differs per brand and this
 * file does not get to know. It runs inside the SAME transaction as the payment
 * update, which is what makes the whole thing one decision: a caller that checks
 * what is left first and writes afterwards has the classic oversell, where two
 * buyers pass the check together and both are sold the last one.
 *
 * `grant` receives the transaction, so any conditional UPDATE it needs is
 * serialised with everything else here. It also receives the payment row as WE
 * recorded it at checkout -- amount included -- rather than as the payload claims
 * it: anything calculated from the money (a commission, a tier) must be a
 * percentage of what we charged, not of a number that arrived over the wire.
 * Returning a falsy value aborts the grant without failing the webhook: the money
 * is recorded, the access is not given, and the caller decides what to say.
 *
 * The row is found by the session id (checkouts opened by this version) or by the
 * payment id (payments opened by the old per-coin checkout and still in flight).
 * A settled row never goes back to unsettled: one session can carry several
 * attempts (the buyer tries BTC, gives up, pays by PayPal), and the abandoned
 * attempt expiring later must not un-pay the one that paid.
 *
 * Idempotent by construction. `payments` is unique on (provider, provider_ref), so
 * a replayed webhook updates the same row, and any sane grant is an upsert.
 *
 * @param {object} payload the parsed webhook body
 * @param {{grant?: (tx: Function, ctx: object) => Promise<any>}} [handlers]
 */
export async function settleWebhook(payload, { grant } = {}) {
  const { sql } = need();

  const { meta, ref, sessionId, status } = readWebhook(payload);

  if (!ref && !sessionId) throw new Error('webhook missing payment reference');
  if (!meta.user_id && !meta.account_id) throw new Error('webhook missing metadata');

  const byPayment = ref ?? sessionId;
  const bySession = sessionId ?? ref;

  return sql.begin(async (tx) => {
    const [payment] = await tx`
      update payments set
        status = case
          when status in ('paid', 'completed', 'confirmed', 'forwarded', 'succeeded', 'settled')
            then status
          else ${status || 'unknown'}
        end,
        raw = ${payload},
        updated_at = now()
      where provider = 'coinpay' and (provider_ref = ${bySession} or provider_ref = ${byPayment})
      returning id, user_id, status, amount_cents, currency
    `;

    if (!SETTLED.has(status)) return { settled: false, granted: false, reason: `status ${status}` };
    // No row means no checkout of ours: nothing recorded what was charged, so there
    // is nothing safe to grant against. Said plainly rather than handing `grant` an
    // undefined payment -- which either threw (a 500, retried for a day) or, worse,
    // granted with a null payment id that no unique index can dedupe on.
    if (!payment) return { settled: false, granted: false, reason: `unknown payment ${bySession}` };
    if (!grant) return { settled: true, granted: false, reason: 'nothing to grant' };

    const result = await grant(tx, { meta, payment, payload });
    return result
      ? { settled: true, granted: true, result }
      : { settled: true, granted: false, reason: 'grant declined' };
  });
}

/* ------------------------------------------------------------- entitlements -- */

/**
 * Grant one person access to one event, inside a caller's transaction.
 *
 * Offered as a helper rather than done automatically, because a brand may be
 * selling something that is not an event at all.
 *
 * `on conflict do nothing`: re-buying is a no-op rather than a second charge or a
 * second row, and a replayed webhook cannot extend anybody's access.
 */
export async function grantEventEntitlement(
  tx,
  { userId, eventId, offerId = null, paymentId = null, expiresAt },
) {
  if (!userId || !Number.isFinite(Number(eventId))) throw new Error('bad entitlement');
  if (!(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime())) {
    // An open-ended grant to a stream is the thing that turns a small sale into
    // redistribution, so there is no default here and no way to omit it.
    throw new Error('an entitlement needs an expiry');
  }

  await tx`
    insert into entitlements ${tx({
      user_id: userId,
      event_id: Number(eventId),
      offer_id: offerId,
      payment_id: paymentId,
      status: 'active',
      expires_at: expiresAt,
    })}
    on conflict (user_id, event_id) do nothing
  `;
  return { eventId: Number(eventId), expiresAt };
}

/** What this person currently holds for this event, if anything. */
export async function activeEntitlement({ userId, eventId }) {
  const { sql } = need();
  if (!userId || !eventId) return null;
  const [row] = await sql`
    select * from entitlements
    where user_id = ${userId} and event_id = ${eventId}
      and status = 'active' and expires_at > now()
  `;
  return row ?? null;
}

/** Everything this person currently holds. For an account page. */
export async function activeEntitlements(userId) {
  const { sql } = need();
  if (!userId) return [];
  return sql`
    select * from entitlements
    where user_id = ${userId} and status = 'active' and expires_at > now()
    order by expires_at
  `;
}
