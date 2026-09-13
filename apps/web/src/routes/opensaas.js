/**
 * The way in and the way out, served: nichedb's own OpenSaaS descriptor at
 * /.well-known/opensaas.json, and the four endpoints it names, each with the
 * page a person uses beside it.
 *
 * The endpoints answer the way the spec says an action answers: `done`,
 * `scheduled`, `pending` with a `next`, or `refused` with a `reason`. A form
 * on the page posts to the same endpoint and is redirected back with a
 * notice, so a person and an agent go through one door.
 */

import * as auth from '@nichedb/auth';
import { config } from '@nichedb/config';
import { sql } from '@nichedb/db';
import * as accountDb from '@nichedb/db/account';
import { sendDeleteLink } from '@nichedb/notify';
import * as pay from '@nichedb/payments';
import { MEMBERSHIP_KIND, PLANS } from '@nichedb/payments/membership';
import { priceFor } from '@nichedb/payments/referrals';
import { termById } from '@nichedb/premium';
import { render, requireUser, respond, wantsJson } from '../lib/http.js';
import { actor, descriptor, SCOPES } from '../lib/opensaas.js';
import { Denied } from '../lib/service.js';
import { BillingPage, DeletedPage, DeletePage, ExportPage } from '../views/account.jsx';
import { prices } from './premium.js';

const DELETE_ACTION = 'delete-account';

export function registerOpenSaaS(app, deps = {}) {
  const store = { ...accountDb, ...deps.store };
  const who = deps.actor ?? actor;
  const mail = deps.sendDeleteLink ?? sendDeleteLink;
  const describe = deps.descriptor ?? descriptor;

  app.get('/.well-known/opensaas.json', (c) => {
    c.header('cache-control', 'public, max-age=300');
    c.header('access-control-allow-origin', '*');
    return c.json(describe());
  });

  /* -------------------------------------------------------------- subscribe -- */

  /**
   * Start a term. Payment is CoinPay's checkout, so the answer is `pending`
   * with the checkout page as `next`: the person finishes there. `plan` is a
   * plan id from the descriptor (`premium-month`, `pro`).
   */
  app.post('/api/v1/billing/subscribe', async (c) => {
    const { user } = await who(c, SCOPES.subscribe);
    const body = await readBody(c);
    const wanted = String(body.plan ?? 'premium-month');
    if (!config.premium.enabled && !config.membership.enabled)
      return refused(c, 'Payments are not configured on this deployment.');
    if (wanted === 'pro') {
      const price = await priceFor(sql, {
        userId: user.id,
        referredBy: user.referred_by,
        amountCents: config.membership.priceCents,
      });
      const { checkoutUrl } = await pay.createCheckout({
        user,
        amountCents: price.amountCents,
        currency: config.membership.currency,
        description: `${config.siteName} Pro, ${config.membership.termDays} days`,
        metadata: {
          kind: MEMBERSHIP_KIND,
          plan: 'pro',
          term_days: String(config.membership.termDays),
          referral_code: price.code ?? '',
          list_price_cents: String(config.membership.priceCents),
        },
        blockchain: config.payments.blockchain,
      });
      return pending(c, checkoutUrl, { plan: 'pro' });
    }
    const term = termById(wanted.replace(/^premium-/, ''), prices());
    if (!wanted.startsWith('premium-') || !term) return refused(c, `No such plan: ${wanted}.`);
    if (term.id === 'day') return pending(c, `${config.siteUrl}/crawl`, { plan: wanted });
    const price = await priceFor(sql, {
      userId: user.id,
      referredBy: user.referred_by,
      amountCents: term.cents,
    });
    const { checkoutUrl } = await pay.createCheckout({
      user,
      amountCents: price.amountCents,
      currency: config.premium.currency,
      description: `${config.siteName} Premium, ${term.days} days`,
      metadata: {
        kind: MEMBERSHIP_KIND,
        plan: 'premium',
        term_days: String(term.days),
        referral_code: price.code ?? '',
        list_price_cents: String(term.cents),
      },
      blockchain: config.payments.blockchain,
    });
    return pending(c, checkoutUrl, { plan: wanted });
  });

  /* ----------------------------------------------------------------- cancel -- */

  app.get('/account/billing', async (c) => {
    const user = requireUser(c);
    const plans = await store.activePlans(user.id);
    return c.html(
      await render(
        <BillingPage
          user={user}
          plans={plans}
          notice={c.req.query('notice')}
          error={c.req.query('error')}
        />,
      ),
    );
  });

  /** End the running term(s) of one plan, or of every plan, today. Nothing is refunded. */
  app.post('/api/v1/billing/cancel', async (c) => {
    const { user } = await who(c, SCOPES.cancel);
    const body = await readBody(c);
    const wanted = body.plan ? String(body.plan) : null;
    const targets = wanted ? [wanted] : PLANS;
    if (wanted && !PLANS.includes(wanted)) return refused(c, `No such plan: ${wanted}.`);
    const ended = [];
    for (const plan of targets) ended.push(...(await store.cancelPlan(user.id, plan)));
    if (ended.length === 0)
      return respond(c, {
        json: {
          status: 'done',
          effective: new Date().toISOString(),
          ended: [],
          note: 'nothing was running',
        },
        redirectTo: '/account/billing',
        notice: 'No running plan to end.',
      });
    return respond(c, {
      json: { status: 'done', effective: new Date().toISOString(), refund: 'none', ended },
      redirectTo: '/account/billing',
      notice: `Ended ${ended.map((e) => e.plan).join(', ')}. Nothing is refunded.`,
    });
  });

  /* ----------------------------------------------------------------- export -- */

  app.get('/account/export', async (c) => {
    const user = requireUser(c);
    return c.html(await render(<ExportPage user={user} />));
  });

  app.post('/api/v1/account/export', async (c) => {
    const { user } = await who(c, SCOPES.export);
    const doc = await store.exportAccount(user.id);
    if (!doc) throw new Denied('No such account.', 404);
    c.header(
      'content-disposition',
      `attachment; filename="${config.siteName.toLowerCase()}-account.json"`,
    );
    return c.json(doc);
  });

  /* ----------------------------------------------------------------- delete -- */

  app.get('/account/delete', async (c) => {
    const user = requireUser(c);
    return c.html(
      await render(
        <DeletePage user={user} notice={c.req.query('notice')} error={c.req.query('error')} />,
      ),
    );
  });

  /**
   * Ask. The account's own email gets a one-time link; following it deletes.
   * That is the `confirm: email` the descriptor states, for a person and an
   * agent alike: the agent's answer is `pending` with the `confirm`.
   */
  app.post('/api/v1/account/delete', async (c) => {
    const { user } = await who(c, SCOPES.delete);
    const token = await store.createActionToken(user.id, DELETE_ACTION);
    const url = `${config.siteUrl}/account/delete/confirm?t=${encodeURIComponent(token)}`;
    try {
      await mail({ email: user.email, url });
    } catch (err) {
      console.error('[account] delete link send failed:', err.message);
      if (!config.mail.enabled)
        console.log(`[account] mail is not configured; the link would have been ${url}`);
      return refused(c, 'The confirmation email could not be sent.');
    }
    return respond(c, {
      json: {
        status: 'pending',
        confirm: 'email',
        next: {
          confirm: 'email',
          sent_to: user.email,
          expires_in: accountDb.ACTION_TTL_MINUTES * 60,
        },
      },
      redirectTo: '/account/delete',
      notice: `A link was sent to ${user.email}. Follow it to delete the account.`,
    });
  });

  app.get('/account/delete/confirm', async (c) => {
    const token = c.req.query('t');
    const userId = token ? await store.consumeActionToken(token, DELETE_ACTION) : null;
    if (!userId)
      return c.html(
        await render(
          <DeletedPage error="That link has expired or was already used. Ask for another." />,
        ),
        400,
      );
    const gone = await store.deleteAccount(userId);
    c.header('set-cookie', auth.sessionCookie('', { clear: true }));
    return c.html(await render(<DeletedPage email={gone?.email ?? null} />));
  });
}

async function readBody(c) {
  const type = c.req.header('content-type') ?? '';
  if (type.includes('application/json')) return (await c.req.json().catch(() => ({}))) ?? {};
  return (await c.req.parseBody().catch(() => ({}))) ?? {};
}

function pending(c, page, extra = {}) {
  if (wantsJson(c)) return c.json({ status: 'pending', next: { page }, ...extra });
  return c.redirect(page, 303);
}

function refused(c, reason) {
  if (wantsJson(c)) return c.json({ status: 'refused', reason }, 400);
  return respond(c, { redirectTo: '/account/billing', error: reason });
}
