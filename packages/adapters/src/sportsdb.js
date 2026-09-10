import { defineAdapter, looseDate, slugify } from '@nichedb/core/adapter';

/**
 * TheSportsDB: TV broadcast listings for the `sports` collection.
 *
 * Ported from tipoffwatch.com, where this was deliberately NOT a fixture provider
 * and still is not. ESPN and Live Tennis say what is being played and when; this
 * fills exactly one hole, which is that ESPN's scoreboard carries US listings and
 * nothing else. Measured against ESPN on 2026-08-21: NFL 16/16 games had a
 * broadcast, MLB 9/9, MLS 13/13 -- but AFL 0/9, NHL 0/7, NBA 0/1, men's college
 * basketball 0/51, and the Premier League had a listing for the current week and
 * nothing for the month after. Leagues with no US rights holder never get one at
 * all, and the rest are only assigned close to kickoff. TheSportsDB answers the
 * first case directly: for the AFL fixture that prompted this it returns
 * "7 Queensland / Australia", which is correct and is something ESPN will never
 * have.
 *
 * The listings are stored as their own `broadcast` items rather than written onto
 * fixtures, because the fixture is another source's row and matching a listing
 * to a fixture is a name-matching question (TheSportsDB says "Home vs Away", ESPN
 * says "Away at Home", and both print club names their own way) that the mirror
 * answers with the fixture in hand. Each item carries the listing's home and away
 * names, sport, day and channel, so a reader pulls `kind=broadcast` for a date
 * window and matches on the team names the way tipoffwatch's `syncBroadcasts` did.
 *
 * THE FREE KEY RETURNS ONE ROW PER QUERY. Not one page, one row: `d=2026-08-21`
 * returned a single NFL listing, and the same query narrowed by sport returned a
 * single AFL listing. That is a cap on the shared test key rather than a rate
 * limit, so on the default key this source fills a trickle -- which is why it asks
 * per (sport, day) on the free key and per day on a subscriber key, where one
 * unfiltered day came back with 795 listings against 576 for soccer alone and 44
 * for Australian Football where the free key returned one. Set SPORTSDB_API_KEY
 * to a subscriber key to get whole days back; nothing else here changes.
 *
 * The key rides in the URL path, so the URL is never put in an item, a note, a
 * log line or an error: requests go through `http.request` and the failures are
 * described by day and sport instead.
 */

export const PROVIDER = 'thesportsdb';

export const BASE = 'https://www.thesportsdb.com/api/v1/json';

/** The shared test key tipoffwatch defaults to, and the one this source does too. */
export const DEFAULT_KEY = '3';

/** The shared test keys, which are the ones subject to the one-row cap above. */
export const FREE_KEYS = new Set(['3', '123']);

/** True on a shared test key, where a query returns a single row. */
export const usingFreeKey = (key) => FREE_KEYS.has(String(key ?? DEFAULT_KEY));

/**
 * nichedb's sport slugs are ESPN's (the fixture items are tagged with them);
 * TheSportsDB uses its own display names. This is tipoffwatch's map, less
 * `motorsport`, which is not a slug any fixture here carries. Only sports where
 * a listing is plausible are mapped: on the free key each entry is one request
 * per day, and an unmapped sport is still covered by a subscriber key's whole
 * day.
 */
export const SPORT_NAMES = new Map([
  ['football', 'American Football'],
  ['basketball', 'Basketball'],
  ['baseball', 'Baseball'],
  ['hockey', 'Ice Hockey'],
  ['soccer', 'Soccer'],
  ['australian-football', 'Australian Football'],
  ['rugby', 'Rugby'],
  ['cricket', 'Cricket'],
  ['mma', 'Fighting'],
  ['tennis', 'Tennis'],
  ['golf', 'Golf'],
  ['racing', 'Motorsport'],
]);

/** The sports asked for one by one on the free key, in this order. */
export const FREE_KEY_SPORTS = [...SPORT_NAMES.keys()];

/** TheSportsDB's name for one of our sport slugs, or null where it has none. */
export const sportName = (sport) => SPORT_NAMES.get(sport) ?? null;

/**
 * The reverse: a listing's `strSport` -> the slug the fixtures carry, so a
 * listing and a fixture for the same game share a tag. Wider than SPORT_NAMES
 * because a subscriber key's whole day carries sports the free key never asks
 * for; anything unknown is slugified so the tag is still something.
 */
const SPORT_SLUGS = new Map([
  ...[...SPORT_NAMES.entries()].map(([slug, name]) => [name.toLowerCase(), slug]),
  ['field hockey', 'field-hockey'],
  ['lacrosse', 'lacrosse'],
  ['volleyball', 'volleyball'],
  ['water polo', 'water-polo'],
  ['rugby league', 'rugby-league'],
  ['rugby union', 'rugby'],
  ['motor sport', 'racing'],
]);

export function sportSlug(name) {
  const key = String(name ?? '')
    .trim()
    .toLowerCase();
  if (!key) return null;
  return SPORT_SLUGS.get(key) ?? slugify(key) ?? null;
}

/** TheSportsDB titles a fixture "Home vs Away". */
export function splitFixture(title) {
  const parts = String(title ?? '').split(/\s+vs\.?\s+/i);
  return parts.length === 2 ? [parts[0].trim(), parts[1].trim()] : null;
}

/* -------------------------------------------------------------- listings -- */

const HMS = /^\d{2}:\d{2}(?::\d{2})?$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

/**
 * When the listing is on, as `{publishedAt, timeKnown, precision}`.
 *
 * `strTimeStamp` is the provider's UTC clock ("2026-09-12 09:35:00", or ISO with
 * a zone on some rows); `dateEvent` + `strTime` is the same thing in two fields.
 * A row with a day and no clock lands at noon UTC with `timeKnown` false, the
 * house rule for a date without a time.
 */
export function listingTime(row) {
  const stamp = String(row?.strTimeStamp ?? '').trim();
  if (stamp) {
    const iso = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(stamp)
      ? stamp.replace(' ', 'T')
      : `${stamp.replace(' ', 'T')}Z`;
    const d = new Date(iso);
    if (!Number.isNaN(d.getTime())) return { publishedAt: d, timeKnown: true, precision: 'minute' };
  }
  const day = String(row?.dateEvent ?? '').trim();
  const time = String(row?.strTime ?? '').trim();
  if (YMD.test(day) && HMS.test(time)) {
    const d = new Date(`${day}T${time.length === 5 ? `${time}:00` : time}Z`);
    if (!Number.isNaN(d.getTime())) return { publishedAt: d, timeKnown: true, precision: 'minute' };
  }
  return looseDate(day);
}

const str = (v) => {
  const s = String(v ?? '').trim();
  return s ? s : null;
};

/** One `tvevents` row -> a listing, or null when it names no event or channel. */
export function normaliseListing(r) {
  const event = str(r?.strEvent);
  const channel = str(r?.strChannel);
  if (!event || !channel) return null;
  const pair = splitFixture(event);
  const when = listingTime(r);
  const date = YMD.test(String(r?.dateEvent ?? ''))
    ? r.dateEvent
    : (when.publishedAt?.toISOString().slice(0, 10) ?? null);
  return {
    listingId: str(r.id),
    eventId: str(r.idEvent),
    event,
    home: pair?.[0] ?? null,
    away: pair?.[1] ?? null,
    channel,
    channelId: str(r.idChannel),
    country: str(r.strCountry),
    logo: str(r.strLogo),
    sportName: str(r.strSport),
    sport: sportSlug(r.strSport),
    league: str(r.strLeague),
    date,
    ...when,
  };
}

/** A whole `eventstv.php` body -> its listings. The provider says `null` for none. */
export function parseListings(body) {
  const rows = Array.isArray(body?.tvevents) ? body.tvevents : [];
  return rows.map(normaliseListing).filter(Boolean);
}

/**
 * One listing -> one item.
 *
 * The id is composed rather than the provider's row id, so a listing re-entered
 * upstream under a new row id is the same item here. The country is part of it
 * because the same channel name is listed per market ("ESPN" in the US and in
 * Latin America are two rows), and a reader wanting the non-US one is the whole
 * point of this source.
 */
export function broadcastItem(l) {
  const channelSlug = slugify(l.channel) || 'unknown';
  const countrySlug = slugify(l.country) || 'international';
  const eventKey = l.eventId ?? slugify(l.event);
  const day = l.date ?? 'undated';
  const title =
    l.home && l.away ? `${l.home} vs ${l.away} on ${l.channel}` : `${l.event} on ${l.channel}`;
  return {
    externalId: `sportsdb:tv:${eventKey}:${channelSlug}:${countrySlug}:${day}`,
    kind: 'broadcast',
    title,
    summary: [l.sportName, l.league, l.country].filter(Boolean).join(' · ') || null,
    url: l.eventId ? `https://www.thesportsdb.com/event/${l.eventId}` : null,
    imageUrl: l.logo,
    publishedAt: l.publishedAt,
    timeKnown: l.timeKnown,
    precision: l.precision,
    tags: [
      'broadcast',
      l.sport,
      day !== 'undated' ? `date:${day}` : null,
      `country:${countrySlug}`,
      `channel:${channelSlug}`,
    ].filter(Boolean),
    data: {
      provider: PROVIDER,
      sport: l.sport,
      sportName: l.sportName,
      league: l.league,
      home: l.home,
      away: l.away,
      event: l.event,
      channel: l.channel,
      channelId: l.channelId,
      country: l.country,
      logo: l.logo,
      starts_at: l.publishedAt ? l.publishedAt.toISOString() : null,
      timeKnown: l.timeKnown,
      date: l.date,
      eventId: l.eventId,
      listingId: l.listingId,
    },
  };
}

/* ------------------------------------------------------------------ walk -- */

const DAY_MS = 86_400_000;

export const utcDay = (t) => new Date(t).toISOString().slice(0, 10);

/** Config `sports`, as a list of slugs; the whole map when unset. */
export function sportsOf(config) {
  const raw = config?.sports;
  const list = Array.isArray(raw)
    ? raw
    : String(raw ?? '')
        .split(/[,\s]+/)
        .filter(Boolean);
  const wanted = list.map((s) => s.toLowerCase()).filter((s) => SPORT_NAMES.has(s));
  return wanted.length ? [...new Set(wanted)] : FREE_KEY_SPORTS;
}

/**
 * The requests one whole walk makes, in order: every day from today to the
 * horizon, and on the free key every mapped sport within each day (day-major, so
 * a capped run still finishes the nearest days first, which are the ones a
 * broadcaster has actually been assigned to).
 *
 * @returns {Array<{day: string, sport: string|null}>}
 */
export function walkPlan({ now = Date.now(), horizonDays = 14, freeKey = true, sports } = {}) {
  const days = Math.max(1, Math.min(60, Math.floor(Number(horizonDays)) || 14));
  const start = Date.parse(`${utcDay(now)}T00:00:00Z`);
  const bySport = freeKey ? (sports ?? FREE_KEY_SPORTS) : [null];
  const plan = [];
  for (let i = 0; i < days; i++) {
    const day = utcDay(start + i * DAY_MS);
    for (const sport of bySport) plan.push({ day, sport });
  }
  return plan;
}

/**
 * Where in the plan a run picks up. The cursor names the unit a capped or
 * cut-short run stopped before; if that unit is still in the plan (the day has
 * not passed, the sports list has not changed) the walk resumes there, else it
 * starts over at today.
 */
export function resumeIndex(plan, cursor) {
  const next = cursor?.next;
  if (!next?.day) return 0;
  const idx = plan.findIndex(
    (u) => u.day === next.day && (u.sport ?? null) === (next.sport ?? null),
  );
  return idx < 0 ? 0 : idx;
}

export function listingsUrl(key, day, sport = null) {
  const name = sport ? sportName(sport) : null;
  return (
    `${BASE}/${encodeURIComponent(key)}/eventstv.php?d=${day}` +
    (name ? `&s=${encodeURIComponent(name)}` : '')
  );
}

/** A message with the key taken out. The shared test keys are not secrets. */
export function redact(message, key) {
  const text = String(message ?? '');
  if (!key || usingFreeKey(key)) return text;
  return text.split(key).join('[key]').split(encodeURIComponent(key)).join('[key]');
}

const describe = (u) => (u.sport ? `${u.day} ${u.sport}` : u.day);

/** Consecutive failures after which a run stops asking, so an outage costs little. */
const FAILURE_STOP = 3;

export const sportsdbTv = defineAdapter({
  name: 'sportsdb-tv',
  title: 'TheSportsDB TV listings',
  collection: 'sports',
  description:
    'Which channel carries a game, in every country TheSportsDB lists, as a broadcast row per listing with the home and away names, the sport, the day and the channel. Exists because ESPN\'s scoreboard is US-only: an AFL game comes back "7 Queensland / Australia", which ESPN will never have. Walks day by day from today to the horizon; on the free key (the default, which returns ONE row per query) it asks per sport and day, on a subscriber key one request returns the whole day. A run stops at its request cap and resumes where it left off. Set SPORTSDB_API_KEY to a subscriber key for whole days.',
  docs: 'https://www.thesportsdb.com/documentation',
  kinds: ['broadcast'],
  cadenceMinutes: 180,
  configFields: [
    {
      key: 'horizonDays',
      label: 'Days ahead',
      type: 'number',
      placeholder: '14',
      help: 'How far ahead to ask. Broadcasters are assigned close to kickoff, so beyond a fortnight there is little to find.',
    },
    {
      key: 'requestCap',
      label: 'Requests per run',
      type: 'number',
      placeholder: '60',
      help: 'The walk stops here and picks up ten minutes later. On a subscriber key a day is one request; on the free key a day is one request per sport.',
    },
    {
      key: 'sports',
      label: 'Sports (free key)',
      type: 'list',
      placeholder: 'soccer, australian-football',
      help: 'Free key only: which sports to ask for, by fixture slug. Unset asks for all twelve that TheSportsDB has a name for. A subscriber key gets every sport in one request.',
    },
  ],
  defaults: { horizonDays: 14, requestCap: 60 },
  defaultSources: [
    {
      slug: 'sportsdb-tv',
      name: 'Sports: TV listings (TheSportsDB)',
      config: { horizonDays: 14, requestCap: 60 },
    },
  ],
  async pull({ config, cursor: prev, env, http, log, deadline }) {
    const key = String(env?.sportsdbApiKey ?? env?.SPORTSDB_API_KEY ?? DEFAULT_KEY);
    const freeKey = usingFreeKey(key);
    const cap = Math.max(1, Math.floor(Number(config?.requestCap)) || 60);
    const stopAt = Number.isFinite(deadline) ? deadline : Number.POSITIVE_INFINITY;
    const now = Date.now();
    const plan = walkPlan({
      now,
      horizonDays: config?.horizonDays,
      freeKey,
      sports: sportsOf(config),
    });

    let idx = resumeIndex(plan, prev);
    const startedAt = idx;
    const items = [];
    const seen = new Set();
    let requests = 0;
    let failures = 0;
    let streak = 0;
    let stopped = null;

    while (idx < plan.length) {
      if (requests >= cap) {
        stopped = 'cap';
        break;
      }
      if (Date.now() > stopAt) {
        stopped = 'deadline';
        break;
      }
      const unit = plan[idx];
      requests += 1;
      let body = null;
      try {
        const res = await http.request(listingsUrl(key, unit.day, unit.sport), {
          headers: { accept: 'application/json' },
          timeoutMs: 20_000,
        });
        if (!res.ok) throw new Error(`thesportsdb answered ${res.status}`);
        body = await res.json();
        streak = 0;
      } catch (err) {
        failures += 1;
        streak += 1;
        log(`${describe(unit)} unavailable (${redact(err?.message ?? err, key)})`);
        if (streak >= FAILURE_STOP) {
          stopped = 'errors';
          break;
        }
        idx += 1;
        continue;
      }
      for (const listing of parseListings(body)) {
        const item = broadcastItem(listing);
        if (seen.has(item.externalId)) continue;
        seen.add(item.externalId);
        items.push(item);
      }
      idx += 1;
    }

    if (requests > 0 && failures === requests) {
      throw new Error(
        `thesportsdb: every request failed (${requests} of ${requests}); see the log`,
      );
    }

    const done = idx >= plan.length;
    const walked = plan.slice(startedAt, idx);
    const from = walked[0]?.day ?? plan[startedAt]?.day ?? null;
    const to = walked.at(-1)?.day ?? from;
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
        next: done ? null : plan[idx],
        walkedAt: done ? new Date(now).toISOString() : (prev?.walkedAt ?? null),
        freeKey,
      },
      nextInMinutes: done ? undefined : 10,
      note:
        `${items.length} listings from ${requests} requests (${from ?? 'nothing'}${to && to !== from ? ` to ${to}` : ''}` +
        `${freeKey ? ', free key: one row per query' : ', whole days'})` +
        (failures ? `, ${failures} failed` : '') +
        (done ? '' : `; stopped ${reason} at ${describe(plan[idx])}, resuming in 10 min`),
    };
  },
});
