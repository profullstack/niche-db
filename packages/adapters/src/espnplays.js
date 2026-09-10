import { defineAdapter } from '@nichedb/core/adapter';
import {
  DEADLINE_MARGIN_MS,
  ensureCatalogue,
  fetchSchedule,
  fixtureTitle,
  HOUR_MS,
  keepsWatch,
  leagueKeysOf,
  liveTargets,
  makeEspnClient,
  NO_BOXSCORE,
  NO_PLAYS,
  normaliseState,
  oddsFromCompetition,
  PROVIDER,
  pool,
  regionFor,
  SITE,
  SKIP_SPORTS_FIELD,
  WATCH_GRACE_MS,
} from './espn.js';

/**
 * Play-by-play and box-score recaps, one item per fixture, into `sports`.
 *
 * Ported from tipoffwatch.com's play poller (`syncPlays` and the two queues
 * behind it). There the site knew which fixtures were worth a summary because it
 * had its own events table; here the adapter cannot read another source's
 * cursor, so it learns the same thing the way `espn-live` does: a watch map of
 * leagues with a game on, kept in its own cursor and fed by a rolling probe of
 * the catalogue, plus whatever leagues are pinned in config.
 *
 * The summary endpoint is the one that costs: ~500 KB a fixture, every byte of
 * it through the metered residential proxy, and there is no smaller endpoint.
 * So each run reads a handful (`summariesPerRun`, default 8) and no more, the
 * plays and the recap come out of that one read, and a finished game is read
 * exactly once more after the whistle and then closed out in the cursor.
 *
 * Which sports have what, measured on tipoffwatch 2026-08-21 and 2026-09-06:
 *   plays and a box score   baseball, basketball, football, soccer, hockey, AFL
 *   box score only          field hockey, lacrosse, rugby, rugby league,
 *                           volleyball, water polo
 *   no summary at all       tennis, golf, racing, mma (an "event" there is a
 *                           tournament, a race weekend or a card, and the
 *                           summary endpoint wants the individual match)
 */

export const KIND = 'plays';

/**
 * How many plays a live item carries. A game in progress is re-read every few
 * minutes, and a mirror appends only what is new, so the tail of the log is all
 * it needs; the whole log lands once the game is final. An MLB game with every
 * pitch is ~700 plays, so the final cap is a guard against a pathological
 * summary rather than a number a real game reaches.
 */
export const PLAYS_CAP_LIVE = 400;
export const PLAYS_CAP_FINAL = 2000;

/**
 * How long after kick-off a finished game is still owed its one recap read.
 * Three hours of play plus a three-hour catch-up window, measured from kick-off
 * because the scoreboard does not say when the whistle went. Pinned in the cursor
 * as `recapped[fixtureKey]` once read, so the window bounds only the backlog a
 * fresh cursor picks up.
 */
export const RECAP_LOOKBACK_MS = 6 * HOUR_MS;

/** How long a `recapped` / `read` stamp lives in the cursor. */
export const STAMP_TTL_MS = 24 * HOUR_MS;

/** The summary probe reaches half a day either way, like the live tick. */
const SCHEDULE_REACH_MS = 12 * HOUR_MS;

export const playsSupportedFor = (sport) => !NO_PLAYS.has(sport);
export const boxscoreSupportedFor = (sport) => !NO_BOXSCORE.has(sport);

/* ------------------------------------------------------------------ plays -- */

/** 1 -> "1st". Only used when the provider ships no period label of its own. */
const ordinal = (n) => {
  if (!Number.isFinite(n)) return null;
  const teens = n % 100;
  if (teens >= 11 && teens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
};

/** Which side a team id is, given `{home, away}` ids. */
const sideOf = (sides, teamId) => {
  if (!sides || !teamId) return null;
  if (sides.home && String(sides.home) === teamId) return 'home';
  if (sides.away && String(sides.away) === teamId) return 'away';
  return null;
};

/**
 * One provider play -> the item's play shape, or null if it is not usable.
 *
 * Every sport's play object carries the same core fields (`id`, `text`,
 * `scoringPlay`, `period`), which is what makes one mapper enough for the three
 * containers below. `periodLabel` is kept alongside the number because football
 * ships no label at all, just a number and a clock, and tipoffwatch's
 * `event_plays.period_label` expects the phrased form.
 */
export function normalisePlay(p, { sequence = null, sides = null } = {}) {
  if (!p?.id || !p?.text) return null;
  // Checked for absence before conversion: Number(null) is 0, which would file
  // every unsequenced play at the top of the log.
  const rawSeq = p.sequenceNumber ?? sequence;
  const seq =
    rawSeq === null || rawSeq === undefined || rawSeq === '' ? Number.NaN : Number(rawSeq);
  const period = Number.isFinite(p.period?.number) ? p.period.number : null;
  const clock = p.clock?.displayValue ?? null;
  const label = p.period?.displayValue ?? [clock, ordinal(period)].filter(Boolean).join(' · ');
  const teamId = p.team?.id === undefined || p.team?.id === null ? null : String(p.team.id);
  return {
    id: String(p.id),
    sequence: Number.isFinite(seq) ? seq : null,
    text: String(p.text),
    period,
    periodLabel: label || null,
    clock,
    homeScore: Number.isFinite(p.homeScore) ? p.homeScore : null,
    awayScore: Number.isFinite(p.awayScore) ? p.awayScore : null,
    scoring: Boolean(p.scoringPlay),
    type: p.type?.text ?? null,
    team: sideOf(sides, teamId),
    teamId,
  };
}

/**
 * The play list out of a summary, whichever way this sport ships it:
 *
 *   - `plays`      baseball, basketball, hockey -- flat and already ordered
 *   - `drives`     football -- nested under the current and previous drives; a
 *                  finished game drops `current` altogether
 *   - `commentary` soccer -- each entry wraps a play and carries the sequence the
 *                  play itself lacks; `keyEvents` is the same feed minus the
 *                  filler, and covers matches with no commentary
 *
 * All four are read on every call rather than switched on the sport. Ids repeated
 * across shapes (every soccer keyEvent also appears in commentary) collapse to one
 * play, which is what a mirror's unique index expects.
 */
export function playsFromSummary(data, { sides = null } = {}) {
  const seen = new Map();
  const add = (play, opts) => {
    const row = normalisePlay(play, { ...opts, sides });
    if (row && !seen.has(row.id)) seen.set(row.id, row);
  };
  for (const p of data?.plays ?? []) add(p);
  const drives = data?.drives;
  const driveList = Array.isArray(drives)
    ? drives
    : [drives?.current, ...(drives?.previous ?? [])].filter(Boolean);
  for (const drive of driveList) for (const p of drive?.plays ?? []) add(p);
  for (const entry of data?.commentary ?? []) add(entry?.play, { sequence: entry?.sequence });
  for (const p of data?.keyEvents ?? []) add(p);
  return orderPlays([...seen.values()]);
}

/** Sequenced plays in order; unsequenced ones keep their arrival order at the end. */
export function orderPlays(plays) {
  return [...plays].sort((a, b) => {
    if (a.sequence === null && b.sequence === null) return 0;
    if (a.sequence === null) return 1;
    if (b.sequence === null) return -1;
    return a.sequence - b.sequence;
  });
}

/** The tail of the log a live item carries, or the whole of it once final. */
export function capPlays(plays, { final = false } = {}) {
  const cap = final ? PLAYS_CAP_FINAL : PLAYS_CAP_LIVE;
  const total = plays.length;
  return {
    plays: total > cap ? plays.slice(total - cap) : plays,
    total,
    truncated: total > cap,
  };
}

/* ------------------------------------------------------------------ recap -- */

/** A number ESPN may ship as a string, a float, or not at all. */
const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);

/**
 * Drop the empty periods some leagues pad a linescore out to: rugby league is
 * played in two halves and returns four columns, the last two scoreless. Only
 * trailing, only scoreless, only past regulation; extra time is scored and stays.
 */
function trimPadding(away, home, regulationPeriods) {
  if (!regulationPeriods) return [away, home];
  let end = Math.max(away.length, home.length);
  const blank = (row, i) => {
    const v = row[i];
    return v === undefined || v === '' || v === '0';
  };
  while (end > regulationPeriods && blank(away, end - 1) && blank(home, end - 1)) end--;
  return [away.slice(0, end), home.slice(0, end)];
}

/** Compared without punctuation or case, so one denylist covers every sport. */
const statKey = (label) =>
  String(label)
    .toLowerCase()
    .replace(/[^a-z]/g, '');

/** Rows about the record rather than the game: season context and bookkeeping. */
const SKIP_STAT = new Set(
  [
    'gamesplayed',
    'teamgamesplayed',
    'gamesstarted',
    'qualified',
    'qualifiedcatcher',
    'isqualified',
    'isqualifiedinsteals',
    'isqualifiedsteals',
    'playerrating',
    'projectedhomeruns',
    'rank',
  ].map(statKey),
);

/** Whether a stat reads as nothing: absent, blank, or any spelling of zero. */
const isZero = (v) => {
  if (v === null || v === undefined || v === '') return true;
  const n = Number(String(v).replace(/[%,]/g, ''));
  return Number.isFinite(n) && n === 0;
};

/**
 * Cap the table taking from every group round-robin, so a baseball box score
 * keeps a Pitching line rather than forty rows of Batting.
 */
function capPerGroup(rows, limit) {
  if (rows.length <= limit) return rows;
  const groups = new Map();
  for (const row of rows) {
    const g = row.group ?? '';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(row);
  }
  const out = [];
  const buckets = [...groups.values()];
  for (let i = 0; out.length < limit; i++) {
    let placed = false;
    for (const bucket of buckets) {
      if (i >= bucket.length) continue;
      out.push(bucket[i]);
      placed = true;
      if (out.length === limit) break;
    }
    if (!placed) break;
  }
  return out;
}

/**
 * The team comparison table, from either container ESPN uses: flat
 * `[{label, displayValue}]` (football, soccer, AFL) or grouped
 * `[{displayName, stats: [...]}]` (baseball, rugby league). Paired by stat; a
 * stat only one side reported, or both reported as zero, is dropped.
 */
function teamStatRows(teams) {
  if (teams.length < 2) return [];
  const side = (which) => teams.find((t) => t.homeAway === which) ?? null;
  const home = side('home');
  const away = side('away');
  if (!home || !away) return [];
  const flatten = (team) => {
    const out = new Map();
    for (const entry of team.statistics ?? []) {
      if (Array.isArray(entry.stats)) {
        const group = entry.displayName ?? entry.name ?? '';
        for (const s of entry.stats) {
          const label = s.displayName ?? s.shortDisplayName ?? s.abbreviation ?? s.name;
          if (!label) continue;
          out.set(`${group}|${label}`, {
            group,
            label,
            value: s.displayValue ?? (s.value === undefined ? null : String(s.value)),
          });
        }
      } else {
        const label = entry.label ?? entry.displayName ?? entry.name;
        if (!label) continue;
        out.set(`|${label}`, {
          group: null,
          label,
          value: entry.displayValue ?? (entry.value === undefined ? null : String(entry.value)),
        });
      }
    }
    return out;
  };
  const homeStats = flatten(home);
  const awayStats = flatten(away);
  const rows = [];
  for (const [key, h] of homeStats) {
    const a = awayStats.get(key);
    if (!a) continue;
    if (h.value == null && a.value == null) continue;
    if (SKIP_STAT.has(statKey(h.label))) continue;
    if (isZero(h.value) && isZero(a.value)) continue;
    rows.push({ group: h.group, label: h.label, home: h.value, away: a.value });
  }
  return capPerGroup(rows, 40);
}

/**
 * Everything about a finished game that is not a play, out of the same summary.
 * The shape is tipoffwatch's `recapFromSummary` verbatim, so a mirror can store
 * it straight into `events.recap`: every key optional, the renderer draws what
 * it finds, because the sports genuinely differ in what they return.
 */
export function recapFromSummary(data) {
  if (!data || typeof data !== 'object') return null;
  const comp = data.header?.competitions?.[0];
  const competitors = comp?.competitors ?? [];
  const of = (which) => competitors.find((c) => c.homeAway === which);
  const recap = {};

  const periodLabel = data.format?.regulation?.displayName ?? null;
  const cells = (c) =>
    (c?.linescores ?? []).map((l) => {
      const v = l.displayValue ?? l.value;
      return v === undefined || v === null ? '' : String(v);
    });
  const regulation = num(data.format?.regulation?.periods);
  const [awayLine, homeLine] = trimPadding(cells(of('away')), cells(of('home')), regulation);
  if (awayLine.length > 0 || homeLine.length > 0) {
    recap.linescores = {
      labels: Array.from({ length: Math.max(awayLine.length, homeLine.length) }, (_, i) =>
        String(i + 1),
      ),
      periodLabel,
      away: awayLine,
      home: homeLine,
    };
  }

  const teamStats = teamStatRows(data.boxscore?.teams ?? []);
  if (teamStats.length > 0) recap.teamStats = teamStats;

  const leaders = [];
  for (const entry of data.leaders ?? []) {
    const teamId = entry.team?.id ?? null;
    const side =
      teamId && of('home')?.team?.id === teamId
        ? 'home'
        : teamId && of('away')?.team?.id === teamId
          ? 'away'
          : null;
    for (const category of entry.leaders ?? []) {
      const top = (category.leaders ?? [])[0];
      const athlete = top?.athlete;
      if (!athlete || !top?.displayValue) continue;
      leaders.push({
        side,
        team: entry.team?.abbreviation ?? entry.team?.displayName ?? null,
        category: category.shortDisplayName ?? category.displayName ?? null,
        name: athlete.displayName ?? athlete.shortName ?? null,
        // Already phrased per sport ("25/29, 286 YDS, 2 TD"); not re-decided here.
        line: top.displayValue,
      });
    }
  }
  if (leaders.length > 0) recap.leaders = leaders.slice(0, 12);

  const info = data.gameInfo ?? {};
  const officials = (info.officials ?? []).map((o) => o.displayName ?? o.fullName).filter(Boolean);
  if (officials.length > 0) recap.officials = officials;
  if (typeof info.gameDuration === 'string' && info.gameDuration)
    recap.duration = info.gameDuration;
  // Zero is how this field says "not reported", not an empty ground.
  if (Number.isFinite(info.attendance) && info.attendance > 0) recap.attendance = info.attendance;

  const article = data.article;
  if (article?.headline) {
    recap.article = {
      headline: article.headline,
      // The agency's opening sentence arrives with the dateline stripped and its
      // leading dash left behind.
      summary:
        typeof article.description === 'string'
          ? article.description.replace(/^[\s—–-]+/, '')
          : null,
      source: article.source ?? null,
      publishedAt: article.published ?? article.originallyPosted ?? null,
    };
  }

  // `summary.odds` is [] on a finished game; pickcenter is where the line outlives
  // the whistle, in the scoreboard's own shape, so it is marked `post`.
  const closing = oddsFromCompetition({ odds: data.pickcenter ?? [] }, { state: 'post' });
  if (closing) recap.odds = closing;

  return Object.keys(recap).length > 0 ? recap : null;
}

/* ------------------------------------------------------------- selection -- */

/**
 * Whether a fixture is worth a summary right now.
 *
 * In play: yes, if its sport has a play log (a box-score-only sport has nothing
 * to show until the whistle). Finished: once, if it kicked off recently enough
 * and has not been read since the whistle. Anything else, and every sport with no
 * summary at all, is not.
 */
export function wantsSummary(f, now, { recapped = {} } = {}) {
  if (!f?.home || !f?.away || f.tournament) return false;
  const sport = f.sport;
  const plays = playsSupportedFor(sport);
  const box = boxscoreSupportedFor(sport);
  if (f.state === 'in') return plays;
  if (f.state !== 'post') return false;
  if (!plays && !box) return false;
  if (recapped[f.key]) return false;
  const t = f.publishedAt?.getTime?.();
  return Number.isFinite(t) && t >= now - RECAP_LOOKBACK_MS;
}

/**
 * Which of the candidates this run reads, inside `limit`.
 *
 * Split rather than pooled, as tipoffwatch learned the hard way: a game being
 * played needs reading again and again while it is on; a finished one needs
 * reading exactly once more. Drawn from one queue the finished ones win on age
 * alone and the live fixtures get nothing. So live games take the bulk, ordered
 * by how long since they were last read, and up to two slots are held for
 * finished ones, newest first (the game that just ended is the one someone has
 * open). Neither queue can starve the other, and a slot one queue cannot fill
 * goes to the other.
 */
export function pickSummaries(candidates, { limit = 8, read = {} } = {}) {
  const cap = Math.max(0, Math.floor(Number(limit) || 0));
  if (cap === 0) return [];
  const at = (c) => Date.parse(read[c.key] ?? '') || 0;
  const live = candidates.filter((c) => c.state === 'in').sort((a, b) => at(a) - at(b));
  const ended = candidates
    .filter((c) => c.state === 'post')
    .sort((a, b) => (b.publishedAt?.getTime?.() ?? 0) - (a.publishedAt?.getTime?.() ?? 0));
  const endedShare = Math.min(2, Math.max(1, cap - 1));
  const reserved = Math.min(endedShare, ended.length);
  const liveTake = live.slice(0, Math.max(0, cap - reserved));
  const endedTake = ended.slice(0, cap - liveTake.length);
  return [...liveTake, ...endedTake];
}

/** Drop the stamps older than the TTL, so the cursor does not grow for ever. */
export function pruneStamps(stamps, now, ttlMs = STAMP_TTL_MS) {
  const out = {};
  for (const [k, iso] of Object.entries(stamps ?? {})) {
    const t = Date.parse(iso);
    if (Number.isFinite(t) && now - t < ttlMs) out[k] = iso;
  }
  return out;
}

/* ------------------------------------------------------------------- item -- */

/** The summary's own view of the state, which is fresher than the scoreboard's. */
export function summaryState(summary) {
  const comp = summary?.header?.competitions?.[0];
  return comp?.status?.type?.state ? normaliseState(comp) : null;
}

/** The summary URL for a fixture: the event's provider key is `<league key>/<id>`. */
export const summaryUrl = (league, f) =>
  `${SITE}/${league.key}/summary?event=${encodeURIComponent(f.id)}`;

/**
 * One fixture's play-by-play and, once it is final, its recap.
 *
 * Keyed like the fixture it belongs to (`<league key>/<event id>`, because ESPN
 * event ids are only unique within a league), and pointing back at it by tag and
 * by `fixtureExternalId` so a mirror can join without parsing the id.
 */
export function playsItem({ fixture: f, league, meta = {}, summary, state, now = Date.now() }) {
  const sport = league.sport;
  const final = state === 'post';
  const sides = { home: f.home?.id ?? null, away: f.away?.id ?? null };
  const capped = capPlays(playsFromSummary(summary, { sides }), { final });
  const recap = final && boxscoreSupportedFor(sport) ? recapFromSummary(summary) : null;
  const fixtureExternalId = `${PROVIDER}:fixture:${f.key}`;
  const last = capped.plays[capped.plays.length - 1] ?? null;
  return {
    externalId: `${PROVIDER}:${KIND}:${f.key}`,
    kind: KIND,
    title: fixtureTitle(f),
    summary: last?.text ?? f.statusDetail ?? null,
    url: f.url ?? null,
    imageUrl: f.home?.logoUrl ?? meta.logoUrl ?? null,
    publishedAt: f.publishedAt,
    timeKnown: f.timeKnown,
    precision: f.precision,
    tags: [KIND, sport, `league:${league.slug}`, `state:${state}`, `fixture:${fixtureExternalId}`],
    data: {
      provider: PROVIDER,
      sport,
      fixtureExternalId,
      fixtureKey: f.key,
      eventId: f.id,
      league: {
        slug: league.slug,
        key: league.key,
        name: meta.name ?? league.name ?? league.leagueKey,
        abbreviation: meta.abbreviation ?? null,
        region: regionFor(league.key, meta.region ?? null),
      },
      home: f.home ? { id: f.home.id, name: f.home.displayName, score: f.home.score } : null,
      away: f.away ? { id: f.away.id, name: f.away.displayName, score: f.away.score } : null,
      state,
      statusDetail: f.statusDetail ?? null,
      playsSupported: playsSupportedFor(sport),
      boxscoreSupported: boxscoreSupportedFor(sport),
      plays: capped.plays,
      playsTotal: capped.total,
      playsTruncated: capped.truncated,
      recap,
      final,
      fetchedAt: new Date(now).toISOString(),
    },
  };
}

/* ---------------------------------------------------------------- adapter -- */

/** A 4xx is ESPN saying there is no summary for this id, not a passing fault. */
const noSummary = (err) => err?.status === 400 || err?.status === 404;

export const espnPlays = defineAdapter({
  name: 'espn-plays',
  title: 'ESPN: play-by-play and recaps',
  collection: 'sports',
  description:
    'Play-by-play as a game unfolds and the box score once it is over, one item per fixture, from ESPN summaries. Which fixtures are worth a read is learned by the source itself: a rolling probe of the catalogue plus a watch list of leagues with a game on, as the live-scores source does. A game in play is re-read each run, carrying the tail of its log; a finished game is read once more after the whistle, with the whole log, the linescore, team statistics, leaders, officials, the wire recap and the closing line, then closed out. Every summary is ~500 KB, so a run reads at most a handful. Keyless, but ESPN blocks cloud egress, so set SPORTS_PROXY_URL to a residential proxy on a hosted deployment.',
  docs: 'https://site.api.espn.com/apis/site/v2/sports',
  kinds: [KIND],
  cadenceMinutes: 2,
  configFields: [
    {
      key: 'leagues',
      label: 'Leagues',
      type: 'list',
      placeholder: 'football/nfl, basketball/nba',
      help: 'ESPN league keys or slugs. Empty means every league the probe finds a game in.',
    },
    {
      key: 'probePerRun',
      label: 'Leagues probed per run',
      type: 'number',
      placeholder: '4',
      help: 'How many leagues each run checks for a game on, round robin, besides the ones already watched.',
    },
    {
      key: 'summariesPerRun',
      label: 'Summaries per run',
      type: 'number',
      placeholder: '8',
      help: 'How many fixtures get a summary read each run. Each is ~500 KB through the proxy; 8 every two minutes is about 120 MB an hour at full tilt.',
    },
    SKIP_SPORTS_FIELD,
  ],
  defaults: { leagues: [], probePerRun: 4, summariesPerRun: 8, skipSports: ['tennis'] },
  defaultSources: [{ slug: 'espn-plays', name: 'Sports: ESPN play-by-play and recaps' }],
  async pull(ctx) {
    const { config, cursor: prev, env, http, log, deadline } = ctx;
    const client = makeEspnClient({ env, http, log });
    const cursor = { ...prev };
    const now = Date.now();
    const leagues = await ensureCatalogue(ctx, client, cursor);
    const byKey = new Map(leagues.map((l) => [l.key, l]));

    const watch = { ...(cursor.watch ?? {}) };
    for (const [k, seen] of Object.entries(watch)) {
      if (!byKey.has(k) || now - Date.parse(seen) > WATCH_GRACE_MS) delete watch[k];
    }
    const recapped = pruneStamps(cursor.recapped, now);
    const read = pruneStamps(cursor.read, now);
    const pinned = leagueKeysOf(config, leagues).filter((k) => byKey.has(k));
    const { targets, scanIdx } = liveTargets({
      leagues,
      watch,
      scanIdx: cursor.scanIdx,
      probe: Math.min(Math.max(Number(config.probePerRun) || 4, 1), 60),
      pinned,
    });
    const limit = Math.min(Math.max(Number(config.summariesPerRun) || 8, 1), 50);
    const stopAt = deadline - DEADLINE_MARGIN_MS;

    // Pass one: the scoreboards, to learn which fixtures are on or just over.
    const candidates = [];
    let boardsFailed = 0;
    const from = new Date(now - SCHEDULE_REACH_MS);
    const to = new Date(now + SCHEDULE_REACH_MS);
    await pool(targets, 6, stopAt, async (key) => {
      const league = byKey.get(key);
      try {
        const { league: meta, events } = await fetchSchedule(client, {
          league,
          from,
          to,
          fallback: false,
        });
        if (keepsWatch(events, now)) watch[key] = new Date(now).toISOString();
        else delete watch[key];
        for (const f of events) {
          if (wantsSummary({ ...f, sport: league.sport }, now, { recapped })) {
            candidates.push({ ...f, sport: league.sport, league, meta: meta ?? {} });
          }
        }
      } catch (err) {
        boardsFailed += 1;
        if (boardsFailed === 1) log(`first scoreboard failure: ${key}: ${err?.message ?? err}`);
      }
    });

    // Pass two: the summaries, inside the per-run cap and the deadline.
    const due = pickSummaries(candidates, { limit, read });
    const items = [];
    let failed = 0;
    let live = 0;
    let finals = 0;
    await pool(due, 2, stopAt, async (c) => {
      const stamp = new Date().toISOString();
      try {
        const summary = await client.get(summaryUrl(c.league, c));
        const state = summaryState(summary) ?? c.state;
        items.push(playsItem({ fixture: c, league: c.league, meta: c.meta, summary, state, now }));
        read[c.key] = stamp;
        if (state === 'post') {
          recapped[c.key] = stamp;
          finals += 1;
        } else live += 1;
      } catch (err) {
        if (noSummary(err)) {
          // Answered once and never asked again: a fixture with no summary would
          // otherwise hold a slot every run ahead of games that have one.
          read[c.key] = stamp;
          if (c.state === 'post') recapped[c.key] = stamp;
          return;
        }
        failed += 1;
        if (failed === 1) log(`first summary failure: ${c.key}: ${err?.message ?? err}`);
      }
    });

    return {
      items,
      cursor: {
        leagues: cursor.leagues,
        leaguesAt: cursor.leaguesAt,
        watch,
        scanIdx,
        recapped,
        read,
      },
      note: `${Object.keys(watch).length} league(s) watched, ${candidates.length} candidate(s), ${live} live + ${finals} final read of ${due.length} due, ${failed} failed${boardsFailed ? `, ${boardsFailed} scoreboard(s) failed` : ''}`,
    };
  },
});
