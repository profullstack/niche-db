# Markets: symbols, price history and fundamentals move into nichedb

advis0r.com and b1dz.com each fetch three things for themselves today: the
tradable US symbol directory (Alpaca's asset list), daily price history per
symbol (Alpaca bars) and SEC XBRL fundamentals per company (companyfacts).
nichedb's existing `markets` collection now carries all three, so a site reads
`markets` instead of holding its own Alpaca key and its own SEC crawler.

This is the contract the adapters are built to, in the shape of
[consolidation.md](./consolidation.md): fixed item kinds, tags and `data`
shapes, so a site can be written against the shape without reading the adapter.
The conventions there (externalId per source, lower-case tags, `data` holds the
full record, keys never leave nichedb) hold here.

Adapters: `alpaca-assets`, `equity-history`, `sec-fundamentals`, all in
`packages/adapters/src/equities.js`.

## Kinds

| kind | externalId | title | publishedAt | tags |
|---|---|---|---|---|
| symbol | `alpaca:asset:<asset id>` | `AAPL · Apple Inc. Common Stock` | null | `symbol`, `exchange:<nasdaq\|nyse\|arca\|bats\|amex\|otc\|crypto>`, `class:<us_equity\|crypto>`, `tradable`, `otc`, `fractionable`, `shortable` (each only when true) |
| history | `history:<SYMBOL>` | `AAPL daily bars` | the last bar's day (precision `day`) | `history`, `symbol:<symbol>`, `feed:<iex\|sip>` |
| fundamentals | `sec:facts:<cik>` | `Apple Inc. (AAPL) fundamentals` | the newest `filed` date among the kept points (precision `day`) | `fundamentals`, `symbol:<symbol>` (one per ticker the CIK lists), `cik:<cik>`, `exchange:<slug>` when the SEC says |

`<cik>` is the plain number (`320193`), not zero-padded. Symbol tags are
lower-case with Alpaca's spelling: `symbol:brk.b`, `symbol:btc/usd`.

`url` is a public page: the Yahoo quote page for a symbol
(`https://finance.yahoo.com/quote/BRK-B`, Yahoo's hyphen spelling), its history
page for a window, and EDGAR's company page for fundamentals.

## `symbol`

One item per active Alpaca asset, the whole list: about 14,300 US equities
across NASDAQ, NYSE, ARCA, BATS, AMEX and OTC plus Alpaca's crypto pairs
(`class:crypto`). Untradable and OTC names are kept and tagged, because a
lookup by name wants to *find* them and then rank them below the tradable ones.

```
{ assetId, symbol, name, exchange, assetClass: 'us_equity'|'crypto', status,
  tradable, marginable, shortable, easyToBorrow, fractionable, attributes:[…] }
```

`attributes` is Alpaca's list as sent (`has_options`, `ipo`, `ptp_no_exception`,
`fractional_eh_enabled`...). `summary` is a one-line reading of the same:
`NASDAQ · US equity · tradable · fractionable · shortable`.

A site building a symbol directory takes `?kind=symbol` whole (one page a day
of ~14k rows, or `since=` for what moved) and ranks on `tradable`, `otc` and
`class` itself. There is no per-symbol lookup endpoint; the directory is the
lookup.

## `history`

One item per symbol carrying its last **400 daily bars**, oldest first, split
adjusted. The universe is the active, tradable `us_equity` symbols off OTC,
about 8,500 to 9,000 names.

```
{ symbol, timeframe: '1Day', feed: 'iex'|'sip', adjustment: 'split',
  bars: [[ 'YYYY-MM-DD', open, high, low, close, volume, vwap ], ...],
  first: 'YYYY-MM-DD', last: 'YYYY-MM-DD', count }
```

Each bar is a fixed seven-tuple; `vwap` is null when the feed did not send
one. `bars` is capped at 400, so `count` is at most 400 and `first` moves
forward as days are added. A symbol with no print on the feed for a day simply
has no bar for that day: the tuples are trading days with activity, not a
calendar.

`feed` is what the deployment reads: `iex` on the free tier (one venue, and a
thin name can go days without a print), `sip` on a paid data plan (the
consolidated tape). A site that needs the tape for a symbol should check the
tag rather than assume.

A mirror keys on `(symbol, day)` and upserts the window: the newest item is the
truth for every day it holds, and a day it no longer holds fell off the back.
The `since=` filter on `updated_at` returns only the symbols whose window
changed, which after a session is most of the universe and between sessions is
none of it.

### How it stays current

Bars are only asked for once a session has **settled**: 20:15 New York time on
a weekday, after the extended session closes. Before that the day's bar is
still moving, and a window that stored it would never ask for that day again.
So the hourly runs between sessions do nothing (no requests at all), and the
first run after 20:15 ET walks the universe, 100 symbols a request, asking each
for the days after the last one it holds. A run that reaches its deadline saves
its place in the cursor and comes back in five minutes; the walk usually
completes in one.

The adapter cannot carry 8k windows in its cursor, so it reads the window it
wrote last time back through `ctx.previous(externalIds)` (a core hook added
for this: this source's own rows, `data` only) and merges the new bars in. A
symbol seen for the first time is read from 400 calendar days back (about 280
trading days; the window fills to 400 over the following months). A symbol
that answers with no bars is remembered as quiet through that day, so the next
walk resumes there rather than re-reading the whole window for a name with no
prints.

Requests a day at the defaults: one for the universe, then per session about
85 to 90 bar requests (one page per 100-symbol batch; a straggler group in a
batch adds one). Runs outside sessions cost none. The first backfill is about
255 requests (three pages a batch) across one or two runs, paced at ~185 a
minute under Alpaca's 200/min.

## `fundamentals`

One item per company with XBRL facts, from `data.sec.gov`'s companyfacts. The
company list is `https://www.sec.gov/files/company_tickers_exchange.json`
(which also names the exchange), grouped by CIK: a company listing several
tickers (GOOGL, GOOG) is one item under the first, tagged with every ticker.

```
{ cik, symbol, symbols:[…], name, exchange,
  concepts: {
    <Concept>: [ { start, end, val, fy, fp, form, filed, unit }, ... ]   // oldest first, last 12
  },
  latest: { revenue, grossProfit, operatingIncome, netIncome, epsDiluted, epsBasic,
            assets, liabilities, equity, cash, operatingCashFlow,
            sharesOutstanding, publicFloat, longTermDebt,
            period, fp, fy, form, filed } }
```

Concepts kept (a filer that never reports one simply lacks the key):

- us-gaap: `Revenues`, `RevenueFromContractWithCustomerExcludingAssessedTax`,
  `SalesRevenueNet`, `GrossProfit`, `OperatingIncomeLoss`, `NetIncomeLoss`,
  `EarningsPerShareBasic`, `EarningsPerShareDiluted`, `Assets`, `Liabilities`,
  `StockholdersEquity`, `CashAndCashEquivalentsAtCarryingValue`,
  `NetCashProvidedByUsedInOperatingActivities`, `CommonStockSharesOutstanding`,
  `LongTermDebt`, `LongTermDebtNoncurrent`, `LongTermDebtCurrent`
- dei: `EntityCommonStockSharesOutstanding`, `EntityPublicFloat`

The alternates are the ones advis0r's provider fell back through: revenue is
reported under one of three tags, long-term debt as one figure or as current
plus non-current, and the cover-page share count (dei) is more current than
the balance-sheet one.

Points are taken from annual and quarterly reports only: `10-K`, `10-Q`,
`20-F`, `40-F` and their amendments (the foreign forms so that a foreign
private issuer is not an empty item). One point per `(end, fp)`, the latest
`filed` winning, so a restatement or an amendment replaces what it restated. A
quarter's own three-month figure beats the year-to-date figure that shares its
end date (both arrive in the same 10-Q under the same `fp`). `start` is null for
an instant (balance-sheet) concept. Each concept keeps its last twelve points.

`latest` is each concept's most recent point (`revenue` walks the three revenue
tags and takes the newest date; `sharesOutstanding` prefers the cover-page
count; `longTermDebt` is `LongTermDebt` or the sum of current and non-current).
It mixes quarters and years by design: `period`, `fp`, `fy`, `form` and `filed`
describe the newest of them, and the per-point `fp` in `concepts` says which
each figure is. A site wanting trailing-twelve-month revenue sums the last four
quarterly points itself.

`summary` is a headline: `revenue $90.8B, net income $23.6B, diluted EPS 1.53
(Q2 to 2024-03-30, 10-Q filed 2024-05-03)`.

### How it stays current

The whole list is walked once a week, `perRun` (default 300) companies an
hour, never faster than five requests a second (the SEC allows ten). The cursor
is a few bytes: the Monday of the current week, the CIK to resume after, and
the week the last full walk finished. The list itself is re-read every run
rather than stored, so a resume point survives the list changing under it. A
company whose facts file is a 404 (funds, trusts, shells) is skipped, as is one
reporting none of the concepts.

A 403 from the SEC is its rate threshold and surfaces as an error containing
"rate limit" so the run is recorded as failed and the source waits its cadence;
a 403 that says the tool is undeclared names the fix (`CONTACT_EMAIL`). The SEC
requires a User-Agent with a contact, so the adapter needs `CONTACT_EMAIL` and
sends `nichedb.dev (<contact email>)`.

Requests: one list read a run (24 a day) plus 300 facts reads an hour while
walking. About 10,000 companies means the walk takes ~34 runs, a day and a
half, then the source idles until Monday: roughly 7,200 a day while walking,
~1,500 a day averaged over the week.

## Sources and feeds

Sources: `alpaca-assets` (daily; two requests, one per asset class),
`equity-history` (hourly; walks after each session settles, `nextInMinutes: 5`
while a walk is incomplete), `sec-fundamentals` (hourly; 300 companies a run,
idle once the week's walk is done).

Feeds in `markets`:

```
{ collection: 'markets', slug: 'us-symbols',    name: 'US symbols',    query: { kinds: ['symbol'] } }
{ collection: 'markets', slug: 'price-history', name: 'Price history', query: { kinds: ['history'] } }
{ collection: 'markets', slug: 'fundamentals',  name: 'Fundamentals',  query: { kinds: ['fundamentals'] } }
```

Config: `APCA_API_KEY_ID` and `APCA_API_SECRET_KEY` (existing) for the two
Alpaca sources; `APCA_FEED` (`iex`, default, or `sip`) for the history feed,
overridable per source with its `feed` field; `CONTACT_EMAIL` (existing) for
the SEC. No key is ever in an item, a cursor, a log line or an error.

## What a site reads

- A symbol lookup: `?kind=symbol` mirrored daily; rank `tradable` above the
  rest and `otc` below. Match names against `title` or `data.name`.
- A chart or a technical score: `?kind=history&tags=symbol:aapl` for one
  window, or `?kind=history&since=<last sync>` after 20:15 ET for everything
  that moved. `bars[-1]` is the last close; the 400-day window covers a
  200-day moving average with room.
- A thesis or a screen: `?kind=fundamentals&tags=symbol:aapl`. `latest` for the
  headline numbers; `concepts.<Concept>` for the series; `filed` and `form` for
  point-in-time work, as advis0r's `asOf` did.
