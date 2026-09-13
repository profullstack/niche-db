/**
 * Premium: the page that sells it, the room it opens, and the four things a
 * member can do that a free account cannot.
 *
 * Every gate here reads `c.get('entitlements')`, which `lib/premium.js` put on
 * the context from the domain package. None of them re-derives what a plan is
 * worth, so there is exactly one answer to "is this included" and the pricing
 * page is rendered from the same object that enforces it.
 */
import { config } from '@nichedb/config';
import { sql } from '@nichedb/db';
import * as premiumDb from '@nichedb/db/premium';
import * as q from '@nichedb/db/queries';
import { priceFor } from '@nichedb/payments/referrals';
import {
  APP_ICONS,
  awardCost,
  awardKinds,
  entitlements,
  isAppIcon,
  isAwardKind,
  isTheme,
  THEMES,
  termById,
  termOptions,
} from '@nichedb/premium';
import { comparisonRows, REDDIT } from '@nichedb/premium/comparison';
import { render, requireUser, respond, wantsJson } from '../lib/http.js';
import {
  awardCheck,
  ensureMonthlyCredits,
  entitlementsOf,
  planOf,
  premiumSnapshot,
  requirePremium,
} from '../lib/premium.js';
import { prices, startPremiumCheckout } from '../lib/premium-checkout.js';
import { Denied } from '../lib/service.js';
import { LoungePage, PremiumPage } from '../views/premium.jsx';

export { prices };

/** The comparison, built from this deployment's own numbers. */
export const rowsForSite = () =>
  comparisonRows({
    ...prices(),
    apiPremiumPerHour: config.api.premiumPerHour,
    monthlyCredits: config.premium.monthlyCredits,
    siteName: config.siteName,
  });

export function registerPremium(app, { checkout = startPremiumCheckout } = {}) {
  /* ----------------------------------------------------------- the pitch -- */

  app.get('/premium', async (c) => {
    const user = c.get('user');
    const plan = planOf(c);
    const terms = termOptions(prices());
    const quotedTerms = await Promise.all(
      terms.map(async (term) => {
        const quote = user
          ? await priceFor(sql, {
              userId: user.id,
              referredBy: user.referred_by,
              amountCents: term.cents,
            }).catch(() => null)
          : null;
        return {
          ...term,
          checkoutCents: quote?.amountCents ?? term.cents,
          discountCents: quote?.discountCents ?? 0,
        };
      }),
    );
    const [members, snapshot] = await Promise.all([
      premiumDb.memberCounts().catch(() => ({})),
      user ? premiumSnapshot(c) : Promise.resolve(null),
    ]);
    return c.html(
      await render(
        <PremiumPage
          user={user}
          plan={plan}
          terms={quotedTerms}
          rows={rowsForSite()}
          reddit={REDDIT}
          members={members}
          snapshot={snapshot}
          selectedTerm={termById(c.req.query('term'), prices())?.id ?? 'month'}
          enabled={config.premium.enabled}
          notice={c.req.query('notice')}
          error={c.req.query('error')}
        />,
      ),
    );
  });

  /** Membership pricing and entitlements, distinct from account-free crawl access. */
  app.get('/api/v1/premium', (c) =>
    c.json({
      plan: planOf(c),
      entitlements: entitlementsOf(c),
      pricing: {
        currency: config.premium.currency,
        terms: termOptions(prices()),
        purchase: `${config.siteUrl}/api/premium/buy`,
        renews: false,
        crawl_pass: { url: `${config.siteUrl}/crawl`, includes_account_perks: false },
      },
      monthly_credits: config.premium.monthlyCredits,
      awards: awardKinds(),
      compared_with: {
        name: REDDIT.name,
        monthly_cents: REDDIT.monthlyCents,
        yearly_cents: REDDIT.yearlyCents,
        captured_on: REDDIT.capturedOn,
        sources: REDDIT.sources.map((s) => s.url),
        rows: rowsForSite(),
      },
    }),
  );

  /* ---------------------------------------------------------------- buying -- */

  app.post('/api/premium/buy', async (c) => {
    const user = requireUser(c);
    const body = c.req.header('content-type')?.includes('application/json')
      ? await c.req.json().catch(() => ({}))
      : await c.req.parseBody().catch(() => ({}));
    const wanted = String(body?.term ?? c.req.query('term') ?? 'month');
    const { checkoutUrl } = await checkout(user, wanted);
    // Keep the provider's origin: the generic respond() helper only redirects locally.
    return wantsJson(c) ? c.json({ checkoutUrl }) : c.redirect(checkoutUrl, 303);
  });

  /* --------------------------------------------------------------- lounge -- */

  /** Member collections, the member directory and this week's awarded items. */
  app.get('/lounge', async (c) => {
    const user = requireUser(c);
    requirePremium(c, 'The Lounge');
    await ensureMonthlyCredits(c);
    const [early, members, awarded, snapshot] = await Promise.all([
      premiumDb.earlyAccessCollections(),
      premiumDb.loungeMembers({ limit: 60 }),
      premiumDb.topAwarded({ targetType: 'item', days: 7, limit: 12 }),
      premiumSnapshot(c),
    ]);
    const items = await Promise.all(awarded.map((a) => q.getItem(Number(a.target_id))));
    const top = awarded
      .map((a, i) => ({ ...a, item: items[i] }))
      .filter((a) => a.item)
      .slice(0, 10);
    return c.html(
      await render(
        <LoungePage
          user={user}
          plan={planOf(c)}
          early={early}
          members={members}
          top={top}
          snapshot={snapshot}
          themes={THEMES}
          icons={APP_ICONS}
          awards={awardKinds()}
          notice={c.req.query('notice')}
          error={c.req.query('error')}
        />,
      ),
    );
  });

  /* ----------------------------------------------------------- appearance -- */

  app.post('/api/premium/appearance', async (c) => {
    const user = requireUser(c);
    requirePremium(c, 'Themes and app icons');
    const body = await c.req.parseBody();
    const theme = String(body.theme ?? 'default');
    const icon = String(body.icon ?? 'default');
    if (!isTheme(theme) || !isAppIcon(icon)) throw new Denied('No such theme or icon.', 400);
    await premiumDb.saveAppearance({ userId: user.id, theme, icon });
    return respond(c, { redirectTo: '/lounge', notice: 'Saved.' });
  });

  /* --------------------------------------------------------------- awards -- */

  /**
   * Give an award. The credits are real: they are granted monthly, spent here,
   * and the ledger is the only place a balance comes from — which is the part
   * Reddit's Coins never had, because Coins were bought and then retired.
   */
  app.post('/api/premium/awards', async (c) => {
    const user = requireUser(c);
    const body = await c.req.parseBody();
    const kind = String(body.kind ?? '');
    const targetType = String(body.target_type ?? 'item');
    const targetId = Number(body.target_id);
    if (!isAwardKind(kind)) throw new Denied('No such award.', 400);
    if (!['item', 'contribution'].includes(targetType)) throw new Denied('No such target.', 400);
    if (!Number.isInteger(targetId) || targetId <= 0) throw new Denied('No such target.', 400);
    await ensureMonthlyCredits(c);

    const check = await awardCheck(c, kind);
    if (!check.ok) throw new Denied(check.reason, check.upsell ? 402 : 400);

    const result = await premiumDb.giveAward({
      userId: user.id,
      targetType,
      targetId,
      kind,
      credits: awardCost(kind),
    });
    if (!result.ok)
      throw new Denied(
        result.reason === 'already awarded'
          ? 'You have already given that award here.'
          : 'Not enough credits.',
        400,
      );
    return respond(c, {
      json: { ok: true, award: result.award, balance: result.balance },
      redirectTo: targetType === 'item' ? `/i/${targetId}` : '/lounge',
      notice: `${kind} awarded.`,
    });
  });

  /** What one thing has been given. Public: an award nobody can see is not one. */
  app.get('/api/v1/awards/:type/:id', async (c) => {
    const type = c.req.param('type');
    const id = Number(c.req.param('id'));
    if (!['item', 'contribution'].includes(type) || !Number.isInteger(id))
      throw new Denied('No such target.', 400);
    const [counts, awards] = await Promise.all([
      premiumDb.awardCounts({ targetType: type, targetId: id }),
      premiumDb.awardsFor({ targetType: type, targetId: id, limit: 20 }),
    ]);
    return c.json({
      target: { type, id },
      counts,
      awards: awards.map((a) => ({
        kind: a.kind,
        credits: a.credits,
        at: a.created_at,
        by: a.display_name ?? a.handle ?? 'a member',
      })),
    });
  });
}

/** Exported for the tests and for llms.txt: what a plan gets, as data. */
export const planTable = () =>
  ['free', 'premium', 'pro'].map((plan) =>
    entitlements(plan, { monthlyCredits: config.premium.monthlyCredits }),
  );
