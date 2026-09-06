import { allocate, attributableNetMinor, MAX_SHARE_BPS } from '@nichedb/knowledge';
import { sql } from './index.js';
import { audit } from './knowledge.js';
import { pgArray } from './queries.js';

/**
 * The revenue ledger.
 *
 * An earning arrives, is finalised, and at that instant is divided between the
 * niche's influencers and the platform using the shares in force right then.
 * Nothing afterwards rewrites it. A tier that moves tomorrow applies to
 * tomorrow's money.
 *
 * The arithmetic lives in `@nichedb/knowledge` and is tested without a
 * database. This module feeds it the current shares and stores what it says.
 */

/* ----------------------------------------------------------------- events -- */

/**
 * Record an earning.
 *
 * Idempotent on `externalId`: a settlement delivered twice books once. That is
 * the only thing between a retried webhook and paying somebody twice, so a
 * caller with a payment reference should always pass it.
 *
 * `finalize` allocates immediately. Leave it false for money that might still
 * be refunded, and finalise when it has settled.
 */
export async function recordRevenueEvent({
  externalId = null,
  nicheId = null,
  sourceType,
  sourceId = null,
  grossMinor,
  processingMinor = 0,
  networkMinor = 0,
  infraMinor = 0,
  refundMinor = 0,
  currency = 'USD',
  occurredAt = null,
  metadata = {},
  finalize = true,
}) {
  const gross = Math.max(0, Math.round(Number(grossMinor) || 0));
  const net = attributableNetMinor({
    grossMinor: gross,
    processingMinor,
    networkMinor,
    infraMinor,
    refundMinor,
  });
  const cost = gross - net;

  const [row] = await sql`
    insert into revenue_events
      (external_id, niche_id, source_type, source_id, gross_amount_minor,
       direct_cost_minor, net_amount_minor, currency, occurred_at, metadata)
    values (${externalId}, ${nicheId ?? null}, ${sourceType}, ${sourceId},
            ${gross}, ${cost}, ${net}, ${currency},
            ${occurredAt ? new Date(occurredAt) : new Date()},
            ${JSON.stringify(metadata)}::text::jsonb)
    on conflict (external_id) do nothing
    returning *
  `;
  if (!row) {
    // Already had it. Hand back what we hold rather than an error: a webhook
    // retrying is normal, and the right answer is "yes, booked".
    const existing = externalId ? await revenueEventByExternalId(externalId) : null;
    return { event: existing, duplicate: true, allocations: [] };
  }

  const allocations = finalize ? await finalizeRevenueEvent(row.id) : [];
  return {
    event: allocations.length ? await getRevenueEvent(row.id) : row,
    duplicate: false,
    allocations,
  };
}

export async function getRevenueEvent(id) {
  const [row] = await sql`
    select e.*, n.slug as niche_slug, n.name as niche_name
    from revenue_events e
    left join niches n on n.id = e.niche_id
    where e.id = ${Number(id)}
  `;
  return row ?? null;
}

export async function revenueEventByExternalId(externalId) {
  const [row] = await sql`select * from revenue_events where external_id = ${externalId}`;
  return row ?? null;
}

/**
 * Divide a settled earning and write the allocations.
 *
 * The shares are read here, at finalisation, and stamped onto each row. A
 * niche with nobody operating it allocates everything to the platform.
 *
 * `finalized_at` is set in the same statement that reads it, conditional on it
 * being null, so two requests racing to finalise the same event produce one
 * set of allocations rather than two.
 */
export async function finalizeRevenueEvent(id) {
  const event = await getRevenueEvent(id);
  if (!event || event.finalized_at) return [];

  const members = event.niche_id
    ? await sql`
        select m.user_id, m.share_cap_bps,
               coalesce(s.score, 0) as score
        from niche_members m
        left join contribution_scores s
          on s.niche_id = m.niche_id and s.influencer_id = m.user_id
        where m.niche_id = ${event.niche_id} and m.status = 'active'
          and m.role in ('operator', 'specialist')
      `
    : [];

  const split = allocate({
    netMinor: Number(event.net_amount_minor),
    members: members.map((m) => ({
      influencerId: m.user_id,
      score: Number(m.score),
      capBps: Number(m.share_cap_bps ?? MAX_SHARE_BPS),
    })),
  });

  const written = [];
  await sql.begin(async (tx) => {
    // Claim the event first. If this updates nothing, somebody else finalised
    // it between the read above and here, and we must not allocate again.
    const claimed = await tx`
      update revenue_events set finalized_at = now()
      where id = ${Number(id)} and finalized_at is null
      returning id
    `;
    if (!claimed.length) return;

    for (const a of split) {
      if (a.amountMinor <= 0 && a.allocationType !== 'platform') continue;
      const [row] = await tx`
        insert into revenue_allocations
          (revenue_event_id, influencer_id, allocation_type, share_bps, amount_minor)
        values (${Number(id)}, ${a.influencerId ?? null}, ${a.allocationType},
                ${a.shareBps}, ${a.amountMinor})
        on conflict do nothing
        returning *
      `;
      if (row) written.push(row);
    }
  });
  return written;
}

/** Everything a niche has earned, newest first. */
export async function revenueForNiche(nicheId, { limit = 100 } = {}) {
  return sql`
    select e.id, e.external_id, e.source_type, e.gross_amount_minor, e.direct_cost_minor,
           e.net_amount_minor, e.currency, e.occurred_at, e.finalized_at
    from revenue_events e
    where e.niche_id = ${Number(nicheId)}
    order by e.occurred_at desc
    limit ${Math.min(Number(limit) || 100, 500)}
  `;
}

/** The totals a niche dashboard shows. */
export async function nicheRevenueTotals(nicheId) {
  const [row] = await sql`
    select coalesce(sum(gross_amount_minor), 0)::bigint as gross,
           coalesce(sum(net_amount_minor), 0)::bigint as net,
           coalesce(sum(net_amount_minor) filter (where source_type = 'x402'), 0)::bigint as machine,
           count(*)::int as events
    from revenue_events where niche_id = ${Number(nicheId)}
  `;
  return {
    grossMinor: Number(row?.gross ?? 0),
    netMinor: Number(row?.net ?? 0),
    machineMinor: Number(row?.machine ?? 0),
    events: Number(row?.events ?? 0),
  };
}

/* ------------------------------------------------------------ influencers -- */

/** What one person has been allocated, and out of what. */
export async function allocationsForInfluencer(userId, { limit = 100, status = null } = {}) {
  return sql`
    select a.id, a.share_bps, a.amount_minor, a.status, a.created_at,
           e.source_type, e.currency, e.occurred_at,
           n.slug as niche_slug, n.name as niche_name
    from revenue_allocations a
    join revenue_events e on e.id = a.revenue_event_id
    left join niches n on n.id = e.niche_id
    where a.influencer_id = ${userId}::uuid
      and (${status}::text is null or a.status = ${status})
    order by a.created_at desc
    limit ${Math.min(Number(limit) || 100, 500)}
  `;
}

/**
 * What somebody is owed and what they have been paid.
 *
 * "Owed" is everything not yet in a payout and not reversed. A reversal is a
 * status, not a deletion, so a refunded sale stops being owed without the row
 * that recorded it disappearing.
 */
export async function balanceFor(userId) {
  const [row] = await sql`
    select
      coalesce(sum(amount_minor) filter (
        where status in ('accrued', 'eligible')), 0)::bigint as owed,
      coalesce(sum(amount_minor) filter (
        where status in ('scheduled', 'processing')), 0)::bigint as in_flight,
      coalesce(sum(amount_minor) filter (where status = 'paid'), 0)::bigint as paid,
      coalesce(sum(amount_minor) filter (where status = 'reversed'), 0)::bigint as reversed
    from revenue_allocations
    where influencer_id = ${userId}::uuid
  `;
  return {
    owedMinor: Number(row?.owed ?? 0),
    inFlightMinor: Number(row?.in_flight ?? 0),
    paidMinor: Number(row?.paid ?? 0),
    reversedMinor: Number(row?.reversed ?? 0),
  };
}

/* --------------------------------------------------------------- payouts -- */

export async function getPayoutAccount(userId) {
  const [row] = await sql`select * from payout_accounts where user_id = ${userId}::uuid`;
  return row ?? null;
}

/**
 * Set where somebody's money goes.
 *
 * Changing the address clears its verification. An attacker who reaches an
 * account should not inherit the confirmation given to the previous address.
 */
export async function setPayoutAddress({ userId, address, currency = 'USD' }) {
  const [row] = await sql`
    insert into payout_accounts (user_id, address, currency)
    values (${userId}::uuid, ${address || null}, ${currency})
    on conflict (user_id) do update
      set address = excluded.address, currency = excluded.currency,
          verified_at = null, updated_at = now()
    returning *
  `;
  return row;
}

export async function verifyPayoutAddress({ userId, actorId }) {
  const [row] = await sql`
    update payout_accounts set verified_at = now(), updated_at = now()
    where user_id = ${userId}::uuid and address is not null
    returning *
  `;
  if (row)
    await audit({
      actorId,
      action: 'payout_account.verified',
      subjectType: 'payout_account',
      subjectId: String(row.id),
      detail: { userId },
    });
  return row ?? null;
}

/**
 * Gather what somebody is owed into one payout.
 *
 * The allocations are attached by their own primary key in `payout_allocations`,
 * so an allocation can belong to at most one payout. Pressing the button twice
 * produces one payout and then an empty one, not two payments.
 *
 * Refuses an unverified address. Paying the wrong address is not recoverable.
 */
export async function schedulePayout({ influencerId, actorId, minimumMinor = 0 }) {
  const account = await getPayoutAccount(influencerId);
  if (!account?.address) return { ok: false, reason: 'no payout address on file' };
  if (!account.verified_at) return { ok: false, reason: 'that payout address is not verified' };

  let payout = null;
  await sql.begin(async (tx) => {
    // `for update skip locked` so two admins clicking at once take disjoint
    // sets rather than blocking or double-claiming.
    const owed = await tx`
      select id, amount_minor from revenue_allocations
      where influencer_id = ${influencerId}::uuid
        and status in ('accrued', 'eligible')
        and not exists (select 1 from payout_allocations p where p.allocation_id = revenue_allocations.id)
      order by created_at
      for update skip locked
    `;
    const total = owed.reduce((n, a) => n + Number(a.amount_minor), 0);
    if (total <= 0 || total < Number(minimumMinor)) return;

    const [created] = await tx`
      insert into payouts (influencer_id, amount_minor, currency, status)
      values (${influencerId}::uuid, ${total}, ${account.currency}, 'scheduled')
      returning *
    `;
    for (const a of owed) {
      await tx`
        insert into payout_allocations (payout_id, allocation_id)
        values (${created.id}, ${a.id})
        on conflict (allocation_id) do nothing
      `;
    }
    await tx`
      update revenue_allocations set status = 'scheduled'
      where id = any(${pgArray(owed.map((a) => a.id))}::bigint[])
    `;
    payout = created;
  });

  if (!payout) return { ok: false, reason: 'nothing is owed' };
  await audit({
    actorId,
    action: 'payout.scheduled',
    subjectType: 'payout',
    subjectId: String(payout.id),
    detail: { influencerId, amountMinor: Number(payout.amount_minor) },
  });
  return { ok: true, payout };
}

/** Record that a scheduled payout actually moved, with whatever reference did it. */
export async function markPayoutPaid({ payoutId, actorId, externalRef }) {
  let payout = null;
  await sql.begin(async (tx) => {
    const [row] = await tx`
      update payouts
      set status = 'paid', paid_at = now(), updated_at = now(), external_ref = ${externalRef ?? null}
      where id = ${Number(payoutId)} and status in ('scheduled', 'processing')
      returning *
    `;
    if (!row) return;
    await tx`
      update revenue_allocations set status = 'paid'
      where id in (select allocation_id from payout_allocations where payout_id = ${row.id})
    `;
    payout = row;
  });
  if (!payout) return null;
  await audit({
    actorId,
    action: 'payout.paid',
    subjectType: 'payout',
    subjectId: String(payout.id),
    detail: { externalRef, amountMinor: Number(payout.amount_minor) },
  });
  return payout;
}

/**
 * A payout that did not happen. The allocations go back to being owed, so the
 * money is not stranded in a state nothing will pick up again.
 */
export async function markPayoutFailed({ payoutId, actorId, reason }) {
  let payout = null;
  await sql.begin(async (tx) => {
    const [row] = await tx`
      update payouts set status = 'failed', failure_reason = ${reason ?? null}, updated_at = now()
      where id = ${Number(payoutId)} and status in ('scheduled', 'processing')
      returning *
    `;
    if (!row) return;
    await tx`
      update revenue_allocations set status = 'accrued'
      where id in (select allocation_id from payout_allocations where payout_id = ${row.id})
    `;
    await tx`delete from payout_allocations where payout_id = ${row.id}`;
    payout = row;
  });
  if (!payout) return null;
  await audit({
    actorId,
    action: 'payout.failed',
    subjectType: 'payout',
    subjectId: String(payout.id),
    detail: { reason },
  });
  return payout;
}

export async function listPayouts({ influencerId = null, limit = 50 } = {}) {
  return sql`
    select p.*, u.handle::text as handle, u.display_name, u.email::text as email
    from payouts p
    join users u on u.id = p.influencer_id
    where (${influencerId}::uuid is null or p.influencer_id = ${influencerId}::uuid)
    order by p.created_at desc
    limit ${Math.min(Number(limit) || 50, 200)}
  `;
}

/** Everyone with money waiting, for the admin's payout run. */
export async function outstandingBalances({ limit = 100 } = {}) {
  return sql`
    select a.influencer_id, u.handle::text as handle, u.display_name, u.email::text as email,
           sum(a.amount_minor)::bigint as owed,
           pa.address is not null as has_address,
           pa.verified_at is not null as verified
    from revenue_allocations a
    join users u on u.id = a.influencer_id
    left join payout_accounts pa on pa.user_id = a.influencer_id
    where a.status in ('accrued', 'eligible') and a.influencer_id is not null
    group by a.influencer_id, u.handle, u.display_name, u.email, pa.address, pa.verified_at
    having sum(a.amount_minor) > 0
    order by sum(a.amount_minor) desc
    limit ${Math.min(Number(limit) || 100, 500)}
  `;
}

/**
 * Take back an allocation whose earning turned out not to be real: a refund, a
 * chargeback, a reversed contribution. Marked, never deleted, so the history
 * of what was believed at payout time survives.
 */
export async function reverseAllocation({ allocationId, actorId, reason }) {
  const [row] = await sql`
    update revenue_allocations set status = 'reversed'
    where id = ${Number(allocationId)} and status in ('accrued', 'eligible')
    returning *
  `;
  if (!row) return null;
  await audit({
    actorId,
    action: 'allocation.reversed',
    subjectType: 'revenue_allocation',
    subjectId: String(allocationId),
    detail: { reason, amountMinor: Number(row.amount_minor) },
  });
  return row;
}

export async function listRevenueEvents({ limit = 100 } = {}) {
  return sql`
    select e.*, n.slug as niche_slug, n.name as niche_name,
           (select count(*)::int from revenue_allocations a where a.revenue_event_id = e.id) as allocations
    from revenue_events e
    left join niches n on n.id = e.niche_id
    order by e.occurred_at desc
    limit ${Math.min(Number(limit) || 100, 500)}
  `;
}
