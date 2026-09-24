import { defineAdapter, slugify } from '@nichedb/core/adapter';

import {
  BASE,
  DEFAULT_KEY,
  PROVIDER,
  paceMs,
  premium,
  redact,
  sleep,
  sportSlug,
  usingFreeKey,
} from './sportsdb.js';

/**
 * TheSportsDB: every player it knows, as OpenProfile.md people for the
 * `profiles` collection, in the shape sportarr-persons.js emits.
 *
 * There is no player list endpoint on the free key, and the player id space
 * (34,145,419 to 34,436,687 and climbing on 2026-09-13) is far too wide to walk
 * one lookup at a time at thirty requests a minute. Teams are the way in: team
 * ids are dense, they start at 133,597 (133,590 to 133,596 answer null) and
 * rosters answer, with gaps, up to at least 149,500 on 2026-09-13 (152,000 and
 * above answered null), and `lookup_all_players.php?id=<teamId>` answers
 * `{"player":[...]}` for a team with players and `{"player":null}` for an id
 * that is not a team or a team nobody has entered players for yet. So a run
 * walks team ids from the cursor, asks for `requestCap` rosters and stops; the
 * walk ends when `tailMisses` ids in a row answer null, which is what "past the
 * newest team" looks like, and the next run starts over so the whole catalogue
 * is re-read on the cadence. Two hundred is deliberately wide because a gap in
 * the middle is a stretch of teams without rosters as much as a stretch of
 * missing ids.
 *
 * Measured on the free key: a roster answers TEN rows, alphabetical, whatever
 * the squad size (Liverpool and the Atlanta Hawks both came back with exactly
 * ten). That is the same list cap every free endpoint has, so on the free key
 * this source carries the first ten names of every team and a premium key
 * (env `SPORTSDB_API_KEY`) lifts it -- which the deployment has had since
 * 2026-09-24, so the rows are whole squads now and the cap here is the one that
 * matters: a subscriber key is 100 requests a minute against 30, so the pause
 * and the rosters-per-run default both come from the key. Cloudflare answers 1015 (HTTP 429) after
 * about forty fast calls, and thirty a minute is the published limit, so the
 * default pause is 2,100 ms; a 429 counts as a failure and three in a row end
 * the run without losing the place.
 *
 * One document per player row. The accounts are the identity keys: the
 * player's own page on thesportsdb.com first, then X, Instagram, Facebook and
 * YouTube when the row has them (TheSportsDB stores these as bare handles OR
 * full URLs, with or without www and a trailing slash; both are normalised to
 * one URL each), then the Wikidata item when the row carries one, which is
 * the same key sportarr-persons.js writes, so an athlete both sources know
 * merges into one person rather than two. The core matches profiles by
 * `data.source_url`, so `externalId`, `data.source_url` and `data.page_url`
 * are all the player page URL, and never the API URL that carries the key.
 *
 * Licence: TheSportsDB's terms (docs_terms_of_use.php) allow its data to be
 * copied from the official API endpoints with a credit, which is where every
 * row here comes from and why every document and every item's
 * `data.attribution` says so. The artwork is made by its users and the terms
 * point at the row's `strCreativeCommons` flag for whether a cutout or thumb
 * is CC licensed, so that flag travels as `data.artwork_cc`.
 */

export const SITE = 'https://www.thesportsdb.com';
export const USER_AGENT = 'nichedb (https://nichedb.dev; hello@nichedb.dev)';

/** The credit the terms ask for, on every item. */
export const ATTRIBUTION =
  'Data from TheSportsDB (https://www.thesportsdb.com), whose terms allow copying from the official API with a credit.';

/** The first team id that answers; the handful before it are null. */
export const START_ID = 133590;

/** Consecutive unknown team ids that mean the walk is past the newest team. */
export const TAIL_MISSES = 200;

/** Rosters per run by default: under a minute at the free key's pace. */
export const REQUEST_CAP = 25;

/**
 * Rosters per run on a subscriber key, where the limit is 100 requests a minute
 * rather than 30 and a roster comes back whole instead of ten names deep.
 */
export const PREMIUM_REQUEST_CAP = 90;

/** Consecutive failures after which a run stops asking, so an outage costs little. */
const FAILURE_STOP = 3;

/** Pause between rosters: thirty a minute is the free key's limit, and a burst earns a 429. */
export const PAUSE_MS = 2100;

const enc = (v) => encodeURIComponent(String(v));

export const rosterUrl = (key, teamId) =>
  `${BASE}/${enc(key ?? DEFAULT_KEY)}/lookup_all_players.php?id=${enc(teamId)}`;

export const playerPage = (id) => `${SITE}/player/${enc(id)}`;
export const teamPage = (id) => `${SITE}/team/${enc(id)}`;

const text = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
};

/** The rows out of a roster answer, each with an id and a name, deduped; [] for an unknown team. */
export function parseRoster(body) {
  const rows = body?.player;
  if (!Array.isArray(rows)) return [];
  const out = [];
  const seen = new Set();
  for (const r of rows) {
    const id = text(r?.idPlayer);
    if (!id || !text(r?.strPlayer) || seen.has(id)) continue;
    seen.add(id);
    out.push(r);
  }
  return out;
}

/**
 * The networks a row can name, with the hosts a stored URL may use. A value
 * arrives as `alex_isak`, `@alex_isak`, `twitter.com/alex_isak`,
 * `http://www.instagram.com/alex_isak`, `www.facebook.com/codygakpo/` or
 * `www.instagram.com/flowirtz_61/?hl=en`, all seen live.
 */
export const NETWORKS = {
  x: { hosts: ['x.com', 'twitter.com'], base: 'https://x.com/', firstSegment: true },
  instagram: { hosts: ['instagram.com'], base: 'https://www.instagram.com/', firstSegment: true },
  facebook: { hosts: ['facebook.com'], base: 'https://www.facebook.com/', firstSegment: false },
  youtube: { hosts: ['youtube.com'], base: 'https://www.youtube.com/', firstSegment: false },
};

/**
 * The path part of a stored account, for one network: the handle for X and
 * Instagram, the whole path for Facebook and YouTube (a page can live under
 * `pages/<name>/<id>` and a channel under `channel/<id>` or `@<handle>`). Null
 * for nothing, for whitespace, and for a URL on some other host, which is a
 * row where the field holds something it should not.
 */
export function accountPath(value, network) {
  const spec = NETWORKS[network];
  let s = text(value);
  if (!spec || !s) return null;
  s = s.replace(/^https?:\/\//i, '').replace(/^(?:www|m|mobile)\./i, '');
  const slash = s.indexOf('/');
  const head = (slash === -1 ? s : s.slice(0, slash)).toLowerCase();
  if (head.includes('.')) {
    if (!spec.hosts.includes(head)) return null;
    s = slash === -1 ? '' : s.slice(slash + 1);
  }
  s = s.replace(/[?#].*$/, '').replace(/^\/+|\/+$/g, '');
  if (spec.firstSegment) s = s.split('/')[0].replace(/^@/, '');
  else if (network !== 'youtube') s = s.replace(/^@/, '');
  if (network === 'youtube' && /^UC[\w-]{22}$/.test(s)) s = `channel/${s}`;
  if (!s || /\s/.test(s)) return null;
  return s;
}

/** The account URL for a row's value on one network, or null. */
export function accountUrl(value, network) {
  const p = accountPath(value, network);
  return p ? `${NETWORKS[network].base}${p}` : null;
}

/** A website with a scheme, or null. */
export const websiteUrl = (v) => {
  const s = text(v);
  if (!s || /\s/.test(s)) return null;
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
};

/**
 * A stored height or weight as a phrase. The rows print them every way there is
 * ("1.92 m (6 ft 4 in)", "176cm / 5'9\"", "170 lbs", "6 ft 6 in (1.98 m)") and a
 * bare number, which is metres or centimetres for a height and kilograms for a
 * weight.
 */
export function measure(v, kind) {
  const s = text(v);
  if (!s) return null;
  if (!/^\d+(\.\d+)?$/.test(s)) return s;
  const n = Number(s);
  if (!(n > 0)) return null;
  if (kind === 'height') return n < 3 ? `${s} m` : `${s} cm`;
  return `${s} kg`;
}

/** The one-line headline: position and team, else the sport. */
export function headlineOf(r) {
  const position = text(r.strPosition);
  const team = text(r.strTeam);
  if (position && team) return `${position} for ${team}`;
  if (position) return position;
  return team ? `Plays for ${team}` : (text(r.strSport) ?? 'Athlete');
}

/**
 * The document. Identity block per the spec (Kind, Handle, Web, Avatar), the
 * headline, one line of facts and provenance, then Accounts (the identity
 * keys) and Topics (the sport and the team). No em dashes anywhere.
 */
export function profileDoc(r) {
  const id = String(r.idPlayer);
  const name = text(r.strPlayer);
  const handle = `${slugify(name) || 'player'}-${id}`;
  const website = websiteUrl(r.strWebsite);
  const avatar = text(r.strCutout) ?? text(r.strThumb);
  const lines = [`# ${name}`, '', '- **Kind**: person', `- **Handle**: ${handle}`];
  if (website) lines.push(`- **Web**: ${website}`);
  if (avatar) lines.push(`- **Avatar**: ${avatar}`);
  lines.push('', headlineOf(r));
  const facts = [];
  const born = text(r.dateBorn);
  const nationality = text(r.strNationality);
  const height = measure(r.strHeight, 'height');
  const weight = measure(r.strWeight, 'weight');
  if (born) facts.push(`Born ${born}`);
  if (nationality) facts.push(`${born ? 'from' : 'From'} ${nationality}`);
  if (height) facts.push(`height ${height}`);
  if (weight) facts.push(`weight ${weight}`);
  lines.push(
    '',
    `${facts.length ? `${facts.join(', ')}. ` : ''}Compiled by NicheDB from TheSportsDB (player ${id}).`,
  );
  lines.push('', '## Accounts', '', `- ${playerPage(id)}`);
  for (const [network, field] of [
    ['x', 'strTwitter'],
    ['instagram', 'strInstagram'],
    ['facebook', 'strFacebook'],
    ['youtube', 'strYoutube'],
  ]) {
    const url = accountUrl(r[field], network);
    if (url) lines.push(`- ${url}`);
  }
  const qid = text(r.idWikidata);
  if (qid && /^Q\d+$/.test(qid)) lines.push(`- https://www.wikidata.org/wiki/${qid}`);
  const topics = [text(r.strSport), text(r.strTeam)].filter(Boolean);
  if (topics.length) {
    lines.push('', '## Topics', '');
    for (const t of topics) lines.push(`- ${t}`);
  }
  lines.push('');
  return lines.join('\n');
}

/** The item the core absorbs: kind `openprofile` with the document under data.doc. */
export function playerItem(r, fetchedAt) {
  const id = String(r.idPlayer);
  const name = text(r.strPlayer);
  const sportName = text(r.strSport);
  const sport = sportName ? sportSlug(sportName) : null;
  const team = text(r.strTeam);
  const teamId = text(r.idTeam);
  const page = playerPage(id);
  return {
    externalId: page,
    kind: 'openprofile',
    title: name,
    summary: headlineOf(r),
    url: page,
    imageUrl: text(r.strCutout) ?? text(r.strThumb),
    publishedAt: fetchedAt,
    timeKnown: true,
    precision: 'minute',
    tags: [
      'openprofile',
      `from:${PROVIDER}`,
      sport ? `sport:${sport}` : null,
      team ? `team:${slugify(team)}` : null,
    ].filter(Boolean),
    data: {
      app: PROVIDER,
      listing: teamId ? teamPage(teamId) : null,
      source_url: page,
      page_url: page,
      player_id: id,
      team_id: teamId,
      team,
      sport: sportName,
      position: text(r.strPosition),
      nationality: text(r.strNationality),
      born: text(r.dateBorn),
      wikidata: text(r.idWikidata),
      artwork_cc: text(r.strCreativeCommons) === 'Yes',
      attribution: ATTRIBUTION,
      updated_at: null,
      fetched_at: fetchedAt,
      doc: profileDoc(r),
    },
  };
}

/** Where a run starts: the cursor's next team id, else the configured start. */
export function resumeId(prev, config) {
  const start = Math.max(1, Math.floor(Number(config?.startId)) || START_ID);
  const next = Math.floor(Number(prev?.nextId));
  return Number.isFinite(next) && next >= start ? next : start;
}

export const sportsdbPlayers = defineAdapter({
  name: 'sportsdb-players',
  title: 'TheSportsDB players',
  collection: 'profiles',
  description:
    'Every player TheSportsDB knows, one OpenProfile.md per person with their position, team, sport, nationality, birth date, photo, X, Instagram, Facebook and YouTube, and the Wikidata item, so an athlete Sportarr also knows merges into one person. Walks the team id space through lookup_all_players.php, which answers for any team on the free key (ten rows a roster there, the whole squad on a premium key); a run asks for a fixed number of rosters and resumes, the walk ends after a long run of unknown ids past the newest team, and the next run starts over. TheSportsDB allows its data to be copied from the official API with a credit, and every document carries one.',
  docs: 'https://www.thesportsdb.com/documentation',
  kinds: ['openprofile'],
  cadenceMinutes: 1440,
  configFields: [
    {
      key: 'startId',
      label: 'First team id',
      type: 'number',
      placeholder: String(START_ID),
      help: 'Where a pass begins. Team ids start at 133,597; the few before it answer null.',
    },
    {
      key: 'requestCap',
      label: 'Rosters per run',
      type: 'number',
      placeholder: String(REQUEST_CAP),
      help: 'The walk stops here and picks up ten minutes later. Twenty-five rosters is under a minute at the free key limit.',
    },
    {
      key: 'pauseMs',
      label: 'Pause between rosters (ms)',
      type: 'number',
      placeholder: String(PAUSE_MS),
      help: 'The free key allows thirty requests a minute and Cloudflare refuses a burst; 2,100 ms keeps a run under both.',
    },
    {
      key: 'tailMisses',
      label: 'Unknown ids that end a pass',
      type: 'number',
      placeholder: String(TAIL_MISSES),
      help: 'Team ids have gaps, so one unknown id means nothing; this many in a row means the walk is past the newest team.',
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
      slug: 'sportsdb-players',
      name: 'People: TheSportsDB players',
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
    const cap = Math.max(
      1,
      Math.floor(Number(config?.requestCap)) || (premium(key) ? PREMIUM_REQUEST_CAP : REQUEST_CAP),
    );
    const tail = Math.max(1, Math.floor(Number(config?.tailMisses)) || TAIL_MISSES);
    const pause =
      config?.pauseMs === 0 ? 0 : Math.max(0, Math.floor(Number(config?.pauseMs))) || paceMs(key);
    const stopAt = Number.isFinite(deadline) ? deadline : Number.POSITIVE_INFINITY;
    const startedAt = resumeId(prev, config);
    const fetchedAt = new Date().toISOString();
    let id = startedAt;
    let topId = Math.floor(Number(prev?.topId)) || 0;
    let misses = 0;
    let requests = 0;
    let failures = 0;
    let streak = 0;
    let teams = 0;
    let stopped = null;
    const items = new Map();

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
        const res = await http.request(rosterUrl(key, id), {
          headers: { accept: 'application/json', 'user-agent': USER_AGENT },
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
      const rows = parseRoster(body);
      if (rows.length) {
        misses = 0;
        teams += 1;
        topId = Math.max(topId, id);
        for (const r of rows) {
          const item = playerItem(r, fetchedAt);
          if (!items.has(item.externalId)) items.set(item.externalId, item);
        }
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
      items: [...items.values()],
      cursor: {
        nextId: done ? null : id,
        topId: topId || null,
        walkedAt: done ? fetchedAt : (prev?.walkedAt ?? null),
        freeKey: usingFreeKey(key),
      },
      nextInMinutes: done ? undefined : 10,
      note:
        `${items.size} players from ${teams} teams in ${requests} lookups (ids ${startedAt} to ${id - 1}` +
        `${topId ? `, newest seen ${topId}` : ''})` +
        (failures ? `, ${failures} failed` : '') +
        (usingFreeKey(key) ? ', ten rows a roster on the free key' : '') +
        (done
          ? `; past the newest team, next run starts over at ${resumeId(null, config)}`
          : `; stopped ${reason} at ${id}, resuming in 10 min`),
    };
  },
});
