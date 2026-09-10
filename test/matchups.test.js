import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

// matchups.js reaches @nichedb/config through the pool module, which reads the
// environment at import. It needs to be set, not to connect.
process.env.DATABASE_URL ??= 'postgres://localhost:5432/unused';
const { expandSide, fixtureWindow, matchFixtures, scoreFixture, sideMatchesTeam } = await import(
  '../packages/db/src/matchups.js'
);

/**
 * The matchup match against a real Postgres in-process: the migrations, the
 * trigram operators the prefilter leans on, and the scoring over rows as the
 * ESPN adapter writes them.
 */

/**
 * A tagged template with Bun's shape (nested fragments, thenable), over PGlite.
 * Fragments are flattened into one statement with numbered parameters.
 */
function pgliteSql(db) {
  class Fragment {
    constructor(strings, values) {
      this.strings = strings;
      this.values = values;
    }
    compile(params) {
      let text = '';
      this.strings.forEach((s, i) => {
        text += s;
        if (i >= this.values.length) return;
        const v = this.values[i];
        if (v instanceof Fragment) text += v.compile(params);
        else {
          params.push(v);
          text += `$${params.length}`;
        }
      });
      return text;
    }
    // biome-ignore lint/suspicious/noThenProperty: a query is awaited, as Bun's is
    then(resolve, reject) {
      const params = [];
      const text = this.compile(params);
      return db
        .query(text, params)
        .then((r) => r.rows)
        .then(resolve, reject);
    }
  }
  return (strings, ...values) => new Fragment(strings, values);
}

let db;
let sql;
let sportsId;
let otherId;
let sourceId;

const NOW = new Date('2026-09-10T18:00:00Z');
const hours = (n) => new Date(NOW.getTime() + n * 3_600_000).toISOString();

const team = (name, displayName, abbreviation) => ({ id: name, name, displayName, abbreviation });
const CHIEFS = team('Chiefs', 'Kansas City Chiefs', 'KC');
const BILLS = team('Bills', 'Buffalo Bills', 'BUF');
const CHARGERS = team('Chargers', 'Los Angeles Chargers', 'LAC');
const LAKERS = team('Lakers', 'Los Angeles Lakers', 'LAL');
const CELTICS = team('Celtics', 'Boston Celtics', 'BOS');
const MAN_UTD = team('Man United', 'Manchester United', 'MAN');
const MAN_CITY = team('Man City', 'Manchester City', 'MNC');
const CHELSEA = team('Chelsea', 'Chelsea', 'CHE');

async function seedFixture({
  collectionId = sportsId,
  home,
  away,
  at,
  state = 'pre',
  league = { slug: 'nfl', name: 'NFL', abbreviation: 'NFL' },
  sport = 'football',
  neutral = false,
}) {
  const title = `${away.displayName} ${neutral ? 'vs' : 'at'} ${home.displayName}`;
  const { rows } = await db.query(
    `insert into items (collection_id, source_id, external_id, kind, title, published_at, tags, data)
     values ($1, $2, $3, 'fixture', $4, $5, $6, $7) returning id`,
    [
      collectionId,
      sourceId,
      `espn:fixture:${sport}/${league.slug}/${Math.random()}`,
      title,
      at,
      ['fixture', sport, `league:${league.slug}`, `state:${state}`],
      JSON.stringify({ provider: 'espn', sport, league, home, away, state }),
    ],
  );
  return { id: Number(rows[0].id), title };
}

let bills_at_chiefs;
let chiefs_at_bills_next_week;
let chargers_at_chiefs;
let celtics_at_lakers;
let bills_at_chiefs_far;
let city_at_united;
let united_at_chelsea;
let chiefs_in_other_collection;

beforeAll(async () => {
  db = await new PGlite({ extensions: { citext, pg_trgm } });
  const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
  for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(await readFile(dir + f, 'utf8'));
  }
  sql = pgliteSql(db);
  const col = async (slug) =>
    Number(
      (
        await db.query(
          `insert into collections (slug, name) values ($1, $1) on conflict (slug) do update set name = $1 returning id`,
          [slug],
        )
      ).rows[0].id,
    );
  sportsId = await col('sports');
  otherId = await col('channels');
  sourceId = Number(
    (
      await db.query(
        `insert into sources (collection_id, adapter, slug, name) values ($1, 'espn', 'espn-schedule', 'ESPN') returning id`,
        [sportsId],
      )
    ).rows[0].id,
  );
  bills_at_chiefs = await seedFixture({ home: CHIEFS, away: BILLS, at: hours(2) });
  chiefs_at_bills_next_week = await seedFixture({ home: BILLS, away: CHIEFS, at: hours(5 * 24) });
  chargers_at_chiefs = await seedFixture({
    home: CHIEFS,
    away: CHARGERS,
    at: hours(-30),
    state: 'post',
  });
  celtics_at_lakers = await seedFixture({
    home: LAKERS,
    away: CELTICS,
    at: hours(26),
    league: { slug: 'nba', name: 'NBA', abbreviation: 'NBA' },
    sport: 'basketball',
  });
  // Outside the default window: only a date reaches it.
  bills_at_chiefs_far = await seedFixture({ home: CHIEFS, away: BILLS, at: hours(20 * 24) });
  const epl = { slug: 'eng.1', name: 'English Premier League', abbreviation: 'EPL' };
  city_at_united = await seedFixture({
    home: MAN_UTD,
    away: MAN_CITY,
    at: hours(20),
    league: epl,
    sport: 'soccer',
  });
  united_at_chelsea = await seedFixture({
    home: CHELSEA,
    away: MAN_UTD,
    at: hours(3 * 24),
    league: epl,
    sport: 'soccer',
  });
  chiefs_in_other_collection = await seedFixture({
    collectionId: otherId,
    home: CHIEFS,
    away: BILLS,
    at: hours(1),
  });
}, 60_000);

const match = (teams, opts = {}) =>
  matchFixtures(teams, { collectionId: sportsId, now: NOW, ...opts }, { sql });

describe('a side against a team', () => {
  test('equals, whole-word-contains or is contained by the team names, case and accents folded', () => {
    expect(sideMatchesTeam('Chiefs', CHIEFS)).toBe(true);
    expect(sideMatchesTeam('chiefs', CHIEFS)).toBe(true);
    expect(sideMatchesTeam('Kansas City Chiefs', CHIEFS)).toBe(true);
    expect(sideMatchesTeam('Kansas City', CHIEFS)).toBe(true);
    expect(sideMatchesTeam('KC', CHIEFS)).toBe(true);
    expect(sideMatchesTeam('Kansas City Chiefs Football', CHIEFS)).toBe(true);
    expect(sideMatchesTeam('Bills', CHIEFS)).toBe(false);
    expect(sideMatchesTeam('Chief', CHIEFS)).toBe(false);
    expect(sideMatchesTeam('Atletico Madrid', team('Atlético', 'Atlético Madrid', 'ATM'))).toBe(
      true,
    );
    expect(sideMatchesTeam('Atlético', team('Atletico', 'Atletico Madrid', 'ATM'))).toBe(true);
  });

  test('a supporter’s shorthand is spelled out: Man Utd is Manchester United, not City', () => {
    expect(expandSide('Man Utd')).toBe('manchester united');
    expect(expandSide('Man City FC')).toBe('manchester city');
    expect(sideMatchesTeam('Man Utd', MAN_UTD)).toBe(true);
    expect(sideMatchesTeam('Man Utd', MAN_CITY)).toBe(false);
    expect(sideMatchesTeam('Man City', MAN_CITY)).toBe(true);
    expect(sideMatchesTeam('Man City', MAN_UTD)).toBe(false);
    expect(sideMatchesTeam('LA Lakers', LAKERS)).toBe(true);
    expect(sideMatchesTeam('Chelsea FC', CHELSEA)).toBe(true);
  });
});

describe('scoring a fixture', () => {
  const row = (home, away, at, extra = {}) => ({
    published_at: at,
    tags: ['fixture', 'football', 'league:nfl', `state:${extra.state ?? 'pre'}`],
    data: { home, away, league: { slug: 'nfl', abbreviation: 'NFL' }, state: 'pre', ...extra },
  });

  test('both sides in either order score near 1, one side 0.45, neither nothing', () => {
    const f = row(CHIEFS, BILLS, hours(1));
    expect(scoreFixture({ teams: ['Chiefs', 'Bills'] }, f, NOW).score).toBeGreaterThan(0.95);
    expect(scoreFixture({ teams: ['Bills', 'Chiefs'] }, f, NOW).score).toBeGreaterThan(0.95);
    expect(scoreFixture({ teams: ['Chiefs', 'Chargers'] }, f, NOW)).toMatchObject({
      score: 0.45,
      sidesMatched: 1,
    });
    expect(scoreFixture({ teams: ['Lakers', 'Celtics'] }, f, NOW)).toBeNull();
  });

  test('nearer kickoff wins, in play wins outright, and the league adds a little back', () => {
    const soon = scoreFixture({ teams: ['Chiefs', 'Bills'] }, row(CHIEFS, BILLS, hours(2)), NOW);
    const later = scoreFixture({ teams: ['Chiefs', 'Bills'] }, row(BILLS, CHIEFS, hours(120)), NOW);
    const inPlay = scoreFixture(
      { teams: ['Chiefs', 'Bills'] },
      row(CHIEFS, BILLS, hours(-1), { state: 'in' }),
      NOW,
    );
    expect(inPlay.score).toBe(1);
    expect(soon.score).toBeGreaterThan(later.score);
    expect(later.score).toBeGreaterThan(0.5);
    const withLeague = scoreFixture(
      { teams: ['Chiefs', 'Bills'], league: 'NFL' },
      row(BILLS, CHIEFS, hours(120)),
      NOW,
    );
    expect(withLeague.score).toBeGreaterThan(later.score);
    const wrongLeague = scoreFixture(
      { teams: ['Chiefs', 'Bills'], league: 'NBA' },
      row(BILLS, CHIEFS, hours(120)),
      NOW,
    );
    expect(wrongLeague.score).toBe(later.score);
  });

  test('the window is 36 h back to 7 days on, or a day either side of the date asked for', () => {
    const d = fixtureWindow({ now: NOW });
    expect(d.from.toISOString()).toBe('2026-09-09T06:00:00.000Z');
    expect(d.to.toISOString()).toBe('2026-09-17T18:00:00.000Z');
    const on = fixtureWindow({ date: '2026-09-30', now: NOW });
    expect(on.from.toISOString()).toBe('2026-09-29T00:00:00.000Z');
    expect(on.to.toISOString()).toBe('2026-10-02T00:00:00.000Z');
    expect(fixtureWindow({ date: 'yesterday', now: NOW }).from).toEqual(d.from);
  });
});

describe('matchFixtures against Postgres', () => {
  test('Chiefs vs Bills finds the game in two hours, in both orders, over the rematch', async () => {
    for (const teams of [
      ['Chiefs', 'Bills'],
      ['Bills', 'Chiefs'],
    ]) {
      const rows = await match(teams);
      expect(rows.slice(0, 2).map((r) => r.id)).toEqual([
        bills_at_chiefs.id,
        chiefs_at_bills_next_week.id,
      ]);
      expect(rows[0].score).toBeGreaterThan(0.95);
      expect(rows[1].score).toBeGreaterThan(0.5);
      expect(rows[0].title).toBe('Buffalo Bills at Kansas City Chiefs');
      expect(rows[0].collection_slug).toBe('sports');
      // The Chargers game shares a side; it is there, under the floor.
      for (const r of rows.slice(2)) expect(r.score).toBe(0.45);
      expect(rows.slice(2).map((r) => r.id)).toEqual([chargers_at_chiefs.id]);
    }
  });

  test('one side matched scores under the 0.5 floor', async () => {
    const rows = await match(['Chiefs', 'Chargers'], { limit: 10 });
    expect(rows[0].id).toBe(chargers_at_chiefs.id);
    expect(rows[0].score).toBeGreaterThan(0.5);
    const oneSided = rows.filter((r) => r.id !== chargers_at_chiefs.id);
    expect(oneSided.map((r) => r.id)).toContain(bills_at_chiefs.id);
    for (const r of oneSided) expect(r.score).toBe(0.45);
  });

  test('the abbreviation, the full name and the shorthand all reach the fixture', async () => {
    expect((await match(['KC', 'BUF']))[0].id).toBe(bills_at_chiefs.id);
    expect((await match(['Kansas City Chiefs', 'Buffalo Bills']))[0].id).toBe(bills_at_chiefs.id);
    expect((await match(['LA Lakers', 'Boston']))[0].id).toBe(celtics_at_lakers.id);
    const derby = await match(['Man Utd', 'Man City']);
    expect(derby[0].id).toBe(city_at_united.id);
    expect(derby[0].score).toBeGreaterThan(0.9);
    expect((await match(['Man Utd', 'Chelsea']))[0].id).toBe(united_at_chelsea.id);
  });

  test('the league in front breaks a tie towards its fixture', async () => {
    const rows = await match(['Chiefs', 'Bills'], { league: 'NFL' });
    expect(rows[0].id).toBe(bills_at_chiefs.id);
    expect(rows[0].score).toBe(1);
  });

  test('date narrows to that day and the ones either side', async () => {
    expect((await match(['Chiefs', 'Bills'])).map((r) => r.id)).not.toContain(
      bills_at_chiefs_far.id,
    );
    const on = await match(['Chiefs', 'Bills'], { date: '2026-09-30' });
    expect(on.map((r) => r.id)).toEqual([bills_at_chiefs_far.id]);
    expect(on[0].score).toBeGreaterThan(0.9);
    expect(await match(['Chiefs', 'Bills'], { date: '2026-10-20' })).toEqual([]);
  });

  test('the collection asked for is honoured, and no collection means every fixture', async () => {
    const ids = (await match(['Chiefs', 'Bills'])).map((r) => r.id);
    expect(ids).not.toContain(chiefs_in_other_collection.id);
    const all = await matchFixtures(['Chiefs', 'Bills'], { now: NOW }, { sql });
    expect(all.map((r) => r.id)).toContain(chiefs_in_other_collection.id);
  });

  test('nothing to match is nothing back', async () => {
    expect(await match(['Chiefs'])).toEqual([]);
    expect(await match(null)).toEqual([]);
    expect(await match(['Alien', 'Predator'])).toEqual([]);
  });
});
