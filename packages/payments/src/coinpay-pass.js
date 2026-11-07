/**
 * Profullstack Pass: a CoinPay user who deposited $99 into their own CoinPay
 * wallet gets a free month on every Profullstack property
 * (https://coinpayportal.com/pass).
 *
 * CoinPay reports the pass as a userinfo claim, which this site only sees at
 * sign-in. The sign-in callback turns an active pass into a free Pro term from
 * now until the pass expires: one `memberships` row, plan 'pro', price 0, keyed
 * on grant_ref `coinpay-pass:<coinpay sub>:<expires_at>`. That row IS the
 * persisted pass: isProUser / activeMembership already read the furthest-out
 * Pro term, and a paid Pro term bought during the pass stacks after it.
 *
 * Idempotent on the (user_id, grant_ref) partial unique index: signing in ten
 * times during one pass inserts one row. Never stacks on a Pro term the member
 * already holds: the pass is "Pro until it expires". Data dumps are not part
 * of it.
 */

export const PASS_URL = 'https://coinpayportal.com/pass';
export const PASS_GRANT_PREFIX = 'coinpay-pass';
export const PASS_PLAN = 'pro';

/**
 * Active only when `active === true` AND the expiry parses to a future date.
 * Accepts the raw claim (`{ active, expires_at }`) or the parsed one
 * coinpay-onboard finishSignIn returns (`{ active, expiresAt: Date }`).
 */
export function normalizePass(pass, now = new Date()) {
  if (!pass || typeof pass !== 'object') return { active: false, expiresAt: null };
  const raw = pass.expiresAt ?? pass.expires_at ?? null;
  const parsed =
    raw instanceof Date ? raw : typeof raw === 'string' && raw.trim() ? new Date(raw) : null;
  const expiresAt = parsed && Number.isFinite(parsed.getTime()) ? parsed : null;
  const active = pass.active === true && expiresAt !== null && expiresAt.getTime() > now.getTime();
  return { active, expiresAt };
}

export function passGrantRef(sub, expiresAt) {
  return `${PASS_GRANT_PREFIX}:${sub}:${expiresAt.toISOString()}`;
}

/**
 * Grant Pro until the pass expires, once per pass.
 *
 * @param {(text: string, params: unknown[]) => Promise<object[]>} run
 * @returns {Promise<null | { expires_at: unknown, replayed: boolean }>}
 */
export async function grantCoinpayPass(
  run,
  { userId, sub, pass, now = new Date(), currency = 'USD' },
) {
  if (!userId || !sub) return null;
  const p = normalizePass(pass, now);
  if (!p.active) return null;
  const ref = passGrantRef(sub, p.expiresAt);
  const exp = p.expiresAt.toISOString();
  const [row] = await run(
    `insert into memberships (user_id, payment_id, started_at, expires_at, price_cents, currency, plan, grant_ref)
     select $1::uuid, null, now(), $2::timestamptz, 0, $3, $4, $5
     where $2::timestamptz > now()
     on conflict do nothing
     returning expires_at`,
    [userId, exp, currency, PASS_PLAN, ref],
  );
  if (row) return { ...row, replayed: false };
  const [existing] = await run(
    'select expires_at from memberships where user_id = $1::uuid and grant_ref = $2',
    [userId, ref],
  );
  return existing ? { ...existing, replayed: true } : null;
}
