import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { V2_BASE } from '../packages/adapters/src/sportsdb.js';
import {
  liveItem,
  livePath,
  liveState,
  liveTime,
  parseLive,
  sportsdbLive,
} from '../packages/adapters/src/sportsdb-live.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

const fixture = async (name) =>
  JSON.parse(
    await readFile(new URL(`../packages/adapters/test/fixtures/${name}`, import.meta.url), 'utf8'),
  );

const live = await fixture('sportsdb-livescore.json');
const KEY = '90210';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function provider(body = live, status = 200) {
  const calls = [];
  const http = {
    async request(url, options) {
      calls.push({ url, headers: options?.headers ?? {} });
      return json(body, status);
    },
  };
  return { http, calls };
}

const run = (p, { config = {}, key = KEY } = {}) =>
  sportsdbLive.pull({
    config,
    cursor: {},
    env: { SPORTSDB_API_KEY: key },
    http: p.http,
    log: () => {},
    deadline: Date.now() + 60_000,
  });

describe('liveState', () => {
  test('reads the terse per-sport codes', () => {
    expect(liveState('NS')).toBe('pre');
    expect(liveState('FT')).toBe('post');
    expect(liveState('CANC')).toBe('post');
    expect(liveState('P3')).toBe('in');
    expect(liveState('1H')).toBe('in');
    expect(liveState('Q3')).toBe('in');
    // an unknown code is a game in play, not a game dropped
    expect(liveState('WHATEVER')).toBe('in');
    expect(liveState(null)).toBe('in');
  });
});

describe('liveTime', () => {
  test('reads a zoneless stamp as UTC, not as local time', () => {
    expect(liveTime({ strTimestamp: '2026-09-23T15:30:00' })).toBe('2026-09-23T15:30:00.000Z');
  });

  test('keeps a zone when there is one', () => {
    expect(liveTime({ strTimestamp: '2026-09-23T15:30:00Z' })).toBe('2026-09-23T15:30:00.000Z');
  });

  test('falls back to the day and the clock', () => {
    expect(liveTime({ dateEvent: '2026-09-24', strEventTime: '19:00' })).toBe(
      '2026-09-24T19:00:00.000Z',
    );
    expect(liveTime({})).toBeNull();
  });
});

describe('parseLive', () => {
  test('drops a row with no event id or no sides', () => {
    expect(parseLive(live)).toHaveLength(2);
    expect(parseLive({})).toEqual([]);
    expect(parseLive({ livescore: null })).toEqual([]);
  });
});

describe('liveItem', () => {
  const [hockey, soccer] = parseLive(live).map(liveItem);

  test('is a fixture under this provider, never ESPN', () => {
    expect(hockey.kind).toBe('fixture');
    expect(hockey.externalId).toBe('thesportsdb:fixture:2589337');
    expect(hockey.url).toBe('https://www.thesportsdb.com/event/2589337');
    expect(normaliseItem(hockey)).toBeTruthy();
  });

  test('carries the score, the state and the raw status code', () => {
    expect(hockey.title).toBe('Kosice vs Slovan Bratislava');
    expect(hockey.data.homeScore).toBe(2);
    expect(hockey.data.awayScore).toBe(4);
    expect(hockey.data.state).toBe('in');
    expect(hockey.data.statusCode).toBe('P3');
    expect(hockey.data.progress).toBe('20');
    expect(hockey.data.unplayed).toBe(false);
    expect(hockey.summary).toContain('2-4');
    expect(hockey.tags).toContain('state:in');
    expect(hockey.tags).toContain('hockey');
    expect(hockey.tags).toContain('league:slovak-extraliga');
    expect(hockey.tags).toContain('team:kosice');
  });

  test('a game that has not started has no score and is tagged pre', () => {
    expect(soccer.data.homeScore).toBeNull();
    expect(soccer.data.state).toBe('pre');
    expect(soccer.tags).toContain('state:pre');
    expect(soccer.publishedAt).toBe('2026-09-24T19:00:00.000Z');
    expect(soccer.summary).not.toContain('0-0');
    // an empty badge is not a URL
    expect(soccer.imageUrl).toBeNull();
  });
});

describe('livePath', () => {
  test('is the whole world by default and one sport when asked', () => {
    expect(livePath({})).toBe('livescore/all');
    expect(livePath({ sport: 'all' })).toBe('livescore/all');
    expect(livePath({ sport: 'ice_hockey' })).toBe('livescore/ice_hockey');
  });
});

describe('sportsdb-live', () => {
  test('one request, key in the header, and the URL free of it', async () => {
    const p = provider();
    const out = await run(p);
    expect(p.calls).toHaveLength(1);
    expect(p.calls[0].url).toBe(`${V2_BASE}/livescore/all`);
    expect(p.calls[0].url).not.toContain(KEY);
    expect(p.calls[0].headers['X-API-KEY']).toBe(KEY);
    expect(out.items).toHaveLength(2);
    expect(out.note).toContain('1 in play');
  });

  test('the shared test key has no live endpoint, so nothing is asked for', async () => {
    const p = provider();
    const out = await run(p, { key: '3' });
    expect(p.calls).toHaveLength(0);
    expect(out.items).toEqual([]);
    expect(out.note).toContain('SPORTSDB_API_KEY');
  });

  test('an outage is an error the run reports, with no key in it', async () => {
    const p = provider({ error: 'nope' }, 500);
    expect(run(p)).rejects.toThrow(/live unavailable/);
  });

  test('the same game twice in one answer is one item', async () => {
    const rows = live.livescore;
    const p = provider({ livescore: [rows[0], rows[0], rows[1]] });
    const out = await run(p);
    expect(out.items).toHaveLength(2);
  });
});
