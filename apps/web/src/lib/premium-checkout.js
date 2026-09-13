import { config } from '@nichedb/config';
import { sql } from '@nichedb/db';
import * as pay from '@nichedb/payments';
import { MEMBERSHIP_KIND } from '@nichedb/payments/membership';
import { priceFor } from '@nichedb/payments/referrals';
import { termById } from '@nichedb/premium';
import { Denied } from './service.js';

export const prices = () => ({
  dayCents: config.premium.dayCents,
  monthCents: config.premium.monthCents,
  yearCents: config.premium.yearCents,
});

/** Every Premium term buys the same account entitlements, including a single day. */
export async function startPremiumCheckout(
  user,
  wanted,
  { createCheckout = pay.createCheckout } = {},
) {
  if (!config.premium.enabled)
    throw new Denied('Payments are not configured on this deployment.', 400);
  const term = termById(wanted, prices());
  if (!term) throw new Denied('No such term.', 400);
  const price = await priceFor(sql, {
    userId: user.id,
    referredBy: user.referred_by,
    amountCents: term.cents,
  });
  return createCheckout({
    user,
    amountCents: price.amountCents,
    currency: config.premium.currency,
    description: `${config.siteName} Premium, ${term.days} days`,
    metadata: {
      kind: MEMBERSHIP_KIND,
      plan: 'premium',
      term_days: String(term.days),
      referral_code: price.code ?? '',
      list_price_cents: String(term.cents),
    },
    blockchain: config.payments.blockchain,
  });
}
