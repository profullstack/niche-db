/**
 * Pro membership: one paid term, stacking on renewal.
 *
 * Shared-shape with the sibling sites: this file imports nothing and takes the
 * caller's transaction, so it can be copied between brands verbatim.
 */

export const MEMBERSHIP_KIND = 'membership';

/**
 * Add one paid term, inside the caller's transaction.
 *
 * A renewal STACKS: the new term begins at the later of now and the end of what
 * they already hold. Decided in SQL so two concurrent webhooks cannot both read
 * the same end date. Idempotent through payment_id, which is unique.
 */
export async function grantMembership(tx, { userId, paymentId, priceCents, currency, termDays }) {
  if (!userId) throw new Error('a membership needs a member');
  if (!Number.isFinite(termDays) || termDays <= 0) throw new Error('a membership needs a term');
  if (!Number.isFinite(priceCents) || priceCents < 0) throw new Error('bad price');

  const [row] = await tx`
    insert into memberships (user_id, payment_id, started_at, expires_at, price_cents, currency)
    select ${userId}::uuid,
           ${paymentId ?? null},
           s.start_at,
           s.start_at + make_interval(days => ${Math.trunc(termDays)}::int),
           ${Math.trunc(priceCents)}::int,
           ${currency ?? 'USD'}
    from (
      select greatest(now(), coalesce(max(expires_at), now())) as start_at
      from memberships where user_id = ${userId}::uuid
    ) s
    on conflict (payment_id) do nothing
    returning id, started_at, expires_at
  `;
  return row ?? null;
}
