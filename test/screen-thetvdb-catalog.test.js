import { describe, expect, test } from 'bun:test';

import {
  ATTRIBUTION,
  ATTRIBUTION_URL,
  imageUrl,
  lastPage,
  PAGES_PER_RUN,
  pageItems,
  REFRESH_PER_RUN,
  redact,
  resumeFrom,
  summaryOf,
  thetvdbCatalog,
  titleItem,
  tokenExpiry,
  updatedIds,
} from '../packages/adapters/src/thetvdb-catalog.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

const fixture = (name) =>
  JSON.parse(
    require('node:fs').readFileSync(
      new URL(`../packages/adapters/test/fixtures/thetvdb-${name}.json`, import.meta.url),
      'utf8',
    ),
  );

const LOGIN = fixture('login');
const PAGE0 = fixture('series-page-0');
const PAGE1 = fixture('series-page-1');
const PAGE_END = fixture('series-page-end');
const SERIES = fixture('series-70327');
const EXTENDED = fixture('series-70327-extended');
const UPDATES0 = fixture('updates-page-0');
const UPDATES_END = fixture('updates-page-end');
const UNAUTHORIZED = fixture('unauthorized');

const KEY = 'test-api-key-0123456789abcdef';
const TOKEN = LOGIN.data.token;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * A fake TheTVDB keyed on URL: login, two series pages then the empty end,
 * one updates page then the empty end, and extended series rows. `failing`
 * is a predicate on the path for requests that should answer 500.
 */
function provider({ failing = () => false, staleToken = null } = {}) {
  const calls = [];
  const http = {
    async request(url, opts = {}) {
      const u = new URL(url);
      calls.push({
        url,
        method: opts.method ?? 'GET',
        auth: opts.headers?.authorization ?? null,
        body: opts.body,
      });
      if (u.pathname === '/v4/login') {
        const body = JSON.parse(opts.body ?? '{}');
        if (opts.method !== 'POST' || body.apikey !== KEY)
          return json({ message: 'Unauthorized' }, 401);
        return json(LOGIN);
      }
      const auth = opts.headers?.authorization;
      if (auth !== `Bearer ${TOKEN}` && !(staleToken && auth === `Bearer ${staleToken}`))
        return json(UNAUTHORIZED, 401);
      if (staleToken && auth === `Bearer ${staleToken}`) return json(UNAUTHORIZED, 401);
      if (failing(u.pathname + u.search)) return json({ message: 'boom' }, 500);
      if (u.pathname === '/v4/series') {
        const page = Number(u.searchParams.get('page'));
        if (page === 0) return json(PAGE0);
        if (page === 1) return json(PAGE1);
        return json(PAGE_END);
      }
      if (u.pathname === '/v4/updates') {
        const page = Number(u.searchParams.get('page'));
        return json(page === 0 ? UPDATES0 : UPDATES_END);
      }
      const m = u.pathname.match(/^\/v4\/series\/(\d+)\/extended$/);
      if (m) {
        const id = Number(m[1]);
        if (id === 462009 || id === 999) return json({ message: 'not found' }, 404);
        return json({
          ...EXTENDED,
          data: { ...EXTENDED.data, id, name: `Series ${id}`, slug: `series-${id}` },
        });
      }
      return json({ message: 'not found' }, 404);
    },
    async json(url) {
      throw new Error(`json() not expected for ${url}`);
    },
  };
  return { http, calls };
}

const run = (config, cursor, p, env = { thetvdbApiKey: KEY }) =>
  thetvdbCatalog.pull({
    config: { pagesPerRun: PAGES_PER_RUN, refreshPerRun: REFRESH_PER_RUN, pauseMs: 0, ...config },
    cursor,
    env,
    http: p.http,
    log: (msg) => p.logs?.push(msg),
    deadline: Number.POSITIVE_INFINITY,
  });

const FRESH = { token: TOKEN, tokenExpires: Date.now() + 20 * 86_400_000 };

describe('rows', () => {
  test('a list row becomes a title item in the screen shape, with attribution on every row', () => {
    const items = pageItems(PAGE0).map(normaliseItem);
    expect(items).toHaveLength(4);
    const buffy = items[0];
    expect(buffy.externalId).toBe('thetvdb:series:70327');
    expect(buffy.kind).toBe('title');
    expect(buffy.title).toBe('Buffy the Vampire Slayer');
    expect(buffy.url).toBe('https://thetvdb.com/series/buffy-the-vampire-slayer');
    expect(buffy.imageUrl).toBe('https://artworks.thetvdb.com/banners/posters/70327-1.jpg');
    expect(buffy.publishedAt.toISOString()).toBe('1997-03-10T12:00:00.000Z');
    expect(buffy.precision).toBe('day');
    expect(buffy.tags).toEqual(['title', 'tv', 'thetvdb', 'country:usa', 'lang:eng']);
    expect(buffy.summary.length).toBeLessThanOrEqual(600);
    expect(buffy.summary).toContain('In every generation there is a Chosen One.');
    expect(buffy.summary).not.toContain('\r');
    expect(buffy.data).toMatchObject({
      provider: 'thetvdb',
      category: 'tv',
      form: 'series',
      thetvdbId: '70327',
      slug: 'buffy-the-vampire-slayer',
      year: 1997,
      normTitle: 'buffy the vampire slayer',
      originalCountry: 'usa',
      originalLanguage: 'eng',
      status: null,
      firstAired: '1997-03-10',
      lastAired: '2003-05-20',
      nextAired: null,
      score: 517993,
      averageRuntime: 44,
      aliases: ['Buffy - Im Bann der Dämonen', 'Buffy, cazavampiros'],
      genres: [],
      imdbId: null,
      attribution: ATTRIBUTION,
      attributionUrl: ATTRIBUTION_URL,
    });
    expect(ATTRIBUTION).toBe('Metadata provided by TheTVDB.com');
    expect(ATTRIBUTION_URL).toBe('https://thetvdb.com');
    // a row with no poster and no overview still lands
    const bare = items.find((i) => i.externalId === 'thetvdb:series:70333');
    expect(bare.imageUrl).toBeNull();
    expect(bare.summary).toBeNull();
    expect(pageItems({ data: 'nope' })).toEqual([]);
    expect(pageItems(null)).toEqual([]);
  });

  test('an extended row adds status, genres, network and the IMDb and TMDB ids', () => {
    const item = normaliseItem(titleItem(EXTENDED.data));
    expect(item.tags).toEqual([
      'title',
      'tv',
      'thetvdb',
      'status:ended',
      'country:usa',
      'lang:eng',
      'genre:horror',
      'genre:fantasy',
      'genre:drama',
      'genre:comedy',
      'genre:adventure',
      'genre:action',
      'genre:romance',
    ]);
    expect(item.imageUrl).toBe('https://artworks.thetvdb.com/banners/posters/70327-1.jpg');
    expect(item.data).toMatchObject({
      status: 'Ended',
      genres: ['Horror', 'Fantasy', 'Drama', 'Comedy', 'Adventure', 'Action', 'Romance'],
      network: 'The WB',
      companies: ['The WB', 'UPN'],
      imdbId: 'tt0118276',
      tmdbId: '95',
    });
    // the base record (no genres) is the same row with less on it
    const base = normaliseItem(titleItem(SERIES.data));
    expect(base.externalId).toBe(item.externalId);
    expect(base.data.status).toBe('Ended');
    expect(base.data.genres).toEqual([]);
  });

  test('a series whose genres include Anime is filed under anime', () => {
    const row = {
      ...EXTENDED.data,
      genres: [
        { id: 1, name: 'Anime' },
        { id: 12, name: 'Drama' },
      ],
    };
    const item = titleItem(row);
    expect(item.data.category).toBe('anime');
    expect(item.tags.slice(0, 3)).toEqual(['title', 'anime', 'thetvdb']);
    expect(titleItem({ id: 5 })).toBeNull();
    expect(titleItem(null)).toBeNull();
  });

  test('helpers: image, summary, page end, token expiry, redaction', () => {
    expect(imageUrl('/banners/x.jpg')).toBe('https://artworks.thetvdb.com/banners/x.jpg');
    expect(imageUrl('banners/x.jpg')).toBe('https://artworks.thetvdb.com/banners/x.jpg');
    expect(imageUrl('https://artworks.thetvdb.com/banners/x.jpg')).toBe(
      'https://artworks.thetvdb.com/banners/x.jpg',
    );
    expect(imageUrl('')).toBeNull();
    expect(imageUrl(null)).toBeNull();
    expect(summaryOf('  a \r\n\r\n b  ')).toBe('a b');
    expect(summaryOf('x'.repeat(700)).length).toBe(600);
    expect(summaryOf('')).toBeNull();
    expect(lastPage(PAGE0)).toBe(false);
    expect(lastPage(PAGE_END)).toBe(true);
    expect(lastPage({ data: [{ id: 1 }], links: { next: null } })).toBe(true);
    expect(tokenExpiry(TOKEN)).toBe(1791915321000);
    const t0 = 1_000_000;
    expect(tokenExpiry('not-a-jwt', t0)).toBe(t0 + 29 * 86_400_000);
    expect(redact(`401 from https://x/?k=${KEY} with ${TOKEN}`, KEY, TOKEN)).toBe(
      '401 from https://x/?k=[secret] with [secret]',
    );
    expect(redact('short', 'abc')).toBe('short');
  });

  test('updated ids: created and updated, deduplicated, ascending, deletes dropped, last time kept', () => {
    const { ids, lastTs, next } = updatedIds(UPDATES0);
    expect(ids).toEqual([343443, 447187, 448246, 478360, 482422, 482423]);
    expect(ids).not.toContain(462009);
    expect(lastTs).toBe(1789219816);
    expect(next).toContain('page=1');
    expect(updatedIds(UPDATES_END)).toEqual({ ids: [], lastTs: 0, next: null });
    expect(updatedIds(null)).toEqual({ ids: [], lastTs: 0, next: null });
  });

  test('resume defaults', () => {
    expect(resumeFrom({})).toMatchObject({
      page: 0,
      walkedAt: null,
      pending: [],
      token: null,
      tokenExpires: 0,
    });
    expect(resumeFrom({ page: 7, token: 't', tokenExpires: 5 })).toMatchObject({
      page: 7,
      token: 't',
      tokenExpires: 5,
    });
    expect(
      resumeFrom({ walkedAt: '2026-09-13T00:00:00.000Z', pending: [2, 'x', 1, 2, -1] }),
    ).toMatchObject({ walkedAt: '2026-09-13T00:00:00.000Z', pending: [2, 1] });
  });
});

describe('the first pass', () => {
  test('logs in, walks page by page to the empty page and marks the pass done', async () => {
    const p = provider();
    const out = await run({}, {}, p);
    expect(out.items.map((i) => i.externalId)).toEqual([
      'thetvdb:series:70327',
      'thetvdb:series:70328',
      'thetvdb:series:70333',
      'thetvdb:series:70330',
      'thetvdb:series:70909',
      'thetvdb:series:70910',
    ]);
    expect(out.cursor.page).toBeNull();
    expect(out.cursor.walkedAt).toMatch(/^\d{4}-/);
    expect(out.cursor.token).toBe(TOKEN);
    expect(out.cursor.tokenExpires).toBe(1791915321000);
    expect(out.nextInMinutes).toBeUndefined();
    expect(out.note).toContain('catalogue is walked');
    expect(p.calls.map((c) => c.method)).toEqual(['POST', 'GET', 'GET', 'GET']);
    expect(p.calls[0].url).toBe('https://api4.thetvdb.com/v4/login');
    expect(p.calls[1].auth).toBe(`Bearer ${TOKEN}`);
    expect(p.calls[3].url).toContain('/v4/series?page=2');
  });

  test('reuses a fresh token from the cursor without logging in', async () => {
    const p = provider();
    const out = await run({}, FRESH, p);
    expect(p.calls.every((c) => c.method === 'GET')).toBe(true);
    expect(out.cursor.token).toBe(TOKEN);
  });

  test('renews a token within a day of its expiry before asking anything', async () => {
    const p = provider();
    await run({}, { token: 'nearly-dead', tokenExpires: Date.now() + 3_600_000 }, p);
    expect(p.calls[0].method).toBe('POST');
    expect(p.calls[1].auth).toBe(`Bearer ${TOKEN}`);
  });

  test('a 401 triggers one re-login and a retry of the same request', async () => {
    const p = provider({ staleToken: 'stale-token-value' });
    const out = await run(
      { pagesPerRun: 1 },
      { token: 'stale-token-value', tokenExpires: Date.now() + 20 * 86_400_000 },
      p,
    );
    expect(p.calls.map((c) => c.method)).toEqual(['GET', 'POST', 'GET']);
    expect(p.calls[0].auth).toBe('Bearer stale-token-value');
    expect(p.calls[2].auth).toBe(`Bearer ${TOKEN}`);
    expect(p.calls[2].url).toBe(p.calls[0].url);
    expect(out.items).toHaveLength(4);
    expect(out.cursor.token).toBe(TOKEN);
  });

  test('stops at the page cap and resumes from the cursor', async () => {
    const p = provider();
    const first = await run({ pagesPerRun: 1 }, {}, p);
    expect(first.items).toHaveLength(4);
    expect(first.cursor).toMatchObject({ page: 1, walkedAt: null, token: TOKEN });
    expect(first.nextInMinutes).toBe(10);
    expect(first.note).toContain('at the cap');
    const second = await run({ pagesPerRun: 5 }, first.cursor, p);
    expect(second.items.map((i) => i.externalId)).toEqual([
      'thetvdb:series:70909',
      'thetvdb:series:70910',
    ]);
    expect(second.cursor.walkedAt).toMatch(/^\d{4}-/);
    expect(p.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  test('three failures in a row stop the run and keep what was read', async () => {
    const p = provider({ failing: (path) => /page=[1-9]/.test(path) });
    p.logs = [];
    const out = await run({}, FRESH, p);
    expect(out.items).toHaveLength(4);
    expect(out.cursor).toMatchObject({ page: 1, walkedAt: null });
    expect(out.note).toContain('after repeated failures');
    expect(out.note).toContain('3 failed');
    expect(p.calls).toHaveLength(4);
    expect(p.logs).toHaveLength(3);
  });

  test('every request failing throws, and the key never appears in the error or the log', async () => {
    const p = provider({ failing: () => true });
    p.logs = [];
    await expect(run({}, FRESH, p)).rejects.toThrow(/every request failed \(3\)/);
    const text = [...p.logs].join('\n');
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(TOKEN);
  });

  test('a refused login says so without the key', async () => {
    const p = provider();
    await expect(run({}, {}, p, { thetvdbApiKey: 'wrong-key-0123456789' })).rejects.toThrow(
      /login refused \(401\)/,
    );
    await expect(run({}, {}, p, {})).rejects.toThrow(/THETVDB_API_KEY is not set/);
    try {
      await run({}, {}, p, { thetvdbApiKey: 'wrong-key-0123456789' });
    } catch (err) {
      expect(err.message).not.toContain('wrong-key-0123456789');
    }
  });
});

describe('the delta path', () => {
  const walked = {
    ...FRESH,
    page: null,
    walkedAt: '2026-09-13T00:00:00.000Z',
    refreshedAt: new Date(1_789_200_923 * 1000).toISOString(),
    pending: [],
  };

  test('lists the changes since the last refresh, fetches each once, tolerates a 404', async () => {
    const p = provider();
    const out = await run({}, walked, p);
    expect(p.calls[0].url).toBe(
      'https://api4.thetvdb.com/v4/updates?since=1789200923&type=series&page=0',
    );
    expect(p.calls[1].url).toContain('/v4/updates?since=1789200923&type=series&page=1');
    expect(p.calls.slice(2).map((c) => c.url)).toEqual([
      'https://api4.thetvdb.com/v4/series/343443/extended?short=true',
      'https://api4.thetvdb.com/v4/series/447187/extended?short=true',
      'https://api4.thetvdb.com/v4/series/448246/extended?short=true',
      'https://api4.thetvdb.com/v4/series/478360/extended?short=true',
      'https://api4.thetvdb.com/v4/series/482422/extended?short=true',
      'https://api4.thetvdb.com/v4/series/482423/extended?short=true',
    ]);
    expect(out.items.map((i) => i.externalId)).toEqual([
      'thetvdb:series:343443',
      'thetvdb:series:447187',
      'thetvdb:series:448246',
      'thetvdb:series:478360',
      'thetvdb:series:482422',
      'thetvdb:series:482423',
    ]);
    expect(out.items[0].data.imdbId).toBe('tt0118276');
    expect(out.items[0].data.status).toBe('Ended');
    expect(out.cursor.pending).toEqual([]);
    expect(out.cursor.refreshedAt > walked.refreshedAt).toBe(true);
    expect(out.cursor.listedAt).toBeNull();
    expect(out.nextInMinutes).toBeUndefined();
    expect(out.note).toContain('caught up');
  });

  test('caps the fetches and carries the rest as pending, without listing again', async () => {
    const p = provider();
    const first = await run({ refreshPerRun: 2 }, walked, p);
    expect(first.items).toHaveLength(2);
    expect(first.cursor.pending).toEqual([448246, 478360, 482422, 482423]);
    expect(first.cursor.refreshedAt).toBe(walked.refreshedAt);
    expect(first.cursor.listedAt).toMatch(/^\d{4}-/);
    expect(first.nextInMinutes).toBe(10);
    const second = await run({ refreshPerRun: 10 }, first.cursor, p);
    expect(second.items).toHaveLength(4);
    expect(second.cursor.pending).toEqual([]);
    expect(second.cursor.refreshedAt).toBe(first.cursor.listedAt);
    expect(p.calls.filter((c) => c.url.includes('/v4/updates'))).toHaveLength(2);
  });

  test('a 404 on a pending series is skipped, and a failed listing throws', async () => {
    const p = provider();
    const out = await run({}, { ...walked, pending: [999, 343443] }, p);
    expect(out.items.map((i) => i.externalId)).toEqual(['thetvdb:series:343443']);
    expect(out.cursor.pending).toEqual([]);
    const q = provider({ failing: (path) => path.startsWith('/v4/updates') });
    await expect(run({}, walked, q)).rejects.toThrow(/could not list updates/);
  });
});
