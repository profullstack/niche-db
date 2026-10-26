import * as auth from '@nichedb/auth';
import { config } from '@nichedb/config';
import * as q from '@nichedb/db/queries';
import { sendLoginLink } from '@nichedb/notify';
import { connection } from '@nichedb/queue';
import { vapidKeysFromEnv, vapidPublicKeyResponse } from '@profullstack/notifications/server';
import { saveSignupProfile, validateProfile } from '@profullstack/profile';
import { getCookie, setCookie } from 'hono/cookie';
import { AUTH, attempt, callerAddress, forgive, VIEW } from '../lib/auth-throttle.js';
import { acceptInvite, attributeReferral, looksLikeInvite } from '../lib/credits.js';
import { render, requireUser, respond } from '../lib/http.js';
import { profiles } from '../lib/profile.js';
import { SignIn } from '../views/pages.jsx';

const REF_COOKIE = 'ndb_ref';
/** Set by /i/<code>; also carried on the emailed link (login_tokens.invite_code). */
export const INVITE_COOKIE = 'ndb_invite';
const inviteFrom = (c) => {
  const v = getCookie(c, INVITE_COOKIE);
  return v && looksLikeInvite(v) ? v : null;
};
const waitFor = (s) =>
  s >= 3600
    ? `${Math.ceil(s / 3600)} hour(s)`
    : s >= 60
      ? `${Math.ceil(s / 60)} minute(s)`
      : `${s} second(s)`;

/** Escalating per-address backoff in front of the unauthenticated auth routes. */
const backoff =
  (name, limits = AUTH) =>
  async (c, next) => {
    const caller = callerAddress(c);
    if (!caller) return next();
    const verdict = attempt(`${name}:${caller}`, Date.now(), limits);
    if (verdict.ok) return next();
    c.header('retry-after', String(verdict.retryAfter));
    const msg = `Too many attempts. Try again in ${waitFor(verdict.retryAfter)}.`;
    if ((c.req.header('accept') ?? '').includes('application/json'))
      return c.json({ error: msg }, 429);
    return c.html(await render(<SignIn mode="login" error={msg} />), 429);
  };

function rememberReferral(c) {
  const ref = c.req.query('ref');
  if (ref && /^[A-Z0-9]{4,16}$/i.test(ref)) {
    setCookie(c, REF_COOKIE, ref.toUpperCase(), {
      path: '/',
      maxAge: 30 * 86400,
      sameSite: 'Lax',
      httpOnly: true,
      secure: config.isProd,
    });
    return ref.toUpperCase();
  }
  return getCookie(c, REF_COOKIE) ?? null;
}

export function registerAuth(app) {
  app.get('/login', backoff('view', VIEW));
  app.get('/login', async (c) => {
    if (c.get('user')) return c.redirect(c.req.query('next') ?? '/following', 303);
    const referral = rememberReferral(c);
    return c.html(
      await render(
        <SignIn
          mode="login"
          next={c.req.query('next')}
          referral={referral}
          invite={inviteFrom(c)}
          error={c.req.query('error')}
        />,
      ),
    );
  });
  app.get('/signup', backoff('view', VIEW));
  app.get('/signup', async (c) => {
    if (c.get('user')) return c.redirect('/following', 303);
    const referral = rememberReferral(c);
    return c.html(
      await render(
        <SignIn
          mode="signup"
          next={c.req.query('next')}
          referral={referral}
          invite={inviteFrom(c)}
        />,
      ),
    );
  });
  /** A referral link: remember the code, land on sign-up. */
  app.get('/r/:code', (c) => {
    rememberReferral({ ...c, req: { ...c.req, query: () => c.req.param('code') } });
    setCookie(c, REF_COOKIE, c.req.param('code').toUpperCase(), {
      path: '/',
      maxAge: 30 * 86400,
      sameSite: 'Lax',
      httpOnly: true,
      secure: config.isProd,
    });
    return c.redirect('/signup', 303);
  });

  /** Request a sign-in link. Identical answer whether or not the address exists. */
  app.post('/api/auth/magic', backoff('magic'));
  app.post('/api/auth/magic', async (c) => {
    const body = await c.req.parseBody();
    const json = (c.req.header('accept') ?? '').includes('application/json');

    /*
     * The signup form carries the shared profile fields; plain sign-in does not and
     * is never asked for them. They are checked here, before any link exists, and
     * a refusal goes back to the form with what was typed. The same answer for a
     * known or unknown address, so it says nothing about who has an account.
     */
    let profile = null;
    if (body.mode === 'signup') {
      const check = validateProfile(body);
      if (!check.ok) {
        if (json) return c.json({ error: 'Some fields need fixing.', errors: check.errors }, 400);
        return c.html(
          await render(
            <SignIn mode="signup" next={body.next} values={body} errors={check.errors} />,
          ),
          400,
        );
      }
      profile = check.profile;
    }

    const email = String(body.email ?? '')
      .trim()
      .toLowerCase();
    const next = String(body.next ?? '/following');
    const invite = looksLikeInvite(body.invite) ? String(body.invite) : inviteFrom(c);
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      try {
        const url = await auth.createLoginLink(email, { next, profile, invite });
        await sendLoginLink({ email, url });
      } catch (err) {
        console.error('[auth] link send failed:', err.message);
        if (!config.mail.enabled)
          console.log(
            `[auth] mail is not configured; the link would have been ${await auth.createLoginLink(email, { next, profile, invite })}`,
          );
      }
    }
    if (json) return c.json({ ok: true });
    return c.html(await render(<SignIn mode="login" sent />));
  });

  app.get('/auth/magic', backoff('token'));
  app.get('/auth/magic', async (c) => {
    const token = c.req.query('t');
    if (!token) return c.redirect('/login', 303);
    const result = await auth.consumeLoginLink(token, { userAgent: c.req.header('user-agent') });
    if (!result)
      return c.html(
        await render(
          <SignIn
            mode="login"
            error="That link has expired or was already used. Ask for another."
          />,
        ),
        400,
      );
    // The fields typed on the signup form, saved now that the account exists and
    // the link has proved the mailbox. A failure here never costs anybody their
    // sign-in: settings asks again.
    if (result.profile) {
      await saveSignupProfile(profiles, result.user.id, result.profile, {
        email: result.user.email,
      }).catch((err) => console.error('[auth] signup profile save failed:', err.message));
    }
    const ref = getCookie(c, REF_COOKIE);
    if (ref && result.user?.created) {
      // One attribution per sign-up: a referrals code (the programme that pays)
      // goes to users.referred_by as before; an affiliates code is recorded there.
      await attributeReferral({
        userId: result.user.id,
        code: ref,
        onExternal: ({ userId, code }) => q.setReferredBy({ userId, code }),
      }).catch(async (err) => {
        console.error('[auth] attribution failed:', err.message);
        await q.setReferredBy({ userId: result.user.id, code: ref }).catch(() => {});
      });
    }
    // An invite counts only for an account this link just created: spending the
    // link proved the mailbox, so this is a real, confirmed sign-up. The code
    // comes from the link itself first, so another browser still counts.
    const invite = result.invite ?? inviteFrom(c);
    if (invite && result.user?.created)
      await acceptInvite({ userId: result.user.id, code: invite }).catch((err) =>
        console.error('[auth] invite accept failed:', err.message),
      );
    const caller = callerAddress(c);
    if (caller) forgive(`token:${caller}`);
    c.header('set-cookie', auth.sessionCookie(result.sessionId));
    if (ref) setCookie(c, REF_COOKIE, '', { path: '/', maxAge: 0 });
    if (getCookie(c, INVITE_COOKIE)) setCookie(c, INVITE_COOKIE, '', { path: '/', maxAge: 0 });
    const next = c.req.query('next');
    return c.redirect(next?.startsWith('/') ? next : '/following', 303);
  });

  app.post('/api/auth/logout', async (c) => {
    const sid = getCookie(c, config.session.cookie);
    if (sid) await q.endSession(sid);
    c.header('set-cookie', auth.sessionCookie('', { clear: true }));
    return respond(c, { redirectTo: '/' });
  });

  /* Passkey challenges live in Redis keyed by a short-lived cookie. */
  const challengeKey = (id) => `pk:challenge:${id}`;
  async function stashChallenge(c, challenge) {
    const id = crypto.randomUUID();
    await connection.set(challengeKey(id), challenge, 'EX', 300);
    setCookie(c, 'ndb_pk', id, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: 300,
      secure: config.isProd,
    });
  }
  async function takeChallenge(c) {
    const id = getCookie(c, 'ndb_pk');
    if (!id) return null;
    const val = await connection.get(challengeKey(id));
    await connection.del(challengeKey(id));
    return val;
  }

  app.post('/api/auth/passkey/register/options', async (c) => {
    const user = requireUser(c);
    const options = await auth.passkeyRegistrationOptions(user);
    await stashChallenge(c, options.challenge);
    return c.json(options);
  });
  app.post('/api/auth/passkey/register/verify', async (c) => {
    const user = requireUser(c);
    const expectedChallenge = await takeChallenge(c);
    if (!expectedChallenge) return c.json({ error: 'challenge expired' }, 400);
    const ok = await auth.verifyPasskeyRegistration({
      user,
      response: await c.req.json(),
      expectedChallenge,
    });
    return c.json({ ok }, ok ? 200 : 400);
  });
  app.post('/api/auth/passkey/remove', async (c) => {
    const user = requireUser(c);
    const body = await c.req.parseBody();
    await q.deletePasskey({ userId: user.id, credentialId: String(body.credential_id ?? '') });
    return respond(c, { redirectTo: '/settings', notice: 'Passkey removed.' });
  });

  const pkBackoff = backoff('passkey');
  app.post('/api/auth/passkey/authenticate/options', pkBackoff);
  app.post('/api/auth/passkey/authenticate/options', async (c) => {
    const options = await auth.passkeyAuthenticationOptions();
    await stashChallenge(c, options.challenge);
    return c.json(options);
  });
  app.post('/api/auth/passkey/authenticate/verify', pkBackoff);
  app.post('/api/auth/passkey/authenticate/verify', async (c) => {
    const expectedChallenge = await takeChallenge(c);
    if (!expectedChallenge) return c.json({ error: 'challenge expired' }, 400);
    const result = await auth.verifyPasskeyAuthentication({
      response: await c.req.json(),
      expectedChallenge,
      userAgent: c.req.header('user-agent'),
    });
    if (!result) return c.json({ error: 'rejected' }, 400);
    const caller = callerAddress(c);
    if (caller) forgive(`passkey:${caller}`);
    c.header('set-cookie', auth.sessionCookie(result.sessionId));
    return c.json({ ok: true });
  });

  /*
   * The push public key, read from the environment on every request rather than
   * written into the page, so a key missing at render time cannot leave the page
   * telling every browser that push is not available. 503 with a reason when the
   * server has no key pair.
   */
  app.get('/api/push/vapid-public-key', () =>
    vapidPublicKeyResponse(vapidKeysFromEnv(process.env)),
  );

  /* Push subscriptions and the reader's zone. */
  app.post('/api/push/subscribe', async (c) => {
    const user = requireUser(c);
    const sub = await c.req.json();
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth)
      return c.json({ error: 'bad subscription' }, 400);
    await q.savePushSubscription({
      userId: user.id,
      endpoint: sub.endpoint,
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth,
    });
    return c.json({ ok: true });
  });
  app.post('/api/push/unsubscribe', async (c) => {
    const user = requireUser(c);
    const sub = await c.req.json();
    if (sub?.endpoint) await q.deletePushSubscription({ userId: user.id, endpoint: sub.endpoint });
    return c.json({ ok: true });
  });
  app.post('/api/timezone', async (c) => {
    const user = c.get('user');
    if (!user) return c.json({ ok: false }, 401);
    const { timezone } = await c.req.json();
    try {
      Intl.DateTimeFormat(undefined, { timeZone: timezone });
    } catch {
      return c.json({ error: 'bad timezone' }, 400);
    }
    await q.setUserTimezone(user.id, timezone);
    return c.json({ ok: true });
  });
}
