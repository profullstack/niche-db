-- 0030 tried to build a large index inside a migration. Undoing that decision.
--
-- What happened on 2026-09-24. 0030 carried
-- `create index if not exists items_collection_kind_tags_idx`, a GIN index over
-- 35 million rows. Migrations run inside a transaction and before the process
-- serves anything, so that is a plain CREATE INDEX: it takes a lock that blocks
-- every write to `items` for the length of the build, while the app is not yet
-- listening.
--
-- On the deploy, a stuck `insert into items` already held a conflicting lock.
-- The migration queued behind it, every other write queued behind the
-- migration, boot never finished, and nichedb.dev returned 502 for fifteen
-- minutes. The index was not even built: an earlier interrupted CONCURRENTLY
-- attempt had left an INVALID index of the same name, and `if not exists` saw
-- the name and skipped, so 0030 recorded itself as applied over an index that
-- answers no query.
--
-- Both halves of that are now handled where they belong, in
-- packages/db/src/build-indexes.js: the build runs after boot, outside a
-- transaction, CONCURRENTLY, with a lock_timeout, and it drops an invalid
-- index before rebuilding so an interrupted build is repaired by the next boot
-- instead of silently persisting.
--
-- This migration drops the invalid leftover if one is here, so the builder
-- starts from a clean slate. It creates nothing: a missing index is a slower
-- query and the builder will fill it in, while a migration that builds one is
-- an outage waiting for a busy table.
do $$
declare
  invalid_index boolean;
begin
  select not i.indisvalid into invalid_index
  from pg_index i
  where i.indexrelid::regclass::text = 'items_collection_kind_tags_idx';

  if invalid_index then
    set local lock_timeout = '5s';
    drop index if exists items_collection_kind_tags_idx;
    raise notice 'dropped an invalid items_collection_kind_tags_idx; the builder rebuilds it';
  end if;
exception
  when lock_not_available then
    -- Busy table. The builder drops it too, so this is not worth a failed boot.
    raise notice 'could not drop the invalid index now; the index builder will';
end
$$;
