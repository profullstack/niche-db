-- NicheDB: collections of sources that fill a table of items, and feeds that
-- cut that table into something a person, a reader or an agent can follow.
--
--   collection  a niche: games, packages, filings, ...
--   source      one configured adapter inside a collection (Steam new releases,
--               the npm changes feed, EDGAR Form D filings)
--   item        one row a source produced. The universal shape: title, url, when,
--               tags, plus the adapter's own payload in `data`
--   feed        a saved query over a collection. What people follow. Has an RSS
--               and JSON rendering, and a page
--
-- Accounts are magic link + passkey. There is no password column, on purpose.

create extension if not exists citext;
create extension if not exists pg_trgm;

-- array_to_string is only STABLE, and a generated column needs IMMUTABLE.
create or replace function immutable_join(text[]) returns text
  language sql immutable parallel safe
  as $$ select array_to_string($1, ' ') $$;

create table users (
  id           uuid primary key default gen_random_uuid(),
  email        citext not null unique,
  -- user | admin. The first account is an admin; ADMIN_EMAILS promotes on sign-in.
  role         text not null default 'user',
  handle       citext unique,
  display_name text,
  timezone     text not null default 'UTC',
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz
);

-- Magic links. Only the hash is stored, so a database read cannot mint a session.
create table login_tokens (
  token_hash  bytea primary key,
  email       citext not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  consumed_at timestamptz
);
create index login_tokens_expires_idx on login_tokens (expires_at);

create table sessions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  user_agent text
);
create index sessions_user_idx on sessions (user_id);
create index sessions_expires_idx on sessions (expires_at);

create table passkeys (
  credential_id text primary key,
  user_id       uuid not null references users(id) on delete cascade,
  public_key    bytea not null,
  counter       bigint not null default 0,
  transports    text[] not null default '{}',
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);
create index passkeys_user_idx on passkeys (user_id);

-- API keys for the CLI, MCP and anything scripted. Hash only; the key is shown
-- once. `prefix` is the first characters, so a list can name a key without
-- being able to use it.
create table api_keys (
  -- The manager's own uuid, as text: it is what its records are keyed by.
  id           text primary key,
  user_id      uuid not null references users(id) on delete cascade,
  name         text not null default 'default',
  prefix       text not null,
  key_hash     bytea not null unique,
  permissions  jsonb not null default '{"read": true, "write": true}',
  is_active    boolean not null default true,
  expires_at   timestamptz,
  metadata     jsonb not null default '{}',
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
create index api_keys_user_idx on api_keys (user_id) where is_active;

create table push_subscriptions (
  id          bigserial primary key,
  user_id     uuid not null references users(id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  created_at  timestamptz not null default now(),
  last_ok_at  timestamptz,
  disabled_at timestamptz
);
create index push_subs_user_idx on push_subscriptions (user_id) where disabled_at is null;

-- ---------------------------------------------------------------------------
-- The catalogue.
-- ---------------------------------------------------------------------------

create table collections (
  id          bigserial primary key,
  slug        text not null unique,
  name        text not null,
  description text,
  -- Null owner means a system collection, managed by admins.
  owner_id    uuid references users(id) on delete set null,
  public      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table sources (
  id              bigserial primary key,
  collection_id   bigint not null references collections(id) on delete cascade,
  -- The adapter's registry name: steam, npm, edgar, ...
  adapter         text not null,
  slug            text not null unique,
  name            text not null,
  description     text,
  -- Adapter options: which forms, which repos, which Twitch client. Secrets
  -- come from the environment, never from here, so a config is safe to show.
  config          jsonb not null default '{}',
  enabled         boolean not null default true,
  cadence_minutes int not null default 60,
  -- Adapter-owned resume state: a sequence number, a last-seen id, a token.
  cursor          jsonb not null default '{}',
  owner_id        uuid references users(id) on delete set null,
  -- Scheduling is driven by data, not by a timer: the tick asks "what is due".
  next_run_at     timestamptz not null default now(),
  last_run_at     timestamptz,
  last_ok_at      timestamptz,
  last_error      text,
  run_count       int not null default 0,
  item_count      int not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index sources_collection_idx on sources (collection_id);
create index sources_due_idx on sources (next_run_at) where enabled;

create table runs (
  id          bigserial primary key,
  source_id   bigint not null references sources(id) on delete cascade,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  -- running | ok | error
  status      text not null default 'running',
  seen        int not null default 0,
  added       int not null default 0,
  updated     int not null default 0,
  error       text,
  note        text
);
create index runs_source_idx on runs (source_id, started_at desc);

create table items (
  id            bigserial primary key,
  collection_id bigint not null references collections(id) on delete cascade,
  source_id     bigint not null references sources(id) on delete cascade,
  -- The adapter's own id for the thing: an appid, a package@version, an
  -- accession number. Unique per source, so a re-fetch updates rather than
  -- duplicates.
  external_id   text not null,
  -- What kind of thing, in the adapter's vocabulary: game, release, version,
  -- model, filing, document. A feed can filter on it.
  kind          text not null default 'item',
  title         text not null,
  summary       text,
  url           text,
  image_url     text,
  -- When it happened or will happen. Null when the source has no date at all.
  published_at  timestamptz,
  -- Whether published_at is a real instant or a date we padded to noon UTC.
  time_known    boolean not null default true,
  -- minute | day | month | year
  precision     text not null default 'minute',
  tags          text[] not null default '{}',
  -- The adapter's payload, as it chose to keep it. Never required by the core.
  data          jsonb not null default '{}',
  -- Hash of the normalised row, so a re-fetch that changes nothing writes nothing.
  content_hash  text,
  first_seen_at timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  search        tsvector generated always as (
    to_tsvector('simple',
      coalesce(title, '') || ' ' || coalesce(summary, '') || ' ' || immutable_join(tags))
  ) stored,
  unique (source_id, external_id)
);
-- "Newest in this collection" is the site's hot read; id order is arrival order.
create index items_collection_id_idx on items (collection_id, id desc);
create index items_source_id_idx on items (source_id, id desc);
create index items_published_idx on items (published_at desc nulls last);
create index items_kind_idx on items (collection_id, kind, id desc);
create index items_search_idx on items using gin (search);
create index items_tags_idx on items using gin (tags);
create index items_title_trgm_idx on items using gin (title gin_trgm_ops);

create table feeds (
  id            bigserial primary key,
  slug          text not null unique,
  collection_id bigint not null references collections(id) on delete cascade,
  name          text not null,
  description   text,
  owner_id      uuid references users(id) on delete cascade,
  public        boolean not null default true,
  -- { sources: [slug], kinds: [kind], tags: [tag], q: 'text', upcoming: bool }
  -- An empty object is the whole collection.
  query         jsonb not null default '{}',
  follower_count int not null default 0,
  -- The delivery scanner's cursor: items above this id have not been considered.
  last_scanned_item_id bigint not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index feeds_collection_idx on feeds (collection_id);
create index feeds_owner_idx on feeds (owner_id);

create table follows (
  user_id    uuid not null references users(id) on delete cascade,
  feed_id    bigint not null references feeds(id) on delete cascade,
  channels   text[] not null default '{webpush,email}',
  created_at timestamptz not null default now(),
  primary key (user_id, feed_id)
);
create index follows_feed_idx on follows (feed_id);

-- At-most-once delivery. The primary key IS the idempotency guard.
create table deliveries (
  feed_id  bigint not null references feeds(id) on delete cascade,
  user_id  uuid not null references users(id) on delete cascade,
  item_id  bigint not null references items(id) on delete cascade,
  channel  text not null,
  status   text not null default 'sent',
  sent_at  timestamptz not null default now(),
  primary key (feed_id, user_id, item_id, channel)
);
create index deliveries_sent_idx on deliveries (sent_at);

-- ---------------------------------------------------------------------------
-- Money. Same shape as the sibling sites, because packages/payments is shared.
-- ---------------------------------------------------------------------------

create table payments (
  id           bigserial primary key,
  user_id      uuid not null references users(id) on delete cascade,
  provider     text not null default 'coinpay',
  provider_ref text not null,
  amount_cents int not null,
  currency     text not null default 'USD',
  status       text not null default 'pending',
  raw          jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (provider, provider_ref)
);
create index payments_user_idx on payments (user_id);

create table memberships (
  id          bigserial primary key,
  user_id     uuid not null references users(id) on delete cascade,
  payment_id  bigint unique references payments(id) on delete set null,
  started_at  timestamptz not null,
  expires_at  timestamptz not null,
  price_cents int not null,
  currency    text not null default 'USD',
  created_at  timestamptz not null default now()
);
create index memberships_user_idx on memberships (user_id, expires_at desc);

-- Metering for the public API, per key or per address, per hour.
create table api_usage (
  bucket   text not null,
  hour     timestamptz not null,
  count    int not null default 0,
  primary key (bucket, hour)
);
