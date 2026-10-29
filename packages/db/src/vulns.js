import { sql } from './index.js';
import { pgArray } from './queries.js';

/**
 * Reads behind /c/vulns/<id>: every row in the vulns collection that carries
 * one of the given join keys (`id:cve-2026-12537`, `related:mal-2026-18177`,
 * `oss-fuzz:60557`). `tags && keys` is an overlap on the items_tags_idx GIN
 * index, so a page is a couple of index scans however large the collection
 * grows. The keys go in as an array literal (see pgArray: Bun stringifies a
 * JS array parameter as `a,b`).
 */
export async function itemsForKeys(keys, { limit = 200, db = sql } = {}) {
  const wanted = [...new Set((keys ?? []).filter(Boolean))].slice(0, 100);
  if (wanted.length === 0) return [];
  return db`
    select i.id, s.adapter, s.slug as source, s.name as source_name, i.external_id, i.kind,
           i.title, i.summary, i.url, i.published_at, i.tags, i.data, i.updated_at
    from items i
    join sources s on s.id = i.source_id
    join collections c on c.id = i.collection_id
    where c.slug = 'vulns' and i.tags && ${pgArray(wanted)}::text[]
    order by i.published_at desc nulls last, i.id desc
    limit ${Math.min(Math.max(1, limit), 500)}
  `;
}

/** How many rows each vulns source holds, for the landing page. */
export async function vulnCounts({ db = sql } = {}) {
  return db`
    select s.adapter, s.slug, s.name, count(i.id)::int as items, max(i.updated_at) as updated_at
    from sources s
    join collections c on c.id = s.collection_id
    left join items i on i.source_id = s.id
    where c.slug = 'vulns'
    group by s.adapter, s.slug, s.name
    order by items desc
  `;
}
