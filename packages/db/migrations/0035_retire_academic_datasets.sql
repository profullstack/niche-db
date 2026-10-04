-- The `datasets` collection comes off the site: the Academic Torrents
-- datasets imported from bittorrented.com (0.35.x, PRs #180 and #181), all of
-- them, with the collection, its three feeds and the `academic-datasets`
-- source. Pulled on request, 2026-10-04.
--
-- WHY A MIGRATION AND NOT THE SEED
--
-- The code no longer seeds the collection, its feeds or its source, and the
-- adapter is no longer registered, but nothing in the seed deletes what it
-- once created, and an empty upstream snapshot (bittorrented now serves
-- `datasets: []`) never deletes upserted rows either. Nor would hiding them
-- do: `collections.public` only takes a collection out of the index, while
-- /c/<slug>, /i/<id>, search, the API, MCP, the sitemaps and the hourly dumps
-- read items without asking. So the rows go.
--
-- REVERSIBLE
--
-- The items are copied into `retired_items` first (same columns as `items`,
-- plus when and why), so nothing depends on bittorrented still holding them.
-- The niche the collection seeded is archived (the niches table's own
-- "hidden, kept for history" state), not deleted, so its page and history
-- come back with it. To restore: register `academicDatasets` in
-- packages/adapters/src/index.js again, put the collection and its feeds back
-- in packages/core/src/seed.js (as #180 had them), boot once so the seed
-- recreates them, then
--
--   insert into items (collection_id, source_id, external_id, kind, title,
--                      summary, url, image_url, published_at, time_known,
--                      precision, tags, data, content_hash, first_seen_at)
--   select c.id, s.id, r.external_id, r.kind, r.title, r.summary, r.url,
--          r.image_url, r.published_at, r.time_known, r.precision, r.tags,
--          r.data, r.content_hash, r.first_seen_at
--     from retired_items r, collections c, sources s
--    where r.retired_collection = 'datasets'
--      and c.slug = 'datasets' and s.slug = 'academic-datasets'
--   on conflict do nothing;
--   update niches set status = 'open', collection_id = (select id from collections where slug = 'datasets')
--    where slug = 'datasets';
--
-- About two hundred rows, so no index is built here, and none is needed on
-- the archive.

create table if not exists retired_items (like items);
alter table retired_items add column if not exists retired_collection text;
alter table retired_items add column if not exists retired_at timestamptz;
alter table retired_items add column if not exists retired_reason text;

insert into retired_items
select i.*, 'datasets', now(), 'Academic Torrents datasets pulled from nichedb.dev on request'
  from items i
 where i.collection_id = (select id from collections where slug = 'datasets');

update niches
   set status = 'archived'
 where slug = 'datasets';

-- Cascades to the collection's sources (and their runs), items, feeds (and
-- their follows and deliveries) and its stored stats; the archived niche's
-- collection_id is set null.
delete from collections where slug = 'datasets';
