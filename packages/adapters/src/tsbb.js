import { decodeEntities, defineAdapter, first, slugify, xmlItems } from '@nichedb/core/adapter';

/**
 * Topics from the tsbb.dev bulletin board.
 *
 * tsbb is the house forum software and tsbb.dev is its own board. The JSON API
 * at `/api/v1/latest` lists topics across the board, but a topic there does
 * not say which forum it is in, and the forum is the one thing a reader
 * filters by. So the walk is: `/api/v1/forums` for the list, then each forum's
 * own RSS at `/f/{slug}/feed.xml`, which carries the topic, its opening post
 * and its author. Keyless; both documents answer without a token and show
 * exactly what a browser would.
 *
 * A forum of `kind: category` is a heading with no topics of its own, and a
 * forum with no topics has no feed worth fetching; both are skipped from the
 * list rather than fetched and found empty.
 */

const BASE = 'https://tsbb.dev';

/** Forums read per run, however many the board has. */
const MAX_FORUMS = 40;

/**
 * Decoded, whitespace-collapsed, and null when nothing is left.
 *
 * `decodeEntities` always returns a string because the XML parser needs it to.
 * A title that was only an entity decodes to nothing, and a topic with no
 * title is not a topic, so the emptiness has to become null somewhere.
 */
const clean = (s) => {
  const t = decodeEntities(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t || null;
};

/** The forums worth reading: real forums, not headings, with something in them. */
export function readableForums(doc) {
  return (Array.isArray(doc?.forums) ? doc.forums : [])
    .filter((f) => f && typeof f.slug === 'string' && f.kind !== 'category')
    .filter((f) => !Number.isFinite(f.topics) || f.topics > 0)
    .map((f) => ({
      slug: f.slug,
      name: clean(f.name) ?? f.slug,
      description: clean(f.description),
    }));
}

/** One feed entry, or null if it has no link or title. */
export function toItem(it, forum) {
  const url = first(it.link)?.text?.trim();
  if (!url) return null;
  const title = clean(first(it.title)?.text);
  if (!title) return null;
  const author = clean(first(it['dc:creator'])?.text ?? first(it.author)?.text);

  return {
    externalId: (first(it.guid)?.text || url).slice(0, 500),
    kind: 'post',
    title,
    summary: clean(first(it.description)?.text)?.slice(0, 600) ?? null,
    url,
    imageUrl: null,
    publishedAt: first(it.pubDate)?.text ?? null,
    tags: ['tsbb', `forum:${forum.slug}`, author ? `by:${slugify(author)}` : null].filter(Boolean),
    data: {
      board: BASE,
      forum: forum.slug,
      forumName: forum.name,
      author,
    },
  };
}

export function parseFeed(xml, forum) {
  const out = [];
  for (const it of xmlItems(xml, 'item')) {
    const item = toItem(it, forum);
    if (item) out.push(item);
  }
  return out;
}

export const tsbb = defineAdapter({
  name: 'tsbb',
  title: 'tsbb.dev board',
  collection: 'forums',
  description:
    'Every topic on the tsbb.dev bulletin board, forum by forum: the title, the opening post, the author and the forum it was posted in. The forum list comes from the keyless JSON API and each forum’s topics from its own RSS feed.',
  docs: 'https://tsbb.dev/api/v1',
  kinds: ['post'],
  cadenceMinutes: 30,
  configFields: [
    {
      key: 'forums',
      label: 'Forums',
      type: 'list',
      required: false,
      placeholder: 'announcements, general',
      help: 'Forum slugs to read. Leave empty to read every forum that has topics in it.',
    },
  ],
  defaults: { forums: [] },
  defaultSources: [
    {
      slug: 'tsbb-topics',
      name: 'Forums: tsbb.dev',
      config: { forums: [] },
    },
  ],
  async pull({ config, http, log, deadline }) {
    const only = new Set(
      (Array.isArray(config.forums) ? config.forums : String(config.forums ?? '').split(','))
        .map((s) => String(s).trim().toLowerCase())
        .filter(Boolean),
    );

    const doc = await http.json(`${BASE}/api/v1/forums`, { timeoutMs: 15_000 });
    const forums = readableForums(doc)
      .filter((f) => only.size === 0 || only.has(f.slug))
      .slice(0, MAX_FORUMS);

    const items = [];
    const failed = [];
    for (const forum of forums) {
      if (Date.now() > deadline) break;
      try {
        const xml = await http.text(`${BASE}/f/${encodeURIComponent(forum.slug)}/feed.xml`, {
          headers: { accept: 'application/rss+xml, application/xml, */*' },
          timeoutMs: 15_000,
        });
        items.push(...parseFeed(xml, forum));
      } catch (err) {
        failed.push(`${forum.slug} (${err.message.slice(0, 40)})`);
      }
    }

    if (failed.length) log(`failed: ${failed.join(', ')}`);
    log(`${items.length} topics from ${forums.length - failed.length} forums`);
    return { items, note: `${items.length} topics from ${forums.length - failed.length} forums` };
  },
});
