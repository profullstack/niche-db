import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

import {
  bindings,
  gameItem,
  imageUrl,
  labels,
  PAGE_ROWS,
  parseTop,
  REQUESTS_PER_RUN,
  readRow,
  resumeFrom,
  sparqlUrl,
  topQuery,
  USER_AGENT,
  WINDOW_SPAN,
  wikidataDate,
  wikidataGames,
  windowQuery,
} from '../packages/adapters/src/wikidata-games.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

const fixture = async (name) =>
  JSON.parse(
    await readFile(new URL(`../packages/adapters/test/fixtures/${name}`, import.meta.url), 'utf8'),
  );

const top = await fixture('wikidata-games-top.json');
const first = await fixture('wikidata-games-window-first.json');
const dense = await fixture('wikidata-games-window-dense.json');

const rowOf = (body, qid) =>
  body.results.bindings.find((r) => r.item.value.endsWith(`/${qid}`)) ?? null;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * A fake query service with games at the given ids. The top query answers
 * the highest of them; a window query answers the ids inside it, in order,
 * up to its LIMIT, each row cut from VVVVVV's real row.
 */
function provider(ids = [5, 7, 150, 1000, 1001, 1002, 2500], fail = () => false) {
  const urls = [];
  const headers = [];
  const template = rowOf(first, 'Q5766');
  const http = {
    async request(url, opts) {
      urls.push(url);
      headers.push(opts?.headers ?? {});
      const query = new URL(url).searchParams.get('query') ?? '';
      if (query.includes('MAX(')) {
        if (fail('top')) return json({ error: 'nope' }, 500);
        return json({
          head: top.head,
          results: {
            bindings: [
              {
                top: { type: 'literal', value: String(Math.max(...ids)) },
                total: { type: 'literal', value: String(ids.length) },
              },
            ],
          },
        });
      }
      const m = query.match(/\?id >= (\d+) && \?id < (\d+)/);
      const limit = Number(query.match(/LIMIT (\d+)/)?.[1]);
      const lo = Number(m?.[1]);
      const hi = Number(m?.[2]);
      if (fail(lo, limit)) return json({ error: 'timeout' }, 504);
      const rows = ids
        .filter((id) => id >= lo && id < hi)
        .sort((a, b) => a - b)
        .slice(0, limit)
        .map((id) => ({
          ...template,
          item: { type: 'uri', value: `http://www.wikidata.org/entity/Q${id}` },
          id: { type: 'literal', value: String(id) },
          title: { 'xml:lang': 'en', type: 'literal', value: `Game ${id}` },
        }));
      return json({ head: first.head, results: { bindings: rows } });
    },
    async json(url) {
      throw new Error(`500 from ${url}`);
    },
  };
  return { http, urls, headers };
}

const run = (overrides = {}, cursor = {}, p = provider()) =>
  wikidataGames.pull({
    config: {
      requestsPerRun: REQUESTS_PER_RUN,
      windowSpan: WINDOW_SPAN,
      pageRows: PAGE_ROWS,
      pauseMs: 0,
      ...overrides,
    },
    cursor,
    env: {},
    http: p.http,
    log: () => {},
    deadline: Number.POSITIVE_INFINITY,
  });

describe('gameItem', () => {
  test('one row becomes one game item in the shape the IGDB sources use', () => {
    const item = normaliseItem(
      gameItem(readRow(bindings({ results: { bindings: [rowOf(first, 'Q5766')] } })[0])),
    );
    expect(item.externalId).toBe('wikidata:game:Q5766');
    expect(item.kind).toBe('game');
    expect(item.title).toBe('VVVVVV');
    expect(item.summary).toContain('2010');
    expect(item.url).toBe('https://www.wikidata.org/wiki/Q5766');
    expect(item.imageUrl).toMatch(
      /^https:\/\/commons\.wikimedia\.org\/wiki\/Special:FilePath\/VVVVVV.*\?width=800$/,
    );
    expect(item.publishedAt.toISOString()).toBe('2010-01-11T12:00:00.000Z');
    expect(item.precision).toBe('day');
    expect(item.timeKnown).toBe(false);
    expect(item.tags).toContain('game');
    expect(item.tags).toContain('wikidata');
    expect(item.tags).toContain('platform:microsoft-windows');
    expect(item.tags).toContain('platform:commodore-64');
    expect(item.tags).toContain('genre:puzzle-platformer');
    expect(item.data.provider).toBe('wikidata');
    expect(item.data.qid).toBe('Q5766');
    expect(item.data.steamAppId).toBe('70300');
    expect(item.data.steamUrl).toBe('https://store.steampowered.com/app/70300');
    expect(item.data.gogId).toBe('game/vvvvvv');
    expect(item.data.gogUrl).toBe('https://www.gog.com/game/vvvvvv');
    expect(item.data.igdbId).toBe('vvvvvv');
    expect(item.data.developers).toEqual(['Terry Cavanagh']);
    expect(item.data.publishers).toEqual(['Terry Cavanagh', 'Nicalis']);
    expect(item.data.platforms).toContain('PlayStation Vita');
    expect(item.data.genres).toEqual(['puzzle-platformer']);
    expect(item.data.modes).toEqual(['single-player video game', 'co-op mode']);
    expect(item.data.year).toBe(2010);
    expect(item.data.officialSite).toBe('https://thelettervsixtim.es');
    expect(item.data.external).toEqual({
      steam: '70300',
      gog: 'game/vvvvvv',
      igdb: 'vvvvvv',
      wikidata: 'Q5766',
    });
    expect(item.data.attribution).toBe('Wikidata, CC0');
    expect(JSON.stringify(item)).not.toContain('—');
  });

  test('a game with only a mul label keeps its title, one with no label is skipped, not thrown on', () => {
    const civ = readRow(bindings({ results: { bindings: [rowOf(first, 'Q2374')] } })[0]);
    expect(civ.title).toBe('Civilization III');
    expect(civ.steamAppId).toBe('3910');
    expect(civ.gogId).toBeNull();
    const item = normaliseItem(gameItem(civ));
    expect(item.data.external).toEqual({
      steam: '3910',
      igdb: 'sid-meier-s-civilization-iii',
      wikidata: 'Q2374',
    });
    expect(item.data.gogUrl).toBeNull();

    const nameless = bindings({ results: { bindings: [rowOf(dense, 'Q135013027')] } })[0];
    expect(nameless.title).toBeUndefined();
    expect(readRow(nameless)).toBeNull();
    expect(readRow(null)).toBeNull();
    expect(readRow({})).toBeNull();
  });

  test('a date to the year stays a year, and no date is no date', () => {
    const globe = readRow(bindings({ results: { bindings: [rowOf(dense, 'Q135005950')] } })[0]);
    expect(globe.releaseDate).toBe('2000');
    expect(globe.year).toBe(2000);
    const item = normaliseItem(gameItem(globe));
    expect(item.precision).toBe('year');
    expect(item.publishedAt.getUTCFullYear()).toBe(2000);

    const wind = readRow(bindings({ results: { bindings: [rowOf(first, 'Q31332')] } })[0]);
    expect(wind.releaseDate).toBeNull();
    expect(wind.year).toBeNull();
    expect(normaliseItem(gameItem(wind)).publishedAt).toBeNull();
    expect(normaliseItem(gameItem(wind)).imageUrl).toBeNull();
  });

  test('wikidataDate reads the precision that rides after the slash', () => {
    expect(wikidataDate('2010-01-11T00:00:00Z/11')).toBe('2010-01-11');
    expect(wikidataDate('2010-01-11T00:00:00Z/10')).toBe('2010-01');
    expect(wikidataDate('2000-01-01T00:00:00Z/9')).toBe('2000');
    expect(wikidataDate('1990-01-01T00:00:00Z/8')).toBe('1990');
    expect(wikidataDate('+2010-01-11T00:00:00Z')).toBe('2010-01-11');
    expect(wikidataDate('0000-01-01T00:00:00Z/9')).toBeNull();
    expect(wikidataDate('not a date')).toBeNull();
    expect(wikidataDate(null)).toBeNull();
  });

  test('images go over https at a card size, labels split on the pipe', () => {
    expect(imageUrl('http://commons.wikimedia.org/wiki/Special:FilePath/A%20b.png')).toBe(
      'https://commons.wikimedia.org/wiki/Special:FilePath/A%20b.png?width=800',
    );
    expect(imageUrl('https://example.org/x.png')).toBe('https://example.org/x.png');
    expect(imageUrl(null)).toBeNull();
    expect(labels('Microsoft Windows|macOS| Ouya ')).toEqual([
      'Microsoft Windows',
      'macOS',
      'Ouya',
    ]);
    expect(labels('')).toEqual([]);
    expect(labels(undefined)).toEqual([]);
  });

  test('the top query answer and the query text', () => {
    expect(parseTop(top)).toEqual({ top: 141442831, total: 175986 });
    expect(parseTop({ results: { bindings: [] } })).toBeNull();
    expect(parseTop(null)).toBeNull();
    expect(topQuery()).toContain('wd:Q7889');
    expect(topQuery()).toContain('COUNT(DISTINCT ?item)');
    const q = windowQuery(135_000_000, 136_000_000, 500);
    expect(q).toContain('FILTER(?id >= 135000000 && ?id < 136000000)');
    expect(q).toContain('LIMIT 500');
    expect(q).toContain('SELECT DISTINCT ?item ?id WHERE');
    expect(q).toContain('wdt:P1733');
    expect(q).toContain('wdt:P5794');
    expect(q).toContain('wikibase:timePrecision');
    expect(sparqlUrl(q)).toStartWith('https://query.wikidata.org/sparql?format=json&query=');
    expect(new URL(sparqlUrl(q)).searchParams.get('query')).toBe(q);
    expect(windowQuery(-5, 0, 0)).toContain('FILTER(?id >= 0 && ?id < 1)');
  });

  test('resume defaults', () => {
    expect(resumeFrom({})).toEqual({ from: 0, topId: null, total: null, walkedAt: null });
    expect(resumeFrom({ from: 8, topId: 2500, total: 7, walkedAt: 'x' })).toEqual({
      from: 8,
      topId: 2500,
      total: 7,
      walkedAt: 'x',
    });
    expect(resumeFrom({ from: -1, topId: 0 })).toMatchObject({ from: 0, topId: null });
  });
});

describe('the walk', () => {
  test('asks for the top once, slides past a full page, and ends past the highest game', async () => {
    const p = provider();
    const out = await run({ windowSpan: 1000, pageRows: 2 }, {}, p);
    expect(out.items.map((i) => i.externalId)).toEqual([
      'wikidata:game:Q5',
      'wikidata:game:Q7',
      'wikidata:game:Q150',
      'wikidata:game:Q1000',
      'wikidata:game:Q1001',
      'wikidata:game:Q1002',
      'wikidata:game:Q2500',
    ]);
    // top, [0,1000) full at 5,7; [8,1008) full at 150,1000; [1001,2001) full at 1001,1002;
    // [1003,2003) empty; [2003,3003) 2500; then 3003 > 2500 ends the pass
    expect(p.urls).toHaveLength(6);
    expect(p.urls.filter((u) => u.includes('MAX('))).toHaveLength(1);
    expect(out.cursor).toMatchObject({ from: null, topId: null, total: 7 });
    expect(out.cursor.walkedAt).toMatch(/^\d{4}-/);
    expect(out.nextInMinutes).toBeUndefined();
    expect(out.note).toContain('past the highest game');
    expect(out.note).not.toContain('—');
    for (const h of p.headers) expect(h['user-agent']).toBe(USER_AGENT);
    expect(USER_AGENT).toContain('nichedb.dev');
  });

  test('stops at the cap and resumes from the cursor without asking for the top again', async () => {
    const p = provider();
    const first = await run({ windowSpan: 1000, pageRows: 2, requestsPerRun: 2 }, {}, p);
    expect(first.items.map((i) => i.externalId)).toEqual(['wikidata:game:Q5', 'wikidata:game:Q7']);
    expect(first.cursor).toMatchObject({ from: 8, topId: 2500, total: 7, walkedAt: null });
    expect(first.nextInMinutes).toBe(10);
    expect(first.note).toContain('stopped at the request cap');

    const second = await run({ windowSpan: 1000, pageRows: 2, requestsPerRun: 2 }, first.cursor, p);
    expect(second.items.map((i) => i.externalId)).toEqual([
      'wikidata:game:Q150',
      'wikidata:game:Q1000',
      'wikidata:game:Q1001',
      'wikidata:game:Q1002',
    ]);
    expect(second.cursor).toMatchObject({ from: 1003, topId: 2500 });
    expect(p.urls).toHaveLength(4);
    expect(p.urls.filter((u) => u.includes('MAX('))).toHaveLength(1);
    expect(JSON.parse(JSON.stringify(second.cursor))).toEqual(second.cursor);
  });

  test('repeated failures stop the run without losing the place, and a dead service throws', async () => {
    const p = provider(undefined, (lo) => lo === 8);
    const out = await run({ windowSpan: 1000, pageRows: 2 }, {}, p);
    expect(out.items).toHaveLength(2);
    expect(out.cursor).toMatchObject({ from: 8, topId: 2500 });
    expect(out.nextInMinutes).toBe(10);
    expect(out.note).toContain('after repeated failures');
    expect(out.note).toContain('3 failed');
    // top, window 0, then three tries at window 8
    expect(p.urls).toHaveLength(5);

    const dead = provider(undefined, () => true);
    await expect(run({ windowSpan: 1000 }, {}, dead)).rejects.toThrow(/every request failed/);
  });

  test('a window that times out is retried with fewer rows', async () => {
    const p = provider(undefined, (lo, limit) => lo === 8 && limit === 2);
    const out = await run({ windowSpan: 1000, pageRows: 2 }, {}, p);
    expect(out.items).toHaveLength(7);
    expect(out.cursor.from).toBeNull();
    expect(out.note).toContain('1 failed');
    expect(out.note).toContain('past the highest game');
  });

  test('a failed top query stops after three tries and the next run starts the pass', async () => {
    const p = provider(undefined, (lo) => lo === 'top');
    await expect(run({}, {}, p)).rejects.toThrow(/every request failed/);
    expect(p.urls).toHaveLength(3);
  });
});
