import { defineAdapter, looseDate, slugify } from '@nichedb/core/adapter';

import {
  fileOf,
  imageUrlFor,
  isBareQid,
  parseBindings,
  qidOf,
  SPARQL,
  splitList,
  TIMEOUT_MS,
  USER_AGENT,
  ymdOf,
} from './wikidata-films.js';

/**
 * Every music festival on Wikidata, for the `events` collection.
 *
 * musicbrainz-events carries dated editions; this is the festivals
 * themselves, the recurring thing a person follows from year to year.
 * Wikidata holds 7,488 items that are an instance of music festival
 * (Q868557) or one of its subclasses (measured 2026-09-25), CC0: 3,112 with
 * an official website, 5,857 with a country, 3,729 with a founding date,
 * 3,786 with a place, 952 with a genre, 631 with the MusicBrainz series id
 * that joins them to their editions in musicbrainz-events, and 162 marked
 * as having ended.
 *
 * The whole set is one query: grouped to one row per festival, it answered
 * in 29 s on 2026-09-25, inside the service's 60 s limit. It is asked weekly;
 * a failed ask is retried twice after a pause and a third failure throws,
 * which the core retries on its own schedule. Should the set outgrow the
 * limit, the id-window walk in wikidata-films is the way to split it.
 *
 * 689 festivals have no label in any language asked for and come back as
 * their bare Q id; they are skipped. The image is a Commons file, which
 * keeps its own licence, so the file name rides in `data` beside the CC0
 * credit for the rest.
 */

export const PROVIDER = 'wikidata';
export const ATTRIBUTION = 'Wikidata, CC0';

/** Music festival. */
export const ROOT = 'Q868557';

/** Festivals change slowly; a week keeps the set current. */
export const CADENCE_MINUTES = 10_080;

/** Label languages, English first, then those most festivals are named in. */
export const LABEL_LANGUAGES = 'en,mul,de,fr,es,it,nl,pl,sv,pt,ru,ja';

/** Asks per run before giving up. */
const ATTEMPTS = 3;

/** Pause between asks. */
export const PAUSE_MS = 5_000;

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/** The one query: every festival, one row each. */
export function buildQuery() {
  return [
    'SELECT ?item ?itemLabel ?itemDescription (SAMPLE(?web) AS ?website) (SAMPLE(?coord) AS ?coords)',
    '(MIN(?inception) AS ?founded) (SAMPLE(?dissolved) AS ?ended) (SAMPLE(?cc) AS ?countryCode)',
    '(SAMPLE(?image) AS ?imageFile) (SAMPLE(?mbs) AS ?mbSeries) (SAMPLE(?article) AS ?wikipedia)',
    '(GROUP_CONCAT(DISTINCT ?locLabel;separator="|") AS ?locations)',
    '(GROUP_CONCAT(DISTINCT ?genreLabel;separator="|") AS ?genres)',
    'WHERE {',
    `?item wdt:P31/wdt:P279* wd:${ROOT} .`,
    'OPTIONAL{?item wdt:P856 ?web} OPTIONAL{?item wdt:P625 ?coord} OPTIONAL{?item wdt:P571 ?inception}',
    'OPTIONAL{?item wdt:P576 ?dissolved} OPTIONAL{?item wdt:P17 ?country . ?country wdt:P297 ?cc}',
    'OPTIONAL{?item wdt:P18 ?image} OPTIONAL{?item wdt:P1407 ?mbs}',
    'OPTIONAL{?item wdt:P276 ?loc} OPTIONAL{?item wdt:P131 ?loc} OPTIONAL{?item wdt:P136 ?genre}',
    'OPTIONAL{?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/>}',
    `SERVICE wikibase:label { bd:serviceParam wikibase:language "${LABEL_LANGUAGES}".`,
    '?item rdfs:label ?itemLabel . ?item schema:description ?itemDescription .',
    '?loc rdfs:label ?locLabel . ?genre rdfs:label ?genreLabel . } }',
    'GROUP BY ?item ?itemLabel ?itemDescription',
  ].join(' ');
}

export const queryUrl = () => `${SPARQL}?query=${encodeURIComponent(buildQuery())}`;

const value = (row, key) => {
  const v = row?.[key]?.value;
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s || null;
};

/** `Point(5.89 51.96)` (longitude first) as `{ lat, long }`, or null. */
export function pointOf(wkt) {
  const m = String(wkt ?? '').match(
    /^Point\(\s*(-?[\d.]+(?:e-?\d+)?)\s+(-?[\d.]+(?:e-?\d+)?)\s*\)$/i,
  );
  if (!m) return null;
  const long = Number(m[1]);
  const lat = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(long) || Math.abs(lat) > 90 || Math.abs(long) > 180)
    return null;
  return { lat, long };
}

/** Only an http(s) url is a link. */
const link = (v) => (v && /^https?:\/\//i.test(v) ? v : null);

/** One SPARQL row as a festival item, or null for a row with no id or no real label. */
export function festivalItem(row) {
  const qid = qidOf(value(row, 'item'));
  const name = value(row, 'itemLabel');
  if (!qid || !name || isBareQid(name)) return null;
  const description = value(row, 'itemDescription');
  const cc = value(row, 'countryCode');
  const country = cc && /^[A-Z]{2}$/i.test(cc) ? cc.toUpperCase() : null;
  const founded = ymdOf(value(row, 'founded'));
  const ended = ymdOf(value(row, 'ended'));
  const when = looseDate(founded ?? '');
  const locations = splitList(value(row, 'locations')).filter((l) => !isBareQid(l));
  const genres = splitList(value(row, 'genres')).filter((g) => !isBareQid(g));
  const imageFile = fileOf(value(row, 'imageFile'));
  const website = link(value(row, 'website'));
  const mbSeries = value(row, 'mbSeries');
  return {
    externalId: `${PROVIDER}:festival:${qid}`,
    kind: 'festival',
    title: name,
    summary:
      [
        description && description.toLowerCase() !== 'music festival' ? description : null,
        locations.length ? `in ${locations.join(', ')}` : null,
        founded ? `since ${founded.slice(0, 4)}` : null,
        ended ? `(ended ${ended.slice(0, 4)})` : null,
      ]
        .filter(Boolean)
        .join(' ') || null,
    url: website ?? `https://www.wikidata.org/wiki/${qid}`,
    imageUrl: imageUrlFor(imageFile),
    publishedAt: when.publishedAt,
    timeKnown: false,
    precision: when.precision,
    tags: [
      'festival',
      PROVIDER,
      country ? `country:${country.toLowerCase()}` : null,
      ...genres.map((g) => `genre:${slugify(g)}`),
      ...locations.slice(0, 3).map((l) => `city:${slugify(l)}`),
      ended ? 'ended' : null,
      mbSeries ? 'musicbrainz' : null,
    ].filter((t) => t && !t.endsWith(':')),
    data: {
      wikidataId: qid,
      description,
      website,
      wikipedia: link(value(row, 'wikipedia')),
      country,
      locations,
      location: pointOf(value(row, 'coords')),
      genres,
      founded,
      ended,
      musicbrainzSeries: mbSeries,
      imageFile,
      attribution: ATTRIBUTION,
    },
  };
}

export const wikidataFestivals = defineAdapter({
  name: 'wikidata-festivals',
  title: 'Wikidata: every music festival',
  collection: 'events',
  description:
    'Every music festival on Wikidata, about 7,500: name, description, official website, English Wikipedia article, country, host city or venue and its coordinates, genres, founding year, whether it has ended, and the MusicBrainz series id that joins it to its dated editions. CC0 (images keep their Commons licence). One query to the SPARQL service, weekly.',
  docs: 'https://www.wikidata.org/wiki/Q868557',
  kinds: ['festival'],
  cadenceMinutes: CADENCE_MINUTES,
  defaultSources: [
    { slug: 'wikidata-festivals', name: 'Events: every music festival on Wikidata' },
  ],
  async *pull({ http, log }, { pauseMs = PAUSE_MS } = {}) {
    let rows = null;
    let lastError = null;
    for (let attempt = 0; attempt < ATTEMPTS && !rows; attempt++) {
      if (attempt > 0) await sleep(pauseMs);
      try {
        const res = await http.request(queryUrl(), {
          headers: { accept: 'application/sparql-results+json', 'user-agent': USER_AGENT },
          timeoutMs: TIMEOUT_MS,
        });
        if (!res.ok) throw new Error(`query.wikidata.org answered ${res.status}`);
        rows = parseBindings(await res.json());
      } catch (err) {
        lastError = err;
        log(`festivals query failed (${err?.message ?? err})`);
      }
    }
    if (!rows) {
      throw new Error(`wikidata-festivals: ${ATTEMPTS} asks failed (${lastError?.message ?? '?'})`);
    }
    const items = [];
    let skipped = 0;
    for (const row of rows) {
      const item = festivalItem(row);
      if (item) items.push(item);
      else skipped += 1;
    }
    if (items.length) yield { items };
    return {
      note: `${items.length} festivals, ${skipped} without a label`,
      nextInMinutes: CADENCE_MINUTES,
    };
  },
});
