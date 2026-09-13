import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

import {
  link,
  list,
  parseTeam,
  REQUEST_CAP,
  resumeId,
  START_ID,
  sportsdbTeams,
  TAIL_MISSES,
  teamItem,
  teamLeagues,
  teamPageUrl,
  teamUrl,
} from '../packages/adapters/src/sportsdb-teams.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

const fixture = async (name) =>
  JSON.parse(
    await readFile(new URL(`../packages/adapters/test/fixtures/${name}`, import.meta.url), 'utf8'),
  );

const arsenal = await fixture('sportsdb-teams-arsenal.json');
const celtics = await fixture('sportsdb-teams-celtics.json');
const unknown = await fixture('sportsdb-teams-unknown.json');

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A fake TheSportsDB with teams at the given ids and null everywhere else. */
function provider(known = new Set([133597, 133598, 133600]), fail = () => false) {
  const urls = [];
  const http = {
    async request(url) {
      urls.push(url);
      const id = Number(new URL(url).searchParams.get('id'));
      if (fail(id)) return json({ error: 'nope' }, 500);
      if (!known.has(id)) return json(unknown);
      const row = { ...arsenal.teams[0], idTeam: String(id), strTeam: `Team ${id}` };
      return json({ teams: [row] });
    },
    async json(url) {
      throw new Error(`500 from ${url}`);
    },
  };
  return { http, urls };
}

const run = (overrides = {}, cursor = {}, p = provider()) =>
  sportsdbTeams.pull({
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

describe('teamItem', () => {
  test('one team row becomes one team item with the fields a reader wants', () => {
    const item = normaliseItem(teamItem(arsenal.teams[0]));
    expect(item.externalId).toBe('sportsdb:team:133604');
    expect(item.kind).toBe('team');
    expect(item.title).toBe('Arsenal');
    expect(item.url).toBe('https://www.thesportsdb.com/team/133604');
    expect(item.imageUrl).toMatch(/^https:\/\/r2\.thesportsdb\.com\/images\/media\/team\/badge\//);
    expect(item.tags).toContain('team');
    expect(item.tags).toContain('soccer');
    expect(item.tags).toContain('league:english-premier-league');
    expect(item.tags).toContain('league:fa-cup');
    expect(item.tags).toContain('country:england');
    expect(item.tags).toContain('gender:male');
    expect(item.data.provider).toBe('thesportsdb');
    expect(item.data.attribution).toContain('TheSportsDB');
    expect(item.data.leagueId).toBe('4328');
    expect(item.data.league).toBe('English Premier League');
    expect(item.data.leagues[1]).toEqual({ id: '4482', name: 'FA Cup', slug: 'fa-cup' });
    expect(item.data.sport).toBe('soccer');
    expect(item.data.sportName).toBe('Soccer');
    expect(item.data.country).toBe('England');
    expect(item.data.formedYear).toBe(1892);
    expect(item.data.stadium).toBe('Emirates Stadium');
    expect(item.data.stadiumLocation).toBe('Holloway, London, England');
    expect(item.data.stadiumCapacity).toBe(60338);
    expect(item.data.website).toBe('https://www.arsenal.com');
    expect(item.data.socials.twitter).toBe('https://twitter.com/arsenal');
    expect(item.data.alternateNames).toEqual(['Arsenal Football Club', 'AFC', 'Arsenal FC']);
    expect(item.data.colours).toEqual(['#EF0107', '#fbffff', '#013373']);
    expect(item.data.badge).toBe(item.imageUrl);
    expect(item.data.logo).toMatch(/\/team\/logo\//);
    expect(item.data.gender).toBe('Male');
    expect(item.data.espnId).toBe('359');
    expect(item.data.apiFootballId).toBe('42');
    expect(item.data.description.startsWith('Arsenal Football Club is a professional')).toBe(true);
    expect(item.summary.length).toBeLessThanOrEqual(600);
  });

  test('a basketball team is tagged by its sport slug and every league it names', () => {
    const item = normaliseItem(teamItem(celtics.teams[0]));
    expect(item.externalId).toBe('sportsdb:team:134860');
    expect(item.title).toBe('Boston Celtics');
    expect(item.tags).toContain('basketball');
    expect(item.tags).toContain('league:nba');
    expect(item.tags).toContain('league:nba-cup');
    expect(item.tags).toContain('country:united-states');
    expect(item.data.leagueId).toBe('4387');
    expect(item.data.leagues.map((l) => l.name)).toEqual(['NBA', 'NBA Cup', 'NBA Summer League']);
    expect(item.data.stadium).toBe('TD Garden');
    expect(item.data.espnId).toBeNull();
    expect(item.data.colours).toEqual(['#007a33', '#FFFFFF']);
    expect(item.data.alternateNames).toEqual([]);
  });

  test('the logo stands in when there is no badge, and a missing description falls back', () => {
    const row = { ...arsenal.teams[0], strBadge: '', strDescriptionEN: null };
    const item = normaliseItem(teamItem(row));
    expect(item.imageUrl).toBe(row.strLogo);
    expect(item.summary).toBe('Soccer · English Premier League · England');
  });

  test('helpers: leagues, links, lists, ids that mean nothing', () => {
    expect(
      teamLeagues({ strLeague: 'NBA', idLeague: '4387', strLeague2: '', idLeague2: '' }),
    ).toEqual([{ id: '4387', name: 'NBA', slug: 'nba' }]);
    expect(
      teamLeagues({ strLeague: 'X', idLeague: '1', strLeague3: 'X', idLeague3: '1' }),
    ).toHaveLength(1);
    expect(link('www.arsenal.com')).toBe('https://www.arsenal.com');
    expect(link('https://www.nba.com/celtics')).toBe('https://www.nba.com/celtics');
    expect(link('')).toBeNull();
    expect(list('A, B,,C ')).toEqual(['A', 'B', 'C']);
    expect(list(null)).toEqual([]);
    expect(teamItem({ ...arsenal.teams[0], idESPN: '0' }).data.espnId).toBeNull();
  });

  test('an unknown id is null, a page url is plain', () => {
    expect(parseTeam(unknown)).toBeNull();
    expect(parseTeam({ teams: null })).toBeNull();
    expect(parseTeam({})).toBeNull();
    expect(parseTeam(arsenal)?.idTeam).toBe('133604');
    expect(teamPageUrl('134860')).toBe('https://www.thesportsdb.com/team/134860');
  });

  test('the key rides in the path and never in an item', () => {
    expect(teamUrl('abc', 133604)).toBe(
      'https://www.thesportsdb.com/api/v1/json/abc/lookupteam.php?id=133604',
    );
    expect(JSON.stringify(teamItem(arsenal.teams[0]))).not.toContain('/json/3/');
  });
});

describe('the walk', () => {
  test('stops at the cap and resumes from the cursor', async () => {
    const p = provider();
    const first = await run({ requestCap: 2 }, {}, p);
    expect(first.items.map((i) => i.externalId)).toEqual([
      'sportsdb:team:133597',
      'sportsdb:team:133598',
    ]);
    expect(first.cursor.nextId).toBe(133599);
    expect(first.cursor.topId).toBe(133598);
    expect(first.nextInMinutes).toBe(10);
    expect(first.note).toContain('stopped at the request cap');
    expect(JSON.parse(JSON.stringify(first.cursor))).toEqual(first.cursor);

    const second = await run({ requestCap: 2 }, first.cursor, p);
    expect(second.items.map((i) => i.externalId)).toEqual(['sportsdb:team:133600']);
    expect(second.cursor.nextId).toBe(133601);
    expect(p.urls).toHaveLength(4);
  });

  test('a run of unknown ids ends the pass and the next run starts over', async () => {
    const p = provider();
    const out = await run({ requestCap: 100, tailMisses: 5 }, {}, p);
    expect(out.items).toHaveLength(3);
    expect(out.cursor.nextId).toBeNull();
    expect(out.cursor.topId).toBe(133600);
    expect(out.cursor.walkedAt).toMatch(/^\d{4}-/);
    expect(out.nextInMinutes).toBeUndefined();
    expect(out.note).toContain('past the newest team');
    // 133597, 133598, 133599 (miss), 133600, then five misses 133601..133605
    expect(p.urls).toHaveLength(9);
    expect(resumeId(out.cursor, {})).toBe(START_ID);
  });

  test('a gap of one is not the tail', async () => {
    const p = provider(new Set([133597, 133599]));
    const out = await run({ requestCap: 100, tailMisses: 3 }, {}, p);
    expect(out.items.map((i) => i.externalId)).toEqual([
      'sportsdb:team:133597',
      'sportsdb:team:133599',
    ]);
  });

  test('repeated failures stop the run without losing the place, and a dead provider throws', async () => {
    const p = provider(new Set([133597]), (id) => id >= 133598);
    const out = await run({ requestCap: 100 }, {}, p);
    expect(out.items).toHaveLength(1);
    expect(out.cursor.nextId).toBe(133600);
    expect(out.note).toContain('after repeated failures');
    expect(out.nextInMinutes).toBe(10);

    const dead = provider(new Set(), () => true);
    await expect(run({ requestCap: 5 }, {}, dead)).rejects.toThrow(/every request failed/);
  });

  test('the cursor never rewinds before startId', () => {
    expect(resumeId({ nextId: 100 }, { startId: 133597 })).toBe(133597);
    expect(resumeId({ nextId: 150000 }, {})).toBe(150000);
    expect(resumeId({}, { startId: 140000 })).toBe(140000);
  });

  test('the adapter says what it is and no prose carries an em dash', () => {
    expect(sportsdbTeams.name).toBe('sportsdb-teams');
    expect(sportsdbTeams.collection).toBe('sports');
    expect(sportsdbTeams.kinds).toEqual(['team']);
    expect(sportsdbTeams.cadenceMinutes).toBe(1440);
    expect(sportsdbTeams.defaultSources[0].slug).toBe('sportsdb-teams');
    expect(sportsdbTeams.description).toMatch(/terms of use/i);
    expect(sportsdbTeams.description).not.toContain(String.fromCharCode(0x2014));
  });
});
