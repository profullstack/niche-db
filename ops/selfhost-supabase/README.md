# nichedb Postgres: Railway to self-hosted Supabase

This kit moves nichedb's production database off Railway's managed Postgres and
onto self-hosted Supabase (Docker) on our own server. It uses logical
replication, so the copy runs while production keeps writing, and the switch
costs a few minutes of failed writes instead of hours of downtime.

## Why

On 2026-09-23 the Railway database was 72 GB (`items` alone: 40 GB heap,
26 GB indexes, 5 GB TOAST, 35M rows). It grew about 6 GB a day from the dump
imports: books, law, podcasts. The volume is 100 GB. CPU is mostly idle, and
memory sits at the 24 GB cap with `shared_buffers` still at 128 MB. The problem
is disk, and it is cheaper to own.

## What is where

| Path | Role |
|---|---|
| `server/setup-server.sh` | Runs as root on the new box. Installs the official Supabase stack pinned to `self-hosted/v0.8.2` (Postgres 17.6.1.136), adds the nichedb overlay and starts it. Idempotent. |
| `nichedb-db` | Orchestrator, run from the dev box. Provisioning, DNS, vault, replication, cutover, rollback, cleanup. |
| `lib/split_post_data.py` | Splits the schema so primary keys go in before the copy, and the indexes, unique keys and foreign keys go in after. |
| `test/rehearse.sh` | Full local dress rehearsal on the real Supabase image. |
| `test/make-fixture.sh` | Builds the rehearsal fixture from production: schema, reference tables and newest items. No credentials, sessions, email or money tables. |

What the overlay changes on stock Supabase:

- **Postgres is published directly on 5432**, with TLS on and a self-signed
  cert for `db.nichedb.dev`. The app already connects with
  `sslmode=require` and does not verify the cert.
- **pg_hba**: from outside, only the `postgres` role gets in, and only over
  TLS. The compose network is pinned to `172.31.250.0/24` so the Docker
  gateway can be treated as outside. That covers clients Docker proxies:
  localhost and IPv6.
- **anon/authenticated lose schema `public`**, including what PUBLIC grants
  them by default. PostgREST can never serve nichedb's tables. Signups are
  off.
- **Tuning** is sized from the box's RAM and CPUs: 25% `shared_buffers`, 16 GB
  `max_wal_size`, parallel maintenance, and autovacuum tuned for `items`.
- **Supavisor** binds 127.0.0.1:6543 only. **Studio** sits behind Caddy with
  HTTPS and basic auth at `https://supabase.nichedb.dev`.
- **Docker logs** rotate at 3 x 50 MB. **Supabase's `setup.sh` output**,
  which prints every secret, goes to a root-only log, never the terminal.

## Before the server arrives

- **Keep Railway's volume ahead of the growth.** At about 6 GB a day, the 100 GB
  volume fills around 2026-09-26. Railway's Postgres also has to hold the
  replication slot's WAL during the copy, about 1.4 GB an hour, capped at
  `SLOT_KEEP_GB=8`.
- **Server sizing.** Plan for 3x the database on the data disk, NVMe,
  32 GB+ RAM, Ubuntu 24.04+ or Debian 12+. Put it on the **US East coast**:
  the app and its database both run in Railway's `us-east4` (northern
  Virginia), and the app stays there and queries across. Every extra
  millisecond of distance is paid on every query.
- **Freeze niche-db merges for the replication window.** Logical replication
  does not copy DDL. A deploy that runs a migration mid-copy parks the
  subscription. See "A migration landed mid-copy" below.

## Runbook

```sh
K=ops/selfhost-supabase/nichedb-db

$K provision root@<server-ip>   # install + start Supabase, fetch the connection
$K dns                          # db.nichedb.dev + supabase.nichedb.dev -> server
$K vault                        # server .env -> vault nichedb-supabase--prod,
                                # SELFHOST_* merged into nichedb--prod (backup kept)
$K check                        # versions, sizes, free disk on both sides

$K source-prep                  # Railway: wal_level=logical (RESTARTS Postgres,
                                # ~30-60 s app outage), TCP proxy, publication
$K schema                       # tables + primary keys on the target
$K subscribe                    # initial copy, then streaming
$K status                       # repeat until every table is state r
$K indexes                      # detached on the server; `status` tails the log
$K verify                       # schema must be identical

$K cutover                      # the switch (below)
# ...a few days later, once nothing points back:
$K cleanup                      # drop publication/slot, remove the TCP proxy
```

`cutover` does this, in order, and refuses to start unless every table is
ready, the index counts match, the schemas are identical and lag is under
64 MB:

1. Sets Railway's database `default_transaction_read_only = on` and closes
   the app's sessions. Reads keep working. Writes fail from here.
2. Waits until the target has confirmed every WAL byte written so far.
3. Copies all 32 sequence positions.
4. Drops the subscription, which also drops the slot on Railway.
5. Sets the app's `DATABASE_URL` to the new server and waits for the deploy.
6. Smoke tests `https://nichedb.dev/healthz` and counts the app's connections
   on the target.

Railway's database is left read-only and intact as the fallback.

**Rollback** with `$K rollback`. It restores `DATABASE_URL` to
`${{Postgres.DATABASE_URL}}` and makes Railway writable again. Anything
written to the new server after the cutover is not copied back.

State and secrets live in `~/.local/state/nichedb-selfhost/` (mode 0700).

### A migration landed mid-copy

The subscription disables itself on the first apply error, and `status` shows
it disabled with errors. Apply the migration's DDL to the target, then
re-enable:

```sh
$K apply-migration packages/db/migrations/00NN_name.sql
```

Its `schema_migrations` row arrives through replication, so the app will not
run it again. If the migration also changes data, apply only its DDL part.
The data changes come across from Railway anyway.

## Rehearsal

```sh
ops/selfhost-supabase/test/make-fixture.sh /tmp/nichedb-fixture   # needs railway login
ops/selfhost-supabase/test/rehearse.sh /tmp/nichedb-fixture
```

Passed on 2026-09-23 with the production schema: 53 tables, 32 sequences,
84 indexes, 68 foreign keys. A writer inserted, updated and deleted items on
the source through the whole run. Checks:

- **Data**: counts and an md5 over every item row are identical, and so is
  the generated `search` column.
- **Sequences**: a fresh insert after the cutover takes a new id.
- **Cutover**: the source rejects writes afterwards, and the subscription and
  slot are gone.
- **Access**: TLS is required, `supabase_admin` is refused from outside, and
  anon gets "permission denied for schema public" over REST.
- **The app's own Bun SQL pool** reads the target with `sslmode=require`.
- **Migrations**: `migrate-cli` reports "up to date" against the target.
- **Operations**: `rollback` restores writes, and a second `setup-server.sh`
  run keeps its secrets.

## Not covered yet

- **Backups** of the new server. Railway did this for us. Pick a destination
  (S3/B2 bucket) and add WAL-G or pgBackRest before deleting Railway's copy.
- **Redis** stays on Railway. Only Postgres moves.
- **The TLS cert is self-signed.** Encrypted, but the app does not verify it,
  same as today.
