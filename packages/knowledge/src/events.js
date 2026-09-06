/**
 * The contracts the later phases arrive through, defined now so Phase 1 does
 * not have to be unpicked to add them.
 *
 * Nothing here writes to a table and nothing here talks to a gateway. These
 * are the shapes: what Chovy sends when its agent has a question, what the
 * x402 gateway's sale looks like once it has been normalised into something
 * a ledger can attribute, and how one settlement divides between the people
 * who earned it. They are pure and they are tested, so when Phase 3 adds the
 * ledger tables the arithmetic under them is already known to be right.
 */

import { apportion, MAX_SHARE_BPS, splitShareBps } from './tiers.js';

/**
 * Every event between NicheDB, Chovy and the gateway carries this envelope.
 * `id` is what makes delivery idempotent: the same event replayed books once,
 * which matters most for the one that moves money.
 */
export const DOMAIN_EVENT_VERSION = 1;

export function domainEvent({ type, producer, payload, nicheId, userId, id, occurredAt } = {}) {
  if (!type) throw new TypeError('a domain event needs a type');
  if (!producer) throw new TypeError('a domain event needs a producer');
  return {
    id: id ?? crypto.randomUUID(),
    type,
    version: DOMAIN_EVENT_VERSION,
    occurredAt: occurredAt ?? new Date().toISOString(),
    producer,
    nicheId: nicheId ?? null,
    userId: userId ?? null,
    payload: payload ?? {},
  };
}

/** NicheDB tells Chovy. */
export const NICHEDB_EVENTS = [
  'niche.created',
  'niche.updated',
  'influencer.joined',
  'influencer.tier_changed',
  'expert_answer.created',
  // A human read the question and sent it back: the agent has to find out more
  // before a person can settle it. Not a failure, and not scored.
  'agent.research_requested',
  'source.approved',
  'source.rejected',
  'product_idea.created',
  'promotion_idea.created',
];

/** Chovy tells NicheDB. */
export const CHOVY_EVENTS = [
  'agent.question_created',
  'agent.research_completed',
  'knowledge.proposed',
  'knowledge.correction_proposed',
  'software.feature_proposed',
  'software.feature_shipped',
  'promotion.proposed',
  'promotion.completed',
  'lead.generated',
  'revenue.attribution_proposed',
];

/** Where money can come from. The ledger stores the source, not a guess at it. */
export const REVENUE_SOURCE_TYPES = [
  'software_subscription',
  'software_one_time',
  'api',
  'x402',
  'dataset_license',
  'lead',
  'sponsorship',
  'affiliate',
  'referral',
  'advertising',
  'service',
  'other',
];

/**
 * One paid crawl, in the ledger's language.
 *
 * The argument is the sale object this deployment's x402 gateway already
 * hands `onSale` (apps/web/src/lib/pricing.js) — payer, ref, days, priceCents,
 * totalCents, currency, userAgent, expiresAt. Nothing about the gateway
 * changes to support this; the ledger reads what it already emits.
 *
 * `eventId` is the payment reference, so a settlement delivered twice is one
 * row. Amounts stay integer minor units the whole way: a share of a dollar
 * computed in floating point is a share that does not add up.
 */
export function machineRevenueEvent(sale, { property, nicheId = null, resourceId = null } = {}) {
  const ref = sale?.ref ? String(sale.ref) : null;
  if (!ref) return null;
  const amount = Math.max(0, Math.round(Number(sale.totalCents) || 0));
  return {
    eventId: `x402:${ref}`,
    property: property ?? null,
    nicheId,
    resourceId,
    path: sale.path ?? null,
    consumerId: sale.payer ?? null,
    sourceType: 'x402',
    amountMinor: amount,
    currency: sale.currency ?? 'USD',
    paymentRef: ref,
    requestCount: Number(sale.requestCount) || null,
    bytesServed: Number(sale.bytesServed) || null,
    occurredAt: sale.occurredAt ?? new Date().toISOString(),
  };
}

/**
 * Gross, less what it actually cost to take the money, is what gets shared.
 *
 * Payment fees and the infrastructure a request genuinely consumed come off,
 * because they were never revenue. Nothing else does: subtracting a share of
 * the office from a roofer's payout is how a revenue share becomes an
 * argument, and this one is meant to be checkable on a page.
 */
export function attributableNetMinor({
  grossMinor = 0,
  processingMinor = 0,
  networkMinor = 0,
  infraMinor = 0,
  refundMinor = 0,
} = {}) {
  const n = (v) => Math.max(0, Math.round(Number(v) || 0));
  return Math.max(
    0,
    n(grossMinor) - n(processingMinor) - n(networkMinor) - n(infraMinor) - n(refundMinor),
  );
}

/**
 * Divide a settled revenue event between the niche's influencers and the
 * platform.
 *
 * The shares are the ones in force at the moment the event is finalised, and
 * that is the point: a tier change tomorrow does not reach back and rewrite
 * what today's sale paid. Every allocation is whole minor units, and the
 * platform takes the remainder, so gross out equals net in exactly.
 */
export function allocate({ netMinor, members = [], maxInfluencerBps = MAX_SHARE_BPS } = {}) {
  const net = Math.max(0, Math.round(Number(netMinor) || 0));
  const split = splitShareBps(members, { maxBps: maxInfluencerBps });

  const allocations = [];
  let paid = 0;
  for (const member of split) {
    // Floor every share: over-paying the last member out of a rounding
    // remainder is the one direction this must never go.
    const amount = Math.floor((net * member.shareBps) / 10_000);
    if (amount <= 0 && member.shareBps === 0) continue;
    paid += amount;
    allocations.push({
      influencerId: member.influencerId ?? member.id ?? null,
      allocationType: 'knowledge_influencer',
      shareBps: member.shareBps,
      amountMinor: amount,
    });
  }

  allocations.push({
    influencerId: null,
    allocationType: 'platform',
    shareBps: 10_000 - allocations.reduce((n, a) => n + a.shareBps, 0),
    amountMinor: net - paid,
  });
  return allocations;
}

/** Where a payout can be in its life. Forward only, except for a reversal. */
export const PAYOUT_STATES = [
  'accrued',
  'eligible',
  'scheduled',
  'processing',
  'paid',
  'failed',
  'reversed',
];

/**
 * How one crawl sale divides between niches.
 *
 * A pass buys the whole index for a day, not one niche, so there is no single
 * niche to hand it to. The only measurable answer to "whose data did this pay
 * for" is how much of the index each niche holds, which is the rule the
 * partner programme already splits on.
 *
 * The share is taken against the WHOLE index, and the part nobody operates is
 * a claimant too. A niche holding one percent of the rows does not collect the
 * whole dollar because it happens to be the only one with an operator.
 *
 * Returns one entry per operated niche plus the platform remainder.
 */
export function splitSaleAcrossNiches({ totalCents, operated, totalItems }) {
  const total = Math.max(0, Math.round(Number(totalCents) || 0));
  const all = Math.max(0, Number(totalItems) || 0);
  if (total === 0 || all === 0 || !operated?.length) return { niches: [], remainderCents: total };

  // The unoperated remainder is a claimant too, so the apportionment covers
  // the whole index and every cent lands somewhere.
  const operatedItems = operated.reduce((n, o) => n + Math.max(0, Number(o.items) || 0), 0);
  const weights = [
    ...operated.map((o) => Math.max(0, Number(o.items) || 0)),
    Math.max(0, all - operatedItems),
  ];
  const parts = apportion(total, weights);

  // A niche apportioned zero cents contributes nothing, so dropping it cannot
  // lose money: the kept shares plus the remainder still sum to the sale.
  return {
    niches: operated.map((o, i) => ({ ...o, cents: parts[i] })).filter((o) => o.cents > 0),
    remainderCents: parts.at(-1),
  };
}
