import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

import {
  accountPath,
  accountUrl,
  headlineOf,
  measure,
  parseRoster,
  playerItem,
  playerPage,
  profileDoc,
  REQUEST_CAP,
  resumeId,
  rosterUrl,
  START_ID,
  sportsdbPlayers,
  TAIL_MISSES,
  websiteUrl,
} from '../packages/adapters/src/sportsdb-players.js';
import { normaliseItem } from '../packages/core/src/adapter.js';
import { assemble, keysOf } from '../packages/core/src/profiles.js';

const fixture = async (name) =>
  JSON.parse(
    await readFile(new URL(`../packages/adapters/test/fixtures/${name}`, import.meta.url), 'utf8'),
  );

const liverpool = await fixture('sportsdb-players-liverpool.json');
const hawks = await fixture('sportsdb-players-hawks.json');
const unknown = await fixture('sportsdb-players-null.json');

const isak = liverpool.player.find((p) => p.strPlayer === 'Alexander Isak');
const alisson = liverpool.player.find((p) => p.strPlayer === 'Alisson Becker');
const iraola = liverpool.player.find((p) => p.strPlayer === 'Andoni Iraola');
const wirtz = liverpool.player.find((p) => p.strPlayer === 'Florian Wirtz');
const veesaar = hawks.player.find((p) => p.strPlayer === 'Henri Veesaar');

const EM_DASH = String.fromCharCode(0x2014);

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A fake TheSportsDB: rosters at the given team ids, null everywhere else. */
function provider(
  rosters = new Map([
    [133602, liverpool],
    [133603, hawks],
    [133605, liverpool],
  ]),
  fail = () => false,
) {
  const urls = [];
  const http = {
    async request(url, opts) {
      urls.push(url);
      if (!opts?.headers?.['user-agent']?.includes('nichedb')) return json({ error: 'who' }, 403);
      const id = Number(new URL(url).searchParams.get('id'));
      if (fail(id)) return json({ error: 'nope' }, 500);
      return json(rosters.get(id) ?? unknown);
    },
    async json(url) {
      throw new Error(`500 from ${url}`);
    },
  };
  return { http, urls };
}

const run = (overrides = {}, cursor = {}, p = provider()) =>
  sportsdbPlayers.pull({
    config: {
      startId: 133602,
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

describe('reading a roster', () => {
  test('a roster is the rows with an id and a name, an unknown team is empty', () => {
    expect(parseRoster(liverpool).map((r) => r.idPlayer)).toEqual([
      '34163447',
      '34163551',
      '34149298',
      '34173012',
    ]);
    expect(parseRoster(unknown)).toEqual([]);
    expect(parseRoster({})).toEqual([]);
    expect(
      parseRoster({
        player: [
          { idPlayer: '1', strPlayer: 'A' },
          { idPlayer: '1', strPlayer: 'A again' },
          { idPlayer: null, strPlayer: 'No id' },
          { idPlayer: '2', strPlayer: '' },
          null,
        ],
      }),
    ).toHaveLength(1);
  });

  test('accounts arrive as handles or URLs and leave as one URL each', () => {
    expect(accountPath('alex_isak', 'x')).toBe('alex_isak');
    expect(accountPath('@alex_isak', 'x')).toBe('alex_isak');
    expect(accountPath('twitter.com/alex_isak', 'x')).toBe('alex_isak');
    expect(accountPath('https://x.com/alex_isak/', 'x')).toBe('alex_isak');
    expect(accountPath('http://www.instagram.com/alex_isak', 'instagram')).toBe('alex_isak');
    expect(accountPath('www.instagram.com/flowirtz_61/?hl=en', 'instagram')).toBe('flowirtz_61');
    expect(accountPath('www.facebook.com/AlissonBeckerOficial', 'facebook')).toBe(
      'AlissonBeckerOficial',
    );
    expect(accountPath('facebook.com/pages/Some-Club/1234/', 'facebook')).toBe(
      'pages/Some-Club/1234',
    );
    expect(accountPath('https://www.youtube.com/@MrBeast', 'youtube')).toBe('@MrBeast');
    expect(accountPath('youtube.com/channel/UCAddYoRhmxqsRSt4zV4E2_g', 'youtube')).toBe(
      'channel/UCAddYoRhmxqsRSt4zV4E2_g',
    );
    expect(accountPath('UCAddYoRhmxqsRSt4zV4E2_g', 'youtube')).toBe(
      'channel/UCAddYoRhmxqsRSt4zV4E2_g',
    );
    expect(accountPath('', 'x')).toBeNull();
    expect(accountPath(null, 'x')).toBeNull();
    expect(accountPath('www.premierleague.com/alex', 'x')).toBeNull();
    expect(accountPath('alex isak', 'x')).toBeNull();
    expect(accountPath('alex_isak', 'myspace')).toBeNull();
    expect(accountUrl('twitter.com/alex_isak', 'x')).toBe('https://x.com/alex_isak');
    expect(accountUrl('www.facebook.com/codygakpo/', 'facebook')).toBe(
      'https://www.facebook.com/codygakpo',
    );
    expect(accountUrl(null, 'instagram')).toBeNull();
  });

  test('a website gets a scheme, a measure gets a unit when bare', () => {
    expect(websiteUrl('www.alissonbecker.com')).toBe('https://www.alissonbecker.com');
    expect(websiteUrl('https://shop.example.com/')).toBe('https://shop.example.com/');
    expect(websiteUrl('')).toBeNull();
    expect(measure('1.92 m (6 ft 4 in)', 'height')).toBe('1.92 m (6 ft 4 in)');
    expect(measure('1.81', 'height')).toBe('1.81 m');
    expect(measure('185', 'height')).toBe('185 cm');
    expect(measure('73.47', 'weight')).toBe('73.47 kg');
    expect(measure('170 lbs', 'weight')).toBe('170 lbs');
    expect(measure('0', 'weight')).toBeNull();
    expect(measure(null, 'height')).toBeNull();
  });

  test('the headline is position and team, else the sport', () => {
    expect(headlineOf(isak)).toBe('Centre-Forward for Liverpool');
    expect(headlineOf(iraola)).toBe('Manager for Liverpool');
    expect(headlineOf({ strPosition: 'Goalkeeper' })).toBe('Goalkeeper');
    expect(headlineOf({ strTeam: 'Liverpool' })).toBe('Plays for Liverpool');
    expect(headlineOf({ strSport: 'Soccer' })).toBe('Soccer');
    expect(headlineOf({})).toBe('Athlete');
  });

  test('the key rides in the path and never in an item', () => {
    expect(rosterUrl('abc', 133602)).toBe(
      'https://www.thesportsdb.com/api/v1/json/abc/lookup_all_players.php?id=133602',
    );
    expect(rosterUrl(undefined, 1)).toContain('/json/3/');
    expect(playerPage('34163447')).toBe('https://www.thesportsdb.com/player/34163447');
    expect(JSON.stringify(playerItem(isak, '2026-09-13T06:00:00.000Z'))).not.toContain('/json/');
  });
});

describe('the document', () => {
  test('is a valid OpenProfile.md whose accounts are the identity keys', () => {
    const doc = profileDoc(isak);
    expect(doc).not.toContain(EM_DASH);
    const parsed = assemble([doc], null);
    expect(parsed.name).toBe('Alexander Isak');
    expect(parsed.headline).toBe('Centre-Forward for Liverpool');
    expect(parsed.identity.find((e) => e.key === 'Kind')?.value).toBe('person');
    expect(parsed.identity.find((e) => e.key === 'Handle')?.value).toBe('alexander-isak-34163447');
    expect(parsed.identity.find((e) => e.key === 'Avatar')?.value).toMatch(
      /^https:\/\/r2\.thesportsdb\.com\/images\/media\/player\/cutout\//,
    );
    expect(parsed.identity.find((e) => e.key === 'Web')).toBeUndefined();
    const keys = keysOf(doc);
    expect(keys.some((k) => k.includes('thesportsdb.com/player/34163447'))).toBe(true);
    expect(keys.some((k) => k.includes('x.com/alex_isak'))).toBe(true);
    expect(keys.some((k) => k.includes('instagram.com/alex_isak'))).toBe(true);
    expect(keys.some((k) => k.includes('wikidata.org/wiki/q23759917'))).toBe(true);
    expect(keys.some((k) => k.includes('facebook'))).toBe(false);
    expect(doc).toContain('## Topics');
    expect(doc).toContain('- Soccer');
    expect(doc).toContain('- Liverpool');
    expect(doc).toContain(
      'Born 1999-09-21, from Sweden, height 1.92 m (6 ft 4 in), weight 170 lbs. Compiled by NicheDB from TheSportsDB (player 34163447).',
    );
    // The player page comes first, so it is the primary key.
    expect(doc.indexOf('thesportsdb.com/player/34163447')).toBeLessThan(doc.indexOf('x.com/'));
  });

  test('every social a row has, normalised, in the fixed order', () => {
    const doc = profileDoc(alisson);
    const accounts = doc
      .split('## Accounts')[1]
      .split('## Topics')[0]
      .split('\n')
      .filter((l) => l.startsWith('- '))
      .map((l) => l.slice(2));
    expect(accounts).toEqual([
      'https://www.thesportsdb.com/player/34163551',
      'https://x.com/Alissonbecker',
      'https://www.instagram.com/alissonbecker',
      'https://www.facebook.com/AlissonBeckerOficial',
      'https://www.wikidata.org/wiki/Q18237361',
    ]);
    expect(profileDoc(wirtz)).toContain('- https://www.instagram.com/flowirtz_61\n');
    expect(profileDoc(wirtz)).not.toContain('hl=en');
  });

  test('a bare weight gets a unit and a manager is a person too', () => {
    const doc = profileDoc(iraola);
    expect(doc).toContain('Manager for Liverpool');
    expect(doc).toContain('weight 73.47 kg');
    expect(assemble([doc], null).name).toBe('Andoni Iraola');
  });

  test('no cutout falls back to the thumb; no Wikidata id, no Wikidata line', () => {
    const doc = profileDoc(veesaar);
    const parsed = assemble([doc], null);
    expect(parsed.identity.find((e) => e.key === 'Avatar')?.value).toMatch(
      /\/images\/media\/player\/thumb\//,
    );
    expect(parsed.headline).toBe('Center for Atlanta Hawks');
    expect(doc).not.toContain('wikidata');
    expect(keysOf(doc).some((k) => k.includes('thesportsdb.com/player/34436687'))).toBe(true);
  });

  test('the item is what the core absorbs', () => {
    const item = normaliseItem(playerItem(isak, '2026-09-13T06:00:00.000Z'));
    expect(item.kind).toBe('openprofile');
    expect(item.externalId).toBe('https://www.thesportsdb.com/player/34163447');
    expect(item.url).toBe(item.externalId);
    expect(item.title).toBe('Alexander Isak');
    expect(item.summary).toBe('Centre-Forward for Liverpool');
    expect(item.imageUrl).toMatch(/cutout/);
    expect(item.data.app).toBe('thesportsdb');
    expect(item.data.source_url).toBe(item.externalId);
    expect(item.data.page_url).toBe(item.externalId);
    expect(item.data.listing).toBe('https://www.thesportsdb.com/team/133602');
    expect(item.data.wikidata).toBe('Q23759917');
    expect(typeof item.data.doc).toBe('string');
    expect(item.tags).toEqual([
      'openprofile',
      'from:thesportsdb',
      'sport:soccer',
      'team:liverpool',
    ]);
    const hawk = normaliseItem(playerItem(veesaar, '2026-09-13T06:00:00.000Z'));
    expect(hawk.tags).toContain('sport:basketball');
    expect(hawk.tags).toContain('team:atlanta-hawks');
  });
});

describe('the walk', () => {
  test('walks to the tail, one document per player, and the next run starts over', async () => {
    const p = provider();
    const out = await run({ requestCap: 100, tailMisses: 5 }, {}, p);
    // Liverpool twice (133602 and 133605) is still four people, plus three Hawks.
    expect(out.items).toHaveLength(7);
    expect(new Set(out.items.map((i) => i.externalId)).size).toBe(7);
    expect(out.items.every((i) => i.kind === 'openprofile')).toBe(true);
    expect(out.cursor.nextId).toBeNull();
    expect(out.cursor.topId).toBe(133605);
    expect(out.cursor.walkedAt).toMatch(/^\d{4}-/);
    expect(out.cursor.freeKey).toBe(true);
    expect(out.nextInMinutes).toBeUndefined();
    expect(out.note).toContain('7 players from 3 teams in 9 lookups');
    expect(out.note).toContain('past the newest team');
    expect(out.note).not.toContain(EM_DASH);
    // 133602, 133603, 133604 (miss), 133605, then five misses 133606..133610
    expect(p.urls).toHaveLength(9);
    expect(p.urls[0]).toBe(
      'https://www.thesportsdb.com/api/v1/json/3/lookup_all_players.php?id=133602',
    );
    expect(resumeId(out.cursor, { startId: 133602 })).toBe(133602);
  });

  test('stops at the cap and resumes from the cursor', async () => {
    const p = provider();
    const first = await run({ requestCap: 2 }, {}, p);
    expect(first.items).toHaveLength(7);
    expect(first.cursor.nextId).toBe(133604);
    expect(first.cursor.topId).toBe(133603);
    expect(first.nextInMinutes).toBe(10);
    expect(first.note).toContain('stopped at the request cap at 133604');

    const second = await run({ requestCap: 2 }, first.cursor, p);
    expect(second.items.map((i) => i.title)).toEqual([
      'Alexander Isak',
      'Alisson Becker',
      'Andoni Iraola',
      'Florian Wirtz',
    ]);
    expect(second.cursor.nextId).toBe(133606);
    expect(second.cursor.topId).toBe(133605);
    expect(p.urls).toHaveLength(4);
    expect(JSON.parse(JSON.stringify(second.cursor))).toEqual(second.cursor);
  });

  test('a gap is not the tail', async () => {
    const p = provider(
      new Map([
        [133602, hawks],
        [133609, liverpool],
      ]),
    );
    const out = await run({ requestCap: 100, tailMisses: 10 }, {}, p);
    expect(out.items).toHaveLength(7);
    expect(out.cursor.topId).toBe(133609);
  });

  test('repeated failures stop the run without losing the place, and a dead provider throws', async () => {
    const p = provider(undefined, (id) => id >= 133603);
    const out = await run({ requestCap: 100 }, {}, p);
    expect(out.items).toHaveLength(4);
    expect(out.cursor.nextId).toBe(133605);
    expect(out.note).toContain('after repeated failures');
    expect(out.note).toContain('3 failed');
    expect(p.urls).toHaveLength(4);

    const dead = provider(undefined, () => true);
    await expect(run({ requestCap: 5 }, {}, dead)).rejects.toThrow(/every request failed/);
  });

  test('a single bad row never stops the roster', async () => {
    const p = provider(
      new Map([
        [
          133602,
          { player: [{ idPlayer: null, strPlayer: 'Nobody' }, ...liverpool.player.slice(0, 1)] },
        ],
      ]),
    );
    const out = await run({ requestCap: 3, tailMisses: 2 }, {}, p);
    expect(out.items.map((i) => i.title)).toEqual(['Alexander Isak']);
  });

  test('the cursor never rewinds before startId', () => {
    expect(resumeId({ nextId: 100 }, { startId: 133602 })).toBe(133602);
    expect(resumeId({ nextId: 140000 }, {})).toBe(140000);
    expect(resumeId({}, {})).toBe(START_ID);
    expect(resumeId({ nextId: null }, { startId: 133602 })).toBe(133602);
  });
});
