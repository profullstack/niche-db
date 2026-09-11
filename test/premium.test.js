/**
 * Premium: the entitlement table, the money, the ledger and the page.
 *
 * The point of the first half is that a benefit sold on /premium is a gate in
 * code, not a line of copy: every row of the comparison table has to be
 * reachable from `entitlements()`, and the plan that gets it has to be the plan
 * the page says. The second half runs the ledger and the grant against a real
 * Postgres in process, because "may not spend credits twice" is entirely a
 * statement about what the database does under a race.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';

const {
  appIconFor,
  atLeast,
  awardCost,
  bestPlan,
  canAward,
  creditGrantRef,
  entitlements,
  isAwardKind,
  isTheme,
  MONTHLY_CREDITS,
  planFor,
  termById,
  termOptions,
  themeFor,
} = await import('../packages/premium/src/index.js');
const { comparisonRows, REDDIT, scoreboard } = await import(
  '../packages/premium/src/comparison.js'
);
const { ALL_ON, decideModules } = await import('../apps/web/src/lib/modules.js');

const PRICES = { dayCents: 100, monthCents: 3000, yearCents: 30000 };
const future = new Date(Date.now() + 86_400_000).toISOString();
const past = new Date(Date.now() - 86_400_000).toISOString();

describe('which plan somebody holds', () => {
  test('no user is free, and an admin is Pro without buying anything', () => {
    expect(planFor({ user: null })).toBe('free');
    expect(planFor({ user: { role: 'admin' }, terms: [] })).toBe('pro');
  });

  test('an expired term is not a plan', () => {
    expect(
      planFor({ user: { role: 'user' }, terms: [{ plan: 'premium', expires_at: past }] }),
    ).toBe('free');
  });

  test('the best unexpired term wins, whatever order the rows arrive in', () => {
    const user = { role: 'user' };
    const premium = { plan: 'premium', expires_at: future };
    const pro = { plan: 'pro', expires_at: future };
    expect(planFor({ user, terms: [premium, pro] })).toBe('pro');
    expect(planFor({ user, terms: [pro, premium] })).toBe('pro');
    expect(planFor({ user, terms: [premium] })).toBe('premium');
  });

  test('a row with no plan is a legacy Pro membership, because that is all there was', () => {
    expect(planFor({ user: { role: 'user' }, terms: [{ expires_at: future }] })).toBe('pro');
  });

  test('bestPlan and atLeast order the three', () => {
    expect(bestPlan('free', 'premium')).toBe('premium');
    expect(bestPlan('pro', 'premium')).toBe('pro');
    expect(bestPlan('nonsense', 'free')).toBe('free');
    expect(atLeast('premium', 'premium')).toBe(true);
    expect(atLeast('premium', 'pro')).toBe(false);
    expect(atLeast('pro', 'premium')).toBe(true);
  });
});

describe('what each plan is entitled to', () => {
  test('free carries the ad and the tracker and gets none of the rest', () => {
    const free = entitlements('free');
    expect(free.ads).toBe(true);
    expect(free.tracking).toBe(true);
    expect(free.badge).toBeNull();
    expect(free.lounge).toBe(false);
    expect(free.awards).toBe(false);
    expect(free.appearance).toBe(false);
    expect(free.earlyAccess).toBe(false);
    expect(free.monthlyCredits).toBe(0);
    expect(free.unlimitedFeeds).toBe(false);
    expect(free.ownSources).toBe(false);
  });

  test('premium turns the ads off and opens everything Reddit sells', () => {
    const premium = entitlements('premium');
    expect(premium.ads).toBe(false);
    expect(premium.tracking).toBe(false);
    expect(premium.badge).toBe('premium');
    expect(premium.lounge).toBe(true);
    expect(premium.awards).toBe(true);
    expect(premium.appearance).toBe(true);
    expect(premium.earlyAccess).toBe(true);
    expect(premium.highlight).toBe(true);
    expect(premium.monthlyCredits).toBe(MONTHLY_CREDITS.premium);
    expect(premium.apiTier).toBe('premium');
  });

  test('Premium grants more credits a month than Reddit ever did', () => {
    // Reddit's drip was 700 Coins a month, and it was retired in 2023.
    expect(MONTHLY_CREDITS.premium).toBeGreaterThan(700);
  });

  /**
   * The rule that keeps the two paid tiers honest. Pro costs four times as
   * much; a Pro member finding out that a benefit is Premium-only would be a
   * bug in the price list, not a feature.
   */
  test('Pro is a superset of Premium, benefit by benefit', () => {
    const premium = entitlements('premium');
    const pro = entitlements('pro');
    for (const key of ['lounge', 'awards', 'appearance', 'earlyAccess', 'highlight']) {
      expect(pro[key]).toBe(premium[key]);
    }
    expect(pro.ads).toBe(false);
    expect(pro.monthlyCredits).toBeGreaterThanOrEqual(premium.monthlyCredits);
    expect(pro.crawlPass).toBe(true);
    expect(premium.crawlPass).toBe(false);
  });

  test('an unknown plan is free, never a crash and never an upgrade', () => {
    expect(entitlements('platinum').plan).toBe('free');
    expect(entitlements(undefined).ads).toBe(true);
  });
});

describe('ads follow the plan, not the copy', () => {
  test('a member never carries an ad or a tracker, and never has to ask', () => {
    for (const plan of ['premium', 'pro']) {
      const m = decideModules({ plan, paid: true, disable: undefined });
      expect(m.ads).toBe(false);
      expect(m.tracking).toBe(false);
      expect(m.paid).toBe(true);
      expect(m.premium).toBe(true);
      expect(m.plan).toBe(plan);
    }
    expect(decideModules({ plan: 'pro', paid: true }).pro).toBe(true);
    expect(decideModules({ plan: 'premium', paid: true }).pro).toBe(false);
  });

  test('a free reader gets everything on however they ask', () => {
    expect(decideModules({ plan: 'free', paid: false, disable: 'ads,tracking' })).toBe(ALL_ON);
  });

  test('a pass holder keeps the choice it paid for', () => {
    const m = decideModules({ plan: 'free', paid: true, disable: 'ads' });
    expect(m).toEqual({
      ads: false,
      tracking: true,
      paid: true,
      pro: false,
      premium: false,
      plan: 'free',
    });
  });
});

describe('awards and credits', () => {
  test('an award has a price and an unknown one has none', () => {
    expect(awardCost('useful')).toBe(50);
    expect(awardCost('scoop')).toBe(250);
    expect(awardCost('gold')).toBeNull();
    expect(isAwardKind('verified')).toBe(true);
    expect(isAwardKind('__proto__')).toBe(false);
  });

  test('a free account is told to buy Premium; a member is told the balance', () => {
    const free = canAward({ plan: 'free', balance: 10_000, kind: 'useful' });
    expect(free.ok).toBe(false);
    expect(free.upsell).toBe(true);

    const broke = canAward({ plan: 'premium', balance: 10, kind: 'scoop' });
    expect(broke.ok).toBe(false);
    expect(broke.reason).toContain('250');

    expect(canAward({ plan: 'premium', balance: 250, kind: 'scoop' })).toEqual({
      ok: true,
      cost: 250,
    });
  });

  test('the monthly grant is keyed by the calendar month', () => {
    expect(creditGrantRef(new Date('2026-09-11T00:00:00Z'))).toBe('grant:2026-09');
    expect(creditGrantRef(new Date('2026-09-30T23:59:59Z'))).toBe('grant:2026-09');
    expect(creditGrantRef(new Date('2026-10-01T00:00:00Z'))).toBe('grant:2026-10');
  });
});

describe('appearance is an entitlement, not a preference', () => {
  test('a free account keeps the default however its row reads', () => {
    expect(themeFor({ plan: 'free', theme: 'ultraviolet' })).toBe('default');
    expect(appIconFor({ plan: 'free', icon: 'ember' })).toBe('logo.svg');
  });

  test('a member gets what they chose', () => {
    expect(themeFor({ plan: 'premium', theme: 'mint' })).toBe('mint');
    expect(appIconFor({ plan: 'pro', icon: 'mono' })).toBe('icons/app-mono.svg');
  });

  test('a value we do not ship can never reach the page', () => {
    expect(isTheme('../../etc/passwd')).toBe(false);
    expect(themeFor({ plan: 'pro', theme: '"><script>' })).toBe('default');
    expect(appIconFor({ plan: 'pro', icon: '../../secret.svg' })).toBe('logo.svg');
  });
});

describe('what it costs', () => {
  const terms = termOptions(PRICES);

  test('a dollar a day is the unit, and the longer terms discount it', () => {
    expect(terms.map((t) => t.id)).toEqual(['day', 'month', 'year']);
    expect(terms[0].cents).toBe(100);
    expect(terms[1].cents).toBe(3000);
    expect(terms[1].savedPercent).toBe(0);
    // A year at the day rate is $365; we ask $300.
    expect(terms[2].savedCents).toBe(6500);
    expect(terms[2].savedPercent).toBe(18);
  });

  test('only a term we sell can be bought', () => {
    expect(termById('month', PRICES).days).toBe(30);
    expect(termById('decade', PRICES)).toBeNull();
    expect(termById('__proto__', PRICES)).toBeNull();
  });
});

describe('the comparison with Reddit Premium', () => {
  const rows = comparisonRows({ ...PRICES, siteName: 'nichedb' });

  test("Reddit's price is the one captured, and it is dated and sourced", () => {
    expect(REDDIT.monthlyCents).toBe(599);
    expect(REDDIT.yearlyCents).toBe(4999);
    expect(REDDIT.capturedOn).toBe('2026-09-11');
    expect(REDDIT.sources.length).toBeGreaterThanOrEqual(2);
    for (const s of REDDIT.sources) expect(s.url).toStartWith('https://');
  });

  test('we beat them on most rows and admit the one we do not', () => {
    const score = scoreboard(rows);
    expect(score.ours).toBeGreaterThan(score.theirs);
    const price = rows.find((r) => r.feature === 'Price');
    expect(price.wins).toBe(false);
    expect(price.note).toContain('more');
  });

  test('the cheapest way in is a dollar, against their $5.99 minimum', () => {
    expect(PRICES.dayCents).toBeLessThan(REDDIT.entryCents);
    expect(rows[0].ours).toContain('$1');
  });

  /**
   * Every benefit Reddit lists has to have an answer, and every answer has to
   * be something this codebase actually enforces. This is the test that stops
   * the pricing page growing a promise the entitlement table has never heard
   * of.
   */
  test('every Reddit benefit has a row, and every row we win is an entitlement', () => {
    const features = rows.map((r) => r.feature);
    for (const expected of [
      'Ad-free',
      'Members-only room',
      'Badge',
      'Monthly credits',
      'Themes and icons',
      'Higher limits',
      'Early access',
    ]) {
      expect(features).toContain(expected);
    }
    const premium = entitlements('premium');
    const gates = {
      'Ad-free': !premium.ads,
      'No tracking': !premium.tracking,
      'Members-only room': premium.lounge,
      Badge: premium.badge === 'premium',
      'Monthly credits': premium.monthlyCredits > 0,
      Awards: premium.awards,
      'Themes and icons': premium.appearance,
      'Early access': premium.earlyAccess,
      'Higher limits': premium.unlimitedFeeds && premium.ownSources,
    };
    for (const [feature, enforced] of Object.entries(gates)) {
      expect(features).toContain(feature);
      expect(enforced).toBe(true);
    }
  });

  test('the table reads this deployment’s own prices, not hard-coded ones', () => {
    const dear = comparisonRows({ dayCents: 250, monthCents: 6000, yearCents: 60000 });
    expect(dear[1].ours).toContain('$2.50');
  });
});

/* ---------------------------------------------------------- the real rows -- */

let db;
beforeAll(async () => {
  db = await new PGlite({ extensions: { citext, pg_trgm } });
  const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
  for (const f of (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort()) {
    await db.exec(await readFile(dir + f, 'utf8'));
  }
}, 60_000);

const rows = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (sql, params) => (await rows(sql, params))[0];
const user = async () =>
  (await one(`insert into users (email) values ($1) returning id`, [`u${Math.random()}@t.test`]))
    .id;

/** The statement `grantCredits` runs, kept identical to the query. */
const GRANT = `
  insert into premium_credits (user_id, delta, reason, ref)
  values ($1, $2, $3, $4) on conflict do nothing returning id`;

describe('the credit ledger, against a real Postgres', () => {
  test('a month may only be granted once, however many times the granter runs', async () => {
    const id = await user();
    const first = await rows(GRANT, [id, 1000, 'monthly:premium', 'grant:2026-09']);
    const again = await rows(GRANT, [id, 1000, 'monthly:premium', 'grant:2026-09']);
    const october = await rows(GRANT, [id, 1000, 'monthly:premium', 'grant:2026-10']);
    expect(first).toHaveLength(1);
    expect(again).toHaveLength(0);
    expect(october).toHaveLength(1);
    const [{ balance }] = await rows(
      `select coalesce(sum(delta), 0)::int as balance from premium_credits where user_id = $1`,
      [id],
    );
    expect(balance).toBe(2000);
  });

  test('two people granting the same month do not collide with each other', async () => {
    const a = await user();
    const b = await user();
    await rows(GRANT, [a, 1000, 'monthly:premium', 'grant:2026-09']);
    const other = await rows(GRANT, [b, 1000, 'monthly:premium', 'grant:2026-09']);
    expect(other).toHaveLength(1);
  });

  test('a spend is a negative row and the balance is their sum', async () => {
    const id = await user();
    await rows(GRANT, [id, 1000, 'monthly:premium', 'grant:2026-09']);
    await rows(GRANT, [id, -250, 'award:scoop', 'award:1']);
    const [{ balance }] = await rows(
      `select coalesce(sum(delta), 0)::int as balance from premium_credits where user_id = $1`,
      [id],
    );
    expect(balance).toBe(750);
  });
});

describe('awards, against a real Postgres', () => {
  const AWARD = `
    insert into premium_awards (user_id, target_type, target_id, kind, credits)
    values ($1, $2, $3, $4, $5)
    on conflict (user_id, target_type, target_id, kind) do nothing returning id`;

  test('the same award on the same thing is given once', async () => {
    const id = await user();
    expect(await rows(AWARD, [id, 'item', 7, 'useful', 50])).toHaveLength(1);
    expect(await rows(AWARD, [id, 'item', 7, 'useful', 50])).toHaveLength(0);
    // A different award on the same item is a different award.
    expect(await rows(AWARD, [id, 'item', 7, 'scoop', 250])).toHaveLength(1);
  });

  test('only the two target kinds the schema knows are accepted', async () => {
    const id = await user();
    await expect(rows(AWARD, [id, 'user', 7, 'useful', 50])).rejects.toThrow();
  });
});

describe('memberships carry a plan', () => {
  test('an existing term with no plan named is Pro, which is what it always meant', async () => {
    const id = await user();
    const row = await one(
      `insert into memberships (user_id, started_at, expires_at, price_cents)
       values ($1, now(), now() + interval '30 days', 12000) returning plan`,
      [id],
    );
    expect(row.plan).toBe('pro');
  });

  test('a plan the price list does not have cannot be stored', async () => {
    const id = await user();
    await expect(
      rows(
        `insert into memberships (user_id, started_at, expires_at, price_cents, plan)
         values ($1, now(), now() + interval '30 days', 3000, 'platinum')`,
        [id],
      ),
    ).rejects.toThrow();
  });

  test('a Premium term does not make somebody Pro', async () => {
    const id = await user();
    await rows(
      `insert into memberships (user_id, started_at, expires_at, price_cents, plan)
       values ($1, now(), now() + interval '30 days', 3000, 'premium')`,
      [id],
    );
    // The query isProUser runs, which is plan-scoped for exactly this reason.
    const pro = await rows(
      `select 1 from memberships where user_id = $1 and expires_at > now() and plan = 'pro'`,
      [id],
    );
    expect(pro).toHaveLength(0);
    const terms = await rows(
      `select plan, expires_at from memberships where user_id = $1 and expires_at > now()`,
      [id],
    );
    expect(planFor({ user: { role: 'user' }, terms })).toBe('premium');
  });

  test('a term stacks on the end of its own plan, not on the other one', async () => {
    const id = await user();
    // Three weeks of Pro are already running.
    await rows(
      `insert into memberships (user_id, started_at, expires_at, price_cents, plan)
       values ($1, now(), now() + interval '21 days', 12000, 'pro')`,
      [id],
    );
    // The statement grantMembership runs for a month of Premium.
    const premium = await one(
      `insert into memberships (user_id, started_at, expires_at, price_cents, currency, plan)
       select $1, s.start_at, s.start_at + make_interval(days => 30), 3000, 'USD', 'premium'
       from (select greatest(now(), coalesce(max(expires_at), now())) as start_at
             from memberships where user_id = $1 and plan = 'premium') s
       returning started_at, expires_at`,
      [id],
    );
    const startsWithinTheHour =
      Math.abs(new Date(premium.started_at).getTime() - Date.now()) < 3_600_000;
    expect(startsWithinTheHour).toBe(true);
  });
});

describe('early access is a column, not a convention', () => {
  test('no collection is hidden by the migration itself', async () => {
    const hidden = await rows(`select slug from collections where early_access`);
    expect(hidden).toEqual([]);
  });

  test('a collection can be opened to members and then to everyone', async () => {
    await rows(
      `insert into collections (slug, name, early_access) values ($1, 'Members first', true)`,
      ['early-test'],
    );
    expect(
      (await one(`select early_access from collections where slug = 'early-test'`)).early_access,
    ).toBe(true);
    await rows(`update collections set early_access = false where slug = 'early-test'`);
    expect(
      (await one(`select early_access from collections where slug = 'early-test'`)).early_access,
    ).toBe(false);
  });
});
