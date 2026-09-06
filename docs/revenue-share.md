# Revenue share

Two programmes run on this site, both capped at 80%, deliberately kept apart.

| | Who | What they are paid for | Where |
| --- | --- | --- | --- |
| **Partners** | Someone whose writing is already in the index | A share of what a crawler pays to read it | `/sell`, `@profullstack/partners` |
| **Knowledge Influencers** | Someone who knows an industry and operates a niche | A share of what that niche makes | `/opportunities`, `packages/knowledge` |

They are separate ledgers because conflating a commission on somebody else's
traffic with a share of a business you help run makes both impossible to audit.
A person can be both.

## The ladder

Score is verified contribution. Share is what that score is worth.

| Tier | Verified score | Share |
| --- | ---: | ---: |
| Contributor | 0 | 20% |
| Specialist | 100 | 30% |
| Expert | 250 | 40% |
| Lead Expert | 500 | 50% |
| Niche Operator | 900 | 60% |
| Senior Operator | 1,500 | 70% |
| Top Knowledge Influencer | 2,500 | 80% |

The thresholds are data, not code. They are seeded into `contribution_tiers` by
migration `0007` and read back from that table at runtime, so a deployment that
tunes them pays on the numbers it actually has. `CONTRIBUTION_TIERS` in
`packages/knowledge/src/tiers.js` is the shipped default and the fallback.

## Basis points, never floats

Every share is an integer basis point: 2000 is 20%, 8000 is 80%. Every amount is
integer minor units. A share of a dollar computed in floating point is a share
that does not add up, and this programme pays real money on the answer.

`share_cap_bps` on a membership holds one person below what their tier would
give, without editing a table that is global. The programme maximum is the
ceiling over both: nothing can ask for more than 8000.

## More than one person on a niche

`splitShareBps` divides the influencer allocation. Under the 80% ceiling
everyone gets what their tier says. Over it, each is scaled by the same factor
so relative standing survives the squeeze, and the remainder is handed out by
largest-remainder so the parts sum to exactly 8000 rather than to 7999.

## A tier change never rewrites history

`allocate()` uses the shares in force at the moment a revenue event is
finalised. Reaching Expert tomorrow does not reach back and re-pay today's sale
at 40%.

That is what `tier_history` is for: every tier a person has held, with the score
and the share and when it took effect, appended and never updated. Six months
later "your share was 40% when that settled" is something a page can show rather
than something someone has to be believed about.

## What is shared

```
gross
- payment processing
- network fee
- the infrastructure the request actually consumed
- refunds and chargebacks
= attributable net
```

Nothing else comes off. Subtracting a share of the office from a roofer's payout
is how a revenue share becomes an argument, and this one is meant to be
checkable on a page.

Allocation floors every share and gives the platform the remainder, so the parts
always sum to the net exactly and rounding never over-pays.

## Payouts

Not built yet. The states are defined (`PAYOUT_STATES`) and CoinPay is already
the rail this deployment uses for Pro memberships and crawl passes, so there is
no second payment integration to write — only the ledger tables and the wiring.
