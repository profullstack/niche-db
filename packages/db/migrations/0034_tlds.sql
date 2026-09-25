-- Top-level domains, and what a name under each one costs.
--
-- IANA publishes the list of top-level domains every day as a text file with
-- a version on its first line. Nobody publishes the difference between two
-- days, so `tlds` is that list kept as a table: a label that appears is added
-- with the list version it first appeared in, a label that disappears is
-- marked removed rather than deleted (names were bought under it), and every
-- appearance and disappearance is a row in `tld_changes`. The type and the
-- manager come from IANA's root zone database, the RDAP server from IANA's
-- bootstrap file; the shape is OpenTLD's top-level domain record
-- (logicsrc.com/docs/opentld).
--
-- `tld_prices` is one row per registrar and label: register, renew, transfer
-- and restore for one year, in the registrar's own currency. A label the
-- registrar stops selling gets `gone_at`, never a delete. The table is small
-- (a few thousand rows), so pages read it whole and facet in memory.

create table if not exists tlds (
  tld           text primary key,
  unicode       text,
  type          text,
  manager       text,
  rdap          text,
  status        text not null default 'delegated' check (status in ('delegated', 'removed')),
  first_seen    text,
  first_seen_at timestamptz not null default now(),
  removed       text,
  removed_at    timestamptz,
  list_version  text,
  updated_at    timestamptz not null default now()
);

create table if not exists tld_changes (
  id           bigserial primary key,
  tld          text not null,
  change       text not null check (change in ('added', 'removed', 'returned')),
  list_version text,
  at           timestamptz not null default now()
);
create index if not exists tld_changes_at on tld_changes (at desc);
create index if not exists tld_changes_tld on tld_changes (tld);

create table if not exists tld_registrars (
  slug         text primary key,
  name         text not null,
  web          text,
  source_url   text,
  source_kind  text,
  currency     text,
  attribution  text,
  last_read_at timestamptz,
  last_count   integer,
  last_error   text
);

create table if not exists tld_prices (
  registrar     text not null references tld_registrars (slug) on delete cascade,
  tld           text not null,
  currency      text not null,
  register      numeric(12, 2),
  renew         numeric(12, 2),
  transfer      numeric(12, 2),
  restore       numeric(12, 2),
  promo         jsonb,
  privacy       text,
  idn           boolean,
  premium       text,
  restrictions  text,
  url           text,
  extra         jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  seen_at       timestamptz not null default now(),
  gone_at       timestamptz,
  primary key (registrar, tld)
);
create index if not exists tld_prices_tld on tld_prices (tld);

-- One row per upstream file: the version or hash last read, so an unchanged
-- file costs one fetch and no writes, and the error when it failed.
create table if not exists tld_sync (
  source     text primary key,
  version    text,
  fetched_at timestamptz,
  count      integer,
  error      text
);
