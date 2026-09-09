import { decodeEntities, defineAdapter } from '@nichedb/core/adapter';

import { platformOf } from './podcastplatforms.js';

/**
 * Podcasts, split by who serves the feed.
 *
 * Every podcast directory in the world is a search box over one undifferentiated
 * pile. Apple has 2.5 million shows and one ranking; Spotify has the same shows
 * and a different ranking. Neither will tell you the thing that actually sorts
 * the medium in two, because both are in the business of the half that pays:
 * whether a show is published by an operation with a hosting bill, or by a
 * person on their own domain.
 *
 * So this collection has exactly two sources and they are that split. Same
 * upstream, same request, partitioned on the feed's host by
 * `isPlatformHosted` -- see podcastplatforms.js for how the 307 platform
 * domains were measured and what the measurement gets wrong. The two are
 * disjoint by construction: every feed lands in one group or the other, never
 * both and never neither.
 *
 * WHY RSSAMPLIFIER AND NOT THE PODCAST INDEX
 *
 * The Podcast Index is the census -- 4.7 million feeds -- and it is the wrong
 * shape for this. Its API needs a key, and its keyless surface is a 1.7 GB
 * gzipped SQLite dump published on its own schedule. Neither is something a
 * source can poll hourly.
 *
 * rssamplifier is a live crawl of a large slice of the same catalogue, keyless,
 * CORS-open, and it publishes new podcasts as they are discovered. It also does
 * the one piece of work that would otherwise fall to us: a feed is filed as a
 * podcast because its own document carries audio enclosures or the itunes and
 * podcast namespaces, checked on every crawl, rather than because a submitter
 * said so. That is a fact about the feed. What we add is the half nobody else
 * publishes.
 *
 * THREE THINGS ABOUT THE UPSTREAM
 *
 * - `/api/feeds` is ordered newest-added first, and pages by offset over a table
 *   that grows underneath you. A show discovered mid-run shifts every later row
 *   down one, so a strict "stop at the slug I saw last time" would step over
 *   entries. `OVERLAP_PAGES` is why: after the marker is found we read one more
 *   page rather than stopping on it.
 * - A source has to walk the catalogue before it can keep up with it. Reading
 *   down from the head until last run's marker is right for keeping up and
 *   useless for starting, because the newest pages are not a sample of the
 *   whole. Measured 2026-09-09 across ten evenly spaced depths of the 274,518
 *   podcast feeds: the first page is 2/200 commercial and every other depth
 *   sampled runs 178-194 out of 200, for 84% overall. The head is inverted
 *   against the catalogue behind it, so a commercial source that only ever read
 *   the head found 12 shows in 2,000 feeds and would have stayed that way while
 *   ~230,000 sat three pages further down. `backfill` walks forward by offset to
 *   the end of the listing first; `incremental` takes over once it is done.
 * - A feed is only classified once it has been crawled, so a freshly submitted
 *   podcast is not in `kind=podcast` yet. This is a feature here. A bulk import
 *   arrives as a trickle the poller can keep up with, rather than a hundred
 *   thousand rows in one run.
 * - `lastPublishedAt` is the show's newest episode and is frequently years old:
 *   podfade is the dominant story in this medium, and about two thirds of every
 *   podcast catalogue has not published in three years. It is still the right
 *   date for the item, because "when did this show last speak" is the question a
 *   reader of a podcast directory is asking.
 */

const BASE = 'https://rssamplifier.com';

/** The documented ceiling on /api/feeds. */
const PAGE = 200;

/**
 * How far past the marker to keep reading.
 *
 * Offset paging over a growing table loses rows: anything added while the run
 * is in flight pushes the marker further from offset 0 than it was, and a run
 * that stops the instant it sees the marker never reads what got pushed past
 * the page boundary. One extra page is cheap and closes it, because the run
 * before this one is at most an hour old.
 */
const OVERLAP_PAGES = 1;

/** The two halves, and what each is called on the sources page. */
export const GROUPS = {
  commercial: {
    slug: 'podcasts-commercial',
    name: 'Podcasts: commercially hosted',
    description:
      'Shows served by a podcast host, a network or a broadcaster -- anchor.fm, Buzzsprout, Spreaker, Libsyn, Acast, Megaphone and 300 more domains that each carry 25 or more live feeds. This is where 93.8% of the medium lives.',
  },
  'self-hosted': {
    slug: 'podcasts-self-hosted',
    name: 'Podcasts: self-hosted',
    description:
      'Shows served from the publisher’s own domain rather than a hosting platform. The independent 6% of the medium, spread across roughly 13,400 domains, and the half that no podcast app surfaces because there is nobody selling it.',
  },
};

/** Decoded, whitespace-collapsed, and null when nothing is left. */
const clean = (s) => {
  const t = decodeEntities(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t || null;
};

/**
 * One directory feed as an item, or null if it is not this source's half.
 *
 * The url is the show's own site where it has one and the directory page where
 * it does not, because a reader following a podcast wants the show, not our
 * copy of it. Both addresses and the feed itself are in `data` regardless, so
 * anything reading this collection can subscribe without a second request.
 *
 * @param {object} feed one entry from /api/feeds
 * @param {'commercial'|'self-hosted'} group
 */
export function toItem(feed, group) {
  const feedUrl = typeof feed?.feedUrl === 'string' ? feed.feedUrl.trim() : '';
  const slug = typeof feed?.slug === 'string' ? feed.slug.trim() : '';
  if (!feedUrl || !slug) return null;

  const title = clean(feed.title);
  if (!title) return null;

  const platform = platformOf(feedUrl);
  if ((platform !== null) !== (group === 'commercial')) return null;

  // A show with no episode date is a show we cannot place in time. `lastSuccessAt`
  // is when we last read it, which is a fact about the crawler rather than about
  // the show, so it is only the fallback.
  const published = feed.lastPublishedAt ?? feed.lastSuccessAt ?? null;
  const date = published ? new Date(published) : null;

  let host = null;
  try {
    host = new URL(feedUrl).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    host = null;
  }

  const site = typeof feed.siteUrl === 'string' && feed.siteUrl ? feed.siteUrl : null;
  const page = typeof feed.page === 'string' && feed.page ? feed.page : `${BASE}/${slug}`;

  return {
    externalId: slug.slice(0, 500),
    kind: 'show',
    title,
    summary: clean(feed.description)?.slice(0, 600) ?? null,
    url: site ?? page,
    imageUrl: null,
    publishedAt: date && !Number.isNaN(date.getTime()) ? date : null,
    /*
     * The language is a tag as well as a field, so "German self-hosted
     * podcasts" is a feed query rather than a code change.
     *
     * The tag on the commercial side is the platform, not the hostname. The
     * platform is one of 307 values and answers a real question -- everything
     * on anchor.fm, everything Libsyn serves. The hostname is very nearly a
     * primary key: a show on S3 answers at its own bucket subdomain, and
     * self-hosted is 13,400 domains for 21,000 shows, so tagging hostnames
     * would add tens of thousands of tags that each match one row. The exact
     * host is in `data.host` on both sides regardless.
     */
    tags: ['podcast', group, platform, langTag(feed.language)].filter(Boolean),
    data: {
      group,
      host,
      platform,
      feedUrl,
      siteUrl: site,
      directory: page,
      language: feed.language ?? null,
      episodeCount: Number.isFinite(feed.itemCount) ? feed.itemCount : null,
      freshness: feed.freshness ?? null,
      lastPublishedAt: feed.lastPublishedAt ?? null,
    },
  };
}

/**
 * A language tag reduced to its base.
 *
 * The directory carries what the publisher wrote, which is `en`, `en-us` and
 * `en-US` for the same language. Tagging all three separately makes the tag
 * useless for following one, so only the base is tagged.
 */
function langTag(language) {
  const base = String(language ?? '')
    .toLowerCase()
    .split('-')[0]
    .trim();
  return /^[a-z]{2,3}$/.test(base) ? `lang:${base}` : null;
}

export const podcasts = defineAdapter({
  name: 'podcasts',
  title: 'Podcasts',
  collection: 'podcasts',
  description:
    'Podcast shows from the rssamplifier.com directory, which files a feed as a podcast from its own document on every crawl. Configured as one of two halves: shows on a commercial hosting platform, or shows served from the publisher’s own domain. Keyless.',
  docs: 'https://rssamplifier.com/llms.txt',
  kinds: ['show'],
  cadenceMinutes: 60,
  configFields: [
    {
      key: 'group',
      label: 'Group',
      type: 'select',
      required: true,
      options: ['commercial', 'self-hosted'],
      help: 'Which half of the split this source carries. Decided per feed from its host, so the two never overlap.',
    },
    {
      key: 'maxPages',
      label: 'Pages per run',
      type: 'number',
      help: `Pages of ${PAGE} feeds to read before giving up on reaching last run's marker. Only applies once the backfill is done.`,
    },
    {
      key: 'backfillPages',
      label: 'Backfill pages per run',
      type: 'number',
      help: `Pages of ${PAGE} feeds to walk per run while working through the catalogue that existed before this source did. Set to 0 to skip the backfill and only take new arrivals.`,
    },
  ],
  defaults: { group: 'self-hosted', maxPages: 10, backfillPages: 100 },
  defaultSources: [
    {
      slug: GROUPS.commercial.slug,
      name: GROUPS.commercial.name,
      description: GROUPS.commercial.description,
      config: { group: 'commercial', maxPages: 10, backfillPages: 100 },
    },
    {
      slug: GROUPS['self-hosted'].slug,
      name: GROUPS['self-hosted'].name,
      description: GROUPS['self-hosted'].description,
      config: { group: 'self-hosted', maxPages: 10, backfillPages: 100 },
    },
  ],
  async pull(ctx) {
    const done = ctx.cursor?.backfillDone === true;
    const wanted = Number(ctx.config?.backfillPages ?? 100);
    return done || wanted <= 0 ? incremental(ctx) : backfill(ctx);
  },
});

/**
 * Walk the whole catalogue once, oldest end included.
 *
 * `incremental` reads down from the head until it meets its marker, which is
 * the right shape for keeping up and no shape at all for starting. A source
 * created today against a directory holding 274,518 podcasts sees only the
 * newest page or two of them, and the head of this listing is inverted against
 * everything behind it: 2 of the first 200 feeds are commercially hosted, and
 * 84% of the catalogue is. So the commercial source read 2,000 feeds, found 12
 * shows, and would have stayed that way forever while ~230,000 sat just below
 * the window it was looking through. Nothing errored and nothing would ever
 * have fixed itself.
 *
 * So a new source walks forward by offset until the pages run out, a slice per
 * run, and only then starts keeping up.
 *
 * DRIFT GOES THE SAFE WAY
 *
 * The listing is newest-first and the table grows while the walk is in
 * progress, so a row at offset N moves to N+k as k feeds are added above it. A
 * walker moving forward therefore re-reads rows it has already seen rather than
 * stepping over rows it has not. Re-reading is free -- items are keyed on the
 * directory slug, so a second sighting updates a row instead of adding one --
 * and skipping would be silent. Being pushed down is the error worth having.
 *
 * The head is captured on the first run and held until the walk finishes, at
 * which point it becomes the incremental marker. Anything added during the walk
 * sits above that marker and is picked up by the first incremental run, so the
 * handover has no gap in it either.
 */
async function backfill({ config, cursor, http, log, deadline }) {
  const group = config.group === 'commercial' ? 'commercial' : 'self-hosted';
  const pages = Math.max(1, Math.min(Number(config.backfillPages) || 100, 500));
  const startOffset = Number.isInteger(cursor?.backfillOffset) ? cursor.backfillOffset : 0;
  // Held across every run of the walk, so the handover marker is the head as it
  // was when the walk began rather than as it is when the walk ends.
  let head = typeof cursor?.backfillHead === 'string' ? cursor.backfillHead : null;

  const items = [];
  let offset = startOffset;
  let scanned = 0;
  let exhausted = false;

  for (let page = 0; page < pages; page += 1) {
    if (Date.now() > deadline) {
      log(`out of time at offset ${offset}`);
      break;
    }

    const doc = await http.json(`${BASE}/api/feeds?kind=podcast&limit=${PAGE}&offset=${offset}`, {
      timeoutMs: 30_000,
    });
    const feeds = Array.isArray(doc?.feeds) ? doc.feeds : [];
    if (offset === 0) head ??= feeds[0]?.slug ?? null;

    for (const feed of feeds) {
      scanned += 1;
      const item = toItem(feed, group);
      if (item) items.push(item);
    }

    offset += feeds.length;

    // A short page is the end of the listing. An empty one is too, and both
    // have to end the walk: paging past the end forever would mean the source
    // never starts keeping up.
    if (feeds.length < PAGE) {
      exhausted = true;
      break;
    }
  }

  if (exhausted) {
    log(`backfill complete at ${offset} feeds; ${items.length} ${group} shows this run`);
    return { items, cursor: head ? { newest: head, backfillDone: true } : { backfillDone: true } };
  }

  log(`backfill ${startOffset}-${offset}: ${items.length} ${group} shows from ${scanned} scanned`);
  return { items, cursor: { backfillOffset: offset, backfillHead: head } };
}

/** Read down from the head until last run's marker, then stop. */
async function incremental({ config, cursor, http, log, deadline }) {
  const group = config.group === 'commercial' ? 'commercial' : 'self-hosted';
  const maxPages = Math.max(1, Math.min(Number(config.maxPages) || 10, 100));
  const marker = typeof cursor?.newest === 'string' ? cursor.newest : null;

  const items = [];
  let newest = null;
  let scanned = 0;
  let pagesAfterMarker = 0;
  let reachedMarker = false;

  for (let page = 0; page < maxPages; page += 1) {
    if (Date.now() > deadline) {
      log(`out of time after ${page} pages`);
      break;
    }

    const url = `${BASE}/api/feeds?kind=podcast&limit=${PAGE}&offset=${page * PAGE}`;
    const doc = await http.json(url, { timeoutMs: 30_000 });
    const feeds = Array.isArray(doc?.feeds) ? doc.feeds : [];
    if (feeds.length === 0) break;

    newest ??= feeds[0]?.slug ?? null;

    for (const feed of feeds) {
      scanned += 1;
      if (marker && feed?.slug === marker) reachedMarker = true;
      const item = toItem(feed, group);
      if (item) items.push(item);
    }

    // Everything before the marker is new; everything after it we have already
    // seen, bar the rows offset paging pushed past a boundary. One more page
    // covers those, then stop.
    if (reachedMarker) {
      pagesAfterMarker += 1;
      if (pagesAfterMarker > OVERLAP_PAGES) break;
    }

    if (feeds.length < PAGE) break;
  }

  // A run that never found the marker read maxPages and stopped short of it,
  // so it has a gap. Keeping the old marker would make the next run re-read
  // the same pages and find the same gap forever; advancing it accepts the
  // gap once and moves on. Say so, because it is the one thing that silently
  // loses shows, and the fix is to raise maxPages.
  if (marker && !reachedMarker) {
    log(`marker ${marker} not reached in ${maxPages} pages -- raise maxPages`);
  }

  log(`${items.length} ${group} shows from ${scanned} feeds scanned`);
  /*
   * `backfillDone` is carried through, never set here. Stamping it in this
   * function would mark a source as walked that this function has never walked
   * -- a source configured `backfillPages: 0` reaches incremental without one
   * having happened, and turning the setting back on afterwards would then
   * silently do nothing. Only a completed walk may claim to be a completed
   * walk. Carrying it is still required: dropping it would send the next run
   * back into the backfill it already finished.
   */
  const next = newest ? { newest } : { ...(cursor ?? {}) };
  if (cursor?.backfillDone === true) next.backfillDone = true;
  return { items, cursor: next };
}
