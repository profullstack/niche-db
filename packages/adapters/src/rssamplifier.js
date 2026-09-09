import { decodeEntities, defineAdapter } from '@nichedb/core/adapter';

/**
 * Newsrooms, from the rssamplifier.com directory.
 *
 * The newsfeed adapter reads a list of feeds somebody chose; this reads a list
 * somebody classified. rssamplifier indexes over half a million feeds and sorts
 * each from its own document on every crawl, ~24,700 of them as `news` --
 * "several articles a day, a staff of bylines, or a masthead that says news, and
 * at least two of those three", drawn conservatively enough that a weekly blog
 * with a masthead stays a blog.
 *
 * That is the thing neither sibling can supply. `newsfeed` knows a desk because
 * we told it; `gdelt` knows a domain. Neither can say whether a feed nobody has
 * curated is a newsroom, so neither can grow past the list we maintain by hand.
 * This one can: a topic asked for here returns whoever the directory currently
 * files under it, which is why one source here is worth more than a hundred more
 * lines in DEFAULT_FEEDS.
 *
 * `/topics/{keyword}/news.json` is a JSON Feed of what those newsrooms
 * published, newest first, so a desk is one request and the desk name is the
 * topic. Keywords are normalised upstream -- `sport` and `sports` reach the same
 * document, so only one of them is worth asking for.
 *
 * Keyless, CORS-open, and documented at https://rssamplifier.com/llms.txt.
 *
 * THREE THINGS IN THE DOCUMENT THAT ARE NOT STORIES
 *
 * - Sponsored entries. The directory inserts one every ten items, at most three
 *   per document, and says outright to filter them if you are indexing. They are
 *   house adverts stamped with the day they were served, so ingesting them puts
 *   an advert at the top of a news feed on every run. Note the count: asking for
 *   200 returns 203, because they ride on top of the limit rather than inside
 *   it.
 * - Future dates. A publisher that files a release date in a `published` field
 *   arrives unclamped -- a games feed on the sport desk was dated six days out.
 * - Character references. Nothing upstream decodes them, so a masthead arrives
 *   as `Al Jazeera &#8211; Breaking News, World News and Video from Al Jazeera`.
 */

const BASE = 'https://rssamplifier.com';

/**
 * The desks asked for, which are also the topics.
 *
 * The first nine are the ones `newsfeed` files under, so a story lands on a desk
 * a reader already browses. The last three exist here and nowhere else in this
 * collection: no newsroom feed we list publishes an entertainment, food or
 * travel desk, and GDELT has no notion of one, but the directory files hundreds
 * of newsrooms under each. Leaving them out was leaving the coverage on the
 * floor.
 *
 * Verified live 2026-09-09, each a well-covered news topic publishing the same
 * day: world, us, politics, business, technology, science, health, sport and
 * climate carry 20 to 57 distinct newsrooms; entertainment 51, food 54 and
 * travel 46.
 *
 * Keywords are normalised upstream, so `sport` and `sports` are one document and
 * asking for both would only fetch it twice.
 */
export const DEFAULT_TOPICS = [
  'world',
  'us',
  'politics',
  'business',
  'technology',
  'science',
  'health',
  'sport',
  'climate',
  'entertainment',
  'food',
  'travel',
];

/** The documented ceiling: fifty by default, 200 the most it will serve. */
const LIMIT = 200;

/**
 * How far ahead of us a publisher's clock may be.
 *
 * Feeds routinely file a few minutes ahead through timezone sloppiness and
 * dropping those would lose real stories. A date days out is not skew; it is a
 * release date in the wrong field.
 */
const SKEW_MS = 15 * 60 * 1000;

/**
 * Decoded, whitespace-collapsed, and null when nothing is left.
 *
 * `decodeEntities` always returns a string because the XML parser needs it to.
 * A title that was only an entity decodes to nothing, and a story with no
 * headline is not a story, so the emptiness has to become null somewhere.
 */
const clean = (s) => {
  const t = decodeEntities(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t || null;
};

/**
 * Is this entry an advert rather than a story?
 *
 * Three markers because the documentation names two and the live payload
 * carried a third. Any one is enough. Getting this wrong fails silently: it
 * publishes a house advert as the day's news.
 */
export function isSponsored(item) {
  if (!item) return false;
  if (item._crawlproof) return true;
  if ((item.tags ?? []).some((t) => String(t).toLowerCase() === 'sponsored')) return true;
  return /^tag:crawlproof\.com/i.test(String(item.id ?? ''));
}

/** Long titles cut back to the publication; short ones left exactly as written. */
const SEPARATORS = /\s+(?:[|–—:]|::|-)\s+/;
const LONG = 40;

/**
 * A feed's title reduced to the name of the publication.
 *
 * Plenty of mastheads are the name followed by a sales pitch, and carried whole
 * that becomes the outlet on every story. Only long titles are cut, and only at
 * a separator the publisher wrote -- the length rule is doing real work, because
 * `News - Tennisuptodate.com` and `Daily Express :: World Feed` both have a
 * separator and a useless left-hand side, and cutting either makes it worse.
 */
export function masthead(title) {
  const full = clean(title);
  if (!full) return null;
  if (full.length <= LONG) return full;
  const [head] = full.split(SEPARATORS);
  const name = head?.trim();
  return name && name.length >= 3 && name.length <= LONG ? name : full.slice(0, 120).trim();
}

/**
 * The directory's own slug for a feed, from its page URL.
 *
 * This is the outlet identity rather than the masthead, because mastheads
 * repeat: the directory holds eight feeds titled "Eco-Business". The slug is
 * unique upstream and stable across crawls.
 */
export function outletOf(item) {
  const meta = item?._rssamplifier ?? {};
  const page = typeof meta.feed_page === 'string' ? meta.feed_page.trim() : '';
  const name = masthead(meta.feed_title);
  if (!name) return null;
  const slug = page.split('/').filter(Boolean).pop() ?? '';
  return { key: slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name, page: page || null };
}

/** One entry, or null if it is an advert, undated, future-dated or nameless. */
export function toItem(entry, section, now = Date.now()) {
  if (isSponsored(entry)) return null;
  const url = typeof entry?.url === 'string' ? entry.url.trim() : '';
  if (!url) return null;

  const title = clean(entry.title);
  if (!title) return null;

  const published = entry.date_published ? new Date(entry.date_published) : null;
  if (!published || Number.isNaN(published.getTime())) return null;
  if (published.getTime() > now + SKEW_MS) return null;

  const outlet = outletOf(entry);
  if (!outlet) return null;

  return {
    /*
     * The section is NOT in the id, for the same reason it is not in
     * newsfeed's: a story reaching two desks is one story, and keying on the
     * section would store it twice. Cross-source duplicates are a separate
     * problem, handled by the collection's dedupe key rather than here.
     */
    externalId: `${outlet.key}:${url}`.slice(0, 500),
    kind: 'story',
    title,
    summary: clean(entry.summary)?.slice(0, 600) ?? null,
    url,
    imageUrl: typeof entry.image === 'string' && entry.image ? entry.image : null,
    publishedAt: published,
    // Matches newsfeed exactly, so anything reading this collection files a
    // story from either source the same way.
    tags: ['news', section, outlet.key].filter(Boolean),
    data: {
      section,
      outlet: outlet.key,
      outletName: outlet.name,
      directory: outlet.page,
    },
  };
}

export const rssamplifier = defineAdapter({
  name: 'rssamplifier',
  title: 'RSS Amplifier newsrooms',
  collection: 'news',
  description:
    'Stories from the newsrooms in the rssamplifier.com directory, which classifies every feed from its own document on each crawl and files ~24,700 of them as news. One request per desk: world, US, politics, business, technology, science, health, sport, climate, entertainment, food and travel. Keyless, and the outlet arrives with its masthead rather than a bare host.',
  docs: 'https://rssamplifier.com/llms.txt',
  kinds: ['story'],
  cadenceMinutes: 30,
  configFields: [
    {
      key: 'topics',
      label: 'Topics',
      type: 'list',
      required: true,
      placeholder: DEFAULT_TOPICS.slice(0, 3).join(', '),
      help: 'One rssamplifier topic per desk. Keywords are normalised upstream, so "sport" and "sports" are the same document.',
    },
  ],
  defaults: { topics: DEFAULT_TOPICS },
  defaultSources: [
    {
      slug: 'news-directory',
      name: 'News: classified newsrooms',
      config: { topics: DEFAULT_TOPICS },
    },
  ],
  async pull({ config, http, log, deadline }) {
    const topics = (
      Array.isArray(config.topics) ? config.topics : String(config.topics ?? '').split(',')
    )
      .map((t) => String(t).trim().toLowerCase())
      .filter((t) => /^[a-z][a-z0-9-]{0,30}$/.test(t))
      .slice(0, 30);

    const items = [];
    const failed = [];
    const now = Date.now();

    for (const topic of topics) {
      if (Date.now() > deadline) break;
      try {
        const doc = await http.json(
          `${BASE}/topics/${encodeURIComponent(topic)}/news.json?limit=${LIMIT}`,
          { timeoutMs: 20_000 },
        );
        for (const entry of doc?.items ?? []) {
          const item = toItem(entry, topic, now);
          if (item) items.push(item);
        }
      } catch (err) {
        // A topic with nothing under it is a 404 here rather than an empty
        // document, and one missing desk is not a reason to lose the rest.
        failed.push(`${topic} (${err.message.slice(0, 40)})`);
      }
    }

    if (failed.length) log(`skipped ${failed.length}: ${failed.join(', ')}`);
    log(`${items.length} stories from ${topics.length - failed.length} desks`);
    return { items };
  },
});
