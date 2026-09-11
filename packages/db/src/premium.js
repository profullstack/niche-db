/**
 * Every statement Premium runs: terms, the credit ledger, awards, and the
 * collections that are open to members before they are open to everyone.
 *
 * The rules about what a plan is worth live in `@nichedb/premium` and the
 * money lives in `packages/payments`. This file only reads and writes rows.
 */
import { sql } from './index.js';
import { pgArray } from './queries.js';

/* -------------------------------------------------------------------- terms -- */

/** Every unexpired term a user holds, best plan first. `planFor` picks from these. */
export async function activeTerms(userId) {
  if (!userId) return [];
  return sql`
    select id, plan, started_at, expires_at, price_cents, currency
    from memberships
    where user_id = ${userId}::uuid and expires_at > now()
    order by case plan when 'pro' then 2 else 1 end desc, expires_at desc
  `;
}

/** The longest-running term on a given plan, for "you are Premium until ...". */
export async function activeTermOn(userId, plan) {
  if (!userId) return null;
  const [row] = await sql`
    select id, plan, started_at, expires_at
    from memberships
    where user_id = ${userId}::uuid and plan = ${plan} and expires_at > now()
    order by expires_at desc limit 1
  `;
  return row ?? null;
}

/* ------------------------------------------------------------------ credits -- */

/** The balance is the sum of the ledger. Never stored, so it cannot disagree with itself. */
export async function creditBalance(userId) {
  if (!userId) return 0;
  const [row] = await sql`
    select coalesce(sum(delta), 0)::int as balance from premium_credits where user_id = ${userId}::uuid
  `;
  return row?.balance ?? 0;
}

export async function creditLedger(userId, { limit = 25 } = {}) {
  if (!userId) return [];
  return sql`
    select id, delta, reason, ref, created_at from premium_credits
    where user_id = ${userId}::uuid order by created_at desc, id desc limit ${limit}
  `;
}

/**
 * Add credits under a ref that may only ever be used once for this user.
 *
 * Returns the row when it wrote one and null when the ref was already used, so
 * the caller can tell "granted" from "already had it" without a second read.
 * Two granters racing produce one grant: the unique index decides, not us.
 */
export async function grantCredits({ userId, amount, reason, ref = null, tx = sql }) {
  if (!userId || !Number.isFinite(amount) || amount <= 0) return null;
  const [row] = await tx`
    insert into premium_credits ${tx({
      user_id: userId,
      delta: Math.trunc(amount),
      reason,
      ref,
    })}
    on conflict do nothing
    returning id, delta, ref, created_at
  `;
  return row ?? null;
}

/* ------------------------------------------------------------------- awards -- */

/**
 * Give an award: the charge and the award in one transaction, with the balance
 * re-read inside it.
 *
 * The balance check in the caller is for the message; this one is for the
 * money. Two tabs clicking the same button cannot both spend the last 100
 * credits, and the unique (user, target, kind) means the second one is a
 * no-op rather than a second charge.
 */
export async function giveAward({ userId, targetType, targetId, kind, credits }) {
  return sql.begin(async (tx) => {
    const [balanceRow] = await tx`
      select coalesce(sum(delta), 0)::int as balance from premium_credits
      where user_id = ${userId}::uuid
    `;
    const balance = balanceRow?.balance ?? 0;
    if (balance < credits) return { ok: false, reason: 'not enough credits', balance };

    const [award] = await tx`
      insert into premium_awards ${tx({
        user_id: userId,
        target_type: targetType,
        target_id: Math.trunc(targetId),
        kind,
        credits: Math.trunc(credits),
      })}
      on conflict (user_id, target_type, target_id, kind) do nothing
      returning id, kind, credits, created_at
    `;
    if (!award) return { ok: false, reason: 'already awarded', balance };

    await tx`
      insert into premium_credits ${tx({
        user_id: userId,
        delta: -Math.trunc(credits),
        reason: `award:${kind}`,
        ref: `award:${award.id}`,
      })}
    `;
    return { ok: true, award, balance: balance - credits };
  });
}

/** What one thing has been given, newest first. */
export async function awardsFor({ targetType, targetId, limit = 20 }) {
  return sql`
    select a.id, a.kind, a.credits, a.created_at,
           u.handle::text as handle, u.display_name
    from premium_awards a join users u on u.id = a.user_id
    where a.target_type = ${targetType} and a.target_id = ${Math.trunc(targetId)}
    order by a.created_at desc limit ${limit}
  `;
}

/** Counts per kind for one thing, for the line under a title. */
export async function awardCounts({ targetType, targetId }) {
  const rows = await sql`
    select kind, count(*)::int as n from premium_awards
    where target_type = ${targetType} and target_id = ${Math.trunc(targetId)}
    group by kind order by n desc
  `;
  return rows;
}

/** The most-awarded things lately: what the Lounge is actually for. */
export async function topAwarded({ targetType = 'item', days = 7, limit = 12 } = {}) {
  return sql`
    select a.target_id, count(*)::int as awards, sum(a.credits)::int as credits,
           max(a.created_at) as last_at
    from premium_awards a
    where a.target_type = ${targetType} and a.created_at > now() - make_interval(days => ${days}::int)
    group by a.target_id
    order by awards desc, credits desc, last_at desc
    limit ${limit}
  `;
}

/** Awards a user has given, for their own dashboard. */
export async function awardsGiven(userId, { limit = 20 } = {}) {
  if (!userId) return [];
  return sql`
    select id, target_type, target_id, kind, credits, created_at
    from premium_awards where user_id = ${userId}::uuid
    order by created_at desc limit ${limit}
  `;
}

/* -------------------------------------------------------------- appearance -- */

export async function saveAppearance({ userId, theme, icon }) {
  await sql`
    update users set premium_theme = ${theme ?? null}, premium_icon = ${icon ?? null}
    where id = ${userId}::uuid
  `;
}

/* ------------------------------------------------------------ early access -- */

/** Collections a member sees before the public does. */
export async function earlyAccessCollections() {
  return sql`
    select c.*,
      (select count(*)::int from sources s where s.collection_id = c.id and s.enabled) as source_count,
      coalesce((select sum(s.item_count)::int from sources s where s.collection_id = c.id), 0) as item_count
    from collections c
    where c.early_access
    order by c.id
  `;
}

/** Is this collection members-only right now? Cheap, and asked on every collection page. */
export async function isEarlyAccess(slug) {
  const [row] = await sql`select early_access from collections where slug = ${slug}`;
  return Boolean(row?.early_access);
}

/** The members roll on the Lounge: who is paying, newest first. No emails. */
export async function loungeMembers({ limit = 50 } = {}) {
  return sql`
    select distinct on (u.id)
           u.handle::text as handle, u.display_name, m.plan, m.started_at
    from memberships m join users u on u.id = m.user_id
    where m.expires_at > now()
    order by u.id, m.started_at desc
    limit ${limit}
  `;
}

/** How many people hold a term right now, per plan. For the pricing page. */
export async function memberCounts() {
  const rows = await sql`
    select plan, count(distinct user_id)::int as n from memberships
    where expires_at > now() group by plan
  `;
  return Object.fromEntries(rows.map((r) => [r.plan, r.n]));
}

/* ------------------------------------------------------------- plan lookup -- */

/**
 * The plan each of these users holds right now, as a map of id to plan.
 *
 * One statement for a whole list, because the alternative is a query per row
 * rendered — which is how a badge beside a name turns a page with fifteen
 * contributions on it into sixteen round trips.
 *
 * Bun's driver stringifies a JS array into `a,b`, so the ids go in as a
 * Postgres array explicitly (see the array-params test).
 */
export async function plansForUsers(userIds) {
  const ids = [...new Set((userIds ?? []).filter(Boolean).map(String))];
  if (ids.length === 0) return {};
  const rows = await sql`
    select user_id::text as user_id,
           case when bool_or(plan = 'pro') then 'pro' else 'premium' end as plan
    from memberships
    where expires_at > now() and user_id = any(${pgArray(ids)}::uuid[])
    group by user_id
  `;
  return Object.fromEntries(rows.map((r) => [r.user_id, r.plan]));
}
