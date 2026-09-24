-- A feed narrowed by a tag was unreadable on a large collection.
--
-- `/f/scotus-opinions` (kinds=[opinion], tags=[scotus] over the law collection)
-- returned 503 "that query took too long" at rest, not only under load. The
-- planner answered it with a BitmapAnd of two index scans: the tag side was
-- cheap (27,045 rows from items_tags_idx) but the other side built a bitmap
-- over 734,590 entries of items_kind_idx, every opinion in the collection, to
-- intersect with it. Measured on production, 2026-09-24: the query did not
-- finish in 120 s. Gathering the tag matches first and filtering afterwards did
-- finish, in 24 s -- still past the web timeout -- because it fetched 27,045
-- heap rows only to discard most of them.
--
-- Neither side of that intersection is avoidable while no single index answers
-- all three predicates. btree_gin lets one GIN index carry the two scalars
-- beside the array, so `collection_id = ? and kind = any(?) and tags && ?`
-- becomes one bitmap scan over the rows matching all three, and the heap is
-- touched for those alone.
--
-- Production builds this CONCURRENTLY before the rollout, as with
-- items_first_seen_idx in 0025: migrations run inside a transaction and CREATE
-- INDEX CONCURRENTLY cannot. The statement below is the same index, so it is a
-- no-op there and the real thing on a fresh deployment.
--
-- btree_gin is a contrib extension and not every Postgres has it -- pglite,
-- which the tests run migrations against, does not. Its absence is not a
-- failed migration: the database is correct without the index and only reads
-- the slower plan, so this checks first and says so rather than refusing to
-- boot on a deployment that cannot install it.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'btree_gin') then
    create extension if not exists btree_gin;
    create index if not exists items_collection_kind_tags_idx
      on items using gin (collection_id, kind, tags);
  else
    raise notice
      'btree_gin unavailable: tag and kind feed queries keep the slower plan';
  end if;
end
$$;
