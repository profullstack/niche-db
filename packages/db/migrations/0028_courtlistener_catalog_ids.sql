-- The CourtListener catalogue's rows get ids that cannot collide, and the FJC
-- Integrated Database joins the default walk.
--
-- The catalogue writes every table it walks under one source, and a row is
-- `(source_id, external_id)`. Judges, disclosures, oral arguments and opinion
-- clusters were all keyed by CourtListener's bare numeric id, and those tables
-- number their rows independently from 1, so the clusters walk (ten million
-- rows, walked last) overwrote the judge, disclosure and oral argument with the
-- same number as it went. On 2026-09-23, 7 of 406 sampled judge ids and 9 of
-- 400 disclosure ids were still what they had been written as; the rest had
-- become oral arguments and then opinions.
--
-- The adapter now prefixes every table but courts and clusters (`judge:2749`,
-- `disclosure:1108`, `audio:17`, `docket:…`, `fjc:…`), and a cursor from before
-- that walks the three tables again once the clusters are done. What this
-- deletes is what they left behind under bare ids: the catalogue's rows of
-- those kinds whose id is a bare number. A bare-number row of kind `opinion`
-- is a cluster, which is keyed that way still, and stays.
--
-- Found through the (collection_id, kind) index: the law collection holds a
-- few hundred thousand rows of these kinds at most, against the five million
-- the catalogue source holds in all.

with gone as (
  delete from items i
   where i.collection_id = (select id from collections where slug = 'law')
     and i.kind in ('judge', 'financial-disclosure', 'oral-argument', 'docket', 'case')
     and i.source_id in (select id from sources where adapter = 'courtlistener-catalog')
     and i.external_id ~ '^[0-9]+$'
  returning i.source_id
)
update sources s
   set item_count = greatest(0, s.item_count - g.n),
       updated_at = now()
  from (select source_id, count(*)::int as n from gone group by source_id) g
 where s.id = g.source_id;

-- The FJC Integrated Database (a few million district court cases, 280 MB) was
-- off by default and is on now. A stored config wins over the adapter's
-- defaults and seeding never rewrites one, so the seeded source is changed
-- here; one whose config says anything but the seeded 'false' is left alone.
update sources
   set config = config || '{"fjc": "true"}'::jsonb,
       updated_at = now()
 where adapter = 'courtlistener-catalog'
   and config ->> 'fjc' = 'false';
