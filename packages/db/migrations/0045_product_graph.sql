-- The product graph (core/products.js): one row per offer a store states in
-- its own product page JSON-LD, read from the records the pit.world crawler
-- pushes to /api/v1/sites/records. `product_key` is the identity offers from
-- different stores meet on: gtin:<14>, mpn:<brand>:<mpn>, or url:<page>.
--
-- Its own table, not items: text search over the items GIN index takes 1-4 s
-- even filtered to one source (pitbot-crawler notes), and pit.world gives an
-- engine 2.5 s. This table starts empty, so building its indexes here is safe
-- (the "never build a big index in a migration" rule is about items).
-- fastupdate off on the GIN indexes: the inserting backend never merges a
-- pending list (the 2026-09-24 stalls).
create table if not exists product_offers (
  id bigserial primary key,
  product_key text not null,
  gtin text,
  mpn text,
  sku text,
  brand text,
  name text not null,
  variant text,
  category text,
  image_url text,
  page_url text not null,
  offer_url text not null,
  host text not null,
  seller text,
  price numeric(14, 2),
  currency text,
  availability text,
  condition text,
  first_seen_at timestamptz not null default now(),
  seen_at timestamptz not null default now(),
  search tsvector generated always as (
    to_tsvector('simple',
      coalesce(name, '') || ' ' || coalesce(brand, '') || ' ' ||
      coalesce(variant, '') || ' ' || coalesce(category, '') || ' ' ||
      coalesce(mpn, '') || ' ' || coalesce(sku, ''))
  ) stored,
  unique (offer_url, product_key)
);

create index if not exists product_offers_key_idx on product_offers (product_key);
create index if not exists product_offers_page_idx on product_offers (page_url);
create index if not exists product_offers_gtin_idx on product_offers (gtin) where gtin is not null;
create index if not exists product_offers_host_idx on product_offers (host, seen_at desc);
create index if not exists product_offers_search_idx on product_offers using gin (search) with (fastupdate = off);
