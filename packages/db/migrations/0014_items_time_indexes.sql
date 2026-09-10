-- A site keeping its own copy of a collection asks "what changed since my last
-- sync" every minute, and a page of today's fixtures asks for a day's window
-- inside one collection. Neither had an index to answer from: published_at was
-- indexed alone, updated_at not at all.
create index if not exists items_collection_updated_idx on items (collection_id, updated_at desc);
create index if not exists items_collection_published_idx on items (collection_id, published_at);
