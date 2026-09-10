import { sql as defaultSql } from './index.js';

/**
 * The fixture behind a matchup name.
 *
 * A playlist calls an event channel "NFL: Chiefs vs Bills"; the fixture in the
 * sports collection is called "Buffalo Bills at Kansas City Chiefs" and its
 * `data.home` / `data.away` carry `{ name: 'Chiefs', displayName: 'Kansas City
 * Chiefs', abbreviation: 'KC' }`. Trigram similarity on the title alone does
 * not get from one to the other, so a matchup is scored by team: each side the
 * caller parsed out is compared with both teams of every fixture in the window,
 * in both orders, and the fixture where both sides land wins.
 *
 * One SQL statement fetches the candidates (kind fixture, kicking off in the
 * window, title or abbreviation near either side, which the trigram index
 * answers); the scoring is done here, where the team fields are.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** How a supporter shortens a name, and what the record calls it. */
const ALIASES = new Map([
  ['man', 'manchester'],
  ['utd', 'united'],
  ['man u', 'manchester united'],
  ['ny', 'new york'],
  ['nyc', 'new york'],
  ['la', 'los angeles'],
  ['sf', 'san francisco'],
  ['kc', 'kansas city'],
  ['nola', 'new orleans'],
  ['gb', 'green bay'],
  ['ne', 'new england'],
  ['tb', 'tampa bay'],
  ['okc', 'oklahoma city'],
  ['atl', 'atletico'],
  ['ath', 'athletic'],
  ['wolves', 'wolverhampton wanderers'],
  ['psg', 'paris saint germain'],
  ['inter', 'internazionale'],
  ['juve', 'juventus'],
  ['barca', 'barcelona'],
  ['bayern', 'bayern munich'],
  ['dortmund', 'borussia dortmund'],
  ['gladbach', 'borussia monchengladbach'],
]);

/** Club suffixes that neither side needs to agree on. */
const CLUB_WORDS = new Set([
  'fc',
  'afc',
  'cf',
  'sc',
  'ac',
  'sk',
  'fk',
  'bk',
  'cd',
  'ud',
  'rc',
  'as',
]);

/**
 * The short form both a side and a team name are brought to before they are
 * compared, so "Alcorn St" meets "Alcorn State Braves" and "Man Utd" meets
 * "Manchester United" whichever way round each was written.
 */
const SHORT = new Map([
  ['state', 'st'],
  ['saint', 'st'],
  ['university', 'univ'],
  ['united', 'utd'],
  ['manchester', 'man'],
  ['athletic', 'ath'],
  ['atletico', 'atl'],
  ['internazionale', 'inter'],
  ['juventus', 'juve'],
]);

/** Lower case, diacritics folded, punctuation to spaces. */
export function foldName(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** A side as a supporter wrote it, with its shorthand spelled out. */
export function expandSide(side) {
  const folded = foldName(side);
  const whole = ALIASES.get(folded);
  if (whole) return whole;
  return folded
    .split(' ')
    .filter((t) => !CLUB_WORDS.has(t))
    .map((t) => ALIASES.get(t) ?? t)
    .join(' ')
    .trim();
}

/** Folded, club suffixes dropped, long words shortened: what is compared. */
export function canonName(value) {
  return foldName(value)
    .split(' ')
    .filter((t) => t && !CLUB_WORDS.has(t))
    .map((t) => SHORT.get(t) ?? t)
    .join(' ');
}

const wholeWordIn = (needle, haystack) =>
  needle.length > 0 && ` ${haystack} `.includes(` ${needle} `);

/**
 * Whether a side names this team: it equals, whole-word-contains or is contained
 * by the team's display name, name, short name or abbreviation, or every word
 * of the spelled-out side is a word of the team's names ("Man Utd" against
 * "Manchester United").
 */
export function sideMatchesTeam(side, team) {
  if (!team) return false;
  const raw = canonName(side);
  const expanded = canonName(expandSide(side));
  if (!raw) return false;
  // The abbreviation only ever matches whole: "MAN" is Manchester United, but
  // "Man City" is not.
  const abbreviation = foldName(team.abbreviation);
  if (abbreviation && (abbreviation === raw || abbreviation === foldName(side))) return true;
  const fields = [team.displayName, team.name, team.shortName, team.location]
    .filter(Boolean)
    .map(canonName)
    .filter(Boolean);
  for (const f of fields) {
    if (f === raw || f === expanded) return true;
  }
  const longFields = fields.filter((f) => f.length >= 3);
  for (const f of longFields) {
    if (wholeWordIn(raw, f) || wholeWordIn(expanded, f)) return true;
    if (raw.length >= 3 && wholeWordIn(f, raw)) return true;
    if (expanded.length >= 3 && wholeWordIn(f, expanded)) return true;
  }
  const words = new Set(longFields.flatMap((f) => f.split(' ')));
  const tokens = expanded.split(' ').filter(Boolean);
  return (
    tokens.length > 0 && tokens.some((t) => t.length >= 4) && tokens.every((t) => words.has(t))
  );
}

/** Whether the league the caller named is the fixture's. */
export function leagueMatches(league, item) {
  const want = foldName(league);
  if (!want) return false;
  const meta = item.data?.league ?? {};
  const names = [meta.abbreviation, meta.name, meta.slug].filter(Boolean).map(foldName);
  if (names.includes(want)) return true;
  const slug = want.replace(/ /g, '-');
  return (item.tags ?? []).some((t) => t === `league:${slug}` || t === `league:${want}`);
}

/**
 * How well a fixture answers the matchup, or null when neither side is in it.
 *
 * Both sides matched, in either order: 1.0 less a little for every day between
 * kickoff and `now` (in play is 0 away), so a game on now beats the rematch next
 * week; the league named in front adds a little back. One side only: 0.45, under
 * the 0.5 floor callers apply, so "Chiefs vs Bills" never answers with the
 * Chargers game.
 *
 * @returns {{ score: number, distanceHours: number, sidesMatched: 1|2 }|null}
 */
export function scoreFixture({ teams, league = null }, item, now = new Date()) {
  const [a, b] = teams ?? [];
  const home = item.data?.home ?? null;
  const away = item.data?.away ?? null;
  if (!a || !b || (!home && !away)) return null;
  const aHome = sideMatchesTeam(a, home);
  const aAway = sideMatchesTeam(a, away);
  const bHome = sideMatchesTeam(b, home);
  const bAway = sideMatchesTeam(b, away);
  const both = (aAway && bHome) || (aHome && bAway);
  if (!both && !aHome && !aAway && !bHome && !bAway) return null;
  const kickoff = item.published_at ? new Date(item.published_at) : null;
  const inPlay = item.data?.state === 'in';
  const distanceHours =
    inPlay || !kickoff || Number.isNaN(kickoff.getTime())
      ? inPlay
        ? 0
        : 72
      : Math.abs(kickoff.getTime() - now.getTime()) / HOUR;
  if (!both) return { score: 0.45, distanceHours, sidesMatched: 1 };
  const penalty = Math.min(0.25, (distanceHours / 24) * 0.04);
  const boost = league && leagueMatches(league, item) ? 0.05 : 0;
  return {
    score: Math.round(Math.min(1, 1 - penalty + boost) * 1000) / 1000,
    distanceHours,
    sidesMatched: 2,
  };
}

/** The window fixtures are looked for in: a day either side of `date`, else 36 h back to 7 days on. */
export function fixtureWindow({ date = null, now = new Date() } = {}) {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(date ?? '')) ? new Date(`${date}T00:00:00Z`) : null;
  if (day && !Number.isNaN(day.getTime())) {
    return {
      from: new Date(day.getTime() - DAY),
      to: new Date(day.getTime() + 2 * DAY),
      reference: new Date(day.getTime() + 12 * HOUR),
    };
  }
  return {
    from: new Date(now.getTime() - 36 * HOUR),
    to: new Date(now.getTime() + 7 * DAY),
    reference: now,
  };
}

/**
 * The fixtures a matchup name is about, best first, each with `score`.
 *
 * `teams` are the two sides as parsed; `league` the label in front, if any;
 * `date` a YYYY-MM-DD to look on instead of the default window. `sql` can be
 * swapped for a test's own client.
 */
export async function matchFixtures(
  teams,
  { league = null, collectionId = null, date = null, now = new Date(), limit = 5 } = {},
  { sql = defaultSql } = {},
) {
  const sides = (teams ?? []).map((t) => String(t ?? '').trim()).filter(Boolean);
  if (sides.length !== 2) return [];
  const { from, to, reference } = fixtureWindow({ date, now });
  // Each side as written and as spelled out, so "Man Utd" reaches "Manchester
  // United at Chelsea" through the title and "KC" through the abbreviation.
  const [a1, b1] = sides.map(foldName);
  const [a2, b2] = sides.map(expandSide);
  const rows = await sql`
    select i.*, s.slug as source_slug, s.name as source_name, s.adapter,
      c.slug as collection_slug, c.name as collection_name
    from items i join sources s on s.id = i.source_id join collections c on c.id = i.collection_id
    where i.kind = 'fixture'
      and (${collectionId === null} or i.collection_id = ${collectionId})
      and i.published_at >= ${from.toISOString()}::timestamptz
      and i.published_at < ${to.toISOString()}::timestamptz
      and (
        i.title ilike ${`%${a1}%`} or i.title ilike ${`%${a2}%`}
        or i.title ilike ${`%${b1}%`} or i.title ilike ${`%${b2}%`}
        or ${a1} <% i.title or ${a2} <% i.title
        or ${b1} <% i.title or ${b2} <% i.title
        or lower(coalesce(i.data->'home'->>'abbreviation', '')) in (${a1}, ${b1})
        or lower(coalesce(i.data->'away'->>'abbreviation', '')) in (${a1}, ${b1})
        or lower(coalesce(i.data->'home'->>'name', '')) in (${a1}, ${b1}, ${a2}, ${b2})
        or lower(coalesce(i.data->'away'->>'name', '')) in (${a1}, ${b1}, ${a2}, ${b2})
      )
    order by i.published_at asc
    limit 200
  `;
  const scored = [];
  for (const row of rows) {
    const hit = scoreFixture({ teams: sides, league }, row, reference);
    if (hit) scored.push({ ...row, score: hit.score, distance_hours: hit.distanceHours });
  }
  scored.sort(
    (x, y) =>
      y.score - x.score || x.distance_hours - y.distance_hours || Number(y.id) - Number(x.id),
  );
  return scored.slice(0, Math.min(Math.max(1, limit), 50));
}
