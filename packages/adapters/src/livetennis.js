import { defineAdapter, looseDate, slugify } from '@nichedb/core/adapter';

/**
 * Live Tennis API: the tennis source for the `sports` collection.
 *
 * Ported from tipoffwatch.com, where this provider replaced ESPN for tennis. ESPN
 * publishes tennis as a fortnight-shaped event holding a tree of draws; this
 * provider answers in tennis's own vocabulary -- ATP, WTA, Challenger and ITF,
 * singles and doubles, the current server, the points in the game being played,
 * games per set, surface, round and both players' rankings.
 *
 * The whole design is shaped by ONE constraint: the free key allows **100
 * requests per day**. So the provider is read whole, not per tour (`/matches` is
 * not scoped, so one response holds every tour), and a day counter in the cursor
 * simply stops spending at the ceiling rather than being told no by a 429. The
 * counter is seeded once a day from `/usage`, the provider's own count, because a
 * redeploy restarts the process and an in-memory count went back to zero while
 * the provider kept counting.
 *
 * At the default cadence of 30 minutes that is 48 live reads, a fixture and a
 * results read every six hours, and a results read whenever a live match vanished
 * from the board and the day's remaining budget can afford it: roughly 60 to 80
 * requests a day, inside 100 with room for a manual poke. The paid tiers raise
 * the ceiling (Basic 1k/day, Pro 10k, Ultra 500k); on one of those set the budget
 * up and the cadence down, and nothing else changes.
 */

const BASE = 'https://api.livetennisapi.com/api/public/v1';

export const PROVIDER = 'livetennis';

/**
 * The tours, which are this provider's leagues. `other` is the catch-all for rows
 * that carry no tour at all -- UTR events, exhibitions -- which are real fixtures
 * with real players and get a league of their own rather than being forced into
 * ITF. The slugs match tipoffwatch's, and ESPN's tennis-atp/tennis-wta, which is
 * why the ESPN adapters skip tennis by default.
 */
export const TOURS = [
  { key: 'atp', slug: 'tennis-atp', name: 'ATP Tour', abbreviation: 'ATP', priority: 3 },
  { key: 'wta', slug: 'tennis-wta', name: 'WTA Tour', abbreviation: 'WTA', priority: 3 },
  {
    key: 'challenger',
    slug: 'tennis-challenger',
    name: 'ATP Challenger Tour',
    abbreviation: 'CH',
    priority: 6,
  },
  {
    key: 'itf',
    slug: 'tennis-itf',
    name: 'ITF World Tennis Tour',
    abbreviation: 'ITF',
    priority: 8,
  },
  {
    key: 'other',
    slug: 'tennis-other',
    name: 'Other Tennis Events',
    abbreviation: 'TEN',
    priority: 12,
  },
];

const TOUR_BY_KEY = new Map(TOURS.map((t) => [t.key, t]));

/** A row's tour. Anything the provider does not classify lands in `other`. */
export const tourOf = (m) => {
  const t = String(m?.tour ?? '').toLowerCase();
  return TOUR_BY_KEY.has(t) && t !== 'other' ? t : 'other';
};

export function leagueItem(tour) {
  return {
    externalId: `${PROVIDER}:league:tennis:${tour.slug}`,
    kind: 'league',
    title: tour.name,
    summary: tour.abbreviation,
    url: null,
    imageUrl: null,
    publishedAt: null,
    timeKnown: false,
    precision: 'day',
    tags: ['league', 'tennis'],
    data: {
      provider: PROVIDER,
      sport: 'tennis',
      slug: tour.slug,
      key: tour.key,
      name: tour.name,
      abbreviation: tour.abbreviation,
      logoUrl: null,
      region: null,
      priority: tour.priority,
      abbrAmbiguous: false,
      supersededBy: null,
      plays_supported: false,
      boxscoreSupported: false,
    },
  };
}

/* --------------------------------------------------------------- matches -- */

/**
 * One side of a match: a player, or a doubles pair.
 *
 * The two are different id spaces -- there is a player 4382 and a pair 4382 -- so
 * the `p`/`d` prefix keeps them apart. The key carries no tour: a player in an ITF
 * draw one week and a Challenger the next is one person.
 */
export function side(p) {
  if (!p?.id || !p.name) return null;
  const isPair = p.is_doubles_team === true;
  const id = `${isPair ? 'd' : 'p'}${p.id}`;
  return {
    id,
    key: `${PROVIDER}/${id}`,
    slug: `${PROVIDER}-${id}`,
    name: p.name,
    displayName: p.name,
    // A ranking is the closest thing tennis has to an abbreviation.
    abbreviation: Number.isFinite(p.ranking) ? `#${p.ranking}` : null,
    logoUrl: null,
    score: null,
    record: null,
    country: p.country ? String(p.country).toUpperCase() : null,
    ranking: Number.isFinite(p.ranking) ? p.ranking : null,
  };
}

/** `pre` until it is being played, then `in`, then `post`. */
export function stateOf(m) {
  if (m?.status === 'live') return 'in';
  if (m?.status === 'completed' || m?.status === 'cancelled' || m?.outcome) return 'post';
  return 'pre';
}

/**
 * The line under the scoreline: the round (not started), the set being played (in
 * progress), or how it ended ("retired" and "walkover" are results in tennis and
 * must not read as "completed").
 */
export function statusDetail(m) {
  const state = stateOf(m);
  if (state === 'post') {
    const outcome = m.outcome && m.outcome !== 'completed' ? m.outcome : m.event_status;
    return outcome ? String(outcome).replace(/^./, (c) => c.toUpperCase()) : 'Final';
  }
  if (state === 'in') {
    const set = m.score?.games?.[0]?.length ?? null;
    return set ? `Set ${set}` : 'Live';
  }
  return m.round || m.round_code || null;
}

/** The scoreboard clock, which in tennis is the points in the game being played. */
export function displayClock(m) {
  const pts = m.score?.points;
  if (stateOf(m) !== 'in' || !Array.isArray(pts) || pts.length !== 2) return null;
  return m.score.is_tiebreak ? `TB ${pts[0]}-${pts[1]}` : `${pts[0]}-${pts[1]}`;
}

/**
 * The score that two integers cannot hold: games per set, who is serving, and the
 * points in the game being played. `games` is kept whatever the state, because
 * "6-4 4-6 7-5" IS the result; `points` and `serving` only while it is on. The
 * array order is [away, home] = [p1, p2].
 */
export function scoreDetail(m) {
  const s = m.score;
  const games = Array.isArray(s?.games) ? s.games : null;
  if (games?.length !== 2) return null;
  if (!Array.isArray(games[0]) || !Array.isArray(games[1])) return null;
  if (games[0].length === 0) return null;
  const live = stateOf(m) === 'in';
  const pts = Array.isArray(s.points) && s.points.length === 2 ? s.points.map(String) : null;
  return {
    kind: 'tennis',
    games,
    points: live ? pts : null,
    tiebreak: live ? s.is_tiebreak === true : false,
    serving: live && (s.server === 1 || s.server === 2) ? (s.server === 1 ? 'away' : 'home') : null,
  };
}

/**
 * A match -> a fixture. `p1` becomes the AWAY side and `p2` the home side,
 * because the fixture list renders away first and "Sinner vs Alcaraz" must put
 * the same two names in the same two places the provider did.
 */
export function normaliseMatch(m) {
  const away = side(m?.players?.p1);
  const home = side(m?.players?.p2);
  if (!away || !home || !m.id || !m.scheduled_time) return null;
  const sets = Array.isArray(m.score?.sets) ? m.score.sets : [];
  away.score = Number.isFinite(sets[0]) ? sets[0] : null;
  home.score = Number.isFinite(sets[1]) ? sets[1] : null;
  const tour = tourOf(m);
  const draw = m.is_doubles ? 'doubles' : 'singles';
  const qualifying = m.is_qualifying ? ' (Q)' : '';
  return {
    id: String(m.id),
    key: `${PROVIDER}/${tour}/${m.id}`,
    tour,
    updatedAt: m.updated_at ? Date.parse(m.updated_at) || 0 : 0,
    ...looseDate(m.scheduled_time),
    state: stateOf(m),
    statusDetail: statusDetail(m),
    name: `${away.name} vs ${home.name}`,
    // For tennis the tournament genuinely is the place.
    venue: m.tournament ?? null,
    venueCity:
      [m.round, `${draw}${qualifying}`, m.surface, m.indoor ? 'indoor' : null]
        .filter(Boolean)
        .join(' · ') || null,
    tournament: m.tournament ?? null,
    tournamentId: m.tournament_id ? String(m.tournament_id) : null,
    round: m.round ?? null,
    roundCode: m.round_code ?? null,
    surface: m.surface ?? null,
    indoor: m.indoor === true,
    doubles: m.is_doubles === true,
    qualifying: m.is_qualifying === true,
    period: m.score?.games?.[0]?.length ?? null,
    displayClock: displayClock(m),
    scoreDetail: scoreDetail(m),
    home,
    away,
  };
}

/** How far along a fixture is. A match only ever moves forward through these. */
const PROGRESS = { pre: 0, in: 1, post: 2 };

/**
 * Which copy of a fixture to keep when it turns up in more than one list. The
 * lists are refreshed on different clocks, so a stale live row must not reinstate
 * `in` on a match that finished: the state is the tiebreak and it cannot regress,
 * and `updated_at` settles the rest.
 */
export function wins(next, held) {
  const a = PROGRESS[next.state] ?? 0;
  const b = PROGRESS[held.state] ?? 0;
  if (a !== b) return a > b;
  return next.updatedAt >= held.updatedAt;
}

/** Every match in the rows, one copy each, the most advanced copy winning. */
export function mergeMatches(rows) {
  const byKey = new Map();
  for (const raw of rows) {
    const m = normaliseMatch(raw);
    if (!m) continue;
    const held = byKey.get(m.key);
    if (!held || wins(m, held)) byKey.set(m.key, m);
  }
  return [...byKey.values()];
}

export function fixtureItem(m) {
  const tour = TOUR_BY_KEY.get(m.tour) ?? TOUR_BY_KEY.get('other');
  return {
    externalId: `${PROVIDER}:fixture:${m.id}`,
    kind: 'fixture',
    title: m.name,
    summary: [m.tournament, m.round].filter(Boolean).join(' · ') || null,
    url: null,
    imageUrl: null,
    publishedAt: m.publishedAt,
    timeKnown: m.timeKnown,
    precision: m.precision,
    tags: [
      'fixture',
      'tennis',
      `league:${tour.slug}`,
      `state:${m.state}`,
      `team:${m.home.slug}`,
      `team:${m.away.slug}`,
      `draw:${m.doubles ? 'doubles' : 'singles'}`,
    ],
    data: {
      provider: PROVIDER,
      sport: 'tennis',
      id: m.id,
      key: m.key,
      league: {
        slug: tour.slug,
        key: tour.key,
        name: tour.name,
        abbreviation: tour.abbreviation,
        region: null,
      },
      name: m.name,
      shortName: null,
      home: m.home,
      away: m.away,
      state: m.state,
      statusDetail: m.statusDetail,
      period: m.period,
      displayClock: m.displayClock,
      venue: m.venue,
      venueCity: m.venueCity,
      venueRegion: null,
      neutralSite: true,
      attendance: null,
      // This provider carries no broadcast data. Null rather than empty so a
      // listings pass still treats these as unfilled.
      broadcast: null,
      broadcastSource: null,
      broadcastMarkets: null,
      odds: null,
      scoreDetail: m.scoreDetail,
      plays_supported: false,
      boxscoreSupported: false,
      timeKnown: m.timeKnown,
      tournament: false,
      tournamentName: m.tournament,
      tournamentId: m.tournamentId,
      round: m.round,
      roundCode: m.roundCode,
      surface: m.surface,
      indoor: m.indoor,
      doubles: m.doubles,
      qualifying: m.qualifying,
    },
  };
}

/* ----------------------------------------------------------- tournaments -- */

/**
 * The tournaments, one row each, alongside their matches.
 *
 * tipoffwatch left these out, and its reasons are met here rather than ignored.
 * `tournament_id` is per DRAW, so Winston-Salem arrived twice: this keys on the
 * tour and the name instead. The earliest match in a two-day window moves
 * forward every day, so a fortnight kept announcing it started today: the first
 * start ever seen is kept in the cursor and never moved later. And a calendar
 * that is mostly headers is a reader's problem to filter, which the `tournament`
 * tag lets them do.
 *
 * @param {object} starts cursor map of tournament key -> first start ISO, updated in place
 */
export function tournamentItems(matches, starts, now = Date.now()) {
  const groups = new Map();
  for (const m of matches) {
    if (!m.tournament) continue;
    const key = `${m.tour}:${slugify(m.tournament)}`;
    const g = groups.get(key) ?? { key, tour: m.tour, name: m.tournament, matches: [] };
    g.matches.push(m);
    groups.set(key, g);
  }
  const items = [];
  for (const g of groups.values()) {
    const first = g.matches
      .map((m) => m.publishedAt?.getTime?.())
      .filter(Number.isFinite)
      .sort((a, b) => a - b)[0];
    if (!Number.isFinite(first)) continue;
    const held = Date.parse(starts[g.key] ?? '');
    const start = Number.isFinite(held) ? Math.min(held, first) : first;
    starts[g.key] = new Date(start).toISOString();
    const tour = TOUR_BY_KEY.get(g.tour) ?? TOUR_BY_KEY.get('other');
    const states = new Set(g.matches.map((m) => m.state));
    const state = states.has('in') ? 'in' : states.has('pre') ? 'pre' : 'post';
    const surface = g.matches.find((m) => m.surface)?.surface ?? null;
    items.push({
      externalId: `${PROVIDER}:fixture:tournament:${g.key}`,
      kind: 'fixture',
      title: g.name,
      summary: [tour.name, surface].filter(Boolean).join(' · '),
      url: null,
      imageUrl: null,
      publishedAt: new Date(start),
      timeKnown: false,
      precision: 'day',
      tags: ['fixture', 'tennis', `league:${tour.slug}`, `state:${state}`, 'tournament'],
      data: {
        provider: PROVIDER,
        sport: 'tennis',
        id: g.key,
        key: `${PROVIDER}/${g.tour}/tournament/${slugify(g.name)}`,
        league: {
          slug: tour.slug,
          key: tour.key,
          name: tour.name,
          abbreviation: tour.abbreviation,
          region: null,
        },
        name: g.name,
        shortName: null,
        home: null,
        away: null,
        state,
        statusDetail: null,
        period: null,
        displayClock: null,
        venue: g.name,
        venueCity: null,
        venueRegion: null,
        neutralSite: true,
        attendance: null,
        broadcast: null,
        broadcastSource: null,
        broadcastMarkets: null,
        odds: null,
        scoreDetail: null,
        plays_supported: false,
        boxscoreSupported: false,
        timeKnown: false,
        tournament: true,
        surface,
        matches: g.matches.length,
        seenAt: new Date(now).toISOString(),
      },
    });
  }
  return items;
}

/* ---------------------------------------------------------------- budget -- */

export const utcDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

/**
 * Today's spend, from the cursor, rolled over when the UTC day has -- as the
 * provider counts it. `limit` is the lower of what was asked for and what the
 * plan actually allows, once `/usage` has said.
 */
export function budgetFrom(cursor, config, now = Date.now()) {
  const day = utcDay(now);
  const same = cursor?.day === day;
  const configured = Math.max(1, Number(config?.dailyBudget) || 95);
  const perDay = Number.isFinite(cursor?.providerPerDay) ? cursor.providerPerDay : null;
  return {
    day,
    calls: same ? Number(cursor?.calls) || 0 : 0,
    seeded: same && cursor?.seededDay === day,
    providerPerDay: perDay,
    limit: perDay === null ? configured : Math.min(configured, perDay),
  };
}

/**
 * How many requests the rest of today's regular reads will need, so an optional
 * read can be refused before it starves the scores. One live read per remaining
 * run, plus the scheduled fixture and results refreshes.
 */
export function reserveFor(now, cadenceMinutes, fixturesHours) {
  const msLeft = DAY_MS - (now % DAY_MS);
  const runsLeft = Math.ceil(msLeft / (Math.max(1, cadenceMinutes) * 60_000));
  const refreshes = Math.ceil(msLeft / (Math.max(1, fixturesHours) * HOUR_MS)) * 2;
  return runsLeft + refreshes;
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** The list endpoints, each read whole (every tour at once). */
const LISTS = {
  live: { path: '/matches?status=live', maxPages: 2 },
  upcoming: { path: '/matches?status=upcoming', maxPages: 2 },
  // Read from `/history` rather than `?status=completed`, which is a paid tier.
  recent: { path: '/history/matches', maxPages: 1 },
};

export const livetennis = defineAdapter({
  name: 'livetennis',
  title: 'Live Tennis API',
  collection: 'sports',
  description:
    'Tennis fixtures and live scores across ATP, WTA, Challenger and ITF, singles and doubles, with games per set, the server and the points in the current game, plus surface, round and rankings. Reads the whole board rather than per tour and counts its requests in the cursor, seeded from the provider, so a free key (100 requests a day) is never exceeded: live scores every run, fixtures and results every six hours, and a results read when a live match ends if the day can afford it. Set LIVETENNIS_API_KEY.',
  docs: 'https://livetennisapi.com/docs',
  kinds: ['league', 'fixture'],
  cadenceMinutes: 30,
  needsEnv: ['livetennisApiKey'],
  configFields: [
    {
      key: 'dailyBudget',
      label: 'Requests per day',
      type: 'number',
      placeholder: '95',
      help: 'A hard ceiling per UTC day. Ninety-five leaves five of the free tier for a manual poke; raise it on a paid key.',
    },
    {
      key: 'fixturesHours',
      label: 'Fixture refresh (hours)',
      type: 'number',
      placeholder: '6',
      help: 'How often the upcoming and just-finished lists are re-read. Draws are published a day or two out and do not churn.',
    },
  ],
  defaults: { dailyBudget: 95, fixturesHours: 6 },
  defaultSources: [
    {
      slug: 'livetennis',
      name: 'Sports: Live Tennis fixtures and scores',
      config: { dailyBudget: 95, fixturesHours: 6 },
    },
  ],
  async pull({ config, cursor: prev, env, http, log }) {
    const key = env.livetennisApiKey ?? env.LIVETENNIS_API_KEY;
    if (!key) throw new Error('LIVETENNIS_API_KEY is not set');
    const now = Date.now();
    const budget = budgetFrom(prev, config, now);
    const fixturesHours = Math.max(1, Number(config.fixturesHours) || 6);
    const headers = { authorization: `Bearer ${key}`, accept: 'application/json' };
    const spent = () => budget.calls;

    class BudgetExhausted extends Error {}
    async function get(path) {
      if (budget.calls >= budget.limit)
        throw new BudgetExhausted(`budget of ${budget.limit} spent`);
      budget.calls += 1;
      return http.json(`${BASE}${path}`, { headers, timeoutMs: 20_000 });
    }

    // Once a day, the provider's own count of what we have spent. Not fatal: being
    // unable to ask how much is left is no reason to stop working.
    let seededDay = budget.seeded ? budget.day : null;
    if (!budget.seeded) {
      try {
        const body = await get('/usage');
        const used = body?.today?.calls;
        const perDay = body?.limits?.per_day;
        if (Number.isFinite(perDay) && perDay > 0) {
          budget.providerPerDay = perDay;
          budget.limit = Math.min(budget.limit, perDay);
        }
        // +1 for this very request, and never downward.
        if (Number.isFinite(used)) budget.calls = Math.max(budget.calls, used + 1);
        seededDay = budget.day;
      } catch (err) {
        log(`usage read failed (${err?.message ?? err}); counting locally`);
      }
    }

    async function pages(list) {
      const rows = [];
      for (let page = 0; page < list.maxPages; page++) {
        const sep = list.path.includes('?') ? '&' : '?';
        const body = await get(`${list.path}${sep}limit=100&offset=${page * 100}`);
        rows.push(...(body?.data ?? []));
        if (!body?.meta?.has_more) break;
      }
      return rows;
    }

    const rows = [];
    const read = [];
    let exhausted = false;
    async function tryRead(name, list) {
      try {
        const got = await pages(list);
        rows.push(...got);
        read.push(`${name} ${got.length}`);
        return true;
      } catch (err) {
        if (err instanceof BudgetExhausted) exhausted = true;
        log(`${name} unavailable (${err?.message ?? err})`);
        return false;
      }
    }

    const liveOk = await tryRead('live', LISTS.live);
    const liveIds = liveOk
      ? rows.filter((r) => r?.status === 'live').map((r) => String(r.id))
      : (prev.liveIds ?? []);
    const vanished = liveOk ? (prev.liveIds ?? []).filter((id) => !liveIds.includes(id)) : [];

    const due = (at) => !Number.isFinite(at) || now - at >= fixturesHours * HOUR_MS;
    let upcomingAt = prev.upcomingAt;
    let recentAt = prev.recentAt;
    if (!exhausted && due(upcomingAt) && (await tryRead('upcoming', LISTS.upcoming))) {
      upcomingAt = now;
    }
    // A match drops out of the live list the moment it ends, so without this read
    // every fixture would sit at `in` with the last score anyone saw. Read on the
    // clock, and early when something vanished and the day can afford it.
    const reserve = reserveFor(now, 30, fixturesHours);
    const affordable = budget.calls + 1 + reserve <= budget.limit;
    if (!exhausted && (due(recentAt) || (vanished.length > 0 && affordable))) {
      if (await tryRead('recent', LISTS.recent)) recentAt = now;
    }

    const matches = mergeMatches(rows);
    const starts = { ...(prev.tournamentStarts ?? {}) };
    const items = [
      ...TOURS.map(leagueItem),
      ...matches.map(fixtureItem),
      ...tournamentItems(matches, starts, now),
    ];
    const live = matches.filter((m) => m.state === 'in').length;

    return {
      items,
      cursor: {
        day: budget.day,
        calls: budget.calls,
        seededDay,
        providerPerDay: budget.providerPerDay,
        upcomingAt,
        recentAt,
        liveIds,
        tournamentStarts: starts,
      },
      note: `${matches.length} matches (${live} live) from ${read.join(', ') || 'nothing'}; ${spent()}/${budget.limit} requests today${exhausted ? ', budget spent' : ''}`,
    };
  },
});
