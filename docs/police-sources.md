# California police announcements

California is the first state. The catalogue contains all **177 incorporated cities
with more than 50,000 residents** in Census Vintage 2025; 76 exceed 100,000.
The 50,000 cutoff retains more local coverage without adding a paid data service.
Unincorporated Census-designated places are outside this municipal scope.

**39 cities have reviewed ingestion sources: 35 Nixle archives and four RSS feeds.**
All 39 returned dated announcements in the live adapter check on September 13, 2026.
The remaining 138 cities have source leads, not working ingestion coverage from
this adapter. Existing Socrata crime sources remain separate.

The crime collection links to `/c/crime/coverage`, a directory with city/account
search, 50,000 and 100,000 population filters, and a “Needs a feed” filter.
`/f/police-updates-ca` contains the new announcements. Each source has its own
status page and can be paused or assigned a different cadence.

## Meaning of a record

- Kind: `police-update`, separate from incident-level `crime-report` records.
- Content: a publisher's headline, a short summary and a link to the original.
  Police feeds may include traffic advisories, outreach and other agency notices.
- Time: the publication date supplied by RSS or the individual Nixle alert.
  Archive text such as “2 weeks ago” is never converted to today's date. A missing
  timestamp stays unknown. Incident time is not inferred from publication time.
- Location: the publishing city's Census reference point, explicitly labelled
  `location_precision: jurisdiction`. This supports the existing radius queries
  without implying an exact incident address. The linked radius of 100 is in
  **kilometers**. Agency headquarters addresses in Nixle footers are excluded.
- City police publishers are assigned to their municipal jurisdiction. Broad
  county feeds and sheriff stations with uncertain service areas are references
  only; they are not pinned to whichever city shares their name.

Announcements do not enter the existing incident-only saved feeds or scanner
crime counts. The collection and item pages explain the location and time basis.

## Polling and cost

Default cadence is 60 minutes per city. No X API, social login, paid scraping
service, or paid geocoder is used. Social profiles remain direct reference links.
The adapter checks robots policy, has request timeouts, caps RSS results at 50
and Nixle archive entries at 20, and limits detail fetches to the worker budget
with a maximum of 20 per run. It spaces detail requests by 500 milliseconds.

After initial loading, each Nixle run reads robots, the archive and the newest
two alerts to catch corrections; unseen/changed alerts take precedence. Each
RSS run reads robots and its feed. With no new posts this is approximately 148
requests an hour across the 39 sources, or 107,000 per 30 days. New posts and
initial loading add detail requests. This estimate excludes retries; hosting,
bandwidth and database costs depend on the deployment. There is no paid API
dependency in this implementation.

IDs are stable and unchanged records keep their content hash. Failed detail
reads fail the source run and are retried; they are not recorded as processed.
An HTML login/challenge page is an error, rather than a successful empty feed.

## Evidence and reproducibility

The full discovery snapshot is in `docs/data/police-sources/`:

- `inventory.json` and `channels.csv`: cities, populations, coordinates, source
  candidates, provenance, access results and discovery errors.
- `index.html`: standalone searchable research directory, including the original
  100 km view around 37.243507, -121.942648.
- `indexed-searches.json`: additional web discovery results with original queries.
- `nixle-directories.json`: publisher links actually found in public city pages.
- `validation.json`: feed/archive format, item counts and latest date labels.
  An archive with items can still be stale or belong to a different jurisdiction;
  this count is not the number of live city feeds.
- `ingestion-check.json`: live adapter results for the explicitly enabled cities.

`docs/data/police-ingestion-ca.json` is the explicit review list that enables
ingestion. Discovery never adds a feed to it automatically. The generated runtime
catalogue is `packages/adapters/src/police-sources-ca.json` and includes at most six
reference links per city. Sources without ingestion remain labelled as leads.

Population source:
https://www2.census.gov/programs-surveys/popest/datasets/2020-2025/cities/totals/sub-est2025.csv

Reference points:
https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2025_Gazetteer/2025_Gaz_place_national.zip

Government domain registry:
https://github.com/cisagov/dotgov-data

Discovery also uses Wikidata FIPS-matched official-website leads and search
results; these are candidates, not independent proof of police ownership.
Blocked websites, empty calendars, stale feeds and social accounts are retained
as references where useful. In particular, an accessible feed on an unverified
domain is insufficient for activation.

```sh
python3 scripts/discover-police-sources.py --state CA --min-population 50000
python3 scripts/discover-police-nixle.py
python3 scripts/build-police-source-report.py --validate
# Review agency identity, jurisdiction, dates and access before editing the explicit list.
python3 scripts/build-police-catalogue.py
bun scripts/check-police-feeds.js
bunx biome check --write docs/data packages/adapters/src/police-sources-ca.json
python3 test/police-source-discovery.test.py
bun test test/police-updates.test.js test/geo.test.js
```

Discovery resumes existing results; use `--refresh` to repeat city website scans.
Feed validation and Nixle directory discovery resume their snapshots as well;
remove the particular validation/directory entry to recheck it. The live adapter
smoke check always makes fresh requests and writes no database records.

For another state, discover into a separate directory with `--state XX --output
docs/data/police-sources-xx`. Review its city-specific publishers before adding a
runtime catalogue and seeds. Do not overwrite the California directory to add a
second state. The runtime builder currently accepts the CA/50,000 inventory only.

Normal application startup seeds these 39 hourly sources and the saved feed
idempotently; no database migration is required. Deployment and worker operation
are required before the new sources appear on the public site.
