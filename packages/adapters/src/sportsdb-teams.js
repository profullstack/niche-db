import { defineAdapter, slugify, stripHtml } from '@nichedb/core/adapter';

import { BASE, DEFAULT_KEY, PROVIDER, redact, sportSlug, usingFreeKey } from './sportsdb.js';

/**
 * TheSportsDB: the team catalogue for the `sports` collection.
 *
 * The plan was to walk league ids the way sportsdb-leagues.js does and ask
 * `lookup_all_teams.php?id=<league>` for each. Measured on 2026-09-13 that
 * endpoint IGNORES the id on the shared test key: 4328 (the Premier League),
 * 4387 (the NBA) and 4330 all answered the same 24 rows of English League 1,
 * byte for byte, on key 3 and on key 123. `search_all_teams.php?l=` answers the
 * right league but is capped at 10 rows (the Premier League came back with 10
 * of 20). The one team endpoint that is not capped is `lookupteam.php?id=`, the
 * team twin of the league lookup, which answers for any team id on the free key
 * and `{"teams":null}` for an unknown one. So this source walks TEAM ids, not
 * league ids: they start at 133597 (Birmingham City; Arsenal is 133604, the
 * first rows ever entered) and run densely to a little over 157,000 on
 * 2026-09-13, so the space is about 24,000 ids with few gaps and a pass at the
 * default cap takes about a week of ten-minute runs.
 *
 * The walk is the league walk's: a run asks for `requestCap` ids and stops, the
 * cursor carries the next id, and the pass ends when `tailMisses` ids in a row
 * are unknown, which is what "past the newest team" looks like. The next run
 * starts over from `startId`. The free key is 30 requests a minute and
 * Cloudflare answers 429 with `error code: 1015` past a burst of about forty, so
 * a run keeps `pauseMs` between lookups and the default cap keeps a run under a
 * minute of traffic followed by ten minutes of silence.
 *
 * One item per team, kind `team`, tagged the way espn.js tags its teams: `team`,
 * the sport slug (the same slug fixtures and broadcasts carry, via sportSlug),
 * `league:<slug>` for every league the row names (a club plays in a league and
 * a cup or two, and TheSportsDB lists up to seven), the country and the gender.
 * The badge is the image and the English description is the summary. Every
 * field a reader could want is kept under `data`, including the ESPN and
 * API-Football cross-reference ids that make a team row joinable.
 *
 * The key rides in the URL path, as in sportsdb.js, so no URL is ever put in an
 * item, a note, a log line or an error.
 */

/** Birmingham City, the lowest team id that answers; Arsenal is 133604. */
export const START_ID = 133597;

/** Consecutive unknown ids that mean the walk is past the newest team. */
export const TAIL_MISSES = 25;

/** Lookups per run by default: under a minute of traffic on the free key's pace. */
export const REQUEST_CAP = 25;

/** Consecutive failures after which a run stops asking, so an outage costs little. */
const FAILURE_STOP = 3;

/** Pause between lookups: the free key is 30 a minute, and a burst is banned for a while. */
export const PAUSE_MS = 2_100;

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

export const teamUrl = (key, id) =>
  `${BASE}/${encodeURIComponent(String(key ?? DEFAULT_KEY))}/lookupteam.php?id=${encodeURIComponent(String(id))}`;

/** The team page on thesportsdb.com. */
export const teamPageUrl = (id) => `https://www.thesportsdb.com/team/${id}`;

const text = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
};

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** A cross-reference id, which TheSportsDB writes as "0" when it has none. */
const refId = (v) => {
  const s = text(v);
  return s && s !== '0' ? s : null;
};

/** A link TheSportsDB stores without a scheme ("www.twitter.com/Arsenal") as a URL. */
export function link(v) {
  const s = text(v);
  if (!s) return null;
  return /^https?:\/\//i.test(s) ? s : `https://${s.replace(/^\/+/, '')}`;
}

/** A comma-separated field as a list. */
export const list = (v) =>
  (text(v) ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Every league a team row names. `strLeague`/`idLeague` is the main one and
 * `strLeague2`..`strLeague7` are the cups and secondary competitions; an empty
 * slot is "" or null.
 */
export function teamLeagues(r) {
  const out = [];
  const seen = new Set();
  for (let i = 1; i <= 7; i++) {
    const suffix = i === 1 ? '' : String(i);
    const name = text(r?.[`strLeague${suffix}`]);
    const id = text(r?.[`idLeague${suffix}`]);
    if (!name && !id) continue;
    const slug = name ? slugify(name) : null;
    const key = id ?? slug;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ id, name, slug: slug || null });
  }
  return out;
}

/** The one row out of a lookupteam answer, or null for an unknown id. */
export function parseTeam(body) {
  const rows = body?.teams;
  if (!Array.isArray(rows) || !rows.length) return null;
  const r = rows[0];
  return r && text(r.idTeam) && text(r.strTeam) ? r : null;
}

/** One team row -> one item. */
export function teamItem(r) {
  const id = String(r.idTeam);
  const name = text(r.strTeam);
  const sportName = text(r.strSport);
  const sport = sportName ? sportSlug(sportName) : null;
  const country = text(r.strCountry);
  const countrySlug = country ? slugify(country) : null;
  const gender = text(r.strGender);
  const leagues = teamLeagues(r);
  const main = leagues[0] ?? null;
  const description = stripHtml(text(r.strDescriptionEN) ?? '') || null;
  const location = text(r.strLocation);
  const stadium = text(r.strStadium);
  return {
    externalId: `sportsdb:team:${id}`,
    kind: 'team',
    title: name,
    summary: description
      ? description.slice(0, 600)
      : [sportName, main?.name, country].filter(Boolean).join(' · ') || null,
    url: teamPageUrl(id),
    imageUrl: text(r.strBadge) ?? text(r.strLogo),
    publishedAt: null,
    tags: [
      'team',
      sport,
      ...leagues.map((l) => (l.slug ? `league:${l.slug}` : null)),
      countrySlug ? `country:${countrySlug}` : null,
      gender ? `gender:${slugify(gender)}` : null,
    ].filter(Boolean),
    data: {
      provider: PROVIDER,
      attribution: 'TheSportsDB (thesportsdb.com)',
      teamId: id,
      name,
      shortName: text(r.strTeamShort),
      alternateNames: list(r.strTeamAlternate),
      keywords: list(r.strKeywords),
      leagueId: main?.id ?? null,
      league: main?.name ?? null,
      leagues,
      division: text(r.strDivision),
      sport,
      sportName,
      country,
      location,
      gender,
      formedYear: num(r.intFormedYear),
      stadium,
      stadiumLocation: location,
      stadiumCapacity: num(r.intStadiumCapacity),
      venueId: text(r.idVenue),
      website: link(r.strWebsite),
      socials: {
        twitter: link(r.strTwitter),
        facebook: link(r.strFacebook),
        instagram: link(r.strInstagram),
        youtube: link(r.strYoutube),
      },
      rss: link(r.strRSS),
      description,
      colours: [r.strColour1, r.strColour2, r.strColour3].map(text).filter(Boolean),
      badge: text(r.strBadge),
      logo: text(r.strLogo),
      banner: text(r.strBanner),
      equipment: text(r.strEquipment),
      fanart: [r.strFanart1, r.strFanart2, r.strFanart3, r.strFanart4].map(text).filter(Boolean),
      espnId: refId(r.idESPN),
      apiFootballId: refId(r.idAPIfootball),
      loved: num(r.intLoved),
      leaguePageUrl: main?.id ? `https://www.thesportsdb.com/league/${main.id}` : null,
    },
  };
}

/** Where a run starts: the cursor's next id, else the configured start. */
export function resumeId(prev, config) {
  const start = Math.max(1, Math.floor(Number(config?.startId)) || START_ID);
  const next = Math.floor(Number(prev?.nextId));
  return Number.isFinite(next) && next >= start ? next : start;
}

export const sportsdbTeams = defineAdapter({
  name: 'sportsdb-teams',
  title: 'TheSportsDB teams',
  collection: 'sports',
  description:
    'Every team TheSportsDB knows, one row each with its sport, leagues and cups, country, stadium, colours, badge, description, website, socials and the ESPN and API-Football cross-reference ids. Walks the team id space through lookupteam.php, which answers for any id on the free key while the per-league list endpoint ignores its league id on that key and the search is capped at ten rows; a run asks for a fixed number of ids with a pause between them and resumes, the walk ends after a run of unknown ids past the newest team, and the next run starts the catalogue over. TheSportsDB terms of use allow copying data from the official API endpoints with attribution, which every row carries.',
  docs: 'https://www.thesportsdb.com/documentation',
  kinds: ['team'],
  cadenceMinutes: 1440,
  configFields: [
    {
      key: 'startId',
      label: 'First team id',
      type: 'number',
      placeholder: String(START_ID),
      help: 'Where a pass begins. 133597 is Birmingham City, the lowest team id TheSportsDB answers for.',
    },
    {
      key: 'requestCap',
      label: 'Lookups per run',
      type: 'number',
      placeholder: String(REQUEST_CAP),
      help: 'The walk stops here and picks up ten minutes later. About 24,000 ids exist, so 25 a run is a full pass in about a week.',
    },
    {
      key: 'pauseMs',
      label: 'Pause between lookups (ms)',
      type: 'number',
      placeholder: String(PAUSE_MS),
      help: 'The free key is 30 lookups a minute and a burst of about forty is refused for a while; 2100 ms keeps a run under that.',
    },
    {
      key: 'tailMisses',
      label: 'Unknown ids that end a pass',
      type: 'number',
      placeholder: String(TAIL_MISSES),
      help: 'Ids have gaps, so one unknown id means nothing; this many in a row means the walk is past the newest team.',
    },
  ],
  defaults: {
    startId: START_ID,
    requestCap: REQUEST_CAP,
    tailMisses: TAIL_MISSES,
    pauseMs: PAUSE_MS,
  },
  defaultSources: [
    {
      slug: 'sportsdb-teams',
      name: 'Sports: teams (TheSportsDB)',
      config: {
        startId: START_ID,
        requestCap: REQUEST_CAP,
        tailMisses: TAIL_MISSES,
        pauseMs: PAUSE_MS,
      },
    },
  ],
  async pull({ config, cursor: prev, env, http, log, deadline }) {
    const key = String(env?.sportsdbApiKey ?? env?.SPORTSDB_API_KEY ?? DEFAULT_KEY);
    const cap = Math.max(1, Math.floor(Number(config?.requestCap)) || REQUEST_CAP);
    const tail = Math.max(1, Math.floor(Number(config?.tailMisses)) || TAIL_MISSES);
    const pause =
      config?.pauseMs === 0 ? 0 : Math.max(0, Math.floor(Number(config?.pauseMs))) || PAUSE_MS;
    const stopAt = Number.isFinite(deadline) ? deadline : Number.POSITIVE_INFINITY;
    const startedAt = resumeId(prev, config);
    let id = startedAt;
    let topId = Math.floor(Number(prev?.topId)) || 0;
    let misses = 0;
    let requests = 0;
    let failures = 0;
    let streak = 0;
    let stopped = null;
    const items = [];

    for (;;) {
      if (requests >= cap) {
        stopped = 'cap';
        break;
      }
      if (Date.now() > stopAt) {
        stopped = 'deadline';
        break;
      }
      if (misses >= tail) {
        stopped = 'tail';
        break;
      }
      if (requests > 0) await sleep(pause);
      requests += 1;
      let body = null;
      try {
        const res = await http.request(teamUrl(key, id), {
          headers: { accept: 'application/json' },
          timeoutMs: 20_000,
        });
        if (!res.ok) throw new Error(`thesportsdb answered ${res.status}`);
        body = await res.json();
        streak = 0;
      } catch (err) {
        failures += 1;
        streak += 1;
        log(`team ${id} unavailable (${redact(err?.message ?? err, key)})`);
        if (streak >= FAILURE_STOP) {
          stopped = 'errors';
          break;
        }
        id += 1;
        continue;
      }
      const row = parseTeam(body);
      if (row) {
        misses = 0;
        topId = Math.max(topId, id);
        items.push(teamItem(row));
      } else {
        misses += 1;
      }
      id += 1;
    }

    if (requests > 0 && failures === requests) {
      throw new Error(
        `thesportsdb: every request failed (${requests} of ${requests}); see the log`,
      );
    }

    const done = stopped === 'tail';
    const reason =
      stopped === 'cap'
        ? 'at the request cap'
        : stopped === 'deadline'
          ? 'on the run deadline'
          : stopped === 'errors'
            ? 'after repeated failures'
            : null;

    return {
      items,
      cursor: {
        nextId: done ? null : id,
        topId: topId || null,
        walkedAt: done ? new Date().toISOString() : (prev?.walkedAt ?? null),
        freeKey: usingFreeKey(key),
      },
      nextInMinutes: done ? undefined : 10,
      note:
        `${items.length} teams from ${requests} lookups (ids ${startedAt} to ${id - 1}` +
        `${topId ? `, newest seen ${topId}` : ''})` +
        (failures ? `, ${failures} failed` : '') +
        (done
          ? `; past the newest team, next run starts over at ${resumeId(null, config)}`
          : `; stopped ${reason} at ${id}, resuming in 10 min`),
    };
  },
});
