import { describe, expect, test } from 'bun:test';
import { ADAPTERS, adapterByName } from '../packages/adapters/src/index.js';
import {
  isPlatformHosted,
  PLATFORM_HOSTS,
  platformOf,
} from '../packages/adapters/src/podcastplatforms.js';
import { GROUPS, toItem } from '../packages/adapters/src/podcasts.js';

// The seed reaches the config module, which asserts its env at import rather
// than on first use. Nothing here connects; the value only has to exist.
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';

const { COLLECTIONS, DEFAULT_FEEDS } = await import('../packages/core/src/seed.js');

/** One entry shaped exactly as /api/feeds returns it, verified live 2026-09-09. */
const feed = (over = {}) => ({
  slug: 'checked-into-history',
  title: 'Checked Into History',
  description: 'August and Liv revisit true moments.',
  siteUrl: 'https://www.celebrity-hotels.com/podcast',
  feedUrl: 'https://www.celebrity-hotels.com/podcast/feed.xml',
  language: 'en',
  kind: 'podcast',
  itemCount: 1,
  status: 'active',
  lastSuccessAt: '2026-09-08T11:10:11.525Z',
  freshness: 'live',
  lastPublishedAt: '2026-08-28T17:35:00.000Z',
  page: 'https://rssamplifier.com/checked-into-history',
  ...over,
});

describe('registration', () => {
  test('the adapter is wired to the podcasts collection with both sources', () => {
    const a = adapterByName('podcasts');
    expect(a).toBeTruthy();
    expect(a.collection).toBe('podcasts');
    expect(a.kinds).toContain('show');
    expect(a.defaultSources.map((s) => s.config.group).sort()).toEqual([
      'commercial',
      'self-hosted',
    ]);
  });

  /*
   * Fifteen minutes is a decision, not a default. It matches the upstream
   * directory's own floor for a feed that just published, so a fresh episode is
   * not sat on for an hour after the directory already had it, and it finishes
   * the catalogue walk in a quarter of the time. A run costs `backfillPages`
   * requests rather than one per feed, which is what makes it affordable.
   */
  test('polls every fifteen minutes', () => {
    expect(adapterByName('podcasts').cadenceMinutes).toBe(15);
  });

  test('the collection exists and its feeds only reference sources that do', () => {
    expect(COLLECTIONS.some((c) => c.slug === 'podcasts')).toBe(true);
    const declared = new Set(ADAPTERS.flatMap((a) => (a.defaultSources ?? []).map((s) => s.slug)));
    const wanted = DEFAULT_FEEDS.filter((f) => f.collection === 'podcasts').flatMap(
      (f) => f.query.sources ?? [],
    );
    expect(wanted.length).toBeGreaterThan(0);
    for (const s of wanted) expect(declared.has(s)).toBe(true);
  });

  test('no adapter name or source slug is claimed twice', () => {
    const names = ADAPTERS.map((a) => a.name);
    expect(new Set(names).size).toBe(names.length);
    const slugs = ADAPTERS.flatMap((a) => (a.defaultSources ?? []).map((s) => s.slug));
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});

/**
 * The public suffixes are the trap. The Podcast Index dump the platform list was
 * measured from files some feeds under a bare `co.uk` or `com.br`, and every one
 * of those cleared the 25-feed threshold. Had they survived into the set, the
 * suffix match would file every .co.uk podcast in Britain as commercially
 * hosted and empty the half this collection exists for.
 */
describe('platform classification', () => {
  test('no bare public suffix is in the set', () => {
    for (const bad of ['co.uk', 'com.br', 'org.au', 'com.au', 'org.uk', 'co.nz', 'co.za']) {
      expect(PLATFORM_HOSTS.has(bad)).toBe(false);
    }
    expect(isPlatformHosted('https://someshow.co.uk/feed.xml')).toBe(false);
  });

  test('a platform is matched through its subdomains, and only its own', () => {
    expect(isPlatformHosted('https://feeds.buzzsprout.com/2.rss')).toBe(true);
    expect(isPlatformHosted('https://anchor.fm/s/1/podcast/rss')).toBe(true);
    expect(isPlatformHosted('https://www.buzzsprout.com/2.rss')).toBe(true);
    expect(isPlatformHosted('https://notbuzzsprout.com/f.xml')).toBe(false);
    expect(isPlatformHosted('https://buzzsprout.com.evil.example/f.xml')).toBe(false);
  });

  test('the platform is the registrable domain, never the bucket subdomain', () => {
    expect(platformOf('https://some-show.s3.us-east-1.amazonaws.com/rss.xml')).toBe(
      'amazonaws.com',
    );
    expect(platformOf('https://feeds.buzzsprout.com/2.rss')).toBe('buzzsprout.com');
    expect(platformOf('https://blog.example.org/podcast.rss')).toBeNull();
  });

  test('an unparseable url is nobody’s platform', () => {
    expect(isPlatformHosted('garbage')).toBe(false);
    expect(isPlatformHosted('')).toBe(false);
    expect(isPlatformHosted(null)).toBe(false);
  });
});

/**
 * The two sources read the same document and must partition it. A feed counted
 * by both is a show a reader sees twice; a feed counted by neither is a show
 * that silently never arrives, which is the failure nothing would report.
 */
describe('the two groups partition the catalogue', () => {
  const cases = [
    feed(),
    feed({ slug: 'a', feedUrl: 'https://anchor.fm/s/1/podcast/rss' }),
    feed({ slug: 'b', feedUrl: 'https://feeds.megaphone.fm/x' }),
    feed({ slug: 'c', feedUrl: 'https://someshow.co.uk/feed.xml' }),
    feed({ slug: 'd', feedUrl: 'https://blog.example.org/podcast.rss' }),
  ];

  test('every feed lands in exactly one group', () => {
    for (const f of cases) {
      const hits = ['commercial', 'self-hosted'].filter((g) => toItem(f, g) !== null);
      expect(hits.length).toBe(1);
    }
  });

  test('a platform feed is commercial and an own-domain feed is self-hosted', () => {
    expect(toItem(cases[1], 'commercial')?.data.group).toBe('commercial');
    expect(toItem(cases[1], 'self-hosted')).toBeNull();
    expect(toItem(cases[0], 'self-hosted')?.data.group).toBe('self-hosted');
    expect(toItem(cases[0], 'commercial')).toBeNull();
  });
});

describe('one feed as an item', () => {
  test('carries the show’s own site, and the feed url to subscribe with', () => {
    const item = toItem(feed(), 'self-hosted');
    expect(item.externalId).toBe('checked-into-history');
    expect(item.kind).toBe('show');
    expect(item.url).toBe('https://www.celebrity-hotels.com/podcast');
    expect(item.data.feedUrl).toBe('https://www.celebrity-hotels.com/podcast/feed.xml');
    expect(item.data.directory).toBe('https://rssamplifier.com/checked-into-history');
    expect(item.data.host).toBe('celebrity-hotels.com');
    expect(item.publishedAt.toISOString()).toBe('2026-08-28T17:35:00.000Z');
  });

  test('falls back to the directory page when the show has no site', () => {
    const item = toItem(feed({ siteUrl: null }), 'self-hosted');
    expect(item.url).toBe('https://rssamplifier.com/checked-into-history');
  });

  /*
   * lastSuccessAt is when we read the feed, not when the show published. It is
   * the fallback and never the first choice, or a decade-dormant show would date
   * itself to this morning and sit at the top of the collection.
   */
  test('dates from the newest episode, falling back to the last crawl', () => {
    const undated = toItem(feed({ lastPublishedAt: null }), 'self-hosted');
    expect(undated.publishedAt.toISOString()).toBe('2026-09-08T11:10:11.525Z');
    const neither = toItem(feed({ lastPublishedAt: null, lastSuccessAt: null }), 'self-hosted');
    expect(neither.publishedAt).toBeNull();
  });

  /*
   * On the self-hosted side the host is nearly a primary key -- 13,400 domains
   * for 21,000 shows -- so tagging it would be tens of thousands of tags that
   * each match one row. It is a tag only where it is one of 307 values.
   */
  test('tags the platform on the commercial side and nothing on the other', () => {
    const bucket = feed({
      feedUrl: 'https://some-show.s3.us-east-1.amazonaws.com/rss.xml',
    });
    const item = toItem(bucket, 'commercial');
    expect(item.tags).toContain('amazonaws.com');
    expect(item.tags).not.toContain('some-show.s3.us-east-1.amazonaws.com');
    expect(item.data.host).toBe('some-show.s3.us-east-1.amazonaws.com');
    expect(item.data.platform).toBe('amazonaws.com');

    const own = toItem(feed(), 'self-hosted');
    expect(own.tags).not.toContain('celebrity-hotels.com');
    expect(own.data.host).toBe('celebrity-hotels.com');
    expect(own.data.platform).toBeNull();
  });

  test('tags the base language, not the regional variant', () => {
    expect(toItem(feed({ language: 'en-US' }), 'self-hosted').tags).toContain('lang:en');
    expect(toItem(feed({ language: 'en-us' }), 'self-hosted').tags).toContain('lang:en');
    expect(
      toItem(feed({ language: '' }), 'self-hosted').tags.some((t) => t.startsWith('lang:')),
    ).toBe(false);
  });

  test('drops a feed with no url, no slug or no title', () => {
    expect(toItem(feed({ feedUrl: '' }), 'self-hosted')).toBeNull();
    expect(toItem(feed({ slug: '' }), 'self-hosted')).toBeNull();
    expect(toItem(feed({ title: '  ' }), 'self-hosted')).toBeNull();
    expect(toItem(null, 'self-hosted')).toBeNull();
  });
});

const page = (slugs) => ({
  feeds: slugs.map((s) => feed({ slug: s, feedUrl: `https://${s}.example.org/rss` })),
});

/**
 * A fake upstream that pages by offset.
 *
 * Offsets are resolved against the running total rather than divided by the
 * page size, because a short page means later requests ask for an offset that
 * is not a multiple of 200 -- which is exactly what the backfill does.
 */
const ctx = (pages, over = {}) => {
  const flat = pages.flatMap((p) => p.feeds);
  const seen = [];
  return {
    seen,
    ctx: {
      config: { group: 'self-hosted', maxPages: 5 },
      cursor: { backfillDone: true },
      log: () => {},
      deadline: Date.now() + 60_000,
      http: {
        json: async (url) => {
          seen.push(url);
          const params = new URL(url).searchParams;
          const offset = Number(params.get('offset'));
          const limit = Number(params.get('limit'));
          return { feeds: flat.slice(offset, offset + limit) };
        },
      },
      ...over,
    },
  };
};

describe('pull', () => {
  test('stops at an empty page and records the newest slug as the marker', async () => {
    const { ctx: c } = ctx([page(['a', 'b'])]);
    const out = await adapterByName('podcasts').pull(c);
    expect(out.items.map((i) => i.externalId)).toEqual(['a', 'b']);
    expect(out.cursor).toEqual({ newest: 'a', backfillDone: true });
  });

  /*
   * Offset paging over a table that grows underneath the run pushes rows past a
   * page boundary, so stopping the instant the marker appears steps over
   * whatever moved. One page of overlap is what closes that.
   */
  test('reads one page past the marker rather than stopping on it', async () => {
    const full = (prefix) => page(Array.from({ length: 200 }, (_, i) => `${prefix}${i}`));
    const pages = [full('p0-'), full('p1-'), full('p2-'), full('p3-')];
    pages[1].feeds[10].slug = 'marker';
    const { ctx: c, seen } = ctx(pages, { cursor: { newest: 'marker', backfillDone: true } });
    await adapterByName('podcasts').pull(c);
    expect(seen.length).toBe(3);
    expect(seen[2]).toContain('offset=400');
  });

  test('never asks for more pages than it is configured for', async () => {
    const full = (p) => page(Array.from({ length: 200 }, (_, i) => `${p}-${i}`));
    const pages = [full('a'), full('b'), full('c'), full('d'), full('e'), full('f')];
    const { ctx: c, seen } = ctx(pages, { config: { group: 'self-hosted', maxPages: 2 } });
    await adapterByName('podcasts').pull(c);
    expect(seen.length).toBe(2);
  });

  /*
   * A run that never reached its marker has a gap in it. Keeping the old marker
   * would make every later run re-read the same pages and rediscover the same
   * gap forever, so the marker advances and the run says why.
   */
  test('advances the marker even when the old one was never reached', async () => {
    const full = (p) => page(Array.from({ length: 200 }, (_, i) => `${p}-${i}`));
    const lines = [];
    const { ctx: c } = ctx([full('a'), full('b')], {
      config: { group: 'self-hosted', maxPages: 1 },
      cursor: { newest: 'nowhere', backfillDone: true },
      log: (m) => lines.push(m),
    });
    const out = await adapterByName('podcasts').pull(c);
    expect(out.cursor).toEqual({ newest: 'a-0', backfillDone: true });
    expect(lines.some((l) => l.includes('raise maxPages'))).toBe(true);
  });

  test('returns nothing rather than throwing when the deadline has passed', async () => {
    const { ctx: c, seen } = ctx([page(['a'])], { deadline: Date.now() - 1 });
    const out = await adapterByName('podcasts').pull(c);
    expect(out.items).toEqual([]);
    expect(seen.length).toBe(0);
  });

  test('both groups are described on the sources page', () => {
    expect(GROUPS.commercial.slug).toBe('podcasts-commercial');
    expect(GROUPS['self-hosted'].slug).toBe('podcasts-self-hosted');
  });
});

/**
 * The bug this exists to prevent.
 *
 * `incremental` reads down from the head until it meets its marker, which is
 * right for keeping up and useless for starting: the newest pages of this
 * directory are about 99% self-hosted, so a commercial source that only ever
 * read the head found 12 shows in 2,000 feeds and nothing would have fixed it.
 * A new source has to walk the whole listing before it can keep up with it.
 */
describe('backfill', () => {
  const mixed = (n, start = 0) => ({
    feeds: Array.from({ length: n }, (_, i) => {
      const k = start + i;
      // One in fifty is on a platform, which is roughly the real head-of-list
      // ratio and the thing that made head-only reading useless.
      return feed({
        slug: `s${k}`,
        feedUrl: k % 50 === 0 ? 'https://anchor.fm/s/x/podcast/rss' : `https://own${k}.example/rss`,
      });
    }),
  });

  test('a source with no cursor walks instead of reading only the head', async () => {
    const { ctx: c, seen } = ctx([mixed(200), mixed(200, 200), mixed(50, 400)], {
      cursor: {},
      config: { group: 'commercial', backfillPages: 10 },
    });
    const out = await adapterByName('podcasts').pull(c);
    // 450 feeds walked, one in fifty commercial: 9 shows a head-only read of the
    // first page would have found one of.
    expect(out.items.length).toBe(9);
    expect(seen.length).toBe(3);
    expect(out.cursor.backfillDone).toBe(true);
  });

  test('resumes from the stored offset rather than starting over', async () => {
    const { ctx: c, seen } = ctx([mixed(200), mixed(200, 200), mixed(200, 400)], {
      cursor: { backfillOffset: 400, backfillHead: 's0' },
      config: { group: 'self-hosted', backfillPages: 1 },
    });
    const out = await adapterByName('podcasts').pull(c);
    expect(seen[0]).toContain('offset=400');
    expect(out.cursor).toEqual({ backfillOffset: 600, backfillHead: 's0' });
  });

  test('stops after its configured pages and keeps walking next run', async () => {
    const pages = [mixed(200), mixed(200, 200), mixed(200, 400), mixed(200, 600)];
    const { ctx: c, seen } = ctx(pages, {
      cursor: {},
      config: { group: 'self-hosted', backfillPages: 2 },
    });
    const out = await adapterByName('podcasts').pull(c);
    expect(seen.length).toBe(2);
    expect(out.cursor.backfillOffset).toBe(400);
    expect(out.cursor.backfillDone).toBeUndefined();
  });

  /*
   * The head is captured when the walk starts and held until it ends, so
   * anything added to the directory during the walk sits above the handover
   * marker and is picked up by the first incremental run. Promoting the head as
   * it looks at the END of the walk would skip every one of them.
   */
  test('hands over the head as it was when the walk began', async () => {
    const first = ctx([mixed(200), mixed(200, 200)], {
      cursor: {},
      config: { group: 'self-hosted', backfillPages: 1 },
    });
    const mid = await adapterByName('podcasts').pull(first.ctx);
    expect(mid.cursor.backfillHead).toBe('s0');

    const last = ctx([mixed(200), mixed(50, 200)], {
      cursor: mid.cursor,
      config: { group: 'self-hosted', backfillPages: 5 },
    });
    const out = await adapterByName('podcasts').pull(last.ctx);
    expect(out.cursor).toEqual({ newest: 's0', backfillDone: true });
  });

  test('a finished walk never runs again', async () => {
    const { ctx: c, seen } = ctx([mixed(10)], {
      cursor: { newest: 's0', backfillDone: true },
      config: { group: 'self-hosted', maxPages: 1 },
    });
    const out = await adapterByName('podcasts').pull(c);
    expect(seen[0]).toContain('offset=0');
    expect(out.cursor.backfillDone).toBe(true);
    expect(out.cursor.backfillOffset).toBeUndefined();
  });

  /*
   * backfillPages 0 means "only take new arrivals". It must not leave a
   * `backfillDone` behind, or turning the setting back on later would silently
   * do nothing: only a walk that happened may claim to have happened.
   */
  test('skipping the walk does not mark it done', async () => {
    const { ctx: c } = ctx([mixed(10)], {
      cursor: {},
      config: { group: 'self-hosted', backfillPages: 0, maxPages: 1 },
    });
    const out = await adapterByName('podcasts').pull(c);
    expect(out.cursor.backfillDone).toBeUndefined();
  });

  test('stops walking when it runs out of time', async () => {
    const { ctx: c, seen } = ctx([mixed(200), mixed(200, 200)], {
      cursor: {},
      config: { group: 'self-hosted', backfillPages: 50 },
      deadline: Date.now() - 1,
    });
    const out = await adapterByName('podcasts').pull(c);
    expect(seen.length).toBe(0);
    expect(out.items).toEqual([]);
    expect(out.cursor.backfillOffset).toBe(0);
  });
});
