import * as q from '@nichedb/db/queries';
import * as subs from '@nichedb/db/submissions';
import { render, requireUser, respond } from '../lib/http.js';
import { Denied, isAdmin } from '../lib/service.js';
import {
  approveSubmission,
  rejectSubmission,
  submissionOut,
  submitFeed,
} from '../lib/submissions.js';
import { SubmissionsAdmin, SubmitPage } from '../views/submit.jsx';

/**
 * Suggesting a feed from anywhere on the site, and the queue it lands in.
 *
 * The form is open to everyone, signed in or not: the point of a directory is
 * that people tell it things. What it is not open to is making the deployment
 * fetch -- that waits for an admin at /admin/submissions. Registered before
 * the niche routes because `/submit` is a literal path that must win over
 * `/:slug`.
 */

const requireAdmin = (c) => {
  const user = requireUser(c);
  if (!isAdmin(user)) throw new Denied('Admins only.', 403);
  return user;
};

async function handleSubmit(c, body) {
  // The honeypot. A person never sees the field; a form-filler fills it.
  if (body.website)
    return respond(c, { json: { ok: true }, redirectTo: '/submit', notice: 'Thanks.' });
  const user = c.get('user');
  const { submission, duplicate } = await submitFeed({
    user,
    url: body.url,
    collection: body.collection || null,
    note: body.note || null,
    email: body.email || null,
  });
  return respond(c, {
    json: { submission: submissionOut(submission), duplicate },
    status: duplicate ? 200 : 201,
    redirectTo: '/submit',
    notice: duplicate
      ? 'That feed is already suggested and waiting for review.'
      : 'Thanks. An admin will look at it; approved feeds appear on their collection page.',
  });
}

export function registerSubmit(app) {
  app.get('/submit', async (c) => {
    return c.html(
      await render(
        <SubmitPage
          user={c.get('user')}
          collections={await q.listCollections()}
          collection={c.req.query('collection') ?? null}
          values={{ url: c.req.query('url') ?? '' }}
          notice={c.req.query('notice')}
          error={c.req.query('error')}
        />,
      ),
    );
  });

  app.post('/submit', async (c) => {
    const body = await c.req.parseBody();
    try {
      return await handleSubmit(c, body);
    } catch (err) {
      if (!(err instanceof Denied)) throw err;
      return c.html(
        await render(
          <SubmitPage
            user={c.get('user')}
            collections={await q.listCollections()}
            collection={body.collection || null}
            values={body}
            error={err.message}
          />,
        ),
        err.status === 429 ? 429 : 400,
      );
    }
  });

  /* ------------------------------------------------------------------ api -- */

  app.post('/api/v1/submissions', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return handleSubmit(c, body);
  });

  app.get('/api/v1/submissions', async (c) => {
    requireAdmin(c);
    const status = c.req.query('status') ?? 'pending';
    const rows = await subs.listSubmissions({
      status: status === 'all' ? null : status,
      limit: c.req.query('limit'),
    });
    return c.json({ submissions: rows.map(submissionOut) });
  });

  app.post('/api/v1/submissions/:id', async (c) => {
    const admin = requireAdmin(c);
    const body = await c.req.json().catch(() => ({}));
    if (body.decision === 'reject') {
      const s = await rejectSubmission(admin, c.req.param('id'), { note: body.note ?? null });
      return c.json({ submission: submissionOut(await subs.getSubmission(s.id)) });
    }
    const out = await approveSubmission(admin, c.req.param('id'), {
      collection: body.collection,
      section: body.section,
      note: body.note ?? null,
    });
    return c.json({
      submission: submissionOut(await subs.getSubmission(out.submission.id)),
      result_url: out.resultUrl,
    });
  });

  /* ---------------------------------------------------------------- admin -- */

  app.get('/admin/submissions', async (c) => {
    const user = requireAdmin(c);
    const [pending, decided, collections] = await Promise.all([
      subs.listSubmissions({ status: 'pending', limit: 200 }),
      subs.listSubmissions({ status: null, limit: 60 }),
      q.listCollections(),
    ]);
    return c.html(
      await render(
        <SubmissionsAdmin
          user={user}
          pending={pending}
          decided={decided.filter((s) => s.status !== 'pending')}
          collections={collections}
          notice={c.req.query('notice')}
          error={c.req.query('error')}
        />,
      ),
    );
  });

  app.post('/admin/submissions/:id', async (c) => {
    const admin = requireAdmin(c);
    const body = await c.req.parseBody();
    const note = body.note ? String(body.note).slice(0, 500) : null;
    if (String(body.decision ?? '') === 'reject') {
      await rejectSubmission(admin, c.req.param('id'), { note });
      return respond(c, { redirectTo: '/admin/submissions', notice: 'Rejected.' });
    }
    const out = await approveSubmission(admin, c.req.param('id'), {
      collection: body.collection,
      section: body.section,
      note,
    });
    return respond(c, {
      json: { ok: true, result_url: out.resultUrl },
      redirectTo: '/admin/submissions',
      notice: out.forwardedTo
        ? `Approved and handed to ${out.forwardedTo}.`
        : 'Approved. The source is added and its first fetch is queued.',
    });
  });
}
