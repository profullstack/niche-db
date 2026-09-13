import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

import {
  buildQuery,
  fileOf,
  filmItem,
  genreName,
  imageUrlFor,
  isBareQid,
  isTimeout,
  LABEL_LANGUAGES,
  MAX_ROWS,
  MIN_WINDOW,
  parseBindings,
  qidOf,
  resumeFrom,
  runtimeOf,
  splitList,
  summaryOf,
  TOP_ID,
  WINDOW,
  WINDOWS_PER_RUN,
  wikidataFilms,
  windowOf,
  windowUrl,
  ymdOf,
} from '../packages/adapters/src/wikidata-films.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

const fixture = async (name) =>
  JSON.parse(
    await readFile(new URL(`../packages/adapters/test/fixtures/${name}`, import.meta.url), 'utf8'),
  );

/** Two real windows, trimmed: 20,000,000 on (8 rows, one with no label) and 100,000,000 on (7 rows). */
const mid = await fixture('wikidata-films-window-20000000.json');
const sparse = await fixture('wikidata-films-window-100000000.json');
const rowOf = (body, qid) =>
  body.results.bindings.find((r) => r.item.value.endsWith(`/${qid}`)) ?? null;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const empty = () => ({ head: mid.head, results: { bindings: [] } });

/**
 * A fake query service keyed on the window a url asks for: the mid fixture at
 * 0, the sparse one at 200,000, nothing past that. `answer` can override any
 * window by its start and width.
 */
function provider(answer = () => null) {
  const urls = [];
  const windows = [];
  const http = {
    async request(url, opts) {
      urls.push(url);
      const w = windowOf(url);
      windows.push([w.start, w.end - w.start, opts?.headers?.['user-agent'] ?? null]);
      const custom = answer(w.start, w.end - w.start);
      if (custom) return custom;
      if (w.start === 0) return json(mid);
      if (w.start === 200_000) return json(sparse);
      return json(empty());
    },
    async json(url) {
      throw new Error(`500 from ${url}`);
    },
  };
  return { http, urls, windows };
}

const run = (overrides = {}, cursor = {}, p = provider()) =>
  wikidataFilms.pull({
    config: {
      startId: 0,
      windowsPerRun: WINDOWS_PER_RUN,
      window: WINDOW,
      topId: 600_000,
      maxRows: MAX_ROWS,
      pauseMs: 0,
      ...overrides,
    },
    cursor,
    env: {},
    http: p.http,
    log: () => {},
    deadline: Number.POSITIVE_INFINITY,
  });

describe('filmItem', () => {
  test('one row becomes one title item in the TMDB and TVmaze shape', () => {
    const item = normaliseItem(filmItem(rowOf(mid, 'Q20001052')));
    expect(item.externalId).toBe('wikidata:film:Q20001052');
    expect(item.kind).toBe('title');
    expect(item.title).toBe('Adventures of Casanova');
    expect(item.url).toBe('https://www.wikidata.org/wiki/Q20001052');
    expect(item.imageUrl).toMatch(/^https:\/\/commons\.wikimedia\.org\/wiki\/Special:FilePath\//);
    expect(item.imageUrl).toContain('Casanova');
    expect(item.imageUrl).toMatch(/\?width=512$/);
    expect(item.publishedAt.toISOString()).toBe('1948-02-07T12:00:00.000Z');
    expect(item.timeKnown).toBe(false);
    expect(item.precision).toBe('day');
    expect(item.tags).toEqual([
      'title',
      'film',
      'wikidata',
      'genre:adventure',
      'country:united-states',
    ]);
    expect(item.summary).toBe(
      '1948 film directed by Roberto Gavaldón (United States). Adventure. 83 min.',
    );
    expect(item.data).toMatchObject({
      provider: 'wikidata',
      category: 'film',
      form: 'movie',
      year: 1948,
      normTitle: 'adventures of casanova',
      titleLanguage: 'en',
      imdbId: 'tt0040075',
      tmdbId: '279267',
      tvmazeId: null,
      anilistId: null,
      wikidataId: 'Q20001052',
      directors: ['Roberto Gavaldón'],
      genres: ['adventure'],
      countries: ['United States'],
      runtimeMin: 83,
      releaseDate: '1948-02-07',
      attribution: 'Wikidata, CC0',
    });
    expect(item.data.imageFile).toContain('Adventures of Casanova (1948).jpg');
  });

  test('lists split on the bar, several countries become several tags', () => {
    const two = filmItem(rowOf(mid, 'Q20001943'));
    expect(two.data.directors).toEqual(['Helene Crouzillat', 'Lætitia Tura']);
    expect(two.summary).toContain('directed by Helene Crouzillat and Lætitia Tura');
    const ines = filmItem(rowOf(sparse, 'Q100146341'));
    expect(ines.data.genres).toEqual(['drama', 'period drama', 'historical']);
    expect(ines.data.countries).toEqual(['Spain', 'Portugal']);
    expect(ines.tags).toContain('country:spain');
    expect(ines.tags).toContain('country:portugal');
    expect(ines.tags).toContain('genre:period-drama');
  });

  test('a film with nothing but a name still stands, one with no name in any language does not', () => {
    const bare = filmItem(rowOf(mid, 'Q20002642'));
    expect(bare.title).toBe('Transrating');
    expect(bare.publishedAt).toBeNull();
    expect(bare.imageUrl).toBeNull();
    expect(bare.summary).toBe('Film.');
    expect(bare.data.imdbId).toBeNull();
    expect(bare.data.year).toBeNull();
    expect(bare.tags).toEqual(['title', 'film', 'wikidata']);
    expect(filmItem(rowOf(mid, 'Q20094866'))).toBeNull();
    expect(filmItem(null)).toBeNull();
    expect(filmItem({ item: { value: 'nonsense' }, itemLabel: { value: 'x' } })).toBeNull();
  });

  test('a label in another language is the title, and says which language', () => {
    const fr = filmItem(rowOf(mid, 'Q20004162'));
    expect(fr.title).toBe("Âmes d'enfants");
    expect(fr.data.titleLanguage).toBe('fr');
    expect(fr.data.normTitle).toBe('ames d enfants');
    expect(fr.data.genres).toEqual(['silent']);
  });

  test('a date on 1 January is the year Wikidata truncated, stored at year precision', () => {
    const fr = normaliseItem(filmItem(rowOf(mid, 'Q20004162')));
    expect(fr.precision).toBe('year');
    expect(fr.publishedAt.toISOString()).toBe('1928-07-01T12:00:00.000Z');
    expect(fr.data.releaseDate).toBe('1928');
    expect(fr.data.year).toBe(1928);
    expect(fr.summary).toMatch(/^1928 film/);
    const day = normaliseItem(filmItem(rowOf(mid, 'Q20004204')));
    expect(day.precision).toBe('day');
    expect(day.data.releaseDate).toBe('2013-11-01');
  });

  test('the helpers', () => {
    expect(qidOf('http://www.wikidata.org/entity/Q26060')).toBe('Q26060');
    expect(qidOf('http://www.wikidata.org/entity/P31')).toBeNull();
    expect(isBareQid('Q20094866')).toBe(true);
    expect(isBareQid('Q')).toBe(false);
    expect(
      fileOf('http://commons.wikimedia.org/wiki/Special:FilePath/Tokyo%20Monogatari%201953.jpg'),
    ).toBe('Tokyo Monogatari 1953.jpg');
    expect(fileOf('https://example.com/x.jpg')).toBeNull();
    expect(imageUrlFor('Tokyo Monogatari 1953.jpg')).toBe(
      'https://commons.wikimedia.org/wiki/Special:FilePath/Tokyo%20Monogatari%201953.jpg?width=512',
    );
    expect(imageUrlFor(null)).toBeNull();
    expect(splitList('a|b||a| c ')).toEqual(['a', 'b', 'c']);
    expect(splitList(null)).toEqual([]);
    expect(genreName('comedy film')).toBe('comedy');
    expect(genreName('film based on literature')).toBe('film based on literature');
    expect(ymdOf('1972-03-13T00:00:00Z')).toBe('1972-03-13');
    expect(ymdOf('2014-01-01T00:00:00Z')).toBe('2014');
    expect(ymdOf('2013-11-01T00:00:00Z')).toBe('2013-11-01');
    expect(ymdOf('-0500-01-01T00:00:00Z')).toBeNull();
    expect(ymdOf('1972-13-01T00:00:00Z')).toBeNull();
    expect(runtimeOf('136')).toBe(136);
    expect(runtimeOf('92.4')).toBe(92);
    expect(runtimeOf('')).toBeNull();
    expect(
      summaryOf({ year: null, directors: [], countries: [], genres: [], runtimeMin: null }),
    ).toBe('Film.');
    expect(
      summaryOf({
        year: 2001,
        directors: ['A', 'B', 'C'],
        countries: ['Japan'],
        genres: [],
        runtimeMin: 90,
      }),
    ).toBe('2001 film directed by A, B and C (Japan). 90 min.');
    expect(parseBindings({ results: { bindings: [{ a: 1 }, null] } })).toEqual([{ a: 1 }]);
    expect(parseBindings('nope')).toEqual([]);
  });

  test('the query walks by id window, names every label to the label service, and is readable back from the url', () => {
    const q = buildQuery(200_000, 400_000);
    expect(q).toContain('?item wdt:P31 wd:Q11424');
    expect(q).toContain('FILTER(?n >= 200000 && ?n < 400000)');
    expect(q).toContain('?genre rdfs:label ?genreLabel');
    expect(q).toContain(`wikibase:language "${LABEL_LANGUAGES}"`);
    expect(q).not.toContain('OFFSET');
    expect(windowOf(windowUrl(200_000, 400_000))).toEqual({ start: 200_000, end: 400_000 });
    expect(windowOf('https://query.wikidata.org/sparql?query=x')).toBeNull();
  });

  test('what counts as the service giving up on a window', () => {
    expect(isTimeout(504, 'upstream request timeout')).toBe(true);
    expect(isTimeout(500, 'java.util.concurrent.TimeoutException')).toBe(true);
    expect(isTimeout(500, 'Unknown error')).toBe(false);
    expect(isTimeout(502, '')).toBe(false);
    expect(
      isTimeout(
        null,
        null,
        Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' }),
      ),
    ).toBe(true);
    expect(isTimeout(null, null, new Error('ECONNRESET'))).toBe(false);
  });

  test('resume', () => {
    expect(resumeFrom({}, {})).toEqual({ start: 0, window: WINDOW });
    expect(resumeFrom({ nextId: 400_000, window: 50_000 }, {})).toEqual({
      start: 400_000,
      window: 50_000,
    });
    expect(resumeFrom({ nextId: 400_000, window: 1 }, {})).toEqual({
      start: 400_000,
      window: WINDOW,
    });
    expect(resumeFrom({ nextId: 5 }, { startId: 100 })).toEqual({ start: 100, window: WINDOW });
    expect(resumeFrom({ window: 400_000 }, { window: 100_000 }).window).toBe(100_000);
    expect(TOP_ID).toBeGreaterThan(135_000_000);
    expect(MIN_WINDOW).toBeLessThan(WINDOW);
  });
});

describe('the walk', () => {
  test('walks window by window to the top and marks the pass done', async () => {
    const p = provider();
    const out = await run({}, {}, p);
    expect(out.items).toHaveLength(7 + 7);
    expect(out.items.map((i) => i.externalId)).toContain('wikidata:film:Q100156260');
    expect(out.items.map((i) => i.externalId)).not.toContain('wikidata:film:Q20094866');
    expect(out.cursor).toMatchObject({ nextId: null, window: WINDOW });
    expect(out.cursor.walkedAt).toMatch(/^\d{4}-/);
    expect(out.nextInMinutes).toBeUndefined();
    expect(out.note).toContain('14 films from 3 windows');
    expect(out.note).toContain('1 without a title');
    expect(out.note).toContain('past the top id');
    expect(p.windows.map(([s, w]) => [s, w])).toEqual([
      [0, 200_000],
      [200_000, 200_000],
      [400_000, 200_000],
    ]);
    for (const [, , ua] of p.windows) expect(ua).toMatch(/nichedb/);
    expect(new URL(p.urls[0]).origin + new URL(p.urls[0]).pathname).toBe(
      'https://query.wikidata.org/sparql',
    );
    expect(resumeFrom(out.cursor, {})).toEqual({ start: 0, window: WINDOW });
  });

  test('stops at the window cap and resumes from the cursor', async () => {
    const p = provider();
    const first = await run({ windowsPerRun: 1 }, {}, p);
    expect(first.items).toHaveLength(7);
    expect(first.cursor).toMatchObject({ nextId: 200_000, window: WINDOW, walkedAt: null });
    expect(first.nextInMinutes).toBe(10);
    expect(first.note).toContain('stopped at the window cap at 200000');
    const second = await run({ windowsPerRun: 1 }, first.cursor, p);
    expect(second.items.map((i) => i.externalId)).toContain('wikidata:film:Q100052082');
    expect(second.cursor.nextId).toBe(400_000);
    expect(JSON.parse(JSON.stringify(second.cursor))).toEqual(second.cursor);
    const third = await run({ windowsPerRun: 1 }, second.cursor, p);
    expect(third.cursor.nextId).toBeNull();
    expect(p.windows).toHaveLength(3);
  });

  test('a window that times out is halved and asked again, and the width rides in the cursor', async () => {
    const p = provider((start, width) =>
      start === 0 && width === 200_000
        ? new Response('upstream request timeout', { status: 504 })
        : null,
    );
    // maxRows 20 so seven films do not grow the window back.
    const out = await run({ windowsPerRun: 2, maxRows: 20 }, {}, p);
    expect(out.items).toHaveLength(7);
    expect(p.windows.map(([s, w]) => [s, w])).toEqual([
      [0, 200_000],
      [0, 100_000],
    ]);
    expect(out.cursor).toMatchObject({ nextId: 100_000, window: 100_000 });
    expect(out.note).toContain('window halved 1 times to 100000');
    const next = await run({ windowsPerRun: 1, maxRows: 20 }, out.cursor, p);
    expect(p.windows.at(-1).slice(0, 2)).toEqual([100_000, 100_000]);
    expect(next.cursor.nextId).toBe(200_000);
  });

  test('a window with too many films is kept and the next one is half as wide; a sparse one grows back', async () => {
    const p = provider();
    const out = await run({ windowsPerRun: 2, maxRows: 5 }, {}, p);
    expect(out.items).toHaveLength(7 + 7);
    expect(p.windows.map(([s, w]) => [s, w])).toEqual([
      [0, 200_000],
      [200_000, 100_000],
    ]);
    expect(out.cursor.window).toBe(50_000);
    const grown = await run(
      { windowsPerRun: 1, maxRows: 5 },
      { nextId: 400_000, window: 50_000 },
      p,
    );
    // 400,000 on is empty, so the window doubles back towards the configured size.
    expect(grown.cursor.window).toBe(100_000);
  });

  test('repeated failures stop the run without losing the place, and a dead service throws', async () => {
    const p = provider((start) => (start >= 200_000 ? json({ error: 'nope' }, 500) : null));
    const out = await run({ windowsPerRun: 10 }, {}, p);
    expect(out.items).toHaveLength(7);
    expect(out.cursor).toMatchObject({ nextId: 200_000, window: WINDOW });
    expect(out.note).toContain('3 failed');
    expect(out.note).toContain('after repeated failures at 200000');
    expect(out.nextInMinutes).toBe(10);
    expect(p.windows).toHaveLength(4);

    const dead = provider(() => json({ error: 'nope' }, 500));
    await expect(run({ windowsPerRun: 5 }, {}, dead)).rejects.toThrow(/every request failed/);

    const thrown = provider(() => {
      throw new Error('ECONNRESET');
    });
    await expect(run({ windowsPerRun: 5 }, {}, thrown)).rejects.toThrow(/every request failed/);
  });

  test('a timeout at the smallest window is a failure, not a loop', async () => {
    const p = provider(() => new Response('upstream request timeout', { status: 504 }));
    await expect(run({ windowsPerRun: 5, window: MIN_WINDOW }, {}, p)).rejects.toThrow(
      /every request failed/,
    );
    expect(p.windows).toHaveLength(3);
    for (const [, w] of p.windows) expect(w).toBe(MIN_WINDOW);
  });

  test('the run deadline stops the walk with the place kept', async () => {
    const p = provider();
    const out = await wikidataFilms.pull({
      config: { topId: 600_000, pauseMs: 0 },
      cursor: {},
      env: {},
      http: p.http,
      log: () => {},
      deadline: Date.now() - 1,
    });
    expect(out.items).toHaveLength(0);
    expect(out.cursor.nextId).toBe(0);
    expect(out.note).toContain('on the run deadline');
  });
});
