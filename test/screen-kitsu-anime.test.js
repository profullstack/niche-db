import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

import {
  ATTRIBUTION,
  animeItem,
  formOf,
  kitsuAnime,
  PAGE_LIMIT,
  pageItems,
  pageRows,
  pageUrl,
  REQUEST_CAP,
  ratingSlug,
  resumeFrom,
  subtypeOf,
  summaryOf,
  titleOf,
  totalOf,
  USER_AGENT,
} from '../packages/adapters/src/kitsu-anime.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

const fixture = async (name) =>
  JSON.parse(
    await readFile(new URL(`../packages/adapters/test/fixtures/${name}`, import.meta.url), 'utf8'),
  );

/* Saved from kitsu.io/api/edge/anime on 2026-09-13, trimmed to a few rows each. */
const page0 = await fixture('kitsu-anime-page-0.json');
const page1 = await fixture('kitsu-anime-page-1.json');
const pageLast = await fixture('kitsu-anime-page-last.json');
const pageEmpty = await fixture('kitsu-anime-page-empty.json');

const bebop = page0.data[0];

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * A fake Kitsu: the three saved pages at offsets 0, 20 and 40, an empty page
 * past that, `meta.count` rewritten to the fake's total and `links.next`
 * dropped on the last page, as the live API does.
 */
function provider({ fail = () => false, total = 40 + pageLast.data.length } = {}) {
  const urls = [];
  const headers = [];
  const pages = new Map([
    [0, page0],
    [20, page1],
    [40, pageLast],
  ]);
  const http = {
    async request(url, opts = {}) {
      urls.push(url);
      headers.push(opts.headers ?? {});
      const offset = Number(new URL(url).searchParams.get('page[offset]'));
      if (fail(offset, urls.length)) return json({ errors: [{ status: '500' }] }, 500);
      const page = pages.get(offset) ?? pageEmpty;
      const links = { ...page.links };
      if (offset + PAGE_LIMIT >= total) delete links.next;
      return json({ data: page.data, meta: { count: total }, links });
    },
    async json(url) {
      throw new Error(`500 from ${url}`);
    },
  };
  return { http, urls, headers };
}

const run = (overrides = {}, cursor = {}, p = provider()) =>
  kitsuAnime.pull({
    config: { requestCap: REQUEST_CAP, pauseMs: 0, ...overrides },
    cursor,
    env: {},
    http: p.http,
    log: () => {},
    deadline: Number.POSITIVE_INFINITY,
  });

describe('animeItem', () => {
  test('one anime row becomes one title item in the anime shape', () => {
    const item = normaliseItem(animeItem(bebop));
    expect(item.externalId).toBe('kitsu:anime:1');
    expect(item.kind).toBe('title');
    expect(item.title).toBe('Cowboy Bebop');
    expect(item.url).toBe('https://kitsu.io/anime/cowboy-bebop');
    expect(item.imageUrl).toBe('https://media.kitsu.app/anime/poster_images/1/original.jpg');
    expect(item.publishedAt.toISOString()).toBe('1998-04-03T12:00:00.000Z');
    expect(item.timeKnown).toBe(false);
    expect(item.precision).toBe('day');
    expect(item.summary.length).toBeLessThanOrEqual(600);
    expect(item.summary).toMatch(/^In the year 2071/);
    expect(item.tags).toEqual(['title', 'anime', 'kitsu', 'subtype:tv', 'rating:r']);
    expect(item.data).toMatchObject({
      provider: 'kitsu',
      category: 'anime',
      form: 'series',
      year: 1998,
      normTitle: 'cowboy bebop',
      anilistId: null,
      kitsuId: '1',
      slug: 'cowboy-bebop',
      subtype: 'tv',
      episodeCount: 26,
      episodeLength: 25,
      status: 'finished',
      startDate: '1998-04-03',
      endDate: '1999-04-24',
      ageRating: 'R',
      ageRatingGuide: '17+ (violence & profanity)',
      averageRating: 82.27,
      userCount: 162298,
      favoritesCount: 5167,
      popularityRank: 44,
      ratingRank: 197,
      youtubeVideoId: 'qig4KOK2R2g',
      nsfw: false,
      attribution: ATTRIBUTION,
    });
    expect(item.data.titles).toEqual({
      en: 'Cowboy Bebop',
      en_jp: 'Cowboy Bebop',
      ja_jp: 'カウボーイビバップ',
    });
    expect(item.data.synopsis.length).toBeGreaterThan(600);
    expect(item.data.rating).toBeCloseTo(8.227);
  });

  test('a film is form movie, an OVA and a music video keep their subtype', () => {
    const movie = animeItem(page0.data[1]);
    expect(movie.externalId).toBe('kitsu:anime:2');
    expect(movie.data.form).toBe('movie');
    expect(movie.tags).toContain('subtype:movie');
    const ova = animeItem(page1.data[2]);
    expect(ova.data.subtype).toBe('ova');
    expect(ova.data.form).toBe('series');
    const music = animeItem(pageLast.data[0]);
    expect(music.tags).toContain('subtype:music');
    expect(music.tags).toContain('rating:g');
    expect(music.data.averageRating).toBeNull();
    expect(music.data.rating).toBeNull();
    expect(formOf(null)).toBe('series');
    expect(subtypeOf({ subtype: 'TV' })).toBe('tv');
    expect(subtypeOf({ subtype: 'hologram' })).toBeNull();
    expect(ratingSlug('R18')).toBe('r18');
    expect(ratingSlug(null)).toBeNull();
  });

  test('the title falls back from canonical to English to romanised Japanese', () => {
    const eyeshield = page0.data[3];
    expect(eyeshield.attributes.titles.en).toBeUndefined();
    expect(titleOf(eyeshield.attributes)).toBe('Eyeshield 21');
    expect(titleOf({ titles: { en: 'Trigun', en_jp: 'Torigan' } })).toBe('Trigun');
    expect(titleOf({ titles: { en_jp: 'Torigan', ja_jp: 'トライガン' } })).toBe('Torigan');
    expect(titleOf({ titles: { ja_jp: 'トライガン' } })).toBe('トライガン');
    expect(titleOf({ titles: {} })).toBeNull();
    expect(titleOf(null)).toBeNull();
  });

  test('a synopsis is collapsed and cut to 600, and the url falls back to the id', () => {
    expect(summaryOf('a\n\nb  c .')).toBe('a b c.');
    expect(summaryOf(null)).toBeNull();
    expect(summaryOf('x'.repeat(700)).length).toBe(600);
    const noSlug = animeItem({ id: '7', attributes: { canonicalTitle: 'Seven', slug: null } });
    expect(noSlug.url).toBe('https://kitsu.io/anime/7');
    expect(noSlug.imageUrl).toBeNull();
    expect(noSlug.publishedAt).toBeNull();
    expect(noSlug.tags).toEqual(['title', 'anime', 'kitsu']);
  });

  test('a row with no id or no title is skipped, never thrown on', () => {
    expect(animeItem(null)).toBeNull();
    expect(animeItem({ id: '9' })).toBeNull();
    expect(animeItem({ id: '9', attributes: { titles: {} } })).toBeNull();
    expect(animeItem({ attributes: { canonicalTitle: 'No id' } })).toBeNull();
    const items = pageItems({ data: [{ id: '9' }, bebop, null] });
    expect(items.map((i) => i.externalId)).toEqual(['kitsu:anime:1']);
    expect(pageRows({ data: 'nope' })).toEqual([]);
    expect(pageRows(null)).toEqual([]);
  });

  test('page urls, totals and resume state', () => {
    expect(pageUrl(40)).toBe(
      'https://kitsu.io/api/edge/anime?page%5Blimit%5D=20&page%5Boffset%5D=40&sort=id',
    );
    expect(new URL(pageUrl(40)).searchParams.get('page[offset]')).toBe('40');
    expect(totalOf(page0)).toBe(22418);
    expect(totalOf(pageEmpty)).toBe(22418);
    expect(totalOf({})).toBeNull();
    expect(resumeFrom({})).toEqual({ offset: 0, total: null });
    expect(resumeFrom({ offset: null, total: 22418 })).toEqual({ offset: 0, total: null });
    expect(resumeFrom({ offset: 3000, total: 22418 })).toEqual({ offset: 3000, total: 22418 });
    expect(resumeFrom({ offset: 'x' })).toEqual({ offset: 0, total: null });
    expect(resumeFrom({ offset: -5 })).toEqual({ offset: 0, total: null });
  });
});

describe('the walk', () => {
  test('walks page by page to the end and marks the pass done', async () => {
    const p = provider();
    const out = await run({}, {}, p);
    expect(out.items.map((i) => i.externalId)).toEqual([
      'kitsu:anime:1',
      'kitsu:anime:2',
      'kitsu:anime:3',
      'kitsu:anime:6',
      'kitsu:anime:21',
      'kitsu:anime:22',
      'kitsu:anime:26',
      'kitsu:anime:51036',
      'kitsu:anime:51038',
      'kitsu:anime:51043',
    ]);
    expect(out.cursor.offset).toBeNull();
    expect(out.cursor.total).toBe(43);
    expect(out.cursor.walkedAt).toMatch(/^\d{4}-/);
    expect(out.nextInMinutes).toBeUndefined();
    expect(out.note).toContain('10 anime from 3 pages');
    expect(out.note).toContain('the catalogue is walked');
    expect(p.urls).toHaveLength(3);
    expect(p.urls[0]).toContain('page%5Boffset%5D=0');
    expect(p.urls[2]).toContain('page%5Boffset%5D=40');
    for (const h of p.headers) {
      expect(h['user-agent']).toBe(USER_AGENT);
      expect(h.accept).toBe('application/vnd.api+json');
    }
    expect(JSON.parse(JSON.stringify(out.cursor))).toEqual(out.cursor);
  });

  test('stops at the page cap and resumes from the cursor', async () => {
    const p = provider();
    const first = await run({ requestCap: 1 }, {}, p);
    expect(first.items).toHaveLength(4);
    expect(first.cursor).toMatchObject({ offset: 20, total: 43, walkedAt: null });
    expect(first.nextInMinutes).toBe(10);
    expect(first.note).toContain('stopped at the page cap at offset 20');

    const second = await run({ requestCap: 1 }, first.cursor, p);
    expect(second.items.map((i) => i.externalId)).toEqual([
      'kitsu:anime:21',
      'kitsu:anime:22',
      'kitsu:anime:26',
    ]);
    expect(second.cursor).toMatchObject({ offset: 40, total: 43 });
    expect(second.nextInMinutes).toBe(10);

    const third = await run({ requestCap: 5 }, second.cursor, p);
    expect(third.items).toHaveLength(3);
    expect(third.cursor.offset).toBeNull();
    expect(third.cursor.walkedAt).toMatch(/^\d{4}-/);
    expect(third.nextInMinutes).toBeUndefined();
    expect(p.urls).toHaveLength(3);
  });

  test('a cursor already at the total is a finished pass and costs no request', async () => {
    const p = provider();
    const out = await run({}, { offset: 43, total: 43 }, p);
    expect(out.items).toHaveLength(0);
    expect(out.cursor.offset).toBeNull();
    expect(out.nextInMinutes).toBeUndefined();
    expect(p.urls).toHaveLength(0);
    // and the run after that starts over from 0
    const again = await run({ requestCap: 1 }, out.cursor, p);
    expect(again.items).toHaveLength(4);
    expect(p.urls[0]).toContain('page%5Boffset%5D=0');
  });

  test('an empty page past the end ends the pass without a links.next', async () => {
    const p = provider({ total: 999 });
    const out = await run({}, { offset: 60, total: 999 }, p);
    expect(out.items).toHaveLength(0);
    expect(out.cursor.offset).toBeNull();
    expect(out.note).toContain('0 anime from 1 pages');
    expect(p.urls).toHaveLength(1);
  });

  test('a failed page is asked for again; three in a row stop the run with the place kept', async () => {
    const p = provider({ fail: (offset) => offset === 20 });
    const out = await run({}, {}, p);
    expect(out.items).toHaveLength(4);
    expect(out.cursor).toMatchObject({ offset: 20, total: 43 });
    expect(out.nextInMinutes).toBe(10);
    expect(out.note).toContain('3 failed');
    expect(out.note).toContain('after repeated failures');
    expect(p.urls).toHaveLength(4);
    expect(p.urls.slice(1).every((u) => u.includes('page%5Boffset%5D=20'))).toBe(true);
  });

  test('one failure is retried and the walk completes', async () => {
    const p = provider({ fail: (offset, n) => offset === 20 && n === 2 });
    const out = await run({}, {}, p);
    expect(out.items).toHaveLength(10);
    expect(out.cursor.offset).toBeNull();
    expect(out.note).toContain('1 failed');
    expect(p.urls).toHaveLength(4);
  });

  test('a dead provider throws', async () => {
    const dead = provider({ fail: () => true });
    await expect(run({ requestCap: 5 }, {}, dead)).rejects.toThrow(/every request failed/);
    expect(dead.urls).toHaveLength(3);
  });

  test('the deadline stops the run with the place kept', async () => {
    const p = provider();
    const out = await kitsuAnime.pull({
      config: { requestCap: REQUEST_CAP, pauseMs: 0 },
      cursor: {},
      env: {},
      http: p.http,
      log: () => {},
      deadline: 0,
    });
    expect(out.items).toHaveLength(0);
    expect(out.cursor.offset).toBe(0);
    expect(out.nextInMinutes).toBe(10);
    expect(out.note).toContain('on the run deadline');
  });
});

describe('the adapter', () => {
  test('is a screen title source with the licence position in its description', () => {
    expect(kitsuAnime.name).toBe('kitsu-anime');
    expect(kitsuAnime.collection).toBe('screen');
    expect(kitsuAnime.kinds).toEqual(['title']);
    expect(kitsuAnime.cadenceMinutes).toBe(1440);
    expect(kitsuAnime.description).toContain('no licence stated');
    expect(kitsuAnime.defaultSources[0].slug).toBe('kitsu-anime');
    expect(kitsuAnime.defaults.requestCap).toBe(150);
  });
});
