# Top-level domains (`/tlds`)

Every label in IANA's root, what a name under it costs to keep at each registrar, and whether a given name is taken. The record and the price shape are [OpenTLD](https://logicsrc.com/docs/opentld); this is its first reader.

## Where the rows come from

A worker job (queue `tld-sync`, daily at `TLDS_CRON`, default 08:20 UTC, and once at boot) runs four steps, each on its own so one failure leaves the others:

| step | upstream | writes |
|---|---|---|
| list | `data.iana.org/TLD/tlds-alpha-by-domain.txt` | `tlds`, `tld_changes` |
| type and registry | `www.iana.org/domains/root/db` (HTML) | `tlds.type`, `tlds.manager`; "Not assigned" rows as retired |
| RDAP servers | `data.iana.org/rdap/dns.json` | `tlds.rdap` |
| prices | one reader per registrar, below | `tld_registrars`, `tld_prices` |

The list is diffed, never replaced. The first read is a baseline and writes no change rows; after that a new label is `added`, a missing one is marked `removed` (never deleted) and one that comes back is `returned`, each with the IANA list version. A list far shorter than what is held is refused as a broken download. An unchanged version costs one fetch.

The root zone database also lists 157 labels as "Not assigned": retired before this table began. They are kept as `removed` rows, so the table holds every top-level domain there has been.

## Registrars

| slug | source | currency | notes |
|---|---|---|---|
| `porkbun` | `api.porkbun.com/api/json/v3/pricing/get`, POST, keyless | USD | 909 labels, of which only ~540 are in IANA's root: the rest are Handshake names, which are skipped and counted |
| `dynadot` | `www.dynadot.com/domain/prices`, the Nuxt `__NUXT_DATA__` payload | whatever the page is in | the page switched from USD to CNY between two reads from the same box; the currency is read per row and a mixed page is refused |
| `cloudflare` | `cfdomainpricing.com/prices.json` (MIT mirror of Cloudflare's at-cost prices) | USD | at cost, so a transfer is one year's renewal |
| `ovh` | `eu.api.ovh.com/1.0/order/catalog/public/domain?ovhSubsidiary=IE` | EUR, before VAT | a 30 MB catalogue; prices are in hundred-millionths; second-level plans skipped |

Any registrar that serves `/.well-known/opentld.json` is read by listing its URL in `TLDS_OPENTLD_URLS`; no code. A new keyless registrar is one entry in `REGISTRARS` (`packages/core/src/tlds/sources.js`) and a parser.

A price list that comes back less than half as long as the last good one is refused and the last good list kept. A label a registrar stops listing is marked `gone_at`, not deleted.

Namecheap, Spaceship and NameSilo sit behind Cloudflare challenges, and Gandi, GoDaddy, name.com and NameSilo's API want a key; none is read.

## Comparing prices

Prices are compared within a currency and never converted. "Best" is the cheapest USD price across registrars. With `registrar` chosen, every column is that registrar's own price in its own currency. The default order is the renewal, ascending, because the first year is the promotion. The *renewal trap* is a renewal at least twice the first year, cheapest against cheapest; on 2026-09-25 that was 314 labels, led by `.baby` ($1.54, then $50.20).

## Surfaces

| surface | what |
|---|---|
| `/tlds` | the table, facets (type, renewal band, trap, sold at, script, status, registry), sortable on every column |
| `/tlds/<tld>` | one label: registry, RDAP server, every registrar's price, history; a Unicode label redirects to its `xn--` form |
| `/tlds/changes` | the change log |
| `/tlds/check?name=foo&tlds=com,dev` | RDAP lookups |
| `GET /api/v1/tlds` | the listing as JSON with facet counts, or `format=csv` |
| `GET /api/v1/tlds/{tld}`, `/changes`, `/registrars`, `/check` | as the pages |
| MCP | `search_tlds`, `get_tld`, `tld_changes`, `check_domain` |
| CLI | `nichedb tlds`, `nichedb tld <tld>`, `nichedb tld changes`, `nichedb check <name>` |

## Availability

A name is `registered` (RDAP 200, with the registrar and expiry), `not_registered` (404) or `unknown` (no RDAP server, a timeout, any other status). `not_registered` is not "available": the name may be reserved or premium. `unknown` is never turned into either and is not cached; definite answers are cached ten minutes. `.io` and `.de`, among others, publish no RDAP server.

Checks cost the registries a request each, so a stranger gets `TLDS_FREE_CHECKS_PER_HOUR` (120) names an hour, counted per name; a paid caller is not counted. One check asks about at most `TLDS_MAX_NAMES_PER_CHECK` (25) names.

## Registry names

The registry is IANA's wording. Identity Digital's new generic TLDs are mostly listed under its subsidiary **Binky Moon, LLC** (196 labels), not under "Identity Digital Limited" (24), so search for both.
