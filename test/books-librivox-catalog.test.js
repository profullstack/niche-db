import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

import {
  ATTRIBUTION,
  bookItem,
  copyrightYear,
  genreSlug,
  languageCode,
  librivoxCatalog,
  pageItems,
  pageUrl,
  parsePage,
  REQUEST_CAP,
  resumeOffset,
  USER_AGENT,
} from '../packages/adapters/src/librivox-catalog.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

const fixture = async (name) =>
  JSON.parse(
    await readFile(new URL(`../packages/adapters/test/fixtures/${name}`, import.meta.url), 'utf8'),
  );

// Two real pages of the walk, trimmed, and the real past-the-end answer.
const page0 = await fixture('librivox-catalog-page-0.json');
const page1 = await fixture('librivox-catalog-page-1.json');
const end = await fixture('librivox-catalog-end.json');

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * A fake LibriVox that serves the fixture pages by offset, the way the real
 * one does, and 404s past the last one.
 */
function provider(pages = [page0.books, page1.books], fail = () => false) {
  const urls = [];
  const headers = [];
  const byOffset = new Map();
  let at = 0;
  for (const books of pages) {
    byOffset.set(at, books);
    at += books.length;
  }
  const http = {
    async request(url, opts) {
      urls.push(url);
      headers.push(opts?.headers ?? {});
      const offset = Number(new URL(url).searchParams.get('offset'));
      if (fail(offset)) return json({ error: 'nope' }, 500);
      const books = byOffset.get(offset);
      if (!books) return json(end, 404);
      return json({ books });
    },
    async json(url) {
      throw new Error(`500 from ${url}`);
    },
  };
  return { http, urls, headers };
}

const run = (overrides = {}, cursor = {}, p = provider()) =>
  librivoxCatalog.pull({
    config: { requestCap: REQUEST_CAP, pauseMs: 0, ...overrides },
    cursor,
    env: {},
    http: p.http,
    log: () => {},
    deadline: Number.POSITIVE_INFINITY,
  });

const monteCristo = page0.books.find((b) => b.id === '47');

describe('bookItem', () => {
  test('one audiobook row becomes one audiobook item with the fields a listener wants', () => {
    const item = normaliseItem(bookItem(monteCristo));
    expect(item.externalId).toBe('librivox:47');
    expect(item.kind).toBe('audiobook');
    expect(item.title).toBe('Count of Monte Cristo');
    expect(item.url).toBe('https://librivox.org/the-count-of-monte-cristo-by-alexandre-dumas/');
    expect(item.imageUrl).toMatch(/^https:\/\/www\.archive\.org\/download\/.*\.jpg$/);
    expect(item.publishedAt).toBeNull();
    expect(item.summary.length).toBeLessThanOrEqual(600);
    expect(item.summary).not.toContain('<i>');
    expect(item.summary).toContain('adventure novel by Alexandre Dumas');
    expect(item.tags).toContain('audiobook');
    expect(item.tags).toContain('librivox');
    expect(item.tags).toContain('lang:en');
    expect(item.tags).toContain('genre:literary-fiction');
    expect(item.tags).toContain('genre:published-1800-1900');
    expect(item.data.provider).toBe('librivox');
    expect(item.data.librivoxId).toBe('47');
    expect(item.data.authors).toEqual([
      {
        id: '431',
        name: 'Alexandre Dumas',
        firstName: 'Alexandre',
        lastName: 'Dumas',
        dob: '1802',
        dod: '1870',
      },
    ]);
    expect(item.data.language).toBe('English');
    expect(item.data.languageCode).toBe('en');
    expect(item.data.totaltime).toBe('49:43:15');
    expect(item.data.totaltimesecs).toBe(178995);
    expect(item.data.numSections).toBe(128);
    expect(item.data.urlRss).toBe('https://librivox.org/rss/47');
    expect(item.data.urlZip).toMatch(/^https:\/\/archive\.org\/compress\//);
    expect(item.data.urlProject).toBe('https://en.wikipedia.org/wiki/Count_of_Monte_Cristo');
    expect(item.data.urlText).toBe('https://www.gutenberg.org/etext/1184');
    expect(item.data.urlIarchive).toBe(
      'https://www.archive.org/details/count_monte_cristo_0711_librivox',
    );
    expect(item.data.genres.map((g) => g.name)).toEqual([
      'Literary Fiction',
      'Published 1800 -1900',
    ]);
    expect(item.data.copyrightYear).toBe(1844);
    expect(item.data.attribution).toBe(ATTRIBUTION);
    expect(JSON.stringify(item)).not.toContain('sections');
  });

  test('a row with no id or title is skipped, never thrown on', () => {
    expect(bookItem({ title: 'No id' })).toBeNull();
    expect(bookItem({ id: '1', title: '' })).toBeNull();
    expect(bookItem(null)).toBeNull();
    expect(pageItems([{ id: '1', title: 'Fine' }, {}, null])).toHaveLength(1);
    expect(pageItems({ not: 'a list' })).toEqual([]);
    expect(pageItems(page0.books)).toHaveLength(page0.books.length);
  });

  test('an empty description falls back to author, language and running time', () => {
    const item = bookItem({ ...monteCristo, description: '', coverart_jpg: '' });
    expect(item.summary).toBe('Alexandre Dumas · English · 49:43:15');
    expect(item.imageUrl).toMatch(/_thumb\.jpg$/);
  });

  test('language names become codes, genres slugs, years numbers', () => {
    expect(languageCode('English')).toBe('en');
    expect(languageCode('Ancient Greek')).toBe('grc');
    expect(languageCode('Multilingual')).toBe('mul');
    expect(languageCode('Bisaya/Cebuano')).toBe('ceb');
    expect(languageCode(' Klingon ')).toBe('klingon');
    expect(languageCode('Foo/Bar')).toBe('foo-bar');
    expect(languageCode('')).toBeNull();
    expect(genreSlug('Science Fiction/Fantasy')).toBe('science-fiction-fantasy');
    expect(genreSlug('Published 1800 -1900')).toBe('published-1800-1900');
    expect(copyrightYear('1844')).toBe(1844);
    expect(copyrightYear('0')).toBeNull();
    expect(copyrightYear('')).toBeNull();
  });
});

describe('pages', () => {
  test('the page url asks for json, the extended set with cover art, and every field but the sections', () => {
    const u = new URL(pageUrl(150));
    expect(u.origin + u.pathname).toBe('https://librivox.org/api/feed/audiobooks/');
    expect(u.searchParams.get('format')).toBe('json');
    expect(u.searchParams.get('extended')).toBe('1');
    expect(u.searchParams.get('coverart')).toBe('1');
    expect(u.searchParams.get('limit')).toBe('50');
    expect(u.searchParams.get('offset')).toBe('150');
    const fields = u.searchParams.get('fields');
    expect(fields.startsWith('{id,')).toBe(true);
    const names = fields.slice(1, -1).split(',');
    expect(names).toContain('coverart_jpg');
    expect(names).toContain('num_sections');
    expect(names).not.toContain('sections');
  });

  test('a 404, an error body or an empty list is the end; another failure is a failure', () => {
    expect(parsePage(404, null)).toEqual({ books: [], end: true });
    expect(parsePage(200, end)).toEqual({ books: [], end: true });
    expect(parsePage(200, { books: [] })).toEqual({ books: [], end: true });
    expect(parsePage(200, page1).end).toBe(false);
    expect(parsePage(200, page1).books).toHaveLength(page1.books.length);
    expect(() => parsePage(500, {})).toThrow(/answered 500/);
    expect(() => parsePage(522, null)).toThrow(/answered 522/);
  });

  test('resume defaults', () => {
    expect(resumeOffset({})).toBe(0);
    expect(resumeOffset({ offset: 2000 })).toBe(2000);
    expect(resumeOffset({ offset: -5 })).toBe(0);
    expect(resumeOffset({ offset: null })).toBe(0);
  });
});

describe('the walk', () => {
  const total = page0.books.length + page1.books.length;

  test('walks page by page to the 404 and marks the pass done', async () => {
    const p = provider();
    const out = await run({}, {}, p);
    expect(out.items).toHaveLength(total);
    expect(out.items[0].externalId).toBe('librivox:47');
    expect(out.cursor.offset).toBeNull();
    expect(out.cursor.total).toBe(total);
    expect(out.cursor.walkedAt).toMatch(/^\d{4}-/);
    expect(out.nextInMinutes).toBeUndefined();
    expect(out.note).toContain('past the last book');
    expect(p.urls).toHaveLength(3);
    for (const h of p.headers) expect(h['user-agent']).toBe(USER_AGENT);
  });

  test('stops at the cap and resumes from the cursor', async () => {
    const p = provider();
    const first = await run({ requestCap: 1 }, {}, p);
    expect(first.items).toHaveLength(page0.books.length);
    expect(first.cursor.offset).toBe(page0.books.length);
    expect(first.cursor.seen).toBe(page0.books.length);
    expect(first.cursor.walkedAt).toBeNull();
    expect(first.nextInMinutes).toBe(10);
    expect(first.note).toContain('stopped at the page cap');

    const second = await run({ requestCap: 10 }, first.cursor, p);
    expect(second.items).toHaveLength(page1.books.length);
    expect(second.items[0].externalId).toBe(`librivox:${page1.books[0].id}`);
    expect(second.cursor.offset).toBeNull();
    expect(second.cursor.total).toBe(total);
    expect(p.urls).toHaveLength(3);
    expect(resumeOffset(second.cursor)).toBe(0);
  });

  test('repeated failures stop the run without losing the place, and a dead provider throws', async () => {
    const p = provider(undefined, (offset) => offset === page0.books.length);
    const out = await run({ requestCap: 10 }, {}, p);
    expect(out.items).toHaveLength(page0.books.length);
    expect(out.cursor.offset).toBe(page0.books.length);
    expect(out.nextInMinutes).toBe(10);
    expect(out.note).toContain('after repeated failures');
    expect(out.note).toContain('3 failed');
    expect(p.urls).toHaveLength(4);

    const dead = provider(undefined, () => true);
    await expect(run({ requestCap: 5 }, {}, dead)).rejects.toThrow(/every request failed/);
  });

  test('a run past the deadline keeps its place', async () => {
    const p = provider();
    const out = await librivoxCatalog.pull({
      config: { requestCap: 10, pauseMs: 0 },
      cursor: {},
      env: {},
      http: p.http,
      log: () => {},
      deadline: 0,
    });
    expect(out.items).toHaveLength(0);
    expect(out.cursor.offset).toBe(0);
    expect(out.note).toContain('on the run deadline');
  });
});
