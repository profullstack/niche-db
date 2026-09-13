/**
 * The way out of an account, as data: end a plan, hand back everything the
 * account holds, delete it. These are the store behind the OpenSaaS actions
 * (logicsrc.com/opensaas) nichedb serves about itself, and behind the pages
 * a person uses for the same three things.
 */
import { createHash, randomBytes } from 'node:crypto';
import { sql } from './index.js';

export const ACTION_TTL_MINUTES = 30;

const hash = (token) => createHash('sha256').update(String(token)).digest();

export async function userByEmail(email) {
  const [row] = await sql`
    select *, email::text as email, handle::text as handle
    from users where email = ${String(email).trim().toLowerCase()}
  `;
  return row ?? null;
}

/**
 * End every running term of a plan now. Prepaid terms do not renew, so this
 * is the one meaning "cancel" can have here: the plan stops today, the rows
 * stay with the moment they were cut, and nothing is refunded (the descriptor
 * says so). Returns the terms that were ended.
 */
export async function cancelPlan(userId, plan) {
  return sql`
    update memberships
       set cancelled_at = now(), expires_at = now()
     where user_id = ${userId}::uuid and plan = ${plan}
       and expires_at > now() and cancelled_at is null
    returning id, plan, started_at, expires_at, cancelled_at
  `;
}

/** The running plans an account holds, newest end first. */
export async function activePlans(userId) {
  return sql`
    select plan, max(expires_at) as expires_at, count(*)::int as terms
      from memberships
     where user_id = ${userId}::uuid and expires_at > now()
     group by plan order by max(expires_at) desc
  `;
}

/**
 * Everything the account holds, as one JSON document. Secrets never: an API
 * key is named by its prefix, a passkey by its id, a push subscription by
 * its count. The row shapes are the tables', so a reader gets the account
 * as it is kept rather than as a page shows it.
 */
export async function exportAccount(userId) {
  const [user] = await sql`
    select id, email::text as email, role, handle::text as handle, display_name, timezone,
           created_at, last_seen_at, premium_theme, premium_icon
      from users where id = ${userId}::uuid
  `;
  if (!user) return null;
  const [
    apiKeys,
    passkeys,
    follows,
    memberships,
    payments,
    submissions,
    profiles,
    sources,
    feeds,
    push,
  ] = await Promise.all([
    sql`select id, name, prefix, created_at, last_used_at, expires_at, revoked_at
            from api_keys where user_id = ${userId}::uuid order by created_at`,
    sql`select credential_id, created_at, last_used_at from passkeys
           where user_id = ${userId}::uuid order by created_at`,
    sql`select f.slug, f.name, fo.channels, fo.created_at
            from follows fo join feeds f on f.id = fo.feed_id
           where fo.user_id = ${userId}::uuid order by fo.created_at`,
    sql`select plan, started_at, expires_at, cancelled_at, price_cents, currency, created_at
            from memberships where user_id = ${userId}::uuid order by started_at`,
    sql`select provider, provider_ref, amount_cents, currency, created_at
            from payments where user_id = ${userId}::uuid order by created_at`,
    sql`select feed_url, note, status, created_at, decided_at
            from source_submissions where user_id = ${userId}::uuid order by created_at`,
    sql`select id, slug, handle, name, claimed_at, claim_method, overrides, public, updated_at
            from profiles where owner_user_id = ${userId}::uuid order by id`,
    sql`select slug, name, adapter, config, cadence_minutes, enabled, created_at
            from sources where owner_id = ${userId}::uuid order by created_at`,
    sql`select slug, name, query, created_at from feeds
           where owner_id = ${userId}::uuid order by created_at`,
    sql`select count(*)::int as n from push_subscriptions
           where user_id = ${userId}::uuid and disabled_at is null`,
  ]);
  return {
    exported_at: new Date().toISOString(),
    account: user,
    api_keys: apiKeys,
    passkeys,
    follows,
    memberships,
    payments,
    submissions,
    profiles,
    sources,
    feeds,
    push_subscriptions: push[0]?.n ?? 0,
  };
}

/** A one-time link token for an account action; only its hash is kept. */
export async function createActionToken(userId, action) {
  const token = randomBytes(32).toString('base64url');
  await sql`
    insert into account_actions (token_hash, user_id, action, expires_at)
    values (${hash(token)}, ${userId}::uuid, ${action},
            now() + make_interval(mins => ${ACTION_TTL_MINUTES}))
  `;
  return token;
}

/** Spend the link; the user id it stood for, or null when it is spent, expired or wrong. */
export async function consumeActionToken(token, action) {
  const [row] = await sql`
    update account_actions set consumed_at = now()
     where token_hash = ${hash(token)} and action = ${action}
       and consumed_at is null and expires_at > now()
    returning user_id
  `;
  return row?.user_id ?? null;
}

/**
 * Delete the account. Sessions, passkeys, keys, follows, memberships, payments,
 * push subscriptions and referral rows cascade at once; a profile the person
 * claimed is unclaimed rather than removed (it is about them, not theirs to
 * take from the directory); a source or feed they made is left with no owner
 * because other people follow it. Nothing is kept for later.
 */
export async function deleteAccount(userId) {
  const [row] =
    await sql`delete from users where id = ${userId}::uuid returning email::text as email`;
  return row ?? null;
}
