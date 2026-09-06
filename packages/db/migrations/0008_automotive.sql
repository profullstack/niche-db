-- Automotive: the two things the collection cannot hold as items.
--
-- Everything else about a vehicle is an item like any other — a recall, a
-- complaint, a rating, a model year — and lives in `items` with the rest of
-- the site. Two things do not fit that shape:
--
--   auto_vin_lookups   a decoded VIN. It is not news, it has no publish date,
--                      and it is keyed by a string nobody can enumerate. It is
--                      a cache with a memory: the decode is expensive to get
--                      and free to keep, and which VINs get asked about is
--                      itself the most valuable thing the endpoint learns.
--   auto_place_cache   mechanics and parts shops near a point, from
--                      OpenStreetMap. Overpass is slow and often busy, so an
--                      answer is held per rounded tile rather than re-asked.
--
-- No VIN is joined to a person here. The table records the VIN, what the
-- government says the VIN means, and how often it was asked about. Nothing
-- about who asked.

create table auto_vin_lookups (
  vin           text primary key,
  -- Positions 1-3: the manufacturer. Worth its own column because it is the
  -- one part of a VIN that groups.
  wmi           text not null,
  model_year    int,
  make          text,
  model         text,
  body_class    text,
  vehicle_type  text,
  -- vPIC's full answer, as it gave it. Kept whole: the useful field is always
  -- the one that was not projected out.
  decoded       jsonb not null default '{}',
  -- Whether position 9 checks out under ISO 3779. False is not an error: a VIN
  -- outside North America may not carry a check digit at all.
  check_digit_ok boolean,
  source        text not null default 'vpic',
  lookup_count  int not null default 1,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  decoded_at    timestamptz not null default now()
);
create index auto_vin_lookups_wmi_idx on auto_vin_lookups (wmi);
create index auto_vin_lookups_vehicle_idx on auto_vin_lookups (model_year, make, model);
create index auto_vin_lookups_popular_idx on auto_vin_lookups (lookup_count desc, last_seen_at desc);

create table auto_place_cache (
  -- kind + the tile the query rounded to: 'car_repair:37.77:-122.42:8'
  key         text primary key,
  kind        text not null,
  places      jsonb not null default '[]',
  fetched_at  timestamptz not null default now()
);
create index auto_place_cache_fetched_idx on auto_place_cache (fetched_at);
