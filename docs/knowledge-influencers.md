# Knowledge Influencers

**Know the niche. Run the AI.**

A Knowledge Influencer is a person who knows how an industry actually works and
supervises the agents building software, data and promotion for it. They do not
have to write code. What they contribute is the part the agents do not have:
judgement, terminology, customer pain, which sources are worth reading, and
which of the obvious answers is wrong.

They start at **20%** of the revenue their niche makes and can reach **80%**.

This document covers Phase 1: niches, claims, contributions, scoring and tiers.
The revenue ledger and the Chovy agent loop are later phases; the contracts they
arrive through are already defined in `packages/knowledge/src/events.js`.

## The model

| Thing | What it is |
| --- | --- |
| **niche** | A bounded market: `commercial-roofing`, `packages`, `filings`. Not the same as a `collection`, which is a shape of data this deployment ingests. A niche may point at one. |
| **opportunity** | Why a niche is worth operating, in dimensions rather than one number. |
| **claim** | Someone applying to operate a niche, with their answers to ten questions. |
| **member** | An approved operator, specialist or observer on a niche. |
| **contribution event** | One scored thing a human did, with evidence. |
| **tier** | Score in, revenue share out. Seven rungs from 20% to 80%. |

## The surfaces

| Route | What it is |
| --- | --- |
| `/opportunities` | Every niche looking for someone who knows it. |
| `/opportunities/<slug>` | One niche's pitch, its score dimensions, and the application form. |
| `/<slug>` | The niche's public page: what it is, who runs it, what has been built. |
| `/<slug>/skill.md` | The same, for an agent. |
| `/<slug>/manifest.json` | Feeds, APIs, datasets and the x402 terms, machine-readable. |
| `/@<handle>` | A Knowledge Influencer's public profile. |
| `/dashboard/niches` | The operator's own view: what the agent is asking, score, tier, distance to the next rung. |
| `/dashboard/niches/<slug>/questions` | One niche's question queue. |
| `/admin/knowledge` | Claims and contributions awaiting a human, and the audit log. |

A niche page is served from the site root because that is where somebody
searching for their own industry expects to find it. Two things stop it
shadowing a real page: a niche may not take a slug the site already uses
(`RESERVED_NICHE_SLUGS`, refused when the niche is created and backed by a shape
check in the database), and the route is registered after every other one.

`/@handle` is answered by the same handler. Hono does not match a parameter
behind a literal prefix inside a segment, so `/@:handle` never fires and the
request arrives at `/:slug` with the `@` still attached.

## Claiming a niche

The application asks ten questions and none of them are a filter on
credentials. Someone who has spent seventeen years estimating commercial roofs
and has never written a line of code is exactly the person this is for.

An approved claim creates an active membership at **20%**, writes the first row
of tier history and flips the niche to `operated`. It is one transaction: a
membership without the decision that created it is a person earning a share
nobody can point at a reason for.

**A niche takes as many experts as know it.** It is a subject, the way a Quora
topic is, not a plot the first arrival takes. So an approved claim deliberately
leaves the opportunity **open**: the pages keep inviting people, the niche page
lists everyone covering it, and the application form still appears to somebody
who is not already a member. Only an admin closes an opportunity.

Joining is not zero-sum, and the arithmetic is the reason. Shares are per
person by their own verified score, and they only compete once the sum passes
the 80% ceiling. A second expert who has contributed nothing takes nothing from
the first: 40% stays 40%. Past the ceiling everyone scales by the same factor,
so relative standing survives and the parts still total exactly 8000 basis
points. There are tests for each of those three cases.

## Contributing

`POST /api/v1/niches/<slug>/contributions` with a type and evidence. Only a
member of the niche may, and what a contribution is worth is never the caller's
decision — `points` is a request that a ranged type clamps, and every other type
ignores it.

The engine (`packages/knowledge/src/score.js`) returns points and a status:

- **pending** — held for a human. Everything from a new account, everything
  claiming money, anything the submitter's own agent generated.
- **verified** — counts now. Only low-risk types, only for someone with at
  least `TRUST_THRESHOLD` verified contributions in that niche already.
- **rejected** — an unknown type, or a duplicate.

## What stops this being gamed

Impact over volume, in five specific places:

1. **Evidence or nothing.** A contribution with nothing checkable attached
   scores zero and waits.
2. **Money needs an outside reference.** A conversion, lead or revenue claim
   needs a payment reference, lead id, commit or URL, and is never
   auto-verified however trusted the claimant.
3. **Duplicates book once.** The dedupe key is a digest over the niche, the
   type and the substance — not the timestamp, which is exactly what a
   resubmission changes. A unique index enforces it, so two racing requests
   still book once.
4. **Repetition pays less.** After `diminishAfter` verified events of a type in
   thirty days, the type pays half, then a quarter, then nothing. Ten thousand
   submissions of the cheapest thing there is reaches a score under 200, which
   is a `specialist` and not a `top-knowledge-influencer`. There is a test that
   asserts exactly this.
5. **Trust is earned per niche.** A new account's work is all held.

An admin can reverse anything. The row is marked `reversed` and keeps its
points; only the sum stops counting it. It is not deleted, and it is not
cancelled by a second negative row either — a status that excludes a row *and* a
compensating negative would subtract the same points twice and take honest work
down with the fraud.

## Tiers

See [revenue-share.md](./revenue-share.md).

## Running it

```sh
bun test test/knowledge.test.js     # the engine: scoring, tiers, splitting, allocation
bun test test/schema.test.js        # the tables, against an in-process Postgres
```

Neither needs a server.

## The agent question loop

This is the part that makes a day's work a few minutes long instead of an
open-ended obligation to go and find something to contribute. See
[agent-questions.md](./agent-questions.md).

## The revenue ledger

What a niche earned and whose share of it is whose, including payouts. See
[revenue-ledger.md](./revenue-ledger.md).

## Not yet built
- Promotion attribution, and the opportunity score's own inputs.
- Notifications. A question arriving should reach the operator by email or
  push; today it waits on the dashboard until they look.
