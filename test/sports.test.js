import { afterEach, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

import {
  ambiguousAbbreviations,
  canonicalBroadcaster,
  catalogueFresh,
  drawBelongsTo,
  earliestUpcoming,
  espnCatalogue,
  espnLive,
  espnSchedule,
  fetchSchedule,
  fixtureItem,
  fixtureTitle,
  horizonWindow,
  keepsWatch,
  leagueItem,
  leagueKeysOf,
  leagueNameFromTeams,
  leagueSlug,
  leaguesInWindow,
  liveTargets,
  liveWorthy,
  makeEspnClient,
  nearWindow,
  normaliseState,
  oddsFromCompetition,
  parseLeagueDetail,
  parseLeagueRefs,
  parseScoreboard,
  parseSports,
  parseTeams,
  proxyUsable,
  regionFor,
  resetProxyBreaker,
  skipSportsOf,
  slugFromRef,
  startOf,
  teamItem,
  USER_AGENT,
  utcDay,
  yyyymmdd,
} from '../packages/adapters/src/espn.js';
import {
  budgetFrom,
  displayClock,
  livetennis,
  mergeMatches,
  normaliseMatch,
  reserveFor,
  scoreDetail,
  side,
  stateOf,
  statusDetail,
  TOURS,
  fixtureItem as tennisFixtureItem,
  leagueItem as tourItem,
  tournamentItems,
  tourOf,
  wins,
} from '../packages/adapters/src/livetennis.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

const fixture = async (name) =>
  JSON.parse(
    await readFile(new URL(`../packages/adapters/test/fixtures/${name}`, import.meta.url), 'utf8'),
  );

const nfl = await fixture('espn-scoreboard-nfl.json');
const tennis = await fixture('espn-scoreboard-tennis.json');
const nflTeams = await fixture('espn-teams-nfl.json');
const eng1 = await fixture('espn-league-eng1.json');
const catalogue = await fixture('espn-catalogue.json');
const lt = await fixture('livetennis-matches.json');

const NFL = {
  key: 'football/nfl',
  sport: 'football',
  leagueKey: 'nfl',
  slug: 'football-nfl',
  priority: 1,
};
const ATP = {
  key: 'tennis/atp',
  sport: 'tennis',
  leagueKey: 'atp',
  slug: 'tennis-atp',
  priority: 3,
};
const WTA = {
  key: 'tennis/wta',
  sport: 'tennis',
  leagueKey: 'wta',
  slug: 'tennis-wta',
  priority: 3,
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** An `http` helper whose `request` answers from a router, recording every URL. */
function fakeHttp(route) {
  const urls = [];
  return {
    urls,
    async request(url, opts) {
      urls.push({ url, opts });
      const r = await route(url);
      return r ?? json({ error: 'not found' }, 404);
    },
  };
}

/* ------------------------------------------------------------- catalogue -- */

describe('espn catalogue parsing', () => {
  test('the slug rule keeps dot and underscore variants apart', () => {
    // ESPN really ships both; folding both separators to `-` collapses them.
    expect(leagueSlug('soccer', 'fifa.intercontinental_cup')).not.toBe(
      leagueSlug('soccer', 'fifa.intercontinental.cup'),
    );
    expect(leagueSlug('soccer', 'eng.1')).toBe('soccer-eng-1');
  });

  test('sports and leagues are read off the $ref links, not fetched one by one', () => {
    const sports = parseSports(catalogue.sports);
    expect(sports.length).toBe(17);
    expect(sports).toContain('soccer');
    expect(slugFromRef('http://x/v2/sports/soccer/leagues/eng.1?lang=en', 'leagues')).toBe('eng.1');
    expect(slugFromRef('garbage', 'leagues')).toBeNull();

    const leagues = parseLeagueRefs('soccer', catalogue.soccerLeagues);
    const keys = leagues.map((l) => l.key);
    expect(keys).toContain('soccer/fifa.intercontinental_cup');
    expect(keys).toContain('soccer/fifa.intercontinental.cup');
    expect(new Set(leagues.map((l) => l.slug)).size).toBe(leagues.length);
    const world = leagues.find((l) => l.leagueKey === 'fifa.world');
    expect(world.priority).toBe(1);
    expect(world.slug).toBe('soccer-fifa-world');
    expect(leagues.find((l) => l.leagueKey === 'fifa.wwc').priority).toBe(100);
  });

  test('the league detail carries the real name and, for domestic soccer, the country', () => {
    expect(parseLeagueDetail(eng1)).toEqual({
      name: 'English Premier League',
      abbreviation: 'Premier League',
      logoUrl: 'https://a.espncdn.com/i/leaguelogos/soccer/500/23.png',
      region: 'England',
    });
    expect(parseLeagueDetail(null)).toBeNull();
  });

  test('curation wins over the provider for the leagues whose chip names another competition', () => {
    expect(regionFor('basketball/nbl', null)).toBe('Australia');
    expect(regionFor('soccer/eng.1', 'England')).toBe('England');
    expect(regionFor('hockey/nhl', null)).toBeNull();
  });

  test('a league item follows the contract', () => {
    const league = {
      key: 'soccer/eng.1',
      sport: 'soccer',
      leagueKey: 'eng.1',
      slug: 'soccer-eng-1',
      priority: 1,
    };
    const item = leagueItem(league, parseLeagueDetail(eng1), { teams: 20 });
    expect(item.externalId).toBe('espn:league:soccer:soccer-eng-1');
    expect(item.kind).toBe('league');
    expect(item.title).toBe('English Premier League');
    expect(item.publishedAt).toBeNull();
    expect(item.tags).toEqual(['league', 'soccer', 'region:england']);
    expect(item.data).toMatchObject({
      provider: 'espn',
      sport: 'soccer',
      slug: 'soccer-eng-1',
      key: 'soccer/eng.1',
      abbreviation: 'Premier League',
      region: 'England',
      priority: 1,
      abbrAmbiguous: false,
      supersededBy: null,
      plays_supported: true,
      teams: 20,
    });
    // A league the detail endpoint 404s for still gets a row, named by its key.
    const bare = leagueItem({ ...league, leagueKey: 'x.9', slug: 'soccer-x-9' }, {});
    expect(bare.title).toBe('x.9');
    expect(normaliseItem(bare)).not.toBeNull();
  });

  test('an abbreviation shared by several leagues is flagged, a duplicate key is pointed home', () => {
    const ambiguous = ambiguousAbbreviations({ a: 'BFC', b: 'bfc', c: 'NFL', d: null });
    expect([...ambiguous]).toEqual(['bfc']);
    const bfc = leagueItem(
      { key: 'mma/bfc', sport: 'mma', leagueKey: 'bfc', slug: 'mma-bfc' },
      { abbreviation: 'BFC' },
      { ambiguous },
    );
    expect(bfc.data.abbrAmbiguous).toBe(true);
    expect(bfc.data.plays_supported).toBe(false);
    const dup = leagueItem({
      key: 'soccer/concacaf.champions_cup',
      sport: 'soccer',
      leagueKey: 'concacaf.champions_cup',
      slug: 'soccer-concacaf-champions_cup',
    });
    expect(dup.data.supersededBy).toBe('soccer/concacaf.champions');
  });

  test('teams are keyed by league, because ESPN team ids collide across leagues', () => {
    const teams = parseTeams(NFL, nflTeams);
    expect(teams.length).toBe(3);
    const [ari] = teams;
    expect(ari.key).toBe('football/nfl/22');
    expect(ari.slug).toBe('football-nfl-22');
    expect(ari.displayName).toBe('Arizona Cardinals');
    expect(ari.logoUrl).toMatch(/^https:\/\//);
    expect(ari.url).toContain('espn.com/nfl/team');
    expect(leagueNameFromTeams(nflTeams)).toEqual({
      name: 'National Football League',
      abbreviation: 'NFL',
    });
    expect(parseTeams(NFL, null)).toEqual([]);

    const item = teamItem(NFL, ari);
    expect(item.externalId).toBe('espn:team:football/nfl/22');
    expect(item.kind).toBe('team');
    expect(item.tags).toEqual(['team', 'football', 'league:football-nfl']);
    expect(item.data).toMatchObject({
      provider: 'espn',
      sport: 'football',
      abbreviation: 'ARI',
      location: 'Arizona',
      leagues: ['football-nfl'],
    });
    expect(item.data.color).toBeTruthy();
  });
});

/* -------------------------------------------------------------- fixtures -- */

describe('espn fixtures', () => {
  const { league, events } = parseScoreboard(nfl, NFL);
  const [pre, post] = events;

  test('the scoreboard carries the league name the catalogue endpoint lacks', () => {
    expect(league).toEqual({
      name: 'National Football League',
      abbreviation: 'NFL',
      logoUrl: 'https://a.espncdn.com/i/teamlogos/leagues/500/nfl.png',
    });
  });

  test('a scheduled game: sides, venue, broadcaster, records, and the line', () => {
    expect(pre.key).toBe('football/nfl/401872657');
    expect(pre.state).toBe('pre');
    expect(pre.publishedAt.toISOString()).toBe('2026-09-11T00:35:00.000Z');
    expect(pre.timeKnown).toBe(true);
    expect(pre.precision).toBe('minute');
    expect(pre.home.displayName).toBe('Los Angeles Rams');
    expect(pre.away.displayName).toBe('San Francisco 49ers');
    expect(pre.home.key).toBe('football/nfl/14');
    expect(pre.home.record).toBe('0-0');
    expect(pre.venue).toBe('Melbourne Cricket Ground');
    expect(pre.venueCity).toBe('Melbourne');
    // US venues carry a state, everywhere else a country; this one has both and
    // the state wins, which is the provider's own convention.
    expect(pre.venueRegion).toBe('VIC');
    expect(pre.neutralSite).toBe(true);
    expect(pre.broadcast).toBe('Netflix');
    expect(pre.broadcastNames).toEqual(['Netflix']);
    // Zero is how ESPN says "not reported", not how it says an empty ground.
    expect(pre.attendance).toBeNull();
    expect(pre.url).toContain('gameId/401872657');
    expect(pre.odds).toMatchObject({
      provider: 'DraftKings',
      details: 'LAR -3.5',
      spread: -3.5,
      overUnder: 48.5,
      favorite: 'home',
      homeMoneyline: -198,
      awayMoneyline: 164,
      drawMoneyline: null,
      capturedState: 'pre',
      opening: { spread: -2.5, overUnder: 48.5, homeMoneyline: -155, awayMoneyline: 130 },
    });
  });

  test('a finished game: scores, period, attendance, and no line', () => {
    expect(post.state).toBe('post');
    expect(post.statusDetail).toBe('Final');
    expect(post.home.score).toBe(13);
    expect(post.away.score).toBe(10);
    expect(post.home.record).toBe('1-0');
    expect(post.period).toBe(4);
    expect(post.attendance).toBe(68744);
    expect(post.venueRegion).toBe('WA');
    expect(post.neutralSite).toBe(false);
    expect(post.odds).toBeNull();
  });

  test('the fixture item follows the contract', () => {
    const item = fixtureItem(pre, NFL, league);
    expect(item.externalId).toBe('espn:fixture:football/nfl/401872657');
    expect(item.kind).toBe('fixture');
    // Nobody is at home in Melbourne, so "vs" rather than "at".
    expect(item.title).toBe('San Francisco 49ers vs Los Angeles Rams');
    expect(item.summary).toBe('SF VS LAR');
    expect(item.imageUrl).toBe(pre.home.logoUrl);
    expect(item.publishedAt.toISOString()).toBe('2026-09-11T00:35:00.000Z');
    expect(item.tags).toEqual([
      'fixture',
      'football',
      'league:football-nfl',
      'state:pre',
      'team:football-nfl-14',
      'team:football-nfl-25',
    ]);
    expect(item.data.league).toEqual({
      slug: 'football-nfl',
      key: 'football/nfl',
      name: 'National Football League',
      abbreviation: 'NFL',
      region: null,
    });
    expect(item.data).toMatchObject({
      provider: 'espn',
      sport: 'football',
      state: 'pre',
      neutralSite: true,
      broadcast: 'Netflix',
      broadcastSource: 'espn',
      broadcastMarkets: [{ country: 'United States', channels: ['Netflix'] }],
      scoreDetail: null,
      plays_supported: true,
      boxscoreSupported: true,
      tournament: false,
    });
    expect(item.data.home).toMatchObject({
      id: '14',
      abbreviation: 'LAR',
      score: 0,
      record: '0-0',
    });
    expect(item.data.odds.details).toBe('LAR -3.5');
    const stored = normaliseItem(item);
    expect(stored.tags).toContain('state:pre');
    expect(stored.precision).toBe('minute');

    const done = fixtureItem(post, NFL, league);
    expect(done.title).toBe('New England Patriots at Seattle Seahawks');
    expect(done.tags).toContain('state:post');
    expect(done.data.broadcastMarkets).toEqual([{ country: 'United States', channels: ['NBC'] }]);
  });

  test('a fixture whose time ESPN padded is stored at day precision', () => {
    const e = structuredClone(nfl.events[0]);
    e.competitions[0].timeValid = false;
    const [f] = parseScoreboard({ events: [e] }, NFL).events;
    expect(f.timeKnown).toBe(false);
    expect(f.precision).toBe('day');
    expect(startOf({ date: 'nonsense' }, {})).toEqual({
      publishedAt: null,
      timeKnown: false,
      precision: 'day',
    });
  });

  test('state is pre/in/post and nothing else', () => {
    expect(normaliseState({ status: { type: { state: 'in' } } })).toBe('in');
    expect(normaliseState({ status: { type: { state: 'post' } } })).toBe('post');
    expect(normaliseState({ status: { type: { state: 'weird' } } })).toBe('pre');
    expect(normaliseState(null)).toBe('pre');
  });

  test('an individual sport with no competitors still yields a fixture', () => {
    const [f] = parseScoreboard(
      {
        events: [
          {
            id: '99',
            date: '2026-08-21T10:30Z',
            name: 'Heineken Dutch GP',
            status: { type: { state: 'pre' } },
            competitions: [{ status: { type: { state: 'pre' } }, competitors: [] }],
          },
        ],
      },
      { key: 'racing/f1', sport: 'racing', leagueKey: 'f1', slug: 'racing-f1' },
    ).events;
    expect(f.home).toBeNull();
    expect(fixtureTitle(f)).toBe('Heineken Dutch GP');
    const item = fixtureItem(f, {
      key: 'racing/f1',
      sport: 'racing',
      leagueKey: 'f1',
      slug: 'racing-f1',
    });
    expect(item.tags).toEqual(['fixture', 'racing', 'league:racing-f1', 'state:pre']);
    expect(item.data.plays_supported).toBe(false);
  });

  test('broadcaster truncations are spelled out, everything else passes through', () => {
    expect(canonicalBroadcaster('NBC Sports CA')).toBe('NBC Sports California');
    expect(canonicalBroadcaster('MLB.TV')).toBe('MLB.TV');
    expect(canonicalBroadcaster(null)).toBe('');
  });
});

describe('espn odds', () => {
  /** Shapes copied from live ESPN responses on tipoffwatch, 2026-09-06. */
  const nflOdds = [
    {
      provider: { id: '100', name: 'DraftKings', priority: 1 },
      details: 'SEA -3.5',
      overUnder: 44.5,
      spread: -3.5,
      awayTeamOdds: { favorite: false, underdog: true },
      homeTeamOdds: { favorite: true, underdog: false },
      moneyline: {
        home: { close: { odds: '-185' }, open: { odds: '-175' } },
        away: { close: { odds: '154' }, open: { odds: '148' } },
      },
      pointSpread: {
        home: { close: { line: '-3.5' }, open: { line: '-2.5' } },
        away: { close: { line: '+3.5' }, open: { line: '+2.5' } },
      },
      total: {
        over: { close: { line: 'o44.5' }, open: { line: 'o46.5' } },
        under: { close: { line: 'u44.5' }, open: { line: 'u46.5' } },
      },
    },
  ];
  const mlbPickcenter = [
    {
      provider: { id: '100', name: 'DraftKings', priority: 1 },
      details: 'CHC -126',
      overUnder: 8.5,
      spread: 1.5,
      awayTeamOdds: { favorite: true, underdog: false, moneyLine: -126 },
      homeTeamOdds: { favorite: false, underdog: true, moneyLine: 105 },
    },
  ];

  test('reads the scoreboard container, moneyline nested under close, with the opening', () => {
    const line = oddsFromCompetition({ odds: nflOdds }, { state: 'pre', now: new Date(0) });
    expect(line).toMatchObject({
      provider: 'DraftKings',
      details: 'SEA -3.5',
      spread: -3.5,
      overUnder: 44.5,
      favorite: 'home',
      homeMoneyline: -185,
      awayMoneyline: 154,
      capturedState: 'pre',
      capturedAt: '1970-01-01T00:00:00.000Z',
      opening: { spread: -2.5, overUnder: 46.5, homeMoneyline: -175, awayMoneyline: 148 },
    });
  });

  test('reads the pickcenter container, where the moneyline is a plain number and has no history', () => {
    const line = oddsFromCompetition({ odds: mlbPickcenter }, { state: 'post' });
    expect(line).toMatchObject({
      details: 'CHC -126',
      favorite: 'away',
      homeMoneyline: 105,
      awayMoneyline: -126,
      capturedState: 'post',
      opening: null,
    });
  });

  test('a finished game has no line, in either spelling of empty', () => {
    expect(oddsFromCompetition({ odds: null })).toBeNull();
    expect(oddsFromCompetition({ odds: [] })).toBeNull();
    expect(oddsFromCompetition({ odds: [null] })).toBeNull();
    expect(oddsFromCompetition({})).toBeNull();
    expect(
      oddsFromCompetition({
        odds: [{ provider: { name: 'DK' }, awayTeamOdds: {}, homeTeamOdds: {} }],
      }),
    ).toBeNull();
  });

  test('a settled, absurd moneyline is dropped rather than shown', () => {
    const settled = [
      {
        provider: { name: 'DraftKings' },
        details: 'USC -37.5',
        spread: -37.5,
        overUnder: 61.5,
        homeTeamOdds: { favorite: true, moneyLine: -100000 },
        awayTeamOdds: { underdog: true, moneyLine: 5000 },
      },
    ];
    const line = oddsFromCompetition({ odds: settled }, { state: 'post' });
    expect(line.homeMoneyline).toBeNull();
    expect(line.awayMoneyline).toBe(5000);
    expect(line.spread).toBe(-37.5);
  });

  test('soccer prices the draw', () => {
    const soccer = [
      {
        provider: { name: 'Bet365' },
        details: 'EVEN',
        moneyline: {
          home: { close: { odds: '+150' } },
          away: { close: { odds: '+180' } },
          draw: { close: { odds: '+230' } },
        },
      },
    ];
    expect(oddsFromCompetition({ odds: soccer }).drawMoneyline).toBe(230);
  });
});

describe('espn tennis', () => {
  test('a tournament fans out into itself and its matches, split by draw between the tours', () => {
    const atp = parseScoreboard(tennis, ATP).events;
    const wta = parseScoreboard(tennis, WTA).events;
    const tournaments = atp.filter((e) => e.tournament);
    const matches = atp.filter((e) => !e.tournament);
    expect(tournaments.length).toBe(1);
    expect(tournaments[0].key).toBe('tennis/atp/718-2026');
    expect(tournaments[0].name).toBe('Cincinnati Open');
    expect(tournaments[0].venue).toBe('Lindner Family Tennis Center');
    expect(matches.length).toBe(1);
    // The women's doubles draw belongs to the WTA board, and to it alone.
    expect(wta.filter((e) => !e.tournament).map((e) => e.id)).toEqual(['182450']);
    expect(drawBelongsTo('mixed-doubles', 'atp')).toBe(true);
    expect(drawBelongsTo('mixed-doubles', 'wta')).toBe(false);
    expect(drawBelongsTo(null, 'wta')).toBe(true);
  });

  test('a match reads sets won, the court, and both players as followable sides', () => {
    const [m] = parseScoreboard(tennis, ATP).events.filter((e) => !e.tournament);
    expect(m.key).toBe('tennis/atp/184414');
    expect(m.name).toBe("Dane Sweeny vs Christopher O'Connell");
    expect(m.shortName).toBe("D. Sweeny vs C. O'Connell");
    expect(m.publishedAt.toISOString()).toBe('2026-08-11T16:05:00.000Z');
    expect(m.state).toBe('post');
    // Games per set are not a scoreline anyone quotes; this went 2-1 to O'Connell.
    expect({ away: m.away.score, home: m.home.score }).toEqual({ away: 1, home: 2 });
    expect(m.venue).toBe('Cincinnati Open');
    expect(m.venueCity).toBe('Cincinnati, USA · Court 9');
    expect(m.neutralSite).toBe(true);
    expect(m.away.logoUrl).toContain('aus.png');
    expect(m.period).toBe(3);

    const item = fixtureItem(m, ATP, { name: 'ATP Tour', abbreviation: 'ATP' });
    expect(item.externalId).toBe('espn:fixture:tennis/atp/184414');
    expect(item.tags).toEqual([
      'fixture',
      'tennis',
      'league:tennis-atp',
      'state:post',
      'team:tennis-atp-3301',
      'team:tennis-atp-4030',
    ]);
    expect(item.data.plays_supported).toBe(false);
  });

  test('an undrawn bracket slot is not a fixture, and a doubles pair is one side', () => {
    const atp = parseScoreboard(tennis, ATP).events;
    expect(atp.some((e) => /TBD/.test(e.name))).toBe(false);
    expect(atp.some((e) => e.id === '999999')).toBe(false);
    const [d] = parseScoreboard(tennis, WTA).events.filter((e) => !e.tournament);
    expect(d.away.name).toBe('Ulrikke Eikeri / Quinn Gleason');
    expect(d.away.key).toBe('tennis/wta/1652-3970');
    expect(d.away.logoUrl).toContain('nor.png');
  });

  test('the tournament row is tagged so a reader can leave the headers out', () => {
    const [t] = parseScoreboard(tennis, ATP).events.filter((e) => e.tournament);
    const item = fixtureItem(t, ATP);
    expect(item.externalId).toBe('espn:fixture:tennis/atp/718-2026');
    expect(item.title).toBe('Cincinnati Open');
    expect(item.tags).toContain('tournament');
    expect(item.data.tournament).toBe(true);
    expect(item.data.home).toBeNull();
  });
});

/* --------------------------------------------------------------- windows -- */

describe('espn windows and cursor arithmetic', () => {
  const now = Date.parse('2026-09-10T12:00:00Z');

  test('the near window reaches six hours back and the configured hours forward', () => {
    const { from, to } = nearWindow(now, 72);
    expect(from.toISOString()).toBe('2026-09-10T06:00:00.000Z');
    expect(to.toISOString()).toBe('2026-09-13T12:00:00.000Z');
    // Garbage config falls back to a day rather than a zero-width window.
    expect(nearWindow(now, 'x').to.getTime()).toBeGreaterThan(now);
    expect(horizonWindow(now, 30).to.toISOString()).toBe('2026-10-10T12:00:00.000Z');
    expect(yyyymmdd(new Date(now))).toBe('20260910');
    expect(utcDay(now)).toBe('2026-09-10');
  });

  test('a league is in the near pass when its next fixture is inside the window, or it has never been asked', () => {
    const leagues = [{ key: 'a' }, { key: 'b' }, { key: 'c' }, { key: 'd' }, { key: 'e' }];
    const upcoming = {
      a: '2026-09-10T20:00:00Z',
      b: '2026-09-20T20:00:00Z',
      c: null,
      d: '2026-09-10T08:00:00Z',
    };
    expect(leaguesInWindow(leagues, upcoming, now, 72).map((l) => l.key)).toEqual(['a', 'd', 'e']);
  });

  test('the earliest upcoming start ignores what finished more than six hours ago', () => {
    const at = (iso) => ({ publishedAt: new Date(iso) });
    expect(
      earliestUpcoming(
        [at('2026-09-09T12:00:00Z'), at('2026-09-12T12:00:00Z'), at('2026-09-11T12:00:00Z')],
        now,
      ),
    ).toBe('2026-09-11T12:00:00.000Z');
    expect(earliestUpcoming([at('2026-09-10T07:00:00Z')], now)).toBe('2026-09-10T07:00:00.000Z');
    expect(earliestUpcoming([], now)).toBeNull();
    expect(earliestUpcoming([{ publishedAt: null }], now)).toBeNull();
  });

  test('the live tick keeps what is on, what is about to start, and what just finished', () => {
    const f = (state, iso) => ({ state, publishedAt: new Date(iso) });
    expect(liveWorthy(f('in', '2026-09-01T00:00:00Z'), now)).toBe(true);
    expect(liveWorthy(f('pre', '2026-09-10T13:30:00Z'), now)).toBe(true);
    expect(liveWorthy(f('pre', '2026-09-10T14:30:00Z'), now)).toBe(false);
    expect(liveWorthy(f('pre', '2026-09-10T11:00:00Z'), now)).toBe(false);
    expect(liveWorthy(f('post', '2026-09-10T02:00:00Z'), now)).toBe(true);
    expect(liveWorthy(f('post', '2026-09-09T02:00:00Z'), now)).toBe(false);
    expect(liveWorthy({ state: 'in', publishedAt: null }, now)).toBe(false);

    expect(keepsWatch([f('post', '2026-09-10T02:00:00Z')], now)).toBe(false);
    expect(keepsWatch([f('pre', '2026-09-10T13:00:00Z')], now)).toBe(true);
    expect(keepsWatch([f('pre', '2026-09-11T13:00:00Z')], now)).toBe(false);
    expect(keepsWatch([f('in', '2026-09-10T11:00:00Z')], now)).toBe(true);
  });

  test('the live tick asks the watch list first, then a rolling slice that wraps', () => {
    const leagues = ['a', 'b', 'c', 'd', 'e'].map((key) => ({ key }));
    const r1 = liveTargets({ leagues, watch: { d: 'x' }, scanIdx: 3, probe: 3 });
    expect(r1.targets).toEqual(['d', 'e', 'a']);
    expect(r1.scanIdx).toBe(1);
    const r2 = liveTargets({ leagues, watch: {}, scanIdx: r1.scanIdx, probe: 3 });
    expect(r2.targets).toEqual(['b', 'c', 'd']);
    // Pinned leagues replace discovery entirely.
    const pinned = liveTargets({ leagues, watch: { a: 'x' }, scanIdx: 0, probe: 3, pinned: ['e'] });
    expect(pinned.targets).toEqual(['e']);
    expect(pinned.scanIdx).toBe(0);
  });

  test('config lists arrive as arrays or comma strings, slugs resolve to keys', () => {
    expect(skipSportsOf({ skipSports: ['Tennis', ' golf '] })).toEqual(['tennis', 'golf']);
    expect(skipSportsOf({ skipSports: 'tennis,golf' })).toEqual(['tennis', 'golf']);
    expect(skipSportsOf({})).toEqual([]);
    const cat = [NFL, ATP];
    expect(leagueKeysOf({ leagues: 'football-nfl, tennis/atp' }, cat)).toEqual([
      'football/nfl',
      'tennis/atp',
    ]);
    expect(leagueKeysOf({ leagues: [] }, cat)).toEqual([]);
  });

  test('a cached catalogue is fresh for a day', () => {
    expect(catalogueFresh({ leagues: [NFL], leaguesAt: Date.now() - 1000 })).toBe(true);
    expect(catalogueFresh({ leagues: [NFL], leaguesAt: Date.now() - 25 * 3_600_000 })).toBe(false);
    expect(catalogueFresh({ leagues: [], leaguesAt: Date.now() })).toBe(false);
    expect(catalogueFresh({})).toBe(false);
  });
});

/* ---------------------------------------------------------------- access -- */

describe('espn client', () => {
  afterEach(() => resetProxyBreaker());

  test('direct requests carry the curl-prefixed user agent ESPN accepts', async () => {
    const http = fakeHttp(() => json({ ok: 1 }));
    const client = makeEspnClient({ env: {}, http });
    expect(await client.get('https://x/y')).toEqual({ ok: 1 });
    expect(http.urls[0].opts.headers['user-agent']).toBe(USER_AGENT);
    expect(USER_AGENT).toMatch(/^curl\//);
    expect(client.proxied).toBe(false);
  });

  test('a proxy answering 402 trips the breaker and the request goes direct', async () => {
    const seen = [];
    const fetchImpl = async (_url, opts) => {
      seen.push(opts.proxy ?? 'direct');
      return opts.proxy
        ? new Response('Bandwidth limit reached', { status: 402 })
        : json({ via: 'direct' });
    };
    const http = fakeHttp(() => json({ via: 'http' }));
    const log = [];
    const client = makeEspnClient({
      env: { sportsProxyUrl: 'http://user:pw@proxy:1' },
      http,
      log: (m) => log.push(m),
      fetchImpl,
    });
    expect(await client.get('https://x/a')).toEqual({ via: 'http' });
    expect(seen).toEqual(['http://user:pw@proxy:1']);
    expect(proxyUsable()).toBe(false);
    expect(log[0]).toContain('402');
    expect(log[0]).toContain('Bandwidth limit');
    // Inside the cooldown the proxy is not even tried.
    await client.get('https://x/b');
    expect(seen.length).toBe(1);
    resetProxyBreaker();
    expect(proxyUsable()).toBe(true);
  });

  test('a proxy that will not connect is the same fault; ESPN refusing the proxy is not', async () => {
    const http = fakeHttp(() => json({ via: 'http' }));
    const dead = makeEspnClient({
      env: { SPORTS_PROXY_URL: 'http://proxy:1' },
      http,
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(await dead.get('https://x/a')).toEqual({ via: 'http' });
    expect(proxyUsable()).toBe(false);
    resetProxyBreaker();

    const blocked = makeEspnClient({
      env: { sportsProxyUrl: 'http://proxy:1' },
      http,
      fetchImpl: async () => new Response('Access Denied', { status: 403 }),
    });
    await expect(blocked.get('https://x/a')).rejects.toThrow(/403 \(via proxy\)/);
    // A 403 is ESPN's answer, so the breaker stays closed and http was not asked.
    expect(proxyUsable()).toBe(true);
    expect(http.urls.length).toBe(1);
  });
});

describe('espn fetchSchedule', () => {
  const clientFor = (route) => {
    const calls = [];
    return {
      calls,
      client: {
        async get(url) {
          calls.push(url);
          const r = route(url);
          if (r instanceof Error) throw r;
          return r;
        },
      },
    };
  };
  const notFound = () => Object.assign(new Error('espn 404'), { status: 404 });

  test('a 404 on a date window falls back to the undated board only when asked', async () => {
    const { client, calls } = clientFor((url) => (url.includes('dates=') ? notFound() : nfl));
    const from = new Date('2026-09-10T00:00:00Z');
    const to = new Date('2026-09-12T00:00:00Z');
    const r = await fetchSchedule(client, { league: NFL, from, to });
    expect(r.events.length).toBe(2);
    expect(calls.length).toBe(2);
    expect(calls[0]).toContain('dates=20260910-20260912');
    expect(calls[1]).not.toContain('dates=');

    const quiet = await fetchSchedule(client, { league: NFL, from, to, fallback: false });
    expect(quiet.events).toEqual([]);
  });

  test('a full page is split by date, never into a backwards range', async () => {
    const ranges = [];
    const { client } = clientFor((url) => {
      const m = /dates=(\d{8})-(\d{8})/.exec(url);
      if (m) ranges.push([m[1], m[2]]);
      return {
        events: Array.from({ length: 100 }, (_, i) => ({
          id: `${ranges.length}-${i}`,
          date: '2026-08-25T12:00Z',
          name: 'G',
          status: { type: { state: 'pre' } },
          competitions: [{ status: { type: { state: 'pre' } }, competitors: [] }],
        })),
      };
    });
    const r = await fetchSchedule(client, {
      league: NFL,
      from: new Date('2026-08-01T00:00:00Z'),
      to: new Date('2026-08-29T00:00:00Z'),
    });
    expect(ranges.length).toBeGreaterThan(1);
    for (const [a, b] of ranges) expect(Number(a)).toBeLessThanOrEqual(Number(b));
    expect(new Set(r.events.map((e) => e.key)).size).toBe(r.events.length);

    ranges.length = 0;
    await fetchSchedule(client, {
      league: NFL,
      from: new Date('2026-08-30T00:00:00Z'),
      to: new Date('2026-08-31T00:00:00Z'),
    });
    expect(ranges).toEqual([['20260830', '20260831']]);
  });
});

/* ----------------------------------------------------------------- pulls -- */

/** A two-sport ESPN, answered from the fixtures, for the adapters' cursor logic. */
function fakeEspn({ onScoreboard } = {}) {
  return fakeHttp((url) => {
    if (url.endsWith('/sports?limit=50')) {
      return json({
        items: [
          { $ref: 'http://x/v2/sports/football?lang=en' },
          { $ref: 'http://x/v2/sports/tennis?lang=en' },
          { $ref: 'http://x/v2/sports/soccer?lang=en' },
        ],
      });
    }
    if (url.includes('/sports/football/leagues?')) {
      return json({
        items: [
          { $ref: 'http://x/v2/sports/football/leagues/nfl?lang=en' },
          { $ref: 'http://x/v2/sports/football/leagues/college-football?lang=en' },
        ],
      });
    }
    if (url.includes('/sports/tennis/leagues?')) {
      return json({ items: [{ $ref: 'http://x/v2/sports/tennis/leagues/atp?lang=en' }] });
    }
    if (url.includes('/sports/soccer/leagues?')) {
      return json({ items: [{ $ref: 'http://x/v2/sports/soccer/leagues/eng.1?lang=en' }] });
    }
    if (url.includes('/leagues/eng.1')) return json(eng1);
    if (url.includes('/leagues/nfl'))
      return json({ name: 'National Football League', abbreviation: 'NFL' });
    if (url.includes('/teams?')) return url.includes('football/nfl') ? json(nflTeams) : null;
    if (url.includes('/scoreboard')) return onScoreboard ? onScoreboard(url) : json(nfl);
    return null;
  });
}

const ctx = (http, extra = {}) => ({
  config: {},
  cursor: {},
  env: {},
  http,
  log: () => {},
  budget: 150,
  deadline: Date.now() + 60_000,
  ...extra,
});

describe('espn-catalogue pull', () => {
  test('pages through the leagues on its budget and cursor, then completes', async () => {
    const http = fakeEspn();
    const config = { ...espnCatalogue.defaults };
    // Two requests per league and a budget of 4: two leagues per run, three
    // leagues after tennis is skipped, ordered by priority.
    const r1 = await espnCatalogue.pull(ctx(http, { config, budget: 4 }));
    expect(r1.nextInMinutes).toBe(1);
    expect(r1.cursor.idx).toBe(2);
    expect(r1.cursor.leagues.map((l) => l.key)).toEqual([
      'football/nfl',
      'soccer/eng.1',
      'football/college-football',
    ]);
    const kinds = r1.items.map((i) => i.kind);
    expect(kinds.filter((k) => k === 'league').length).toBe(2);
    expect(kinds.filter((k) => k === 'team').length).toBe(3);
    const nflLeague = r1.items.find((i) => i.externalId === 'espn:league:football:football-nfl');
    expect(nflLeague.title).toBe('National Football League');
    expect(nflLeague.data.teams).toBe(3);
    const epl = r1.items.find((i) => i.externalId === 'espn:league:soccer:soccer-eng-1');
    expect(epl.tags).toContain('region:england');

    const r2 = await espnCatalogue.pull(ctx(http, { config, budget: 4, cursor: r1.cursor }));
    expect(r2.nextInMinutes).toBeUndefined();
    expect(r2.cursor.idx).toBe(0);
    expect(r2.cursor.sweptDay).toBe(utcDay());
    expect(r2.items.map((i) => i.externalId)).toEqual([
      'espn:league:football:football-college-football',
    ]);
    // No roster endpoint answered for it, so it is named by its key.
    expect(r2.items[0].title).toBe('college-football');
    // The abbreviation map for next sweep's ambiguity check is complete.
    expect(Object.keys(r2.cursor.abbr).sort()).toEqual([
      'football/college-football',
      'football/nfl',
      'soccer/eng.1',
    ]);
    // The catalogue listing was fetched once, not once per run.
    expect(http.urls.filter((u) => u.url.endsWith('/sports?limit=50')).length).toBe(1);
  });

  test('every ESPN adapter names the sports collection and its own default source', () => {
    for (const a of [espnCatalogue, espnSchedule, espnLive]) {
      expect(a.collection).toBe('sports');
      expect(a.defaultSources[0].slug).toBe(a.name);
      for (const s of a.defaultSources) {
        for (const k of Object.keys(s.config ?? {})) {
          expect(a.configFields.map((f) => f.key)).toContain(k);
        }
      }
    }
    expect(espnCatalogue.kinds).toEqual(['league', 'team']);
    expect(espnSchedule.kinds).toEqual(['fixture']);
    expect(espnLive.cadenceMinutes).toBe(1);
  });
});

/**
 * The schedule adapter reads the real clock, so a board copied from ESPN on a
 * given day is a board of games already played once that day has gone. Move
 * every game two days ahead of now for the tests that need it upcoming.
 */
function soon(board) {
  const when = new Date(Date.now() + 2 * 86_400_000).toISOString();
  return { ...board, events: (board.events ?? []).map((e) => ({ ...e, date: when })) };
}

describe('espn-schedule pull', () => {
  test('sweeps the horizon on the first run of the day, then only the near window', async () => {
    const boards = [];
    const http = fakeEspn({
      onScoreboard: (url) => {
        boards.push(url);
        return url.includes('football/nfl') ? json(soon(nfl)) : json({ events: [] });
      },
    });
    const config = { ...espnSchedule.defaults };
    const r1 = await espnSchedule.pull(ctx(http, { config }));
    expect(r1.note).toMatch(/^full:/);
    expect(r1.nextInMinutes).toBeUndefined();
    expect(r1.cursor.fullDay).toBe(utcDay());
    expect(r1.cursor.queue).toEqual([]);
    expect(r1.items.length).toBe(2);
    expect(r1.items[0].data.league.name).toBe('National Football League');
    // Every league asked once, with a 30-day window; tennis skipped.
    expect(boards.length).toBe(3);
    expect(boards.every((u) => /dates=\d{8}-\d{8}/.test(u))).toBe(true);
    expect(boards.some((u) => u.includes('tennis'))).toBe(false);
    // Learned: NFL has a fixture, the others have none.
    expect(r1.cursor.upcoming['football/nfl']).toBeTruthy();
    expect(r1.cursor.upcoming['soccer/eng.1']).toBeNull();
    expect(r1.cursor.regions['soccer/eng.1']).toBe('England');
    expect(r1.items.every((i) => i.data.league.region === null)).toBe(true);

    boards.length = 0;
    const r2 = await espnSchedule.pull(ctx(http, { config, cursor: r1.cursor }));
    expect(r2.note).toMatch(/^near:/);
    // Only the league whose next fixture is inside the window is asked. The NFL
    // fixture in the sample is in the past by now, which reads as "refresh it".
    expect(boards.length).toBe(1);
    expect(boards[0]).toContain('football/nfl');
  });

  test('a run that hits its deadline carries the queue over and asks to be run again', async () => {
    const http = fakeEspn();
    const r = await espnSchedule.pull(
      ctx(http, { config: { ...espnSchedule.defaults }, deadline: Date.now() }),
    );
    expect(r.nextInMinutes).toBe(1);
    expect(r.cursor.mode).toBe('full');
    expect(r.cursor.queue.length).toBe(3);
    expect(r.cursor.fullDay).toBeNull();
    expect(r.items).toEqual([]);
    // The next run resumes the same sweep rather than starting a near pass.
    const r2 = await espnSchedule.pull(
      ctx(http, { config: { ...espnSchedule.defaults }, cursor: r.cursor }),
    );
    expect(r2.note).toMatch(/^full:/);
    expect(r2.cursor.fullDay).toBe(utcDay());
  });
});

describe('espn-live pull', () => {
  test('watches a league with a game on, emits fresh state, and drops it when nothing is on', async () => {
    const live = structuredClone(nfl);
    live.events[0].status.type.state = 'in';
    live.events[0].competitions[0].status.type.state = 'in';
    live.events[0].status.displayClock = '12:34';
    live.events[0].status.period = 2;
    live.events[0].competitions[0].competitors[0].score = '7';
    live.events[0].date = new Date().toISOString();
    live.events[0].competitions[0].date = live.events[0].date;
    live.events[1].date = new Date(Date.now() - 2 * 3_600_000).toISOString();
    let board = live;
    const http = fakeEspn({
      onScoreboard: (url) => (url.includes('football/nfl') ? json(board) : json({ events: [] })),
    });
    const config = { ...espnLive.defaults, probePerRun: 2 };
    const r1 = await espnLive.pull(ctx(http, { config }));
    expect(Object.keys(r1.cursor.watch)).toEqual(['football/nfl']);
    expect(r1.cursor.scanIdx).toBe(2);
    const inPlay = r1.items.find((i) => i.tags.includes('state:in'));
    expect(inPlay.data.displayClock).toBe('12:34');
    expect(inPlay.data.period).toBe(2);
    expect(inPlay.data.home.score).toBe(7);
    // The game that finished two hours ago rides along so its final is written.
    expect(r1.items.find((i) => i.tags.includes('state:post'))).toBeTruthy();
    expect(r1.note).toContain('1 in play');

    // Next minute: the watched league is asked first, then the probe wraps round.
    board = { events: [] };
    const r2 = await espnLive.pull(ctx(http, { config, cursor: r1.cursor }));
    expect(r2.cursor.watch).toEqual({});
    expect(r2.items).toEqual([]);
    const asked = http.urls.filter((u) => u.url.includes('/scoreboard')).map((u) => u.url);
    expect(asked[asked.length - 1] === asked[asked.length - 2]).toBe(false);
  });

  test('pinned leagues are polled and nothing else is probed', async () => {
    const http = fakeEspn({ onScoreboard: () => json({ events: [] }) });
    const r = await espnLive.pull(
      ctx(http, { config: { ...espnLive.defaults, leagues: ['football-nfl'] } }),
    );
    const asked = http.urls.filter((u) => u.url.includes('/scoreboard')).map((u) => u.url);
    expect(asked.length).toBe(1);
    expect(asked[0]).toContain('football/nfl');
    expect(r.cursor.scanIdx).toBe(0);
  });
});

/* ------------------------------------------------------------ livetennis -- */

describe('livetennis parsing', () => {
  test('reads as tennis: sets won, the set being played, and the points in the game', () => {
    const m = normaliseMatch(lt.liveSingles);
    expect(m.name).toBe('Riko Kikawada vs Clarissa Blomqvist');
    expect(m.state).toBe('in');
    expect({ away: m.away.score, home: m.home.score }).toEqual({ away: 1, home: 1 });
    expect(m.period).toBe(3);
    expect(m.statusDetail).toBe('Set 3');
    expect(m.displayClock).toBe('40-AD');
    expect(m.publishedAt.toISOString()).toBe('2026-08-29T08:00:00.000Z');
    expect(m.timeKnown).toBe(true);
    expect(m.precision).toBe('minute');
    expect(m.scoreDetail).toEqual({
      kind: 'tennis',
      games: [
        [7, 4, 5],
        [6, 6, 1],
      ],
      points: ['40', 'AD'],
      tiebreak: false,
      serving: 'home',
    });
  });

  test('p1 is the away side, the tournament is the venue, the details sit beside it', () => {
    const m = normaliseMatch(lt.liveSingles);
    expect(m.away.name).toBe('Riko Kikawada');
    expect(m.home.name).toBe('Clarissa Blomqvist');
    expect(m.home.abbreviation).toBe('#1034');
    expect(m.home.country).toBe('FIN');
    expect(m.venue).toBe('W15 Monastir 23');
    expect(m.venueCity).toBe('W15 Monastir 23 - Semi-finals · singles · hard');
    expect(m.key).toBe('livetennis/itf/180216');
  });

  test('a tiebreak is labelled, and a retirement is a result', () => {
    const tb = {
      ...lt.liveSingles,
      score: { ...lt.liveSingles.score, points: ['6', '5'], is_tiebreak: true },
    };
    expect(displayClock(tb)).toBe('TB 6-5');
    expect(scoreDetail(tb).tiebreak).toBe(true);
    const done = normaliseMatch(lt.finishedSingles);
    expect(done.state).toBe('post');
    expect(done.statusDetail).toBe('Retired');
    expect(done.displayClock).toBeNull();
    // Games survive the end of the match; points and server do not.
    expect(done.scoreDetail.games).toEqual([
      [7, 4, 6],
      [6, 6, 3],
    ]);
    expect(done.scoreDetail.points).toBeNull();
    expect(done.scoreDetail.serving).toBeNull();
    expect(stateOf({ status: 'cancelled' })).toBe('post');
    expect(statusDetail({ status: 'completed' })).toBe('Final');
    expect(statusDetail(lt.upcomingSingles)).toBe('Quarter-finals');
  });

  test('a doubles pair cannot collide with a singles player of the same id, and a player key carries no tour', () => {
    expect(side(lt.liveSingles.players.p1).key).toBe('livetennis/p2487');
    expect(side(lt.liveDoubles.players.p1).key).toBe('livetennis/d2487');
    expect(side(lt.liveDoubles.players.p1).abbreviation).toBeNull();
    expect(side(null)).toBeNull();
    const itf = normaliseMatch(lt.liveSingles);
    const ch = normaliseMatch({ ...lt.liveSingles, id: 9, tour: 'challenger' });
    expect(itf.away.key).toBe(ch.away.key);
    expect(ch.key).toBe('livetennis/challenger/9');
  });

  test('a row with no tour lands in "other", and one with no time or player is dropped', () => {
    expect(tourOf(lt.untoured)).toBe('other');
    expect(tourOf({ tour: 'WTA' })).toBe('wta');
    expect(normaliseMatch({ ...lt.liveSingles, scheduled_time: null })).toBeNull();
    expect(
      normaliseMatch({ ...lt.liveSingles, players: { p1: lt.liveSingles.players.p1 } }),
    ).toBeNull();
    const dateOnly = normaliseMatch({ ...lt.upcomingSingles, scheduled_time: '2026-08-30' });
    expect(dateOnly.timeKnown).toBe(false);
    expect(dateOnly.precision).toBe('day');
  });

  test('when a match is in two lists the more advanced copy wins, then the newer one', () => {
    const live = normaliseMatch(lt.liveSingles);
    const done = normaliseMatch(lt.finishedSingles);
    expect(wins(done, live)).toBe(true);
    expect(wins(live, done)).toBe(false);
    const merged = mergeMatches([lt.finishedSingles, lt.liveSingles, lt.liveDoubles]);
    expect(merged.length).toBe(2);
    expect(merged.find((m) => m.id === '180216').state).toBe('post');
  });

  test('the fixture item follows the contract with the tennis extras in data', () => {
    const item = tennisFixtureItem(normaliseMatch(lt.liveSingles));
    expect(item.externalId).toBe('livetennis:fixture:180216');
    expect(item.kind).toBe('fixture');
    expect(item.title).toBe('Riko Kikawada vs Clarissa Blomqvist');
    expect(item.summary).toBe('W15 Monastir 23 · W15 Monastir 23 - Semi-finals');
    expect(item.tags).toEqual([
      'fixture',
      'tennis',
      'league:tennis-itf',
      'state:in',
      'team:livetennis-p2844',
      'team:livetennis-p2487',
      'draw:singles',
    ]);
    expect(item.data).toMatchObject({
      provider: 'livetennis',
      sport: 'tennis',
      league: { slug: 'tennis-itf', name: 'ITF World Tennis Tour', abbreviation: 'ITF' },
      state: 'in',
      statusDetail: 'Set 3',
      period: 3,
      displayClock: '40-AD',
      neutralSite: true,
      broadcast: null,
      odds: null,
      plays_supported: false,
      surface: 'hard',
      roundCode: 'SF',
      doubles: false,
    });
    expect(item.data.scoreDetail.serving).toBe('home');
    expect(normaliseItem(item).tags).toContain('team:livetennis-p2487');
    expect(item.url).toBeNull();
  });

  test('the five tours are leagues, under the same slugs tipoffwatch uses', () => {
    expect(TOURS.map((t) => t.slug)).toEqual([
      'tennis-atp',
      'tennis-wta',
      'tennis-challenger',
      'tennis-itf',
      'tennis-other',
    ]);
    const item = tourItem(TOURS[0]);
    expect(item.externalId).toBe('livetennis:league:tennis:tennis-atp');
    expect(item.kind).toBe('league');
    expect(item.tags).toEqual(['league', 'tennis']);
    expect(item.data.priority).toBe(3);
  });

  test('a tournament lands once per tour, and its start never moves later', () => {
    const matches = mergeMatches([lt.liveDoubles, lt.upcomingSingles, lt.liveSingles]);
    const starts = {};
    const items = tournamentItems(matches, starts, Date.parse('2026-08-29T12:00:00Z'));
    // Winston-Salem arrives under two tournament_ids (911 and 912) and is one row.
    expect(items.map((i) => i.externalId).sort()).toEqual([
      'livetennis:fixture:tournament:atp:winston-salem',
      'livetennis:fixture:tournament:itf:w15-monastir-23',
    ]);
    const ws = items.find((i) => i.title === 'Winston-Salem');
    expect(ws.publishedAt.toISOString()).toBe('2026-08-29T09:00:00.000Z');
    expect(ws.timeKnown).toBe(false);
    expect(ws.tags).toEqual(['fixture', 'tennis', 'league:tennis-atp', 'state:in', 'tournament']);
    expect(ws.data.matches).toBe(2);
    expect(ws.data.tournament).toBe(true);
    // A later run that only sees a later match keeps the first start it learned.
    const later = tournamentItems(mergeMatches([lt.upcomingSingles]), starts);
    expect(later[0].publishedAt.toISOString()).toBe('2026-08-29T09:00:00.000Z');
    expect(starts['atp:winston-salem']).toBe('2026-08-29T09:00:00.000Z');
  });
});

describe('livetennis budget', () => {
  const noon = Date.parse('2026-09-10T12:00:00Z');

  test('the count rolls with the UTC day and is clamped to what the plan allows', () => {
    const b = budgetFrom(
      { day: '2026-09-10', calls: 40, seededDay: '2026-09-10' },
      { dailyBudget: 95 },
      noon,
    );
    expect(b).toMatchObject({ day: '2026-09-10', calls: 40, seeded: true, limit: 95 });
    const rolled = budgetFrom({ day: '2026-09-09', calls: 90, seededDay: '2026-09-09' }, {}, noon);
    expect(rolled.calls).toBe(0);
    expect(rolled.seeded).toBe(false);
    expect(rolled.limit).toBe(95);
    const clamped = budgetFrom(
      { day: '2026-09-10', calls: 1, providerPerDay: 50 },
      { dailyBudget: 95 },
      noon,
    );
    expect(clamped.limit).toBe(50);
  });

  test('the reserve is what the rest of the day will need on the clock', () => {
    // Twelve hours left at 30 minutes a run: 24 live reads, plus two refreshes of
    // two lists each.
    expect(reserveFor(noon, 30, 6)).toBe(24 + 4);
    expect(reserveFor(Date.parse('2026-09-10T23:50:00Z'), 30, 6)).toBe(1 + 2);
  });
});

describe('livetennis pull', () => {
  const provider = ({ rows, used = 10, perDay = 100, fail = () => false }) => {
    const calls = [];
    const http = {
      async json(url, opts) {
        const path = url.replace('https://api.livetennisapi.com/api/public/v1', '');
        calls.push({ path, auth: opts.headers.authorization });
        if (fail(path)) throw new Error('403 from upstream');
        if (path.startsWith('/usage'))
          return { today: { calls: used }, limits: { per_day: perDay } };
        const list = path.startsWith('/history')
          ? rows.filter((r) => r.status === 'completed')
          : path.includes('status=live')
            ? rows.filter((r) => r.status === 'live')
            : rows.filter((r) => r.status === 'upcoming');
        return { data: list, meta: { has_more: false } };
      },
    };
    return { http, calls };
  };
  const run = (http, extra = {}) =>
    livetennis.pull({
      config: { ...livetennis.defaults },
      cursor: {},
      env: { livetennisApiKey: 'twjp_test' },
      http,
      log: () => {},
      budget: 150,
      deadline: Date.now() + 60_000,
      ...extra,
    });

  test('refuses to run without the key, and never puts it anywhere but the header', async () => {
    const { http } = provider({ rows: [] });
    await expect(run(http, { env: {} })).rejects.toThrow(/LIVETENNIS_API_KEY/);
    expect(livetennis.needsEnv).toEqual(['livetennisApiKey']);
    const r = await run(http);
    for (const it of r.items) {
      expect(JSON.stringify(it)).not.toContain('twjp_test');
    }
  });

  test('a first run seeds the count from the provider, reads all three lists, and writes the cursor', async () => {
    const { http, calls } = provider({
      rows: [lt.liveSingles, lt.liveDoubles, lt.upcomingSingles],
      used: 10,
    });
    const r = await run(http);
    expect(calls[0].path).toBe('/usage');
    expect(calls[0].auth).toBe('Bearer twjp_test');
    expect(calls.map((c) => c.path.split('?')[0]).slice(1)).toEqual([
      '/matches',
      '/matches',
      '/history/matches',
    ]);
    // 10 already spent today per the provider, +1 for /usage, +3 lists.
    expect(r.cursor.calls).toBe(14);
    expect(r.cursor.day).toBe(utcDay());
    expect(r.cursor.seededDay).toBe(utcDay());
    expect(r.cursor.providerPerDay).toBe(100);
    expect(r.cursor.liveIds.sort()).toEqual(['180215', '180216']);
    expect(r.cursor.upcomingAt).toBeGreaterThan(0);
    expect(r.cursor.recentAt).toBeGreaterThan(0);
    const kinds = r.items.map((i) => i.kind);
    expect(kinds.filter((k) => k === 'league').length).toBe(5);
    expect(r.items.filter((i) => i.tags.includes('tournament')).length).toBe(2);
    expect(
      r.items.filter((i) => i.kind === 'fixture' && !i.tags.includes('tournament')).length,
    ).toBe(3);
    expect(r.note).toContain('2 live');
    expect(r.note).toContain('14/95 requests today');
  });

  test('inside the refresh interval only the live list is read; a vanished match buys a results read', async () => {
    const { http, calls } = provider({ rows: [lt.finishedSingles, lt.upcomingSingles], used: 20 });
    const cursor = {
      day: utcDay(),
      calls: 21,
      seededDay: utcDay(),
      providerPerDay: 100,
      upcomingAt: Date.now() - 60_000,
      recentAt: Date.now() - 60_000,
      liveIds: ['180216'],
    };
    const r = await run(http, { cursor });
    const paths = calls.map((c) => c.path.split('?')[0]);
    expect(paths).toEqual(['/matches', '/history/matches']);
    expect(r.cursor.calls).toBe(23);
    expect(r.cursor.liveIds).toEqual([]);
    const done = r.items.find((i) => i.externalId === 'livetennis:fixture:180216');
    expect(done.tags).toContain('state:post');

    // Without the vanishing there is nothing to buy.
    const quiet = provider({ rows: [lt.upcomingSingles], used: 20 });
    await run(quiet.http, { cursor: { ...cursor, liveIds: [] } });
    expect(quiet.calls.map((c) => c.path.split('?')[0])).toEqual(['/matches']);
  });

  test('at the ceiling it stops spending and says so rather than throwing', async () => {
    const { http, calls } = provider({ rows: [lt.liveSingles], used: 94 });
    const r = await run(http);
    // /usage put the count at 95, which is the whole budget: no list is read.
    expect(calls.map((c) => c.path.split('?')[0])).toEqual(['/usage']);
    expect(r.cursor.calls).toBe(95);
    expect(r.note).toContain('budget spent');
    expect(r.items.filter((i) => i.kind === 'fixture')).toEqual([]);
    // The tours still land, so the leagues exist whatever the day's budget did.
    expect(r.items.filter((i) => i.kind === 'league').length).toBe(5);
  });

  test('a provider whose plan is smaller than the configured budget wins', async () => {
    const { http } = provider({ rows: [lt.liveSingles], used: 0, perDay: 30 });
    const r = await run(http, { config: { dailyBudget: 95, fixturesHours: 6 } });
    expect(r.note).toContain('/30 requests today');
    expect(r.cursor.providerPerDay).toBe(30);
  });

  test('a failed usage read is not fatal: the count carries on locally', async () => {
    const { http, calls } = provider({
      rows: [lt.liveSingles],
      fail: (p) => p.startsWith('/usage'),
    });
    const r = await run(http);
    expect(r.cursor.seededDay).toBeNull();
    expect(r.cursor.calls).toBe(4);
    expect(calls.length).toBe(4);
    expect(r.items.some((i) => i.externalId === 'livetennis:fixture:180216')).toBe(true);
  });
});
