/** RSS 2.0 and JSON Feed renderings of a list of items. */

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export function buildRss({ title, link, description, selfUrl, items, siteUrl }) {
  const entries = items
    .map((i) => {
      const url = i.url ?? `${siteUrl}/i/${i.id}`;
      const when = i.published_at ? new Date(i.published_at) : new Date(i.first_seen_at);
      return [
        '<item>',
        `<title>${esc(i.title)}</title>`,
        `<link>${esc(url)}</link>`,
        `<guid isPermaLink="false">${esc(`${siteUrl}/i/${i.id}`)}</guid>`,
        `<pubDate>${when.toUTCString()}</pubDate>`,
        ...(i.tags ?? []).slice(0, 10).map((t) => `<category>${esc(t)}</category>`),
        i.summary ? `<description>${esc(i.summary)}</description>` : '',
        i.image_url ? `<enclosure url="${esc(i.image_url)}" type="image/jpeg" length="0" />` : '',
        '</item>',
      ].join('');
    })
    .join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '<channel>',
    `<title>${esc(title)}</title>`,
    `<link>${esc(link)}</link>`,
    `<description>${esc(description ?? title)}</description>`,
    `<atom:link href="${esc(selfUrl)}" rel="self" type="application/rss+xml" />`,
    `<lastBuildDate>${new Date().toUTCString()}</lastBuildDate>`,
    entries,
    '</channel>',
    '</rss>',
  ].join('\n');
}

export function buildJsonFeed({ title, link, description, selfUrl, items, siteUrl }) {
  return {
    version: 'https://jsonfeed.org/version/1.1',
    title,
    home_page_url: link,
    feed_url: selfUrl,
    description: description ?? title,
    items: items.map((i) => ({
      id: String(i.id),
      url: i.url ?? `${siteUrl}/i/${i.id}`,
      title: i.title,
      content_text: i.summary ?? '',
      image: i.image_url ?? undefined,
      date_published: new Date(i.published_at ?? i.first_seen_at).toISOString(),
      tags: i.tags ?? [],
      _nichedb: {
        kind: i.kind,
        source: i.source_slug,
        collection: i.collection_slug,
        data: i.data,
      },
    })),
  };
}
