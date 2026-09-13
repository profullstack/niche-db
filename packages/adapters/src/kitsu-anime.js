import { defineAdapter, looseDate, slugify, stripHtml } from '@nichedb/core/adapter';
import { normTitleOrNull } from './screen-titles.js';

/**
 * Every anime Kitsu knows, for the `screen` collection.
 *
 * anilist-airing carries the few hundred series with an episode coming; this
 * is the whole catalogue, 22,418 titles on 2026-09-13, from TV series to
 * three-minute music videos. Kitsu is keyless JSON:API: `/anime?sort=id` with
 * `page[limit]` (20 at most, whatever is asked) and `page[offset]`, `meta.count`
 * the exact total and `links.next` present while there is more. Past the end
 * the answer is 200 with an empty `data`, not a 404. Ids run to 51,000 with
 * gaps, so the walk is by offset, not by id.
 *
 * Kitsu publishes no licence for the data its API serves: not on the API page,
 * not in the terms, not in the response. So every row says so in
 * `data.attribution`, and the adapter description says so too, rather than
 * guessing at a Creative Commons that was never granted.
 *
 * At 20 a page the catalogue is 1,121 requests, and a run asks for
 * `requestCap` of them and stops; the cursor carries the next offset, the
 * next run picks it up ten minutes later, and once the offset reaches the
 * total the pass is done and the next run (a day later) starts over. A page
 * that fails is asked for again rather than skipped, since skipping a page
 * loses twenty titles; three failures in a row end the run with the place
 * kept.
 *
 * Rows follow anilist.js's titleItem so an anime here and the same anime in
 * the airing source line up on `data.category`, `data.form`, `data.normTitle`
 * and the shared id columns; Kitsu's own id is `data.kitsuId`.
 */

export const BASE = 'https://kitsu.io/api/edge';
const PROVIDER = 'kitsu';
const CATEGORY = 'anime';

/** Every row says where it came from and that Kitsu has stated no licence. */
export const ATTRIBUTION = 'Kitsu (kitsu.io); no licence stated';

/** Who is asking, on every request. */
export const USER_AGENT = 'nichedb (https://nichedb.dev; hello@nichedb.dev)';

/** Kitsu caps page[limit] at 20 for anime whatever is asked. */
export const PAGE_LIMIT = 20;

/** Pages per run by default: 150 pages is 3,000 anime, a full pass in eight runs. */
export const REQUEST_CAP = 150;

/** Consecutive failures after which a run stops asking, so an outage costs little. */
const FAILURE_STOP = 3;

/** Kitsu publishes no rate limit figure; two pages a second has never been refused, and a keyless source deserves the gap. */
export const PAUSE_MS = 500;

/** Kitsu's subtypes, lower-cased, as `subtype:` tags. */
export const SUBTYPES = new Set(['tv', 'movie', 'ova', 'ona', 'special', 'music']);

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

export const pageUrl = (offset, limit = PAGE_LIMIT) =>
  `${BASE}/anime?page%5Blimit%5D=${encodeURIComponent(String(limit))}&page%5Boffset%5D=${encodeURIComponent(String(offset))}&sort=id`;

const text = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
};

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** The title Kitsu shows, else the English, else the romanised Japanese, else any title at all. */
export function titleOf(attrs) {
  const titles = attrs?.titles && typeof attrs.titles === 'object' ? attrs.titles : {};
  return (
    text(attrs?.canonicalTitle) ??
    text(titles.en) ??
    text(titles.en_jp) ??
    Object.values(titles).map(text).find(Boolean) ??
    null
  );
}

/** A synopsis with its line breaks collapsed and cut to what a card can hold. */
export function summaryOf(synopsis, limit = 600) {
  const s = stripHtml(synopsis).replace(/\s+([.,;:!?])/g, '$1');
  if (!s) return null;
  return s.length > limit ? `${s.slice(0, limit - 1)}…` : s;
}

/** Kitsu's subtype as a lower-case slug, or null when it is not one of the six. */
export function subtypeOf(attrs) {
  const s = text(attrs?.subtype ?? attrs?.showType)?.toLowerCase() ?? null;
  return s && SUBTYPES.has(s) ? s : null;
}

/** The two forms the screen collection distinguishes: a film, or something episodic. */
export const formOf = (subtype) => (subtype === 'movie' ? 'movie' : 'series');

/** `R18` and `PG` as `rating:r18` and `rating:pg`. */
export const ratingSlug = (ageRating) => {
  const s = slugify(text(ageRating) ?? '');
  return s || null;
};

/** The rows on a page; anything that is not a JSON:API list is no rows. */
export function pageRows(body) {
  return Array.isArray(body?.data) ? body.data : [];
}

/** `meta.count`, the exact total, or null when the page does not carry one. */
export function totalOf(body) {
  const n = num(body?.meta?.count);
  return n !== null && n >= 0 ? Math.floor(n) : null;
}

/** One anime row as a `title` item, or null for a row with no id or no title. */
export function animeItem(row) {
  const id = text(row?.id);
  const a = row?.attributes;
  if (!id || !a || typeof a !== 'object') return null;
  const title = titleOf(a);
  if (!title) return null;
  const slug = text(a.slug);
  const subtype = subtypeOf(a);
  const rating = ratingSlug(a.ageRating);
  const when = looseDate(a.startDate ?? '');
  const poster = a.posterImage && typeof a.posterImage === 'object' ? a.posterImage : {};
  const cover = a.coverImage && typeof a.coverImage === 'object' ? a.coverImage : {};
  const averageRating = num(a.averageRating);
  const youtubeVideoId = text(a.youtubeVideoId);
  const titles = a.titles && typeof a.titles === 'object' ? { ...a.titles } : {};
  return {
    externalId: `${PROVIDER}:${CATEGORY}:${id}`,
    kind: 'title',
    title,
    summary: summaryOf(a.synopsis ?? a.description),
    url: `https://kitsu.io/anime/${encodeURIComponent(slug ?? id)}`,
    imageUrl: text(poster.original) ?? text(poster.large) ?? null,
    publishedAt: when.publishedAt,
    timeKnown: false,
    precision: when.precision,
    tags: [
      'title',
      CATEGORY,
      PROVIDER,
      subtype ? `subtype:${subtype}` : null,
      rating ? `rating:${rating}` : null,
    ].filter(Boolean),
    data: {
      provider: PROVIDER,
      category: CATEGORY,
      form: formOf(subtype),
      year: when.publishedAt ? Number(String(a.startDate).slice(0, 4)) : null,
      normTitle: normTitleOrNull(title),
      imdbId: null,
      tmdbId: null,
      tvmazeId: null,
      anilistId: null,
      kitsuId: id,
      slug,
      titles,
      abbreviatedTitles: Array.isArray(a.abbreviatedTitles)
        ? a.abbreviatedTitles.map(text).filter(Boolean)
        : [],
      synopsis: text(a.synopsis) ?? text(a.description),
      subtype,
      episodeCount: num(a.episodeCount),
      episodeLength: num(a.episodeLength),
      runtimeMin: num(a.episodeLength),
      status: text(a.status),
      startDate: text(a.startDate),
      endDate: text(a.endDate),
      ageRating: text(a.ageRating),
      ageRatingGuide: text(a.ageRatingGuide),
      averageRating,
      // Kitsu scores out of 100; every other source here is out of 10.
      rating: averageRating === null ? null : averageRating / 10,
      ratingCount: null,
      userCount: num(a.userCount),
      favoritesCount: num(a.favoritesCount),
      popularity: num(a.userCount),
      popularityRank: num(a.popularityRank),
      ratingRank: num(a.ratingRank),
      youtubeVideoId,
      trailerUrl: youtubeVideoId ? `https://www.youtube.com/watch?v=${youtubeVideoId}` : null,
      posterUrl: text(poster.original) ?? text(poster.large) ?? null,
      backdropUrl: text(cover.original) ?? text(cover.large) ?? null,
      nsfw: a.nsfw === true,
      genres: [],
      watch: [],
      attribution: ATTRIBUTION,
    },
  };
}

/** The items on a page; a row that is not an anime is skipped, never thrown on. */
export function pageItems(body) {
  return pageRows(body)
    .map((r) => animeItem(r))
    .filter(Boolean);
}

/**
 * Where a run starts. A finite `offset` in the cursor is a pass in progress
 * and the total it saw comes along; anything else is the start of a pass.
 */
export function resumeFrom(prev) {
  // A null offset is a finished pass (Number(null) is 0, which would look like a live one).
  if (prev?.offset === null || prev?.offset === undefined) return { offset: 0, total: null };
  const offset = Math.floor(Number(prev.offset));
  if (!Number.isFinite(offset) || offset < 0) return { offset: 0, total: null };
  const total = Math.floor(Number(prev?.total));
  return { offset, total: Number.isFinite(total) && total >= 0 ? total : null };
}

export const kitsuAnime = defineAdapter({
  name: 'kitsu-anime',
  title: 'Kitsu: every anime',
  collection: 'screen',
  description:
    'Every anime on Kitsu, about 22,000, one title row each with its canonical, English and Japanese titles, synopsis, poster, subtype (TV, movie, OVA, ONA, special, music), age rating and guide, episode count and length, status, start and end dates, average rating, user and favourite counts, popularity and rating ranks and the YouTube trailer id. Keyless JSON:API, twenty a page; a run reads a fixed number of pages and resumes, and once the offset reaches the total the next run starts over. Kitsu states no licence for this data, so every row carries the attribution "Kitsu (kitsu.io); no licence stated" and nothing more is claimed.',
  docs: 'https://kitsu.docs.apiary.io/',
  kinds: ['title'],
  cadenceMinutes: 1440,
  configFields: [
    {
      key: 'requestCap',
      label: 'Pages per run',
      type: 'number',
      placeholder: String(REQUEST_CAP),
      help: 'Twenty anime a page. The walk stops here and picks up ten minutes later; 150 a run is a full pass in about eight runs.',
    },
    {
      key: 'pauseMs',
      label: 'Pause between pages (ms)',
      type: 'number',
      placeholder: String(PAUSE_MS),
      help: 'Kitsu publishes no rate limit figure; half a second between pages has never been refused.',
    },
  ],
  defaults: { requestCap: REQUEST_CAP, pauseMs: PAUSE_MS },
  defaultSources: [
    {
      slug: 'kitsu-anime',
      name: 'Screen: every anime on Kitsu',
      config: { requestCap: REQUEST_CAP, pauseMs: PAUSE_MS },
    },
  ],
  async pull({ config, cursor: prev, http, log, deadline }) {
    const cap = Math.max(1, Math.floor(Number(config?.requestCap)) || REQUEST_CAP);
    const pause =
      config?.pauseMs === 0 ? 0 : Math.max(0, Math.floor(Number(config?.pauseMs))) || PAUSE_MS;
    const stopAt = Number.isFinite(deadline) ? deadline : Number.POSITIVE_INFINITY;
    const state = resumeFrom(prev);
    const startedAt = state.offset;
    let offset = state.offset;
    let total = state.total;
    let requests = 0;
    let failures = 0;
    let streak = 0;
    let stopped = null;
    let done = false;
    const items = [];

    for (;;) {
      if (total !== null && offset >= total) {
        done = true;
        break;
      }
      if (requests >= cap) {
        stopped = 'cap';
        break;
      }
      if (Date.now() > stopAt) {
        stopped = 'deadline';
        break;
      }
      if (requests > 0) await sleep(pause);
      requests += 1;
      let body = null;
      try {
        const res = await http.request(pageUrl(offset), {
          headers: { accept: 'application/vnd.api+json', 'user-agent': USER_AGENT },
          timeoutMs: 20_000,
        });
        if (!res.ok) throw new Error(`kitsu answered ${res.status}`);
        body = await res.json();
        streak = 0;
      } catch (err) {
        failures += 1;
        streak += 1;
        log(`page at offset ${offset} unavailable (${err?.message ?? err})`);
        if (streak >= FAILURE_STOP) {
          stopped = 'errors';
          break;
        }
        // The same offset is asked for again: skipping a page loses twenty titles.
        continue;
      }
      const rows = pageRows(body);
      const count = totalOf(body);
      if (count !== null) total = count;
      items.push(...pageItems(body));
      if (!rows.length || !body?.links?.next) {
        done = true;
        break;
      }
      // links.next is always offset plus limit, so the walk advances by the limit, not by rows served.
      offset += PAGE_LIMIT;
    }

    if (requests > 0 && failures === requests) {
      throw new Error(`kitsu: every request failed (${requests} of ${requests}); see the log`);
    }

    const reason =
      stopped === 'cap'
        ? 'at the page cap'
        : stopped === 'deadline'
          ? 'on the run deadline'
          : stopped === 'errors'
            ? 'after repeated failures'
            : null;

    return {
      items,
      cursor: {
        offset: done ? null : offset,
        total,
        walkedAt: done ? new Date().toISOString() : (prev?.walkedAt ?? null),
      },
      nextInMinutes: done ? undefined : 10,
      note:
        `${items.length} anime from ${requests - failures} pages (offsets ${startedAt} to ${offset}` +
        `${total !== null ? ` of ${total}` : ''})` +
        (failures ? `, ${failures} failed` : '') +
        (done
          ? '; the catalogue is walked, next run starts over'
          : `; stopped ${reason} at offset ${offset}, resuming in 10 min`),
    };
  },
});
