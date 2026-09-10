import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

import {
  BASE,
  broadcastItem,
  DEFAULT_KEY,
  FREE_KEY_SPORTS,
  listingsUrl,
  listingTime,
  normaliseListing,
  parseListings,
  redact,
  resumeIndex,
  SPORT_NAMES,
  splitFixture,
  sportName,
  sportSlug,
  sportsdbTv,
  sportsOf,
  usingFreeKey,
  utcDay,
  walkPlan,
} from '../packages/adapters/src/sportsdb.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

const fixture = async (name) =>
  JSON.parse(
    await readFile(new URL(`../packages/adapters/test/fixtures/${name}`, import.meta.url), 'utf8'),
  );

const day = await fixture('sportsdb-eventstv.json');

const PAID = 'abcdef0123456789';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * A fake `http` that answers `eventstv.php` from a router and records every URL.
 * The route sees the day and the sport name TheSportsDB would, so a test can
 * answer per query.
 */
function provider(route = () => day) {
  const urls = [];
  const http = {
    async request(url, opts) {
      urls.push({ url, opts });
      const u = new URL(url);
      const key = u.pathname.split('/')[4];
      const d = u.searchParams.get('d');
      const s = u.searchParams.get('s');
      const r = await route({ key, day: d, sport: s, url });
      if (r instanceof Response) return r;
      return json(r);
    },
    // `json` throws with the URL in its message; the adapter must not use it.
    async json(url) {
      throw new Error(`500 from ${url}`);
    },
  };
  return { http, urls };
}

const run = (http, extra = {}) => {
  const logs = [];
  const p = sportsdbTv.pull({
    config: { ...sportsdbTv.defaults },
    cursor: {},
    env: { sportsdbApiKey: PAID },
    http,
    log: (m) => logs.push(m),
    budget: 100,
    deadline: Date.now() + 60_000,
    ...extra,
  });
  return Object.assign(p, { logs });
};

/* --------------------------------------------------------------- parsing -- */

describe('sportsdb listing parsing', () => {
  test('sport names round-trip to the fixture slugs', () => {
    expect(sportName('australian-football')).toBe('Australian Football');
    expect(sportName('hockey')).toBe('Ice Hockey');
    expect(sportName('mma')).toBe('Fighting');
    expect(sportName('racing')).toBe('Motorsport');
    expect(sportName('curling')).toBeNull();
    for (const [slug, name] of SPORT_NAMES) expect(sportSlug(name)).toBe(slug);
    expect(sportSlug('Water Polo')).toBe('water-polo');
    expect(sportSlug('Snooker')).toBe('snooker');
    expect(sportSlug('')).toBeNull();
  });

  test('"Home vs Away" splits, anything else does not', () => {
    expect(splitFixture('Arsenal vs Chelsea')).toEqual(['Arsenal', 'Chelsea']);
    expect(splitFixture('Arsenal VS. Chelsea')).toEqual(['Arsenal', 'Chelsea']);
    expect(splitFixture('Italian Grand Prix')).toBeNull();
    expect(splitFixture('A vs B vs C')).toBeNull();
  });

  test('the listing time is the provider UTC stamp, or the day at noon without one', () => {
    expect(listingTime({ strTimeStamp: '2026-09-12 09:35:00' })).toEqual({
      publishedAt: new Date('2026-09-12T09:35:00Z'),
      timeKnown: true,
      precision: 'minute',
    });
    expect(listingTime({ strTimeStamp: '2026-09-12T16:30:00+00:00' }).publishedAt).toEqual(
      new Date('2026-09-12T16:30:00Z'),
    );
    expect(listingTime({ dateEvent: '2026-09-12', strTime: '00:20:00' }).publishedAt).toEqual(
      new Date('2026-09-12T00:20:00Z'),
    );
    expect(listingTime({ dateEvent: '2026-09-12', strTime: null })).toEqual({
      publishedAt: new Date('2026-09-12T12:00:00Z'),
      timeKnown: false,
      precision: 'day',
    });
    expect(listingTime({}).publishedAt).toBeNull();
  });

  test('a realistic eventstv.php day parses row by row, dropping the nameless one', () => {
    const rows = parseListings(day);
    expect(rows).toHaveLength(9);
    expect(parseListings({ tvevents: null })).toEqual([]);
    expect(parseListings(null)).toEqual([]);

    const afl = rows[0];
    expect(afl).toMatchObject({
      listingId: '1526611',
      eventId: '2201430',
      event: 'Collingwood vs Brisbane Lions',
      home: 'Collingwood',
      away: 'Brisbane Lions',
      channel: '7 Queensland',
      channelId: '1123',
      country: 'Australia',
      sport: 'australian-football',
      sportName: 'Australian Football',
      date: '2026-09-12',
      timeKnown: true,
    });
    expect(afl.publishedAt).toEqual(new Date('2026-09-12T09:35:00Z'));

    const nhl = rows.find((r) => r.channel === 'Sportsnet');
    expect(nhl.sport).toBe('hockey');
    expect(nhl.timeKnown).toBe(false);
    expect(nhl.logo).toBeNull();

    const f1 = rows.find((r) => r.channel === 'F1 TV');
    expect(f1.home).toBeNull();
    expect(f1.sport).toBe('racing');
    expect(f1.country).toBeNull();

    expect(normaliseListing({ strEvent: 'A vs B' })).toBeNull();
    expect(normaliseListing({ strChannel: 'X' })).toBeNull();
  });

  test('an item per listing, tagged so the mirror can pull a day and a sport', () => {
    const items = parseListings(day).map(broadcastItem);
    const afl = items[0];
    expect(afl.externalId).toBe('sportsdb:tv:2201430:7-queensland:australia:2026-09-12');
    expect(afl.kind).toBe('broadcast');
    expect(afl.title).toBe('Collingwood vs Brisbane Lions on 7 Queensland');
    expect(afl.publishedAt).toEqual(new Date('2026-09-12T09:35:00Z'));
    expect(afl.tags).toEqual([
      'broadcast',
      'australian-football',
      'date:2026-09-12',
      'country:australia',
      'channel:7-queensland',
    ]);
    expect(afl.imageUrl).toBe(
      'https://r2.thesportsdb.com/images/media/channel/logo/7queensland.png',
    );
    expect(afl.url).toBe('https://www.thesportsdb.com/event/2201430');
    expect(afl.data).toMatchObject({
      provider: 'thesportsdb',
      sport: 'australian-football',
      league: null,
      home: 'Collingwood',
      away: 'Brisbane Lions',
      event: 'Collingwood vs Brisbane Lions',
      channel: '7 Queensland',
      country: 'Australia',
      starts_at: '2026-09-12T09:35:00.000Z',
      eventId: '2201430',
    });

    // The same channel name in two markets is two items, and the US one is not
    // the only one, which is the reason this source exists.
    const espn = items.filter((i) => i.data.eventId === '2201512' && i.data.channel === 'ESPN');
    expect(espn.map((i) => i.externalId).sort()).toEqual([
      'sportsdb:tv:2201512:espn:brazil:2026-09-12',
      'sportsdb:tv:2201512:espn:united-states:2026-09-12',
    ]);

    // No country is still a market, and a title that is not a pair still reads.
    const f1 = items.find((i) => i.data.channel === 'F1 TV');
    expect(f1.title).toBe('Italian Grand Prix on F1 TV');
    expect(f1.tags).toContain('country:international');
    expect(f1.data.home).toBeNull();

    // The store accepts every one of them as-is.
    for (const it of items) {
      const stored = normaliseItem(it);
      expect(stored).not.toBeNull();
      expect(stored.kind).toBe('broadcast');
      expect(stored.tags).toContain('broadcast');
    }
    expect(new Set(items.map((i) => i.externalId)).size).toBe(items.length);
  });
});

/* ------------------------------------------------------------------ plan -- */

describe('sportsdb fetch plan', () => {
  const now = Date.parse('2026-09-10T15:00:00Z');

  test('the free keys are the shared ones and the default is one of them', () => {
    expect(DEFAULT_KEY).toBe('3');
    expect(usingFreeKey('3')).toBe(true);
    expect(usingFreeKey('123')).toBe(true);
    expect(usingFreeKey(undefined)).toBe(true);
    expect(usingFreeKey(PAID)).toBe(false);
  });

  test('a paid key walks one request per day from today to the horizon', () => {
    const plan = walkPlan({ now, horizonDays: 14, freeKey: false });
    expect(plan).toHaveLength(14);
    expect(plan[0]).toEqual({ day: '2026-09-10', sport: null });
    expect(plan.at(-1)).toEqual({ day: '2026-09-23', sport: null });
    expect(plan.every((u) => u.sport === null)).toBe(true);
  });

  test('the free key walks every mapped sport within each day, nearest day first', () => {
    const plan = walkPlan({ now, horizonDays: 14, freeKey: true });
    expect(FREE_KEY_SPORTS).toHaveLength(12);
    expect(plan).toHaveLength(12 * 14);
    expect(plan[0]).toEqual({ day: '2026-09-10', sport: 'football' });
    expect(plan[11]).toEqual({ day: '2026-09-10', sport: 'racing' });
    expect(plan[12]).toEqual({ day: '2026-09-11', sport: 'football' });
    expect(plan.at(-1)).toEqual({ day: '2026-09-23', sport: 'racing' });
  });

  test('config narrows the free-key sports and the horizon is clamped', () => {
    expect(sportsOf({ sports: 'soccer, australian-football, curling' })).toEqual([
      'soccer',
      'australian-football',
    ]);
    expect(sportsOf({ sports: ['hockey', 'hockey'] })).toEqual(['hockey']);
    expect(sportsOf({})).toBe(FREE_KEY_SPORTS);
    expect(sportsOf({ sports: 'curling' })).toBe(FREE_KEY_SPORTS);
    const plan = walkPlan({ now, horizonDays: 3, freeKey: true, sports: ['soccer'] });
    expect(plan).toEqual([
      { day: '2026-09-10', sport: 'soccer' },
      { day: '2026-09-11', sport: 'soccer' },
      { day: '2026-09-12', sport: 'soccer' },
    ]);
    expect(walkPlan({ now, horizonDays: 0, freeKey: false })).toHaveLength(14);
    expect(walkPlan({ now, horizonDays: 500, freeKey: false })).toHaveLength(60);
  });

  test('the cursor resumes inside the plan, and starts over when its day has passed', () => {
    const plan = walkPlan({ now, horizonDays: 14, freeKey: true });
    expect(resumeIndex(plan, {})).toBe(0);
    expect(resumeIndex(plan, { next: null })).toBe(0);
    expect(resumeIndex(plan, { next: { day: '2026-09-13', sport: 'soccer' } })).toBe(
      plan.findIndex((u) => u.day === '2026-09-13' && u.sport === 'soccer'),
    );
    expect(resumeIndex(plan, { next: { day: '2026-09-01', sport: 'soccer' } })).toBe(0);
    // A key change between runs: the free-key unit is not in the paid plan.
    const paid = walkPlan({ now, horizonDays: 14, freeKey: false });
    expect(resumeIndex(paid, { next: { day: '2026-09-13', sport: 'soccer' } })).toBe(0);
    expect(resumeIndex(paid, { next: { day: '2026-09-13' } })).toBe(3);
  });

  test('the URL carries the key in the path and the sport by its provider name', () => {
    expect(listingsUrl('3', '2026-09-12')).toBe(`${BASE}/3/eventstv.php?d=2026-09-12`);
    expect(listingsUrl('3', '2026-09-12', 'football')).toBe(
      `${BASE}/3/eventstv.php?d=2026-09-12&s=American%20Football`,
    );
    expect(listingsUrl('a/b', '2026-09-12')).toBe(`${BASE}/a%2Fb/eventstv.php?d=2026-09-12`);
  });

  test('redact takes a real key out of a message and leaves the shared key alone', () => {
    expect(redact(`500 from ${BASE}/${PAID}/eventstv.php?d=1`, PAID)).not.toContain(PAID);
    expect(redact('500 from x/3/y', '3')).toBe('500 from x/3/y');
    expect(redact('500 from x/a%2Fb/y', 'a/b')).toBe('500 from x/[key]/y');
  });
});

/* ------------------------------------------------------------------ pull -- */

describe('sportsdb-tv pull', () => {
  test('a paid key asks one whole day per request and finishes the horizon in one run', async () => {
    const { http, urls } = provider();
    const r = await run(http);
    expect(urls).toHaveLength(14);
    expect(urls[0].url).toBe(`${BASE}/${PAID}/eventstv.php?d=${utcDay(Date.now())}`);
    expect(urls.every((u) => !u.url.includes('&s='))).toBe(true);
    expect(urls.every((u) => u.opts.timeoutMs === 20_000)).toBe(true);
    // Nine listings a day, deduped by id across days (the fixture repeats).
    expect(r.items).toHaveLength(9);
    expect(r.cursor.next).toBeNull();
    expect(r.cursor.freeKey).toBe(false);
    expect(r.cursor.walkedAt).toBeTruthy();
    expect(r.nextInMinutes).toBeUndefined();
    expect(r.note).toMatch(/9 listings from 14 requests/);
    expect(r.note).toMatch(/whole days/);
  });

  test('the free key asks per sport and day, stops at the cap, and resumes next run', async () => {
    const { http, urls } = provider(({ sport }) => ({
      tvevents: day.tvevents.filter((row) => row.strSport === sport).slice(0, 1),
    }));
    const r = await run(http, { env: {} });
    expect(r.cursor.freeKey).toBe(true);
    expect(urls).toHaveLength(60);
    expect(urls[0].url).toBe(
      `${BASE}/3/eventstv.php?d=${utcDay(Date.now())}&s=American%20Football`,
    );
    expect(urls.every((u) => u.url.includes('&s='))).toBe(true);
    const plan = walkPlan({ horizonDays: 14, freeKey: true });
    expect(r.cursor.next).toEqual(plan[60]);
    expect(r.nextInMinutes).toBe(10);
    expect(r.note).toMatch(/stopped at the request cap/);
    // One row per (sport, day) on the free key; each sport's row is the same
    // listing every day in this fake, so the count is the sports with a row.
    expect(r.items.length).toBeGreaterThan(0);

    const second = provider(({ sport }) => ({
      tvevents: day.tvevents.filter((row) => row.strSport === sport).slice(0, 1),
    }));
    const r2 = await run(second.http, { env: {}, cursor: r.cursor });
    expect(second.urls[0].url).toBe(listingsUrl(DEFAULT_KEY, plan[60].day, plan[60].sport));
    expect(r2.cursor.next).toEqual(plan[120]);

    const third = provider(({ sport }) => ({
      tvevents: day.tvevents.filter((row) => row.strSport === sport).slice(0, 1),
    }));
    const r3 = await run(third.http, { env: {}, cursor: r2.cursor });
    expect(third.urls).toHaveLength(168 - 120);
    expect(r3.cursor.next).toBeNull();
    expect(r3.nextInMinutes).toBeUndefined();
  });

  test('the request cap is config, and the deadline cuts a walk short without losing its place', async () => {
    const capped = provider();
    const r = await run(capped.http, { config: { horizonDays: 14, requestCap: 5 } });
    expect(capped.urls).toHaveLength(5);
    expect(r.cursor.next).toEqual({ day: utcDay(Date.now() + 5 * 86_400_000), sport: null });
    expect(r.nextInMinutes).toBe(10);

    const late = provider();
    const r2 = await run(late.http, { deadline: Date.now() - 1 });
    expect(late.urls).toHaveLength(0);
    expect(r2.items).toEqual([]);
    expect(r2.cursor.next).toEqual({ day: utcDay(Date.now()), sport: null });
    expect(r2.nextInMinutes).toBe(10);
    expect(r2.note).toMatch(/run deadline/);
  });

  test('the day window is today to the horizon, day by day, in order', async () => {
    const { http, urls } = provider();
    await run(http, { config: { horizonDays: 3 } });
    const days = urls.map((u) => new URL(u.url).searchParams.get('d'));
    const t = Date.now();
    expect(days).toEqual([utcDay(t), utcDay(t + 86_400_000), utcDay(t + 2 * 86_400_000)]);
  });

  test('a failed day is logged and skipped; three in a row stop the run; all failing throws', async () => {
    const flaky = provider(({ day: d }) =>
      d === utcDay(Date.now() + 86_400_000) ? json({ error: 'nope' }, 500) : day,
    );
    const p = run(flaky.http, { config: { horizonDays: 3 } });
    const r = await p;
    expect(flaky.urls).toHaveLength(3);
    expect(r.items).toHaveLength(9);
    expect(r.cursor.next).toBeNull();
    expect(r.note).toMatch(/1 failed/);
    expect(p.logs.some((m) => /unavailable \(thesportsdb answered 500\)/.test(m))).toBe(true);

    const down = provider(() => json({ error: 'down' }, 503));
    await expect(run(down.http)).rejects.toThrow(/every request failed \(3 of 3\)/);
    expect(down.urls).toHaveLength(3);

    // A short outage in the middle stops the walk where it is, and the cursor
    // points at the first unit that was not read.
    let n = 0;
    const mid = provider(() => (++n >= 3 && n <= 5 ? json({ error: 'down' }, 503) : day));
    const r2 = await run(mid.http);
    expect(mid.urls).toHaveLength(5);
    expect(r2.cursor.next).toEqual({ day: utcDay(Date.now() + 4 * 86_400_000), sport: null });
    expect(r2.nextInMinutes).toBe(10);
    expect(r2.note).toMatch(/repeated failures/);
  });

  test('the key never appears in items, notes, logs or errors', async () => {
    const { http } = provider();
    const p = run(http);
    const r = await p;
    for (const it of r.items) expect(JSON.stringify(it)).not.toContain(PAID);
    expect(JSON.stringify(r.cursor)).not.toContain(PAID);
    expect(r.note).not.toContain(PAID);

    // A thrown fetch error that names the URL (the way `http.json` does) is
    // redacted before it is logged, and the run's own error names no URL.
    const leaky = {
      async request(url) {
        throw new Error(`ECONNRESET while fetching ${url}`);
      },
    };
    const q = run(leaky);
    let thrown = null;
    try {
      await q;
    } catch (err) {
      thrown = err;
    }
    expect(thrown).not.toBeNull();
    expect(thrown.message).not.toContain(PAID);
    expect(thrown.message).toMatch(/every request failed/);
    expect(q.logs).toHaveLength(3);
    for (const m of q.logs) {
      expect(m).not.toContain(PAID);
      expect(m).toContain('[key]');
    }
  });

  test('the adapter is described the way the registry expects', () => {
    expect(sportsdbTv.name).toBe('sportsdb-tv');
    expect(sportsdbTv.collection).toBe('sports');
    expect(sportsdbTv.kinds).toEqual(['broadcast']);
    expect(sportsdbTv.cadenceMinutes).toBe(180);
    expect(sportsdbTv.defaults).toEqual({ horizonDays: 14, requestCap: 60 });
    expect(sportsdbTv.defaultSources[0].slug).toBe('sportsdb-tv');
    expect(sportsdbTv.needsEnv).toBeUndefined();
  });
});
