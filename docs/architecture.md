# Architecture

One Bun process, one Postgres, one Redis. `ROLES=web,worker` runs everything in
one container; `ROLES=worker` on a second service splits ingestion out.

```
apps/
  web/      Hono, server-rendered JSX, the API, MCP, the PWA
  worker/   BullMQ consumers: ingest, enrich, feed scan, delivery
  cli/      @profullstack/nichedb

packages/
  adapters/    one file per upstream, registered in src/index.js
  auth/        magic link, passkeys, API keys. No password column anywhere.
  config/      every environment variable, read once
  core/        adapter contract, ingest, normalisation, defaults/seed
  db/          the pool, migrations, and every query the app runs
  enrichers/   one file per enrichment, applied after ingest
  knowledge/   the Knowledge Influencer domain: pure, no database, no HTTP
  notify/      email, push, signed webhooks
  payments/    CoinPay, memberships, referrals
  queue/       BullMQ wiring
```

## Layers

Nothing writes SQL outside `packages/db`. Routes, workers and MCP tools import
queries; views import nothing but components and the domain.

```
schemas + domain     packages/knowledge   pure, replayable, tested alone
data access          packages/db          every statement, one place
API handlers         apps/web/src/routes
UI                   apps/web/src/views
jobs                 apps/worker
```

`packages/knowledge` is deliberately the only place that decides what a
contribution is worth or what share a score earns, and it has neither a database
nor a request in it. That is what makes a payout reproducible: the events are
still there and replaying them gives the same number.

## Migrations

Forward-only, numbered, one file each, one transaction each, applied on boot by
every process under an advisory lock. There is no `down`: the recovery path for
a bad migration is a new forward one.

`0006` is reserved for the partners branch. Two branches adding the same number
merge cleanly and then nobody knows which ran first, so a number in flight
elsewhere is left alone.

## Routing

Registration order in `apps/web/src/app.js` is load-bearing:

1. Blocked crawlers.
2. The x402 gateway — training crawlers pay here or go no further.
3. `loadUser` — session cookie, then bearer API key.
4. The leaderboard and the partners programme, each of which answers for its own
   prefix or hands the request on.
5. Ads and tracking modules.
6. The routes: static, auth, pages, manage, API, MCP.
7. **Last:** the Knowledge Influencer routes, because a niche's page is served
   from the site root. Every real route is matched before `/:slug` is asked, and
   a niche may not take a slug the site already uses.

## Money

Two ledgers, both integer minor units and integer basis points, both capped at
80%, deliberately separate: `partner_credits` for people whose writing is in the
index, and the Knowledge Influencer tables for people who operate a niche. See
[revenue-share.md](./revenue-share.md).

## Reading further

- [knowledge-influencers.md](./knowledge-influencers.md)
- [agent-questions.md](./agent-questions.md)
- [revenue-share.md](./revenue-share.md)
- [x402-attribution.md](./x402-attribution.md)
