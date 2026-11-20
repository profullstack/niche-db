-- Keep specifically removed items out of future ingests without retaining
-- their URLs in the suppression table. SHA-256 tokens are computed by the
-- writer from each item's canonical URL.
create table if not exists item_suppressions (
  url_sha256 text primary key check (url_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);

-- This one URL token refers to a sensitive opinion page. Keep only the hash.
insert into item_suppressions (url_sha256)
values ('5a067870a59a6e2080085085557559c268e9497b2b6c0d8a0ee2cea8113046b3')
on conflict do nothing;

-- Remove the existing NicheDB item by its stable source slug and provider ID;
-- deleting the item cascades to its delivery rows.
delete from items
 where source_id = (select id from sources where slug = 'courtlistener-opinions')
   and external_id = '11061729';
