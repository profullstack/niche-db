import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_QUERIES,
  toItem as gdeltItem,
  parseResponse as parseGdelt,
  sectionFor,
  seenDate,
} from '../packages/adapters/src/gdelt.js';
import { ADAPTERS, adapterByName } from '../packages/adapters/src/index.js';
import {
  buildItems,
  toItem as channelItem,
  indexStreams,
  isNewsChannel,
} from '../packages/adapters/src/newschannels.js';
import {
  DEFAULT_FEEDS,
  toItem as feedItem,
  outletOf,
  parseFeed,
  SECTIONS,
  splitFeedSpec,
} from '../packages/adapters/src/newsfeed.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

// The seed module reaches the database package, which reads the environment at
// import. It needs the variable to exist, not to connect.
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';
const { COLLECTIONS, DEFAULT_FEEDS: SEED_FEEDS } = await import('../packages/core/src/seed.js');

const RSS = `<?xml version="1.0"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>BBC News</title>
    <item>
      <title>Talks resume after a week of delay</title>
      <description><![CDATA[<p>Negotiators returned to the table on Monday.</p>]]></description>
      <link>https://www.bbc.co.uk/news/world-1</link>
      <guid isPermaLink="false">urn:bbc:1</guid>
      <pubDate>Mon, 08 Sep 2026 09:30:00 GMT</pubDate>
      <category>World</category>
      <media:thumbnail url="https://ichef.bbci.co.uk/one.jpg"/>
      <dc:creator>A Reporter</dc:creator>
    </item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Budget passes on a second reading</title>
    <id>tag:example.org,2026:2</id>
    <link rel="alternate" href="https://example.org/budget"/>
    <summary>The measure cleared by nine votes.</summary>
    <updated>2026-09-08T11:00:00Z</updated>
  </entry>
</feed>`;

describe('newsfeed', () => {
  test('reads an RSS item, keeping the guid, image, author and category', () => {
    const [item] = parseFeed(RSS, 'https://feeds.bbci.co.uk/news/world/rss.xml');
    expect(item.externalId).toBe('bbci:urn:bbc:1');
    expect(item.kind).toBe('story');
    expect(item.title).toBe('Talks resume after a week of delay');
    // CDATA and the wrapping <p> are both gone.
    expect(item.summary).toBe('Negotiators returned to the table on Monday.');
    expect(item.url).toBe('https://www.bbc.co.uk/news/world-1');
    expect(item.imageUrl).toBe('https://ichef.bbci.co.uk/one.jpg');
    expect(item.tags).toContain('news');
    expect(item.tags).toContain('World');
    expect(item.data.author).toBe('A Reporter');
  });

  test('reads an Atom entry, where the link is an href and not the text', () => {
    const [item] = parseFeed(ATOM, 'https://example.org/feed');
    expect(item.url).toBe('https://example.org/budget');
    expect(item.externalId).toBe('example:tag:example.org,2026:2');
    expect(item.summary).toBe('The measure cleared by nine votes.');
  });

  test('an item with no title or no id is dropped rather than stored half-formed', () => {
    expect(feedItem('https://x.com/f', { title: { text: 'No link or guid' } })).toBeNull();
    expect(feedItem('https://x.com/f', { guid: { text: 'g' } })).toBeNull();
  });

  test('outlet slug survives the delivery-host prefixes', () => {
    expect(outletOf('https://feeds.bbci.co.uk/news/world/rss.xml')).toBe('bbci');
    expect(outletOf('https://rss.dw.com/rdf/rss-en-all')).toBe('dw');
    expect(outletOf('https://feeds.a.dj.com/rss/RSSWorldNews.xml')).toBe('dj');
    expect(outletOf('https://www.theguardian.com/world/rss')).toBe('theguardian');
    expect(outletOf('not a url')).toBe('unknown');
  });

  test('every shipped feed names a section and an absolute https url', () => {
    expect(DEFAULT_FEEDS.length).toBeGreaterThan(0);
    for (const f of DEFAULT_FEEDS) {
      const { section, url } = splitFeedSpec(f);
      expect(SECTIONS).toContain(section);
      expect(url).toMatch(/^https:\/\//);
    }
    // Every declared section is actually covered by at least one feed.
    const covered = new Set(DEFAULT_FEEDS.map((f) => splitFeedSpec(f).section));
    for (const s of SECTIONS) expect(covered.has(s)).toBe(true);
  });

  test('world is listed first so the specific desk wins a duplicate', () => {
    // A story on two desks collapses to one row by id, so the LAST feed to
    // carry it decides its section. That is only the right answer while world
    // stays at the top of the list.
    const sections = DEFAULT_FEEDS.map((f) => splitFeedSpec(f).section);
    const lastWorld = sections.lastIndexOf('world');
    const firstOther = sections.findIndex((s) => s !== 'world');
    expect(sections[0]).toBe('world');
    expect(lastWorld).toBeLessThan(firstOther === -1 ? Infinity : firstOther);
  });

  test('a bare url still works and lands in world', () => {
    expect(splitFeedSpec('https://example.com/rss')).toEqual({
      section: 'world',
      url: 'https://example.com/rss',
    });
    expect(splitFeedSpec('politics=https://example.com/rss')).toEqual({
      section: 'politics',
      url: 'https://example.com/rss',
    });
    // A query string is not a section prefix.
    expect(splitFeedSpec('https://example.com/rss?a=b').section).toBe('world');
  });

  test('the section rides on the item but never on its id', () => {
    const [a] = parseFeed(RSS, 'https://feeds.bbci.co.uk/news/politics/rss.xml', 'politics');
    const [b] = parseFeed(RSS, 'https://feeds.bbci.co.uk/news/world/rss.xml', 'world');
    expect(a.data.section).toBe('politics');
    expect(a.tags).toContain('politics');
    // The same story on two desks is one story, not two rows.
    expect(a.externalId).toBe(b.externalId);
  });
});

describe('gdelt', () => {
  test('seendate is a compact stamp new Date() cannot read', () => {
    expect(seenDate('20260727T141500Z').toISOString()).toBe('2026-07-27T14:15:00.000Z');
    expect(seenDate('')).toBeNull();
    expect(seenDate('2026-07-27')).toBeNull();
  });

  test('an article carries its country and language as tags', () => {
    const item = gdeltItem('election', {
      url: 'https://www.prokerala.com/news/a1.html',
      title: 'CEC discusses poll staff training',
      seendate: '20260727T141500Z',
      socialimage: '',
      domain: 'prokerala.com',
      language: 'English',
      sourcecountry: 'India',
    });
    expect(item.externalId).toBe('gdelt:https://www.prokerala.com/news/a1.html');
    // GDELT sends "" rather than omitting an absent image.
    expect(item.imageUrl).toBeNull();
    expect(item.tags).toEqual(
      expect.arrayContaining(['news', 'gdelt', 'election', 'prokerala.com', 'india', 'english']),
    );
  });

  test('a throttled reply is prose, not JSON, and parses to null rather than throwing', () => {
    expect(parseGdelt('Please limit requests to one every 5 seconds', 'election')).toBeNull();
    expect(parseGdelt('{"articles":[]}', 'election')).toEqual([]);
  });

  test('beats are short enough to stay inside the rate limit', () => {
    expect(DEFAULT_QUERIES.length).toBeLessThanOrEqual(10);
  });

  test('a beat is a search term; a section is where a reader looks for it', () => {
    expect(sectionFor('election')).toBe('politics');
    expect(sectionFor('economy')).toBe('business');
    // An unmapped beat files under its own name, so adding one needs no change.
    expect(sectionFor('weather')).toBe('weather');
    const item = gdeltItem('election', {
      url: 'https://x.example/a',
      title: 'A',
      seendate: '20260908T000000Z',
      domain: 'x.example',
    });
    expect(item.data.section).toBe('politics');
    expect(item.tags).toContain('politics');
  });
});

describe('news channels', () => {
  const channels = [
    { id: 'A.us', name: 'Alpha News', categories: ['news'], is_nsfw: false, closed: null },
    { id: 'B.us', name: 'Beta News', categories: ['news'], is_nsfw: false, closed: null },
    {
      id: 'C.us',
      name: 'Gamma',
      categories: ['news'],
      is_nsfw: false,
      closed: '2020-01-01',
      country: 'US',
    },
    { id: 'D.us', name: 'Delta Sports', categories: ['sports'], is_nsfw: false, closed: null },
  ];
  const streams = [
    { channel: 'A.us', url: 'https://a.example/live.m3u8', quality: '1080p', title: 'Alpha' },
    { channel: 'A.us', url: 'https://a2.example/live.m3u8', quality: '720p', title: 'Alpha alt' },
    { channel: 'C.us', url: 'https://c.example/live.m3u8', quality: null, title: 'Gamma' },
    { channel: null, url: 'https://orphan.example/live.m3u8', quality: null, title: 'Orphan' },
  ];

  test('only live, non-adult news channels qualify', () => {
    expect(isNewsChannel(channels[0])).toBe(true);
    expect(isNewsChannel(channels[2])).toBe(false); // closed
    expect(isNewsChannel(channels[3])).toBe(false); // not news
    expect(isNewsChannel({ id: 'x', name: 'x', categories: ['news'], is_nsfw: true })).toBe(false);
  });

  test('a stream with no channel is skipped rather than indexed under null', () => {
    const idx = indexStreams(streams);
    expect(idx.get('A.us')).toHaveLength(2);
    expect(idx.has(null)).toBe(false);
  });

  test('a news channel with no stream is counted, not stored', () => {
    const { items, withoutStream } = buildItems(channels, streams);
    expect(items.map((i) => i.externalId)).toEqual(['A.us']);
    // Beta is news and live but has no stream; Gamma has a stream but is closed.
    expect(withoutStream).toBe(1);
  });

  test('the first stream becomes the one to play, and all are kept', () => {
    const item = channelItem(channels[0], indexStreams(streams).get('A.us'));
    expect(item.kind).toBe('channel');
    expect(item.data.streamUrl).toBe('https://a.example/live.m3u8');
    expect(item.data.quality).toBe('1080p');
    expect(item.data.streams).toHaveLength(2);
    expect(item.summary).toContain('2 public streams');
  });
});

describe('the news collection is wired up', () => {
  test('all three adapters are registered against it', () => {
    const news = ADAPTERS.filter((a) => a.collection === 'news').map((a) => a.name);
    expect(news.sort()).toEqual(['gdelt', 'news-channels', 'newsfeed']);
    expect(adapterByName('newsfeed').title).toBe('Newsroom feeds');
  });

  test('the collection exists and its default feeds name real sources', () => {
    expect(COLLECTIONS.find((c) => c.slug === 'news')).toBeTruthy();
    const sourceSlugs = new Set(
      ADAPTERS.flatMap((a) => (a.defaultSources ?? []).map((s) => s.slug)),
    );
    for (const f of SEED_FEEDS.filter((f) => f.collection === 'news')) {
      for (const s of f.query.sources ?? []) expect(sourceSlugs.has(s)).toBe(true);
    }
  });

  test('every produced item survives normalisation', () => {
    const [story] = parseFeed(RSS, 'https://feeds.bbci.co.uk/news/world/rss.xml');
    const normalised = normaliseItem(story);
    expect(normalised.publishedAt.toISOString()).toBe('2026-09-08T09:30:00.000Z');
    expect(normalised.contentHash).toMatch(/^[0-9a-f]{40}$/);
  });
});
