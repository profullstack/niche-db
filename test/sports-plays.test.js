import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { HOUR_MS } from '../packages/adapters/src/espn.js';
import {
  boxscoreSupportedFor,
  capPlays,
  espnPlays,
  normalisePlay,
  PLAYS_CAP_FINAL,
  PLAYS_CAP_LIVE,
  pickSummaries,
  playsFromSummary,
  playsItem,
  playsSupportedFor,
  pruneStamps,
  RECAP_LOOKBACK_MS,
  recapFromSummary,
  STAMP_TTL_MS,
  summaryState,
  summaryUrl,
  wantsSummary,
} from '../packages/adapters/src/espnplays.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

const nfl = JSON.parse(
  await readFile(
    new URL('../packages/adapters/test/fixtures/espn-scoreboard-nfl.json', import.meta.url),
    'utf8',
  ),
);

const NFL = {
  key: 'football/nfl',
  sport: 'football',
  leagueKey: 'nfl',
  slug: 'football-nfl',
  priority: 1,
};

/*
 * Summary excerpts. The KEYS and their nesting are as ESPN ships them (copied from
 * live responses on tipoffwatch, 2026-08-21 and 2026-09-06); the values are
 * trimmed. The whole risk here is that the provider puts the same fact in a
 * different place per sport, so the shapes are not tidied.
 */

/** Football: plays nested under drives, no period label, a clock instead. */
const footballSummary = (state = 'in') => ({
  header: {
    competitions: [
      {
        status: { type: { state } },
        competitors: [
          { homeAway: 'home', team: { id: '26' }, linescores: [{ displayValue: '7' }] },
          { homeAway: 'away', team: { id: '17' }, linescores: [{ displayValue: '0' }] },
        ],
      },
    ],
  },
  format: { regulation: { periods: 4, displayName: 'Quarter' } },
  drives: {
    current: {
      plays: [
        {
          id: '4018726561',
          sequenceNumber: '15100',
          text: 'K.Black left tackle to SF 11 for 5 yards',
          period: { number: 2 },
          clock: { displayValue: '13:43' },
          type: { text: 'Rush' },
          team: { id: '17' },
        },
      ],
    },
    previous: [
      {
        plays: [
          {
            id: '4018726562',
            sequenceNumber: '10200',
            text: 'CJ Donaldson 1 Yd Run',
            scoringPlay: true,
            awayScore: 0,
            homeScore: 7,
            period: { number: 1 },
            clock: { displayValue: '2:10' },
            type: { text: 'Rushing Touchdown' },
            team: { id: '26' },
          },
        ],
      },
    ],
  },
  boxscore: {
    teams: [
      {
        homeAway: 'home',
        statistics: [
          { name: 'firstDowns', label: '1st Downs', displayValue: '29' },
          { name: 'totalYards', label: 'Total Yards', displayValue: '401' },
        ],
      },
      {
        homeAway: 'away',
        statistics: [
          { name: 'firstDowns', label: '1st Downs', displayValue: '19' },
          { name: 'totalYards', label: 'Total Yards', displayValue: '312' },
        ],
      },
    ],
  },
  leaders: [
    {
      team: { id: '26', abbreviation: 'SEA' },
      leaders: [
        {
          displayName: 'Passing Leader',
          shortDisplayName: 'PASS',
          leaders: [
            { displayValue: '25/29, 286 YDS, 2 TD', athlete: { displayName: 'S. Darnold' } },
          ],
        },
      ],
    },
  ],
  gameInfo: {
    attendance: 68738,
    gameDuration: '3:12',
    officials: [{ displayName: 'Carl Cheffers' }],
  },
  article: {
    headline: 'Seahawks hold off Patriots',
    description: '— Sam Darnold threw two touchdowns.',
    source: 'AP',
    published: '2026-09-10T04:10:00Z',
  },
  odds: [],
  pickcenter: [
    {
      provider: { name: 'DraftKings' },
      details: 'SEA -3.5',
      overUnder: 44.5,
      spread: -3.5,
      homeTeamOdds: { favorite: true, moneyLine: -185 },
      awayTeamOdds: { underdog: true, moneyLine: 154 },
    },
  ],
});

/** Basketball: a flat, ordered `plays` list with the provider's own period label. */
const basketballSummary = {
  header: {
    competitions: [
      {
        status: { type: { state: 'in' } },
        competitors: [
          { homeAway: 'home', team: { id: '13' } },
          { homeAway: 'away', team: { id: '2' } },
        ],
      },
    ],
  },
  plays: [
    {
      id: '4017000011',
      sequenceNumber: '1',
      text: 'Jump Ball',
      period: { number: 1, displayValue: '1st Quarter' },
      clock: { displayValue: '12:00' },
      type: { text: 'Jumpball' },
    },
    {
      id: '4017000012',
      sequenceNumber: '2',
      text: 'LeBron James makes 26-foot three point jumper',
      scoringPlay: true,
      awayScore: 0,
      homeScore: 3,
      period: { number: 1, displayValue: '1st Quarter' },
      clock: { displayValue: '11:41' },
      type: { text: '3PT Jump Shot' },
      team: { id: '13' },
    },
  ],
};

/** Soccer: commentary wraps the play and carries its sequence; keyEvents repeat it. */
const soccerSummary = {
  commentary: [
    { sequence: 0, play: { id: '100', text: 'First Half begins.' } },
    { sequence: 5, play: { id: '101', text: 'Foul by Agustin Resch.' } },
  ],
  keyEvents: [
    { id: '101', text: 'Foul by Agustin Resch.', scoringPlay: false },
    { id: '102', text: 'Goal! Houston Dynamo FC 1.', scoringPlay: true, team: { id: '6077' } },
  ],
};

/* ------------------------------------------------------------------ plays -- */

describe('play parsing', () => {
  test('football plays are read out of drives, current and previous, and ordered', () => {
    const plays = playsFromSummary(footballSummary(), { sides: { home: '26', away: '17' } });
    expect(plays.map((p) => p.id)).toEqual(['4018726562', '4018726561']);
    const [td, rush] = plays;
    expect(td).toMatchObject({
      sequence: 10200,
      scoring: true,
      homeScore: 7,
      awayScore: 0,
      period: 1,
      clock: '2:10',
      type: 'Rushing Touchdown',
      team: 'home',
      teamId: '26',
    });
    // No label from the provider: phrased from clock and period number.
    expect(rush.periodLabel).toBe('13:43 · 2nd');
    expect(rush.team).toBe('away');
  });

  test('a finished football game drops `current`, and a drives array reads the same', () => {
    expect(
      playsFromSummary({
        drives: { previous: [{ plays: [{ id: '9', text: 'End of game' }] }] },
      }).map((p) => p.text),
    ).toEqual(['End of game']);
    expect(playsFromSummary({ drives: [{ plays: [{ id: '3', text: 'Punt' }] }] }).length).toBe(1);
  });

  test('basketball plays are flat and keep the label the provider wrote', () => {
    const plays = playsFromSummary(basketballSummary, { sides: { home: '13', away: '2' } });
    expect(plays.length).toBe(2);
    expect(plays[0].periodLabel).toBe('1st Quarter');
    expect(plays[1]).toMatchObject({ scoring: true, homeScore: 3, team: 'home' });
    expect(plays[0].team).toBeNull();
  });

  test('soccer takes its ordering from commentary and collapses repeated key events', () => {
    const plays = playsFromSummary(soccerSummary);
    expect(plays.map((p) => p.id)).toEqual(['100', '101', '102']);
    expect(plays.map((p) => p.sequence)).toEqual([0, 5, null]);
    expect(plays[2].scoring).toBe(true);
    expect(plays[2].teamId).toBe('6077');
  });

  test('plays with no id or no text are dropped, and an empty summary is empty', () => {
    expect(
      playsFromSummary({
        plays: [{ id: '1' }, { text: 'orphan' }, null, { id: '2', text: 'ok' }],
      }).map((p) => p.id),
    ).toEqual(['2']);
    expect(playsFromSummary({})).toEqual([]);
    expect(playsFromSummary(null)).toEqual([]);
    expect(normalisePlay({ id: '1', text: 'x', sequenceNumber: null }).sequence).toBeNull();
  });
});

describe('the plays cap', () => {
  const many = (n) => Array.from({ length: n }, (_, i) => ({ id: String(i), sequence: i }));

  test('a game in progress carries the tail of its log', () => {
    const { plays, total, truncated } = capPlays(many(PLAYS_CAP_LIVE + 100));
    expect(plays.length).toBe(PLAYS_CAP_LIVE);
    expect(plays[0].id).toBe('100');
    expect(total).toBe(PLAYS_CAP_LIVE + 100);
    expect(truncated).toBe(true);
  });

  test('a final carries the whole log up to the guard', () => {
    const r = capPlays(many(PLAYS_CAP_LIVE + 100), { final: true });
    expect(r.plays.length).toBe(PLAYS_CAP_LIVE + 100);
    expect(r.truncated).toBe(false);
    expect(capPlays(many(PLAYS_CAP_FINAL + 1), { final: true }).plays.length).toBe(PLAYS_CAP_FINAL);
  });
});

/* ------------------------------------------------------------------ recap -- */

describe('recap parsing', () => {
  test('a finished football game yields the linescore, stats, leaders, frame, article and line', () => {
    const r = recapFromSummary(footballSummary('post'));
    expect(r.linescores).toEqual({
      labels: ['1'],
      periodLabel: 'Quarter',
      away: ['0'],
      home: ['7'],
    });
    expect(r.teamStats).toEqual([
      { group: null, label: '1st Downs', home: '29', away: '19' },
      { group: null, label: 'Total Yards', home: '401', away: '312' },
    ]);
    expect(r.leaders).toEqual([
      {
        side: 'home',
        team: 'SEA',
        category: 'PASS',
        name: 'S. Darnold',
        line: '25/29, 286 YDS, 2 TD',
      },
    ]);
    expect(r.officials).toEqual(['Carl Cheffers']);
    expect(r.duration).toBe('3:12');
    expect(r.attendance).toBe(68738);
    expect(r.article.summary).toBe('Sam Darnold threw two touchdowns.');
    expect(r.article.source).toBe('AP');
    expect(r.odds).toMatchObject({
      details: 'SEA -3.5',
      homeMoneyline: -185,
      capturedState: 'post',
    });
  });

  test('grouped team stats (baseball) are read, and season bookkeeping and 0-0 rows are not', () => {
    const grouped = (hits, hr) => [
      {
        displayName: 'Batting',
        stats: [
          { displayName: 'Hits', displayValue: hits },
          { displayName: 'Games Played', displayValue: '1' },
          { displayName: 'Grand Slam Home Runs', displayValue: hr },
        ],
      },
    ];
    const r = recapFromSummary({
      header: { competitions: [{ competitors: [] }] },
      boxscore: {
        teams: [
          { homeAway: 'home', statistics: grouped('6', '0') },
          { homeAway: 'away', statistics: grouped('13', '0') },
        ],
      },
    });
    expect(r.teamStats).toEqual([{ group: 'Batting', label: 'Hits', home: '6', away: '13' }]);
  });

  test('padding past regulation is trimmed, an attendance of zero is not reported, nothing is null', () => {
    const cells = (...vals) => vals.map((v) => ({ displayValue: String(v) }));
    const r = recapFromSummary({
      format: { regulation: { periods: 2, displayName: 'Half' } },
      header: {
        competitions: [
          {
            competitors: [
              { homeAway: 'away', linescores: cells(10, 34, 0, 0) },
              { homeAway: 'home', linescores: cells(10, 20, 0, 0) },
            ],
          },
        ],
      },
      gameInfo: { attendance: 0 },
    });
    expect(r.linescores.away).toEqual(['10', '34']);
    expect(r.attendance).toBeUndefined();
    expect(recapFromSummary({ header: { competitions: [{ competitors: [] }] } })).toBeNull();
    expect(recapFromSummary(null)).toBeNull();
  });
});

/* -------------------------------------------------------------- selection -- */

const NOW = Date.parse('2026-09-10T03:00:00Z');
const fixture = (over = {}) => ({
  key: 'football/nfl/1',
  id: '1',
  sport: 'football',
  state: 'in',
  publishedAt: new Date(NOW - HOUR_MS),
  home: { id: '26' },
  away: { id: '17' },
  tournament: false,
  ...over,
});

describe('which fixtures are worth a summary', () => {
  test('a game in play is, a game not yet started is not', () => {
    expect(wantsSummary(fixture(), NOW)).toBe(true);
    expect(wantsSummary(fixture({ state: 'pre' }), NOW)).toBe(false);
  });

  test('a recent final is, once, and an old one is not', () => {
    const post = fixture({ state: 'post' });
    expect(wantsSummary(post, NOW)).toBe(true);
    expect(
      wantsSummary(post, NOW, { recapped: { 'football/nfl/1': '2026-09-10T02:59:00Z' } }),
    ).toBe(false);
    const old = fixture({ state: 'post', publishedAt: new Date(NOW - RECAP_LOOKBACK_MS - 60_000) });
    expect(wantsSummary(old, NOW)).toBe(false);
  });

  test('a box-score-only sport is read only once it is over; a summary-less sport never', () => {
    expect(playsSupportedFor('volleyball')).toBe(false);
    expect(boxscoreSupportedFor('volleyball')).toBe(true);
    expect(wantsSummary(fixture({ sport: 'volleyball' }), NOW)).toBe(false);
    expect(wantsSummary(fixture({ sport: 'volleyball', state: 'post' }), NOW)).toBe(true);
    expect(wantsSummary(fixture({ sport: 'tennis', state: 'post' }), NOW)).toBe(false);
    expect(wantsSummary(fixture({ sport: 'mma' }), NOW)).toBe(false);
    expect(wantsSummary(fixture({ home: null, away: null }), NOW)).toBe(false);
  });
});

describe('the per-run quota', () => {
  const live = (i, readAt) => fixture({ key: `l${i}`, readAt });
  const ended = (i, hoursAgo) =>
    fixture({ key: `e${i}`, state: 'post', publishedAt: new Date(NOW - hoursAgo * HOUR_MS) });

  test('live games take the bulk, finished ones keep two slots, newest first', () => {
    const candidates = [
      ...Array.from({ length: 10 }, (_, i) => live(i)),
      ended(1, 3),
      ended(2, 1),
      ended(3, 2),
    ];
    const picked = pickSummaries(candidates, { limit: 8 }).map((c) => c.key);
    expect(picked.length).toBe(8);
    expect(picked.filter((k) => k.startsWith('l')).length).toBe(6);
    expect(picked.slice(6)).toEqual(['e2', 'e3']);
  });

  test('a slot one queue cannot fill goes to the other', () => {
    const onlyLive = Array.from({ length: 10 }, (_, i) => live(i));
    expect(pickSummaries(onlyLive, { limit: 8 }).length).toBe(8);
    const fewLive = [live(0), ended(1, 1), ended(2, 1), ended(3, 1), ended(4, 1)];
    expect(pickSummaries(fewLive, { limit: 8 }).map((c) => c.key)).toEqual([
      'l0',
      'e1',
      'e2',
      'e3',
      'e4',
    ]);
  });

  test('among live games the one waiting longest is read first', () => {
    const read = { l0: '2026-09-10T02:58:00Z', l1: '2026-09-10T02:50:00Z' };
    const picked = pickSummaries([live(0), live(1), live(2)], { limit: 2, read });
    expect(picked.map((c) => c.key)).toEqual(['l2', 'l1']);
    expect(pickSummaries([live(0)], { limit: 0 })).toEqual([]);
  });
});

describe('cursor pruning', () => {
  test('stamps older than a day are dropped, junk with them', () => {
    const fresh = new Date(NOW - HOUR_MS).toISOString();
    const stale = new Date(NOW - STAMP_TTL_MS - 1).toISOString();
    expect(pruneStamps({ a: fresh, b: stale, c: 'nope' }, NOW)).toEqual({ a: fresh });
    expect(pruneStamps(undefined, NOW)).toEqual({});
  });
});

/* ------------------------------------------------------------------- item -- */

describe('the plays item', () => {
  const f = {
    ...fixture({ key: 'football/nfl/401872656', id: '401872656' }),
    home: { id: '26', displayName: 'Seattle Seahawks', score: 7, logoUrl: 'https://a/sea.png' },
    away: { id: '17', displayName: 'New England Patriots', score: 0 },
    statusDetail: '13:43 - 2nd',
    url: 'https://www.espn.com/nfl/game/_/gameId/401872656',
    timeKnown: true,
    precision: 'minute',
  };

  test('is keyed like its fixture, tagged back to it, and carries no recap while in play', () => {
    const item = playsItem({
      fixture: f,
      league: NFL,
      meta: { name: 'NFL' },
      summary: footballSummary(),
      state: 'in',
      now: NOW,
    });
    expect(item.externalId).toBe('espn:plays:football/nfl/401872656');
    expect(item.kind).toBe('plays');
    expect(item.title).toBe('New England Patriots at Seattle Seahawks');
    expect(item.publishedAt).toEqual(f.publishedAt);
    expect(item.tags).toEqual([
      'plays',
      'football',
      'league:football-nfl',
      'state:in',
      'fixture:espn:fixture:football/nfl/401872656',
    ]);
    expect(item.data).toMatchObject({
      provider: 'espn',
      fixtureExternalId: 'espn:fixture:football/nfl/401872656',
      league: { slug: 'football-nfl', name: 'NFL' },
      state: 'in',
      playsSupported: true,
      boxscoreSupported: true,
      final: false,
      recap: null,
      playsTotal: 2,
      playsTruncated: false,
    });
    expect(item.data.plays[1].team).toBe('away');
    expect(item.summary).toBe('K.Black left tackle to SF 11 for 5 yards');
    expect(normaliseItem(item)).toBeTruthy();
  });

  test('is final, with the recap, once the summary says the game is over', () => {
    const summary = footballSummary('post');
    expect(summaryState(summary)).toBe('post');
    const item = playsItem({ fixture: f, league: NFL, summary, state: 'post', now: NOW });
    expect(item.tags).toContain('state:post');
    expect(item.data.final).toBe(true);
    expect(item.data.recap.linescores.home).toEqual(['7']);
    expect(item.data.recap.article.headline).toBe('Seahawks hold off Patriots');
  });

  test('the summary URL is league-scoped, like the fixture key', () => {
    expect(summaryUrl(NFL, f)).toBe(
      'https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=401872656',
    );
  });
});

/* ------------------------------------------------------------------- pull -- */

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A one-sport ESPN answered from the fixtures, recording every URL. */
function fakeEspn({ onScoreboard, onSummary }) {
  const urls = [];
  return {
    urls,
    async request(url) {
      urls.push(url);
      if (url.endsWith('/sports?limit=50'))
        return json({ items: [{ $ref: 'http://x/v2/sports/football?lang=en' }] });
      if (url.includes('/sports/football/leagues?'))
        return json({
          items: [
            { $ref: 'http://x/v2/sports/football/leagues/nfl?lang=en' },
            { $ref: 'http://x/v2/sports/football/leagues/college-football?lang=en' },
          ],
        });
      if (url.includes('/summary?event=')) return onSummary(url);
      if (url.includes('/scoreboard')) return onScoreboard(url);
      return json({ error: 'not found' }, 404);
    },
  };
}

const ctx = (http, extra = {}) => ({
  config: { ...espnPlays.defaults },
  cursor: {},
  env: {},
  http,
  log: () => {},
  budget: 150,
  deadline: Date.now() + 60_000,
  ...extra,
});

describe('espn-plays pull', () => {
  test('is registered for the sports collection on a two-minute cadence', () => {
    expect(espnPlays.name).toBe('espn-plays');
    expect(espnPlays.collection).toBe('sports');
    expect(espnPlays.kinds).toEqual(['plays']);
    expect(espnPlays.cadenceMinutes).toBe(2);
    expect(espnPlays.defaultSources[0].slug).toBe('espn-plays');
    for (const k of Object.keys(espnPlays.defaults))
      expect(espnPlays.configFields.map((f) => f.key)).toContain(k);
  });

  test('reads a summary for the game on and the game just over, then only the game on', async () => {
    // The sample's first event is made live and its second finished an hour ago.
    const board = structuredClone(nfl);
    const [live, done] = board.events;
    live.status.type.state = 'in';
    live.competitions[0].status.type.state = 'in';
    live.date = new Date().toISOString();
    live.competitions[0].date = live.date;
    done.date = new Date(Date.now() - HOUR_MS).toISOString();
    done.competitions[0].date = done.date;

    const summaries = [];
    const http = fakeEspn({
      onScoreboard: (url) => (url.includes('football/nfl') ? json(board) : json({ events: [] })),
      onSummary: (url) => {
        summaries.push(url);
        return json(footballSummary(url.includes(done.id) ? 'post' : 'in'));
      },
    });

    const r1 = await espnPlays.pull(ctx(http, { env: { SPORTS_PROXY_URL: '' } }));
    expect(Object.keys(r1.cursor.watch)).toEqual(['football/nfl']);
    expect(summaries.length).toBe(2);
    expect(summaries.every((u) => u.includes('/football/nfl/summary?event='))).toBe(true);
    const ids = r1.items.map((i) => i.externalId).sort();
    expect(ids).toEqual(
      [`espn:plays:football/nfl/${live.id}`, `espn:plays:football/nfl/${done.id}`].sort(),
    );
    const final = r1.items.find((i) => i.data.final);
    expect(final.externalId).toBe(`espn:plays:football/nfl/${done.id}`);
    expect(final.data.recap.teamStats.length).toBe(2);
    expect(final.tags).toContain(`fixture:espn:fixture:football/nfl/${done.id}`);
    const inPlay = r1.items.find((i) => !i.data.final);
    expect(inPlay.data.recap).toBeNull();
    expect(inPlay.data.plays.length).toBe(2);
    expect(r1.cursor.recapped).toEqual({ [`football/nfl/${done.id}`]: expect.any(String) });
    expect(r1.cursor.read[`football/nfl/${live.id}`]).toEqual(expect.any(String));
    expect(r1.note).toContain('1 live + 1 final');
    // Nothing secret rides on an item.
    expect(JSON.stringify(r1.items)).not.toMatch(/proxy|SPORTS_PROXY/i);

    // Next run: the finished game is closed out; only the live one is re-read.
    summaries.length = 0;
    const r2 = await espnPlays.pull(ctx(http, { cursor: r1.cursor }));
    expect(summaries.length).toBe(1);
    expect(summaries[0]).toContain(`event=${live.id}`);
    expect(r2.items.map((i) => i.externalId)).toEqual([`espn:plays:football/nfl/${live.id}`]);
    // The catalogue was fetched once, not once per run.
    expect(http.urls.filter((u) => u.endsWith('/sports?limit=50')).length).toBe(1);
  });

  test('a fixture with no summary is closed out rather than retried every run', async () => {
    const board = structuredClone(nfl);
    const done = board.events[1];
    done.date = new Date(Date.now() - HOUR_MS).toISOString();
    done.competitions[0].date = done.date;
    let asked = 0;
    const http = fakeEspn({
      onScoreboard: (url) => (url.includes('football/nfl') ? json(board) : json({ events: [] })),
      onSummary: () => {
        asked += 1;
        return json({ error: 'no summary' }, 404);
      },
    });
    const r1 = await espnPlays.pull(ctx(http));
    expect(asked).toBe(1);
    expect(r1.items).toEqual([]);
    expect(Object.keys(r1.cursor.recapped)).toEqual([`football/nfl/${done.id}`]);
    await espnPlays.pull(ctx(http, { cursor: r1.cursor }));
    expect(asked).toBe(1);
  });

  test('the per-run cap and the deadline both hold', async () => {
    const board = structuredClone(nfl);
    for (const e of board.events) {
      e.status.type.state = 'in';
      e.competitions[0].status.type.state = 'in';
      e.date = new Date().toISOString();
      e.competitions[0].date = e.date;
    }
    let asked = 0;
    const http = fakeEspn({
      onScoreboard: (url) => (url.includes('football/nfl') ? json(board) : json({ events: [] })),
      onSummary: () => {
        asked += 1;
        return json(footballSummary('in'));
      },
    });
    const capped = await espnPlays.pull(
      ctx(http, { config: { ...espnPlays.defaults, summariesPerRun: 1 } }),
    );
    expect(asked).toBe(1);
    expect(capped.items.length).toBe(1);
    expect(capped.note).toContain('2 candidate(s)');

    asked = 0;
    const late = await espnPlays.pull(ctx(http, { cursor: capped.cursor, deadline: Date.now() }));
    expect(asked).toBe(0);
    expect(late.items).toEqual([]);
    // The watch list survives a run that had no time to look.
    expect(late.cursor.watch).toEqual(capped.cursor.watch);
  });
});
