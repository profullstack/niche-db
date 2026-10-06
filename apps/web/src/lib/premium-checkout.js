import { config } from '@nichedb/config';
import { sql } from '@nichedb/db';
import * as pay from '@nichedb/payments';
import { MEMBERSHIP_KIND } from '@nichedb/payments/membership';
import { priceFor } from '@nichedb/payments/referrals';
import { termById } from '@nichedb/premium';
import { findPromo, parsePromoCodes, promoDiscountCents } from '@nichedb/premium/promo';
import { Denied } from './service.js';

export const prices = () => ({
  dayCents: config.premium.dayCents,
  monthCents: config.premium.monthCents,
  yearCents: config.premium.yearCents,
});

/** The promo a typed code names on this deployment right now, or null. */
export const promoFor = (typed) =>
  typed ? findPromo(parsePromoCodes(config.premium.promoCodes), typed) : null;

/**
 * What one term costs this buyer: the better of their referral and the promo,
 * never both. A referral pays its affiliate out of the price, so stacking the
 * two would sell below what the commission is worth. When the promo wins, no
 * referral is attached and no commission is owed.
 */
export async function quotePremium(user, term, promo, { referralPrice = priceFor } = {}) {
  const referral = user
    ? await referralPrice(sql, {
        userId: user.id,
        referredBy: user.referred_by,
        amountCents: term.cents,
      }).catch(() => null)
    : null;
  const referralOff = referral?.discountCents ?? 0;
  const promoOff = promoDiscountCents(term.cents, promo);
  if (promo && promoOff >= referralOff)
    return {
      amountCents: term.cents - promoOff,
      discountCents: promoOff,
      referralCode: null,
      promoCode: promo.code,
      promoPercent: promo.percent,
    };
  return {
    amountCents: referral?.amountCents ?? term.cents,
    discountCents: referralOff,
    referralCode: referral?.code ?? null,
    promoCode: null,
    promoPercent: 0,
  };
}

/** Every Premium term buys the same account entitlements, including a single day. */
export async function startPremiumCheckout(
  user,
  wanted,
  { createCheckout = pay.createCheckout, promoCode = '', referralPrice } = {},
) {
  if (!config.premium.enabled)
    throw new Denied('Payments are not configured on this deployment.', 400);
  const term = termById(wanted, prices());
  if (!term) throw new Denied('No such term.', 400);
  const promo = promoFor(promoCode);
  if (promoCode && !promo) throw new Denied('That promo code is not valid.', 400);
  const price = await quotePremium(user, term, promo, { referralPrice });
  return createCheckout({
    user,
    amountCents: price.amountCents,
    currency: config.premium.currency,
    description: `${config.siteName} Premium, ${term.days} days${
      price.promoCode ? ` (${price.promoCode}, ${price.promoPercent}% off)` : ''
    }`,
    metadata: {
      kind: MEMBERSHIP_KIND,
      plan: 'premium',
      term_days: String(term.days),
      referral_code: price.referralCode ?? '',
      promo_code: price.promoCode ?? '',
      list_price_cents: String(term.cents),
    },
    blockchain: config.payments.blockchain,
  });
}
