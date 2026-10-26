import { describe, expect, test } from 'bun:test';
import { fixtureItem, scheduleState } from '../packages/adapters/src/sportsdb-live.js';
import {
  DAY_CAP,
  dayUrl,
  parseDay,
  schedulePlan,
  sportsdbSchedule,
} from '../packages/adapters/src/sportsdb-schedule.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

const KEY = '90210';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A day-listing row, as eventsday.php writes one. */
const row = (id, over = {}) => ({
  idEvent: String(id),
  strTimestamp: '2026-10-27T07:00:00',
  strEvent: 'New Zealand Cricket vs India Cricket',
  strEventAlternate: 'India Cricket @ New Zealand Cricket',
  strSport: 'Cricket',
  idLeague: '4979',
  strLeague: 'Twenty20 International Series',
  strLeagueBadge: 'https://r2.thesportsdb.com/league.png',
  strSeason: '2026',
  strHomeTeam: 'New Zealand Cricket',
  strAwayTeam: 'India Cricket',
  idHomeTeam: '137145',
  idAwayTeam: '137143',
  strHomeTeamBadge: 'https://r2.thesportsdb.com/nz.png',
  strAwayTeamBadge: 'https://r2.thesportsdb.com/in.png',
  intHomeScore: null,
  intAwayScore: null,
  dateEvent: '2026-10-27',
  strTime: '07:00:00',
  strVenue: 'Hnry Stadium',
  strStatus: 'NS',
  ...over,
});

/** Answers a day from `days[day]`, or a sport within it from `bySport[day][sport]`. */
function provider({ days = {}, bySport = {}, sports = [] } = {}) {
  const calls = [];
  const http = {
    async request(url) {
      calls.push(url);
      const u = new URL(url);
      if (u.pathname.endsWith('/all_sports.php')) {
        return json({ sports: sports.map((strSport) => ({ strSport })) });
      }
      const day = u.searchParams.get('d');
      const sport = u.searchParams.get('s');
      if (sport) return json({ events: bySport[day]?.[sport] ?? null });
      return json({ events: days[day] ?? null });
    },
  };
  return { http, calls };
}

const NOW = Date.parse('2026-10-26T12:00:00Z');

const run = (p, { config = {}, key = KEY, cursor = {} } = {}) =>
  sportsdbSchedule.pull({
    config: { horizonDays: 2, backDays: 1, pauseMs: 0, ...config },
    cursor,
    env: { SPORTSDB_API_KEY: key },
    http: p.http,
    log: () => {},
    deadline: Date.now() + 60_000,
  });

describe('schedulePlan', () => {
  test('today first, then ahead, then the days behind', () => {
    expect(schedulePlan({ now: NOW, horizonDays: 3, backDays: 1 }).map((u) => u.day)).toEqual([
      '2026-10-26',
      '2026-10-27',
      '2026-10-28',
      '2026-10-25',
    ]);
  });
});

describe('scheduleState', () => {
  test('a blank status reads the clock instead of meaning in play', () => {
    expect(scheduleState('', '2026-10-27T07:00:00.000Z', NOW)).toBe('pre');
    expect(scheduleState(null, '2026-10-25T07:00:00.000Z', NOW)).toBe('post');
    // just started, nobody has said so: not invented as live
    expect(scheduleState('', '2026-10-26T11:00:00.000Z', NOW)).toBe('pre');
    expect(scheduleState('FT', '2026-10-27T07:00:00.000Z', NOW)).toBe('post');
    expect(scheduleState('2H', '2026-10-26T11:00:00.000Z', NOW)).toBe('in');
  });
});

describe('fixtureItem', () => {
  test('carries the consolidation contract keys', () => {
    const item = fixtureItem(row(2524756), { now: NOW });
    expect(item.externalId).toBe('thesportsdb:fixture:2524756');
    expect(item.publishedAt).toBe('2026-10-27T07:00:00.000Z');
    expect(item.tags).toContain('cricket');
    expect(item.tags).toContain('league:cricket-twenty20-international-series');
    expect(item.tags).not.toContain('live');
    expect(item.data.key).toBe('2524756');
    expect(item.data.sport).toBe('cricket');
    expect(item.data.league).toMatchObject({
      key: '4979',
      slug: 'cricket-twenty20-international-series',
      name: 'Twenty20 International Series',
    });
    expect(item.data.home).toMatchObject({
      key: 'thesportsdb/team/137145',
      name: 'New Zealand Cricket',
      logoUrl: 'https://r2.thesportsdb.com/nz.png',
    });
    expect(item.data.venue).toBe('Hnry Stadium');
    expect(item.data.state).toBe('pre');
    expect(normaliseItem(item).externalId).toBe(item.externalId);
  });
});

describe('sportsdbSchedule.pull', () => {
  test('does nothing on the shared test key', async () => {
    const p = provider();
    const out = await run(p, { key: '3' });
    expect(out.items).toEqual([]);
    expect(p.calls).toHaveLength(0);
    expect(out.note).toContain('SPORTSDB_API_KEY');
  });

  test('one request a day, and a game listed twice is one item', async () => {
    const p = provider({
      days: {
        '2026-10-26': [row(1), row(2, { strHomeTeam: '', strEvent: '' })],
        '2026-10-27': [row(3), row(1)],
      },
    });
    const out = await run(p);
    expect(p.calls).toHaveLength(3);
    expect(p.calls[0]).toBe(dayUrl(KEY, '2026-10-26'));
    expect(out.items.map((i) => i.data.key)).toEqual(['1', '3']);
    expect(out.cursor.next).toBeNull();
  });

  test('a day at the cap is asked again sport by sport', async () => {
    const full = Array.from({ length: DAY_CAP }, (_, i) => row(10_000 + i));
    const p = provider({
      days: { '2026-10-26': full },
      sports: ['Cricket', 'Darts'],
      bySport: {
        '2026-10-26': {
          Cricket: [row(10_000), row(99_001)],
          Darts: [row(99_002, { strSport: 'Darts', strLeague: 'PDC World Championship' })],
        },
      },
    });
    const out = await run(p);
    const keys = new Set(out.items.map((i) => i.data.key));
    expect(keys.has('99001')).toBe(true);
    expect(keys.has('99002')).toBe(true);
    expect(keys.size).toBe(DAY_CAP + 2);
    expect(p.calls.some((u) => u.includes('all_sports.php'))).toBe(true);
    expect(p.calls.some((u) => u.includes('&s=Darts'))).toBe(true);
  });

  test('stops at the request cap and resumes from the cursor', async () => {
    const p = provider({ days: { '2026-10-27': [row(5)] } });
    const first = await run(p, { config: { requestCap: 1 } });
    expect(first.cursor.next).toMatchObject({ sport: null });
    expect(first.nextInMinutes).toBe(10);
    const second = await run(p, { cursor: first.cursor });
    expect(second.items.map((i) => i.data.key)).toContain('5');
  });

  test('parseDay keeps a named event without sides, drops a row with neither', () => {
    const race = row(7, {
      strSport: 'Motorsport',
      strLeague: 'Formula 1',
      strEvent: 'Mexico City Grand Prix',
      strHomeTeam: null,
      strAwayTeam: null,
      idHomeTeam: null,
      idAwayTeam: null,
    });
    const blank = row(8, { strAwayTeam: null, strEvent: '' });
    expect(parseDay({ events: [row(1), race, blank] }).map((r) => r.idEvent)).toEqual(['1', '7']);
    expect(parseDay({ events: null })).toEqual([]);
    const item = fixtureItem(race, { now: NOW });
    expect(item.title).toBe('Mexico City Grand Prix');
    expect(item.data.sport).toBe('racing');
    expect(item.data.home.key).toBeNull();
  });

  test('the cap is counted on the raw rows, before side-less ones are judged', async () => {
    const full = Array.from({ length: DAY_CAP }, (_, i) =>
      row(20_000 + i, i < 10 ? { strHomeTeam: null, strEvent: '' } : {}),
    );
    const p = provider({ days: { '2026-10-26': full }, sports: ['Cricket'] });
    await run(p);
    expect(p.calls.some((u) => u.includes('&s=Cricket'))).toBe(true);
  });
});
