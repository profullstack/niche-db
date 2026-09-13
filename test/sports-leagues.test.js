import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

import {
  leagueItem,
  leaguePageUrl,
  leagueUrl,
  parseLeague,
  parseTvRights,
  REQUEST_CAP,
  resumeId,
  START_ID,
  sportsdbLeagues,
  TAIL_MISSES,
} from '../packages/adapters/src/sportsdb-leagues.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

const fixture = async (name) =>
  JSON.parse(
    await readFile(new URL(`../packages/adapters/test/fixtures/${name}`, import.meta.url), 'utf8'),
  );

const epl = await fixture('sportsdb-league.json');

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A fake TheSportsDB with leagues at the given ids and null everywhere else. */
function provider(known = new Set([4328, 4329, 4331]), fail = () => false) {
  const urls = [];
  const http = {
    async request(url) {
      urls.push(url);
      const id = Number(new URL(url).searchParams.get('id'));
      if (fail(id)) return json({ error: 'nope' }, 500);
      if (!known.has(id)) return json({ leagues: null });
      const row = { ...epl.leagues[0], idLeague: String(id), strLeague: `League ${id}` };
      return json({ leagues: [row] });
    },
    async json(url) {
      throw new Error(`500 from ${url}`);
    },
  };
  return { http, urls };
}

const run = (overrides = {}, cursor = {}, p = provider()) =>
  sportsdbLeagues.pull({
    config: {
      startId: START_ID,
      requestCap: REQUEST_CAP,
      tailMisses: TAIL_MISSES,
      pauseMs: 0,
      ...overrides,
    },
    cursor,
    env: {},
    http: p.http,
    log: () => {},
    deadline: Number.POSITIVE_INFINITY,
  });

describe('leagueItem', () => {
  test('one league row becomes one league item with the fields a reader wants', () => {
    const item = normaliseItem(leagueItem(epl.leagues[0]));
    expect(item.externalId).toBe('sportsdb:league:4328');
    expect(item.kind).toBe('league');
    expect(item.title).toBe('English Premier League');
    expect(item.url).toBe('https://www.thesportsdb.com/league/4328-english-premier-league');
    expect(item.imageUrl).toMatch(
      /^https:\/\/r2\.thesportsdb\.com\/images\/media\/league\/badge\//,
    );
    expect(item.tags).toContain('league');
    expect(item.tags).toContain('soccer');
    expect(item.tags).toContain('country:england');
    expect(item.tags).toContain('gender:male');
    expect(item.tags).toContain('season:2026-2027');
    expect(item.data.provider).toBe('thesportsdb');
    expect(item.data.alternateNames).toEqual(['Premier League', 'EPL', 'England']);
    expect(item.data.formedYear).toBe(1992);
    expect(item.data.website).toBe('https://www.premierleague.com');
    expect(item.data.apiFootballV3Id).toBe('39');
    expect(item.data.tvRights.length).toBeGreaterThan(5);
    expect(item.summary.length).toBeLessThanOrEqual(600);
  });

  test('tv rights split into market, channel and years', () => {
    expect(parseTvRights('Australia - Stan \r\nCanada - FuboTV [2022-2025]\r\n')).toEqual([
      { market: 'Australia', channel: 'Stan', years: null },
      { market: 'Canada', channel: 'FuboTV', years: '2022-2025' },
    ]);
    expect(parseTvRights(null)).toEqual([]);
  });

  test('an unknown id is null, a page url is id-slug', () => {
    expect(parseLeague({ leagues: null })).toBeNull();
    expect(parseLeague({})).toBeNull();
    expect(parseLeague(epl)?.idLeague).toBe('4328');
    expect(leaguePageUrl('4517', 'WTA Tour')).toBe(
      'https://www.thesportsdb.com/league/4517-wta-tour',
    );
  });

  test('the key rides in the path and never in an item', () => {
    expect(leagueUrl('abc', 4328)).toBe(
      'https://www.thesportsdb.com/api/v1/json/abc/lookupleague.php?id=4328',
    );
    expect(JSON.stringify(leagueItem(epl.leagues[0]))).not.toContain('/json/3/');
  });
});

describe('the walk', () => {
  test('stops at the cap and resumes from the cursor', async () => {
    const p = provider();
    const first = await run({ requestCap: 2 }, {}, p);
    expect(first.items.map((i) => i.externalId)).toEqual([
      'sportsdb:league:4328',
      'sportsdb:league:4329',
    ]);
    expect(first.cursor.nextId).toBe(4330);
    expect(first.cursor.topId).toBe(4329);
    expect(first.nextInMinutes).toBe(10);
    expect(first.note).toContain('stopped at the request cap');

    const second = await run({ requestCap: 2 }, first.cursor, p);
    expect(second.items.map((i) => i.externalId)).toEqual(['sportsdb:league:4331']);
    expect(second.cursor.nextId).toBe(4332);
    expect(p.urls).toHaveLength(4);
  });

  test('a run of unknown ids ends the pass and the next run starts over', async () => {
    const p = provider();
    const out = await run({ requestCap: 100, tailMisses: 5 }, {}, p);
    expect(out.items).toHaveLength(3);
    expect(out.cursor.nextId).toBeNull();
    expect(out.cursor.topId).toBe(4331);
    expect(out.cursor.walkedAt).toMatch(/^\d{4}-/);
    expect(out.nextInMinutes).toBeUndefined();
    expect(out.note).toContain('past the newest league');
    // 4328, 4329, 4330 (miss), 4331, then five misses 4332..4336
    expect(p.urls).toHaveLength(9);
    expect(resumeId(out.cursor, {})).toBe(START_ID);
  });

  test('a gap of one is not the tail', async () => {
    const p = provider(new Set([4328, 4330]));
    const out = await run({ requestCap: 100, tailMisses: 3 }, {}, p);
    expect(out.items.map((i) => i.externalId)).toEqual([
      'sportsdb:league:4328',
      'sportsdb:league:4330',
    ]);
  });

  test('repeated failures stop the run without losing the place, and a dead provider throws', async () => {
    const p = provider(new Set([4328]), (id) => id >= 4329);
    const out = await run({ requestCap: 100 }, {}, p);
    expect(out.items).toHaveLength(1);
    expect(out.cursor.nextId).toBe(4331);
    expect(out.note).toContain('after repeated failures');

    const dead = provider(new Set(), () => true);
    await expect(run({ requestCap: 5 }, {}, dead)).rejects.toThrow(/every request failed/);
  });

  test('the cursor never rewinds before startId', () => {
    expect(resumeId({ nextId: 100 }, { startId: 4328 })).toBe(4328);
    expect(resumeId({ nextId: 5000 }, {})).toBe(5000);
    expect(resumeId({}, { startId: 5000 })).toBe(5000);
  });
});
