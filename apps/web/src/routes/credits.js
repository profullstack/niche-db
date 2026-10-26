/**
 * Credit codes and invites, served: the "Have a code?" redeem endpoint, the
 * /invites page and API, the /i/<code> landing, and the admin's mint.
 * Everything that decides anything is in lib/credits.js.
 */
import { config } from '@nichedb/config';
import { connection } from '@nichedb/queue';
import { getCookie, setCookie } from 'hono/cookie';
import * as lib from '../lib/credits.js';
import { render, requireUser, respond, wantsJson } from '../lib/http.js';
import { Denied, isAdmin } from '../lib/service.js';
import { AdminCreditsPage, InviteLanding, InvitesPage } from '../views/credits.jsx';
import { INVITE_COOKIE } from './auth.js';

const requireAdmin = (c) => {
  const user = requireUser(c);
  if (!isAdmin(user)) throw new Denied('Admins only.', 403);
  return user;
};

async function readBody(c) {
  const ct = c.req.header('content-type') ?? '';
  if (ct.includes('application/json')) return (await c.req.json().catch(() => ({}))) ?? {};
  return c.req.parseBody();
}

/**
 * A one-time plaintext (a new invite or code) for the page the form lands on,
 * kept out of the URL. Its own key, so the API-key flash on /settings never
 * picks it up.
 */
function redisFlash() {
  const key = (kind, c) => {
    const sid = getCookie(c, config.session.cookie);
    return sid ? `flash:${kind}:${sid}` : null;
  };
  return {
    async put(c, kind, value) {
      const k = key(kind, c);
      if (k) await connection.set(k, JSON.stringify(value), 'EX', 120).catch(() => {});
    },
    async take(c, kind) {
      const k = key(kind, c);
      if (!k) return null;
      try {
        const v = await connection.get(k);
        if (v) await connection.del(k);
        return v ? JSON.parse(v) : null;
      } catch {
        return null;
      }
    },
  };
}

const safeBack = (v, fallback) => {
  const s = String(v ?? '');
  return s.startsWith('/') && !s.startsWith('//') ? s : fallback;
};

/*
 * Every write answers on two paths: /api/v1/… for API callers (always JSON,
 * see wantsJson) and the same path without the prefix for the page's plain
 * forms, which get a 303 back with a notice.
 */
export function registerCredits(app, deps = {}) {
  const svc = () => deps.services ?? lib.services();
  const flash = deps.flash ?? redisFlash();

  /* --------------------------------------------------------- credit codes -- */

  app.on('POST', ['/api/v1/credits/redeem', '/credits/redeem'], async (c) => {
    const user = requireUser(c);
    const body = await readBody(c);
    const back = safeBack(body.back, '/settings');
    const r = await lib.redeemCode(user.id, body.code, svc());
    if (!r.ok)
      return respond(c, {
        json: { ok: false, reason: r.reason, error: r.error },
        status: r.reason === 'grant_failed' ? 500 : 400,
        redirectTo: back,
        error: r.error,
      });
    return respond(c, {
      json: { ok: true, unit: lib.UNIT, days: r.days },
      redirectTo: back,
      notice: `Redeemed: ${r.days} days of Premium added.`,
    });
  });

  /* ------------------------------------------------------------- invites -- */

  app.get('/invites', async (c) => {
    const user = requireUser(c);
    const [mine, made] = await Promise.all([
      lib.myInvites(user.id, svc()),
      flash.take(c, 'invite'),
    ]);
    return c.html(
      await render(
        <InvitesPage
          user={user}
          quota={mine.quota}
          invites={mine.invites}
          made={made}
          notice={c.req.query('notice')}
          error={c.req.query('error')}
        />,
      ),
    );
  });

  app.get('/api/v1/invites', async (c) => {
    const user = requireUser(c);
    return c.json(await lib.myInvites(user.id, svc()));
  });

  app.on('POST', ['/api/v1/invites', '/invites'], async (c) => {
    const user = requireUser(c);
    const body = await readBody(c);
    const r = await lib.createInvite(user.id, body.note, svc());
    if (!r.ok) return respond(c, { status: 409, redirectTo: '/invites', error: r.error });
    if (!wantsJson(c)) await flash.put(c, 'invite', r.invite);
    return respond(c, { json: { ok: true, invite: r.invite }, redirectTo: '/invites' });
  });

  app.on('POST', ['/api/v1/invites/:id/revoke', '/invites/:id/revoke'], async (c) => {
    const user = requireUser(c);
    const r = await lib.revokeInvite(user.id, c.req.param('id'), svc());
    if (!r.ok) return respond(c, { status: 404, redirectTo: '/invites', error: r.error });
    return respond(c, {
      redirectTo: '/invites',
      notice: 'Invite withdrawn; the slot is yours again.',
    });
  });

  /**
   * An invite link: remember the code (also carried on the emailed link), then
   * sign up. /i/<number> is an item page; an invite always starts INV-, so the
   * pattern keeps the two apart, and this is registered before the item route.
   */
  app.get('/i/:code{[Ii][Nn][Vv]-[A-Za-z0-9-]{12,20}}', async (c) => {
    const raw = c.req.param('code');
    const status = await lib.inviteStatus(raw, svc());
    const code = status === 'invalid' ? raw.slice(0, 24) : lib.canonicalInvite(raw);
    const user = c.get('user');
    if (status === 'ok' && !user)
      setCookie(c, INVITE_COOKIE, code, {
        path: '/',
        maxAge: config.invites.ttlDays * 86400,
        sameSite: 'Lax',
        httpOnly: true,
        secure: config.isProd,
      });
    c.header('cache-control', 'private, no-store');
    if (wantsJson(c))
      return c.json({
        code,
        status,
        bonus_days: config.invites.bonusDays,
        signup: `${config.siteUrl}/signup`,
      });
    return c.html(
      await render(<InviteLanding user={user} code={code} status={status} />),
      status === 'ok' ? 200 : 404,
    );
  });

  /* --------------------------------------------------------------- admin -- */

  app.get('/admin/credits', async (c) => {
    const user = requireAdmin(c);
    const [codes, made] = await Promise.all([svc().credits.list(), flash.take(c, 'credit-code')]);
    return c.html(
      await render(
        <AdminCreditsPage
          user={user}
          codes={codes.map((x) => lib.codeOut(x))}
          made={made}
          notice={c.req.query('notice')}
          error={c.req.query('error')}
        />,
      ),
    );
  });

  app.get('/api/v1/admin/credits', async (c) => {
    requireAdmin(c);
    return c.json({ codes: (await svc().credits.list()).map((x) => lib.codeOut(x)) });
  });

  app.on('POST', ['/api/v1/admin/credits', '/admin/credits'], async (c) => {
    const user = requireAdmin(c);
    const body = await readBody(c);
    let made;
    try {
      made = await lib.mintPremiumCode(
        {
          days: body.days,
          label: body.label,
          maxRedemptions: body.max || body.max_redemptions || 1,
          expiresInDays: body.expires_days ?? body.expires_in_days ?? null,
          createdBy: user.email,
        },
        svc(),
      );
    } catch (err) {
      if (err.status === 400)
        return respond(c, { status: 400, redirectTo: '/admin/credits', error: err.message });
      throw err;
    }
    if (!wantsJson(c)) await flash.put(c, 'credit-code', made);
    return respond(c, { json: { ok: true, ...made }, redirectTo: '/admin/credits' });
  });

  app.on('POST', ['/api/v1/admin/credits/:id/revoke', '/admin/credits/:id/revoke'], async (c) => {
    requireAdmin(c);
    try {
      await svc().credits.revoke(c.req.param('id'));
    } catch {
      return respond(c, { status: 404, redirectTo: '/admin/credits', error: 'No such code.' });
    }
    return respond(c, { redirectTo: '/admin/credits', notice: 'Revoked.' });
  });
}
