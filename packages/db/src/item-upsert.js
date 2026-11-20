import { createHash } from 'node:crypto';

/** Write a batch of items, filtering URLs that were permanently suppressed. */
export async function upsertItemBatch({
  collectionId,
  sourceId,
  items,
  db,
  writeTimeoutMs,
  bound,
}) {
  const unique = new Map();
  for (const it of items) unique.set(it.externalId, it);
  const rows = [...unique.values()].map((it) => ({
    external_id: it.externalId,
    url_sha256: it.url ? createHash('sha256').update(String(it.url)).digest('hex') : null,
    kind: it.kind ?? 'item',
    title: it.title,
    summary: it.summary ?? null,
    url: it.url ?? null,
    image_url: it.imageUrl ?? null,
    published_at: it.publishedAt ?? null,
    time_known: it.timeKnown ?? true,
    precision: it.precision ?? 'minute',
    tags: it.tags ?? [],
    data: it.data ?? {},
    content_hash: it.contentHash ?? null,
    dedupe_key: it.dedupeKey ?? null,
  }));
  if (rows.length === 0) return { added: 0, updated: 0 };

  /*
   * Bounded, because an insert into `items` is not a small statement: sixteen
   * indexes, three of them GIN, and with fastupdate on it is the inserting
   * backend that merges a full pending list. Measured on production
   * 2026-09-24, that stalled single batches for 14, 27 and 41 minutes, and one
   * for 19 hours 29 minutes, each pinning the xmin horizon for its whole life
   * and blocking every index build and deploy behind it.
   *
   * packages/db/src/gin-maintenance.js removes the cause by merging those
   * lists on a schedule. This is the backstop: a batch that somehow still
   * cannot finish is cancelled and the run fails, which the retry rule already
   * knows how to handle. At-least-once is safe here, because the upsert is
   * idempotent per (source_id, external_id).
   */
  const out = await bound(
    db,
    writeTimeoutMs,
    (conn) => conn`
    insert into items (collection_id, source_id, external_id, kind, title, summary, url,
                       image_url, published_at, time_known, precision, tags, data, content_hash,
                       dedupe_key)
    select ${collectionId}, ${sourceId}, r.external_id, r.kind, r.title, r.summary, r.url,
           r.image_url, r.published_at, coalesce(r.time_known, true),
           coalesce(r.precision, 'minute'), coalesce(r.tags, '{}'), coalesce(r.data, '{}'),
           r.content_hash, r.dedupe_key
    from jsonb_to_recordset(${JSON.stringify(rows)}::text::jsonb) as r(
      external_id text, url_sha256 text, kind text, title text, summary text, url text,
      image_url text, published_at timestamptz, time_known boolean, precision text,
      tags text[], data jsonb, content_hash text, dedupe_key text)
    where r.url_sha256 is null or not exists (
      select 1 from item_suppressions s where s.url_sha256 = r.url_sha256
    )
    on conflict (source_id, external_id) do update set
      kind = excluded.kind, title = excluded.title,
      summary = coalesce(excluded.summary, items.summary),
      url = excluded.url, image_url = coalesce(excluded.image_url, items.image_url),
      published_at = excluded.published_at,
      time_known = excluded.time_known, precision = excluded.precision, tags = excluded.tags,
      data = excluded.data, content_hash = excluded.content_hash,
      dedupe_key = excluded.dedupe_key, updated_at = now()
    where items.content_hash is distinct from excluded.content_hash
    returning (xmax = 0) as inserted
  `,
  );
  let added = 0;
  for (const row of out) if (row.inserted) added++;
  return { added, updated: out.length - added };
}
