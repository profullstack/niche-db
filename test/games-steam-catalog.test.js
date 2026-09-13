import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

import {
  ATTRIBUTION,
  appItem,
  appType,
  parsePage,
  queryStart,
  queryUrl,
  REQUEST_CAP,
  resumeStart,
  steamCatalog,
  steamDate,
  tagListUrl,
  tagMap,
  USER_AGENT,
} from '../packages/adapters/src/steam-catalog.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

const fixture = async (name) =>
  JSON.parse(
    await readFile(new URL(`../packages/adapters/test/fixtures/${name}`, import.meta.url), 'utf8'),
  );

const page0 = await fixture('steam-catalog-page0.json');
const page1 = await fixture('steam-catalog-page1.json');
const last = await fixture('steam-catalog-end.json');
const tagList = await fixture('steam-catalog-tags.json');
const tagNames = tagMap(tagList);

const row = (appid) => page0.response.store_items.find((r) => r.appid === appid);

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A page fixture with its metadata set to a catalogue small enough to walk. */
const TOTAL = 1001;
const page = (fx, start) => ({
  response: {
    metadata: { total_matching_records: TOTAL, start, count: fx.response.metadata.count },
    store_items: fx.response.store_items,
  },
});

/**
 * A fake storefront: page0 at 0, page1 at 500, a one-row page at 1000, so a
 * pass is 1001 apps in three pages. `fail` says which starts answer 500;
 * `tagsDown` takes the tag list away.
 */
function provider({ fail = () => false, tagsDown = false } = {}) {
  const urls = [];
  const headers = [];
  const http = {
    async request(url, opts) {
      urls.push(url);
      headers.push(opts?.headers ?? {});
      if (url === tagListUrl()) return tagsDown ? json({}, 503) : json(tagList);
      const start = queryStart(url);
      if (fail(start)) return json({ error: 'nope' }, 500);
      if (start === 0) return json(page(page0, 0));
      if (start === 500) return json(page(page1, 500));
      if (start === 1000) return json(page(last, 1000));
      return json({ response: { metadata: { total_matching_records: TOTAL, start, count: 0 } } });
    },
    async json(url) {
      throw new Error(`500 from ${url}`);
    },
  };
  return { http, urls, headers };
}

const run = (overrides = {}, cursor = {}, p = provider()) =>
  steamCatalog.pull({
    config: { requestCap: REQUEST_CAP, pauseMs: 0, ...overrides },
    cursor,
    env: {},
    http: p.http,
    log: () => {},
    deadline: Number.POSITIVE_INFINITY,
  });

describe('appItem', () => {
  test('one store row becomes one game item in the shape of the store lists', () => {
    const item = normaliseItem(appItem(row(2494780), tagNames));
    expect(item.externalId).toBe('steam:app:2494780');
    expect(item.kind).toBe('game');
    expect(item.title).toBe('#DRIVE Rally');
    expect(item.summary).toMatch(/rally/i);
    expect(item.url).toBe('https://store.steampowered.com/app/2494780');
    expect(item.imageUrl).toBe(
      'https://cdn.cloudflare.steamstatic.com/steam/apps/2494780/header.jpg',
    );
    expect(item.publishedAt.toISOString()).toBe('2025-04-16T14:22:03.000Z');
    expect(item.tags).toEqual(
      expect.arrayContaining([
        'game',
        'steam',
        'type:game',
        'platform:windows',
        'platform:mac',
        'platform:linux',
        'tag:racing',
      ]),
    );
    expect(item.data.steamAppId).toBe(2494780);
    expect(item.data.appid).toBe(2494780);
    expect(item.data.type).toBe('game');
    expect(item.data.releaseDate).toBe('2025-04-16');
    expect(item.data.platforms).toEqual(['windows', 'mac', 'linux']);
    expect(item.data.tags).toContain('Racing');
    expect(item.data.reviewScore).toBe(8);
    expect(item.data.reviewScoreLabel).toBe('Very Positive');
    expect(item.data.reviewPercentPositive).toBe(80);
    expect(item.data.reviewCount).toBe(740);
    expect(item.data.isFree).toBe(false);
    expect(item.data.developers).toEqual(['Pixel Perfect Dude']);
    expect(item.data.publishers).toEqual(['Pixel Perfect Dude']);
    expect(item.data.attribution).toBe(ATTRIBUTION);
  });

  test('types come through as tags: demo, dlc, software, music', () => {
    expect(appItem(row(2639110), tagNames).tags).toContain('type:demo');
    expect(appItem(row(3787220), tagNames).tags).toContain('type:dlc');
    expect(appItem(row(3478810), tagNames).tags).toContain('type:software');
    expect(appItem(row(4272590), tagNames).tags).toContain('type:music');
    expect(appType(7)).toBe('video');
    expect(appType(10)).toBe('hardware');
    expect(appType(99)).toBe('type-99');
    expect(appType('x')).toBe('unknown');
  });

  test('a coming-soon app has no date, an early-access one is tagged, a free one is free', () => {
    const soon = appItem(row(3582290), tagNames);
    expect(soon.publishedAt).toBeNull();
    expect(soon.tags).toContain('coming-soon');
    expect(soon.data.comingSoon).toBe(true);
    expect(soon.data.reviewPercentPositive).toBeNull();
    const early = appItem(row(2556940), tagNames);
    expect(early.tags).toContain('early-access');
    expect(early.data.price).toBe(14.99);
    const free = appItem(row(3478810), tagNames);
    expect(free.tags).toContain('free');
    expect(free.data.price).toBe(0);
  });

  test('a row with no name is skipped, not thrown', () => {
    expect(row(317160).name).toBe('');
    expect(appItem(row(317160), tagNames)).toBeNull();
    expect(appItem(null)).toBeNull();
    expect(appItem({ appid: 'x', name: 'y' })).toBeNull();
  });

  test('without tag names the row keeps its tag ids', () => {
    const item = appItem(row(2494780));
    expect(item.tags.filter((t) => t.startsWith('tag:'))).toEqual([]);
    expect(item.data.tagIds).toEqual([699, 1644, 1773, 701, 1100687]);
  });
});

describe('pages', () => {
  test('the query url carries the start and the page size', () => {
    const url = queryUrl(1500);
    expect(
      url.startsWith('https://api.steampowered.com/IStoreQueryService/Query/v1?input_json='),
    ).toBe(true);
    const body = JSON.parse(new URL(url).searchParams.get('input_json'));
    expect(body.query.start).toBe(1500);
    expect(body.query.count).toBe(500);
    expect(body.query.filters.type_filters.include_dlc).toBe(true);
    expect(queryStart(url)).toBe(1500);
    expect(queryStart('https://example.com/')).toBeNull();
  });

  test('a page parses to total, start, count and rows; a short last page and junk', () => {
    expect(parsePage(page0)).toMatchObject({ total: 298905, start: 0, count: 500 });
    expect(parsePage(page0).rows).toHaveLength(8);
    expect(parsePage(last)).toMatchObject({ total: 298906, start: 298905, count: 1 });
    expect(parsePage({})).toBeNull();
    expect(parsePage({ response: { metadata: {} } })).toBeNull();
    expect(parsePage({ response: { metadata: { total_matching_records: 5, start: 5 } } })).toEqual({
      total: 5,
      start: 5,
      count: 0,
      rows: [],
    });
  });

  test('the tag list is tagid to name; a steam epoch is a date', () => {
    expect(tagNames.get(699)).toBe('Racing');
    expect(tagMap(null).size).toBe(0);
    expect(steamDate(1744813323).toISOString()).toBe('2025-04-16T14:22:03.000Z');
    expect(steamDate(0)).toBeNull();
    expect(steamDate('x')).toBeNull();
  });

  test('resume defaults and the start-over rule', () => {
    expect(resumeStart({})).toBe(0);
    expect(resumeStart({ start: -3 })).toBe(0);
    expect(resumeStart({ start: 500, total: 1000 })).toBe(500);
    expect(resumeStart({ start: 1200, total: 1000 })).toBe(0);
    expect(resumeStart({ start: 1200 })).toBe(1200);
  });
});

describe('the walk', () => {
  test('walks page by page to the total and marks the pass done', async () => {
    const p = provider();
    const out = await run({}, {}, p);
    // page0 has 8 rows, one unnamed; page1 4; the last page 1
    expect(out.items).toHaveLength(12);
    expect(out.items[0].externalId).toBe('steam:app:2556940');
    expect(out.cursor).toMatchObject({ start: 0, total: TOTAL });
    expect(out.cursor.walkedAt).toMatch(/^\d{4}-/);
    expect(out.nextInMinutes).toBeUndefined();
    expect(out.note).toContain('12 apps from 3 pages');
    expect(out.note).toContain('1 unnamed skipped');
    expect(out.note).toContain('catalogue is walked');
    expect(p.urls).toHaveLength(4);
    expect(p.urls[0]).toBe(tagListUrl());
    for (const h of p.headers) expect(h['user-agent']).toBe(USER_AGENT);
  });

  test('stops at the request cap and resumes from the cursor', async () => {
    const p = provider();
    const first = await run({ requestCap: 1 }, {}, p);
    expect(first.items).toHaveLength(7);
    expect(first.cursor).toMatchObject({ start: 500, total: TOTAL, walkedAt: null });
    expect(first.nextInMinutes).toBe(10);
    expect(first.note).toContain('stopped at the request cap at 500');
    expect(JSON.parse(JSON.stringify(first.cursor))).toEqual(first.cursor);

    const second = await run({ requestCap: 5 }, first.cursor, p);
    expect(second.items.map((i) => i.data.steamAppId)).toEqual([
      3911820, 4504090, 3766210, 4045630, 2639280,
    ]);
    expect(second.cursor.start).toBe(0);
    expect(second.cursor.walkedAt).toMatch(/^\d{4}-/);
    expect(p.urls.filter((u) => u === tagListUrl())).toHaveLength(2);
    expect(p.urls).toHaveLength(5);

    const third = await run({ requestCap: 1 }, second.cursor, p);
    expect(queryStart(p.urls.at(-1))).toBe(0);
    expect(third.cursor.start).toBe(500);
  });

  test('repeated failures stop the run without losing the place, and a dead storefront throws', async () => {
    const p = provider({ fail: (start) => start === 500 });
    const out = await run({ requestCap: 100 }, {}, p);
    expect(out.items).toHaveLength(7);
    expect(out.cursor.start).toBe(500);
    expect(out.nextInMinutes).toBe(10);
    expect(out.note).toContain('3 failed');
    expect(out.note).toContain('after repeated failures');
    expect(p.urls).toHaveLength(5);

    const dead = provider({ fail: () => true, tagsDown: true });
    await expect(run({ requestCap: 5 }, {}, dead)).rejects.toThrow(/every request failed/);
  });

  test('a missing tag list costs the tag names, not the run', async () => {
    const p = provider({ tagsDown: true });
    const out = await run({ requestCap: 1 }, {}, p);
    expect(out.items).toHaveLength(7);
    expect(out.items.every((i) => !i.tags.some((t) => t.startsWith('tag:')))).toBe(true);
    expect(out.items[0].data.tagIds.length).toBeGreaterThan(0);
    expect(out.note).toContain('1 failed');
  });
});
