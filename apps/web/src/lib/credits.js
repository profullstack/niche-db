/**
 * Credit codes and invites: @profullstack/redeem-credits and
 * @profullstack/affiliates over nichedb's own Postgres.
 *
 * Neither package keeps a second entitlement. A redeemed code and an accepted
 * invite both end in `grantMembership`, the same memberships row a paid
 * Premium term writes, with a `grant_ref` that makes the grant idempotent. So
 * "is this person Premium" has one answer, wherever the days came from.
 *
 * - A code grants `premium_days` (minted by an admin: /admin/credits, the API
 *   or `nichedb credits mint`). One-off only: a monthly grant would need a
 *   monthly top-up job, and Premium is sold in days anyway.
 * - An invite is scarce (config.invites.quota per account, single use). When
 *   the invited person's account is created by spending the emailed link
 *   (which proves the mailbox), both of them get config.invites.bonusDays.
 * - Affiliate links stay what they were: the @profullstack/referrals code at
 *   /r/<code> that pays commission. Its codes are "external" to affiliates, so
 *   a sign-up is attributed once, by the system that already pays for it.
 */
import { config } from '@nichedb/config';
import { sql } from '@nichedb/db';
import { grantMembership } from '@nichedb/payments/membership';
import {
  Affiliates,
  postgresStore as affiliatesStore,
  hashCode as inviteHash,
  normalizeCode as normalizeInvite,
} from '@profullstack/affiliates';
import { Credits, postgresStore as creditsStore } from '@profullstack/redeem-credits';

export { affiliatesStore, creditsStore };

export const UNIT = 'premium_days';
const DAY_MS = 86_400_000;

/** Bun's SQL client in the `query(text, params) -> { rows }` shape both stores take. */
export const pgPool = (db = sql) => ({
  query: async (text, params = []) => ({ rows: await db.unsafe(text, params) }),
});

/** A free Premium term, through the same insert a paid one takes. */
export async function grantPremiumDays({ userId, days, ref, db = sql }) {
  return grantMembership(db, {
    userId,
    paymentId: null,
    priceCents: 0,
    currency: config.premium.currency,
    termDays: Math.trunc(days),
    plan: 'premium',
    grantRef: ref,
  });
}

/** Is this an @profullstack/referrals code (the existing affiliate programme)? */
async function isReferralCode(code) {
  const [row] = await sql`
    select 1 as ok from referral_codes where code = ${String(code).trim().toUpperCase()}
  `;
  return Boolean(row);
}

/**
 * The two services, built once per process and lazily (nothing touches the
 * database at import time). Tests pass their own through `makeCredits`.
 */
export function makeCredits({
  creditStore,
  affiliateStore,
  grant = grantPremiumDays,
  externalCodes = isReferralCode,
  now,
  quota = config.invites.quota,
  bonusDays = config.invites.bonusDays,
  ttlDays = config.invites.ttlDays,
} = {}) {
  const credits = new Credits(creditStore, {
    ...(now ? { now } : {}),
    onGrant: async (userId, g, source) => {
      if (g.unit !== UNIT) throw new Error(`nichedb grants ${UNIT}, not ${g.unit}`);
      await grant({ userId, days: g.amount, ref: source });
    },
  });
  const aff = new Affiliates(affiliateStore, {
    ...(now ? { now } : {}),
    defaultQuota: quota,
    inviteTtlMs: ttlDays > 0 ? ttlDays * DAY_MS : null,
    externalCodes,
  });
  return { credits, aff, grant, bonusDays };
}

let shared = null;
export function services() {
  shared ??= makeCredits({
    creditStore: creditsStore(pgPool()),
    affiliateStore: affiliatesStore(pgPool()),
  });
  return shared;
}

/* ------------------------------------------------------------- credit codes -- */

export const REDEEM_ERRORS = {
  invalid: 'That code is not one we issued. Check it and try again.',
  expired: 'That code has expired.',
  used_up: 'That code has already been used.',
  already_redeemed: 'You have already redeemed that code.',
  revoked: 'That code was withdrawn.',
};

const intIn = (v, lo, hi) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
};

/** Admin: make a code worth `days` of Premium. The plaintext is returned once. */
export async function mintPremiumCode(
  { days, label = '', maxRedemptions = 1, expiresInDays = null, createdBy = null },
  svc = services(),
) {
  const d = intIn(days, 1, 3650);
  if (!d)
    throw Object.assign(new Error('days must be a whole number from 1 to 3650'), { status: 400 });
  const max = intIn(maxRedemptions ?? 1, 1, 100_000);
  if (!max) throw Object.assign(new Error('max must be from 1 to 100000'), { status: 400 });
  let expiresAt = null;
  if (expiresInDays !== null && expiresInDays !== undefined && expiresInDays !== '') {
    const e = intIn(expiresInDays, 1, 3650);
    if (!e) throw Object.assign(new Error('expires must be 1 to 3650 days'), { status: 400 });
    expiresAt = Date.now() + e * DAY_MS;
  }
  const minted = await svc.credits.mint({
    grant: { unit: UNIT, amount: d },
    label: String(label ?? '').slice(0, 120),
    maxRedemptions: max,
    expiresAt,
    createdBy: createdBy ?? undefined,
  });
  return codeOut(minted, minted.code);
}

export function codeOut(c, plaintext = undefined) {
  return {
    ...(plaintext ? { code: plaintext } : {}),
    id: c.id,
    label: c.label,
    days: c.grant.amount,
    unit: c.grant.unit,
    max_redemptions: c.maxRedemptions,
    redemptions: c.redemptions ?? 0,
    expires_at: c.expiresAt ? new Date(c.expiresAt).toISOString() : null,
    created_at: new Date(c.createdAt).toISOString(),
    revoked_at: c.revokedAt ? new Date(c.revokedAt).toISOString() : null,
  };
}

/**
 * Redeem a code for the signed-in person. `{ ok, days }` or `{ ok: false,
 * reason, error }` with words a person can act on.
 */
export async function redeemCode(userId, input, svc = services()) {
  const code = String(input ?? '').trim();
  if (!code) return { ok: false, reason: 'invalid', error: 'Type the code first.' };
  if (code.length > 64) return { ok: false, reason: 'invalid', error: REDEEM_ERRORS.invalid };
  let r;
  try {
    r = await svc.credits.redeem(code, String(userId));
  } catch (err) {
    // The code is spent but the term did not save (the redemption stands, per
    // redeem-credits). An admin adds the days by hand; grant_ref 'code:<id>'
    // means doing so twice still adds one term.
    console.error('[credits] grant after redeem failed:', err.message);
    return {
      ok: false,
      reason: 'grant_failed',
      error:
        'The code was accepted but the Premium days did not save. Write to us and we will add them.',
    };
  }
  if (!r.ok) return { ok: false, reason: r.reason, error: REDEEM_ERRORS[r.reason] ?? 'No.' };
  return { ok: true, days: r.grant.amount, code_id: r.codeId };
}

/* ------------------------------------------------------------------ invites -- */

export const INVITE_ERRORS = {
  invalid: 'That invite is not one we issued.',
  expired: 'That invite has expired.',
  used: 'That invite has already been used.',
  self: 'You cannot accept your own invite.',
  revoked: 'That invite was withdrawn.',
};

export const looksLikeInvite = (s) => /^[A-Za-z0-9 -]{12,24}$/.test(String(s ?? ''));
export const canonicalInvite = (s) => normalizeInvite(String(s ?? ''));

/** What an invite link is, without spending it: for the /i/<code> page. */
export async function inviteStatus(code, svc = services()) {
  if (!looksLikeInvite(code)) return 'invalid';
  const row = await svc.aff.store.getInviteByHash(inviteHash(code));
  if (!row) return 'invalid';
  if (row.revokedAt !== null) return 'revoked';
  if (row.usedBy !== null) return 'used';
  if (row.expiresAt !== null && Date.now() >= row.expiresAt) return 'expired';
  return 'ok';
}

export function inviteOut(i, plaintext = undefined) {
  const status =
    i.usedBy !== null
      ? 'used'
      : i.revokedAt
        ? 'revoked'
        : i.expiresAt !== null && Date.now() >= i.expiresAt
          ? 'expired'
          : 'open';
  return {
    ...(plaintext ? { code: plaintext, url: `${config.siteUrl}/i/${plaintext}` } : {}),
    id: i.id,
    note: i.note ?? '',
    status,
    created_at: new Date(i.createdAt).toISOString(),
    expires_at: i.expiresAt ? new Date(i.expiresAt).toISOString() : null,
    used_at: i.usedAt ? new Date(i.usedAt).toISOString() : null,
  };
}

export async function myInvites(userId, svc = services()) {
  const [quota, invites] = await Promise.all([
    svc.aff.quota(String(userId)),
    svc.aff.invites(String(userId)),
  ]);
  return { quota, invites: invites.map((i) => inviteOut(i)), bonus_days: svc.bonusDays };
}

export async function createInvite(userId, note = '', svc = services()) {
  try {
    const made = await svc.aff.createInvite(String(userId), String(note ?? '').slice(0, 80));
    return { ok: true, invite: inviteOut(made, made.code) };
  } catch (err) {
    if (/no invites left/.test(err.message))
      return {
        ok: false,
        error: 'No invites left. Each account gets a few; they are meant to be scarce.',
      };
    throw err;
  }
}

/** Withdraw one of MY unused invites. Someone else's id answers like an unknown one. */
export async function revokeInvite(userId, inviteId, svc = services()) {
  const mine = await svc.aff.invites(String(userId));
  const invite = mine.find((i) => i.id === String(inviteId));
  if (!invite) return { ok: false, error: 'No such invite.' };
  if (invite.usedBy !== null) return { ok: false, error: 'That invite was already used.' };
  await svc.aff.revokeInvite(invite.id);
  return { ok: true };
}

/**
 * A NEW account has just been created by spending its emailed link: accept the
 * invite it came with and give both people their days. Called only for a
 * created account, never on an ordinary sign-in, so an existing member cannot
 * collect bonuses by redeeming invites.
 */
export async function acceptInvite({ userId, code }, svc = services()) {
  if (!code || !looksLikeInvite(code)) return { ok: false, reason: 'invalid' };
  const r = await svc.aff.redeemInvite(code, String(userId));
  if (!r.ok) return r;
  const days = svc.bonusDays;
  if (days > 0) {
    await svc.grant({ userId: String(userId), days, ref: `invite:${r.inviteId}:invitee` });
    await svc.grant({ userId: r.inviterId, days, ref: `invite:${r.inviteId}:inviter` });
  }
  return { ...r, days };
}

/**
 * First-touch attribution for a new account from the ?ref= / referral cookie.
 * nichedb's affiliate codes are @profullstack/referrals codes, which affiliates
 * reports as external; those go to the existing `onExternal` (users.referred_by,
 * which prices the first purchase and pays the commission). Never both.
 */
export async function attributeReferral({ userId, code, onExternal }, svc = services()) {
  if (!code) return { ok: false };
  const r = await svc.aff.attribute(String(code), String(userId));
  if (r.external && onExternal) await onExternal({ userId, code });
  return r;
}
