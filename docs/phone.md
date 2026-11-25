# Phone numbers: /phone

One page per number at `/phone/<digits>` (JSON at `/api/v1/phone/<number>`,
MCP `phone_lookup`, CLI `nichedb phone`), answering four questions from open
data only.

| Question | Source | Licence / terms |
|---|---|---|
| Is it a real number, which country, landline or mobile? | libphonenumber metadata via `libphonenumber-js` | Apache-2.0 / MIT |
| Where in North America, which carrier holds its block? | NANPA nightly reports: area codes, 205k exchanges, 1.43M thousands-blocks (`nanpa` adapter) | published for public use; assignment facts only |
| Did people report it? | FCC Consumer Complaints, unwanted calls with a caller ID (`fcc-unwanted-calls`); the smshub.dev SMS blacklist | public domain; ours |
| Which business publishes it? | NPPES organisations' practice phones (`nppes`, tagged by number) | CMS FOIA-disclosable |

Every row about a number carries the tag `num-<E.164 digits>`, so one tag
query finds it across collections.

## What it never says

Who owns a personal line. No lawful, openly licensed register of personal or
mobile numbers by person exists: white pages are licensed, voter files carry
use restrictions, and the rest is breach data, which is never loaded. The
sources here keep no private person's number: FCC complainants keep only
their state, and an individual provider's NPPES phone is withheld.

## Caveats shown on every page

- **The carrier is the one the block was assigned to.** A ported number keeps
  its block; porting data (the NPAC) is not public.
- **North American line type is a guess** from the carrier's name. Mobile and
  fixed numbers share every NANP range, so libphonenumber cannot tell them
  apart there; elsewhere its type is the country plan's own.

## Next sources

- **FTC Do Not Call complaints** (`api.ftc.gov/v0/dnc-complaints`): needs a
  registered api.data.gov key (DEMO_KEY is 10 requests).
- **Overture Maps Places** `phones` (90M places, CDLA-Permissive-2.0 / CC0 /
  Apache-2.0 per row): 12 GB of parquet, read column-pruned per country.
- **Wikidata P1329** (305k statements, CC0): a sorted deep page times out at
  the query service, so it needs a walk partitioned by country.
- **Canada (CNAC) and Australia (ACMA)** exchange registers.

Publishers that refuse dev2's address (www.ftc.gov, ofcom.org.uk) are asked
again through the fetch routes: c0mpute, then a W3BS desktop
([fetch-routes.md](fetch-routes.md)).
