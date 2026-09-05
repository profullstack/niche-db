/** The public shapes of the things the API, the feeds and MCP return. */

export function itemOut(i, siteUrl) {
  return {
    id: Number(i.id),
    collection: i.collection_slug,
    source: i.source_slug,
    adapter: i.adapter,
    kind: i.kind,
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
