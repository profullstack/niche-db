# Hourly data dumps

The **Data** plan costs **$1,999 for 30 days**, prepaid through CoinPay, with
no automatic renewal. It includes every Pro entitlement plus bulk downloads.
The offer is on `/premium`; the product, purchase and instructions are at
`/dumps`. Checkout opens after the first complete snapshot is available.

## Delivery

A BullMQ job runs at the top of each UTC hour, and once after boot if the
current hour has no completed snapshot. It exports the published item records
in all public, non-early-access collections. Each record has the collection,
source, adapter, stable ID, timestamps, content and public enrichment fields.
Accounts, payment data, credentials, source configuration, private feeds and
nonpublic collections are never queried for the export.

All keyset pages are read in one repeatable-read transaction. A Postgres
advisory transaction lock prevents two instances from generating a snapshot
at once. About 16 MiB of uncompressed NDJSON becomes each independent gzip
part; no whole-database buffer is built. The manifest records SHA-256 hashes,
compressed sizes, row counts, source attribution and snapshot time.

Files go into a private S3-compatible bucket. A manifest is committed only
after every part uploads. Failed jobs preserve the previous snapshot and
remove staged files; retention cleanup also removes abandoned uploads from
crashed jobs. Completed snapshots are retained for 24 hours by default.
The latest completed snapshot is preserved on disk even if generation stalls,
but access and new purchases require a snapshot within the retention window.

## Client API

Use a Data subscriber's account API key:

```sh
curl -H 'Authorization: Bearer YOUR_API_KEY' https://nichedb.dev/api/v1/dumps/latest
```

The response lists `parts`, each with `url`, `sha256`, `bytes` and `rows`.
GET each URL with the same authentication and follow the redirect to storage.
The signed storage URL expires in five minutes. Poll the manifest hourly and
compare `id` to avoid downloading a snapshot twice.

Free, Premium and Pro accounts receive 402. Anonymous clients receive 401.
Administrators can inspect exports. Missing, expired or unknown files never
produce storage URLs. Expired/cancelled Data terms revert to the next active
plan and cannot obtain new download links.

`POST /api/dumps/buy` creates a Data checkout. OpenSaaS clients can subscribe
with `POST /api/v1/billing/subscribe {"plan":"data"}` and cancel through the
existing billing endpoint. CoinPay settlement grants only a 30-day Data term.

## Configuration

- `DATA_DUMPS_MONTH_CENTS`: 199900.
- `DATA_DUMPS_RETENTION_HOURS`: 24.
- `DATA_DUMPS_S3_ENDPOINT`, `DATA_DUMPS_S3_BUCKET`, `DATA_DUMPS_S3_REGION`.
- `DATA_DUMPS_S3_ACCESS_KEY_ID`, `DATA_DUMPS_S3_SECRET_ACCESS_KEY`.

Storage credentials belong only in the deployment environment. No public
bucket policy is required. The scheduler starts when all storage settings are
present. `packages/core/src/data-dumps.js` implements generation and retention;
`apps/web/src/routes/data-dumps.js` controls paid downloads.
