import { describe, expect, test } from 'bun:test';

import {
  PAGES_PER_RUN,
  pageItems,
  REFRESH_PER_RUN,
  resumeFrom,
  tvmazeCatalog,
  updatedIds,
} from '../packages/adapters/src/tvmaze-catalog.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

const show = (id, name, extra = {}) => ({
  id,
  name,
  url: `https://www.tvmaze.com/shows/${id}/x`,
  genres: ['Drama'],
  premiered: '2013-06-24',
  summary: '<p>A <b>town</b> under a dome.</p>',
  image: { medium: 'https://img/m.jpg', original: 'https://img/o.jpg' },
  network: { name: 'CBS', country: { name: 'United States' } },
  externals: { imdb: 'tt1553656', thetvdb: 264492 },
  rating: { average: 6.5 },
  weight: 90,
  language: 'English',
  status: 'Ended',
  type: 'Scripted',
  ...extra,
});

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Two pages of shows, 404 after; /updates lists two ids; /shows/:id answers. */
function provider(updates = { 1: 1_800_000_000, 2: 1_700_000_000, 999: 1_800_000_500 }) {
  const urls = [];
  const http = {
    async request(url) {
      urls.push(url);
      const u = new URL(url);
      if (u.pathname === '/shows') {
        const page = Number(u.searchParams.get('page'));
        if (page === 0)
          return json([
            show(1, 'Under the Dome'),
            show(2, 'Person of Interest'),
            show(3, 'Sports Hour', { genres: ['Sports'] }),
          ]);
        if (page === 1) return json([show(4, 'Bitten')]);
        return json({ name: 'Not Found' }, 404);
      }
      if (u.pathname === '/updates/shows') return json(updates);
      const m = u.pathname.match(/^\/shows\/(\d+)$/);
      if (m) return Number(m[1]) === 999 ? json({}, 404) : json(show(Number(m[1]), `Show ${m[1]}`));
      return json({}, 404);
    },
    async json(url) {
      throw new Error(`500 from ${url}`);
    },
  };
  return { http, urls };
}

const run = (config, cursor, p) =>
  tvmazeCatalog.pull({
    config: { pagesPerRun: PAGES_PER_RUN, refreshPerRun: REFRESH_PER_RUN, pauseMs: 0, ...config },
    cursor,
    env: {},
    http: p.http,
    log: () => {},
    deadline: Number.POSITIVE_INFINITY,
  });

describe('pages', () => {
  test("a page becomes title items in the schedule source's shape, minus rerouted sports", () => {
    const items = pageItems([
      show(1, 'Under the Dome'),
      show(3, 'Sports Hour', { genres: ['Sports'] }),
    ]).map(normaliseItem);
    expect(items).toHaveLength(1);
    expect(items[0].externalId).toBe('tvmaze:title:1');
    expect(items[0].kind).toBe('title');
    expect(items[0].data.thetvdbId).toBe('264492');
    expect(items[0].data.imdbId).toBe('tt1553656');
    expect(items[0].tags).toContain('genre:drama');
    expect(pageItems({ not: 'a list' })).toEqual([]);
  });

  test('updated ids after a moment, ascending', () => {
    expect(updatedIds({ 5: 100, 3: 300, 9: 200 }, 150)).toEqual([3, 9]);
    expect(updatedIds({ x: 1 }, 0)).toEqual([]);
    expect(updatedIds(null, 0)).toEqual([]);
  });

  test('resume defaults', () => {
    expect(resumeFrom({})).toMatchObject({ page: 0, walkedAt: null, pending: [] });
    expect(resumeFrom({ page: 7 })).toMatchObject({ page: 7, walkedAt: null });
    expect(
      resumeFrom({ walkedAt: '2026-09-13T00:00:00.000Z', pending: [1, 'x', 2] }),
    ).toMatchObject({ walkedAt: '2026-09-13T00:00:00.000Z', pending: [1, 2] });
  });
});

describe('the first pass', () => {
  test('walks page by page to the 404 and marks the pass done', async () => {
    const p = provider();
    const out = await run({}, {}, p);
    expect(out.items.map((i) => i.externalId)).toEqual([
      'tvmaze:title:1',
      'tvmaze:title:2',
      'tvmaze:title:4',
    ]);
    expect(out.cursor.page).toBeNull();
    expect(out.cursor.walkedAt).toMatch(/^\d{4}-/);
    expect(out.nextInMinutes).toBeUndefined();
    expect(out.note).toContain('catalogue is walked');
    expect(p.urls).toHaveLength(3);
  });

  test('stops at the page cap and resumes', async () => {
    const p = provider();
    const first = await run({ pagesPerRun: 1 }, {}, p);
    expect(first.items).toHaveLength(2);
    expect(first.cursor).toMatchObject({ page: 1, walkedAt: null });
    expect(first.nextInMinutes).toBe(10);
    const second = await run({ pagesPerRun: 5 }, first.cursor, p);
    expect(second.items.map((i) => i.externalId)).toEqual(['tvmaze:title:4']);
    expect(second.cursor.walkedAt).toMatch(/^\d{4}-/);
  });
});

describe('the delta path', () => {
  const walked = {
    page: null,
    walkedAt: '2026-09-13T00:00:00.000Z',
    refreshedAt: new Date(1_750_000_000 * 1000).toISOString(),
    pending: [],
  };

  test('lists the week, keeps the ids changed since the last refresh, fetches them, tolerates a 404', async () => {
    const p = provider();
    const out = await run({}, walked, p);
    // id 2 changed before the refresh mark; 1 and 999 after; 999 is gone upstream
    expect(out.items.map((i) => i.externalId)).toEqual(['tvmaze:title:1']);
    expect(out.cursor.pending).toEqual([]);
    expect(out.cursor.refreshedAt > walked.refreshedAt).toBe(true);
    expect(out.nextInMinutes).toBeUndefined();
    expect(p.urls[0]).toContain('/updates/shows?since=week');
    expect(p.urls).toHaveLength(3);
  });

  test('caps the fetches and carries the rest as pending, without listing again', async () => {
    const p = provider();
    const first = await run({ refreshPerRun: 1 }, walked, p);
    expect(first.items).toHaveLength(1);
    expect(first.cursor.pending).toEqual([999]);
    expect(first.cursor.refreshedAt).toBe(walked.refreshedAt);
    expect(first.nextInMinutes).toBe(10);
    const second = await run({ refreshPerRun: 1 }, first.cursor, p);
    expect(second.cursor.pending).toEqual([]);
    expect(p.urls.filter((u) => u.includes('/updates/'))).toHaveLength(1);
  });
});
