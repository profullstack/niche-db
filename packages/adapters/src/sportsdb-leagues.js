import { defineAdapter, slugify, stripHtml } from '@nichedb/core/adapter';

import { BASE, DEFAULT_KEY, PROVIDER, redact, sportSlug, usingFreeKey } from './sportsdb.js';

/**
 * TheSportsDB: the league catalogue for the `sports` collection.
 *
 * thesportsdb.com/sport/leagues is the page Anthony asked to bring in, and the
 * numbers behind it are better than the page: every league has a numeric id and
 * `lookupleague.php?id=` answers for any of them on the shared test key, while
 * every LIST endpoint on that key is capped (all_leagues.php returns 10 rows,
 * search_all_leagues.php 5, all_sports.php 2, and the v2 catalogue refuses the
 * key outright). The HTML pages are capped the other way: /sport/leagues shows
 * 83 featured leagues and /sport/soccer 51, out of some 1,500. So this source
 * does not scrape the page. It walks the id space instead: ids start at 4328
 * (the English Premier League, the first row ever entered) and run, with gaps,
 * to just under 6000 on 2026-09-13; an unknown id answers `{"leagues":null}`.
 * A run asks for `requestCap` ids and stops; the cursor carries the next id, and
 * the walk ends when `tailMisses` consecutive ids in a row are unknown, which
 * is what "past the newest league" looks like. The next run starts over from
 * `startId`, so the whole catalogue is re-read every few days and a league
 * added at the tail is picked up on the cycle after it appears.
 *
 * One item per league, kind `league`, tagged by sport (the same slugs the
 * fixtures and broadcasts carry, via sportSlug) and country, with the badge as
 * the image and the English description as the summary. Every field TheSportsDB
 * gives that a reader could want is kept under `data`, including the
 * cross-reference ids for API-Football, because that is what makes a league row
 * joinable to anything else.
 *
 * The key rides in the URL path, as in sportsdb.js, so no URL is ever put in an
 * item, a note, a log line or an error.
 */

export const START_ID = 4328;

/** Consecutive unknown ids that mean the walk is past the newest league. */
export const TAIL_MISSES = 25;

/** Lookups per run by default: about 12 runs per full pass at the free key's pace. */
export const REQUEST_CAP = 120;

/** Consecutive failures after which a run stops asking, so an outage costs little. */
const FAILURE_STOP = 3;

/**
 * Pause between lookups. The first live run fired 103 lookups back to back and
 * the free key refused the last three in a row, which read as an outage and
 * ended the run early; a short gap keeps a run under the key's burst limit.
 */
export const PAUSE_MS = 600;

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

export const leagueUrl = (key, id) =>
  `${BASE}/${encodeURIComponent(String(key ?? DEFAULT_KEY))}/lookupleague.php?id=${encodeURIComponent(String(id))}`;

const text = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
};

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** The league page on thesportsdb.com, which is `league/<id>-<slug>`. */
export const leaguePageUrl = (id, name) =>
  `https://www.thesportsdb.com/league/${id}-${slugify(name) || 'league'}`;

/**
 * `strTvRights` is one text blob, "Country - Channel [years]" per line. Split it
 * into rows so a reader can filter on a market; the raw text is kept too.
 */
export function parseTvRights(blob) {
  const s = text(blob);
  if (!s) return [];
  const rows = [];
  for (const line of s.split(/\r?\n/)) {
    const m = line.trim().match(/^(.+?)\s+-\s+(.+?)(?:\s+\[([^\]]+)\])?$/);
    if (!m) continue;
    rows.push({ market: m[1].trim(), channel: m[2].trim(), years: m[3]?.trim() ?? null });
  }
  return rows;
}

/** The one row out of a lookupleague answer, or null for an unknown id. */
export function parseLeague(body) {
  const rows = body?.leagues;
  if (!Array.isArray(rows) || !rows.length) return null;
  const r = rows[0];
  return r && text(r.idLeague) && text(r.strLeague) ? r : null;
}

/** One league row -> one item. */
export function leagueItem(r) {
  const id = String(r.idLeague);
  const name = text(r.strLeague);
  const sportName = text(r.strSport);
  const sport = sportName ? sportSlug(sportName) : null;
  const country = text(r.strCountry);
  const countrySlug = country ? slugify(country) : null;
  const gender = text(r.strGender);
  const season = text(r.strCurrentSeason);
  const description = stripHtml(text(r.strDescriptionEN) ?? '') || null;
  const alternate = text(r.strLeagueAlternate);
  const website = text(r.strWebsite);
  return {
    externalId: `sportsdb:league:${id}`,
    kind: 'league',
    title: name,
    summary: description
      ? description.slice(0, 600)
      : [sportName, country].filter(Boolean).join(' · ') || null,
    url: leaguePageUrl(id, name),
    imageUrl: text(r.strBadge) ?? text(r.strLogo),
    publishedAt: null,
    tags: [
      'league',
      sport,
      countrySlug ? `country:${countrySlug}` : null,
      gender ? `gender:${slugify(gender)}` : null,
      season ? `season:${season}` : null,
      num(r.intDivision) ? `division:${num(r.intDivision)}` : null,
    ].filter(Boolean),
    data: {
      provider: PROVIDER,
      leagueId: id,
      name,
      alternateNames: alternate
        ? alternate
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
      sport,
      sportName,
      country,
      gender,
      formedYear: num(r.intFormedYear),
      firstEvent: text(r.dateFirstEvent),
      currentSeason: season,
      division: num(r.intDivision),
      cupId: num(r.idCup) ? String(num(r.idCup)) : null,
      website: website ? (website.startsWith('http') ? website : `https://${website}`) : null,
      facebook: text(r.strFacebook),
      twitter: text(r.strTwitter),
      instagram: text(r.strInstagram),
      youtube: text(r.strYoutube),
      rss: text(r.strRSS),
      badge: text(r.strBadge),
      logo: text(r.strLogo),
      banner: text(r.strBanner),
      poster: text(r.strPoster),
      trophy: text(r.strTrophy),
      fanart: [r.strFanart1, r.strFanart2, r.strFanart3, r.strFanart4].map(text).filter(Boolean),
      description,
      tvRights: parseTvRights(r.strTvRights),
      tvRightsText: text(r.strTvRights),
      apiFootballId: text(r.idAPIfootball),
      apiFootballV3Id: text(r.idAPIfootballv3),
      naming: text(r.strNaming),
      complete: text(r.strComplete),
      teamsUrl: `https://www.thesportsdb.com/league/${id}`,
    },
  };
}

/** Where a run starts: the cursor's next id, else the configured start. */
export function resumeId(prev, config) {
  const start = Math.max(1, Math.floor(Number(config?.startId)) || START_ID);
  const next = Math.floor(Number(prev?.nextId));
  return Number.isFinite(next) && next >= start ? next : start;
}

export const sportsdbLeagues = defineAdapter({
  name: 'sportsdb-leagues',
  title: 'TheSportsDB leagues',
  collection: 'sports',
  description:
    'Every league TheSportsDB knows, one row each with its sport, country, current season, badge, description, website, socials, TV rights by market and the API-Football cross-reference ids. Walks the league id space through lookupleague.php, which answers for any id on the free key while every list endpoint on that key is capped at ten rows; a run asks for a fixed number of ids and resumes, the walk ends after a run of unknown ids past the newest league, and the next run starts the catalogue over.',
  docs: 'https://www.thesportsdb.com/documentation',
  kinds: ['league'],
  cadenceMinutes: 360,
  configFields: [
    {
      key: 'startId',
      label: 'First league id',
      type: 'number',
      placeholder: String(START_ID),
      help: 'Where a pass begins. 4328 is the English Premier League, the first league TheSportsDB ever entered.',
    },
    {
      key: 'requestCap',
      label: 'Lookups per run',
      type: 'number',
      placeholder: String(REQUEST_CAP),
      help: 'The walk stops here and picks up ten minutes later. About 1,500 ids exist, so 120 a run is a full pass in a day.',
    },
    {
      key: 'pauseMs',
      label: 'Pause between lookups (ms)',
      type: 'number',
      placeholder: String(PAUSE_MS),
      help: 'The free key refuses a burst of a hundred lookups; a short gap keeps a run under that.',
    },
    {
      key: 'tailMisses',
      label: 'Unknown ids that end a pass',
      type: 'number',
      placeholder: String(TAIL_MISSES),
      help: 'Ids have gaps, so one unknown id means nothing; this many in a row means the walk is past the newest league.',
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
      slug: 'sportsdb-leagues',
      name: 'Sports: leagues (TheSportsDB)',
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
        const res = await http.request(leagueUrl(key, id), {
          headers: { accept: 'application/json' },
          timeoutMs: 20_000,
        });
        if (!res.ok) throw new Error(`thesportsdb answered ${res.status}`);
        body = await res.json();
        streak = 0;
      } catch (err) {
        failures += 1;
        streak += 1;
        log(`league ${id} unavailable (${redact(err?.message ?? err, key)})`);
        if (streak >= FAILURE_STOP) {
          stopped = 'errors';
          break;
        }
        id += 1;
        continue;
      }
      const row = parseLeague(body);
      if (row) {
        misses = 0;
        topId = Math.max(topId, id);
        items.push(leagueItem(row));
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
        `${items.length} leagues from ${requests} lookups (ids ${startedAt} to ${id - 1}` +
        `${topId ? `, newest seen ${topId}` : ''})` +
        (failures ? `, ${failures} failed` : '') +
        (done
          ? `; past the newest league, next run starts over at ${resumeId(null, config)}`
          : `; stopped ${reason} at ${id}, resuming in 10 min`),
    };
  },
});
