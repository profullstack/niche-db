import { sql } from './index.js';

/**
 * Reads and writes for bad traffic (migration 0036): addresses our servers
 * banned, published only once a person approved them.
 *
 * Bulk writes go in as one JSON document unpacked by `jsonb_to_recordset`,
 * never as JS arrays (Bun stringifies an array parameter as `a,b`). Every
 * function takes `{ db }` so a test can hand it PGlite.
 */

const doc = (rows) => JSON.stringify(rows ?? []);

/** The review agent's account; its decisions are labelled as riotcoder's in public. */
export const RIOTCODER_EMAIL = 'riotcoder@profullstack.com';

/**
 * Merge a batch of candidates from the feed. New addresses arrive pending;
 * known ones get fresh evidence but keep their decision. Returns how many rows
 * were new.
 */
export async function upsertCandidates(rows, { db = sql } = {}) {
  if (!rows?.length) return 0;
  const [{ added }] = await db`
    with incoming as (
      select * from jsonb_to_recordset(${doc(rows)}::text::jsonb) as r(
        ip text, score int, category text, first_seen timestamptz, last_seen timestamptz,
        blocks int, servers int, rules jsonb, max_severity text, evidence jsonb
      )
    ), merged as (
      insert into traffic_ips as t
        (ip, score, category, first_seen, last_seen, blocks, servers, rules, max_severity, evidence)
      select ip::inet, coalesce(score, 0), category, first_seen, last_seen,
             coalesce(blocks, 0), coalesce(servers, 0), coalesce(rules, '[]'::jsonb), max_severity,
             coalesce(evidence, '{}'::jsonb)
      from incoming
      on conflict (ip) do update set
        score        = excluded.score,
        category     = excluded.category,
        first_seen   = least(t.first_seen, excluded.first_seen),
        last_seen    = greatest(t.last_seen, excluded.last_seen),
        blocks       = greatest(t.blocks, excluded.blocks),
        servers      = greatest(t.servers, excluded.servers),
        rules        = excluded.rules,
        max_severity = excluded.max_severity,
        evidence     = excluded.evidence,
        updated_at   = now()
      returning (xmax = 0) as inserted
    )
    select count(*) filter (where inserted)::int as added from merged
  `;
  return added;
}

/** Approved addresses, newest decision first. `maxAgeDays` drops ones quiet for that long. */
export async function listPublished(
  { limit = 100, offset = 0, maxAgeDays = null, category = null } = {},
  { db = sql } = {},
) {
  return db`
    select host(ip) as ip, category, first_seen, last_seen, blocks, servers, rules, max_severity,
      reviewed_at, evidence
    from traffic_ips
    where status = 'approved'
      and (${maxAgeDays}::int is null or last_seen > now() - make_interval(days => ${maxAgeDays}::int))
      and (${category}::text is null or category = ${category}::text)
    order by reviewed_at desc, ip
    limit ${limit} offset ${offset}
  `;
}

/** Every approved address as text, for the plain blocklist. */
export async function listPublishedIps(
  { maxAgeDays = null, category = null } = {},
  { db = sql } = {},
) {
  const rows = await db`
    select host(ip) as ip from traffic_ips
    where status = 'approved'
      and (${maxAgeDays}::int is null or last_seen > now() - make_interval(days => ${maxAgeDays}::int))
      and (${category}::text is null or category = ${category}::text)
    order by ip
  `;
  return rows.map((r) => r.ip);
}

/**
 * One address as the public sees it. A pending or rejected address answers
 * `listed: false` with no evidence: unreviewed data is never published.
 */
export async function lookupIp(ip, { db = sql } = {}) {
  // The reviewer is named only as "riotcoder" or "a person": a moderator's email is never public.
  const [row] = await db`
    select host(t.ip) as ip, t.category, t.first_seen, t.last_seen, t.blocks, t.servers, t.rules,
      t.max_severity, t.reviewed_at, t.evidence, t.review_note, t.status,
      case when u.email = ${RIOTCODER_EMAIL} then 'riotcoder' else 'a person' end as reviewer
    from traffic_ips t left join users u on u.id = t.reviewed_by
    where t.ip = ${ip}::inet
  `;
  if (!row || row.status !== 'approved') return { ip, listed: false };
  const { status: _status, ...rest } = row;
  return { listed: true, ...rest };
}

export async function trafficStats({ db = sql } = {}) {
  const [row] = await db`
    select
      count(*) filter (where status = 'approved')::int as approved,
      count(*) filter (where status = 'pending')::int  as pending,
      count(*) filter (where status = 'rejected')::int as rejected,
      count(distinct reviewed_by) filter (where status <> 'pending')::int as reviewers,
      max(reviewed_at) as last_review
    from traffic_ips
  `;
  const categories = await db`
    select category, count(*)::int as n from traffic_ips
    where status = 'approved' group by category order by n desc
  `;
  return { ...row, categories };
}

/** The review queue: strongest evidence first. */
export async function listQueue(
  { status = 'pending', limit = 50, offset = 0 } = {},
  { db = sql } = {},
) {
  // Pending is worked strongest first; decided rows read newest decision first.
  return db`
    select host(t.ip) as ip, t.status, t.score, t.category, t.first_seen, t.last_seen, t.blocks,
           t.servers, t.rules, t.max_severity, t.evidence, t.reviewed_at, t.review_note,
           u.email as reviewer
    from traffic_ips t left join users u on u.id = t.reviewed_by
    where t.status = ${status}
    order by case when ${status} = 'pending' then t.score end desc nulls last,
             case when ${status} = 'pending' then t.last_seen end desc nulls last,
             t.reviewed_at desc nulls last, t.ip
    limit ${limit} offset ${offset}
  `;
}

/**
 * Record a reviewer's decision on one or more addresses. Returns how many
 * changed. A note is required to reject, so the reason survives.
 */
export async function reviewIps({ ips, status, userId, note = null }, { db = sql } = {}) {
  if (!ips?.length) return 0;
  const rows = await db`
    update traffic_ips set
      status = ${status}, reviewed_by = ${userId}, reviewed_at = now(),
      review_note = ${note}, updated_at = now()
    where ip in (select (value #>> '{}')::inet from jsonb_array_elements(${doc(ips)}::text::jsonb))
    returning ip
  `;
  return rows.length;
}

/**
 * Every decided address, for ThreatCrush (token-gated): an approval lets it
 * list a source on a reviewer's say, a rejection keeps it off its feed too.
 */
export async function listDecisions({ db = sql } = {}) {
  const rows = await db`
    select host(ip) as ip, status from traffic_ips where status in ('approved', 'rejected') order by ip
  `;
  return {
    approved: rows.filter((r) => r.status === 'approved').map((r) => r.ip),
    rejected: rows.filter((r) => r.status === 'rejected').map((r) => r.ip),
  };
}

/** A delisting request for a listed address. Returns the row, or null when the address is not listed. */
export async function addDelistRequest({ ip, email, reason }, { db = sql } = {}) {
  const [row] = await db`
    insert into traffic_delist_requests (ip, email, reason)
    select ${ip}::inet, ${email}, ${reason}
    where exists (select 1 from traffic_ips where ip = ${ip}::inet and status = 'approved')
    returning id, host(ip) as ip, status, created_at
  `;
  return row ?? null;
}

export async function listDelistRequests({ status = 'open', limit = 50 } = {}, { db = sql } = {}) {
  return db`
    select d.id, host(d.ip) as ip, d.email, d.reason, d.status, d.created_at, d.decided_at, d.decision_note,
           t.category, t.servers, t.blocks, t.last_seen
    from traffic_delist_requests d left join traffic_ips t on t.ip = d.ip
    where d.status = ${status}
    order by d.created_at asc
    limit ${limit}
  `;
}

/**
 * Decide a request. `delist` takes the address off the list (it becomes
 * rejected, so a later import never brings it back); `decline` leaves it.
 * Returns whether an open request was decided.
 */
export async function decideDelistRequest({ id, action, userId, note = null }, { db = sql } = {}) {
  const status = action === 'delist' ? 'delisted' : 'declined';
  const [row] = await db`
    update traffic_delist_requests set status = ${status}, decided_by = ${userId}, decided_at = now(),
      decision_note = ${note}
    where id = ${id} and status = 'open'
    returning host(ip) as ip
  `;
  if (!row) return false;
  if (action === 'delist') {
    await db`
      update traffic_ips set status = 'rejected', reviewed_by = ${userId}, reviewed_at = now(),
        review_note = ${note ?? 'Delisted on the owner’s request.'}, updated_at = now()
      where ip = ${row.ip}::inet
    `;
  }
  return true;
}

/** The queue as the review job reads it: every pending address with its stored paths. */
export async function pendingForReview({ limit = 100_000 } = {}, { db = sql } = {}) {
  const rows = await db`
    select host(ip) as ip, rules, blocks, servers, coalesce(evidence->'paths', '[]'::jsonb) as paths
    from traffic_ips where status = 'pending' order by score desc, last_seen desc limit ${limit}
  `;
  return rows.map((r) => ({
    ...r,
    rules: typeof r.rules === 'string' ? JSON.parse(r.rules) : r.rules,
    paths: typeof r.paths === 'string' ? JSON.parse(r.paths) : r.paths,
  }));
}

/**
 * Write the review job's decisions as riotcoder. Only still-pending rows move,
 * so a person's decision made meanwhile always wins. Returns rows changed.
 */
export async function applyReview(decisions, { db = sql } = {}) {
  const rows = (decisions ?? [])
    .filter((d) => d.decision === 'approve' || d.decision === 'reject')
    .map((d) => ({
      ip: d.ip,
      status: d.decision === 'approve' ? 'approved' : 'rejected',
      note: String(d.note ?? '').slice(0, 1000),
    }));
  if (!rows.length) return 0;
  const [{ id: reviewer } = {}] = await db`
    insert into users (email) values (${RIOTCODER_EMAIL})
    on conflict (email) do update set email = excluded.email returning id
  `;
  let changed = 0;
  for (let i = 0; i < rows.length; i += 1000) {
    const out = await db`
      update traffic_ips t set status = d.status, review_note = d.note, reviewed_by = ${reviewer},
        reviewed_at = now(), updated_at = now()
      from jsonb_to_recordset(${doc(rows.slice(i, i + 1000))}::text::jsonb) as d(ip text, status text, note text)
      where t.ip = d.ip::inet and t.status = 'pending'
      returning t.ip
    `;
    changed += out.length;
  }
  return changed;
}

export async function getSync(source, { db = sql } = {}) {
  const [row] = await db`select * from traffic_sync where source = ${source}`;
  return row ?? null;
}

export async function setSync(
  { source, count = null, added = null, error = null },
  { db = sql } = {},
) {
  await db`
    insert into traffic_sync (source, fetched_at, count, added, error)
    values (${source}, now(), ${count}, ${added}, ${error})
    on conflict (source) do update set
      fetched_at = now(), count = excluded.count, added = excluded.added, error = excluded.error
  `;
}
