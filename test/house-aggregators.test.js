import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import * as agenticjobs from '../packages/adapters/src/agenticjobs.js';
import * as aiornot from '../packages/adapters/src/aiornot.js';
import { ADAPTERS, adapterByName } from '../packages/adapters/src/index.js';
import * as marketplace from '../packages/adapters/src/marketplacefeeds.js';
import * as p0dcasters from '../packages/adapters/src/p0dcasters.js';
import * as saasrow from '../packages/adapters/src/saasrow.js';
import * as tsbb from '../packages/adapters/src/tsbb.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

// The seed reaches the config module, which asserts its env at import rather
// than on first use. Nothing here connects; the value only has to exist.
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';
const { COLLECTIONS, DEFAULT_FEEDS } = await import('../packages/core/src/seed.js');

/** A small sample of each live response, saved 2026-09-12. */
const fixture = (name) =>
  readFile(new URL(`../packages/adapters/test/fixtures/${name}`, import.meta.url), 'utf8');

/**
 * A pull context whose http answers from a table of URL prefix -> body, and
 * records what was asked for. A URL nothing matches is a 404, which is what
 * the real client throws on. The config is the adapter's own defaults under
 * whatever the test passes, which is exactly how the core builds it.
 */
function ctx(name, routes, over = {}) {
  const seen = [];
  const answer = async (url) => {
    seen.push(url);
    const hit = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
    if (!hit) throw new Error(`404 from ${url}`);
    return hit[1];
  };
  return {
    seen,
    ctx: {
      cursor: {},
      env: {},
      log: () => {},
      budget: 0,
      deadline: Date.now() + 60_000,
      http: {
        json: async (url) => JSON.parse(await answer(url)),
        text: answer,
      },
      ...over,
      config: { ...adapterByName(name).defaults, ...(over.config ?? {}) },
    },
  };
}

const HOUSE = {
  p0dcasters: { collection: 'podcasts', kinds: ['show'], source: 'p0dcasters-shows' },
  saasrow: { collection: 'saas', kinds: ['product'], source: 'saasrow-products' },
  d0rz: { collection: 'marketplace', kinds: ['ask', 'offer'], source: 'd0rz-marketplace' },
  bl0ggers: { collection: 'marketplace', kinds: ['ask', 'offer'], source: 'bl0ggers-marketplace' },
  aiornot: { collection: 'ai-media', kinds: ['submission'], source: 'aiornot-media' },
  agenticjobs: { collection: 'jobs', kinds: ['job'], source: 'agenticjobs-postings' },
  tsbb: { collection: 'forums', kinds: ['post'], source: 'tsbb-topics' },
};

describe('registration', () => {
  for (const [name, want] of Object.entries(HOUSE)) {
    test(`${name} is registered against ${want.collection} with a keyless default source`, () => {
      const a = adapterByName(name);
      expect(a).toBeTruthy();
      expect(a.collection).toBe(want.collection);
      expect(a.kinds).toEqual(want.kinds);
      expect(a.needsEnv ?? []).toEqual([]);
      expect(a.defaultSources.map((s) => s.slug)).toEqual([want.source]);
      // The default config only names fields the adapter declares, or the
      // add-source page cannot show what the seed wrote.
      for (const k of Object.keys(a.defaultSources[0].config ?? {})) {
        expect(a.configFields.map((f) => f.key)).toContain(k);
      }
    });
  }

  test('the four new collections exist and every seeded feed names one that does', () => {
    for (const slug of ['saas', 'marketplace', 'ai-media', 'forums']) {
      expect(COLLECTIONS.some((c) => c.slug === slug)).toBe(true);
    }
    const collections = new Set(COLLECTIONS.map((c) => c.slug));
    const sources = new Set(ADAPTERS.flatMap((a) => (a.defaultSources ?? []).map((s) => s.slug)));
    for (const f of DEFAULT_FEEDS) {
      expect(collections.has(f.collection)).toBe(true);
      for (const s of f.query.sources ?? []) expect(sources.has(s)).toBe(true);
    }
  });

  /*
   * Source and feed slugs are unique across the whole database, not per
   * collection, so a slug shared with any other adapter would silently never
   * be created. Every house slug is prefixed with its site for that reason.
   */
  test('house slugs are site-prefixed and claimed once', () => {
    const slugs = ADAPTERS.flatMap((a) => (a.defaultSources ?? []).map((s) => s.slug));
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const [name, want] of Object.entries(HOUSE))
      expect(want.source.startsWith(name)).toBe(true);
    const feeds = DEFAULT_FEEDS.map((f) => f.slug);
    expect(new Set(feeds).size).toBe(feeds.length);
  });
});

describe('p0dcasters', () => {
  test('reads every outline of the OPML, decoding entities and dropping repeats', async () => {
    const outlines = p0dcasters.parseOpml(await fixture('p0dcasters.opml'));
    expect(outlines.length).toBe(7);
    expect(outlines[4].title).toBe('" Reluctant Radio syndicated radio show');
    expect(outlines[3].title).toBe('Die 5-Finger-Formel: 5F = besser leben');

    const { ctx: c } = ctx('p0dcasters', {
      'https://p0dcasters.com/opml': await fixture('p0dcasters.opml'),
    });
    const out = await adapterByName('p0dcasters').pull(c);
    // Seven outlines, one of them the first feed listed twice.
    expect(out.items.length).toBe(6);
    const it = out.items[0];
    expect(it.kind).toBe('show');
    expect(it.externalId).toBe('http://shademountain.org/recordings/feed/');
    expect(it.url).toBe('http://shademountain.org');
    expect(it.data.feedUrl).toBe('http://shademountain.org/recordings/feed/');
    expect(it.tags).toEqual(['podcast', 'self-hosted', 'p0dcasters']);
    expect(normaliseItem(it)).toBeTruthy();
  });

  test('a show with no site lands on its feed rather than nowhere', async () => {
    const outlines = p0dcasters.parseOpml(await fixture('p0dcasters.opml'));
    const bare = outlines.find((o) => !o.htmlUrl);
    expect(bare).toBeTruthy();
    const it = p0dcasters.toItem(bare);
    expect(it.url).toBe(bare.xmlUrl);
    expect(it.data.siteUrl).toBeNull();
    expect(p0dcasters.toItem({ text: 'folder' })).toBeNull();
  });
});

describe('saasrow', () => {
  test('a product carries its category, pricing and tags as tags and its votes as data', async () => {
    const { data } = JSON.parse(await fixture('saasrow-products.json'));
    const it = saasrow.toItem(data[0]);
    expect(it.kind).toBe('product');
    expect(it.externalId).toBe('fe9f761d-01c2-4f50-9a54-f6f146123c22');
    expect(it.title).toBe('nixamp');
    expect(it.url).toBe('https://www.saasrow.com/software/fe9f761d-01c2-4f50-9a54-f6f146123c22');
    expect(it.data.website).toBe('https://nixamp.com');
    expect(it.tags).toEqual([
      'saasrow',
      'music',
      'pricing:free',
      'music',
      'player',
      'terminal',
      'streaming',
      'x402',
    ]);
    expect(normaliseItem(it).tags).toEqual([
      'saasrow',
      'music',
      'pricing:free',
      'player',
      'terminal',
      'streaming',
      'x402',
    ]);
    expect(it.data.category).toBe('Music');
    expect(it.imageUrl).toContain('software-images');
    expect(saasrow.toItem({ id: 'x' })).toBeNull();
  });

  test('walks offset pages until the directory says there is no next', async () => {
    const page = await fixture('saasrow-products.json');
    const empty = JSON.stringify({
      data: [],
      pagination: { total: 467, limit: 100, offset: 100, next: null },
    });
    const { ctx: c, seen } = ctx('saasrow', {
      'https://saasrow.com/api/v1/products?sort=recent&limit=100&offset=0': page,
      'https://saasrow.com/api/v1/products?sort=recent&limit=100&offset=100': empty,
    });
    const out = await adapterByName('saasrow').pull(c);
    expect(out.items.length).toBe(3);
    expect(seen.length).toBe(2);
    expect(seen[1]).toContain('offset=100');
  });

  test('never asks for more pages than configured', async () => {
    const page = await fixture('saasrow-products.json');
    const { ctx: c, seen } = ctx(
      'saasrow',
      { 'https://saasrow.com/api/v1/products': page },
      {
        config: { pages: 1 },
      },
    );
    await adapterByName('saasrow').pull(c);
    expect(seen.length).toBe(1);
  });
});

describe('marketplaces (d0rz, bl0ggers)', () => {
  test('lifts the budget, rate, city and tags back out of the description', () => {
    const { body, fields } = marketplace.splitDescription(
      'Walk my dog.\n\nSecond paragraph.\n\nBudget: $1,500\n\nCity: Dallas, TX\n\nTags: dogs, walking',
    );
    expect(body).toBe('Walk my dog.\n\nSecond paragraph.');
    expect(fields).toEqual({ budget: '$1,500', city: 'Dallas, TX', tags: 'dogs, walking' });
  });

  test('an ask carries its category, city and budget; an offer its rate', async () => {
    const [ask] = marketplace.parseFeed(await fixture('d0rz-asks.xml'), {
      site: 'd0rz',
      kind: 'ask',
    });
    expect(ask.kind).toBe('ask');
    expect(ask.externalId).toBe('https://d0rz.com/asks/fd04f468-9950-47ce-ab1a-379df7efd268');
    expect(ask.title).toBe('Need a website usability tester for a local delivery app');
    expect(ask.summary).toContain('Dallas-Fort Worth');
    expect(ask.summary).not.toContain('Budget:');
    expect(ask.tags).toEqual(['d0rz', 'ask', 'other', 'city:dallas-tx']);
    expect(ask.data).toMatchObject({
      category: 'other',
      city: 'Dallas, TX',
      budget: 15,
      rate: null,
    });

    const offers = marketplace.parseFeed(await fixture('d0rz-offers.xml'), {
      site: 'd0rz',
      kind: 'offer',
    });
    expect(offers[0].kind).toBe('offer');
    expect(offers[0].title).toBe('Anything around Springfield,OH');
    expect(offers[0].summary).toContain('Uber & Lyft');
    // A post with no rate line is a post with no rate, not a zero.
    expect(offers[0].data.rate).toBeNull();
    expect(offers[1].data).toMatchObject({ budget: null, rate: 20, city: 'Dallas, TX' });
  });

  test('d0rz reads both boards and files each under its own kind', async () => {
    const { ctx: c, seen } = ctx('d0rz', {
      'https://d0rz.com/asks/rss.xml': await fixture('d0rz-asks.xml'),
      'https://d0rz.com/offers/rss.xml': await fixture('d0rz-offers.xml'),
    });
    const out = await adapterByName('d0rz').pull(c);
    expect(seen).toEqual(['https://d0rz.com/asks/rss.xml', 'https://d0rz.com/offers/rss.xml']);
    expect(out.items.map((i) => i.kind)).toEqual(['ask', 'ask', 'ask', 'offer', 'offer']);
    for (const it of out.items) expect(normaliseItem(it).publishedAt).toBeTruthy();
  });

  test('bl0ggers shares the parser, reads its own host, and an empty feed is not a failure', async () => {
    const lines = [];
    const { ctx: c, seen } = ctx(
      'bl0ggers',
      {
        'https://bl0ggers.com/asks/rss.xml': await fixture('bl0ggers-asks.xml'),
        'https://bl0ggers.com/offers/rss.xml': await fixture('bl0ggers-asks.xml'),
      },
      { log: (m) => lines.push(m) },
    );
    const out = await adapterByName('bl0ggers').pull(c);
    expect(seen.every((u) => u.startsWith('https://bl0ggers.com/'))).toBe(true);
    expect(out.items).toEqual([]);
    expect(lines.some((l) => l.includes('failed'))).toBe(false);
  });

  test('one side can be turned off, and a failed side does not lose the other', async () => {
    const { ctx: c, seen } = ctx(
      'd0rz',
      { 'https://d0rz.com/asks/rss.xml': await fixture('d0rz-asks.xml') },
      { config: { sides: 'offers, asks' } },
    );
    const out = await adapterByName('d0rz').pull(c);
    expect(seen.length).toBe(2);
    expect(out.items.length).toBe(3);
  });
});

describe('aiornot', () => {
  test('a submission carries its media, categories and the feed it came from', async () => {
    const [it] = aiornot.parseFeed(await fixture('aiornot-latest.xml'), 'latest');
    expect(it.kind).toBe('submission');
    expect(it.externalId).toBe('media:med_792571a62a1945a79e9bb2e9463b6112');
    expect(it.url).toBe('https://aiornot.vote/m/ai-or-not-animal-mtu2lpg8');
    expect(it.imageUrl).toContain('/media/pool/');
    expect(it.summary).toBe('Guess: AI or Not AI. No guesses yet — be the first.');
    expect(it.tags).toEqual(['aiornot', 'latest', 'animal', 'photorealistic', 'image']);
    expect(it.data).toMatchObject({ mediaType: 'image', feeds: ['latest'] });
  });

  test('a submission on two feeds is stored once and tagged with both', async () => {
    const latest = await fixture('aiornot-latest.xml');
    const { ctx: c } = ctx('aiornot', {
      'https://aiornot.vote/rss.xml': latest,
      'https://aiornot.vote/rss/featured.xml': await fixture('aiornot-featured.xml'),
      // The same document again, as if everything new were also trending.
      'https://aiornot.vote/rss/trending.xml': latest,
    });
    const out = await adapterByName('aiornot').pull(c);
    expect(out.items.length).toBe(6);
    const animal = out.items.find((i) => i.url.endsWith('ai-or-not-animal-mtu2lpg8'));
    expect(animal.tags).toContain('latest');
    expect(animal.tags).toContain('trending');
    expect(animal.tags).not.toContain('featured');
    expect(animal.data.feeds).toEqual(['latest', 'trending']);
    // The dedupe key the collection uses is the canonical URL, so the same
    // submission from two feeds is one key.
    const keys = out.items.map((i) => normaliseItem(i).dedupeKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('reads latest first whatever order the config lists', async () => {
    const { ctx: c, seen } = ctx(
      'aiornot',
      {
        'https://aiornot.vote/rss.xml': await fixture('aiornot-latest.xml'),
        'https://aiornot.vote/rss/trending.xml': await fixture('aiornot-trending.xml'),
      },
      { config: { feeds: ['trending', 'latest'] } },
    );
    await adapterByName('aiornot').pull(c);
    expect(seen).toEqual(['https://aiornot.vote/rss.xml', 'https://aiornot.vote/rss/trending.xml']);
  });
});

describe('agenticjobs', () => {
  test('a posting names its company in the title and carries pay as written', async () => {
    const { items } = JSON.parse(await fixture('agenticjobs-jobs.json'));
    const it = agenticjobs.toItem(items[0]);
    expect(it.kind).toBe('job');
    expect(it.externalId).toBe('3b0d293e-e2af-4609-af4d-1c4762a48a1e');
    expect(it.title).toBe('promote us to your other communities — Profullstack, Inc.');
    expect(it.url).toBe('https://agenticjobs.work/jobs/promote-us-to-your-other-communities');
    expect(it.publishedAt.toISOString()).toBe('2026-09-11T11:33:18.752Z');
    expect(it.tags).toEqual([
      'agenticjobs',
      'temporary',
      'remote',
      'intern',
      'agents:welcome',
      'company:profullstack-inc',
      'ai',
      'promo',
      'ai',
    ]);
    expect(it.data).toMatchObject({
      company: 'Profullstack, Inc.',
      remote: true,
      location: 'Remote',
      agentPolicy: 'welcome',
      applyVia: 'board',
    });
    expect(it.data.pay.lines[0].unit).toContain('share');
    expect(agenticjobs.toItem({ ...items[0], status: 'draft' })).toBeNull();
  });

  test('walks offset pages and stops at the total', async () => {
    const page = await fixture('agenticjobs-jobs.json');
    const { ctx: c, seen } = ctx('agenticjobs', { 'https://agenticjobs.work/api/v1/jobs': page });
    const out = await adapterByName('agenticjobs').pull(c);
    expect(out.items.length).toBe(2);
    // Two postings of a total of two: the first page is also the last.
    expect(seen.length).toBe(1);
    expect(seen[0]).toContain('sort=recent&limit=100&offset=0');
  });
});

describe('tsbb', () => {
  test('reads only real forums with topics in them', async () => {
    const forums = tsbb.readableForums(JSON.parse(await fixture('tsbb-forums.json')));
    expect(forums.map((f) => f.slug)).toEqual([
      'announcements',
      'general',
      'app-showcase',
      'agentic-ai',
    ]);
    expect(forums[0].name).toBe('Announcements');
  });

  test('a topic carries its forum, author and opening post', async () => {
    const [it] = tsbb.parseFeed(await fixture('tsbb-feed-general.xml'), {
      slug: 'general',
      name: 'General discussion',
    });
    expect(it.kind).toBe('post');
    expect(it.externalId).toBe('https://tsbb.dev/t/this-is-neat-1');
    expect(it.title).toBe('This is neat');
    expect(it.summary).toBe('a new bulletin system in 2 hours.');
    expect(it.tags).toEqual(['tsbb', 'forum:general', 'by:anthony']);
    expect(it.data).toMatchObject({
      forum: 'general',
      forumName: 'General discussion',
      author: 'anthony',
    });
  });

  test('pulls the forum list, then each readable forum feed, and survives a missing one', async () => {
    const lines = [];
    const { ctx: c, seen } = ctx(
      'tsbb',
      {
        'https://tsbb.dev/api/v1/forums': await fixture('tsbb-forums.json'),
        'https://tsbb.dev/f/announcements/feed.xml': await fixture('tsbb-feed-announcements.xml'),
        'https://tsbb.dev/f/general/feed.xml': await fixture('tsbb-feed-general.xml'),
      },
      { log: (m) => lines.push(m) },
    );
    const out = await adapterByName('tsbb').pull(c);
    expect(seen[0]).toBe('https://tsbb.dev/api/v1/forums');
    expect(seen.length).toBe(5);
    expect(out.items.length).toBe(4);
    expect(out.items.filter((i) => i.tags.includes('forum:announcements')).length).toBe(3);
    expect(lines.some((l) => l.includes('app-showcase') && l.includes('agentic-ai'))).toBe(true);
  });

  test('a configured forum list narrows the walk', async () => {
    const { ctx: c, seen } = ctx(
      'tsbb',
      {
        'https://tsbb.dev/api/v1/forums': await fixture('tsbb-forums.json'),
        'https://tsbb.dev/f/general/feed.xml': await fixture('tsbb-feed-general.xml'),
      },
      { config: { forums: 'general' } },
    );
    const out = await adapterByName('tsbb').pull(c);
    expect(seen.length).toBe(2);
    expect(out.items.length).toBe(1);
  });
});
