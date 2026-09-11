# Premium

Premium is the tier a person buys, at the house price of **a dollar a day**.
Pro, at $120 a month, is the operator tier and stays what it was. Free stays
free, with one ad and one tracker on it.

The tier exists in the shape it does because Reddit Premium is the
subscription every reader has already been offered, so it is the one ours gets
measured against. The answer is not to be cheaper per month than $5.99; it is
to include a product rather than an ad switch, and to sell a single day to
somebody who only wants a day.

## What it costs

| Term | Price | Per day |
| --- | --- | --- |
| A day | $1, bought over x402 at `/crawl` | $1 |
| A month | $30 through CoinPay | $1 |
| A year | $300 through CoinPay | $0.82 |

`PREMIUM_DAY_CENTS`, `PREMIUM_MONTH_CENTS`, `PREMIUM_YEAR_CENTS`,
`PREMIUM_MONTHLY_CREDITS` and `API_PREMIUM_PER_HOUR` are the configuration.
Nothing in the code carries a price of its own; the pricing page, `llms.txt`
and `/api/v1/premium` all read those.

A day is deliberately not a checkout. It is the crawl pass that already
existed, presented as `x-crawl-pass`, because sending a person through a crypto
confirmation for a dollar costs them more in waiting than the day is worth.

## What it includes, and where each one is enforced

Everything below is decided by `entitlements(plan)` in `packages/premium`,
which is pure and has neither a database nor a request in it. The pricing page
renders from the same object, so a benefit cannot be advertised without being
granted first — `test/premium.test.js` fails if the two drift.

| Benefit | Enforced in |
| --- | --- |
| No ads, no tracking, on pages and inside feeds | `decideModules()` in `apps/web/src/lib/modules.js`; the layout and the feed builders read `currentModules()` |
| The Lounge (`/lounge`) | `requirePremium()` in `apps/web/src/routes/premium.js` |
| Monthly credits | `ensureMonthlyCredits()`, granted under `grant:<YYYY-MM>` against a unique index |
| Awards on items and contributions | `giveAward()` in `packages/db/src/premium.js`, charged in the same transaction |
| The badge | `plansForUsers()` plus `<PlanBadge>`; the plan is looked up for the person being shown, not the reader |
| Highlighted contributions | the `highlighted` class on a niche page's contribution rows |
| Themes and app icons | `themeFor()` / `appIconFor()`, which return the default for a plan that is not entitled and can only ever return a value we ship |
| Early access | the `early_access` column on `collections`, gated in `/c/:slug`, `/i/:id` and the landing list |
| The higher API allowance | `apiLimitFor()` in the `/api/v1/*` rate limiter |
| Unlimited feeds, own sources | `entitlements(await planOfUser(user))` in `apps/web/src/lib/service.js` |
| Vehicle lookups included | `modules.paid`, which a member sets |

Pro is a superset of Premium by construction, and a test asserts it benefit by
benefit. Somebody paying four times as much must never find out that the
cheaper tier had something theirs did not.

## The data

Migration `0016_premium.sql`:

- `memberships.plan` (`premium` | `pro`, default `pro`). Every existing row
  meant Pro, which is exactly what the default says, so there is no backfill.
- `users.premium_theme`, `users.premium_icon` — two scalar columns rather than
  a jsonb blob, because both are single values from a fixed list.
- `premium_credits` — an append-only ledger. A grant is a positive row, a
  spend a negative one, and the balance is the sum. `(user_id, ref)` is unique
  where `ref` is not null, which is what makes the monthly grant idempotent.
- `premium_awards` — one row per (giver, target, kind), unique, so awarding the
  same thing twice is one award and one charge.
- `collections.early_access` — off everywhere, so the site after the migration
  is the site before it.

A term stacks on the end of the last term **of the same plan**. Buying a month
of Premium while three weeks of Pro are still running gives a month of Premium
starting now, not a month that begins after Pro ends.

## The money

Through the CoinPay flow this repo already had. `/api/premium/buy` creates a
checkout whose metadata carries `kind=membership`, `plan=premium` and
`term_days`; the existing `/api/webhooks/coinpay` grants on a settled payment,
validating both against what is actually for sale rather than trusting the
numbers that arrive. No new payment provider, and the single-day path is the
x402 gateway that already sells crawl passes.

## Upselling

Three places, all of them where the missing thing is:

- beside the ad, in the layout, because the only honest moment to sell an
  ad-free tier is next to the ad it removes;
- on the settings page, where somebody is already deciding what their account
  should be;
- at a limit — the API 429 body names the Premium allowance and its price, the
  vehicle-lookup 402 does the same, and a refused Lounge or early-access
  request lands on `/premium` with the reason on it rather than flashing an
  error on the page they were already reading.

## Reddit's numbers

$5.99 a month, $49.99 a year; ad-free browsing, r/lounge, custom app icons and
avatar gear, longer posts and video uploads, new-comment flagging and basic
post stats. The 700-Coins-a-month allowance was retired in 2023 and never
replaced, and early access to features is explicitly not included.

Captured 2026-09-11. `reddit.com/premium` answers anything that is not a
logged-in browser with "You've been blocked by network security" and the Reddit
help centre returns 403 to the same fetchers, so the figures come from two
independent write-ups published that month which agree on both the price and
the list. They are in `packages/premium/src/comparison.js` with their URLs and
the capture date beside them, and the pricing page prints all of it. **Re-check
them before quoting them in an ad.**
