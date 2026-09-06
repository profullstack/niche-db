import * as k from '@nichedb/db/knowledge';
import * as r from '@nichedb/db/revenue';
import { REVENUE_SOURCE_TYPES } from '@nichedb/knowledge';
import { verifyInternalRequest } from '../lib/chovy.js';
import { render, requireUser, respond } from '../lib/http.js';
import { Denied, isAdmin } from '../lib/service.js';
import { NicheRevenue, PayoutsAdmin, PayoutsPage } from '../views/revenue.jsx';

/**
 * The revenue ledger's surfaces.
 *
 * Money arrives through one signed endpoint, is divided at finalisation using
 * the shares in force at that instant, and accrues to the people who earned
 * it. Nothing here sends money: settlement is done out of band and recorded,
 * which is the same shape the partner programme uses.
 */

const requireAdmin = (c) => {
  const user = requireUser(c);
  if (!isAdmin(user)) throw new Denied('Admins only.', 403);
  return user;
};

export function registerRevenue(app) {
  /* -------------------------------------------------------------- internal -- */

  /**
   * An earning, from whatever produced it.
   *
   * Signed, because this decides who is owed money. Idempotent on the payment
   * reference, because a webhook that retries must not pay twice.
   */
  app.post('/api/v1/internal/revenue-events', async (c) => {
    const auth = await verifyInternalRequest(c);
    if (!auth.ok) return c.json({ error: auth.reason }, auth.status);

    const p = auth.body?.payload ?? auth.body ?? {};
    if (!REVENUE_SOURCE_TYPES.includes(p.sourceType))
      return c.json({ error: 'unknown source type', known: REVENUE_SOURCE_TYPES }, 400);
    if (!Number.isFinite(Number(p.grossMinor)) || Number(p.grossMinor) < 0)
      return c.json({ error: 'grossMinor must be a non-negative integer of minor units' }, 400);

    const niche = p.nicheSlug ? await k.getNiche(p.nicheSlug) : null;
    if (p.nicheSlug && !niche) return c.json({ error: 'no such niche' }, 404);

    const out = await r.recordRevenueEvent({
      externalId: p.externalId ?? p.paymentRef ?? auth.body?.id ?? null,
      nicheId: niche?.id ?? p.nicheId ?? null,
      sourceType: p.sourceType,
      sourceId: p.sourceId ?? null,
      grossMinor: p.grossMinor,
      processingMinor: p.processingMinor ?? 0,
      networkMinor: p.networkMinor ?? 0,
      infraMinor: p.infraMinor ?? 0,
      refundMinor: p.refundMinor ?? 0,
      currency: p.currency ?? 'USD',
      occurredAt: p.occurredAt ?? null,
      metadata: p.metadata ?? {},
      finalize: p.finalize !== false,
    });

    return c.json(
      {
        recorded: Boolean(out.event),
        duplicate: out.duplicate,
        eventId: out.event ? String(out.event.id) : null,
        netMinor: out.event ? Number(out.event.net_amount_minor) : 0,
        allocations: out.allocations.map((a) => ({
          type: a.allocation_type,
          shareBps: Number(a.share_bps),
          amountMinor: Number(a.amount_minor),
        })),
      },
      out.duplicate ? 200 : 201,
    );
  });

  /* ------------------------------------------------------------ influencer -- */

  app.get('/api/v1/me/revenue', async (c) => {
    const user = requireUser(c);
    return c.json({
      balance: await r.balanceFor(user.id),
      allocations: await r.allocationsForInfluencer(user.id, { limit: 100 }),
    });
  });

  app.get('/api/v1/me/payouts', async (c) => {
    const user = requireUser(c);
    return c.json({ payouts: await r.listPayouts({ influencerId: user.id }) });
  });

  app.get('/dashboard/payouts', async (c) => {
    const user = requireUser(c);
    const [balance, allocations, payouts, account] = await Promise.all([
      r.balanceFor(user.id),
      r.allocationsForInfluencer(user.id, { limit: 50 }),
      r.listPayouts({ influencerId: user.id }),
      r.getPayoutAccount(user.id),
    ]);
    return c.html(
      await render(
        <PayoutsPage
          user={user}
          balance={balance}
          allocations={allocations}
          payouts={payouts}
          account={account}
          notice={c.req.query('notice')}
          error={c.req.query('error')}
        />,
      ),
    );
  });

  app.post('/dashboard/payouts/address', async (c) => {
    const user = requireUser(c);
    const body = await c.req.parseBody();
    await r.setPayoutAddress({
      userId: user.id,
      address: String(body.address ?? '')
        .trim()
        .slice(0, 200),
    });
    return respond(c, {
      json: { ok: true },
      redirectTo: '/dashboard/payouts',
      notice: 'Saved. An admin has to confirm it before anything is sent.',
    });
  });

  /** A niche's own books, for the people who operate it. */
  app.get('/dashboard/niches/:slug/revenue', async (c) => {
    const user = requireUser(c);
    const niche = await k.getNiche(c.req.param('slug'));
    if (!niche) return c.notFound();
    const member = await k.memberOf({ nicheId: niche.id, userId: user.id });
    if (member?.status !== 'active' && !isAdmin(user)) return c.notFound();

    const [totals, events, members, mine] = await Promise.all([
      r.nicheRevenueTotals(niche.id),
      r.revenueForNiche(niche.id, { limit: 50 }),
      k.nicheMembers(niche.id),
      r.allocationsForInfluencer(user.id, { limit: 50 }),
    ]);
    return c.html(
      await render(
        <NicheRevenue
          user={user}
          niche={niche}
          totals={totals}
          events={events}
          members={members}
          mine={mine.filter((a) => a.niche_slug === niche.slug)}
        />,
      ),
    );
  });

  /* ---------------------------------------------------------------- admin -- */

  app.get('/admin/payouts', async (c) => {
    const user = requireAdmin(c);
    const [owed, payouts, events] = await Promise.all([
      r.outstandingBalances(),
      r.listPayouts({ limit: 50 }),
      r.listRevenueEvents({ limit: 50 }),
    ]);
    return c.html(
      await render(
        <PayoutsAdmin
          user={user}
          owed={owed}
          payouts={payouts}
          events={events}
          notice={c.req.query('notice')}
          error={c.req.query('error')}
        />,
      ),
    );
  });

  app.post('/admin/payouts/verify/:userId', async (c) => {
    const user = requireAdmin(c);
    const done = await r.verifyPayoutAddress({ userId: c.req.param('userId'), actorId: user.id });
    return respond(c, {
      json: { verified: Boolean(done) },
      redirectTo: '/admin/payouts',
      notice: done ? 'Address confirmed.' : null,
      error: done ? null : 'There is no address on that account.',
    });
  });

  app.post('/admin/payouts/schedule/:userId', async (c) => {
    const user = requireAdmin(c);
    const out = await r.schedulePayout({
      influencerId: c.req.param('userId'),
      actorId: user.id,
    });
    return respond(c, {
      json: out,
      redirectTo: '/admin/payouts',
      notice: out.ok ? `Payout ${out.payout.id} scheduled.` : null,
      error: out.ok ? null : out.reason,
    });
  });

  app.post('/admin/payouts/:id/paid', async (c) => {
    const user = requireAdmin(c);
    const body = await c.req.parseBody();
    const done = await r.markPayoutPaid({
      payoutId: c.req.param('id'),
      actorId: user.id,
      externalRef: body.ref ? String(body.ref).slice(0, 200) : null,
    });
    return respond(c, {
      json: { paid: Boolean(done) },
      redirectTo: '/admin/payouts',
      notice: done ? 'Marked paid.' : null,
      error: done ? null : 'That payout is not awaiting settlement.',
    });
  });

  app.post('/admin/payouts/:id/failed', async (c) => {
    const user = requireAdmin(c);
    const body = await c.req.parseBody();
    const done = await r.markPayoutFailed({
      payoutId: c.req.param('id'),
      actorId: user.id,
      reason: body.reason ? String(body.reason).slice(0, 300) : 'no reason given',
    });
    return respond(c, {
      json: { failed: Boolean(done) },
      redirectTo: '/admin/payouts',
      // The money goes back to owed rather than being stranded in a state
      // nothing picks up again.
      notice: done ? 'Marked failed; the allocations are owed again.' : null,
      error: done ? null : 'That payout is not awaiting settlement.',
    });
  });
}
