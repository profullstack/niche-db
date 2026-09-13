import { defineAdapter } from '@nichedb/core/adapter';

import { titleItem } from './tvmaze.js';

/**
 * Every show TVmaze knows, for the `screen` collection.
 *
 * tvmaze-schedule carries the ~6,500 shows with an episode coming; this is
 * the other 84,000. TVmaze is the one screen catalogue a public directory can
 * carry whole: keyless, CC BY-SA with a credit ("data can freely be used for
 * any purpose, as long as TVmaze is properly credited", tvmaze.com/api), and
 * `/shows?page=N` hands back 250 shows a page in id order, 404 past the end.
 * Nearly 90,000 shows is 378 requests, which is nothing; the walk here is
 * capped per run only so a single run never holds the queue for long.
 *
 * Once a pass is complete the source does not walk again. It asks
 * `/updates/shows?since=week` (one request: show id -> last-updated epoch),
 * keeps the ids updated after the last pass or refresh, and fetches those
 * shows one by one, capped per run. A new show has a new id and appears in
 * the same list, so the delta path covers additions too. A full re-walk
 * happens only when the cursor is cleared.
 *
 * Rows are built by tvmaze.js's titleItem, so a show here and the same show
 * in the schedule source are the same shape and the same external id; the
 * screen collection does not dedupe by URL, so the two sources overlap on the
 * airing shows and a reader wanting the whole catalogue reads this source.
 */

export const BASE = 'https://api.tvmaze.com';

/** Pages per run on the first pass: 40 pages is 10,000 shows in about 20 seconds at TVmaze's 20 per 10 s. */
export const PAGES_PER_RUN = 40;

/** Show fetches per run on the delta path. */
export const REFRESH_PER_RUN = 200;

/** Consecutive failures after which a run stops asking, so an outage costs little. */
const FAILURE_STOP = 3;

/** TVmaze asks for at most 20 calls every 10 seconds per IP; 550 ms keeps a run under it. */
export const PAUSE_MS = 550;

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

export const pageUrl = (page) => `${BASE}/shows?page=${encodeURIComponent(String(page))}`;
export const showUrl = (id) => `${BASE}/shows/${encodeURIComponent(String(id))}`;
export const updatesUrl = (since = 'week') =>
  `${BASE}/updates/shows?since=${encodeURIComponent(since)}`;

/** The shows on a page as items; an unknown or rerouted show is skipped. */
export function pageItems(body) {
  if (!Array.isArray(body)) return [];
  return body.map((s) => titleItem(s)).filter(Boolean);
}

/**
 * `/updates/shows` is `{ "<id>": <epoch seconds> }`. The ids updated after
 * `sinceEpoch`, ascending by id, so a capped run works through them in order.
 */
export function updatedIds(body, sinceEpoch) {
  if (!body || typeof body !== 'object') return [];
  const out = [];
  for (const [id, ts] of Object.entries(body)) {
    const n = Number(id);
    const t = Number(ts);
    if (!Number.isInteger(n) || !Number.isFinite(t)) continue;
    if (t > sinceEpoch) out.push(n);
  }
  return out.sort((a, b) => a - b);
}

/** Where a run starts. `walkedAt` set means the pass is done and the delta path applies. */
export function resumeFrom(prev) {
  const page = Math.floor(Number(prev?.page));
  const walkedAt = typeof prev?.walkedAt === 'string' ? prev.walkedAt : null;
  const refreshedAt = typeof prev?.refreshedAt === 'string' ? prev.refreshedAt : walkedAt;
  const pending = Array.isArray(prev?.pending)
    ? prev.pending.filter((n) => Number.isInteger(n))
    : [];
  return { page: page >= 0 ? page : 0, walkedAt, refreshedAt, pending };
}

export const tvmazeCatalog = defineAdapter({
  name: 'tvmaze-catalog',
  title: 'TVmaze: every show',
  collection: 'screen',
  description:
    'Every show TVmaze knows, close to 90,000, as title rows in the same shape as the schedule source: name, summary, image, premiere date, genres, network or streaming channel, language, status, runtime, rating, and the IMDb and TheTVDB ids. Keyless; CC BY-SA with TVmaze credited on every row. Walks /shows 250 a page once, then keeps current from /updates/shows, fetching only the shows that changed. Clear the cursor to re-walk.',
  docs: 'https://www.tvmaze.com/api',
  kinds: ['title'],
  cadenceMinutes: 720,
  configFields: [
    {
      key: 'pagesPerRun',
      label: 'Pages per run (first pass)',
      type: 'number',
      placeholder: String(PAGES_PER_RUN),
      help: '250 shows a page. The walk stops here and picks up ten minutes later.',
    },
    {
      key: 'refreshPerRun',
      label: 'Show fetches per run (updates)',
      type: 'number',
      placeholder: String(REFRESH_PER_RUN),
      help: 'After the first pass, how many changed shows to re-read in one run.',
    },
    {
      key: 'pauseMs',
      label: 'Pause between requests (ms)',
      type: 'number',
      placeholder: String(PAUSE_MS),
      help: 'TVmaze allows 20 calls every 10 seconds per IP.',
    },
  ],
  defaults: { pagesPerRun: PAGES_PER_RUN, refreshPerRun: REFRESH_PER_RUN, pauseMs: PAUSE_MS },
  defaultSources: [
    {
      slug: 'tvmaze-catalog',
      name: 'Screen: every show on TVmaze',
      config: { pagesPerRun: PAGES_PER_RUN, refreshPerRun: REFRESH_PER_RUN, pauseMs: PAUSE_MS },
    },
  ],
  async pull({ config, cursor: prev, http, log, deadline }) {
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

    const get = async (url) => {
      if (requests > 0) await sleep(pause);
      requests += 1;
      const res = await http.request(url, {
        headers: { accept: 'application/json' },
        timeoutMs: 20_000,
      });
      if (res.status === 404) return { notFound: true };
      if (!res.ok) throw new Error(`tvmaze answered ${res.status}`);
      return { body: await res.json() };
    };

    // ── First pass: page walk ──────────────────────────────────────────────
    if (!state.walkedAt) {
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
        } catch (err) {
          failures += 1;
          streak += 1;
          log(`page ${page} unavailable (${err?.message ?? err})`);
          if (streak >= FAILURE_STOP) {
            stopped = 'errors';
            break;
          }
        }
      }
      if (requests > 0 && failures === requests)
        throw new Error(`tvmaze: every request failed (${requests}); see the log`);
      if (!done && !stopped) stopped = 'cap';
      return {
        items,
        cursor: done
          ? { page: null, walkedAt: now.toISOString(), refreshedAt: now.toISOString(), pending: [] }
          : { page, walkedAt: null, refreshedAt: null, pending: [] },
        nextInMinutes: done ? undefined : 10,
        note:
          `${items.length} shows from ${pages} pages (from page ${state.page})` +
          (failures ? `, ${failures} failed` : '') +
          (done
            ? '; the catalogue is walked, updates from here on'
            : `; stopped ${stopped === 'cap' ? 'at the page cap' : stopped === 'deadline' ? 'on the run deadline' : 'after repeated failures'} at page ${page}, resuming in 10 min`),
      };
    }

    // ── Delta path: what changed since the last refresh ─────────────────────
    let pending = state.pending;
    let listed = false;
    if (!pending.length) {
      try {
        const sinceEpoch = Math.floor(
          new Date(state.refreshedAt ?? state.walkedAt).getTime() / 1000,
        );
        const got = await get(updatesUrl('week'));
        pending = got.notFound ? [] : updatedIds(got.body, sinceEpoch);
        listed = true;
      } catch (err) {
        failures += 1;
        log(`updates unavailable (${err?.message ?? err})`);
        throw new Error(`tvmaze: could not list updates (${err?.message ?? err})`);
      }
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
        const got = await get(showUrl(id));
        streak = 0;
        fetched += 1;
        pending = pending.slice(1);
        if (got.notFound) continue;
        const item = titleItem(got.body);
        if (item) items.push(item);
      } catch (err) {
        failures += 1;
        streak += 1;
        log(`show ${id} unavailable (${err?.message ?? err})`);
        if (streak >= FAILURE_STOP) {
          stopped = 'errors';
          break;
        }
        pending = pending.slice(1);
      }
    }
    if (requests > 0 && failures === requests)
      throw new Error(`tvmaze: every request failed (${requests}); see the log`);
    const caughtUp = pending.length === 0;
    if (!caughtUp && !stopped) stopped = 'cap';
    return {
      items,
      cursor: {
        page: null,
        walkedAt: state.walkedAt,
        refreshedAt: caughtUp ? now.toISOString() : (state.refreshedAt ?? state.walkedAt),
        pending: caughtUp ? [] : pending,
      },
      nextInMinutes: caughtUp ? undefined : 10,
      note:
        `${items.length} shows refreshed of ${total} changed${listed ? ' this week' : ' still pending'}` +
        (failures ? `, ${failures} failed` : '') +
        (caughtUp
          ? '; caught up'
          : `; ${pending.length} to go, stopped ${stopped === 'cap' ? 'at the cap' : stopped === 'deadline' ? 'on the run deadline' : 'after repeated failures'}, resuming in 10 min`),
    };
  },
});
