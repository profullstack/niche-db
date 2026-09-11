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
import * as pay from '@nichedb/payments';
import { MEMBERSHIP_KIND } from '@nichedb/payments/membership';
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
import { comparisonRows, REDDIT, scoreboard } from '@nichedb/premium/comparison';
import { render, requireUser, respond } from '../lib/http.js';
import {
  awardCheck,
  ensureMonthlyCredits,
  entitlementsOf,
  planOf,
  premiumSnapshot,
  requirePremium,
} from '../lib/premium.js';
import { Denied } from '../lib/service.js';
import { LoungePage, PremiumPage } from '../views/premium.jsx';

/** The three numbers the price of Premium is made of, in one place. */
export const prices = () => ({
  dayCents: config.premium.dayCents,
  monthCents: config.premium.monthCents,
  yearCents: config.premium.yearCents,
});

/** The comparison, built from this deployment's own numbers. */
export const rowsForSite = () =>
  comparisonRows({
    ...prices(),
    apiPremiumPerHour: config.api.premiumPerHour,
    monthlyCredits: config.premium.monthlyCredits,
    siteName: config.siteName,
  });

export function registerPremium(app) {
  /* ----------------------------------------------------------- the pitch -- */

  app.get('/premium', async (c) => {
    const user = c.get('user');
    const plan = planOf(c);
    const terms = termOptions(prices());
    // The referral discount already exists for Pro and is not a different
    // thing here: a code the buyer arrived with takes its cut off whatever
    // term they choose, so the price they are quoted is the price they pay.
    const discount = user
      ? await priceFor(sql, {
          userId: user.id,
          referredBy: user.referred_by,
          amountCents: config.premium.monthCents,
        }).catch(() => null)
      : null;
    const [members, snapshot] = await Promise.all([
      premiumDb.memberCounts().catch(() => ({})),
      user ? premiumSnapshot(c) : Promise.resolve(null),
    ]);
    return c.html(
      await render(
        <PremiumPage
          user={user}
          plan={plan}
          terms={terms}
          rows={rowsForSite()}
          score={scoreboard(rowsForSite())}
          reddit={REDDIT}
          members={members}
          snapshot={snapshot}
          discountCents={discount?.discountCents ?? 0}
          enabled={config.premium.enabled}
          notice={c.req.query('notice')}
          error={c.req.query('error')}
        />,
      ),
    );
  });

  /**
   * The same thing an agent can read. Premium is bought by people, but what it
   * includes is exactly what a crawl pass includes plus the account-shaped
   * parts, and an agent deciding whether to pay should not have to scrape a
   * pricing page to find that out.
   */
  app.get('/api/v1/premium', (c) =>
    c.json({
      plan: planOf(c),
      entitlements: entitlementsOf(c),
      pricing: {
        currency: config.premium.currency,
        terms: termOptions(prices()),
        day_over_x402: `${config.siteUrl}/crawl`,
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
    if (!config.premium.enabled)
      throw new Denied('Payments are not configured on this deployment.', 400);
    const body = await c.req.parseBody().catch(() => ({}));
    const wanted = String(body.term ?? c.req.query('term') ?? 'month');
    const term = termById(wanted, prices());
    if (!term) throw new Denied('No such term.', 400);
    // A single day is not sold through a checkout: it is the x402 crawl pass
    // that already exists, bought by presenting a payment rather than by
    // filling in a form. Sending a person to CoinPay for a dollar would cost
    // them more in confirmation time than the day is worth.
    if (term.id === 'day')
      return respond(c, { json: { crawl: `${config.siteUrl}/crawl` }, redirectTo: '/crawl' });

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
    return respond(c, { json: { checkoutUrl }, redirectTo: checkoutUrl });
  });

  /* --------------------------------------------------------------- lounge -- */

  /**
   * The members' room. Reddit's r/lounge is a subreddit with nothing in it;
   * this one holds the collections members get before everyone else, what the
   * membership is awarding this week, and who else is in here.
   */
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
export const planTable = () => ['free', 'premium', 'pro'].map((plan) => entitlements(plan));
