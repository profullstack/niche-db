import { defineAdapter, slugify } from '@nichedb/core/adapter';

import { DEFAULT_KEY, PROVIDER, premium, redact, sportSlug, v2 } from './sportsdb.js';

/**
 * TheSportsDB: live scores for the `sports` collection.
 *
 * The second live-score source here, and deliberately not a replacement for
 * espn-live. ESPN is the deeper of the two -- clock, period, venue, odds and
 * play-by-play -- but its scoreboards are US-facing, it blocks cloud egress, so
 * every request goes through the metered residential proxy in SPORTS_PROXY_URL
 * at a few hundred kilobytes a scoreboard, and a run can only afford to probe a
 * handful of leagues. This one is a single request, about 50 KB, straight from
 * thesportsdb.com with no proxy, and it answers for every league TheSportsDB
 * covers at once: one sample carried games from the Slovak Extraliga, the
 * Uruguayan Primera and a Japanese basketball league, none of which an ESPN
 * scoreboard would have been probed for.
 *
 * It exists because the key does. `livescore/all` is v2 and v2 is subscribers
 * only -- there is no live endpoint of any kind on the shared test key, in
 * either version -- so with no SPORTSDB_API_KEY set this source does nothing
 * and says so rather than failing on every run.
 *
 * The rows are fixtures (kind `fixture`, the shape espn.js emits) rather than a
 * kind of their own, so a reader asking /c/sports for what is on right now gets
 * both providers' answers side by side. They do NOT merge: the external ids are
 * this provider's, so a game ESPN also has is two rows, the way a TheSportsDB
 * broadcast listing and an ESPN fixture are two rows. Matching them is the
 * mirror's job, with the fixture in hand, for the reason set out in sportsdb.js.
 *
 * Status codes are per sport and terse -- `1H`, `HT`, `P2`, `Q3`, `BT`, `FT`,
 * `NS`, `CANC` -- so the raw code travels as `data.statusCode` and only the
 * coarse pre/in/post state is derived from it. `strTimestamp` is UTC written
 * without a zone ("2026-09-23T15:30:00"), which parses as local time unless a Z
 * is appended, and `strProgress` is the minute or period count as a string,
 * absent on a game that has not started.
 */

/** Sports with a livescore feed of their own; `all` is every one of them. */
export const LIVE_SPORTS = ['soccer', 'basketball', 'baseball', 'ice_hockey', 'american_football'];

/** Statuses that mean the game has not begun. */
const PRE = new Set(['NS', 'TBD', 'TBA', 'PST', 'POSTP', 'POSTPONED', 'SUSP']);

/** Statuses that mean it is over, one way or another. */
const POST = new Set([
  'FT',
  'AET',
  'PEN',
  'AP',
  'FIN',
  'FINAL',
  'AOT',
  'ABD',
  'CANC',
  'CANCELLED',
  'AWD',
  'WO',
]);

/** Statuses that mean it is over without being played out. */
const UNPLAYED = new Set(['ABD', 'CANC', 'CANCELLED', 'AWD', 'WO', 'PST', 'POSTP', 'POSTPONED']);

const text = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
};

const score = (v) => {
  const s = text(v);
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** pre, in or post from a status code; anything unrecognised is a game in play. */
export function liveState(status) {
  const code = (text(status) ?? '').toUpperCase();
  if (!code) return 'in';
  if (PRE.has(code)) return 'pre';
  if (POST.has(code)) return 'post';
  return 'in';
}

/**
 * TheSportsDB writes its timestamps in UTC without a zone, so `Date.parse`
 * reads them as local time and a run on a box in another zone shifts every
 * kick-off by its offset. Appending the Z is the whole fix.
 */
export function liveTime(row) {
  const stamp = text(row?.strTimestamp);
  if (stamp) {
    const iso = /(z|[+-]\d{2}:?\d{2})$/i.test(stamp) ? stamp : `${stamp}Z`;
    const t = Date.parse(iso);
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  const day = text(row?.dateEvent);
  if (!day) return null;
  const clock = text(row?.strEventTime) ?? '00:00:00';
  const t = Date.parse(`${day}T${clock.length === 5 ? `${clock}:00` : clock}Z`);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** The live rows of a v2 answer, each with an event id and two sides. */
export function parseLive(body) {
  const rows = body?.livescore ?? body?.Livescore ?? body?.all;
  if (!Array.isArray(rows)) return [];
  return rows.filter((r) => text(r?.idEvent) && text(r?.strHomeTeam) && text(r?.strAwayTeam));
}

/** One live row -> one fixture item. */
export function liveItem(row) {
  const id = String(row.idEvent);
  const home = text(row.strHomeTeam);
  const away = text(row.strAwayTeam);
  const sportName = text(row.strSport);
  const sport = sportName ? sportSlug(sportName) : null;
  const league = text(row.strLeague);
  const leagueSlug = league ? slugify(league) : null;
  const state = liveState(row.strStatus);
  const statusCode = text(row.strStatus);
  const homeScore = score(row.intHomeScore);
  const awayScore = score(row.intAwayScore);
  const scored = homeScore !== null || awayScore !== null;
  const progress = text(row.strProgress);
  return {
    externalId: `${PROVIDER}:fixture:${id}`,
    kind: 'fixture',
    title: `${home} vs ${away}`,
    summary:
      [scored ? `${homeScore ?? 0}-${awayScore ?? 0}` : null, statusCode, league]
        .filter(Boolean)
        .join(' · ') || null,
    url: `https://www.thesportsdb.com/event/${id}`,
    imageUrl: text(row.strHomeTeamBadge) ?? text(row.strAwayTeamBadge),
    publishedAt: liveTime(row),
    timeKnown: true,
    precision: 'minute',
    tags: [
      'fixture',
      'live',
      sport,
      leagueSlug ? `league:${leagueSlug}` : null,
      `state:${state}`,
      home ? `team:${slugify(home)}` : null,
      away ? `team:${slugify(away)}` : null,
    ].filter(Boolean),
    data: {
      provider: PROVIDER,
      attribution: 'TheSportsDB (thesportsdb.com)',
      id,
      liveId: text(row.idLiveScore),
      sport,
      sportName,
      league: {
        id: text(row.idLeague),
        slug: leagueSlug,
        name: league,
        division: text(row.intDivision),
      },
      home: { id: text(row.idHomeTeam), name: home, badge: text(row.strHomeTeamBadge) },
      away: { id: text(row.idAwayTeam), name: away, badge: text(row.strAwayTeamBadge) },
      homeScore,
      awayScore,
      state,
      statusCode,
      statusDetail: statusCode,
      unplayed: UNPLAYED.has((statusCode ?? '').toUpperCase()),
      progress,
      day: text(row.dateEvent),
      eventTime: text(row.strEventTime),
      updatedAt: text(row.updated),
      eventPageUrl: `https://www.thesportsdb.com/event/${id}`,
    },
  };
}

/** The feed a config asks for: one sport, or every one of them. */
export function livePath(config) {
  const raw = text(config?.sport);
  if (!raw || raw.toLowerCase() === 'all') return 'livescore/all';
  return `livescore/${encodeURIComponent(raw)}`;
}

export const sportsdbLive = defineAdapter({
  name: 'sportsdb-live',
  title: 'TheSportsDB live scores',
  collection: 'sports',
  description:
    "The score, status and progress of every game being played right now, worldwide, in one request. Complements espn-live rather than replacing it: ESPN carries the clock, venue, odds and play-by-play but is US-facing, blocks cloud egress (so every scoreboard costs residential proxy bandwidth) and can only probe a few leagues a run, while this is 50 KB direct from thesportsdb.com covering every league it knows, from the Slovak Extraliga to the Uruguayan Primera. Rows are fixtures under this provider's own ids, so a game both sources have is two rows and matching them is the reader's call. Subscribers only: the live endpoints are v2 and the shared test key has none, so without SPORTSDB_API_KEY this source stays quiet.",
  docs: 'https://www.thesportsdb.com/documentation',
  kinds: ['fixture'],
  cadenceMinutes: 2,
  configFields: [
    {
      key: 'sport',
      label: 'Sport',
      type: 'text',
      placeholder: 'all',
      help: 'One of soccer, basketball, baseball, ice_hockey, american_football, or all for every game at once. All is one request and is what the default source asks for.',
    },
  ],
  defaults: { sport: 'all' },
  defaultSources: [{ slug: 'sportsdb-live', name: 'Sports: live scores (TheSportsDB)' }],
  async pull({ config, env, http }) {
    const key = String(env?.sportsdbApiKey ?? env?.SPORTSDB_API_KEY ?? DEFAULT_KEY);
    if (!premium(key)) {
      return {
        items: [],
        note: 'no subscriber key: TheSportsDB has no live endpoint on the shared test key, so nothing was asked for. Set SPORTSDB_API_KEY.',
      };
    }

    const path = livePath(config);
    let body = null;
    try {
      body = await v2(http, key, path);
    } catch (err) {
      throw new Error(`thesportsdb live unavailable (${redact(err?.message ?? err, key)})`);
    }

    const rows = parseLive(body);
    const items = [];
    const seen = new Set();
    let live = 0;
    for (const row of rows) {
      const item = liveItem(row);
      if (seen.has(item.externalId)) continue;
      seen.add(item.externalId);
      if (item.data.state === 'in') live += 1;
      items.push(item);
    }

    return {
      items,
      note: `${items.length} games (${live} in play) from one request`,
    };
  },
});
