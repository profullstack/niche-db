import { sql } from '@nichedb/db';
import * as r from '@nichedb/db/revenue';
import { splitSaleAcrossNiches } from '@nichedb/knowledge';

/**
 * Turning one crawl sale into revenue somebody is owed.
 *
 * A pass buys the whole index for a day, not one niche, so there is no single
 * niche to hand it to. The only measurable answer to "whose data did it pay
 * for" is how much of the index each niche holds, which is the same rule the
 * partner programme splits on.
 *
 * So a sale is divided pro-rata by items across the WHOLE index, and only the
 * niches somebody actually operates get an attributed event. The rest stays
 * platform revenue. A niche with one percent of the rows does not collect the
 * whole dollar because it happens to be the only one with an operator.
 */

/** Every niche with an active operator, and how many rows its collection holds. */
async function operatedNiches() {
  return sql`
    select n.id, n.slug, count(i.id)::int as items
    from niches n
    join niche_members m on m.niche_id = n.id and m.status = 'active'
      and m.role in ('operator', 'specialist')
    left join items i on i.collection_id = n.collection_id
    where n.collection_id is not null
    group by n.id, n.slug
    having count(i.id) > 0
  `;
}

/**
 * Book one paid crawl into the revenue ledger.
 *
 * Every event is keyed on the payment reference, so a settlement delivered
 * twice books once even though it becomes several rows. The platform's own
 * remainder is booked too, unattributed, so the ledger's total matches what
 * was actually charged rather than only the part somebody is owed.
 *
 * Returns what it wrote. Never throws: the caller is inside a payment hook and
 * the money has already moved.
 */
export async function attributeCrawlSale(sale) {
  if (!sale?.ref) return { booked: 0, events: [] };
  const totalCents = Math.max(0, Math.round(Number(sale.totalCents) || 0));
  if (totalCents === 0) return { booked: 0, events: [] };

  const [{ n: totalItems }] = await sql`select count(*)::int as n from items`;
  const operated = await operatedNiches();
  const split = splitSaleAcrossNiches({ totalCents, operated, totalItems });

  const events = [];
  for (const niche of split.niches) {
    const out = await r.recordRevenueEvent({
      // One reference per niche, so the whole sale stays idempotent even
      // though it lands as several rows.
      externalId: `x402:${sale.ref}:${niche.slug}`,
      nicheId: niche.id,
      sourceType: 'x402',
      sourceId: sale.ref,
      grossMinor: niche.cents,
      currency: sale.currency ?? 'USD',
      occurredAt: sale.occurredAt ?? null,
      metadata: {
        payer: sale.payer ?? null,
        days: sale.days ?? 1,
        userAgent: sale.userAgent ?? null,
        // What the share was computed from, so the number can be argued with.
        items: niche.items,
        indexItems: totalItems,
      },
    });
    if (out.event && !out.duplicate) events.push({ niche: niche.slug, cents: niche.cents });
  }

  if (split.remainderCents > 0) {
    const out = await r.recordRevenueEvent({
      externalId: `x402:${sale.ref}`,
      nicheId: null,
      sourceType: 'x402',
      sourceId: sale.ref,
      grossMinor: split.remainderCents,
      currency: sale.currency ?? 'USD',
      occurredAt: sale.occurredAt ?? null,
      metadata: { payer: sale.payer ?? null, unattributed: true, indexItems: totalItems },
    });
    if (out.event && !out.duplicate) events.push({ niche: null, cents: split.remainderCents });
  }

  return { booked: events.reduce((n, e) => n + e.cents, 0), events };
}
