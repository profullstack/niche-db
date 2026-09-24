import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import {
  leagueIndex,
  PACE_MS,
  paceMs,
  premium,
  V2_BASE,
} from '../packages/adapters/src/sportsdb.js';
import { sportsdbLeagues } from '../packages/adapters/src/sportsdb-leagues.js';
import { parseTeams, sportsdbTeams } from '../packages/adapters/src/sportsdb-teams.js';

/**
 * The subscriber-key paths: both catalogues walk a list from the v2 API instead
 * of guessing at ids. The shared test key's walks are covered by
 * sports-leagues.test.js and sports-sportsdb-teams.test.js, which these must
 * not disturb.
 */

const fixture = async (name) =>
  JSON.parse(
    await readFile(new URL(`../packages/adapters/test/fixtures/${name}`, import.meta.url), 'utf8'),
  );

const catalogue = await fixture('sportsdb-v2-leagues.json');
const epl = await fixture('sportsdb-league.json');
const arsenal = await fixture('sportsdb-teams-arsenal.json');

const KEY = '90210';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * A fake TheSportsDB on a subscriber key: the v2 catalogue, a league lookup for
 * any id, and a team search that answers per league name.
 */
function provider({ fail = () => false, teamsPerLeague = 2 } = {}) {
  const calls = [];
  const http = {
    async request(url, options) {
      calls.push({ url, headers: options?.headers ?? {} });
      if (url.startsWith(V2_BASE)) {
        if (fail('catalogue')) return json({ error: 'nope' }, 500);
        return json(catalogue);
      }
      const u = new URL(url);
      if (u.pathname.endsWith('lookupleague.php')) {
        const id = u.searchParams.get('id');
        if (fail(id)) return json({ error: 'nope' }, 500);
        return json({ leagues: [{ ...epl.leagues[0], idLeague: id, strLeague: `League ${id}` }] });
      }
      if (u.pathname.endsWith('search_all_teams.php')) {
        const league = u.searchParams.get('l');
        if (fail(league)) return json({ error: 'nope' }, 500);
        if (league === 'NHL') return json({ teams: null });
        const teams = [];
        for (let i = 0; i < teamsPerLeague; i++) {
          teams.push({
            ...arsenal.teams[0],
            // the same team in two leagues, to prove a run keeps it once
            idTeam: String(133600 + i),
            strTeam: `${league} team ${i}`,
          });
        }
        return json({ teams });
      }
      return json({ error: 'unexpected' }, 404);
    },
  };
  return { http, calls };
}

const run = (adapter, p, { config = {}, cursor = {} } = {}) =>
  adapter.pull({
    config: { pauseMs: 0, ...config },
    cursor,
    env: { SPORTSDB_API_KEY: KEY },
    http: p.http,
    log: () => {},
    deadline: Date.now() + 60_000,
  });

describe('premium detection', () => {
  test('the shared test keys are not premium and pace slowly', () => {
    expect(premium('3')).toBe(false);
    expect(premium('123')).toBe(false);
    expect(premium(undefined)).toBe(false);
    expect(paceMs('3')).toBe(PACE_MS.free);
  });

  test('any other key is, and paces at the subscriber limit', () => {
    expect(premium(KEY)).toBe(true);
    expect(paceMs(KEY)).toBe(PACE_MS.premium);
    expect(PACE_MS.premium).toBeLessThan(PACE_MS.free);
  });
});

describe('leagueIndex', () => {
  test('reads the v2 catalogue, deduped, with the key in a header', async () => {
    const p = provider();
    const rows = await leagueIndex(p.http, KEY);
    expect(rows.map((r) => r.id)).toEqual(['4328', '4424', '4380']);
    expect(rows[0]).toEqual({ id: '4328', name: 'English Premier League', sport: 'Soccer' });
    expect(p.calls[0].url).toBe(`${V2_BASE}/all/leagues`);
    expect(p.calls[0].headers['X-API-KEY']).toBe(KEY);
    // the v2 key never rides in the URL
    expect(p.calls[0].url).not.toContain(KEY);
  });

  test('an answer with no list is an error, not an empty pass', async () => {
    const http = {
      async request() {
        return json({ nothing: true });
      },
    };
    expect(leagueIndex(http, KEY)).rejects.toThrow(/no league list/);
  });
});

describe('sportsdb-leagues on a subscriber key', () => {
  test('lists the catalogue once, then looks up every league in it', async () => {
    const p = provider();
    const out = await run(sportsdbLeagues, p);
    expect(out.items).toHaveLength(3);
    expect(out.items.map((i) => i.data.leagueId)).toEqual(['4328', '4424', '4380']);
    // one catalogue request, then one lookup per league
    expect(p.calls).toHaveLength(4);
    expect(out.cursor.ids).toBeNull();
    expect(out.cursor.total).toBe(3);
    expect(out.cursor.freeKey).toBe(false);
    expect(out.cursor.walkedAt).toBeTruthy();
    expect(out.note).toContain('1-3 of 3');
    // no id guessing: the free key's cursor fields are gone
    expect(out.cursor.nextId).toBeUndefined();
  });

  test('a capped run carries the list in the cursor and resumes inside it', async () => {
    const p = provider();
    const first = await run(sportsdbLeagues, p, { config: { requestCap: 2 } });
    expect(first.items).toHaveLength(2);
    expect(first.cursor.ids).toEqual(['4328', '4424', '4380']);
    expect(first.cursor.at).toBe(2);
    expect(first.nextInMinutes).toBe(10);

    const p2 = provider();
    const second = await run(sportsdbLeagues, p2, {
      config: { requestCap: 2 },
      cursor: first.cursor,
    });
    expect(second.items).toHaveLength(1);
    expect(second.items[0].data.leagueId).toBe('4380');
    // the catalogue is not listed again mid-pass
    expect(p2.calls.filter((c) => c.url.startsWith(V2_BASE))).toHaveLength(0);
    expect(second.cursor.ids).toBeNull();
    expect(second.cursor.at).toBe(0);
  });

  test('a failing league is skipped, and a wholly failing run throws', async () => {
    const p = provider({ fail: (id) => id === '4424' });
    const out = await run(sportsdbLeagues, p);
    expect(out.items.map((i) => i.data.leagueId)).toEqual(['4328', '4380']);
    expect(out.note).toContain('1 failed');

    const all = provider({ fail: () => true });
    expect(run(sportsdbLeagues, all)).rejects.toThrow();
  });
});

describe('sportsdb-teams on a subscriber key', () => {
  test('asks per league and keeps a team that plays in two of them once', async () => {
    const p = provider();
    const out = await run(sportsdbTeams, p);
    // three leagues, two teams each, all sharing two ids -> two rows
    expect(out.items).toHaveLength(2);
    expect(new Set(out.items.map((i) => i.externalId)).size).toBe(2);
    expect(out.items[0].kind).toBe('team');
    const asked = p.calls
      .filter((c) => c.url.includes('search_all_teams.php'))
      .map((c) => new URL(c.url).searchParams.get('l'));
    expect(asked).toEqual(['English Premier League', 'MLB', 'NHL']);
    // never the team id walk
    expect(p.calls.some((c) => c.url.includes('lookupteam.php'))).toBe(false);
    expect(out.cursor.leagues).toBeNull();
    expect(out.note).toContain('1 with no teams');
  });

  test('a capped run resumes at the next league', async () => {
    const p = provider();
    const first = await run(sportsdbTeams, p, { config: { requestCap: 1 } });
    expect(first.cursor.at).toBe(1);
    expect(first.cursor.leagues).toEqual(['English Premier League', 'MLB', 'NHL']);

    const p2 = provider();
    const second = await run(sportsdbTeams, p2, {
      config: { requestCap: 1 },
      cursor: first.cursor,
    });
    const asked = p2.calls
      .filter((c) => c.url.includes('search_all_teams.php'))
      .map((c) => new URL(c.url).searchParams.get('l'));
    expect(asked).toEqual(['MLB']);
    expect(second.cursor.at).toBe(2);
  });

  test('parseTeams drops rows with no id or name', () => {
    expect(parseTeams({ teams: null })).toEqual([]);
    expect(parseTeams({ teams: [{ idTeam: '1' }, { strTeam: 'x' }] })).toEqual([]);
    expect(parseTeams({ teams: [{ idTeam: '1', strTeam: 'x' }] })).toHaveLength(1);
  });
});
