# x402 attribution

**Let the bots in. Charge them. Pay whoever earned it.**

This deployment already sells crawl passes over x402
(`@profullstack/x402-gateway`, wired in `apps/web/src/lib/pricing.js`). Training
crawlers get a 402 and buy a day for a dollar, less the more they have spent
here. People, search engines and retrieval crawlers pass through untouched.

Nothing in the Knowledge Influencer work changes any of that. There is one
gateway, it is the one already in production, and the protocol version it speaks
is the one it already speaks. Attribution is built *around* it.

## The hook that already exists

`gatewayOptions().onSale` fires when a pass is paid for, with:

```js
{ payer, ref, days, priceCents, totalCents, currency, userAgent, expiresAt }
```

It already does two things: records the sale in `crawl_sales` (so a buyer's
lifetime spend can set their price) and splits it between partners. Phase 4 adds
a third: normalise it into a ledger event and attribute it to a niche.

`onSale` is awaited. A hook that returns a promise the gateway does not wait for
loses the sale on an edge runtime while the buyer keeps the pass, so anything
added here returns its promise — and, like the partner split, must never be
allowed to fail the sale. The money has already moved; a split that can be
retried is worth more than a 500 to a paying customer.

## The normalised event

`machineRevenueEvent(sale, { property, nicheId, resourceId })` in
`packages/knowledge/src/events.js` turns that object into:

```js
{
  eventId: 'x402:<ref>',      // the payment reference, so a redelivery books once
  property, nicheId, resourceId, path,
  consumerId: sale.payer,
  sourceType: 'x402',
  amountMinor,                 // integer cents, never a float
  currency, paymentRef,
  requestCount, bytesServed, occurredAt,
}
```

Idempotency is the payment reference and nothing else. A settlement delivered
twice is one row.

A sale with no `ref` is not a ledger event and returns null, because there is
nothing to be idempotent on.

## Attribution

Only this side knows whose rows were in the crawl that got paid for, which is
why the gateway does not attempt it. Where a resource maps to a niche, the sale
is attributed to that niche and divided by `allocate()` between its members and
the platform. A sale nobody operates goes entirely to the platform. Not every
request needs a Knowledge Influencer attached.

## What is open, and why

The gateway's `openPaths` carries `/opportunities` alongside `/sell`. Both are
recruiting pages, and charging a crawler to read the page that tells someone
they can be paid for what they know is an odd way to run a marketplace.

`/<niche>/skill.md` and `/<niche>/manifest.json` are **not** open. `openPaths`
matches exactly, or by prefix when an entry ends in a slash, and a per-niche path
is neither. They are charged like any other page for a training crawler. If they
should be free, the shape to add is a prefix the gateway can match, not a
wildcard it cannot.

Note also that the gateway's spoofed-browser check runs before `openPaths`: a
request with a browser user-agent and no `Sec-Fetch` headers gets a 402 even on
a documented-open path.

## Machine audience metrics

`/api/v1/influencers/<handle>` reports verified contributions and tier. It does
not report machine citations, and it will not: a number nobody can measure is
not a metric. Paid requests, unique consumers and paid bytes are all real
figures the gateway and `crawl_sales` already hold, and those are the ones a
profile may show.
