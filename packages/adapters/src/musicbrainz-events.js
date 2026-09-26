import { readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defineAdapter, looseDate, slugify } from '@nichedb/core/adapter';
import { dumpDir, xzLines } from '@nichedb/core/dump';

import {
  BATCH_SIZE,
  BUDGET_MS,
  dumpUrl,
  LATEST_URL,
  localFile,
  memberOf,
  PROVIDER,
  parseLatest,
  USER_AGENT,
  walk,
} from './musicbrainz-catalog.js';

/**
 * MusicBrainz: every live event, for the `events` collection.
 *
 * Why this source. The ticket sites are the obvious place to look for who is
 * playing where, and none of them can be carried: Ticketmaster's Discovery
 * terms allow caching Event Content only "for reasonable periods" and forbid
 * deriving revenue from it, SeatGeek's forbid copying, storing or caching its
 * content at all, and StubHub and Vivid Seats have no public API left, only
 * affiliate programmes. MusicBrainz's event data is CC0, published whole in
 * the same twice-weekly JSON dumps musicbrainz-catalog walks, so this is that
 * walk over the one entity it does not read.
 *
 * WHAT IS IN IT (measured on the 20260923-001002 dump)
 *
 * `event.tar.xz` is 48 MB and holds 125,978 events: 83,016 concerts, 31,710
 * festivals, then stage performances, launch events, conventions, award
 * ceremonies and competitions, and 7,125 with no type. It is mostly history:
 * about 1,700 are still to come. What makes a row useful is its relations,
 * which musicbrainz-catalog drops and this keeps, cut down to the parts that
 * say who, where and how to get in: the performers (286k "main performer",
 * 49k "support act", then guests, hosts, conductors, orchestras, DJs), the
 * venue with its coordinates and city (112k "held at" a place, 9k "held in"
 * an area), the series a festival edition belongs to, the event it was
 * rescheduled as, and the links: 5,753 ticketing pages, 32,678 setlist.fm
 * pages, Songkick, Bandsintown, the official homepage, social profiles and
 * the poster. There are no prices anywhere in it.
 *
 * TRAPS
 *
 * A date whose year is unknown is written with question marks, `????-04-01`,
 * which sorts after every real date as a string and which `new Date()`, the
 * last resort of looseDate, reads as 2 April 2001. Only a year, a year and
 * month or a whole date is parsed, so such a row is stored undated. The
 * `time` is the venue's local wall clock with no zone, so it goes to `data`
 * and the timestamp stays date-only.
 *
 * WHERE, BY COUNTRY
 *
 * An event row names its venue's city but not the city's country: only 15k
 * of 126k events carried an ISO code of their own. The country is in the
 * area dump (35 MB, 120k areas), where every area is "part of" a larger one
 * up to a country: Bonn, then Nordrhein-Westfalen (DE-NW), then Germany. So
 * each new dump starts by fetching area.tar.xz, resolving every area to its
 * country up that chain, and caching the map as JSON beside the dump; the
 * archive is then deleted. That puts a country on 114k events (90.8%); the
 * rest name no venue or area at all. A failure here is logged and the walk
 * goes on without it, so an area outage never stops events being read. Annotations, ratings, tags and genres
 * in the same rows are CC BY-NC-SA and never reach an item; the setlist is
 * a column of the event itself, core data, and is kept.
 */

export const ENTITIES = ['event'];

/**
 * The version of what a row maps to. The walk marks a dump done and skips it
 * until the next one, so a change to the mapping would otherwise wait up to
 * four days to reach the rows; a cursor carrying another version is read as
 * no cursor, and the current dump is walked again once. Bump it with any
 * change to eventItem or the area map.
 *
 * 2: a country from the area hierarchy; cancelled shows lose `tickets`.
 */
export const MAPPING_VERSION = 2;
export const ATTRIBUTION = 'MusicBrainz, CC0';

/** A dump lands twice a week; a daily look at LATEST picks each one up within a day. */
export const CADENCE_MINUTES = 1440;

/** Performers named in tags, so a feed can follow an act without a search. */
export const MAX_ARTIST_TAGS = 8;

/** Performer roles, in the order a summary names them. */
const PERFORMER_ROLES = [
  'main performer',
  'support act',
  'guest performer',
  'host',
  'conductor',
  'orchestra',
  'supporting DJ',
  'participant',
];

/** URL relation types kept, and the key each is stored under. */
const LINK_KEYS = {
  ticketing: 'ticketing',
  setlistfm: 'setlistfm',
  songkick: 'songkick',
  bandsintown: 'bandsintown',
  'official homepage': 'homepage',
  'social network': 'social',
  'last.fm': 'lastfm',
  wikidata: 'wikidata',
  poster: 'poster',
  review: 'review',
};

/**
 * A MusicBrainz date: a year, a year and month, or a whole date. Anything
 * else must not reach looseDate, whose last resort is `new Date()`, and
 * `new Date('????-04-01')` is 2 April 2001.
 */
export const PARTIAL_DATE = /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/;

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const uniq = (xs) => [...new Set(xs.filter(Boolean))];
const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);

/** The two-letter country an area names itself by, or null. */
export function countryOf(area) {
  if (!area || typeof area !== 'object') return null;
  const one = Array.isArray(area['iso-3166-1-codes']) ? str(area['iso-3166-1-codes'][0]) : null;
  if (one && /^[A-Z]{2}$/i.test(one)) return one.toUpperCase();
  const two = Array.isArray(area['iso-3166-2-codes']) ? str(area['iso-3166-2-codes'][0]) : null;
  const m = two?.match(/^([A-Z]{2})-/i);
  return m ? m[1].toUpperCase() : null;
}

/** An area as stored: its name, type and MusicBrainz id. */
const areaOf = (a) =>
  a && typeof a === 'object' && str(a.name)
    ? { name: str(a.name), type: str(a.type), mbid: str(a.id), country: countryOf(a) }
    : null;

/**
 * The relations of one event, sorted into what an item keeps: performers by
 * role, the venue, the area, series, the event it was moved to, and links.
 */
export function relationsOf(relations) {
  const out = {
    performers: [],
    place: null,
    area: null,
    series: [],
    rescheduledAs: null,
    links: {},
  };
  if (!Array.isArray(relations)) return out;
  for (const r of relations) {
    const target = r?.['target-type'];
    const type = str(r?.type);
    if (!type) continue;
    if (target === 'artist' && PERFORMER_ROLES.includes(type)) {
      const name = str(r['target-credit']) ?? str(r.artist?.name);
      if (name) out.performers.push({ name, mbid: str(r.artist?.id), role: type });
    } else if (target === 'place' && type === 'held at' && !out.place && r.place) {
      const p = r.place;
      const lat = num(p.coordinates?.latitude);
      const long = num(p.coordinates?.longitude);
      out.place = {
        name: str(p.name),
        mbid: str(p.id),
        type: str(p.type),
        address: str(p.address),
        location: lat !== null && long !== null ? { lat, long } : null,
        area: areaOf(p.area),
      };
    } else if (target === 'area' && type === 'held in' && !out.area) {
      out.area = areaOf(r.area);
    } else if (target === 'series' && type === 'part of' && str(r.series?.name)) {
      out.series.push({ name: str(r.series.name), mbid: str(r.series.id) });
    } else if (target === 'event' && type === 'rescheduled as' && r.direction === 'forward') {
      const id = str(r.event?.id);
      if (id) out.rescheduledAs = { name: str(r.event.name), mbid: id };
    } else if (target === 'url' && LINK_KEYS[type]) {
      const href = str(r.url?.resource);
      if (!href || !/^https?:\/\//i.test(href)) continue;
      const key = LINK_KEYS[type];
      const list = out.links[key] ?? [];
      if (!list.includes(href)) list.push(href);
      out.links[key] = list;
    }
  }
  // Main performers first, the rest in the order the roles are listed.
  out.performers.sort((a, b) => PERFORMER_ROLES.indexOf(a.role) - PERFORMER_ROLES.indexOf(b.role));
  return out;
}

/** "Metallica, with Pantera and Mammoth" out of the performers, or null. */
export function billing(performers) {
  const main = uniq(performers.filter((p) => p.role === 'main performer').map((p) => p.name));
  const support = uniq(performers.filter((p) => p.role === 'support act').map((p) => p.name));
  const list = (xs) =>
    xs.length <= 2 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`;
  const head =
    main.length > 6 ? `${main.slice(0, 6).join(', ')} and ${main.length - 6} more` : list(main);
  if (!head) return support.length ? `with ${list(support)}` : null;
  return support.length ? `${head}, with ${list(support)}` : head;
}

/** One event row as an item, or null when it is not one. */
export function eventItem(e, countries = null) {
  const id = str(e?.id);
  const name = str(e?.name);
  if (!id || !name) return null;
  const type = str(e.type);
  const life = e['life-span'] && typeof e['life-span'] === 'object' ? e['life-span'] : {};
  const begin = str(life.begin);
  const end = str(life.end);
  const when = looseDate(PARTIAL_DATE.test(begin ?? '') ? begin : '');
  const rel = relationsOf(e.relations);
  const city = rel.place?.area ?? rel.area;
  const country =
    rel.place?.area?.country ??
    rel.area?.country ??
    countries?.get(rel.place?.area?.mbid) ??
    countries?.get(rel.area?.mbid) ??
    null;
  const cancelled = e.cancelled === true;
  const where = [rel.place?.name, city?.name].filter(Boolean);
  const bill = billing(rel.performers);
  const artistTags = uniq(
    rel.performers
      .filter((p) => p.role === 'main performer')
      .map((p) => slugify(p.name))
      .filter(Boolean)
      .map((s) => `artist:${s}`),
  ).slice(0, MAX_ARTIST_TAGS);
  const citySlug = city?.name ? slugify(city.name) : '';
  return {
    externalId: `musicbrainz:event:${id}`,
    kind: 'event',
    title: name,
    summary:
      [
        cancelled ? 'Cancelled.' : null,
        bill,
        where.length ? `at ${where.join(', ')}` : null,
        str(e.disambiguation) ? `(${str(e.disambiguation)})` : null,
      ]
        .filter(Boolean)
        .join(' ') || null,
    url: `https://musicbrainz.org/event/${id}`,
    imageUrl: null,
    publishedAt: when.publishedAt,
    timeKnown: false,
    precision: when.precision,
    tags: uniq([
      'event',
      PROVIDER,
      type ? `type:${slugify(type)}` : null,
      cancelled ? 'cancelled' : null,
      country ? `country:${country.toLowerCase()}` : null,
      citySlug ? `city:${citySlug}` : null,
      // "tickets" means you can still buy one: the on-sale feed asks for it,
      // and a cancelled show keeps its link in data but not the tag.
      rel.links.ticketing && !cancelled ? 'tickets' : null,
      rel.links.setlistfm || str(e.setlist) ? 'setlist' : null,
      ...artistTags,
    ]),
    data: {
      mbid: id,
      type,
      cancelled,
      begin,
      end,
      time: str(e.time),
      disambiguation: str(e.disambiguation),
      setlist: str(e.setlist),
      performers: rel.performers,
      place: rel.place,
      area: rel.area,
      country,
      series: rel.series,
      rescheduledAs: rel.rescheduledAs,
      links: rel.links,
      attribution: ATTRIBUTION,
    },
  };
}

/** The walk's mapper: only event rows become items. */
export const toEventItem = (entity, row, countries = null) =>
  entity === 'event' && row ? eventItem(row, countries) : null;

/** The first "part of" parent an area row names: `{ id, country }`, or null. */
function parentOf(row) {
  for (const r of Array.isArray(row?.relations) ? row.relations : []) {
    if (r?.['target-type'] === 'area' && r.type === 'part of' && r.direction === 'backward') {
      const id = str(r.area?.id);
      if (id) return { id, country: countryOf(r.area) };
    }
  }
  return null;
}

/**
 * Every area's country, from the rows of the area member: an area's own ISO
 * code, else its parent's, else up the "part of" chain until one has a code.
 * A chain longer than a dozen steps, or a loop, resolves to nothing.
 */
export async function areaCountries(rows) {
  const own = new Map();
  const parent = new Map();
  for await (const row of rows) {
    const id = str(row?.id);
    if (!id) continue;
    const p = parentOf(row);
    const cc = countryOf(row) ?? p?.country ?? null;
    if (cc) own.set(id, cc);
    if (p) parent.set(id, p.id);
  }
  const out = new Map();
  const resolve = (id) => {
    if (out.has(id)) return out.get(id);
    let cur = id;
    let cc = null;
    for (let i = 0; i < 12 && cur && !cc; i++) {
      cc = out.get(cur) ?? own.get(cur) ?? null;
      cur = parent.get(cur);
    }
    out.set(id, cc);
    return cc;
  };
  for (const id of new Set([...own.keys(), ...parent.keys()])) resolve(id);
  for (const [id, cc] of out) if (!cc) out.delete(id);
  return out;
}

/** Where a dump's area map is cached. */
export const countriesFile = (dataDir, dir) => join(dataDir, `${dir}-area-country.json`);

async function* parsedLines(file) {
  for await (const line of xzLines(file, { member: memberOf('area') })) {
    try {
      yield JSON.parse(line);
    } catch {
      // a bad line is skipped, as in the walk
    }
  }
}

/**
 * The area map for one dump: read from its cache, or built from area.tar.xz
 * and cached. Older dumps' maps are removed. Null when it cannot be had.
 */
export async function loadCountries({ http, log, dir, dataDir }) {
  const file = countriesFile(dataDir, dir);
  try {
    return new Map(Object.entries(JSON.parse(await readFile(file, 'utf8'))));
  } catch {
    // not cached yet
  }
  const archive = localFile(dataDir, dir, 'area');
  try {
    const dl = await http.download(dumpUrl(dir, 'area'), archive, {
      headers: { 'user-agent': USER_AGENT },
      timeoutMs: 10 * 60_000,
    });
    if (!dl?.complete) {
      log(`area: download incomplete (${dl?.bytes ?? 0} bytes), countries from the events alone`);
      return null;
    }
    const map = await areaCountries(parsedLines(archive));
    await writeFile(file, JSON.stringify(Object.fromEntries(map)));
    for (const name of await readdir(dataDir)) {
      if (name.endsWith('-area-country.json') && !name.startsWith(`${dir}-`)) {
        await unlink(join(dataDir, name)).catch(() => {});
      }
    }
    log(`area: ${map.size} areas resolved to a country`);
    return map;
  } catch (err) {
    log(`area: ${err?.message ?? err}, countries from the events alone`);
    return null;
  } finally {
    await unlink(archive).catch(() => {});
  }
}

/**
 * The adapter's pull: the area map for the current dump, then the shared
 * walk with it. A dump already walked goes straight to the walk, which
 * answers "unchanged" without fetching anything else.
 */
export async function* pullEvents(ctx, { dataDir = null, pauseMs, now } = {}) {
  const base = dataDir ?? (await dumpDir('musicbrainz-events'));
  let countries = null;
  let dir = null;
  try {
    dir = parseLatest(
      await ctx.http.text(LATEST_URL, {
        headers: { 'user-agent': USER_AGENT, accept: 'text/plain, */*' },
        timeoutMs: 20_000,
      }),
    );
  } catch {
    // the walk asks again and reports the failure itself
  }
  const prev = ctx.cursor?.v === MAPPING_VERSION ? ctx.cursor : null;
  const walked = prev?.dir === dir && prev?.done === true;
  if (dir && !walked)
    countries = await loadCountries({ http: ctx.http, log: ctx.log, dir, dataDir: base });
  const stamp = (cursor) => (cursor ? { ...cursor, v: MAPPING_VERSION } : cursor);
  const inner = walk(
    { ...ctx, cursor: prev },
    {
      dataDir: base,
      ...(pauseMs === undefined ? {} : { pauseMs }),
      ...(now ? { now } : {}),
      entities: ENTITIES,
      map: (entity, row) => toEventItem(entity, row, countries),
      dumpName: 'musicbrainz-events',
    },
  );
  let step = await inner.next();
  while (!step.done) {
    yield { ...step.value, cursor: stamp(step.value.cursor) };
    step = await inner.next();
  }
  return step.value ? { ...step.value, cursor: stamp(step.value.cursor) } : step.value;
}

export const musicbrainzEvents = defineAdapter({
  name: 'musicbrainz-events',
  title: 'MusicBrainz: every concert, festival and live event',
  collection: 'events',
  description:
    'Every event in MusicBrainz, from the twice-weekly JSON dumps: about 126,000 concerts, festivals, stage performances, launch events, conventions, award ceremonies and competitions, each with its date and local start time, whether it was cancelled, the performers by role (headliner, support, guest, host, conductor), the venue with its address, coordinates and city, the series a festival edition belongs to, the setlist where one was entered, and links to its ticketing page, setlist.fm, Songkick, Bandsintown, homepage and poster. No prices: no ticket seller licenses those for storage. CC0, credited on every row; the CC BY-NC-SA annotations, ratings, tags and genres are dropped. The 48 MB archive is walked in one run and the walk is repeated when a new dump appears.',
  docs: 'https://musicbrainz.org/doc/Event',
  kinds: ['event'],
  cadenceMinutes: CADENCE_MINUTES,
  budgetMs: BUDGET_MS,
  configFields: [
    {
      key: 'batchSize',
      label: 'Rows per batch',
      type: 'number',
      placeholder: String(BATCH_SIZE),
      help: 'Rows mapped and written together; the cursor is saved after each batch.',
    },
  ],
  defaults: { batchSize: BATCH_SIZE },
  defaultSources: [
    {
      slug: 'musicbrainz-events',
      name: 'Events: every concert and festival on MusicBrainz',
      config: { batchSize: BATCH_SIZE },
    },
  ],
  pull: (ctx) => pullEvents(ctx),
});
