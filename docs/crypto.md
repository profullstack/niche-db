# `crypto`: the universe b1dz.com discovers and advis0r.com lists

Two adapters in `packages/adapters/src/crypto.js` replace b1dz's
`packages/source-crypto-arb/src/pair-discovery.ts`, which every five minutes
asked CoinGecko for the top 500 coins by market cap and Kraken, Coinbase,
Binance.US and Gemini for their 24-hour tickers, and then kept the pairs listed
on two or more venues with $50k of volume and a $10M market cap. The filtering
was the site's decision; the data underneath it is what this collection keeps,
so b1dz reads its universe from here and applies the floors itself, and
advis0r.com's static pair list becomes a query.

This is the contract. Same conventions as `docs/consolidation.md`: `externalId`
is the dedupe key per source, tags are lower-case facets a `?tags=` query can
answer without touching `data`, `data` holds the full record, and no key or
proxy URL ever leaves nichedb.

## Kinds

| kind | externalId | title | publishedAt | tags |
|---|---|---|---|---|
| asset | `coingecko:<id>` | `Bitcoin (BTC)` | CoinGecko's `last_updated` | `asset`, `symbol:<symbol>`, `rank:top100` when rank <= 100 |
| pair | `pair:<venue>:<BASE>-<QUOTE>` | `BTC/USD on Kraken` | the run | `pair`, `venue:<slug>`, `base:<base>`, `quote:<quote>`, `stable-quote` when the quote is USD, USDT or USDC |

Venue slugs are `kraken`, `coinbase`, `binance-us`, `gemini`. Base and quote
are upper-case in the id and `data`, lower-case in the tags. A pair's
`publishedAt` is the run time because the ticker is a snapshot of that moment;
`data.updatedAt` says the same.

An asset's `url` is its CoinGecko page and `imageUrl` its logo. A pair's `url`
is the venue's trade page for that book:

| venue | trade page |
|---|---|
| kraken | `https://pro.kraken.com/app/trade/btc-usd` |
| coinbase | `https://www.coinbase.com/advanced-trade/spot/BTC-USD` |
| binance-us | `https://www.binance.us/spot-trade/btc_usd` |
| gemini | `https://exchange.gemini.com/trade/BTCUSD` |

## `data`

Asset:
```
{ id, symbol, name, rank, priceUsd, marketCapUsd, fullyDilutedUsd, volume24hUsd,
  change24hPct, high24h, low24h, supply: { circulating, total, max },
  ath, athDate, atl, atlDate, updatedAt }
```
Every number is a number or null; `supply.max` is null for an uncapped coin,
never 0.

Pair:
```
{ venue, venueName, base, quote, venueSymbol, status,
  price, bid, ask, high24h, low24h, open24h, change24hPct,
  volume24hBase, volume24hQuote, vwap24h,
  priceUsd, updatedAt }
```
`venueSymbol` is the venue's own name for the book (`XXBTZUSD`, `BTC-USD`,
`BTCUSD`, `btcusd`), which is what a caller needs to place an order or open a
websocket. `priceUsd` is `price` when the quote is USD, USDT or USDC, else null:
a EUR or GBP book is not a dollar price. `status` is always `online`, because
only online books are emitted; the field is there so a mirror's schema does not
change if that ever loosens.

Which fields a venue actually fills, from its all-pairs endpoints:

| field | kraken | coinbase | binance-us | gemini |
|---|---|---|---|---|
| price | yes | yes | yes | yes |
| bid, ask | yes | null | yes | null |
| high24h, low24h | yes | yes | yes | null |
| open24h | today's open (00:00 UTC) | yes | yes | null |
| change24hPct | from today's open | from open | reported | reported |
| volume24hBase | yes | yes | yes | null |
| volume24hQuote | base x 24h VWAP | base x last (approximate) | reported | null |
| vwap24h | yes | null | yes | null |

Two of those deserve a sentence. Kraken's `o` is the day's opening price since
midnight UTC, not the price 24 hours ago, so its `change24hPct` disagrees with
the other three by design (measured 2026-09-11 06:00 UTC: Kraken BTC +0.92%,
the others -1.2% to -1.5%; `high24h`, `low24h`, `volume24hBase` and `vwap24h`
are the genuine rolling day). Gemini's only all-pairs endpoint is `/v1/pricefeed`,
which carries price and a 24h change and nothing else; `/v1/symbols/details/<symbol>`
has volume but is one request per pair, 300 a run, so Gemini volume is null and
stays null. b1dz's `getGeminiVolumes` put a sentinel above its filter for this
reason; a reader that filters on volume should treat a null Gemini volume as
"unknown", not as zero.

## Sources

`coingecko-assets` (cadence 15 minutes, default source `coingecko-assets`):
`GET /api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=N&sparkline=false&price_change_percentage=24h`,
two pages by default (`pages` config, up to 10). Coins are keyed by id across
pages because the ranking moves between the two reads. `COINGECKO_API_KEY` is
optional and is sent as `x-cg-demo-api-key`; the free tier's ~30 requests a
minute makes 2 every 15 minutes nothing.

`crypto-pairs` (cadence 5 minutes, default source `crypto-pairs`): the four
venues in parallel, each from one or two public requests. Config `venues` and
`quotes` narrow either list; empty means all four venues and all five quotes
(USD, USDT, USDC, EUR, GBP).

| venue | list (daily, in cursor) | ticker (every run) |
|---|---|---|
| kraken | `GET /0/public/AssetPairs` (673 KB) | `GET /0/public/Ticker` with no `pair=`: every book in one reply (414 KB) |
| coinbase | `GET api.exchange.coinbase.com/products` (353 KB) | `GET api.exchange.coinbase.com/products/stats` (110 KB) |
| binance-us | `GET /api/v3/exchangeInfo` (1 MB) | `GET /api/v3/ticker/24hr` (315 KB) |
| gemini | `GET /v1/symbols` (4 KB, every run: it is also the only statement of what is live) | `GET /v1/pricefeed` (23 KB) |

The three big lists live in the cursor as `{ [venueSymbol]: [base, quote, status] }`
under `cursor.kraken`, `cursor.coinbase` and `cursor.binanceUs`, each with an
`at` stamp, refreshed after 24 hours; together about 87 KB. A refresh that fails
falls back to the stale list rather than losing the venue for the run. A book
that goes offline is therefore emitted for up to a day after; a book that is
listed is emitted the run after the next refresh.

Filtering, in order: the quote must be one of the five; the venue's status
must be online (Kraken `online`, not `cancel_only` or `post_only`; Coinbase
`online` with `trading_disabled` false; Binance.US `TRADING`; Gemini present
in `/v1/symbols`); and the ticker must carry the book. Measured 2026-09-11:
Kraken 1,279, Coinbase 485, Binance.US 260, Gemini 166, 2,190 pairs a run in
1.4 seconds from a residential address.

Failure: a venue that throws (403, 451, a timeout, a 5xx, Kraken's `error`
array) is logged and skipped and the other three still land; the note names
it. All four failing throws, so the run records an error and the cursor is
kept. A 429 anywhere throws an error whose message contains `rate limit`; the
core http helper has already waited once on the `retry-after` by then. Requests
to one host are spaced 100 ms apart.

Request budget at defaults: Kraken 288 + 1, Coinbase 288 + 1, Binance.US
288 + 1, Gemini 576, CoinGecko 192; about 1,635 requests a day in total, and
roughly 260 MB a day of JSON, most of it Kraken's ticker and Binance.US's.

## Venue quirks worth knowing

- Kraken keys its Ticker by the same legacy name as AssetPairs (`XXBTZUSD`)
  but ships 29 extra `:BTNL`-suffixed keys that AssetPairs does not list; the
  adapter walks AssetPairs and looks the ticker up, never the reverse. The
  clean name comes from `wsname`, which still says `XBT/USD` and `XDG/USD`, so
  `XBT` becomes `BTC` and `XDG` becomes `DOGE` there; the X/Z prefix stripping
  (`XXBT`, `ZUSD`) is only a fallback for an entry with no `wsname`, and every
  entry has one today. Kraken answers 200 with `{ error: ["EAPI:Rate limit
  exceeded"] }` rather than a 429; that string is mapped to the same rate-limit
  error.
- Coinbase: `api.exchange.coinbase.com/products/stats` exists (verified by
  curl from this machine, 200, 522 keys, `stats_24hour: { open, high, low,
  last, volume }`) and is what the adapter uses, one 110 KB request a run
  against a daily product list. The alternative, Advanced Trade's public
  `GET api.coinbase.com/api/v3/brokerage/market/products?product_type=SPOT`,
  also works keyless and adds a reported change and an approximate quote
  volume, but it is 1.2 MB a run and lists 410 USDC "products" that are
  aliases of the USD books (`BTC-USDC` has `alias_to: ["BTC-USD"]`), which a
  reader grouping by base would double count. Neither endpoint carries a bid
  or ask for every product.
- Binance.US blocks datacenter egress. From a home address every endpoint
  answers; from a cloud host it is 403 or 451. `CRYPTO_PROXY_URL` names a
  residential proxy that is used for `api.binance.us` only (Bun's `proxy`
  fetch option), the way `SPORTS_PROXY_URL` is for ESPN. Without it a 403/451
  is logged as "set CRYPTO_PROXY_URL to reach it" and the venue is skipped;
  with it, a proxy that will not connect or answers 402/407 is bypassed for
  that request and the venue is tried direct. `exchangeInfo` splits `BTCUSD`
  by `baseAsset`/`quoteAsset`, never by suffix, because Binance.US also lists
  a legacy `USD4` quote (`BTCUSD4`, all in `BREAK`) that a suffix match reads
  as USD. 364 of its 629 symbols are `BREAK`.
- Gemini symbols have no separator and its own quotes: `aavegusd` is
  AAVE/GUSD (Gemini dollar), `driftrlusd` is DRIFT/RLUSD, `btcusdcperp` is a
  perpetual. The adapter splits on the longest known quote and drops
  perpetuals and the quotes outside the five, which is why 237 `usd`-suffixed
  symbols become 80 USD pairs. Checked 2026-09-11: no USD-quoted base ends in
  G or RL, so the split is unambiguous today. `percentChange24h` is a fraction
  (`-0.0130` is -1.30%) and is multiplied out.

## How b1dz reads it

Instead of `discoverPairs()`:

```
GET /api/v1/items?collection=crypto&kind=pair&tags=stable-quote&limit=200&sort=id&order=asc&after=<last id>
```

(a page is at most 200 rows, so walk the keyset until a short page: about seven pages for the dollar-quoted pairs, three for the assets) then group by `data.base` across `data.venue`. Each row carries the venue's
`volume24hQuote` (dollars, since the quote is a dollar stable) and `priceUsd`,
so the old `$50k per venue` and `on at least two venues` rules are a filter
over that grouping: keep a base whose rows on two or more venues each have
`volume24hQuote >= 50_000` (Gemini's is null: unknown, decide whether to
count it). `data.venueSymbol` is the name to hand each feed's `snapshot()`.
Add `tags=venue:kraken` to see one venue, `tags=base:btc` to see one coin
everywhere.

For the market-cap floor:

```
GET /api/v1/items?collection=crypto&kind=asset&limit=200&sort=id&order=asc&after=<last id>
```

keyed by `data.symbol` (upper-cased to match `base`), `data.marketCapUsd >=
10_000_000`. `tags=rank:top100` is the short list. `since=` on either query
returns only rows updated after a stamp, for a mirror polling every minute.

advis0r's static list is `kind=pair&tags=stable-quote` with the venue it
trades, and `crypto:pairs` in its plugin can answer from the same rows.

## Feeds seeded

`top-100` (kind asset, tag `rank:top100`), `all-assets` (kind asset),
`pairs-kraken`, `pairs-coinbase`, `pairs-binance-us`, `pairs-gemini` (kind
pair, tag `venue:<slug>`), `usd-pairs` (kind pair, tag `stable-quote`).
