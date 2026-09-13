/**
 * OpenSite: the reading rules, proven on fixtures, and the adapter's
 * registration. What would be embarrassing: a card tag lost, a relative
 * picture kept relative, a javascript: image, a robots rule ignored, a
 * gone page kept as live, a record bigger than the spec allows.
 */
import { describe, expect, test } from 'bun:test';
import { ADAPTERS, adapterByName } from '../packages/adapters/src/index.js';
import { opensite } from '../packages/adapters/src/opensite.js';
import { normaliseItem } from '../packages/core/src/adapter.js';
import {
  AGENT,
  cardsOf,
  decodeEntities,
  kindOf,
  parseHead,
  parseUrlList,
  publicWebUrl,
  readRecord,
  readSitemap,
  readUrl,
  recordItem,
  recordPath,
  robotsAllows,
  urlsForPath,
} from '../packages/core/src/opensite.js';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';
const { COLLECTIONS } = await import('../packages/core/src/seed.js');

const PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Inspiring Founders Podcast — nixamp</title>
  <meta name="description" content="Inspiring Founders Podcast is live on server1. Tune in free on nixamp, no account needed." />
  <link rel="canonical" href="/?url=https%3A%2F%2Fserver1.example%3A4321%2Fview%2FK&amp;play=channel%3Aurl-6f4152c1590e" />
  <link rel="icon" href="/favicon.png" type="image/png" sizes="64x64" />
  <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
  <link rel="alternate" type="application/rss+xml" title="feed" href="/feed.xml" />
  <meta property="og:site_name" content="nixamp" />
  <meta property="og:title" content="Inspiring Founders Podcast" />
  <meta property="og:description" content="Inspiring Founders Podcast is live on server1." />
  <meta property="og:type" content="website" />
  <meta property="og:image" content="https://cdn.example/44567180.jpg" />
  <meta property="og:image:width" content="3000" />
  <meta property="og:image:height" content="3000" />
  <meta property="og:image:alt" content="Inspiring Founders Podcast" />
  <meta name="twitter:card" content="summary" />
  <meta content="Inspiring Founders Podcast" name="twitter:title" />
  <meta property="article:tag" content="Podcast, Live" />
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"BroadcastEvent","name":"Inspiring Founders Podcast","datePublished":"2026-09-13T04:00:00Z"}</script>
</head>
<body><h1>hi</h1></body></html>`;

describe('parsing the head', () => {
  test('entities, attributes in either order, links, JSON-LD and the language', () => {
    expect(decodeEntities('a &amp; b &#39;c&#39; &#x41; &quot;d&quot; &nbsp;e')).toBe(
      'a & b \'c\' A "d"  e',
    );
    const head = parseHead(PAGE);
    expect(head.title).toBe('Inspiring Founders Podcast — nixamp');
    expect(head.lang).toBe('en');
    expect(head.metas.find((m) => m.name === 'twitter:title')?.content).toBe(
      'Inspiring Founders Podcast',
    );
    expect(head.links.find((l) => l.rel.includes('canonical'))?.href).toContain(
      'play=channel%3Aurl-6f4152c1590e',
    );
    expect(head.jsonld[0]['@type']).toBe('BroadcastEvent');
    const cards = cardsOf(head.metas);
    expect(cards.og['image:width']).toBe('3000');
    expect(cards.twitter.card).toBe('summary');
    expect(cards.article.tag).toBe('Podcast, Live');
    // Only prefixed names are cards; a plain description is not.
    expect(cards.description).toBeUndefined();
  });

  test('the kind: JSON-LD first, then og:type, then page', () => {
    expect(kindOf({ jsonld: [{ '@type': 'NewsArticle' }] })).toBe('article');
    expect(kindOf({ jsonld: [{ '@type': ['Thing', 'PodcastEpisode'] }] })).toBe('episode');
    expect(kindOf({ og: { type: 'video.other' } })).toBe('video');
    expect(kindOf({ og: { type: 'music.song' } })).toBe('audio');
    expect(kindOf({ og: { type: 'website' } })).toBe('page');
    expect(kindOf({})).toBe('page');
  });
});

describe('a record from a page', () => {
  const url =
    'https://nixamp.com/?url=https%3A%2F%2Fserver1.example%3A4321%2Fview%2FK&play=channel%3Aurl-6f4152c1590e';
  const record = readRecord({ url, html: PAGE, fetchedAt: new Date('2026-09-13T04:52:10Z') });

  test('every required key, first answer wins, pictures absolute, tags kept verbatim', () => {
    expect(record.opensite).toBe('0.1');
    expect(record.url).toBe(url);
    expect(record.canonical).toBe(url);
    expect(record.site).toEqual({ name: 'nixamp', web: 'https://nixamp.com' });
    // JSON-LD names it first, so its name wins over og:title; here they agree.
    expect(record.title).toBe('Inspiring Founders Podcast');
    // JSON-LD has no description, og does, and it wins over <meta name=description>.
    expect(record.description).toBe('Inspiring Founders Podcast is live on server1.');
    expect(record.image).toEqual({
      url: 'https://cdn.example/44567180.jpg',
      width: 3000,
      height: 3000,
      alt: 'Inspiring Founders Podcast',
    });
    expect(record.kind).toBe('stream');
    expect(record.language).toBe('en');
    expect(record.feeds).toEqual(['https://nixamp.com/feed.xml']);
    expect(record.tags).toEqual(['podcast', 'live']);
    expect(record.published_at).toBe('2026-09-13T04:00:00.000Z');
    expect(record.modified_at).toBeNull();
    expect(record.fetched_at).toBe('2026-09-13T04:52:10.000Z');
    expect(record.status).toBe('live');
    expect(record.source).toBe('read');
    expect(record.cards.og.title).toBe('Inspiring Founders Podcast');
    expect(record.cards.twitter.card).toBe('summary');
    expect(record.jsonld[0]['@type']).toBe('BroadcastEvent');
  });

  test('a picture is http(s) and absolute, or the largest icon, or nothing', () => {
    const rel = readRecord({
      url: 'https://a.example/x',
      html: '<html><head><meta property="og:image" content="/pic.jpg"></head></html>',
    });
    expect(rel.image.url).toBe('https://a.example/pic.jpg');
    const bad = readRecord({
      url: 'https://a.example/x',
      html: '<html><head><meta property="og:image" content="javascript:alert(1)"><link rel="icon" sizes="32x32" href="/i32.png"><link rel="apple-touch-icon" href="/touch.png"></head></html>',
    });
    expect(bad.image).toEqual({ url: 'https://a.example/touch.png', icon: true });
    const none = readRecord({
      url: 'https://a.example/x',
      html: '<html><head><title>t</title></head></html>',
    });
    expect(none.image).toBeUndefined();
    expect(none.title).toBe('t');
    expect(none.site).toEqual({ name: 'a.example', web: 'https://a.example' });
  });

  test('a canonical on another origin is moved; 404 is gone; a media file is its kind', () => {
    const moved = readRecord({
      url: 'https://old.example/p',
      html: '<html><head><link rel="canonical" href="https://new.example/p"></head></html>',
    });
    expect(moved.status).toBe('moved');
    expect(moved.canonical).toBe('https://new.example/p');
    const gone = readRecord({ url: 'https://a.example/p', status: 410, html: '' });
    expect(gone.status).toBe('gone');
    const mp3 = readRecord({ url: 'https://a.example/ep.mp3', contentType: 'audio/mpeg' });
    expect(mp3.kind).toBe('audio');
    expect(mp3.title).toBe('ep.mp3');
    const feed = readRecord({
      url: 'https://a.example/feed.xml',
      contentType: 'application/rss+xml; charset=utf-8',
    });
    expect(feed.kind).toBe('feed');
    const blocked = readRecord({ url: 'https://a.example/p', blocked: true });
    expect(blocked.status).toBe('blocked');
  });

  test('the author from JSON-LD, article:author or a rel=me OpenProfile', () => {
    const r = readRecord({
      url: 'https://a.example/post',
      html: '<html><head><meta property="article:author" content="Ada"><link rel="me" href="/~ada/OpenProfile.md"></head></html>',
    });
    expect(r.author).toEqual({ name: 'Ada', profile: 'https://a.example/~ada/OpenProfile.md' });
    const ld = readRecord({
      url: 'https://a.example/post',
      html: '<html><head><script type="application/ld+json">{"@type":"Article","headline":"H","author":{"@type":"Person","name":"Bob","url":"https://bob.example"}}</script></head></html>',
    });
    expect(ld.author).toEqual({ name: 'Bob', web: 'https://bob.example/' });
    expect(ld.title).toBe('H');
    expect(ld.kind).toBe('article');
  });

  test('a record never exceeds the cap: JSON-LD goes first', () => {
    const big = `<html><head><script type="application/ld+json">${JSON.stringify({ '@type': 'Thing', blob: 'x'.repeat(300_000) })}</script></head></html>`;
    const r = readRecord({ url: 'https://a.example/big', html: big });
    expect(JSON.stringify(r).length).toBeLessThan(256 * 1024);
    expect(r.jsonld).toEqual([]);
  });

  test('the item the table stores, and where the record lives', () => {
    const item = normaliseItem(recordItem(record));
    expect(item.externalId).toBe(`opensite:${url}`);
    expect(item.kind).toBe('stream');
    expect(item.url).toBe(url);
    expect(item.imageUrl).toBe('https://cdn.example/44567180.jpg');
    expect(item.summary).toBe('Inspiring Founders Podcast is live on server1.');
    expect(item.tags).toEqual([
      'kind:stream',
      'site:nixamp.com',
      'status:live',
      'topic:podcast',
      'topic:live',
    ]);
    expect(item.data.record.canonical).toBe(url);
    expect(item.data.path).toBe(
      'nixamp.com/?url=https%3A%2F%2Fserver1.example%3A4321%2Fview%2FK&play=channel%3Aurl-6f4152c1590e',
    );
    // An icon is not a picture for the row.
    const iconOnly = recordItem({
      canonical: 'https://a.example/',
      kind: 'page',
      title: 't',
      status: 'live',
      image: { url: 'https://a.example/i.png', icon: true },
    });
    expect(iconOnly.imageUrl).toBeNull();
    expect(recordPath('https://a.example/')).toBe('a.example');
    expect(recordPath('https://a.example:4321/x/y?z=1')).toBe('a.example:4321/x/y?z=1');
    expect(urlsForPath('a.example')).toEqual([
      'https://a.example',
      'https://a.example/',
      'http://a.example',
      'http://a.example/',
    ]);
    expect(urlsForPath('a.example/x?y=1')).toEqual([
      'https://a.example/x?y=1',
      'http://a.example/x?y=1',
    ]);
    expect(urlsForPath('not a host/x')).toEqual([]);
  });
});

describe('refusing politely', () => {
  test('robots.txt: our group, then *, longest match, allow on a tie', () => {
    const txt =
      'User-agent: *\nDisallow: /private\nAllow: /private/ok\n\nUser-agent: OpenSite\nDisallow: /nope\n';
    expect(robotsAllows(txt, '/public')).toBe(true);
    expect(robotsAllows(txt, '/nope/x')).toBe(false);
    // Our own group wins over *, so /private is not ours to refuse.
    expect(robotsAllows(txt, '/private')).toBe(true);
    expect(robotsAllows(txt, '/private', 'Mozilla/5.0')).toBe(false);
    expect(robotsAllows(txt, '/private/ok', 'Mozilla/5.0')).toBe(true);
    expect(robotsAllows('', '/anything')).toBe(true);
    expect(AGENT).toMatch(/^OpenSite\/0\.1 \(\+https:\/\/logicsrc\.com\/opensite\)$/);
  });

  test('readUrl honours the descriptor and robots, and reads the page otherwise', async () => {
    const served = {
      'https://a.example/robots.txt': {
        body: 'User-agent: *\nDisallow: /secret\n',
        type: 'text/plain',
      },
      'https://a.example/.well-known/opensite.json': {
        body: JSON.stringify({
          opensite: '0.1',
          site: { name: 'A', web: 'https://a.example' },
          index: { allow: true },
        }),
        type: 'application/json',
      },
      'https://a.example/page': {
        body: '<html><head><title>P</title><meta property="og:image" content="/p.jpg"></head></html>',
        type: 'text/html',
      },
      'https://closed.example/robots.txt': { body: '', type: 'text/plain', status: 404 },
      'https://closed.example/.well-known/opensite.json': {
        body: JSON.stringify({
          opensite: '0.1',
          site: { name: 'C', web: 'https://closed.example' },
          index: { allow: false },
        }),
        type: 'application/json',
      },
    };
    const asked = [];
    const http = {
      async request(url) {
        asked.push(url);
        const hit = served[url];
        const status = hit?.status ?? (hit ? 200 : 404);
        return new Response(hit?.body ?? '', {
          status,
          headers: { 'content-type': hit?.type ?? 'text/plain' },
        });
      },
    };
    const page = await readUrl('https://a.example/page', {
      http,
      now: () => new Date('2026-09-13T00:00:00Z'),
    });
    expect(page.status).toBe('live');
    expect(page.title).toBe('P');
    expect(page.site).toEqual({ name: 'A', web: 'https://a.example' });
    expect(page.image.url).toBe('https://a.example/p.jpg');
    const secret = await readUrl('https://a.example/secret/x', { http });
    expect(secret.status).toBe('blocked');
    expect(asked.filter((u) => u.endsWith('/secret/x'))).toEqual([]);
    const closed = await readUrl('https://closed.example/anything', { http });
    expect(closed.status).toBe('blocked');
    expect(await readUrl('javascript:alert(1)', { http })).toBeNull();
    const missing = await readUrl('https://a.example/missing', { http });
    expect(missing.status).toBe('gone');
  });

  test('a sitemap and a sitemap index', async () => {
    const http = {
      async request(url) {
        if (url.endsWith('index.xml'))
          return new Response(
            '<sitemapindex><sitemap><loc>https://a.example/s1.xml</loc></sitemap></sitemapindex>',
            { headers: { 'content-type': 'application/xml' } },
          );
        return new Response(
          '<urlset><url><loc>https://a.example/one</loc></url><url><loc>https://a.example/two</loc></url><url><loc>https://a.example/one</loc></url></urlset>',
          { headers: { 'content-type': 'application/xml' } },
        );
      },
    };
    expect(await readSitemap('https://a.example/s1.xml', { http })).toEqual({
      urls: ['https://a.example/one', 'https://a.example/two'],
      sitemaps: [],
    });
    expect((await readSitemap('https://a.example/index.xml', { http })).sitemaps).toEqual([
      'https://a.example/s1.xml',
    ]);
  });
});

describe('the adapter', () => {
  test('is registered against sites with keyless, site-prefixed sources and the pasted one disabled', () => {
    const a = adapterByName('opensite');
    expect(a).toBe(opensite);
    expect(a.collection).toBe('sites');
    expect(a.needsEnv ?? []).toEqual([]);
    expect(COLLECTIONS.some((c) => c.slug === 'sites')).toBe(true);
    const pasted = a.defaultSources.find((s) => s.slug === 'sites-pasted');
    expect(pasted.enabled).toBe(false);
    for (const s of a.defaultSources) {
      for (const k of Object.keys(s.config)) expect(a.configFields.map((f) => f.key)).toContain(k);
      expect(s.slug.endsWith('-pages') || s.slug === 'sites-pasted').toBe(true);
    }
    const all = ADAPTERS.flatMap((x) => (x.defaultSources ?? []).map((s) => s.slug));
    expect(new Set(all).size).toBe(all.length);
  });

  test('a run reads the addresses, then walks the sitemap from where it stopped', async () => {
    const html = (t) => `<html><head><title>${t}</title></head></html>`;
    const pages = [
      'https://a.example/',
      'https://a.example/p1',
      'https://a.example/p2',
      'https://a.example/p3',
    ];
    const http = {
      async request(url) {
        if (url.endsWith('/robots.txt') || url.endsWith('/opensite.json'))
          return new Response('', { status: 404 });
        if (url.endsWith('/sitemap.xml'))
          return new Response(
            `<urlset>${pages.map((p) => `<url><loc>${p}</loc></url>`).join('')}</urlset>`,
            { headers: { 'content-type': 'application/xml' } },
          );
        return new Response(html(url.split('/').pop() || 'home'), {
          headers: { 'content-type': 'text/html' },
        });
      },
    };
    const config = {
      urls: ['https://a.example/'],
      sitemaps: ['https://a.example/sitemap.xml'],
      pages: 2,
    };
    const one = await opensite.pull({
      config,
      cursor: {},
      http,
      log: () => {},
      deadline: Date.now() + 10_000,
    });
    // One pool, the front page first, two a run, and back to the start when done.
    expect(one.items.map((i) => i.url)).toEqual(['https://a.example/', 'https://a.example/p1']);
    expect(one.cursor).toEqual({ offset: 2, total: 4 });
    expect(one.nextInMinutes).toBe(1);
    const two = await opensite.pull({
      config,
      cursor: one.cursor,
      http,
      log: () => {},
      deadline: Date.now() + 10_000,
    });
    expect(two.items.map((i) => i.url)).toEqual(['https://a.example/p2', 'https://a.example/p3']);
    expect(two.cursor).toEqual({ offset: 0, total: 4 });
    expect(two.nextInMinutes).toBeUndefined();
    expect(normaliseItem(one.items[1]).title).toBe('p1');
  });
});

describe('a list of addresses', () => {
  test('lines, commas, bullets, bare domains, repeats, the cap, and what could not be read', () => {
    const out = parseUrlList(
      'https://a.example/x\n- b.example, "https://a.example/x#frag"\n<c.example/p>\nnot a url\n# a comment\nhttp://10.0.0.1/admin\n',
      3,
    );
    expect(out.urls).toEqual(['https://a.example/x', 'https://b.example/', 'https://c.example/p']);
    expect(out.rejected).toEqual(['http://10.0.0.1/admin']);
    expect(out.dropped).toBe(0);
    const capped = parseUrlList('a.example\nb.example\nc.example\nd.example', 2);
    expect(capped.urls).toHaveLength(2);
    expect(capped.dropped).toBe(2);
  });

  test('a public address is on the public web', () => {
    expect(publicWebUrl('https://example.com/x')).toBe('https://example.com/x');
    for (const bad of [
      'http://localhost/',
      'http://web.railway.internal:3000/',
      'http://127.0.0.1/',
      'http://10.1.2.3/',
      'http://172.16.0.9/',
      'http://192.168.1.1/',
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]/',
      'http://intranet/',
      'ftp://example.com/',
    ])
      expect(publicWebUrl(bad)).toBeNull();
  });

  test('readUrl answers blocked for a private address without fetching', async () => {
    const asked = [];
    const http = {
      async request(u) {
        asked.push(u);
        return new Response('');
      },
    };
    const r = await readUrl('http://169.254.169.254/latest/meta-data', { http });
    expect(r.status).toBe('blocked');
    expect(asked).toEqual([]);
  });
});

describe('a long list is walked a few pages a run', () => {
  test('the cursor advances, the run asks to come back in a minute, and wraps at the end', async () => {
    const pages = [
      'https://a.example/1',
      'https://a.example/2',
      'https://a.example/3',
      'https://a.example/4',
      'https://a.example/5',
    ];
    const http = {
      async request(url) {
        if (url.endsWith('/robots.txt') || url.endsWith('/opensite.json'))
          return new Response('', { status: 404 });
        return new Response(`<html><head><title>${url.split('/').pop()}</title></head></html>`, {
          headers: { 'content-type': 'text/html' },
        });
      },
    };
    const config = { urls: pages, sitemaps: [], pages: 2 };
    const one = await opensite.pull({
      config,
      cursor: {},
      http,
      log: () => {},
      deadline: Date.now() + 10_000,
    });
    expect(one.items.map((i) => i.url)).toEqual(pages.slice(0, 2));
    expect(one.cursor).toEqual({ offset: 2, total: 5 });
    expect(one.nextInMinutes).toBe(1);
    const two = await opensite.pull({
      config,
      cursor: one.cursor,
      http,
      log: () => {},
      deadline: Date.now() + 10_000,
    });
    expect(two.items.map((i) => i.url)).toEqual(pages.slice(2, 4));
    const three = await opensite.pull({
      config,
      cursor: two.cursor,
      http,
      log: () => {},
      deadline: Date.now() + 10_000,
    });
    expect(three.items.map((i) => i.url)).toEqual(pages.slice(4));
    expect(three.cursor).toEqual({ offset: 0, total: 5 });
    expect(three.nextInMinutes).toBeUndefined();
    expect(three.note).toContain('1 of 5 pages');
  });
});
