# AI models & prices (`/c/models`)

Every AI model you can call and what it costs, from
[models.dev](https://models.dev) — an open, community-maintained database of
models, their capabilities and their prices, MIT licensed and keyless
([anomalyco/models.dev](https://github.com/anomalyco/models.dev)).

It exists because the question people actually ask is not "what models are
there" but "who serves this model and what do they charge". Those are
different questions, and the second one is the reason this collection stores
what it stores.

## Why a row is an offering, not a model

models.dev publishes the same database two ways, and the difference decides
the shape of the collection:

| Document | Keyed by | What it is |
| --- | --- | --- |
| `api.json?type=all` | provider | Each provider and the models it serves, at its own prices. |
| `catalog.json?type=all` | — | The same providers, plus `models`: the lab catalogue, one entry per model as its maker published it, keyed `lab/slug`. |

The same model reaches you from a dozen providers at a dozen prices, so the
unit worth storing is the **offering** — `(provider, model)` — not the model.
That is what `api.json` carries and what the bulk of this collection is.

The lab catalogue is the other half, and it is the only half with a page of
its own on the site (`models.dev/models/<lab>/<slug>`). A provider's offering
has no URL but the provider's own documentation, which is what those rows
link to.

## Sources

| Source | Slug | Rows | Kinds | Cadence |
| --- | --- | --- | --- | --- |
| models.dev offerings (`api.json`) | `models-dev-offerings` | 8,179 across 223 providers | model | daily |
| models.dev catalogue (`catalog.json`) | `models-dev-catalog` | 428 lab models, 223 providers | catalog-model, provider | daily |

Measured 2026-09-24. Both are keyless and MIT licensed. The upstream is a
build artefact of a git repository rather than a live feed, so a daily pass is
as fresh as the data gets.

## What each row carries

- **model** (an offering): the price per million tokens in, out, cache read
  and cache write; the context and output limits; input and output modalities;
  and whether it reasons, calls tools, returns structured output, takes
  attachments, honours temperature or ships open weights. Plus the provider
  itself — its id, name, documentation, npm package and the environment
  variables it expects.
- **catalog-model**: the same facts as the lab published them, with the lab,
  the catalogue key and the model's own page.
- **provider**: the size of the catalogue, how many of those models are free,
  and when the catalogue last changed.

Dates are days, not moments: `last_updated` where the entry has one and
`release_date` otherwise, stored at day precision with `timeKnown` false.

## Feeds

| Feed | What |
| --- | --- |
| `models-and-prices` | Every offering, newest entry first |
| `open-weight-models` | Offerings whose model ships open weights |
| `free-models` | Offerings whose provider publishes a price of zero |
| `tool-calling-models` | Offerings that call tools |
| `reasoning-models` | Offerings that reason |
| `model-catalog` | The lab catalogue |
| `model-providers` | The providers themselves |

Capabilities are stored as tags (`reasoning`, `tool-call`,
`structured-output`, `attachment`, `open-weights`, `temperature`,
`experimental`, `in:image`, `out:text`, …) so a feed can be "everything that
calls tools" without the query language learning what a model is.

## Traps

**A published zero is a fact, not a missing value.** 638 of the 8,179
offerings cost nothing, so the reflexive `cost.input || null` would erase
every free model in the database. `priceOf` keeps a published zero and
returns null only when the provider publishes no price at all; `free` means a
published zero in *and* out, never an absent price. 7,755 offerings carry a
price; the remaining 424 publish none, and those are not free.

**A provider has no date of its own.** It borrows the newest date in its own
catalogue — the last time that catalogue changed — rather than sorting 223
rows to the bottom of the collection forever on a null.

**Offerings share URLs by design.** Several of a provider's models link to one
documentation page, because an offering has no page of its own. That is safe
here: this collection does not opt into URL dedupe, and if it ever did, the
catalogue rows are the ones with distinct pages. Identity is
`(provider, model)` in `external_id`, which is unique across all 8,179 rows.

**Per-model site URLs are lab-keyed, not provider-keyed.** `models.dev/<anything>`
that is not `/models/<lab>/<slug>` or `/labs/<lab>` redirects to the root, so a
provider's model id cannot be turned into a page by string surgery. Only the
catalogue half gets real pages.

## Resuming

The offerings walk stops between providers when it runs out of deadline and
saves a cursor naming the last provider written; the next run resumes after
it and resets the cursor when it reaches the end. The cursor names a provider
rather than an index, because the document is rebuilt upstream between runs
and a provider added anywhere above the mark would shift every index below it.
A cursor naming a provider that is no longer there starts from the top:
rewriting rows that are already correct costs a write of nothing, and skipping
them loses them.
