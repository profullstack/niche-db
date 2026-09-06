import {
  DIMINISH_WINDOW_DAYS,
  isReservedNicheSlug,
  MAX_SHARE_BPS,
  scoreContribution,
  shareBpsFor,
  tierFor,
} from '@nichedb/knowledge';
import { sql } from './index.js';

/**
 * Every query the Knowledge Influencer program runs. Kept out of queries.js
 * because that file is already the whole of the ingest side; routes import
 * from here and still write no SQL of their own.
 *
 * The scoring itself is not here. `@nichedb/knowledge` decides what a
 * contribution is worth with no database in the room, and this module is what
 * feeds it the counts it needs and stores what it decides.
 */

/* ------------------------------------------------------------------ tiers -- */

/**
 * The ladder as this deployment has it, from the table rather than the
 * constant, so a tuned threshold is the one people are actually paid on.
 * Falls back to the shipped default only if the table is somehow empty.
 */
export async function listTiers() {
  const rows = await sql`
    select slug, name, min_score, share_bps, position
    from contribution_tiers order by position
  `;
  return rows.map((r) => ({
    slug: r.slug,
    name: r.name,
    minScore: Number(r.min_score),
    shareBps: Number(r.share_bps),
  }));
}

/* ----------------------------------------------------------------- niches -- */

export async function getNiche(slug) {
  const [row] = await sql`
    select n.id, n.slug, n.name, n.description, n.status, n.collection_id,
           n.opportunity_score, n.primary_agent_id, n.created_at, n.updated_at,
           c.slug as collection_slug, c.name as collection_name
    from niches n
    left join collections c on c.id = n.collection_id
    where n.slug = ${String(slug ?? '').toLowerCase()}
  `;
  return row ?? null;
}

export async function getNicheById(id) {
  const [row] = await sql`
    select id, slug, name, description, status, collection_id, opportunity_score,
           primary_agent_id, created_at, updated_at
    from niches where id = ${Number(id)}
  `;
  return row ?? null;
}

/** Public niches, newest activity first. Drafts and archives are not listed. */
export async function listNiches({ limit = 100 } = {}) {
  return sql`
    select n.id, n.slug, n.name, n.description, n.status, n.collection_id,
           n.opportunity_score, n.primary_agent_id, n.created_at, n.updated_at,
           (select count(*)::int from niche_members m
             where m.niche_id = n.id and m.status = 'active') as member_count
    from niches n
    where n.status in ('open', 'operated')
    order by n.status = 'operated' desc, n.opportunity_score desc nulls last, n.name
    limit ${Math.min(Number(limit) || 100, 500)}
  `;
}

/**
 * A niche's page is served from the site root, so a slug that names an
 * existing route would shadow it. Refused here rather than discovered later.
 */
export async function createNiche({
  slug,
  name,
  description = null,
  status = 'open',
  collectionId = null,
  ownerId = null,
}) {
  const clean = String(slug ?? '')
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(clean)) throw new Error('That slug is not url-safe.');
  if (isReservedNicheSlug(clean)) throw new Error('That name is already a page on this site.');
  const [row] = await sql`
    insert into niches ${sql({
      slug: clean,
      name: String(name ?? clean),
      description,
      status,
      collection_id: collectionId,
    })}
    on conflict (slug) do nothing
    returning id, slug, name, description, status, collection_id, opportunity_score,
              primary_agent_id, created_at, updated_at
  `;
  if (row && ownerId) {
    await audit({
      actorId: ownerId,
      action: 'niche.created',
      subjectType: 'niche',
      subjectId: String(row.id),
      nicheId: row.id,
      detail: { slug: clean },
    });
  }
  return row ?? null;
}

/* ---------------------------------------------------------------- members -- */

/**
 * Who operates a niche, with the score and share each currently holds. This
 * is what the public page names and what an allocation would divide between.
 */
export async function nicheMembers(nicheId, { status = 'active' } = {}) {
  return sql`
    select m.id, m.niche_id, m.user_id, m.role, m.status, m.share_cap_bps, m.joined_at,
           u.handle::text as handle, u.display_name,
           coalesce(s.score, 0) as score,
           coalesce(s.tier_slug, 'contributor') as tier_slug,
           coalesce(s.share_bps, 2000) as share_bps,
           coalesce(s.verified_count, 0) as verified_count
    from niche_members m
    join users u on u.id = m.user_id
    left join contribution_scores s
      on s.niche_id = m.niche_id and s.influencer_id = m.user_id
    where m.niche_id = ${Number(nicheId)}
      and (${status}::text is null or m.status = ${status})
    order by coalesce(s.score, 0) desc, m.joined_at
  `;
}

/** The niches one person operates, for their dashboard and their profile. */
export async function nichesForUser(userId) {
  return sql`
    select n.id, n.slug, n.name, n.status, m.role, m.status as member_status, m.share_cap_bps,
           coalesce(s.score, 0) as score,
           coalesce(s.tier_slug, 'contributor') as tier_slug,
           coalesce(s.share_bps, 2000) as share_bps,
           coalesce(s.verified_count, 0) as verified_count,
           coalesce(s.pending_count, 0) as pending_count
    from niche_members m
    join niches n on n.id = m.niche_id
    left join contribution_scores s
      on s.niche_id = m.niche_id and s.influencer_id = m.user_id
    where m.user_id = ${userId}::uuid and m.status in ('active', 'pending')
    order by coalesce(s.score, 0) desc, n.name
  `;
}

export async function memberOf({ nicheId, userId }) {
  if (!userId) return null;
  const [row] = await sql`
    select * from niche_members
    where niche_id = ${Number(nicheId)} and user_id = ${userId}::uuid
  `;
  return row ?? null;
}

/**
 * Add someone to a niche. Everyone lands on the first rung: the tier is a
 * consequence of verified contribution and never a thing granted at signup.
 */
export async function addMember({ nicheId, userId, role = 'operator', capBps = MAX_SHARE_BPS }) {
  const [row] = await sql`
    insert into niche_members ${sql({
      niche_id: Number(nicheId),
      user_id: userId,
      role,
      status: 'active',
      share_cap_bps: Math.min(Number(capBps) || MAX_SHARE_BPS, MAX_SHARE_BPS),
    })}
    on conflict (niche_id, user_id) do update
      set status = 'active', role = excluded.role, updated_at = now()
    returning *
  `;
  await ensureScoreRow({ nicheId, userId });
  await sql`
    update niches set status = 'operated', updated_at = now()
    where id = ${Number(nicheId)} and status = 'open'
  `;
  return row;
}

/* ---------------------------------------------------------- opportunities -- */

export async function listOpportunities({ limit = 60 } = {}) {
  return sql`
    select o.id, o.niche_id, o.score, o.dimensions, o.rationale, o.status,
           n.slug, n.name, n.description,
           (select count(*)::int from niche_members m
             where m.niche_id = n.id and m.status = 'active') as member_count
    from opportunities o
    join niches n on n.id = o.niche_id
    where o.status = 'open' and n.status in ('open', 'operated')
    order by o.score desc nulls last, n.name
    limit ${Math.min(Number(limit) || 60, 200)}
  `;
}

export async function getOpportunity(slug) {
  const [row] = await sql`
    select o.id, o.niche_id, o.score, o.dimensions, o.rationale, o.status,
           n.slug, n.name, n.description, n.status as niche_status
    from opportunities o
    join niches n on n.id = o.niche_id
    where n.slug = ${String(slug ?? '').toLowerCase()}
  `;
  return row ?? null;
}

export async function upsertOpportunity({ nicheId, score, dimensions = {}, rationale = null }) {
  const [row] = await sql`
    insert into opportunities (niche_id, score, dimensions, rationale)
    values (${Number(nicheId)}, ${score ?? null}, ${JSON.stringify(dimensions)}::jsonb, ${rationale})
    on conflict (niche_id) do update
      set score = excluded.score, dimensions = excluded.dimensions,
          rationale = excluded.rationale, updated_at = now()
    returning *
  `;
  await sql`
    update niches set opportunity_score = ${score ?? null}, updated_at = now()
    where id = ${Number(nicheId)}
  `;
  return row;
}

/* ---------------------------------------------------------------- claims -- */

export async function createClaim({ nicheId, userId, answers = {} }) {
  const [row] = await sql`
    insert into niche_claims (niche_id, user_id, answers)
    values (${Number(nicheId)}, ${userId}::uuid, ${JSON.stringify(answers)}::jsonb)
    on conflict (niche_id, user_id) where status = 'pending' do nothing
    returning *
  `;
  return row ?? null;
}

export async function getClaim(id) {
  const [row] = await sql`
    select c.*, n.slug as niche_slug, n.name as niche_name,
           u.handle::text as handle, u.display_name, u.email::text as email
    from niche_claims c
    join niches n on n.id = c.niche_id
    join users u on u.id = c.user_id
    where c.id = ${Number(id)}
  `;
  return row ?? null;
}

export async function listClaims({ status = 'pending', userId = null, limit = 100 } = {}) {
  return sql`
    select c.id, c.niche_id, c.user_id, c.status, c.created_at, c.decided_at, c.decision_note,
           n.slug as niche_slug, n.name as niche_name,
           u.handle::text as handle, u.display_name, u.email::text as email
    from niche_claims c
    join niches n on n.id = c.niche_id
    join users u on u.id = c.user_id
    where (${status}::text is null or c.status = ${status})
      and (${userId}::uuid is null or c.user_id = ${userId}::uuid)
    order by c.created_at desc
    limit ${Math.min(Number(limit) || 100, 500)}
  `;
}

/**
 * Approving a claim is what makes someone an operator, and it is one
 * transaction: a membership without the decision that created it is a person
 * earning a share nobody can point at a reason for.
 */
export async function decideClaim({ claimId, approve, actorId, note = null }) {
  const claim = await getClaim(claimId);
  if (claim?.status !== 'pending') return null;

  await sql.begin(async (tx) => {
    await tx`
      update niche_claims
      set status = ${approve ? 'approved' : 'rejected'},
          decided_at = now(), decided_by = ${actorId}::uuid, decision_note = ${note}
      where id = ${Number(claimId)}
    `;
    if (approve) {
      await tx`
        insert into niche_members (niche_id, user_id, role, status)
        values (${claim.niche_id}, ${claim.user_id}::uuid, 'operator', 'active')
        on conflict (niche_id, user_id) do update set status = 'active', updated_at = now()
      `;
      await tx`
        insert into contribution_scores (niche_id, influencer_id, tier_slug, share_bps)
        values (${claim.niche_id}, ${claim.user_id}::uuid, 'contributor', 2000)
        on conflict (niche_id, influencer_id) do nothing
      `;
      await tx`
        insert into tier_history (niche_id, influencer_id, tier_slug, score, share_bps, reason)
        values (${claim.niche_id}, ${claim.user_id}::uuid, 'contributor', 0, 2000, 'claim approved')
      `;
      await tx`
        update niches set status = 'operated', updated_at = now()
        where id = ${claim.niche_id} and status = 'open'
      `;
      await tx`update opportunities set status = 'claimed', updated_at = now() where niche_id = ${claim.niche_id}`;
    }
  });

  await audit({
    actorId,
    action: approve ? 'claim.approved' : 'claim.rejected',
    subjectType: 'niche_claim',
    subjectId: String(claimId),
    nicheId: claim.niche_id,
    detail: { note, userId: claim.user_id },
  });
  return getClaim(claimId);
}

/* --------------------------------------------------- contribution events -- */

async function ensureScoreRow({ nicheId, userId }) {
  await sql`
    insert into contribution_scores (niche_id, influencer_id, tier_slug, share_bps)
    values (${Number(nicheId)}, ${userId}::uuid, 'contributor', 2000)
    on conflict (niche_id, influencer_id) do nothing
  `;
}

/**
 * How many of this type this person has had verified lately, which is what
 * the diminishing return is computed from. Verified only: a queue full of
 * pending submissions must not be able to talk the score down or up.
 */
async function recentOfType({ nicheId, influencerId, type }) {
  const [row] = await sql`
    select count(*)::int as n from contribution_events
    where niche_id = ${Number(nicheId)} and influencer_id = ${influencerId}::uuid
      and event_type = ${type} and status = 'verified'
      and created_at > now() - ${`${DIMINISH_WINDOW_DAYS} days`}::interval
  `;
  return row?.n ?? 0;
}

/**
 * Record a contribution.
 *
 * The engine decides the points and whether it counts yet; this stores that
 * decision and, when the event counted immediately, moves the score. A
 * duplicate returns the row that already exists rather than a second one:
 * the unique index is what enforces it, so two requests racing still book once.
 */
export async function recordContribution({
  nicheId,
  influencerId,
  type,
  points,
  evidence = {},
  sourceType = null,
  sourceId = null,
}) {
  await ensureScoreRow({ nicheId, userId: influencerId });

  const [counts] = await sql`
    select coalesce(verified_count, 0) as verified from contribution_scores
    where niche_id = ${Number(nicheId)} and influencer_id = ${influencerId}::uuid
  `;
  const scored = scoreContribution(
    { nicheId, influencerId, type, points, evidence },
    {
      verifiedCount: Number(counts?.verified ?? 0),
      recentOfType: await recentOfType({ nicheId, influencerId, type }),
    },
  );
  if (scored.status === 'rejected') return { event: null, ...scored };

  const [row] = await sql`
    insert into contribution_events
      (niche_id, influencer_id, event_type, points, status, source_type, source_id, evidence, dedupe_key, verified_at)
    values (${Number(nicheId)}, ${influencerId}::uuid, ${type}, ${scored.points}, ${scored.status},
            ${sourceType}, ${sourceId}, ${JSON.stringify(evidence)}::jsonb, ${scored.dedupeKey},
            ${scored.status === 'verified' ? new Date() : null})
    on conflict (niche_id, influencer_id, dedupe_key) where dedupe_key is not null do nothing
    returning *
  `;
  if (!row) return { event: null, duplicate: true, points: 0, status: 'rejected', ...scored };

  if (row.status === 'verified') await refreshScore({ nicheId, influencerId });
  return { event: row, ...scored, duplicate: false };
}

export async function listContributions({
  nicheId = null,
  influencerId = null,
  status = null,
  limit = 100,
} = {}) {
  return sql`
    select e.id, e.niche_id, e.influencer_id, e.event_type, e.points, e.status,
           e.evidence, e.created_at, e.verified_at, e.reverses_id,
           n.slug as niche_slug, n.name as niche_name,
           u.handle::text as handle, u.display_name
    from contribution_events e
    join niches n on n.id = e.niche_id
    join users u on u.id = e.influencer_id
    where (${nicheId}::bigint is null or e.niche_id = ${nicheId}::bigint)
      and (${influencerId}::uuid is null or e.influencer_id = ${influencerId}::uuid)
      and (${status}::text is null or e.status = ${status})
    order by e.created_at desc
    limit ${Math.min(Number(limit) || 100, 500)}
  `;
}

export async function getContribution(id) {
  const [row] = await sql`select * from contribution_events where id = ${Number(id)}`;
  return row ?? null;
}

/**
 * An admin's decision on a held event. Verifying is what moves a score, so it
 * is also what can move a tier, and both leave a record.
 */
export async function verifyContribution({ id, actorId, approve = true, note = null }) {
  const event = await getContribution(id);
  if (event?.status !== 'pending') return null;

  const [row] = await sql`
    update contribution_events
    set status = ${approve ? 'verified' : 'rejected'},
        verified_at = now(), verified_by = ${actorId}::uuid
    where id = ${Number(id)} and status = 'pending'
    returning *
  `;
  if (!row) return null;

  // Recomputed either way: a rejection changes the pending count the
  // dashboard shows, even though it moves no score.
  const promotion = await refreshScore({
    nicheId: row.niche_id,
    influencerId: row.influencer_id,
  });

  await audit({
    actorId,
    action: approve ? 'contribution.verified' : 'contribution.rejected',
    subjectType: 'contribution_event',
    subjectId: String(id),
    nicheId: row.niche_id,
    detail: { points: row.points, type: row.event_type, note },
  });
  return { event: row, ...promotion };
}

/**
 * Take back an event that should not have counted.
 *
 * The row is marked reversed rather than deleted, and it keeps its points, so
 * the history still shows what was believed and when. Only the sum stops
 * counting it — one place, because a status that excludes a row AND a
 * compensating negative row would subtract the same points twice and take
 * honest work down with the fraud.
 *
 * Who reversed it and why is in the audit log, which is where a dispute is
 * actually answered from.
 */
export async function reverseContribution({ id, actorId, reason }) {
  const event = await getContribution(id);
  if (event?.status !== 'verified') return null;

  await sql`
    update contribution_events set status = 'reversed'
    where id = ${Number(id)} and status = 'verified'
  `;

  const promotion = await refreshScore({
    nicheId: event.niche_id,
    influencerId: event.influencer_id,
  });
  await audit({
    actorId,
    action: 'contribution.reversed',
    subjectType: 'contribution_event',
    subjectId: String(id),
    nicheId: event.niche_id,
    detail: { reason, points: event.points },
  });
  return promotion;
}

/**
 * Recompute one person's score in one niche from the events, and move their
 * tier if it changed.
 *
 * Summed rather than incremented: an increment that runs twice is a tier
 * nobody earned, and the events are the record anyway. A reversal's negative
 * row is in the same sum, which is why a score can go down without anything
 * being deleted.
 */
export async function refreshScore({ nicheId, influencerId }) {
  const tiers = await listTiers();
  const [totals] = await sql`
    select coalesce(sum(points) filter (where status = 'verified'), 0)::int as score,
           count(*) filter (where status = 'verified')::int as verified_count,
           count(*) filter (where status = 'pending')::int as pending_count
    from contribution_events
    where niche_id = ${Number(nicheId)} and influencer_id = ${influencerId}::uuid
  `;
  const score = Math.max(0, Number(totals?.score ?? 0));
  const member = await memberOf({ nicheId, userId: influencerId });
  const capBps = Number(member?.share_cap_bps ?? MAX_SHARE_BPS);
  const tier = tierFor(score, tiers);
  const shareBps = shareBpsFor(score, { capBps, tiers });

  const [previous] = await sql`
    select tier_slug, share_bps from contribution_scores
    where niche_id = ${Number(nicheId)} and influencer_id = ${influencerId}::uuid
  `;

  await sql`
    insert into contribution_scores
      (niche_id, influencer_id, score, verified_count, pending_count, tier_slug, share_bps, updated_at)
    values (${Number(nicheId)}, ${influencerId}::uuid, ${score},
            ${Number(totals?.verified_count ?? 0)}, ${Number(totals?.pending_count ?? 0)},
            ${tier.slug}, ${shareBps}, now())
    on conflict (niche_id, influencer_id) do update
      set score = excluded.score, verified_count = excluded.verified_count,
          pending_count = excluded.pending_count, tier_slug = excluded.tier_slug,
          share_bps = excluded.share_bps, updated_at = now()
  `;

  const changed = previous?.tier_slug !== tier.slug || Number(previous?.share_bps) !== shareBps;
  if (changed) {
    // Append-only, and never backdated: an allocation settled under the old
    // share stays settled under it.
    await sql`
      insert into tier_history (niche_id, influencer_id, tier_slug, score, share_bps, reason)
      values (${Number(nicheId)}, ${influencerId}::uuid, ${tier.slug}, ${score}, ${shareBps},
              ${previous ? 'score changed' : 'first tier'})
    `;
  }
  return {
    score,
    tier,
    shareBps,
    changed,
    previousTier: previous?.tier_slug ?? null,
    previousShareBps: previous ? Number(previous.share_bps) : null,
  };
}

export async function tierHistory({ nicheId, influencerId, limit = 50 }) {
  return sql`
    select tier_slug, score, share_bps, effective_at, reason
    from tier_history
    where niche_id = ${Number(nicheId)} and influencer_id = ${influencerId}::uuid
    order by effective_at desc
    limit ${Math.min(Number(limit) || 50, 200)}
  `;
}

/* --------------------------------------------------------------- profiles -- */

/** A public profile: who they are and what they have verifiably done. */
export async function influencerByHandle(handle) {
  const [row] = await sql`
    select id, handle::text as handle, display_name, created_at
    from users where handle = ${String(handle ?? '')}
  `;
  if (!row) return null;
  const niches = await sql`
    select n.slug, n.name, m.role, m.joined_at,
           coalesce(s.score, 0) as score,
           coalesce(s.tier_slug, 'contributor') as tier_slug,
           coalesce(s.share_bps, 2000) as share_bps,
           coalesce(s.verified_count, 0) as verified_count
    from niche_members m
    join niches n on n.id = m.niche_id
    left join contribution_scores s
      on s.niche_id = m.niche_id and s.influencer_id = m.user_id
    where m.user_id = ${row.id}::uuid and m.status = 'active' and n.status in ('open', 'operated')
    order by coalesce(s.score, 0) desc
  `;
  const [totals] = await sql`
    select count(*) filter (where status = 'verified')::int as verified,
           count(*) filter (where status = 'verified'
             and event_type in ('knowledge_corrected', 'record_corrected'))::int as corrections
    from contribution_events where influencer_id = ${row.id}::uuid
  `;
  return { ...row, niches, totals: totals ?? { verified: 0, corrections: 0 } };
}

/* ---------------------------------------------------------------- audit -- */

/** Every admin decision, in the order it happened. Never updated, never deleted. */
export async function audit({
  actorId = null,
  action,
  subjectType,
  subjectId = null,
  nicheId = null,
  detail = {},
}) {
  await sql`
    insert into knowledge_audit_logs (actor_id, action, subject_type, subject_id, niche_id, detail)
    values (${actorId}::uuid, ${action}, ${subjectType}, ${subjectId}, ${nicheId},
            ${JSON.stringify(detail)}::jsonb)
  `;
}

export async function listAudit({ limit = 100 } = {}) {
  return sql`
    select a.*, u.handle::text as actor_handle, u.email::text as actor_email
    from knowledge_audit_logs a
    left join users u on u.id = a.actor_id
    order by a.created_at desc
    limit ${Math.min(Number(limit) || 100, 500)}
  `;
}
