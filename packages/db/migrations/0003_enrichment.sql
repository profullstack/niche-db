-- Enrichment: what other places say about an item, stored beside it under the
-- enricher's own name, so a feed can choose which of it to show.
alter table items add column if not exists enrichment jsonb not null default '{}';
alter table items add column if not exists enriched_at timestamptz;
-- The worker's queue: newest first, never twice.
create index if not exists items_enrich_pending_idx on items (id desc) where enriched_at is null;
