import { sql } from './index.js';
import { memberOf, recordContribution } from './knowledge.js';

/**
 * The agent question loop.
 *
 * An agent asks, an operator answers, the answer becomes scored knowledge.
 * Everything here is the storage half; what an answer is worth is decided by
 * `@nichedb/knowledge` through `recordContribution`, the same as every other
 * contribution, so there is no second scoring path to keep in step.
 */

/* -------------------------------------------------------------- questions -- */

/**
 * Record a question from an agent.
 *
 * Idempotent on the agent's own id: a webhook delivered twice puts one
 * question in front of a person. The existing row comes back so the caller
 * can tell the difference between "stored" and "already had it".
 */
export async function createQuestion({
  externalId = null,
  nicheId,
  agentId = null,
  title,
  question,
  context = null,
  options = [],
  urgency = 'normal',
  relatedResourceIds = [],
}) {
  const clean = String(urgency ?? 'normal');
  const [row] = await sql`
    insert into agent_questions
      (external_id, niche_id, agent_id, title, question, context, options, urgency, related_resource_ids)
    values (${externalId}, ${Number(nicheId)}, ${agentId},
            ${String(title ?? '').slice(0, 300)},
            ${String(question ?? '').slice(0, 8000)},
            ${context === null ? null : String(context).slice(0, 20_000)},
            ${JSON.stringify(Array.isArray(options) ? options.slice(0, 12) : [])}::text::jsonb,
            ${['low', 'normal', 'high'].includes(clean) ? clean : 'normal'},
            ${JSON.stringify(Array.isArray(relatedResourceIds) ? relatedResourceIds : [])}::text::jsonb)
    on conflict (niche_id, external_id) where external_id is not null do nothing
    returning id, external_id, niche_id, agent_id, title, question, context,
              options, urgency, related_resource_ids, status, created_at, answered_at
  `;
  if (row) return { question: row, duplicate: false };
  if (!externalId) return { question: null, duplicate: false };
  const existing = await questionByExternalId({ nicheId, externalId });
  return { question: existing, duplicate: true };
}

export async function questionByExternalId({ nicheId, externalId }) {
  const [row] = await sql`
    select id, external_id, niche_id, agent_id, title, question, context,
           options, urgency, related_resource_ids, status, created_at, answered_at
    from agent_questions
    where niche_id = ${Number(nicheId)} and external_id = ${externalId}
  `;
  return row ?? null;
}

export async function getQuestion(id) {
  const [row] = await sql`
    select q.id, q.external_id, q.niche_id, q.agent_id, q.title, q.question, q.context,
           q.options, q.urgency, q.related_resource_ids, q.status, q.created_at, q.answered_at,
           n.slug as niche_slug, n.name as niche_name
    from agent_questions q
    join niches n on n.id = q.niche_id
    where q.id = ${Number(id)}
  `;
  return row ?? null;
}

/**
 * A niche's questions. Most urgent first, then oldest.
 *
 * `status` takes 'waiting' to mean everything still on a human: open, and
 * anything sent back for research. Those are one queue to the person looking
 * at it, and filtering on 'open' alone made a question they had just handed
 * back disappear from the page while still counting on their dashboard.
 */
export async function listQuestions({ nicheId, status = 'waiting', limit = 50 } = {}) {
  const waiting = status === 'waiting';
  return sql`
    select q.id, q.external_id, q.niche_id, q.agent_id, q.title, q.question, q.context,
           q.options, q.urgency, q.related_resource_ids, q.status, q.created_at, q.answered_at,
           n.slug as niche_slug, n.name as niche_name,
           (select count(*)::int from agent_answers a where a.question_id = q.id) as answer_count
    from agent_questions q
    join niches n on n.id = q.niche_id
    where q.niche_id = ${Number(nicheId)}
      and (${waiting} or ${status}::text is null or q.status = ${status})
      and (not ${waiting} or q.status in ('open', 'researching'))
    order by
      case q.urgency when 'high' then 0 when 'normal' then 1 else 2 end,
      q.created_at
    limit ${Math.min(Number(limit) || 50, 200)}
  `;
}

/**
 * Everything waiting on one person, across every niche they operate.
 *
 * This is the dashboard's "your agent needs you" list. A question this person
 * has already answered is not waiting on them, which is what the `not exists`
 * is for: in a niche with two operators, each sees only what they have not
 * dealt with.
 */
export async function questionsAwaiting(userId, { limit = 25 } = {}) {
  return sql`
    select q.id, q.external_id, q.niche_id, q.agent_id, q.title, q.question, q.context,
           q.options, q.urgency, q.related_resource_ids, q.status, q.created_at, q.answered_at,
           n.slug as niche_slug, n.name as niche_name
    from agent_questions q
    join niches n on n.id = q.niche_id
    join niche_members m on m.niche_id = q.niche_id and m.user_id = ${userId}::uuid
    where q.status in ('open', 'researching')
      and m.status = 'active'
      and m.role in ('operator', 'specialist')
      and not exists (
        select 1 from agent_answers a
        where a.question_id = q.id and a.influencer_id = ${userId}::uuid
      )
    order by
      case q.urgency when 'high' then 0 when 'normal' then 1 else 2 end,
      q.created_at
    limit ${Math.min(Number(limit) || 25, 100)}
  `;
}

/** How many questions each of a person's niches is waiting on. */
export async function openQuestionCounts(userId) {
  const rows = await sql`
    select q.niche_id, count(*)::int as n
    from agent_questions q
    join niche_members m on m.niche_id = q.niche_id and m.user_id = ${userId}::uuid
    where q.status in ('open', 'researching') and m.status = 'active'
      and not exists (
        select 1 from agent_answers a
        where a.question_id = q.id and a.influencer_id = ${userId}::uuid
      )
    group by q.niche_id
  `;
  return Object.fromEntries(rows.map((r) => [String(r.niche_id), Number(r.n)]));
}

/* ---------------------------------------------------------------- answers -- */

/**
 * Answer a question.
 *
 * A real answer becomes an `agent_answer` contribution, scored by the same
 * engine as everything else, and closes the question. A decline records that
 * the person looked and could not help: no points, no penalty, and the
 * question stays open for somebody who can.
 *
 * The answer row is written first, and its unique constraint is what settles a
 * race: two operators submitting at the same instant, or one double-clicking,
 * and exactly one row is created. Only the request that created it goes on to
 * score, so nobody is paid twice for one question. The contribution's own
 * dedupe key is the second guard under that, keyed on the question id.
 */
export async function answerQuestion({
  questionId,
  influencerId,
  kind = 'answered',
  optionId = null,
  body = null,
}) {
  const question = await getQuestion(questionId);
  if (!question) return { ok: false, reason: 'no such question' };
  if (question.status === 'answered' || question.status === 'dismissed')
    return { ok: false, reason: 'that question is already settled' };

  const member = await memberOf({ nicheId: question.niche_id, userId: influencerId });
  if (member?.status !== 'active' || member.role === 'observer')
    return { ok: false, reason: 'you do not operate this niche' };

  const shape = ['answered', 'insufficient_context', 'needs_research'].includes(kind)
    ? kind
    : 'answered';
  const text = body === null ? null : String(body).slice(0, 8000);
  if (shape === 'answered' && !text && !optionId)
    return { ok: false, reason: 'an answer needs either a choice or some words' };

  // The row goes in first and the unique constraint decides the race. A second
  // submission finds nothing to insert and stops here, before it can score.
  const [answer] = await sql`
    insert into agent_answers (question_id, influencer_id, kind, option_id, body)
    values (${Number(questionId)}, ${influencerId}::uuid, ${shape}, ${optionId}, ${text})
    on conflict (question_id, influencer_id) do nothing
    returning *
  `;
  if (!answer) return { ok: false, reason: 'you have already answered this one' };

  let scored = null;
  if (shape === 'answered') {
    // The evidence names the question it settles, which is what makes the
    // dedupe key stable: answering question 41 twice is one contribution.
    scored = await recordContribution({
      nicheId: question.niche_id,
      influencerId,
      type: 'agent_answer',
      evidence: {
        questionId: `agent-question:${question.id}`,
        title: question.title,
        answer: text ?? `option:${optionId}`,
        agentId: question.agent_id,
      },
      sourceType: 'agent_question',
      sourceId: String(question.id),
    });
    if (scored?.event?.id) {
      await sql`
        update agent_answers set contribution_event_id = ${scored.event.id}
        where id = ${answer.id}
      `;
      answer.contribution_event_id = scored.event.id;
    }
  }

  // A real answer settles the question. A request for more research hands it
  // back to the agent. "Not enough context" leaves it open for someone else.
  const status =
    shape === 'answered'
      ? 'answered'
      : shape === 'needs_research'
        ? 'researching'
        : question.status;
  await sql`
    update agent_questions
    set status = ${status},
        answered_at = ${shape === 'answered' ? new Date() : null}
    where id = ${Number(questionId)}
  `;

  return {
    ok: true,
    answer,
    question: await getQuestion(questionId),
    points: scored?.points ?? 0,
    contributionStatus: scored?.status ?? null,
  };
}

export async function listAnswers(questionId) {
  return sql`
    select a.*, u.handle::text as handle, u.display_name
    from agent_answers a
    join users u on u.id = a.influencer_id
    where a.question_id = ${Number(questionId)}
    order by a.created_at
  `;
}

/** An operator or admin saying a question is not worth anybody's time. */
export async function dismissQuestion({ questionId, influencerId }) {
  const question = await getQuestion(questionId);
  if (!question) return null;
  const member = await memberOf({ nicheId: question.niche_id, userId: influencerId });
  if (member?.status !== 'active' || member.role === 'observer') return null;
  const [row] = await sql`
    update agent_questions set status = 'dismissed'
    where id = ${Number(questionId)} and status in ('open', 'researching')
    returning id
  `;
  return row ?? null;
}
