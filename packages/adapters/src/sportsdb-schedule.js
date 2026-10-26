import { defineAdapter } from '@nichedb/core/adapter';

import {
  BASE,
  DEFAULT_KEY,
  paceMs,
  premium,
  redact,
  resumeIndex,
  sleep,
  utcDay,
} from './sportsdb.js';
import { fixtureItem } from './sportsdb-live.js';

/**
 * TheSportsDB: the fixture calendar for the `sports` collection.
 *
 * espn-schedule is the deep calendar for what ESPN carries -- about 360 leagues
 * across 16 sports. TheSportsDB knows 1,557 leagues across 38 sports, cricket,
 * darts, handball, snooker, netball and cycling among them, and on a subscriber
 * key `eventsday.php?d=` returns a whole day in one request: 362 games on a
 * Tuesday, about 1,400 on a weekend. sportsdb-live only ever sees the games
 * being played this minute; this is everything else, a fortnight ahead and a
 * day behind for the results.
 *
 * THE DAY IS CAPPED AT 1,500 ROWS. Measured 2026-10-26: Saturday 2026-10-31
 * answered exactly 1,500, of which soccer alone was 1,283 when asked for by
 * itself. So a day that comes back at the cap is asked again one sport at a
 * time, for every sport TheSportsDB lists, and the per-sport answers replace
 * the truncated one. A sport that hits the cap on its own (none has yet) is
 * kept as it came and said so in the note.
 *
 * Rows are fixtures in the same shape sportsdb-live emits, under the same
 * external ids, so a game seen by both is the same item and the live feed's
 * fresher score wins whenever it runs later. Subscribers only: on the shared
 * test key a day is ONE row, which is no calendar at all, so without
 * SPORTSDB_API_KEY this source does nothing and says so.
 */

/** Rows a day answer is cut off at. An answer this long is incomplete. */
export const DAY_CAP = 1500;

const DAY_MS = 86_400_000;

/** Consecutive failures after which a run stops asking, so an outage costs little. */
const FAILURE_STOP = 3;

export function dayUrl(key, day, sportName = null) {
  return (
    `${BASE}/${encodeURIComponent(key)}/eventsday.php?d=${day}` +
    (sportName ? `&s=${encodeURIComponent(sportName)}` : '')
  );
}

/** The raw rows of an eventsday answer, which is what the cap is counted on. */
export const dayRows = (body) => (Array.isArray(body?.events) ? body.events : []);

/**
 * The rows worth an item: an event id and either two sides or a name. A race,
 * a fight card or a golf round has no home and away -- 19 of Saturday's 1,500
 * rows -- and is still a fixture, the way ESPN's racing and golf events are.
 */
export function parseDay(body) {
  const has = (v) => String(v ?? '').trim() !== '';
  return dayRows(body).filter(
    (r) => r?.idEvent && ((has(r.strHomeTeam) && has(r.strAwayTeam)) || has(r.strEvent)),
  );
}

/**
 * The days one whole walk covers, in order: today first, then forward to the
 * horizon, then the days behind (results), so a run cut short spends what it
 * had on what is coming up.
 *
 * @returns {Array<{day: string, sport: null}>}
 */
export function schedulePlan({ now = Date.now(), horizonDays = 14, backDays = 1 } = {}) {
  const ahead = Math.max(1, Math.min(60, Math.floor(Number(horizonDays)) || 14));
  const back = Math.max(0, Math.min(14, Math.floor(Number(backDays ?? 1))));
  const start = Date.parse(`${utcDay(now)}T00:00:00Z`);
  const plan = [];
  for (let i = 0; i < ahead; i++) plan.push({ day: utcDay(start + i * DAY_MS), sport: null });
  for (let i = 1; i <= back; i++) plan.push({ day: utcDay(start - i * DAY_MS), sport: null });
  return plan;
}

/** Every sport TheSportsDB lists, by its own name. A subscriber key gets them all. */
export async function sportNames(http, key) {
  const res = await http.request(`${BASE}/${encodeURIComponent(key)}/all_sports.php`, {
    headers: { accept: 'application/json' },
    timeoutMs: 20_000,
  });
  if (!res.ok) throw new Error(`thesportsdb answered ${res.status}`);
  const body = await res.json();
  const rows = Array.isArray(body?.sports) ? body.sports : [];
  return [...new Set(rows.map((r) => String(r?.strSport ?? '').trim()).filter(Boolean))];
}

export const sportsdbSchedule = defineAdapter({
  name: 'sportsdb-schedule',
  title: 'TheSportsDB fixtures',
  collection: 'sports',
  description:
    "Every fixture TheSportsDB has from yesterday to a fortnight ahead, across all 38 of its sports -- cricket, darts, handball, snooker, netball, cycling and the rest that ESPN never carries -- with scores once they are in. One request a day on a subscriber key; a day that comes back at TheSportsDB's 1,500-row cap is asked again sport by sport. Rows are fixtures under TheSportsDB's own ids, the same ones sportsdb-live uses, so a game in both is one item. Subscribers only: the shared test key answers one row a day, so without SPORTSDB_API_KEY this source stays quiet.",
  docs: 'https://www.thesportsdb.com/documentation',
  kinds: ['fixture'],
  cadenceMinutes: 60,
  configFields: [
    {
      key: 'horizonDays',
      label: 'Days ahead',
      type: 'number',
      placeholder: '14',
      help: 'How far ahead to ask, counting today.',
    },
    {
      key: 'backDays',
      label: 'Days behind',
      type: 'number',
      placeholder: '1',
      help: 'How many past days to re-read for final scores.',
    },
    {
      key: 'requestCap',
      label: 'Requests per run',
      type: 'number',
      placeholder: '80',
      help: 'The walk stops here and picks up ten minutes later. A day is one request, or one per sport when it is at the cap.',
    },
  ],
  defaults: { horizonDays: 14, backDays: 1, requestCap: 80 },
  defaultSources: [
    {
      slug: 'sportsdb-schedule',
      name: 'Sports: fixtures (TheSportsDB)',
      config: { horizonDays: 14, backDays: 1, requestCap: 80 },
    },
  ],
  async pull({ config, cursor: prev, env, http, log, deadline }) {
    const key = String(env?.sportsdbApiKey ?? env?.SPORTSDB_API_KEY ?? DEFAULT_KEY);
    if (!premium(key)) {
      return {
        items: [],
        note: 'no subscriber key: the shared test key answers one fixture a day, so nothing was asked for. Set SPORTSDB_API_KEY.',
      };
    }
    const cap = Math.max(1, Math.floor(Number(config?.requestCap)) || 80);
    const stopAt = Number.isFinite(deadline) ? deadline : Number.POSITIVE_INFINITY;
    const pace =
      config?.pauseMs === 0 ? 0 : Math.max(0, Math.floor(Number(config?.pauseMs))) || paceMs(key);
    const now = Date.now();
    const plan = schedulePlan({
      now,
      horizonDays: config?.horizonDays,
      backDays: config?.backDays,
    });

    let idx = resumeIndex(plan, prev);
    const startedAt = idx;
    const items = [];
    const seen = new Set();
    let requests = 0;
    let failures = 0;
    let streak = 0;
    let stopped = null;
    let sports = null;
    const capped = [];

    const ask = async (url, what) => {
      if (requests > 0) await sleep(pace);
      requests += 1;
      try {
        const res = await http.request(url, {
          headers: { accept: 'application/json' },
          timeoutMs: 30_000,
        });
        if (!res.ok) throw new Error(`thesportsdb answered ${res.status}`);
        const body = await res.json();
        streak = 0;
        return dayRows(body);
      } catch (err) {
        failures += 1;
        streak += 1;
        log(`${what} unavailable (${redact(err?.message ?? err, key)})`);
        return null;
      }
    };
    const keep = (rows) => {
      for (const row of parseDay({ events: rows })) {
        const item = fixtureItem(row, { now });
        if (seen.has(item.externalId)) continue;
        seen.add(item.externalId);
        items.push(item);
      }
    };

    while (idx < plan.length) {
      if (requests >= cap) {
        stopped = 'cap';
        break;
      }
      if (Date.now() > stopAt) {
        stopped = 'deadline';
        break;
      }
      const { day } = plan[idx];
      const rows = await ask(dayUrl(key, day), day);
      if (rows === null) {
        if (streak >= FAILURE_STOP) {
          stopped = 'errors';
          break;
        }
        idx += 1;
        continue;
      }
      if (rows.length < DAY_CAP) {
        keep(rows);
        idx += 1;
        continue;
      }

      // Truncated: keep what came, then ask sport by sport. The per-sport walk
      // is not cut by the request cap -- stopping half way through a day would
      // resume at the next one and leave this day short until the next pass.
      keep(rows);
      if (!sports) {
        try {
          sports = await sportNames(http, key);
          requests += 1;
        } catch (err) {
          log(`sport list unavailable (${redact(err?.message ?? err, key)})`);
          sports = [];
        }
      }
      for (const name of sports) {
        if (Date.now() > stopAt) break;
        const part = await ask(dayUrl(key, day, name), `${day} ${name}`);
        if (part === null) continue;
        if (part.length >= DAY_CAP) capped.push(`${day} ${name}`);
        keep(part);
      }
      idx += 1;
    }

    if (requests > 0 && failures === requests) {
      throw new Error(
        `thesportsdb: every request failed (${requests} of ${requests}); see the log`,
      );
    }

    const done = idx >= plan.length;
    const reason =
      stopped === 'cap'
        ? 'at the request cap'
        : stopped === 'deadline'
          ? 'on the run deadline'
          : stopped === 'errors'
            ? 'after repeated failures'
            : null;
    const walked = plan.slice(startedAt, idx).map((u) => u.day);

    return {
      items,
      cursor: {
        next: done ? null : plan[idx],
        walkedAt: done ? new Date(now).toISOString() : (prev?.walkedAt ?? null),
      },
      nextInMinutes: done ? undefined : 10,
      note:
        `${items.length} fixtures from ${requests} requests` +
        (walked.length ? ` (${walked.length} days, ${walked[0]} first)` : '') +
        (failures ? `, ${failures} failed` : '') +
        (capped.length ? `; still at the cap: ${capped.join(', ')}` : '') +
        (done ? '' : `; stopped ${reason} at ${plan[idx].day}, resuming in 10 min`),
    };
  },
});
