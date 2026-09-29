import { defineAdapter } from '@nichedb/core/adapter';

/**
 * Radio Browser (radio-browser.info): a community directory of internet radio
 * stations, every one with a stream URL a player can open.
 *
 * Keyless, and its terms are one line: "This webservice can be used freely but
 * without guarantee to work." It asks for a descriptive User-Agent, which the
 * worker's http already sends. Measured 2026-09-29: a full sweep is 66,721
 * stations over 14 pages, 59,747 passing the server's own stream check and
 * 14,346 with coordinates. `/json/stats` says 59,741 "stations": that counts
 * the working ones only, so it is not the number a sweep should reach.
 *
 * Three things shaped this adapter:
 *
 *   - The API is a set of mirrors that replicate from each other, and a mirror
 *     name that stops resolving is how one retires (fi1, nl1 and at1 in the
 *     docs no longer resolve). A run picks the first mirror that answers and
 *     stays on it, so every page is a page of the same copy of the database.
 *   - `order=changetimestamp` cannot be paged: the first ~5,000 stations share
 *     one second (a bulk import of 2026-01-14), and an offset through a tie is
 *     an offset through an unspecified order. `name` ties far less, and a
 *     daily full sweep catches anything a tie hid the day before.
 *   - `clickcount` is the last 24 hours, not a lifetime total, and `votes` is
 *     the lifetime one. Both are kept; `popular` is judged on either.
 *
 * A station the server marks broken is kept and tagged `offline`: whether a
 * stream still plays is the fact a directory reader wants, and it flips back.
 */

export const MIRRORS = [
  'https://de1.api.radio-browser.info',
  'https://de2.api.radio-browser.info',
  'https://all.api.radio-browser.info',
];

/** Daily. Stations change slowly; the stream checks are what move. */
export const CADENCE_MINUTES = 1440;

/** Stations per API page: about 5.5 MB of JSON at 5,000. */
export const PAGE = 5000;

/** Items handed over per batch. */
export const BATCH = 500;

/** Genre tags kept per station; some carry 38, most of them noise. */
export const MAX_GENRES = 20;

/** Either measure puts a station in the `popular` feed. */
export const POPULAR_VOTES = 1000;
export const POPULAR_CLICKS = 100;

const FETCH_TIMEOUT_MS = 120_000;

const list = (s) =>
  String(s ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A genre tag as a feed can name it: lowercase, no stray punctuation. */
export function genreTag(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}&+ -]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

/**
 * The station's point, or null. Radio Browser writes 0,0 for some stations
 * that have no place at all; nothing broadcasts from the Gulf of Guinea.
 */
export function pointOf(s) {
  const lat = num(s.geo_lat);
  const long = num(s.geo_long);
  if (lat === null || long === null) return null;
  if (lat === 0 && long === 0) return null;
  if (Math.abs(lat) > 90 || Math.abs(long) > 180) return null;
  return { lat, long };
}

/**
 * An http:// image on an https page is blockable mixed content, and nichedb
 * is served over https, so only an https favicon is worth showing.
 */
const httpsOnly = (u) => (typeof u === 'string' && u.startsWith('https://') ? u : null);

const isoOrNull = (s) => (typeof s === 'string' && s ? s : null);

export function stationItem(s) {
  if (!s?.stationuuid || !String(s.name ?? '').trim()) return null;
  const genres = [...new Set(list(s.tags).map(genreTag).filter(Boolean))].slice(0, MAX_GENRES);
  const languages = list(s.language).map((l) => l.toLowerCase());
  const codec = String(s.codec ?? '').trim();
  const online = s.lastcheckok === 1 || s.lastcheckok === true;
  const votes = num(s.votes) ?? 0;
  const clicks = num(s.clickcount) ?? 0;
  const popular = votes >= POPULAR_VOTES || clicks >= POPULAR_CLICKS;
  const cc = String(s.countrycode ?? '')
    .trim()
    .toLowerCase();
  const point = pointOf(s);
  const hls = s.hls === 1 || s.hls === true;
  const stream = s.url_resolved || s.url || null;

  const summary = [
    [s.state, s.country].filter(Boolean).join(', ') || null,
    s.language || null,
    genres.slice(0, 5).join(', ') || null,
    codec && codec !== 'UNKNOWN' ? `${codec}${s.bitrate ? ` ${s.bitrate} kbps` : ''}` : null,
    online ? null : 'stream failing its check',
  ]
    .filter(Boolean)
    .join(' · ');

  return {
    externalId: s.stationuuid,
    kind: 'station',
    title: String(s.name).trim(),
    summary: summary || null,
    // The homepage is the page about the station; a stream URL is not a page.
    url: s.homepage || stream,
    imageUrl: httpsOnly(s.favicon),
    // When the entry last changed. A station has no founding date here.
    publishedAt: isoOrNull(s.lastchangetime_iso8601),
    timeKnown: Boolean(s.lastchangetime_iso8601),
    precision: 'minute',
    tags: [
      'radio-browser',
      online ? 'online' : 'offline',
      ...(popular ? ['popular'] : []),
      ...(hls ? ['hls'] : []),
      ...(point ? ['geo'] : []),
      ...(cc ? [`country:${cc}`] : []),
      ...(codec && codec !== 'UNKNOWN' ? [`codec:${codec.toLowerCase()}`] : []),
      ...languages.slice(0, 4).map((l) => `lang:${l}`),
      ...genres,
    ],
    data: {
      stationUuid: s.stationuuid,
      name: String(s.name).trim(),
      stream,
      streamUrl: s.url || null,
      homepage: s.homepage || null,
      favicon: s.favicon || null,
      country: s.country || null,
      countryCode: s.countrycode || null,
      state: s.state || null,
      iso3166_2: s.iso_3166_2 || null,
      languages,
      languageCodes: list(s.languagecodes),
      genres,
      codec: codec || null,
      bitrate: num(s.bitrate) || null,
      hls,
      online,
      sslError: s.ssl_error === 1 || s.ssl_error === true,
      lastCheckOkAt: isoOrNull(s.lastcheckoktime_iso8601),
      votes,
      clicksLast24h: clicks,
      clickTrend: num(s.clicktrend),
      // Read by ndb_geo_shape, so /c/radio answers near= and sort=distance.
      ...(point ?? {}),
      page: `https://www.radio-browser.info/history/${s.stationuuid}`,
    },
  };
}

/** The first mirror that answers, so a run reads one copy of the database. */
export async function pickMirror(http, mirrors = MIRRORS) {
  for (const base of mirrors) {
    const stats = await http
      .jsonOrNull(`${base}/json/stats`, { timeoutMs: 15_000 })
      .catch(() => null);
    if (stats?.status === 'OK') return { base, stats };
  }
  throw new Error(`no Radio Browser mirror answered (${mirrors.join(', ')})`);
}

export const pageUrl = (base, offset, limit = PAGE) =>
  `${base}/json/stations?order=name&reverse=false&hidebroken=false&offset=${offset}&limit=${limit}`;

export const radiobrowser = defineAdapter({
  name: 'radiobrowser',
  title: 'Radio Browser',
  collection: 'radio',
  description:
    'Every internet radio station in the community directory at radio-browser.info: stream URL, homepage, country, language, genres, codec and bitrate, whether the stream passed its last check, votes and clicks, and coordinates where known. Keyless, free to use, swept daily.',
  docs: 'https://api.radio-browser.info',
  kinds: ['station'],
  cadenceMinutes: CADENCE_MINUTES,
  configFields: [
    {
      key: 'mirror',
      label: 'Mirror',
      type: 'text',
      placeholder: 'https://de1.api.radio-browser.info',
      help: 'Optional: one API server to read instead of the first that answers.',
    },
  ],
  defaults: {},
  defaultSources: [{ slug: 'radio-browser-stations', name: 'Radio Browser: stations', config: {} }],
  async *pull({ config, cursor, http, log, deadline }) {
    const { base, stats } = await pickMirror(http, config.mirror ? [config.mirror] : MIRRORS);
    /*
     * A deadline-stopped sweep resumes at its offset on the same day's sweep;
     * a new day starts again from zero, because a day-old offset into a list
     * that has since gained and lost stations is an offset into another list.
     */
    const today = new Date().toISOString().slice(0, 10);
    let offset = cursor?.day === today && Number.isInteger(cursor?.offset) ? cursor.offset : 0;
    let count = 0;

    for (;;) {
      if (deadline && Date.now() > deadline) {
        log(`stopped at offset ${offset} of ~${stats.stations}`);
        return { cursor: { day: today, offset }, note: `${count} stations, stopped at ${offset}` };
      }
      const page = await http.json(pageUrl(base, offset), { timeoutMs: FETCH_TIMEOUT_MS });
      if (!Array.isArray(page) || page.length === 0) break;
      const items = page.map(stationItem).filter(Boolean);
      offset += page.length;
      for (let i = 0; i < items.length; i += BATCH) {
        const last = i + BATCH >= items.length;
        yield {
          items: items.slice(i, i + BATCH),
          ...(last ? { cursor: { day: today, offset } } : {}),
        };
      }
      count += items.length;
      if (page.length < PAGE) break;
    }

    log(`${count} stations from ${base} (${stats.stations} of them working, by its count)`);
    return { cursor: {}, note: `${count} stations` };
  },
});
