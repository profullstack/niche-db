-- The product graph re-reads shop pages daily (pit.world's reprice job), so an
-- offer remembers the price it had before its last change and when that change
-- was seen: enough to show "was $X" and a drop, without a history table.
-- ADD COLUMN with no default is a catalog-only change; lock_timeout keeps it
-- from queueing behind a long read (the 0044 lesson).
set local lock_timeout = '10s';
alter table product_offers add column if not exists previous_price numeric(14, 2);
alter table product_offers add column if not exists price_changed_at timestamptz;
