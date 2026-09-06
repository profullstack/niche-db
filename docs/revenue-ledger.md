# The revenue ledger

**What a niche earned, whose share of it is whose, and what has been paid.**

Until this existed, a Knowledge Influencer could climb to 80% and the number
was a label on a page. These tables are what stands behind it.

For the ladder itself and how the two revenue-share programmes differ, see
[revenue-share.md](./revenue-share.md).

## The shape

```
an earning arrives
      |  POST /api/v1/internal/revenue-events   (signed, idempotent)
      v
revenue_events            gross, what it cost to take, the remainder
      |
      |  finalised: shares read AT THIS INSTANT and stamped on
      v
revenue_allocations       one row per party, integer minor units
      |
      |  accrued -> scheduled -> paid
      v
payouts + payout_allocations
```

## The two rules everything obeys

**Integer money, integer basis points.** Nothing divides until `formatMinor`
renders a number for a person. A share of a dollar computed in floating point
is a share that does not add up, and this pays real money.

**An allocation records the share that was in force when the event was
finalised.** Reaching Expert tomorrow does not reach back and re-pay yesterday's
sale at 40%. The niche revenue page shows today's split and each settled
allocation's own share side by side, and says why they can disagree.

That second rule is not a convention, it is what the `share_bps` column on
`revenue_allocations` is for. A tier change writes to `tier_history`; it never
touches an allocation.

## What the database refuses

Each of these is a way somebody gets paid twice or paid wrong, so each is a
constraint rather than a code path that has to remember:

| | |
| --- | --- |
| `revenue_events_adds_up` | a row where net is not gross minus cost cannot be written at all |
| `revenue_events_non_negative` | no negative money |
| `external_id` unique | a settlement delivered twice books once |
| `revenue_allocations_once` | one allocation per party per event, including the platform row whose influencer is null |
| `payout_allocations` PK on `allocation_id` | **an allocation belongs to at most one payout**, so the same earning cannot be paid twice however many times the button is pressed |
| `payouts_positive` | a payout of nothing is not a payout |

Finalisation claims the event with `update … where finalized_at is null` inside
the transaction that writes the allocations, so two requests racing to finalise
the same earning produce one split rather than two.

## Payouts

Nothing here sends money, and that is deliberate rather than unfinished.
CoinPay's payout API pays a connected merchant account (us), not an arbitrary
third party's address, so there is no automated disbursement to call. The
partner programme has the same shape: accrue accurately, pay deliberately.

So: an operator saves an address, an admin confirms it, an admin schedules a
payout, the money moves out of band, and the reference is recorded.

Two safeguards worth knowing:

- **Changing an address clears its confirmation.** Whoever confirmed the old
  address did not confirm this one, and someone who reaches an account should
  not inherit that trust.
- **A failed payout returns its allocations to owed** and detaches them, so the
  money is not stranded in a state nothing picks up again.

`schedulePayout` takes the owed rows `for update skip locked`, so two admins
clicking at once take disjoint sets instead of blocking or double-claiming.

## Where earnings come from

Two places. Every paid crawl pass, booked automatically by the gateway's
`onSale` hook and divided across niches by how much of the index each holds
(see [x402-attribution.md](./x402-attribution.md)); and the signed internal
endpoint, for anything else.

```sh
BODY='{"payload":{"nicheSlug":"games","externalId":"pay_1","sourceType":"x402",
       "grossMinor":2000,"processingMinor":60}}'
T=$(date +%s)
MAC=$(printf '%s.%s' "$T" "$BODY" | openssl dgst -sha256 -hmac "$CHOVY_SIGNING_SECRET" -hex | sed 's/.*= *//')
curl -X POST localhost:3000/api/v1/internal/revenue-events \
  -H 'content-type: application/json' -H "x-chovy-signature: t=$T,v1=$MAC" -d "$BODY"
```

## Pages

```
/dashboard/payouts                     owed, address, allocations, payments
/dashboard/niches/<slug>/revenue       one niche's books
/admin/payouts                         who is owed, confirm, schedule, settle
GET /api/v1/me/revenue                 balance and allocations
GET /api/v1/me/payouts
```

## Tests

```sh
bun test test/schema.test.js     # what the database refuses
bun test test/knowledge.test.js  # allocation arithmetic and money rendering
```

The arithmetic (`allocate`, `attributableNetMinor`) is pure and tested without
a database, including that allocations always sum to exactly the net and that
rounding never over-pays.
