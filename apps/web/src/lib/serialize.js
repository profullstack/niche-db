import { defaultEnrichers } from '@nichedb/enrichers';

/** The public shapes of the things the API, the feeds and MCP return. */

/**
 * Which enrichers a feed shows. A feed with no `enrichers` in its query shows
 * the collection's defaults; an explicit list shows exactly that list.
 */
export function allowedEnrichers(feedOrCollection) {
  const q = feedOrCollection?.query;
  const parsed = typeof q === 'string' ? JSON.parse(q) : q;
  if (Array.isArray(parsed?.enrichers)) return new Set(parsed.enrichers);
  return new Set(
    defaultEnrichers(feedOrCollection?.collection_slug ?? feedOrCollection?.slug ?? ''),
  );
}

export function enrichmentOut(item, allowed) {
  const raw =
    typeof item.enrichment === 'string' ? JSON.parse(item.enrichment) : (item.enrichment ?? {});
  const out = {};
  for (const [k, v] of Object.entries(raw)) if (!allowed || allowed.has(k)) out[k] = v;
  return out;
}

export function itemOut(i, siteUrl, { enrichers = null } = {}) {
  return {
    id: Number(i.id),
    collection: i.collection_slug,
    source: i.source_slug,
    adapter: i.adapter,
    kind: i.kind,
    // The upstream's own id, so a site mirroring the collection keeps the
    // key it always had rather than parsing one out of the URL; and when the
    // row last changed, so a mirror can advance its cursor from the page.
    external_id: i.external_id,
    updated_at: i.updated_at,
    title: i.title,
    summary: i.summary,
    url: i.url,
    image_url: i.image_url,
    published_at: i.published_at,
    time_known: i.time_known,
    precision: i.precision,
    tags: i.tags,
    data: i.data,
    first_seen_at: i.first_seen_at,
    enrichment: enrichmentOut(
      i,
      enrichers ?? allowedEnrichers({ collection_slug: i.collection_slug }),
    ),
    page: `${siteUrl}/i/${i.id}`,
  };
}

export function sourceOut(s) {
  return {
    id: Number(s.id),
    slug: s.slug,
    name: s.name,
    description: s.description,
    adapter: s.adapter,
    collection: s.collection_slug,
    enabled: s.enabled,
    cadence_minutes: s.cadence_minutes,
    config: s.config,
    item_count: s.item_count,
    run_count: s.run_count,
    last_run_at: s.last_run_at,
    last_ok_at: s.last_ok_at,
    next_run_at: s.next_run_at,
    last_error: s.last_error,
  };
}

export function feedOut(f, siteUrl) {
  return {
    id: Number(f.id),
    slug: f.slug,
    name: f.name,
    description: f.description,
    collection: f.collection_slug,
    query: f.query,
    public: f.public,
    followers: f.follower_count,
    page: `${siteUrl}/f/${f.slug}`,
    rss: `${siteUrl}/f/${f.slug}.rss`,
    json: `${siteUrl}/f/${f.slug}.json`,
  };
}

export function collectionOut(c, siteUrl) {
  return {
    id: Number(c.id),
    slug: c.slug,
    name: c.name,
    description: c.description,
    sources: c.source_count,
    feeds: c.feed_count,
    items: c.item_count,
    page: `${siteUrl}/c/${c.slug}`,
  };
}
