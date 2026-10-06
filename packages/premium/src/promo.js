/**
 * Promo codes: a percentage off a Premium term, named by a code anyone may type.
 *
 * Pure, like the rest of this package. The codes arrive as the deployment's
 * `PREMIUM_PROMO_CODES` string, `CODE:percent[:YYYY-MM-DD]` separated by commas,
 * so running or ending a sale is a configuration change and never a migration.
 * The date is the last day the code works, inclusive, in UTC.
 */

export function parsePromoCodes(raw = '') {
  const codes = new Map();
  for (const entry of String(raw).split(',')) {
    const [name, pct, until] = entry.trim().split(':');
    const code = normalizeCode(name);
    const percent = Number(pct);
    if (!code || !Number.isInteger(percent) || percent <= 0 || percent >= 100) continue;
    const ends = /^\d{4}-\d{2}-\d{2}$/.test(until ?? '')
      ? new Date(`${until}T23:59:59.999Z`)
      : null;
    codes.set(code, { code, percent, ends });
  }
  return codes;
}

export const normalizeCode = (code) =>
  String(code ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '');

/** The promo a typed code names, or null when it is unknown or over. */
export function findPromo(codes, typed, now = new Date()) {
  const promo = codes.get(normalizeCode(typed));
  if (!promo) return null;
  if (promo.ends && promo.ends < now) return null;
  return promo;
}

/** What a promo takes off a price, in whole cents, rounded in the buyer's favour. */
export const promoDiscountCents = (amountCents, promo) =>
  promo ? Math.ceil((amountCents * promo.percent) / 100) : 0;
