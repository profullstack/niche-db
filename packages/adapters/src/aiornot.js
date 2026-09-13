import { defineAdapter, first, slugify, stripHtml, xmlItems } from '@nichedb/core/adapter';

/**
 * Media judged by people, from aiornot.vote.
 *
 * aiornot.vote shows a photorealistic image or video and asks whether it was
 * made by a model; the crowd's answer is the product. The site publishes three
 * RSS feeds of the same pool: the newest media, the hand-picked featured set,
 * and what is being guessed on right now. Keyless, fifty items a feed.
 *
 * The same submission can be in more than one feed -- a new upload that is
 * also trending, a featured one that is also new -- and it is one submission.
 * The guid is the media id on every feed, so the first feed to carry an item
 * writes it and each later feed only adds its own tag. A run therefore reads
 * `latest` first, because that is the feed with the most items in it.
 */

const BASE = 'https://aiornot.vote';

/** The three documents, keyed by the tag a feed adds to what it carries. */
export const FEEDS = {
  latest: `${BASE}/rss.xml`,
  featured: `${BASE}/rss/featured.xml`,
  trending: `${BASE}/rss/trending.xml`,
};

/**
 * What the enclosure is, from the categories the feed writes. The last
 * category is the media type on every item measured (`image` or `video`);
 * the enclosure's MIME type is the fallback.
 */
function mediaTypeOf(categories, enclosure) {
  const known = categories.find((c) => c === 'image' || c === 'video');
  if (known) return known;
  const mime = enclosure?.attrs?.type ?? '';
  if (/^video\//i.test(mime)) return 'video';
  if (/^image\//i.test(mime)) return 'image';
  return null;
}

/** One feed entry, or null if it has no link or title. */
export function toItem(it, feed) {
  const url = first(it.link)?.text?.trim();
  if (!url) return null;
  const title = first(it.title)?.text?.trim();
  if (!title) return null;

  const categories = (Array.isArray(it.category) ? it.category : it.category ? [it.category] : [])
    .map((c) => c.text?.trim().toLowerCase())
    .filter(Boolean);
  const enclosure = first(it.enclosure);
  const mediaType = mediaTypeOf(categories, enclosure);

  // The description is the image again, the prompt and the vote count so far.
  // The prompt and the count are the summary; the image is already a field.
  const summary =
    stripHtml(first(it.description)?.text ?? '')
      .replace(/\s*Tags:.*$/i, '')
      .trim()
      .slice(0, 600) || null;

  return {
    externalId: (first(it.guid)?.text || url).slice(0, 500),
    kind: 'submission',
    title,
    summary,
    url,
    imageUrl: mediaType === 'image' ? (enclosure?.attrs?.url ?? null) : null,
    publishedAt: first(it.pubDate)?.text ?? null,
    tags: ['aiornot', feed, ...categories.map(slugify)].filter(Boolean),
    data: {
      mediaType,
      mediaUrl: enclosure?.attrs?.url ?? null,
      mimeType: enclosure?.attrs?.type ?? null,
      categories,
      feeds: [feed],
    },
  };
}

export function parseFeed(xml, feed) {
  const out = [];
  for (const it of xmlItems(xml, 'item')) {
    const item = toItem(it, feed);
    if (item) out.push(item);
  }
  return out;
}

/**
 * Fold a second sighting of a submission into the first.
 *
 * Tags and `data.feeds` are unions; everything else is whatever the first
 * feed said, which for a run that starts with `latest` is the newest copy.
 */
export function merge(into, item) {
  for (const t of item.tags) if (!into.tags.includes(t)) into.tags.push(t);
  for (const f of item.data.feeds) if (!into.data.feeds.includes(f)) into.data.feeds.push(f);
  return into;
}

export const aiornot = defineAdapter({
  name: 'aiornot',
  title: 'AI or Not media',
  collection: 'ai-media',
  description:
    'Photorealistic images and videos submitted to aiornot.vote for people to judge as AI or not: the newest, the featured set and what is trending, each with its media file, categories and the votes so far. Three keyless RSS feeds; a submission on more than one is stored once and tagged with each.',
  docs: 'https://aiornot.vote/rss.xml',
  kinds: ['submission'],
  cadenceMinutes: 30,
  configFields: [
    {
      key: 'feeds',
      label: 'Feeds',
      type: 'list',
      required: true,
      placeholder: Object.keys(FEEDS).join(', '),
      help: 'Any of latest, featured and trending. Latest is read first so a submission on two feeds keeps its newest copy.',
    },
  ],
  defaults: { feeds: Object.keys(FEEDS) },
  defaultSources: [
    {
      slug: 'aiornot-media',
      name: 'AI or Not: latest, featured and trending',
      config: { feeds: Object.keys(FEEDS) },
    },
  ],
  async pull({ config, http, log, deadline }) {
    const wanted = new Set(
      (Array.isArray(config.feeds) ? config.feeds : String(config.feeds ?? '').split(',')).map(
        (f) => String(f).trim().toLowerCase(),
      ),
    );
    // In FEEDS order, whatever order the config listed them in: see the note
    // at the top of this file.
    const feeds = Object.keys(FEEDS).filter((f) => wanted.has(f));

    const byUrl = new Map();
    const failed = [];
    for (const feed of feeds) {
      if (Date.now() > deadline) break;
      try {
        const xml = await http.text(FEEDS[feed], {
          headers: { accept: 'application/rss+xml, application/xml, */*' },
          timeoutMs: 15_000,
        });
        for (const item of parseFeed(xml, feed)) {
          const prior = byUrl.get(item.url);
          if (prior) merge(prior, item);
          else byUrl.set(item.url, item);
        }
      } catch (err) {
        failed.push(`${feed} (${err.message.slice(0, 40)})`);
      }
    }

    const items = [...byUrl.values()];
    if (failed.length) log(`failed: ${failed.join(', ')}`);
    log(`${items.length} submissions from ${feeds.length - failed.length} feeds`);
    return { items, note: `${items.length} submissions` };
  },
});
