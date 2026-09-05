# NicheDB

**Sources in, feeds out.** An open platform for databases that only ever grow: game releases, package registries, government filings, and any other public data with a big seed and daily growth. One Postgres, one Redis, and every row reachable by web, RSS, JSON, API, CLI and MCP.

The first deployment is [nichedb.dev](https://nichedb.dev). Run your own on anything that has Postgres and Redis.

## The model

| Thing | What it is |
| --- | --- |
| **collection** | A niche: `games`, `packages`, `filings`. |
| **source** | One adapter pointed at one upstream, fetched on its own cadence. Steam's new-releases list. The npm changes feed. EDGAR Form D filings. |
| **item** | One row a source produced. Title, URL, when (with `time_known` and `precision`), tags, and the adapter's payload in `data`. |
| **feed** | A saved query over a collection. Has a page, RSS and JSON Feed renderings, an API endpoint, and followers who are told when it changes by push, email or signed webhook. |

Adapters are one file each in `packages/adapters/src`. Eleven ship today:

| Adapter | Collection | Key needed |
| --- | --- | --- |
| `steam`, `steam-news` | games | no |
| `igdb` | games | Twitch client id + secret |
| `npm`, `pypi`, `crates`, `huggingface` | packages | no |
| `github-releases` | packages | optional (higher limit) |
| `edgar`, `federal-register` | filings | no (SEC wants `CONTACT_EMAIL`) |
| `courtlistener` | filings | account token |

## Run it

```sh
git clone https://github.com/profullstack/niche-db && cd niche-db
bun install
docker compose up -d db redis          # or point at your own Postgres 16+ and Redis
cp .env.example .env                    # DATABASE_URL, SITE_URL, CONTACT_EMAIL at minimum
bun run build:client
bun run dev                             # web + worker in one process on :3000
```

Migrations apply themselves on boot. The three collections, their default sources and a dozen feeds are seeded on first boot; sources whose adapter needs a credential the deployment lacks are created paused. The first account to sign in is an admin.

`bun run ingest [slug ...]` runs sources from a terminal without Redis. `bun test` runs the suite against an in-process Postgres (PGlite), so it needs no server.

## Surfaces

- **Web**: a PWA. `/sources` manages sources (status, last run, next run, run now, pause, edit config). `/feeds/new` builds a feed with a live preview. `/settings` holds passkeys, API keys and notifications.
- **RSS / JSON Feed**: `/f/<slug>.rss`, `/f/<slug>.json`.
- **API**: `/api/v1`, documented at `/docs/api`. Reads need no key.
- **CLI**: `npm i -g @profullstack/nichedb` → `nichedb`. Documented at `/docs/cli`.
- **MCP**: `/mcp` (Streamable HTTP, stateless) or `nichedb mcp` over stdio. Documented at `/docs/mcp`.
- **llms.txt**: `/llms.txt` describes the whole deployment in one document.

## Accounts and money

Magic link and passkey only; there is no password column. API keys are minted from settings and shown once.

Pro (a yearly membership through [CoinPay](https://coinpayportal.com)) lifts the feed limit, raises the API rate limit and lets an account add its own sources. Referral links give the new customer 20% off and the referrer 60% of the first payment. Training crawlers (GPTBot, ClaudeBot, CCBot, meta-externalagent…) get a 402 with an x402 offer and can buy a day pass at `/crawl`; people, search engines and retrieval crawlers pass through untouched.

## Stack

Bun, Hono (server-rendered JSX), Postgres via Bun's native driver, BullMQ on Redis, Biome. Shared Profullstack modules: `@profullstack/x402-gateway`, `@profullstack/emailer`, `@profullstack/coinpay`, `@profullstack/referrals`, `@profullstack/api-key-manager`, `@profullstack/autoblog` (signed webhooks), `@profullstack/favicon-generator`.

## Configuration

Everything is read once from the environment in `packages/config/src/index.js`; `.env.example` lists every variable. Production secrets live in the `nichedb--prod` [logicsrc](https://logicsrc.com) vault:

```sh
bun run secrets:pull     # logicsrc teams pull profullstack nichedb prod --env .env
bun run secrets:push     # after adding a key locally
```

`ROLES=web,worker` runs everything in one container; `ROLES=worker` on a second service splits ingestion out when one instance stops being enough.

## Deploy

One Dockerfile, one Railway service, plus Railway's Postgres and Redis. `railway.json` sets the healthcheck at `/healthz`. Set `SITE_URL` to the public origin before anyone registers a passkey: the passkey relying-party id is derived from it.

## Adding an adapter

```js
import { defineAdapter } from '@nichedb/core/adapter';

export const example = defineAdapter({
  name: 'example',
  title: 'Example API',
  collection: 'packages',
  description: 'What it watches, in one paragraph.',
  kinds: ['thing'],
  cadenceMinutes: 30,
  configFields: [{ key: 'topic', label: 'Topic', required: true }],
  defaultSources: [{ slug: 'example-default', name: 'Example', config: { topic: 'all' } }],
  async pull({ config, cursor, http, log, budget, deadline }) {
    const page = await http.json(`https://example.com/api?topic=${config.topic}&since=${cursor.since ?? ''}`);
    return {
      items: page.results.map((r) => ({ externalId: r.id, kind: 'thing', title: r.name, url: r.url, publishedAt: r.at, tags: r.tags, data: r })),
      cursor: { since: page.next },
      note: `${page.results.length} things`,
    };
  },
});
```

Register it in `packages/adapters/src/index.js`. The core normalises items, hashes them so unchanged rows cost no write, writes in batches, records the run and reschedules.

## License

MIT
