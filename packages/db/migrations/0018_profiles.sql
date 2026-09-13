-- People: one entry per person, assembled from every app that serves their
-- OpenProfile.md (logicsrc.com/openprofile), and theirs to edit once claimed.
--
-- A profile is not an item. It is a person who may be met on several apps
-- (a podcaster on p0dcasters, a lead on OutreachGraph, an author on
-- rssamplifier), and the row is what those meetings merge into. Each app's
-- document is kept as a source; the identity keys (Web, every Accounts URL,
-- Email, DID) are what two documents are matched on, never the name; and the
-- rendered `doc` is the merge of every source under the owner's overrides,
-- which a re-pull never overwrites. The `profiles` collection carries one
-- item per profile so feeds, search and the API keep working unchanged.

create table profiles (
  id            bigserial primary key,
  -- The name part of the URL, cosmetic: /c/profiles/<slug>-<id>. The id is
  -- what resolves; a stale slug redirects.
  slug          text not null,
  -- Chosen by the owner after a claim: /c/profiles/<handle>. Unique, optional.
  handle        citext unique,
  name          text not null,
  kind          text,
  headline      text,
  -- The rendered OpenProfile.md as served.
  doc           text not null default '',
  -- The parsed view: identity, accounts, topics, broadcasts, guest, sources.
  data          jsonb not null default '{}',
  owner_user_id uuid references users(id) on delete set null,
  claimed_at    timestamptz,
  -- email | linkback | admin
  claim_method  text,
  -- The owner's overlay (@profullstack/openprofile Overrides). Wins over every source.
  overrides     jsonb not null default '{}',
  public        boolean not null default true,
  -- The source whose items row carries this profile in the collection.
  source_id     bigint references sources(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index profiles_owner_idx on profiles (owner_user_id);
create index profiles_updated_idx on profiles (updated_at desc);
create index profiles_name_trgm_idx on profiles using gin (name gin_trgm_ops);
create index profiles_slug_idx on profiles (slug);
-- A handle may not look like the slug-id form, or the two URL shapes could collide.
alter table profiles add constraint profiles_handle_shape
  check (handle is null or (handle ~ '^[a-z0-9][a-z0-9-]{1,39}$' and handle !~ '-[0-9]+$' and handle !~ '^[0-9]+$'));

-- The keys a de-duplicator compares: web:<host/path>, account:<host/path>,
-- email:<address>, did:<did>. One key belongs to one profile.
create table profile_identities (
  profile_id bigint not null references profiles(id) on delete cascade,
  key        text not null primary key,
  created_at timestamptz not null default now()
);
create index profile_identities_profile_idx on profile_identities (profile_id);

-- Every app's document about the person, as fetched, so a merge can be redone
-- and a reader can see where each fact came from.
create table profile_sources (
  id         bigserial primary key,
  profile_id bigint not null references profiles(id) on delete cascade,
  -- Which app: p0dcasters, outreachgraph, rssamplifier, ... (the listing's host).
  app        text not null,
  -- The openprofile.md URL, the identity of the source.
  source_url text not null unique,
  page_url   text,
  doc        text not null,
  fetched_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index profile_sources_profile_idx on profile_sources (profile_id);
