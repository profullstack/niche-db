-- Courts and case law get a collection of their own, and CourtListener moves into it.
--
-- `filings` held one CourtListener source, `courtlistener-opinions`, beside
-- the SEC and Federal Register sources. It never ingested a row (the search
-- API it read needed a token and the run failed on it), and the shape that
-- replaces it is not one source but a catalogue: opinions, oral argument
-- recordings, dockets, judges, financial disclosures and the courts
-- themselves, walked from the quarterly bulk dumps and kept current from the
-- feeds and the API. None of that belongs beside a Form D, so it becomes the
-- `law` collection.
--
-- The care here is the same as 0010's: seeding is idempotent by slug, and a
-- source row left under `filings` would keep its collection forever, because
-- `insertSource`'s conflict clause does not touch `collection_id`. So every
-- source whose adapter is CourtListener's (the family is named
-- `courtlistener`, `courtlistener-oral-arguments`, `courtlistener-api`,
-- `courtlistener-catalog`) is moved, with any items it holds, and its cursor
-- and error are cleared: the old source read the search API and the new one
-- reads the Atom feed, and a cursor from one means nothing to the other.
--
-- The collection is inserted here with the seed's name and description so the
-- move has somewhere to go on a database that boots this migration before
-- `ensureDefaults` runs. `upsertCollection` then updates the name and keeps
-- whichever description is already there, so the two agree.
--
-- Written to run on a database that has never had any of this, too: every
-- statement is conditional on the rows being there, and a fresh deployment
-- reaches the same place by seeding instead.

insert into collections (slug, name, description)
values (
  'law',
  'Courts & case law',
  'Court opinions as they are published, oral argument recordings, federal dockets, judges and their financial disclosures, and the courts themselves, from CourtListener (Free Law Project). The catalogue is walked from the quarterly bulk dumps, public domain; the newest rows arrive by feed within the hour and by the API a few times a day.'
)
on conflict (slug) do nothing;

-- The items first: they are found through the source, so they have to move
-- while the source still points at its old collection.
update items i
   set collection_id = (select id from collections where slug = 'law')
  from sources s
 where s.id = i.source_id
   and s.adapter like 'courtlistener%'
   and i.collection_id <> (select id from collections where slug = 'law');

update sources
   set collection_id = (select id from collections where slug = 'law'),
       cursor = '{}'::jsonb,
       last_error = null,
       next_run_at = now(),
       updated_at = now()
 where adapter like 'courtlistener%'
   and collection_id <> (select id from collections where slug = 'law');

-- And `filings` stops describing opinions it never held.
update collections
   set description = 'SEC EDGAR filings as they land (Form D raises, insider trades, 8-K events) and Federal Register documents.'
 where slug = 'filings'
   and description like '%court opinions%';
