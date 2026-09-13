import { defineAdapter, looseDate, slugify } from '@nichedb/core/adapter';

import { normTitleOrNull } from './screen-titles.js';

/**
 * Every series TheTVDB knows, for the `screen` collection.
 *
 * TheTVDB is the id the rest of the screen collection already speaks: TVmaze
 * rows carry `data.thetvdbId`, Kodi, Plex, Sonarr and the *arr family key on
 * it, and its catalogue is roughly twice TVmaze's at 173,000 series. The API
 * (v4) is keyed and free below $50k a year of revenue, on one condition its
 * terms spell out: "Attribution with a direct link to TheTVDB.com must be
 * displayed to end users", so every row here carries `data.attribution` and
 * `data.attributionUrl` for the page to print. The key never reaches a log,
 * an item, a note or an error.
 *
 * The walk is `/series?page=N`, 500 a page in id order, which is about 350
 * requests for the lot; the end is a page with empty `data` and a null
 * `links.next` (not a 404). A run is capped at a handful of pages so a single
 * run never holds the queue, and resumes from the cursor.
 *
 * Once a pass is complete the source does not walk again. It lists
 * `/updates?since=<epoch>&type=series` (500 a page, ascending by time, with
 * repeats: 1,874 rows for one day when this was written), keeps the created
 * and updated ids, and re-reads them one by one from
 * `/series/<id>/extended?short=true`: the same one request as the base
 * record, but the extended row is the only one carrying genres (which is what
 * decides tv against anime), the IMDb and TMDB ids and the network. A list
 * row has none of those, so a series is at its richest after its first
 * refresh. Ids are carried between runs as `pending` when the cap stops a run.
 *
 * The first delta listing starts from when the walk BEGAN (`startedAt` in the
 * cursor), not when it ended: a walk is many runs over a few hours, and a
 * series changed after its page was read would otherwise wait for its next
 * change. The listing is inclusive of `since` and dedupes, so nothing is lost.
 *
 * Login is `POST /login {apikey}`, answered with a JWT good for about a month;
 * the token and its expiry ride in the cursor, the way igdb.js keeps its
 * Twitch token, and are renewed within a day of expiry or on a 401.
 */

export const BASE = 'https://api4.thetvdb.com/v4';
export const ARTWORK_BASE = 'https://artworks.thetvdb.com';
const PROVIDER = 'thetvdb';

/** Pages per run on the first pass: 20 pages is 10,000 series, about 25 seconds. */
export const PAGES_PER_RUN = 20;

/** Series fetches per run on the delta path. */
export const REFRESH_PER_RUN = 200;

/** Update-listing pages read in one run: 50 pages is 25,000 change rows, well over a week. */
export const LIST_PAGES_MAX = 50;

/** v4 publishes no hard rate limit; a quarter second between calls is being gentle. */
export const PAUSE_MS = 250;

/** Consecutive failures after which a run stops asking, so an outage costs little. */
const FAILURE_STOP = 3;

/** Renew a token this close to its expiry rather than let a run die mid-walk. */
const TOKEN_MARGIN_MS = 86_400_000;

/** When the JWT carries no readable `exp`, assume the documented month, less a margin. */
const TOKEN_LIFETIME_MS = 29 * 86_400_000;

export const ATTRIBUTION = 'Metadata provided by TheTVDB.com';
export const ATTRIBUTION_URL = 'https://thetvdb.com';

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

export const loginUrl = () => `${BASE}/login`;
export const pageUrl = (page) => `${BASE}/series?page=${encodeURIComponent(String(page))}`;
export const seriesUrl = (id) =>
  `${BASE}/series/${encodeURIComponent(String(id))}/extended?short=true`;
export const updatesUrl = (sinceEpoch, page = 0) =>
  `${BASE}/updates?since=${encodeURIComponent(String(sinceEpoch))}&type=series&page=${encodeURIComponent(String(page))}`;

/** A message with the secrets taken out, so a failed request cannot leak the key or the token. */
export function redact(message, ...secrets) {
  let text = String(message ?? '');
  for (const s of secrets) {
    if (!s || typeof s !== 'string' || s.length < 8) continue;
    text = text.split(s).join('[secret]').split(encodeURIComponent(s)).join('[secret]');
  }
  return text;
}

/** When a login token expires, in ms since the epoch, from its JWT `exp` claim. */
export function tokenExpiry(token, now = Date.now()) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString());
    const exp = Number(payload?.exp);
    if (Number.isFinite(exp) && exp > 0) return exp * 1000;
  } catch {
    // not a JWT we can read; fall through to the documented lifetime
  }
  return now + TOKEN_LIFETIME_MS;
}

/** Artwork paths come relative (`/banners/...`) on list rows and absolute on detail rows. */
export function imageUrl(image) {
  const s = String(image ?? '').trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  return `${ARTWORK_BASE}${s.startsWith('/') ? '' : '/'}${s}`;
}

/** An overview cut to what a card can hold, whitespace collapsed. */
export function summaryOf(overview, limit = 600) {
  const text = String(overview ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

const remoteId = (row, sourceName) => {
  const hit = (row?.remoteIds ?? []).find(
    (r) => String(r?.sourceName ?? '').toLowerCase() === sourceName && r?.id,
  );
  return hit ? String(hit.id) : null;
};

/** A series row (list or extended) as a `title` item, or null when it cannot be one. */
export function titleItem(row) {
  if (!row?.id || !row.name) return null;
  const id = String(row.id);
  const genres = (row.genres ?? [])
    .map((g) => (typeof g === 'string' ? g : g?.name))
    .filter(Boolean);
  const category = genres.some((g) => String(g).toLowerCase() === 'anime') ? 'anime' : 'tv';
  const firstAired = row.firstAired || null;
  const when = looseDate(firstAired ?? '');
  const year =
    Number(row.year) || (when.publishedAt ? Number(String(firstAired).slice(0, 4)) : null);
  const statusName = row.status?.name || null;
  const country = row.originalCountry || null;
  const lang = row.originalLanguage || null;
  const network = row.originalNetwork?.name ?? row.latestNetwork?.name ?? null;
  const companies = (row.companies ?? []).map((c) => c?.name).filter(Boolean);
  const imdbId = remoteId(row, 'imdb');
  const tags = ['title', category, PROVIDER];
  if (statusName) tags.push(`status:${slugify(statusName)}`);
  if (country) tags.push(`country:${slugify(country)}`);
  if (lang) tags.push(`lang:${slugify(lang)}`);
  for (const g of genres) tags.push(`genre:${slugify(g)}`);
  return {
    externalId: `${PROVIDER}:series:${id}`,
    kind: 'title',
    title: row.name,
    summary: summaryOf(row.overview),
    url: row.slug
      ? `https://thetvdb.com/series/${row.slug}`
      : `https://thetvdb.com/dereferrer/series/${id}`,
    imageUrl: imageUrl(row.image),
    publishedAt: when.publishedAt,
    timeKnown: false,
    precision: when.precision,
    tags,
    data: {
      provider: PROVIDER,
      category,
      form: 'series',
      thetvdbId: id,
      slug: row.slug ?? null,
      year: Number.isFinite(year) && year > 0 ? year : null,
      normTitle: normTitleOrNull(row.name),
      originalCountry: country,
      originalLanguage: lang,
      status: statusName,
      firstAired,
      lastAired: row.lastAired || null,
      nextAired: row.nextAired || null,
      score: Number.isFinite(row.score) ? Number(row.score) : null,
      averageRuntime: Number.isFinite(row.averageRuntime) ? Number(row.averageRuntime) : null,
      aliases: (row.aliases ?? [])
        .map((a) => (typeof a === 'string' ? a : a?.name))
        .filter(Boolean),
      genres,
      network,
      companies,
      imdbId,
      tmdbId: remoteId(row, 'themoviedb.com'),
      attribution: ATTRIBUTION,
      attributionUrl: ATTRIBUTION_URL,
    },
  };
}

/** The series on a `/series` page as items. */
export function pageItems(body) {
  const rows = body?.data;
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => titleItem(r)).filter(Boolean);
}

/** True when a `/series` page is the end of the catalogue. */
export function lastPage(body) {
  const rows = Array.isArray(body?.data) ? body.data : [];
  return rows.length === 0 || body?.links?.next == null;
}

/**
 * The ids an `/updates` page says were created or updated, deduplicated and
 * ascending by id, plus the newest `timeStamp` on the page so a capped listing
 * knows where to resume. A deleted series is dropped: there is nothing to fetch.
 */
export function updatedIds(body) {
  const rows = Array.isArray(body?.data) ? body.data : [];
  const ids = new Set();
  let lastTs = 0;
  for (const r of rows) {
    const id = Number(r?.recordId);
    const ts = Number(r?.timeStamp);
    if (Number.isFinite(ts) && ts > lastTs) lastTs = ts;
    if (!Number.isInteger(id) || id <= 0) continue;
    if (r?.entityType && r.entityType !== 'series') continue;
    if (r?.method === 'delete') continue;
    ids.add(id);
  }
  return { ids: [...ids].sort((a, b) => a - b), lastTs, next: body?.links?.next ?? null };
}

/** Where a run starts. `walkedAt` set means the pass is done and the delta path applies. */
export function resumeFrom(prev) {
  const page = Math.floor(Number(prev?.page));
  const startedAt = typeof prev?.startedAt === 'string' ? prev.startedAt : null;
  const walkedAt = typeof prev?.walkedAt === 'string' ? prev.walkedAt : null;
  const refreshedAt = typeof prev?.refreshedAt === 'string' ? prev.refreshedAt : walkedAt;
  const listedAt = typeof prev?.listedAt === 'string' ? prev.listedAt : null;
  const pending = Array.isArray(prev?.pending)
    ? [...new Set(prev.pending.filter((n) => Number.isInteger(n) && n > 0))]
    : [];
  const token = typeof prev?.token === 'string' && prev.token ? prev.token : null;
  const tokenExpires = Number(prev?.tokenExpires) || 0;
  return {
    page: page >= 0 ? page : 0,
    startedAt,
    walkedAt,
    refreshedAt,
    listedAt,
    pending,
    token,
    tokenExpires,
  };
}

const stoppedWhy = (stopped) =>
  stopped === 'cap'
    ? 'at the cap'
    : stopped === 'deadline'
      ? 'on the run deadline'
      : 'after repeated failures';

export const thetvdbCatalog = defineAdapter({
  name: 'thetvdb-catalog',
  title: 'TheTVDB: every series',
  collection: 'screen',
  description:
    'Every series TheTVDB knows, about 173,000, as title rows in the screen shape: name, overview, poster, first and last air dates, status, country and language of origin, runtime, aliases, and after a refresh the genres, network and IMDb id. Needs THETVDB_API_KEY (free below $50k a year of revenue). TheTVDB\'s terms require attribution with a direct link to TheTVDB.com shown to end users, so every row carries data.attribution ("Metadata provided by TheTVDB.com") and data.attributionUrl for the page to print. Walks /series 500 a page once, then keeps current from /updates, re-reading only the series that changed. Clear the cursor to re-walk.',
  docs: 'https://thetvdb.github.io/v4-api/',
  kinds: ['title'],
  cadenceMinutes: 720,
  needsEnv: ['thetvdbApiKey'],
  configFields: [
    {
      key: 'pagesPerRun',
      label: 'Pages per run (first pass)',
      type: 'number',
      placeholder: String(PAGES_PER_RUN),
      help: '500 series a page. The walk stops here and picks up ten minutes later.',
    },
    {
      key: 'refreshPerRun',
      label: 'Series fetches per run (updates)',
      type: 'number',
      placeholder: String(REFRESH_PER_RUN),
      help: 'After the first pass, how many changed series to re-read in one run.',
    },
    {
      key: 'pauseMs',
      label: 'Pause between requests (ms)',
      type: 'number',
      placeholder: String(PAUSE_MS),
      help: 'TheTVDB publishes no hard limit; be gentle.',
    },
  ],
  defaults: { pagesPerRun: PAGES_PER_RUN, refreshPerRun: REFRESH_PER_RUN, pauseMs: PAUSE_MS },
  defaultSources: [
    {
      slug: 'thetvdb-catalog',
      name: 'Screen: every series on TheTVDB',
      config: { pagesPerRun: PAGES_PER_RUN, refreshPerRun: REFRESH_PER_RUN, pauseMs: PAUSE_MS },
    },
  ],
  async pull({ config, cursor: prev, env, http, log, deadline }) {
    const key = String(env?.thetvdbApiKey ?? env?.THETVDB_API_KEY ?? '').trim();
    if (!key) throw new Error('THETVDB_API_KEY is not set');
    const pagesCap = Math.max(1, Math.floor(Number(config?.pagesPerRun)) || PAGES_PER_RUN);
    const refreshCap = Math.max(1, Math.floor(Number(config?.refreshPerRun)) || REFRESH_PER_RUN);
    const pause =
      config?.pauseMs === 0 ? 0 : Math.max(0, Math.floor(Number(config?.pauseMs))) || PAUSE_MS;
    const stopAt = Number.isFinite(deadline) ? deadline : Number.POSITIVE_INFINITY;
    const state = resumeFrom(prev);
    const now = new Date();
    const items = [];
    let requests = 0;
    let failures = 0;
    let streak = 0;
    let logins = 0;

    /** Everything that leaves this adapter as text goes through here. */
    const clean = (msg) => redact(msg?.message ?? msg, key, state.token);
    const fail = (msg) => new Error(`thetvdb: ${clean(msg)}`);
    /** A login failure ends the run: nothing after it can succeed, and a bad key must not be retried. */
    const fatal = (msg) => Object.assign(fail(msg), { fatal: true });

    const throttle = async () => {
      if (requests + logins > 0) await sleep(pause);
    };

    /** The bearer token, renewed within a day of expiry, or now when forced by a 401. */
    const token = async (force = false) => {
      if (!force && state.token && state.tokenExpires - Date.now() > TOKEN_MARGIN_MS)
        return state.token;
      await throttle();
      logins += 1;
      let res;
      try {
        res = await http.request(loginUrl(), {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ apikey: key }),
          timeoutMs: 20_000,
        });
      } catch (err) {
        throw fatal(`login failed (${clean(err)})`);
      }
      if (res.status === 401 || res.status === 403)
        throw fatal(`login refused (${res.status}); check THETVDB_API_KEY`);
      if (!res.ok) throw fatal(`login answered ${res.status}`);
      const body = await res.json().catch(() => null);
      const fresh = body?.data?.token;
      if (typeof fresh !== 'string' || !fresh) throw fatal('login returned no token');
      state.token = fresh;
      state.tokenExpires = tokenExpiry(fresh);
      return fresh;
    };

    const bearer = (url, t) =>
      http.request(url, {
        headers: { authorization: `Bearer ${t}`, accept: 'application/json' },
        timeoutMs: 20_000,
      });

    const get = async (url) => {
      const t = await token();
      await throttle();
      requests += 1;
      let res = await bearer(url, t);
      if (res.status === 401) {
        // The token was revoked or expired early; one fresh login, one retry.
        const renewed = await token(true);
        await throttle();
        res = await bearer(url, renewed);
      }
      if (res.status === 404) return { notFound: true };
      if (!res.ok) throw new Error(`answered ${res.status}`);
      return { body: await res.json() };
    };

    const tokenCursor = () => ({ token: state.token, tokenExpires: state.tokenExpires });

    // A stale or missing token is renewed up front, so a bad key fails the run here and once.
    await token();

    // ── First pass: page walk ──────────────────────────────────────────────
    if (!state.walkedAt) {
      const startedAt = state.startedAt ?? now.toISOString();
      let page = state.page;
      let pages = 0;
      let done = false;
      let stopped = null;
      while (pages < pagesCap) {
        if (Date.now() > stopAt) {
          stopped = 'deadline';
          break;
        }
        try {
          const got = await get(pageUrl(page));
          streak = 0;
          if (got.notFound) {
            done = true;
            break;
          }
          items.push(...pageItems(got.body));
          pages += 1;
          page += 1;
          if (lastPage(got.body)) {
            done = true;
            break;
          }
        } catch (err) {
          if (err?.fatal) throw err;
          failures += 1;
          streak += 1;
          log(`page ${page} unavailable (${clean(err)})`);
          if (streak >= FAILURE_STOP) {
            stopped = 'errors';
            break;
          }
        }
      }
      if (requests > 0 && failures === requests)
        throw fail(`every request failed (${requests}); see the log`);
      if (!done && !stopped) stopped = 'cap';
      return {
        items,
        cursor: done
          ? {
              ...tokenCursor(),
              page: null,
              startedAt,
              walkedAt: now.toISOString(),
              refreshedAt: startedAt,
              listedAt: null,
              pending: [],
            }
          : {
              ...tokenCursor(),
              page,
              startedAt,
              walkedAt: null,
              refreshedAt: null,
              listedAt: null,
              pending: [],
            },
        nextInMinutes: done ? undefined : 10,
        note:
          `${items.length} series from ${pages} pages (from page ${state.page})` +
          (failures ? `, ${failures} failed` : '') +
          (done
            ? '; the catalogue is walked, updates from here on'
            : `; stopped ${stoppedWhy(stopped)} at page ${page}, resuming in 10 min`),
      };
    }

    // ── Delta path: what changed since the last refresh ─────────────────────
    let pending = state.pending;
    let listedAt = state.listedAt;
    let listed = false;
    let listPages = 0;
    if (!pending.length) {
      const since = new Date(state.refreshedAt ?? state.walkedAt);
      const sinceEpoch = Math.floor(since.getTime() / 1000);
      const ids = new Set();
      let page = 0;
      let lastTs = 0;
      let more = true;
      try {
        while (more && listPages < LIST_PAGES_MAX) {
          if (Date.now() > stopAt) break;
          const got = await get(updatesUrl(sinceEpoch, page));
          listPages += 1;
          if (got.notFound) break;
          const parsed = updatedIds(got.body);
          for (const id of parsed.ids) ids.add(id);
          if (parsed.lastTs > lastTs) lastTs = parsed.lastTs;
          more = parsed.next != null && (got.body?.data?.length ?? 0) > 0;
          page += 1;
        }
      } catch (err) {
        if (err?.fatal) throw err;
        failures += 1;
        log(`updates unavailable (${clean(err)})`);
        throw fail(`could not list updates (${clean(err)})`);
      }
      pending = [...ids].sort((a, b) => a - b);
      listed = true;
      // A complete listing moves the mark to now; a cut-off one only as far as it
      // read, and one that read nothing (the deadline came first) not at all.
      listedAt = !more
        ? now.toISOString()
        : lastTs
          ? new Date(lastTs * 1000).toISOString()
          : (state.refreshedAt ?? state.walkedAt);
      if (more)
        log(`updates listing cut off after ${listPages} pages; resuming from the last row's time`);
    }
    const total = pending.length;
    let fetched = 0;
    let stopped = null;
    while (pending.length && fetched < refreshCap) {
      if (Date.now() > stopAt) {
        stopped = 'deadline';
        break;
      }
      const id = pending[0];
      try {
        const got = await get(seriesUrl(id));
        streak = 0;
        fetched += 1;
        pending = pending.slice(1);
        if (got.notFound) continue;
        const item = titleItem(got.body?.data);
        if (item) items.push(item);
      } catch (err) {
        if (err?.fatal) throw err;
        failures += 1;
        streak += 1;
        log(`series ${id} unavailable (${clean(err)})`);
        if (streak >= FAILURE_STOP) {
          stopped = 'errors';
          break;
        }
        pending = pending.slice(1);
      }
    }
    if (requests > 0 && failures === requests)
      throw fail(`every request failed (${requests}); see the log`);
    const caughtUp = pending.length === 0;
    if (!caughtUp && !stopped) stopped = 'cap';
    return {
      items,
      cursor: {
        ...tokenCursor(),
        page: null,
        startedAt: state.startedAt,
        walkedAt: state.walkedAt,
        refreshedAt: caughtUp
          ? (listedAt ?? now.toISOString())
          : (state.refreshedAt ?? state.walkedAt),
        listedAt: caughtUp ? null : listedAt,
        pending: caughtUp ? [] : pending,
      },
      nextInMinutes: caughtUp ? undefined : 10,
      note:
        `${items.length} series refreshed of ${total} changed${listed ? ` (${listPages} listing pages)` : ' still pending'}` +
        (failures ? `, ${failures} failed` : '') +
        (caughtUp
          ? '; caught up'
          : `; ${pending.length} to go, stopped ${stoppedWhy(stopped)}, resuming in 10 min`),
    };
  },
});
