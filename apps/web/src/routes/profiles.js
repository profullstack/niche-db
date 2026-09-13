import * as profiles from '@nichedb/db/profiles';
import { MEDIA_TYPE } from '@profullstack/openprofile';
import { cached, render, respond } from '../lib/http.js';
import {
  actor,
  canEdit,
  claimProfile,
  editProfile,
  mdUrlOf,
  pathOf,
  profileOut,
  resolveRef,
  urlOf,
} from '../lib/profiles.js';
import { Denied } from '../lib/service.js';
import { ProfileEditPage, ProfilePage } from '../views/profiles.jsx';

/**
 * People: /c/profiles/<slug>-<id> or /c/profiles/<handle>, the document next
 * to it, the claim, the edit, and the same four things over /api/v1/profiles.
 *
 * The id resolves and the name part is cosmetic, the way LinkedIn does it, so
 * two people with one name never collide and a renamed person keeps their
 * link. A wrong name part is a 301 to the right one. The document is served
 * as text/markdown with CORS open, because a reader on another site is the
 * point of the file.
 */

async function load(c, ref) {
  const { profile, canonical } = await resolveRef(ref);
  if (!profile) return { profile: null };
  const user = await actor(c);
  if (!profile.public && !canEdit(user, profile)) return { profile: null };
  return { profile, canonical, user };
}

function mdResponse(c, profile) {
  c.header('content-type', MEDIA_TYPE);
  c.header('access-control-allow-origin', '*');
  c.header('cache-control', 'public, max-age=3600');
  c.header('link', `<${mdUrlOf(profile)}>; rel="openprofile"`);
  return c.body(profile.doc);
}

export function registerProfiles(app) {
  /* ---------------------------------------------------------------- pages -- */

  app.get('/c/profiles/:ref/openprofile.md', async (c) => {
    const { profile } = await load(c, c.req.param('ref'));
    if (!profile) return c.text('not found\n', 404);
    return mdResponse(c, profile);
  });

  app.get('/c/profiles/:ref', async (c) => {
    const { profile, canonical, user } = await load(c, c.req.param('ref'));
    if (!profile) return c.notFound();
    if (!canonical) return c.redirect(pathOf(profile), 301);
    const key = `profile:${profile.id}:${profile.updated_at}`;
    return cached(
      c,
      key,
      () =>
        render(
          <ProfilePage
            user={user}
            profile={profile}
            canEdit={canEdit(user, profile)}
            notice={c.req.query('notice')}
            error={c.req.query('error')}
          />,
        ),
      600,
    );
  });

  app.get('/c/profiles/:ref/edit', async (c) => {
    const { profile, user } = await load(c, c.req.param('ref'));
    if (!profile) return c.notFound();
    if (!user) return c.redirect(`/login?next=${encodeURIComponent(c.req.path)}`, 303);
    if (!canEdit(user, profile)) throw new Denied('Claim this profile first.', 403);
    return c.html(
      await render(
        <ProfileEditPage
          user={user}
          profile={profile}
          notice={c.req.query('notice')}
          error={c.req.query('error')}
        />,
      ),
    );
  });

  app.post('/c/profiles/:ref/edit', async (c) => {
    const { profile, user } = await load(c, c.req.param('ref'));
    if (!profile) return c.notFound();
    const body = await c.req.parseBody();
    const sections = {};
    const identity = {};
    for (const [k, v] of Object.entries(body)) {
      if (k.startsWith('section.')) sections[k.slice(8)] = String(v);
      if (k.startsWith('identity.')) identity[k.slice(9)] = String(v);
    }
    if (body.identity_new_key && String(body.identity_new_key).trim())
      identity[String(body.identity_new_key).trim()] = String(body.identity_new_value ?? '');
    if (body.section_new_name && String(body.section_new_name).trim())
      sections[String(body.section_new_name).trim()] = String(body.section_new_body ?? '');
    try {
      const updated = await editProfile(user, profile, {
        markdown:
          typeof body.markdown === 'string' && body.markdown.trim() ? body.markdown : undefined,
        patch:
          typeof body.markdown === 'string' && body.markdown.trim()
            ? undefined
            : { name: body.name, headline: body.headline, identity, sections },
        handle: body.handle !== undefined ? String(body.handle) : undefined,
        isPublic:
          body.public !== undefined ? body.public === 'on' || body.public === 'true' : undefined,
      });
      return respond(c, {
        json: { profile: profileOut(updated) },
        redirectTo: pathOf(updated),
        notice: 'Saved.',
      });
    } catch (err) {
      if (!(err instanceof Denied)) throw err;
      return respond(c, {
        error: err.message,
        status: err.status,
        redirectTo: `${pathOf(profile)}/edit`,
      });
    }
  });

  app.post('/c/profiles/:ref/claim', async (c) => {
    const { profile, user } = await load(c, c.req.param('ref'));
    if (!profile) return c.notFound();
    if (!user) return c.redirect(`/login?next=${encodeURIComponent(pathOf(profile))}`, 303);
    const body = await c.req.parseBody().catch(() => ({}));
    try {
      const { method, already } = await claimProfile(user, profile, { email: body.email ?? null });
      return respond(c, {
        json: { ok: true, method, already },
        redirectTo: pathOf(profile),
        notice: already ? 'Already yours.' : `Claimed (${method}). It is yours to edit.`,
      });
    } catch (err) {
      if (!(err instanceof Denied)) throw err;
      return respond(c, { error: err.message, status: err.status, redirectTo: pathOf(profile) });
    }
  });

  /* ------------------------------------------------------------------ api -- */

  app.get('/api/v1/profiles', async (c) => {
    const user = await actor(c);
    const rows = await profiles.listProfiles({
      q: c.req.query('q') || null,
      since: c.req.query('since') || null,
      limit: c.req.query('limit') || 50,
      publicOnly: true,
    });
    const mine = c.req.query('mine') && user ? await profiles.profilesOf(user.id) : null;
    c.header('cache-control', c.req.query('since') ? 'no-store' : 'public, max-age=60');
    return c.json({
      count: (mine ?? rows).length,
      profiles: (mine ?? rows).map(profileOut),
      openprofiles: (mine ?? rows).map((p) => ({
        id: String(p.id),
        name: p.name,
        url: mdUrlOf(p),
        page: urlOf(p),
        updatedAt: new Date(p.updated_at).toISOString(),
        accounts: (p.data?.accounts ?? []).map((a) => a.url),
        web: p.data?.identity?.web ?? null,
      })),
      next: null,
    });
  });

  app.get('/api/v1/profiles/:ref', async (c) => {
    const raw = c.req.param('ref');
    const asMd = raw.endsWith('.md');
    const { profile } = await load(c, asMd ? raw.slice(0, -3) : raw);
    if (!profile) return c.json({ error: 'not found' }, 404);
    if (asMd) return mdResponse(c, profile);
    c.header('cache-control', 'public, max-age=60');
    return c.json({ profile: profileOut(profile), markdown: profile.doc });
  });

  app.get('/api/v1/profiles/:ref/openprofile.md', async (c) => {
    const { profile } = await load(c, c.req.param('ref'));
    if (!profile) return c.text('not found\n', 404);
    return mdResponse(c, profile);
  });

  app.put('/api/v1/profiles/:ref', async (c) => {
    const { profile, user } = await load(c, c.req.param('ref'));
    if (!profile) return c.json({ error: 'not found' }, 404);
    const type = c.req.header('content-type') ?? '';
    let markdown;
    let patch;
    let handle;
    let isPublic;
    if (/markdown|text\/plain/i.test(type)) {
      markdown = await c.req.text();
    } else {
      const body = await c.req.json().catch(() => null);
      if (!body || typeof body !== 'object') throw new Denied('Send JSON, or text/markdown.', 400);
      if (typeof body.markdown === 'string') markdown = body.markdown;
      patch = {
        name: body.name,
        headline: body.headline,
        prose: body.prose,
        identity: body.identity,
        sections: body.sections,
      };
      if (body.handle !== undefined) handle = body.handle;
      if (body.public !== undefined) isPublic = Boolean(body.public);
    }
    const updated = await editProfile(user, profile, { markdown, patch, handle, isPublic });
    return c.json({ profile: profileOut(updated), markdown: updated.doc });
  });

  app.post('/api/v1/profiles/:ref/claim', async (c) => {
    const { profile, user } = await load(c, c.req.param('ref'));
    if (!profile) return c.json({ error: 'not found' }, 404);
    const body = await c.req.json().catch(() => ({}));
    const out = await claimProfile(user, profile, { email: body.email ?? null });
    return c.json({ ok: true, ...out, profile: profileOut(await profiles.getProfile(profile.id)) });
  });
}
