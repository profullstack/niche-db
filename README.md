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

Adapters are one file each in `packages/adapters/src`. Ninety-three ship today across thirty-two collections:

| Collection | Adapters | Key needed |
| --- | --- | --- |
| games | `steam`, `steam-news`, `igdb` | IGDB only (Twitch client) |
| packages | `npm`, `pypi`, `crates`, `go-modules`, `huggingface`, `github-releases` | no (GitHub token optional) |
| filings | `edgar`, `federal-register`, `courtlistener` | CourtListener only |
| music | `musicbrainz` | no |
| books | `openlibrary` | no |
| tabletop | `scryfall-sets`, `scryfall-cards` | no |
| space | `launch-library` | no |
| chess | `lichess-broadcasts` | no |
| alerts | `usgs-earthquakes`, `gdacs` | no |
| weather | `nws-alerts`, `nhc-cyclones`, `swpc-space-weather`, `eonet-events` | no |
| outages | `statuspage` (any Statuspage host) | no |
| extensions | `firefox-addons`, `vscode-extensions`, `mcp-registry` | no |
| health | `openfda-recalls`, `clinical-trials` | no |
| research | `arxiv`, `crossref` | no |
| automotive | `fueleconomy-catalog`, `nhtsa-recalls`, `nhtsa-complaints`, `nhtsa-safety-ratings` | no |
| markets | `iso-mic-exchanges`, `alpaca-corporate-actions`, `alpaca-news`, `alpaca-assets`, `equity-history`, `nasdaq-halts`, `ecb-fx-rates`, `sec-fundamentals` | Alpaca (`APCA_API_KEY_ID`, `APCA_API_SECRET_KEY`, `APCA_FEED` iex or sip); SEC wants `CONTACT_EMAIL` in the user agent |
| crypto | `coingecko-assets`, `crypto-pairs` | keyless (`COINGECKO_API_KEY` optional; `CRYPTO_PROXY_URL` for Binance.US from a datacenter) |
| crime | `socrata-crime`, `uk-police-crime`, `fbi-crime-estimates` | FBI only (free api.data.gov key) |
| public-money | `usaspending-awards`, `ocds-tenders`, `ted-notices` | no |
| housing | `uk-land-registry`, `freddie-mac-rates`, `building-permits` | no |
| jobs | `bls-series`, `eurostat`, `warn-layoffs`, `agenticjobs` | no |
| ai-incidents | `rogue-ai-incidents`, `rogue-ai-research`, `aiid-reports` | no |
| news | `newsfeed`, `gdelt`, `rssamplifier`, `brisk`, `news-channels` | no |
| domains | `ntld-totals`, `ntld-tlds`, `ntld-launches`, `ntld-changes` | no |
| podcasts | `podcasts`, `p0dcasters` | no |
| aviation | `faa-nas-status`, `aviation-hazards`, `aviation-metar`, `ntsb-accidents`, `adsb-flights` | no (NTSB needs mdbtools + unzip, in the Dockerfile) |
| water | `nwps-river-gauges`, `coops-water-levels`, `drought-monitor`, `ndbc-buoys`, `nws-surf-zone` | no |
| consumer-finance | `cfpb-complaints`, `fdic-institutions`, `fdic-structure-changes` | no |
| deals | `slickdeals`, `dealnews`, `dealcatcher`, `bensbargains`, `reddit-deals` | no |
| sports | `espn-catalogue`, `espn-schedule`, `espn-live`, `espn-plays`, `livetennis`, `sportsdb-tv` | Live Tennis; TheSportsDB (`SPORTSDB_API_KEY`, the shared key `3` returns one row per query); ESPN is keyless (`SPORTS_PROXY_URL` for cloud egress) |
| screen | `tmdb-releases`, `tvmaze-schedule`, `anilist-airing`, `imdb-ratings` | TMDB only |
| channels | `iptv-org-channels` | no |
| saas | `saasrow` | no |
| marketplace | `d0rz`, `bl0ggers` | no |
| ai-media | `aiornot` | no |
| forums | `tsbb` | no |
| hosting | `findhost`, `vultr-plans`, `linode-types`, `scaleway-instances`, `ovh-vps`, `lowendbox`, `openserver` | no (FindHost data is CC BY 4.0: credit FindHost, findhost.app) |

### House aggregators

Eight of the sites we run publish a public feed or API of their own, and each is read here through it, keyless, the way any other reader would. The endpoint is the one checked live on 2026-09-12; the slug is the seeded source.

| Site | Endpoint | Collection | Source slug | Kinds |
| --- | --- | --- | --- | --- |
| p0dcasters.com | `/opml` (every show: feed, site, title) | podcasts | `p0dcasters-shows` | `show` |
| saasrow.com | `/api/v1/products` (offset paged, 100 a page) | saas | `saasrow-products` | `product` |
| d0rz.com | `/asks/rss.xml`, `/offers/rss.xml` | marketplace | `d0rz-marketplace` | `ask`, `offer` |
| bl0ggers.com | `/asks/rss.xml`, `/offers/rss.xml` | marketplace | `bl0ggers-marketplace` | `ask`, `offer` |
| aiornot.vote | `/rss.xml`, `/rss/featured.xml`, `/rss/trending.xml` | ai-media | `aiornot-media` | `submission` |
| agenticjobs.work | `/api/v1/jobs` (offset paged, 100 a page) | jobs | `agenticjobs-postings` | `job` |
| tsbb.dev | `/api/v1/forums`, then `/f/{slug}/feed.xml` per forum | forums | `tsbb-topics` | `post` |
| c0ncerts.com | none yet: `/api/events` answers 501 "coming soon" and `/api/v1/events` 404s | — | — | — |

saasrow's `/api/v1/listings` is per-account and needs a key, so only the public products directory is read. A submission aiornot carries on more than one feed is stored once and tagged with each feed. tsbb's cross-board `/api/v1/latest` does not say which forum a topic is in, which is why the walk is per forum.

## Enrichment

After ingest, every item is enriched by the enrichers that apply to it (`packages/enrichers/src`), and the results live on the item under `enrichment.<name>`:

| Enricher | Adds | Default on for |
| --- | --- | --- |
| `youtube` | top videos (trailers, official audio, webcasts); Data API key optional | games, music, tabletop, space, chess, books |
| `wikipedia` | the article's lead paragraph and picture | games, music, books, space, tabletop, hosting |
| `github-repo` | stars, forks, topics, licence, language, last push | packages, extensions |
| `npm-stats` | last week's downloads | packages |
| `sec-company` | tickers, exchange, industry, state, website of the filer | filings |
| `company-ticker` | the listed company behind a hosting provider: ticker and CIK from the SEC's company list, matched on name | hosting |
| `semantic-scholar` | TL;DR, citation counts, open-access PDF (key optional) | research |
| `openlibrary-work` | description and subjects | books |
| `opengraph` | the page's own preview image and description | most collections |
| `tmdb-artwork` | poster, backdrop, synopsis, rating and TMDB id for a title that came in from the IMDb dumps with none (`TMDB_API_KEY`) | screen |

A feed's `enrichers` list picks which of these it shows; absent means the collection's defaults. The feed builder exposes them as checkboxes. Items are enriched once, newest first with a fair share per collection (`ENRICH_PER_RUN` a tick, `ENRICH_PER_COLLECTION` of them from any one collection), and a missing image, summary or tags are filled from whatever the enrichers found while the source's own words always win.

## Run it

```sh
git clone https://github.com/profullstack/niche-db && cd niche-db
bun install
docker compose up -d db redis          # or point at your own Postgres 16+ and Redis
cp .env.example .env                    # DATABASE_URL, SITE_URL, CONTACT_EMAIL at minimum
bun run build:client
bun run dev                             # web + worker in one process on :3000
```

Migrations apply themselves on boot. Every collection, its default sources and its feeds are seeded on first boot; sources whose adapter needs a credential the deployment lacks are created paused. The first account to sign in is an admin.

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

Free pages and feeds carry one [CrawlProof](https://crawlproof.com) ad and a tracker (`CRAWLPROOF_AD_SLOT`, `CRAWLPROOF_SITE_ID`). Two tiers buy them away, both through [CoinPay](https://coinpayportal.com):

- **Premium** — $1 a day, $30 a month or $300 a year (`/premium`). No ads, no tracking, the members' Lounge, 1,000 credits a month to give awards with, a badge, six themes and five app icons, early access to new collections, 30,000 API requests an hour, unlimited feeds, own sources, and the metered vehicle lookups included. `/premium` carries a line-by-line comparison with Reddit Premium; `GET /api/v1/premium` is the same thing as JSON. See [docs/premium.md](docs/premium.md).
- **Pro** — $120 a month (`/pro`). Everything Premium has, plus 120,000 API requests an hour and a crawl pass for the whole term (`GET /api/v1/crawl-pass`) so a member's own agents walk through the paywall.

Referral links give the new customer 20% off and the referrer 60% of the first payment.

Training crawlers (GPTBot, ClaudeBot, CCBot, meta-externalagent…) get a 402 with an x402 offer and buy a pass at `/crawl`: $1 a day for everything, and the more a buyer has paid here the less a day costs (`CRAWL_LOYALTY`, default 20% off after $10, 40% after $50, 60% after $100; every sale is a row in `crawl_sales`). A pass may switch ads or tracking off for its own requests with `?disable=ads,tracking`. People, search engines and retrieval crawlers pass through untouched.

## Knowledge Influencers

Every collection here is also a **niche** someone can operate. A Knowledge
Influencer is a person who knows how an industry actually works and supervises
the agents building software, data and promotion for it — no code required. They
start at **20%** of what the niche makes and climb to **80%** as verified
contribution accumulates.

`/opportunities` lists the niches looking for one. `/<niche>` is the niche's
public page (plus `skill.md` and `manifest.json` for agents), `/@<handle>` is an
operator's profile, `/dashboard/niches` is their own view, and
`/admin/knowledge` is where claims and contributions are verified.

When an agent gets stuck on something only a person who has done the job can
settle, it asks: the question lands on the operator's dashboard, the answer
becomes niche knowledge and a scored contribution, and Chovy is told. Saying
"not enough context" is a first-class answer that costs nothing, because a
guess that gets verified is worse for the niche than an open question. See
[docs/agent-questions.md](docs/agent-questions.md).

Score comes only from contributions somebody verified, and volume does not buy
it: repeated submissions of a type pay less each time, anything claiming a
customer or a payment needs an outside reference, and a duplicate books once.
The ladder lives in `contribution_tiers`, so a deployment can tune it. What a
niche earns is divided at the moment it settles, using the shares in force
right then, so a tier that moves tomorrow never re-prices yesterday's sale
([docs/revenue-ledger.md](docs/revenue-ledger.md)). See
[docs/knowledge-influencers.md](docs/knowledge-influencers.md) and
[docs/revenue-share.md](docs/revenue-share.md).

## Stack

Bun, Hono (server-rendered JSX), Postgres via Bun's native driver, BullMQ on Redis, Biome. `bun apps/worker/src/enrich-cli.js [n]` runs enrichment from a terminal. Shared Profullstack modules: `@profullstack/x402-gateway`, `@profullstack/emailer`, `@profullstack/coinpay`, `@profullstack/referrals`, `@profullstack/api-key-manager`, `@profullstack/autoblog` (signed webhooks), `@profullstack/favicon-generator`.

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
