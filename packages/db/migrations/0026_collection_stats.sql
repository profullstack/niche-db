-- Per-collection statistics, computed by the worker on a cadence and read by
-- the pages. Counting a collection of eight million rows and unnesting every
-- row's tags took ten seconds per page view, ran once per crawler hit, and
-- held every connection in the web pool; now it happens once per collection
-- per interval, off the request path.
create table if not exists collection_stats (
  collection_id bigint primary key references collections(id) on delete cascade,
  items integer not null default 0,
  items_today integer not null default 0,
  sources integer not null default 0,
  feeds integer not null default 0,
  kinds jsonb not null default '[]'::jsonb,
  tags jsonb not null default '[]'::jsonb,
  computed_at timestamptz not null default now(),
  ms integer not null default 0
);
