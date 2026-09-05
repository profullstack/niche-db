-- Crawl passes sold over x402, one row per sale, so a buyer's lifetime spend
-- can set their price: the more an agent has paid, the less each day costs.
create table if not exists crawl_sales (
  id bigserial primary key,
  payer text,
  ref text unique,
  days int not null default 1,
  price_cents int not null,
  total_cents int not null,
  currency text not null default 'USD',
  user_agent text,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists crawl_sales_payer_idx on crawl_sales (lower(payer), created_at desc);
