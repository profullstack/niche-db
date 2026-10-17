import { sql } from './index.js';

/**
 * Reads behind /reputation: the rows other sources already keep about an
 * address or a domain, found by the id each adapter files them under
 * (abuse.ch `ip:<x>` / `domain:<x>`, SURBL `surbl:<x>`). The ids go in as one
 * JSON document, never a JS array (Bun stringifies an array parameter as
 * `a,b`); `(source_id, external_id)` is unique, so each probe is an index hit.
 */
export async function itemsByAdapterIds(probes, { db = sql } = {}) {
  const wanted = (probes ?? []).filter((p) => p?.adapter && p?.externalId);
  if (wanted.length === 0) return [];
  const doc = JSON.stringify(wanted.map((p) => ({ adapter: p.adapter, id: p.externalId })));
  return db`
    select s.adapter, s.slug as source, i.external_id, i.kind, i.title, i.summary, i.url,
           i.published_at, i.tags, i.data, i.updated_at
    from jsonb_to_recordset(${doc}::text::jsonb) as w(adapter text, id text)
    join sources s on s.adapter = w.adapter
    join items i on i.source_id = s.id and i.external_id = w.id
    order by i.published_at desc nulls last
  `;
}
