/**
 * The pricing page, rendered.
 *
 * A comparison table is a claim about a competitor with our name on it, so the
 * things worth asserting are the things that would be embarrassing: a price
 * that does not match the configuration, a Reddit row with no source beside
 * it, a benefit listed that the entitlement table does not grant, and the
 * upsell appearing on a page belonging to somebody who has already paid.
 */
import { describe, expect, test } from 'bun:test';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';
process.env.PREMIUM_DAY_CENTS ??= '100';
process.env.PREMIUM_MONTH_CENTS ??= '3000';
process.env.PREMIUM_YEAR_CENTS ??= '30000';

// Imported by path, not by package name: this directory is outside every
// workspace, so the linked names only resolve from inside apps/web.
const { config } = await import('../packages/config/src/index.js');
const { entitlements, termOptions, THEMES, APP_ICONS, awardKinds } = await import(
  '../packages/premium/src/index.js'
);
const { comparisonRows, REDDIT, scoreboard } = await import(
  '../packages/premium/src/comparison.js'
);
const { PremiumPage, PlanBadge, AwardForm } = await import('../apps/web/src/views/premium.jsx');
const { withModules, decideModules } = await import('../apps/web/src/lib/modules.js');
const { Layout } = await import('../apps/web/src/views/Layout.jsx');

const prices = {
  dayCents: config.premium.dayCents,
  monthCents: config.premium.monthCents,
  yearCents: config.premium.yearCents,
};
const rows = comparisonRows({ ...prices, siteName: config.siteName });

/**
 * The page as a string, the way a request would get it.
 *
 * The components are called rather than written as JSX, because this file
 * lives outside apps/web and Bun's isolated linker keeps `hono` beside the
 * workspace that depends on it: a JSX tag here would need a jsx-runtime the
 * test directory cannot resolve. Calling the component is the same call the
 * runtime would make.
 */
const renderPremium = (props = {}) =>
  withModules(decideModules({ plan: props.plan ?? 'free', paid: false }), () =>
    PremiumPage({
      user: props.user ?? null,
      plan: props.plan ?? 'free',
      terms: termOptions(prices),
      rows,
      score: scoreboard(rows),
      reddit: REDDIT,
      members: props.members ?? {},
      snapshot: props.snapshot ?? null,
      discountCents: 0,
      enabled: props.enabled ?? true,
    }).toString(),
  );

describe('the pricing page', () => {
  test('quotes the three prices this deployment is configured with', async () => {
    const html = await renderPremium();
    expect(html).toContain('$1 a day');
    expect(html).toContain('$30 a month');
    expect(html).toContain('$300 a year');
  });

  test('names Reddit, its price, and where the price came from', async () => {
    const html = await renderPremium();
    expect(html).toContain('Reddit Premium');
    expect(html).toContain('$5.99');
    expect(html).toContain('$49.99');
    expect(html).toContain(REDDIT.capturedOn);
    for (const source of REDDIT.sources) expect(html).toContain(source.url);
  });

  test('every comparison row is on the page, both sides of it', async () => {
    const html = await renderPremium();
    for (const row of rows) {
      expect(html).toContain(row.feature);
    }
    // The row we lose is on the page too, with the admission attached.
    const price = rows.find((r) => !r.wins);
    expect(html).toContain(price.note);
  });

  test('the benefits it lists are the ones the entitlement table grants', async () => {
    const html = await renderPremium();
    const premium = entitlements('premium');
    expect(premium.lounge && html.includes('The Lounge')).toBe(true);
    expect(premium.awards && html.includes('Awards')).toBe(true);
    expect(premium.earlyAccess && html.includes('Early access')).toBe(true);
    expect(premium.appearance && html.includes('Themes and app icons')).toBe(true);
    expect(html).toContain(config.premium.monthlyCredits.toLocaleString('en-US'));
    expect(html).toContain(config.api.premiumPerHour.toLocaleString('en-US'));
  });

  test('a signed-out visitor is asked to sign in; a signed-in one is offered the terms', async () => {
    expect(await renderPremium()).toContain('/login?next=/premium');
    const signedIn = await renderPremium({ user: { id: 'u1', email: 'a@b.test' } });
    expect(signedIn).toContain('/api/premium/buy');
    expect(signedIn).toContain('value="year"');
  });

  test('a deployment with no payments configured says so rather than offering a dead button', async () => {
    const html = await renderPremium({ user: { id: 'u1' }, enabled: false });
    expect(html).not.toContain('/api/premium/buy');
    expect(html).toContain('Payments are not configured');
  });

  test('a member is told they are one, and how many credits they hold', async () => {
    const html = await renderPremium({
      user: { id: 'u1' },
      plan: 'premium',
      snapshot: { balance: 950, terms: [{ expires_at: '2026-12-01T00:00:00Z' }] },
    });
    expect(html).toContain('You are premium');
    expect(html).toContain('950 credits');
  });
});

describe('the upsell appears where the thing it sells is missing', () => {
  const page = (plan) =>
    withModules(decideModules({ plan, paid: plan !== 'free' }), () =>
      Layout({ user: null, children: 'hello' }).toString(),
    );

  test('a free page carries the ad and the offer to remove it', async () => {
    process.env.CRAWLPROOF_AD_SLOT = 'slot-for-the-test';
    const { config: fresh } = await import('../packages/config/src/index.js');
    expect(fresh.ads.enabled).toBe(true);
    const html = await page('free');
    expect(html).toContain('data-cp-ad');
    expect(html).toContain('/premium');
    expect(html).toContain('Premium turns both off');
  });

  test("a member's page carries neither the ad nor the pitch for it", async () => {
    const html = await page('premium');
    expect(html).not.toContain('data-cp-ad');
    expect(html).not.toContain('Premium turns both off');
    // And the nav offers the room instead of the price.
    expect(html).toContain('/lounge');
  });

  test('a free page links to the price instead of the room', async () => {
    const html = await page('free');
    expect(html).toContain('class="premium-link"');
    expect(html).not.toContain('>Lounge<');
  });

  test('the tracker is not loaded for a member', async () => {
    process.env.CRAWLPROOF_SITE_ID = 'site-for-the-test';
    expect(await page('premium')).not.toContain('crawlproof.com/stats.js');
  });
});

describe('the badge and the award form', () => {
  test('a free account gets no badge at all', () => {
    expect(PlanBadge({ plan: 'free' })).toBeNull();
    expect(String(PlanBadge({ plan: 'premium' }))).toContain('plan-premium');
    expect(String(PlanBadge({ plan: 'pro' }))).toContain('plan-pro');
  });

  test('a free reader is offered Premium rather than a form that would be refused', () => {
    const free = String(
      AwardForm({
        targetType: 'item',
        targetId: 1,
        awards: awardKinds(),
        plan: 'free',
        balance: 0,
      }),
    );
    expect(free).toContain('/premium');
    expect(free).not.toContain('<form');

    const member = String(
      AwardForm({
        targetType: 'item',
        targetId: 1,
        awards: awardKinds(),
        plan: 'premium',
        balance: 500,
      }),
    );
    expect(member).toContain('/api/premium/awards');
    expect(member).toContain('500 credits left');
    for (const award of awardKinds()) expect(member).toContain(award.label);
  });
});

describe('the themes and icons on offer are ones that exist', () => {
  test('every theme is defined in the stylesheet', async () => {
    const css = await Bun.file(
      new URL('../apps/web/public/styles.css', import.meta.url).pathname,
    ).text();
    for (const theme of THEMES) {
      if (theme.free) continue;
      // Biome normalises the attribute quotes, so match on the value alone.
      expect(css).toContain(`[data-theme="${theme.id}"]`);
    }
  });

  test('every icon file ships in the image', async () => {
    for (const icon of APP_ICONS) {
      const file = Bun.file(new URL(`../apps/web/public/${icon.file}`, import.meta.url).pathname);
      expect(await file.exists()).toBe(true);
    }
  });
});
