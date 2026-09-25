import { defineAdapter, looseDate, slugify } from '@nichedb/core/adapter';

import { BATCH_SIZE, BUDGET_MS, PROVIDER, walk } from './musicbrainz-catalog.js';

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
 * and the timestamp stays date-only. Annotations, ratings, tags and genres
 * in the same rows are CC BY-NC-SA and never reach an item; the setlist is
 * a column of the event itself, core data, and is kept.
 */

export const ENTITIES = ['event'];
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
export function eventItem(e) {
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
  const country = rel.place?.area?.country ?? rel.area?.country ?? null;
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
      rel.links.ticketing ? 'tickets' : null,
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
export const toEventItem = (entity, row) => (entity === 'event' && row ? eventItem(row) : null);

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
  pull: (ctx) =>
    walk(ctx, { entities: ENTITIES, map: toEventItem, dumpName: 'musicbrainz-events' }),
});
