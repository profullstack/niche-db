-- Weather gets a collection of its own, and the NWS alerts move into it.
--
-- `alerts` was three unrelated things in one box: earthquakes, US weather
-- warnings and the GDACS disaster feed. Weather is the half that grew — NHC
-- cyclone advisories, NOAA space weather and NASA's global event tracker all
-- belong beside the NWS alerts and none of them belong beside an earthquake —
-- so it becomes its own collection and `alerts` keeps the rest.
--
-- The care here is entirely about not losing what already exists. Seeding is
-- idempotent by (collection, slug), so if the source row were left where it is
-- the next boot would create a SECOND nws-alerts source under `weather` and
-- both would poll the National Weather Service forever, double-writing every
-- warning in the country. So the existing rows are moved rather than left to
-- be duplicated:
--
--   * the `weather-alerts-us` source, with its cursor and its run history
--   * every item it has already ingested, which is what makes the feed's
--     archive survive the move
--   * the `severe-weather-us` feed, keeping its slug, because a feed URL is a
--     promise to whoever is polling it and /c/alerts/severe-weather-us
--     answering 404 tomorrow is a broken promise
--
-- Written to run on a database that has never had any of them, too: every
-- statement is conditional on the rows being there, so a fresh deployment
-- reaches the same place by seeding instead.

insert into collections (slug, name, description)
values (
  'weather',
  'Weather',
  'Weather as it is issued rather than forecast: every active US warning, watch and advisory from the National Weather Service, the tropical cyclones the National Hurricane Center is tracking advisory by advisory, geomagnetic storms from NOAA, and the wildfires, floods and severe storms NASA tracks worldwide.'
)
on conflict (slug) do nothing;

-- The items first: they are found through the source, so they have to move
-- while the source still says `alerts`.
update items i
   set collection_id = (select id from collections where slug = 'weather')
  from sources s
 where s.id = i.source_id
   and s.adapter = 'nws-alerts'
   and i.collection_id = (select id from collections where slug = 'alerts');

update sources
   set collection_id = (select id from collections where slug = 'weather')
 where adapter = 'nws-alerts'
   and collection_id = (select id from collections where slug = 'alerts');

-- The feed keeps its slug and its followers; only its collection changes.
update feeds
   set collection_id = (select id from collections where slug = 'weather')
 where slug = 'severe-weather-us'
   and collection_id = (select id from collections where slug = 'alerts');

-- And `alerts` stops describing weather it no longer holds.
update collections
   set description = 'Earthquakes and global disaster alerts, minutes after they are issued. Weather has a collection of its own.'
 where slug = 'alerts';
