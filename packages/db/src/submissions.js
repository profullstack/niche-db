import { sql } from './index.js';

/**
 * Feed suggestions: the queue an admin works through before anything is
 * fetched on a schedule. See migration 0017 for the shape.
 */

const detail = sql`
  s.*,
  c.slug::text  as collection_slug,
  c.name::text  as collection_name,
  u.email::text as user_email,
  u.handle::text as user_handle,
  d.email::text as decided_by_email,
  src.slug::text as source_slug
`;

const joins = sql`
  from source_submissions s
  left join collections c on c.id = s.collection_id
  left join users u on u.id = s.user_id
  left join users d on d.id = s.decided_by
  left join sources src on src.id = s.source_id
`;

/**
 * Insert a pending suggestion. Returns null when the same URL is already
 * waiting: the partial unique index refuses it and `do nothing` turns the
 * refusal into an empty result rather than an error.
 */
export async function createSubmission({
  feedUrl,
  collectionId = null,
  note = null,
  userId = null,
  email = null,
  probe = {},
}) {
  const [row] = await sql`
    insert into source_submissions (feed_url, collection_id, note, user_id, email, probe)
    values (${feedUrl}, ${collectionId}, ${note}, ${userId}::uuid, ${email},
            ${JSON.stringify(probe ?? {})}::text::jsonb)
    on conflict (feed_url) where status = 'pending' do nothing
    returning *
  `;
  return row ?? null;
}

export async function getSubmission(id) {
  const [row] = await sql`select ${detail} ${joins} where s.id = ${Number(id)}`;
  return row ?? null;
}

export async function pendingByUrl(feedUrl) {
  const [row] = await sql`
    select ${detail} ${joins} where s.feed_url = ${feedUrl} and s.status = 'pending'
  `;
  return row ?? null;
}

export async function listSubmissions({ status = 'pending', limit = 100 } = {}) {
  const cap = Math.max(1, Math.min(Number(limit) || 100, 500));
  if (!status) {
    return sql`select ${detail} ${joins} order by s.created_at desc, s.id desc limit ${cap}`;
  }
  return sql`
    select ${detail} ${joins}
    where s.status = ${status}
    order by s.created_at desc, s.id desc
    limit ${cap}
  `;
}

export async function countPending() {
  const [row] =
    await sql`select count(*)::int as n from source_submissions where status = 'pending'`;
  return row?.n ?? 0;
}

/** How many a person has waiting, so one visitor cannot fill the queue. */
export async function pendingBySubmitter({ userId = null, email = null } = {}) {
  if (userId) {
    const [row] = await sql`
      select count(*)::int as n from source_submissions
      where status = 'pending' and user_id = ${userId}::uuid
    `;
    return row?.n ?? 0;
  }
  if (email) {
    const [row] = await sql`
      select count(*)::int as n from source_submissions
      where status = 'pending' and lower(email) = lower(${email})
    `;
    return row?.n ?? 0;
  }
  return 0;
}

/**
 * Close a pending row. Returns the updated row, or null when it was already
 * decided, so two admins clicking at once cannot approve the same URL twice.
 */
export async function decideSubmission({
  id,
  approve,
  actorId,
  note = null,
  sourceId = null,
  forwardedTo = null,
}) {
  const [row] = await sql`
    update source_submissions
    set status = ${approve ? 'approved' : 'rejected'},
        decided_at = now(), decided_by = ${actorId}::uuid, decision_note = ${note},
        source_id = ${sourceId}, forwarded_to = ${forwardedTo}
    where id = ${Number(id)} and status = 'pending'
    returning *
  `;
  return row ?? null;
}
