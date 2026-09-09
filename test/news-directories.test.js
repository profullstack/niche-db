import { describe, expect, test } from 'bun:test';
import * as brisk from '../packages/adapters/src/brisk.js';
import { ADAPTERS, adapterByName } from '../packages/adapters/src/index.js';
import * as rsa from '../packages/adapters/src/rssamplifier.js';
import { decodeEntities } from '../packages/core/src/adapter.js';

const NOW = Date.parse('2026-09-09T08:00:00.000Z');

describe('both directories are registered against the news collection', () => {
  for (const name of ['rssamplifier', 'brisk']) {
    test(`${name} is a news adapter with a default source`, () => {
      const a = adapterByName(name);
      expect(a).toBeTruthy();
      expect(a.collection).toBe('news');
      expect(a.kinds).toContain('story');
      expect(a.defaultSources.length).toBeGreaterThan(0);
      expect(typeof a.pull).toBe('function');
    });
  }

  test('no two adapters claim the same name or source slug', () => {
    const names = ADAPTERS.map((a) => a.name);
    expect(new Set(names).size).toBe(names.length);
    const slugs = ADAPTERS.flatMap((a) => (a.defaultSources ?? []).map((s) => s.slug));
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});

/**
 * The directory inserts one advert every ten items, at most three per document,
 * and its own documentation says to filter them. They are stamped with the day
 * they were served, so ingesting one puts a house advert at the top of a news
 * feed on every single run -- and nothing about that failure is loud.
 */
describe('rssamplifier: sponsored entries', () => {
  const ad = {
    id: 'tag:crawlproof.com,2026:ad/2768fe0d/d/2026-09-09',
    title: 'Fifty tech CEOs, scored on openness (Sponsored)',
    url: 'https://crawlproof.com/a/rNcltabywEbM',
    date_published: '2026-09-09T00:00:00.000Z',
    _rssamplifier: { feed_title: 'CrawlProof', feed_page: 'https://rssamplifier.com/crawlproof' },
  };

  test('are caught by any of the three markers the payload uses', () => {
    expect(rsa.isSponsored(ad)).toBe(true);
    expect(rsa.isSponsored({ ...ad, id: 'https://x.com/a', _crawlproof: {} })).toBe(true);
    expect(rsa.isSponsored({ ...ad, id: 'https://x.com/a', tags: ['Sponsored'] })).toBe(true);
  });

  test('a real story is not mistaken for one', () => {
    expect(rsa.isSponsored(item())).toBe(false);
    expect(rsa.isSponsored({ ...item(), tags: ['climate', 'asia'] })).toBe(false);
    expect(rsa.isSponsored(null)).toBe(false);
  });

  test('never become items', () => {
    expect(rsa.toItem(ad, 'world', NOW)).toBeNull();
  });
});

const item = (over = {}) => ({
  id: 'https://www.eco-business.com/news/malaysia-power/',
  title: 'Data centres are pushing Malaysia’s power demand higher',
  url: 'https://www.eco-business.com/news/malaysia-power/',
  summary: 'The energy regulator said data centres account for 9.28 per cent.',
  image: 'https://www.eco-business.com/img/hero.jpg',
  date_published: '2026-09-09T05:09:00.000Z',
  _rssamplifier: {
    feed_title: 'Eco-Business',
    feed_page: 'https://rssamplifier.com/eco-business-com-8',
  },
  ...over,
});

describe('rssamplifier: stories', () => {
  test('a story carries the desk, the outlet and the masthead', () => {
    const it = rsa.toItem(item(), 'climate', NOW);
    expect(it.kind).toBe('story');
    expect(it.data.section).toBe('climate');
    expect(it.data.outlet).toBe('eco-business-com-8');
    expect(it.data.outletName).toBe('Eco-Business');
    // The same tag shape newsfeed writes, so a reader of this collection files
    // a story from either source identically.
    expect(it.tags).toEqual(['news', 'climate', 'eco-business-com-8']);
  });

  /*
   * A publisher filing a release date in a published field arrives unclamped:
   * a games feed on the sport desk was dated six days out.
   */
  test('a story dated days ahead is dropped, ordinary skew is not', () => {
    const ahead = item({ date_published: new Date(NOW + 6 * 86_400_000).toISOString() });
    expect(rsa.toItem(ahead, 'sport', NOW)).toBeNull();
    const skewed = item({ date_published: new Date(NOW + 5 * 60_000).toISOString() });
    expect(rsa.toItem(skewed, 'sport', NOW)).toBeTruthy();
  });

  test('an undated or nameless entry is skipped rather than guessed at', () => {
    expect(rsa.toItem(item({ date_published: null }), 'world', NOW)).toBeNull();
    expect(rsa.toItem(item({ date_published: 'whenever' }), 'world', NOW)).toBeNull();
    expect(rsa.toItem(item({ title: '&nbsp;' }), 'world', NOW)).toBeNull();
    expect(rsa.toItem(item({ _rssamplifier: {} }), 'world', NOW)).toBeNull();
  });

  /*
   * Mastheads repeat -- the directory holds eight feeds titled "Eco-Business" --
   * so the feed slug is the identity and the title is only what a reader sees.
   */
  test('the feed slug is the outlet identity, not the title', () => {
    const a = rsa.outletOf(item());
    const b = rsa.outletOf(
      item({
        _rssamplifier: {
          feed_title: 'Eco-Business',
          feed_page: 'https://rssamplifier.com/eco-business-com-3',
        },
      }),
    );
    expect(a.key).not.toBe(b.key);
    expect(a.name).toBe(b.name);
  });

  describe('mastheads', () => {
    test('a long name with a tagline is cut back to the publication', () => {
      expect(
        rsa.masthead('Al Jazeera &#8211; Breaking News, World News and Video from Al Jazeera'),
      ).toBe('Al Jazeera');
    });

    /*
     * The length rule earns its keep: both of these have a separator and a
     * useless left-hand side, and cutting either makes the name worse.
     */
    test('a short name keeps its separator', () => {
      expect(rsa.masthead('News - Tennisuptodate.com')).toBe('News - Tennisuptodate.com');
      expect(rsa.masthead('Daily Express :: World Feed')).toBe('Daily Express :: World Feed');
    });
  });
});

describe('brisk: the small web only', () => {
  const row = (over = {}) => ({
    title: 'Publishing my first LEGO MOC',
    url: 'https://popcorn.cx/blog/2026/09/lego-moc/',
    description: 'At the outset of this series...',
    imageUrl: 'https://popcorn.cx/img/moc.jpg',
    publishedAt: '2026-09-09T07:29:48.000Z',
    source: 'popcorn.cx',
    source_type: 'rss',
    ...over,
  });

  /*
   * The wire is already read directly and through a directory, and a Google
   * News URL 302s back to news.google.com rather than to any publisher.
   */
  test('the wire and the Google stubs are not taken', () => {
    expect(brisk.toItem(row({ source_type: 'api', source: 'thehindu.com' }))).toBeNull();
    expect(
      brisk.toItem(row({ source_type: 'google', url: 'https://news.google.com/rss/articles/CB' })),
    ).toBeNull();
    expect(brisk.toItem(row())).toBeTruthy();
  });

  test('a post is filed under its own desk, never a newsroom one', () => {
    const it = brisk.toItem(row());
    expect(it.data.section).toBe('independent');
    expect(it.tags).toEqual(['news', 'independent', 'popcorn.cx']);
  });

  /*
   * The corpus is built from feed documents, and a few advertise their own
   * comment feed as an entry -- a real post title on a raw XML endpoint.
   */
  test('an entry linking to a feed rather than to a page is dropped', () => {
    for (const url of [
      'https://thebeernut.blogspot.com/feeds/762350/comments/default',
      'https://example.com/index.xml',
      'https://example.com/blog/feed/',
    ]) {
      expect(brisk.toItem(row({ url }))).toBeNull();
    }
    expect(brisk.toItem(row({ url: 'https://example.com/2026/feeding-the-cat' }))).toBeTruthy();
  });

  test('the on-demand screenshot placeholder is not carried as an image', () => {
    const shot = 'https://brisk.news/api/screenshot?url=https%3A%2F%2Fexample.com';
    expect(brisk.toItem(row({ imageUrl: shot })).imageUrl).toBeNull();
    expect(brisk.toItem(row()).imageUrl).toBe('https://popcorn.cx/img/moc.jpg');
  });

  test('www is stripped so one blog is not two outlets', () => {
    expect(brisk.outletOf({ source: 'www.example.com' })).toBe('example.com');
    expect(brisk.outletOf({ source: 'The Beer Nut' })).toBeNull();
    expect(brisk.outletOf({ source: 'localhost' })).toBeNull();
  });
});

/**
 * This runs on every attribute and text node the XML parser reads, so its
 * failure mode is the whole document rather than one field.
 */
describe('decodeEntities', () => {
  test('resolves the typographic references a CMS actually writes', () => {
    expect(decodeEntities('it&rsquo;s crazy&hellip;')).toBe('it’s crazy…');
    expect(decodeEntities('Al Jazeera &#8211; Breaking News')).toBe('Al Jazeera – Breaking News');
    expect(decodeEntities('caf&#233; &#x2014; open')).toBe('café — open');
  });

  /*
   * &amp; last. Resolving it first turns a double-encoded `&amp;#39;` into an
   * apostrophe that was never in the text.
   */
  test('a literal ampersand is not decoded twice into markup', () => {
    expect(decodeEntities('Fish &amp;#39;n chips')).toBe('Fish &#39;n chips');
    expect(decodeEntities('Tom &amp; Jerry')).toBe('Tom & Jerry');
  });

  test('a mangled reference cannot throw and take the document with it', () => {
    // String.fromCodePoint throws above 0x10FFFF; this used to be unguarded.
    expect(decodeEntities('&#1114112;')).toBe('&#1114112;');
    expect(decodeEntities('&#xD800;')).toBe('&#xD800;');
    expect(decodeEntities('&#0;')).toBe('&#0;');
    expect(decodeEntities('50% &off; &notareal;')).toBe('50% &off; &notareal;');
  });

  test('always returns a string, because the parser calls it everywhere', () => {
    expect(decodeEntities('')).toBe('');
    expect(typeof decodeEntities(null)).toBe('string');
  });
});
