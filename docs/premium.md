# Premium

Premium is the standard reader membership, starting at **$1/day**. Pro is the
operator tier at $120 per 30 days and includes every Premium benefit.

## Pricing and purchase

| Term | Upfront price | Daily equivalent |
| --- | --- | --- |
| 24 hours | $1 | $1 |
| 30 days | $30 | $1 |
| 365 days | $300 | $0.82 |

All three terms buy account membership through CoinPay. No term renews
automatically. The year saves $65 (18%) compared with 365 individual $1 days.
Prices come from `PREMIUM_DAY_CENTS`, `PREMIUM_MONTH_CENTS` and
`PREMIUM_YEAR_CENTS`. Referral discounts are quoted independently for each term.

`POST /api/premium/buy` accepts a form or JSON with `term: day|month|year`.
The browser gets the full provider checkout URL as a redirect; API callers get
`checkoutUrl`. The OpenSaaS subscribe endpoint uses the same checkout helper.
A confirmed CoinPay webhook grants the purchased term; `membershipTerm()`
rejects unknown plan/term combinations, while missing legacy Pro metadata
retains the configured Pro term. Extensions stack on the end of the same plan.

The account-free x402 pass at `/crawl` is a separate purchase for automated
access. It does not grant a badge, Lounge access, credits or other account
perks. Pro includes a crawl pass for its full term.

## Included benefits

`entitlements()` in `packages/premium` controls the paid benefits:

| Benefit | Enforcement |
| --- | --- |
| No ads or tracking on pages and authenticated feeds | `decideModules()` and the page/feed builders |
| Lounge and member collections | `requirePremium()` and early-access collection gates |
| Monthly award credits | `loadPlan()` grants once per calendar month; the ledger has a unique user/month reference |
| Useful, Verified and Scoop awards | `giveAward()` spends credits in the same transaction as the award |
| Premium badge and highlighted contributions | Plan lookup for the contribution's author |
| Six themes and five app icons | `themeFor()` and `appIconFor()` validate shipped choices and entitlement |
| Higher API allowance | `apiLimitFor()` reads configured limits |
| Unlimited feeds and own sources | The service checks account entitlements |
| Vehicle lookups | Paid module access |

Credits use `PREMIUM_MONTHLY_CREDITS`, doubled for Pro. A daily member receives
the same calendar-month grant; buying more terms in that month does not grant
more credits. The grant occurs on the first member request that month.

## Pricing page and upsells

`/premium` has day/month/year purchase cards, benefit descriptions, a
Free/Premium/Pro comparison, a Reddit comparison and FAQs. Selected terms
survive sign-in. Upsells appear on the home page, in settings, in navigation,
beside ads and when a paid limit or feature is reached. Paid accounts do not
see the Free-account home/settings upsell.

`/api/v1/premium`, `llms.txt` and the OpenSaaS descriptor publish the same
membership pricing and distinguish it from crawl access. The pricing page is
open to crawlers so they can read the offer before purchasing.

## Reddit comparison

Verified on **2026-09-13** against [Reddit Premium](https://www.reddit.com/premium)
and [Reddit's subscription help page](https://support.reddithelp.com/hc/en-us/articles/360043034412-What-is-a-Reddit-Premium-subscription).
The web prices are $5.99/month and $49.99/year. Reddit lists ad-free browsing,
new-comment highlighting, higher content limits, 100 daily AI search questions,
account performance analytics, custom app icons, avatar accessories and r/lounge.

Our $1 entry purchase is smaller; our standard month and year cost more.
The comparison sells nichedb's data tools, credits and membership extras without
claiming a lower monthly price. Hosted AI search, unread-comment highlighting
and a content analytics dashboard are not included in nichedb Premium.
Unlisted Reddit benefits are labelled unlisted rather than assumed unavailable.
The source URLs and verification date live in `packages/premium/src/comparison.js`.
