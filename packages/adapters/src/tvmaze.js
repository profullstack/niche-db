import { defineAdapter, looseDate, slugify, stripHtml } from '@nichedb/core/adapter';
import { normTitleOrNull } from './screen-titles.js';

/**
 * Television, from TVmaze. Ported from genrewatch's catalogue poller.
 *
 * Keyless, and unusually well shaped for this job: `/schedule/full` returns every
 * episode TVmaze knows is coming, in ONE request, with the show embedded in each
 * entry. Roughly 6,500 rows and 12 MB, so the whole TV calendar costs a single
 * upstream call.
 *
 * Shows become `title` items (form series) and episodes become `release` items
 * with `type:episode`. A show TVmaze tags as anime is filed under the anime
 * category, where AniList describes it better; a sports strand is dropped, since
 * fixtures belong to the sports collection.
 */

const BASE = 'https://api.tvmaze.com';
const PROVIDER = 'tvmaze';
const CATEGORY = 'tv';

/** Genres TVmaze uses that belong to another category here. */
const REROUTED = new Map([
  ['sports', null],
  ['anime', 'anime'],
]);

/** Strip TVmaze's HTML summaries down to something a card can hold. */
export function plain(html, limit = 400) {
  const text = stripHtml(html).replace(/\s+([.,;:!?])/g, '$1');
  if (!text) return null;
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/**
 * Where an episode can be watched. `network` is broadcast and `webChannel` is
 * streaming; a show has one or the other and occasionally both, in which case
 * the network is the one a reader recognises.
 */
export function venueOf(show) {
  const src = show?.network ?? show?.webChannel ?? null;
  if (!src) return { venue: null, venueRegion: null };
  return {
    venue: src.name ?? null,
    venueRegion: src.country?.name ?? (show?.webChannel ? 'Streaming' : null),
  };
}

/** TVmaze's episode type, with premieres promoted because readers care most. */
export function kindOf(ep) {
  if (ep.type === 'significant_special' || ep.type === 'insignificant_special') return 'special';
  if (ep.number === 1) return ep.season === 1 ? 'premiere' : 'season-premiere';
  return 'episode';
}

/**
 * Which category a show belongs in, and its genres with the rerouting tags
 * removed. `category` is null when the show should be dropped.
 */
export function classify(show) {
  let category = CATEGORY;
  const genres = [];
  for (const g of show?.genres ?? []) {
    const lower = String(g).toLowerCase();
    if (REROUTED.has(lower)) {
      const target = REROUTED.get(lower);
      if (target === null) return { category: null, genres: [] };
      category = target;
      continue;
    }
    genres.push(g);
  }
  return { category, genres };
}

const genreTags = (names) => names.map((n) => `genre:${slugify(n)}`);

/** A show as a `title` item, or null when it is rerouted away. */
export function titleItem(show) {
  if (!show?.id || !show.name) return null;
  const { category, genres } = classify(show);
  if (!category) return null;
  const id = String(show.id);
  const when = looseDate(show.premiered ?? '');
  const { venue, venueRegion } = venueOf(show);
  const rating = Number.isFinite(show.rating?.average) ? Number(show.rating.average) : null;
  return {
    externalId: `${PROVIDER}:title:${id}`,
    kind: 'title',
    title: show.name,
    summary: plain(show.summary),
    url: show.url ?? `https://www.tvmaze.com/shows/${id}`,
    imageUrl: show.image?.original ?? show.image?.medium ?? null,
    publishedAt: when.publishedAt,
    timeKnown: false,
    precision: when.precision,
    tags: ['title', category, PROVIDER, ...genreTags(genres)],
    data: {
      provider: PROVIDER,
      category,
      form: 'series',
      year: when.publishedAt ? Number(String(show.premiered).slice(0, 4)) : null,
      normTitle: normTitleOrNull(show.name),
      imdbId: show.externals?.imdb ?? null,
      tmdbId: null,
      tvmazeId: id,
      anilistId: null,
      thetvdbId: show.externals?.thetvdb != null ? String(show.externals.thetvdb) : null,
      genres,
      rating,
      ratingCount: null,
      popularity: Number.isFinite(show.weight) ? Number(show.weight) : null,
      backdropUrl: null,
      tagline: null,
      trailerUrl: null,
      runtimeMin: show.averageRuntime ?? show.runtime ?? null,
      watch: show.webChannel?.name ? [show.webChannel.name] : [],
      network: venue,
      networkRegion: venueRegion,
      language: show.language ?? null,
      status: show.status ?? null,
      type: show.type ?? null,
      premiered: show.premiered ?? null,
      ended: show.ended ?? null,
      officialSite: show.officialSite ?? null,
      schedule: show.schedule ?? null,
    },
  };
}

/**
 * An episode as a `release` item, or null when its show is rerouted away or it
 * has no air time at all.
 *
 * An empty `airtime` is TVmaze saying it does not know the slot; `airstamp` is
 * still populated then, padded to midnight in the network's timezone. So the
 * row is stored at day precision with `timeKnown` false rather than "airs at
 * 4am".
 */
export function releaseItem(ep, show = ep?._embedded?.show ?? ep?.show) {
  if (!ep?.id || !show?.id || !ep.airstamp) return null;
  const { category, genres } = classify(show);
  if (!category) return null;
  const startsAt = new Date(ep.airstamp);
  if (Number.isNaN(startsAt.getTime())) return null;
  const timeKnown = Boolean(ep.airtime);
  const { venue, venueRegion } = venueOf(show);
  const number = String(ep.number ?? 0).padStart(2, '0');
  const name = `${show.name} ${ep.season ?? '?'}x${number}${ep.name ? ` — ${ep.name}` : ''}`;
  const showImage = show.image?.original ?? show.image?.medium ?? null;
  return {
    externalId: `${PROVIDER}:episode:${ep.id}`,
    kind: 'release',
    title: name,
    summary: plain(ep.summary) ?? plain(show.summary),
    url: ep.url ?? `https://www.tvmaze.com/episodes/${ep.id}`,
    imageUrl: ep.image?.medium ?? showImage,
    publishedAt: startsAt,
    timeKnown,
    precision: timeKnown ? 'minute' : 'day',
    tags: ['release', category, PROVIDER, ...genreTags(genres), 'type:episode'],
    data: {
      provider: PROVIDER,
      category,
      type: 'episode',
      titleExternalId: `${PROVIDER}:title:${show.id}`,
      titleName: show.name,
      season: ep.season ?? null,
      number: ep.number ?? null,
      venue,
      venueRegion,
      runtimeMin: ep.runtime ?? show.averageRuntime ?? null,
      episodeName: ep.name || null,
      episodeType: kindOf(ep),
      airdate: ep.airdate ?? null,
      airtime: ep.airtime || null,
      // The episode still is landscape, so it is the wide image here.
      backdropUrl: ep.image?.original ?? null,
      posterUrl: showImage,
      rating: Number.isFinite(show.rating?.average) ? Number(show.rating.average) : null,
      language: show.language ?? null,
      status: show.status ?? null,
    },
  };
}

/**
 * Titles and releases from a `/schedule/full` payload, bounded at both ends.
 *
 * The feed is not forward-only: it reaches several days into the past for shows
 * that have just aired. A day of grace keeps something that aired this morning
 * without turning the calendar into an archive.
 */
export function buildItems(rows, { from = new Date(), horizonDays = 120 } = {}) {
  const cutoff = new Date(from.getTime() + horizonDays * 86_400_000);
  const floor = new Date(from.getTime() - 86_400_000);
  const titles = new Map();
  const releases = [];
  for (const ep of Array.isArray(rows) ? rows : []) {
    const show = ep?._embedded?.show ?? ep?.show;
    const release = releaseItem(ep, show);
    if (!release) continue;
    if (release.publishedAt < floor || release.publishedAt > cutoff) continue;
    releases.push(release);
    if (!titles.has(show.id)) {
      const t = titleItem(show);
      if (t) titles.set(show.id, t);
    }
  }
  return { titles: [...titles.values()], releases };
}

export const tvmazeSchedule = defineAdapter({
  name: 'tvmaze-schedule',
  title: 'TVmaze schedule',
  collection: 'screen',
  description:
    'Every upcoming television episode TVmaze knows about, with its show: air time, season and episode number, network or streaming service, genres, artwork and IMDb id. One request for the whole calendar. Keyless.',
  docs: 'https://www.tvmaze.com/api',
  kinds: ['title', 'release'],
  cadenceMinutes: 180,
  configFields: [{ key: 'horizonDays', label: 'Days ahead', type: 'number', placeholder: '120' }],
  defaults: { horizonDays: 120 },
  defaultSources: [{ slug: 'tvmaze-schedule', name: 'TVmaze: TV schedule' }],
  async pull({ config, http, log }) {
    const horizonDays = Math.max(1, Number(config.horizonDays) || 120);
    const rows = await http.json(`${BASE}/schedule/full`, { timeoutMs: 120_000 });
    const { titles, releases } = buildItems(rows, { horizonDays });
    log(`${titles.length} shows, ${releases.length} episodes in the next ${horizonDays} days`);
    return {
      items: [...titles, ...releases],
      note: `${titles.length} shows, ${releases.length} episodes`,
    };
  },
});
