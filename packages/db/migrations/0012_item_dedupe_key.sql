-- One story, one row, however many sources carried it.
--
-- `items` is unique on (source_id, external_id), which is the right key for
-- "has this source told us this before". It is the wrong one for "do we already
-- have this story": two sources reporting the same article are two rows, with
-- two different external ids, and nothing in the schema could say they were the
-- same thing.
--
-- That was invisible while every news source read a different corpus. It stops
-- being invisible the moment a collection aggregates aggregators -- a BBC story
-- arrives from the newsroom's own feed, from GDELT, and from two directories
-- that both index the BBC, and a reader gets it four times.
--
-- So: a normalised form of the article URL, stored per item, and a per
-- collection flag saying whether sharing one means being the same story.

alter table items add column if not exists dedupe_key text;

-- Only where it means something. A `null` key (an item with no URL) never
-- collides with anything, which is why this index is partial rather than a
-- constraint: it answers "who already holds this key in this collection",
-- and the answer for null is "nobody".
create index if not exists items_dedupe_key_idx
  on items (collection_id, dedupe_key)
  where dedupe_key is not null;

-- Off everywhere except where it has been reasoned about.
--
-- Two sources naming the same URL is not always one thing: a package index and
-- a changelog can both point at a release page and mean different rows, and a
-- filing that cites a document is not that document. Deduplicating those would
-- silently drop real items, so this is opt-in per collection rather than a
-- platform-wide rule. `news` turns it on; the other thirteen keep today's
-- behaviour exactly.
alter table collections add column if not exists dedupe_urls boolean not null default false;

update collections set dedupe_urls = true where slug = 'news';
