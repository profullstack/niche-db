import { config } from '@nichedb/config';
import { latestDump } from '@nichedb/core/data-dumps';
import * as pay from '@nichedb/payments';
import { MEMBERSHIP_KIND } from '@nichedb/payments/membership';
import { Denied } from './service.js';

/** Full-price Data access. Checkout is only offered once a downloadable snapshot exists. */
export async function startDataCheckout(
  user,
  {
    createCheckout = pay.createCheckout,
    latest = latestDump,
    storageReady = config.dataDumps.enabled,
  } = {},
) {
  if (!config.premium.enabled)
    throw new Denied('Payments are not configured on this deployment.', 400);
  if (!storageReady || !(await latest()))
    throw new Denied('The first hourly data dump is being prepared. Check back shortly.', 503);
  return createCheckout({
    user,
    amountCents: config.dataDumps.priceCents,
    currency: 'USD',
    description: `${config.siteName} Data: hourly data dumps, 30 days`,
    metadata: {
      kind: MEMBERSHIP_KIND,
      plan: 'data',
      term_days: '30',
      list_price_cents: String(config.dataDumps.priceCents),
    },
    blockchain: config.payments.blockchain,
  });
}
