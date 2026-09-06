import * as a from '@nichedb/db/agents';
import * as k from '@nichedb/db/knowledge';
import { chovyConfigured, notifyChovy, verifyInternalRequest } from '../lib/chovy.js';
import { render, requireUser, respond } from '../lib/http.js';
import { isAdmin } from '../lib/service.js';
import { NicheQuestions } from '../views/knowledge.jsx';

/**
 * The agent question loop.
 *
 * An agent gets stuck on something only a person who has done the job can
 * settle, and asks. The operator answers in about two minutes, the answer
 * becomes scored knowledge, and Chovy is told.
 *
 * The internal route is signed. Everything else here is an ordinary
 * authenticated page or endpoint, because answering is a thing a person does.
 */
export function registerAgents(app) {
  /* -------------------------------------------------------------- internal -- */

  /**
   * An agent asking for judgement.
   *
   * Signed with CHOVY_SIGNING_SECRET, because this creates work that pays: an
   * unsigned endpoint here is a way to mint scored contributions.
   */
  app.post('/api/v1/internal/expert-questions', async (c) => {
    const auth = await verifyInternalRequest(c);
    if (!auth.ok) return c.json({ error: auth.reason }, auth.status);

    const payload = auth.body?.payload ?? auth.body ?? {};
    const slug = payload.nicheSlug ?? payload.niche ?? null;
    const niche = slug ? await k.getNiche(slug) : await k.getNicheById(payload.nicheId);
    if (!niche) return c.json({ error: 'no such niche' }, 404);
    if (!payload.title || !payload.question)
      return c.json({ error: 'a question needs a title and a question' }, 400);

    const { question, duplicate } = await a.createQuestion({
      // Chovy's own id if it sent one, else the envelope's, so a redelivery of
      // either shape books once.
      externalId: payload.externalId ?? auth.body?.id ?? null,
      nicheId: niche.id,
      agentId: payload.agentId ?? niche.primary_agent_id ?? null,
      title: payload.title,
      question: payload.question,
      context: payload.context ?? null,
      options: payload.options ?? [],
      urgency: payload.urgency ?? 'normal',
      relatedResourceIds: payload.relatedResourceIds ?? [],
    });

    return c.json(
      {
        stored: Boolean(question),
        duplicate,
        question: question ? { id: String(question.id), status: question.status } : null,
      },
      duplicate ? 200 : 201,
    );
  });

  /* ------------------------------------------------------------- operators -- */

  app.get('/api/v1/niches/:slug/questions', async (c) => {
    const niche = await k.getNiche(c.req.param('slug'));
    if (!niche) return c.json({ error: 'not found' }, 404);
    const user = requireUser(c);
    const member = await k.memberOf({ nicheId: niche.id, userId: user.id });
    // A question carries the agent's raw research, which is not public.
    if (member?.status !== 'active' && !isAdmin(user))
      return c.json({ error: 'you do not operate this niche' }, 403);
    return c.json({
      questions: await a.listQuestions({
        nicheId: niche.id,
        status: c.req.query('status') ?? 'waiting',
      }),
    });
  });

  app.post('/api/v1/niches/:slug/questions/:id/answer', async (c) => {
    const user = requireUser(c);
    const niche = await k.getNiche(c.req.param('slug'));
    if (!niche) return c.json({ error: 'not found' }, 404);
    const body = await c.req.json().catch(() => ({}));
    return answer(c, {
      user,
      questionId: c.req.param('id'),
      kind: body.kind,
      optionId: body.optionId,
      body: body.answer ?? body.body,
    });
  });

  /* ------------------------------------------------------------- dashboard -- */

  app.get('/dashboard/niches/:slug/questions', async (c) => {
    const user = requireUser(c);
    const niche = await k.getNiche(c.req.param('slug'));
    if (!niche) return c.notFound();
    const member = await k.memberOf({ nicheId: niche.id, userId: user.id });
    if (member?.status !== 'active' && !isAdmin(user)) return c.notFound();

    const [open, settled] = await Promise.all([
      a.listQuestions({ nicheId: niche.id, status: 'waiting' }),
      a.listQuestions({ nicheId: niche.id, status: 'answered', limit: 20 }),
    ]);
    return c.html(
      await render(
        <NicheQuestions
          user={user}
          niche={niche}
          questions={open}
          settled={settled}
          configured={chovyConfigured()}
          notice={c.req.query('notice')}
          error={c.req.query('error')}
        />,
      ),
    );
  });

  /** The form on the dashboard posts here. */
  app.post('/dashboard/questions/:id/answer', async (c) => {
    const user = requireUser(c);
    const form = await c.req.parseBody();
    return answer(c, {
      user,
      questionId: c.req.param('id'),
      kind: form.kind,
      optionId: form.optionId || null,
      body: form.answer || null,
      redirectTo: form.next ? String(form.next) : '/dashboard/niches',
    });
  });

  app.post('/dashboard/questions/:id/dismiss', async (c) => {
    const user = requireUser(c);
    const done = await a.dismissQuestion({ questionId: c.req.param('id'), influencerId: user.id });
    return respond(c, {
      json: { dismissed: Boolean(done) },
      redirectTo: '/dashboard/niches',
      notice: done ? 'Dismissed.' : null,
      error: done ? null : 'That question is not yours to dismiss.',
    });
  });

  /**
   * One place where an answer is recorded, whichever surface it came from.
   *
   * Chovy is told after the write, never before, and a delivery that fails
   * does not fail the answer: the contribution is already banked.
   */
  async function answer(c, { user, questionId, kind, optionId, body, redirectTo }) {
    const out = await a.answerQuestion({
      questionId,
      influencerId: user.id,
      kind: kind ? String(kind) : 'answered',
      optionId: optionId ? String(optionId) : null,
      body: body ?? null,
    });
    if (!out.ok)
      return respond(c, {
        json: { error: out.reason },
        status: 400,
        redirectTo,
        error: out.reason,
      });

    if (out.answer.kind === 'answered') {
      await notifyChovy('expert_answer.created', {
        nicheId: out.question.niche_id,
        userId: user.id,
        payload: {
          questionId: String(out.question.id),
          externalId: out.question.external_id,
          answer: out.answer.body,
          optionId: out.answer.option_id,
          answeredBy: user.handle ?? null,
        },
      });
    } else if (out.answer.kind === 'needs_research') {
      await notifyChovy('agent.research_requested', {
        nicheId: out.question.niche_id,
        userId: user.id,
        payload: {
          questionId: String(out.question.id),
          externalId: out.question.external_id,
          note: out.answer.body,
        },
      });
    }

    const said =
      out.answer.kind === 'answered'
        ? out.contributionStatus === 'verified'
          ? `Thanks. That is ${out.points} points.`
          : 'Thanks. It goes to review before it counts.'
        : out.answer.kind === 'needs_research'
          ? 'Sent back to the agent for more research.'
          : 'Noted. It stays open for someone else.';

    return respond(c, {
      json: { ok: true, points: out.points, status: out.contributionStatus },
      redirectTo,
      notice: said,
    });
  }
}
