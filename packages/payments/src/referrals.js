import {
  applyReferral,
  buildReferralUrl,
  calculateReferral,
  createCode,
  extractCode,
  validateCode,
} from '@profullstack/referrals';

/**
 * Referrals through @profullstack/referrals: 60% of a referred purchase to the
 * affiliate, 20% off for the new customer. This file is the ReferralStore the
 * SDK asks for, over the referral_codes / referral_usages tables, plus the two
 * moments the site touches it: pricing a checkout, and recording a settle.
 *
 * Takes `sql` (or a transaction) as an argument everywhere, like the payments
 * module beside it, so it imports no brand package.
 */

export function store(sql) {
  return {
    async saveCode(c) {
      await sql`
        insert into referral_codes (code, owner_id, created_at, expires_at, split)
        values (${c.code}, ${c.ownerId}::uuid, ${c.createdAt ?? new Date()}, ${c.expiresAt ?? null},
                ${c.split ? JSON.stringify(c.split) : null}::jsonb)
        on conflict (code) do nothing
      `;
    },
    async getCode(code) {
      const [row] =
        await sql`select * from referral_codes where code = ${String(code).toUpperCase()}`;
      if (!row) return null;
      return {
        code: row.code,
        ownerId: row.owner_id,
        createdAt: new Date(row.created_at),
        expiresAt: row.expires_at ? new Date(row.expires_at) : null,
        split: row.split ?? undefined,
      };
    },
    async saveUsage(u) {
      await sql`
        insert into referral_usages (code, affiliate_id, new_user_id, amount_cents,
                                     commission_cents, discount_cents, applied_at)
        values (${u.code}, ${u.affiliateId}::uuid, ${u.newUserId}::uuid, ${u.amountCents},
                ${u.commissionCents}, ${u.discountCents}, ${u.appliedAt ?? new Date()})
        on conflict (new_user_id) do nothing
      `;
    },
    async getUsagesByAffiliate(affiliateId) {
      const rows =
        await sql`select * from referral_usages where affiliate_id = ${affiliateId}::uuid`;
      return rows.map(usageOut);
    },
    async getUsagesByCode(code) {
      const rows = await sql`select * from referral_usages where code = ${code}`;
      return rows.map(usageOut);
    },
  };
}

const usageOut = (r) => ({
  code: r.code,
  affiliateId: r.affiliate_id,
  newUserId: r.new_user_id,
  amountCents: r.amount_cents,
  commissionCents: r.commission_cents,
  discountCents: r.discount_cents,
  appliedAt: new Date(r.applied_at),
});

/** The code somebody shares. Made on first ask, stable after. */
export async function codeFor(sql, userId) {
  const [existing] = await sql`
    select code from referral_codes where owner_id = ${userId}::uuid order by created_at limit 1
  `;
  if (existing) return existing.code;
  const made = await createCode(userId, store(sql));
  return made.code;
}

/**
 * What a buyer should be charged, given the code that brought them here.
 *
 * A code counts once per new customer, never for its own owner, and only while
 * it is valid. Anything else is full price with no referral attached.
 */
export async function priceFor(sql, { userId, referredBy, amountCents }) {
  const full = { amountCents, discountCents: 0, commissionCents: 0, code: null };
  if (!referredBy) return full;
  const s = store(sql);
  const code = await validateCode(referredBy, s);
  if (!code || code.ownerId === userId) return full;
  const [used] = await sql`select 1 from referral_usages where new_user_id = ${userId}::uuid`;
  if (used) return full;
  const calc = calculateReferral(amountCents, code.split);
  return {
    amountCents: calc.finalAmountCents,
    discountCents: calc.discountCents,
    commissionCents: calc.commissionCents,
    code: code.code,
  };
}

/** Record the referral once the money is in, inside the caller's transaction. */
export async function recordReferral(tx, { code, newUserId, amountCents }) {
  if (!code) return null;
  try {
    return await applyReferral({ code, newUserId, amountCents, store: store(tx) });
  } catch {
    // An invalid or expired code at settle time is not a reason to fail the
    // payment: the buyer paid what they were quoted.
    return null;
  }
}

export async function statsFor(sql, userId) {
  const code = await codeFor(sql, userId);
  const usages = await store(sql).getUsagesByCode(code);
  return {
    code,
    totalUsages: usages.length,
    totalRevenueCents: usages.reduce((n, u) => n + u.amountCents, 0),
    totalCommissionCents: usages.reduce((n, u) => n + u.commissionCents, 0),
    totalDiscountCents: usages.reduce((n, u) => n + u.discountCents, 0),
  };
}

export { buildReferralUrl, extractCode };
