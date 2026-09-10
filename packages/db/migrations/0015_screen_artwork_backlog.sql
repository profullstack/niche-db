-- An item with no enricher that applied to it is still stamped enriched, so a
-- miss costs one look and not one a tick forever. It also means the 430,000
-- titles the IMDb dumps landed before the screen collection had an enricher
-- were stamped with nothing found, and tmdb-artwork would never see them.
-- Clear the stamp on the ones it has something to add to: a title with no
-- picture from a source that never carries one.
update items i
set enriched_at = null
from collections c, sources s
where c.id = i.collection_id
  and s.id = i.source_id
  and c.slug = 'screen'
  and i.kind = 'title'
  and i.image_url is null
  and s.adapter = 'imdb-ratings'
  and i.enriched_at is not null;
