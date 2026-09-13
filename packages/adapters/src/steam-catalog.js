import { defineAdapter, slugify } from '@nichedb/core/adapter';

/**
 * Every app on Steam, for the `games` collection.
 *
 * steam.js carries the store's front-page lists, thirty or so apps at a time;
 * this is the other 299,000. The old ISteamApps/GetAppList is gone (404 since
 * 2026), and the storefront's own search backend is what replaced it:
 * IStoreQueryService/Query is keyless, answers 500 apps a page in name order
 * for any `start`, and reports the total, so a walk knows where it is. Each
 * row carries the app's name, type, short description, release date,
 * platforms, top tags, review summary, price, developers and publishers, which
 * is what appdetails would take one request per app to say.
 *
 * A run asks for `requestCap` pages and stops; the cursor carries the next
 * `start`, and the pass is complete when a page comes back short or empty, or
 * when `start` reaches the total. The next run starts the catalogue over, so
 * every app is re-read about every eight days at the default cap and an app
 * that changed since is rewritten. Tag names come from IStoreService/GetTagList
 * once per run, because the query hands back tag ids only.
 *
 * Steam's type codes are undocumented; the ones seen live are mapped by name
 * and any other code becomes `type-<n>` rather than a guess. About one row in
 * twenty has no name (an unlisted or region-locked app), and that row is
 * skipped rather than failing the page.
 */

export const BASE = 'https://api.steampowered.com';
export const STORE = 'https://store.steampowered.com';
export const CDN = 'https://cdn.cloudflare.steamstatic.com/steam/apps';

/** Apps per page. The service accepts 1,000 but 500 keeps a page under a megabyte. */
export const PAGE_SIZE = 500;

/** Pages per run by default: 20,000 apps, so a pass takes about fifteen runs. */
export const REQUEST_CAP = 40;

/**
 * Pause between pages. Valve publishes no limit for this service; the Web API
 * as a whole asks for no more than 100,000 calls a day, and one a second is
 * far inside that while still not hammering the storefront.
 */
export const PAUSE_MS = 1000;

/** Consecutive failures after which a run stops asking, so an outage costs little. */
const FAILURE_STOP = 3;

export const USER_AGENT = 'nichedb (https://nichedb.dev; hello@nichedb.dev) steam-catalog';

export const ATTRIBUTION =
  'Steam (Valve); store data, for personal use and as is, per the Steam Web API terms';

/**
 * `type` on a store item. Confirmed against the store's own labels on
 * 2026-09-13: 0 game, 1 demo, 2 mod, 4 dlc, 6 software, 7 video, 10 hardware,
 * 11 music (soundtracks). Codes not seen live are not guessed.
 */
export const APP_TYPES = {
  0: 'game',
  1: 'demo',
  2: 'mod',
  4: 'dlc',
  6: 'software',
  7: 'video',
  10: 'hardware',
  11: 'music',
};

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

const text = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
};

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** The query the storefront search takes, as an object; `queryUrl` encodes it. */
export function queryBody(start, count = PAGE_SIZE) {
  return {
    query: {
      start: Math.max(0, Math.floor(Number(start)) || 0),
      count: Math.max(1, Math.floor(Number(count)) || PAGE_SIZE),
      sort: 1,
      filters: {
        type_filters: {
          include_apps: true,
          include_dlc: true,
          include_software: true,
          include_games: true,
          include_video: true,
          include_hardware: true,
        },
      },
    },
    context: { language: 'english', country_code: 'US' },
    data_request: {
      include_basic_info: true,
      include_release: true,
      include_platforms: true,
      include_tag_count: 5,
      include_reviews: true,
    },
  };
}

export const queryUrl = (start, count = PAGE_SIZE) =>
  `${BASE}/IStoreQueryService/Query/v1?input_json=${encodeURIComponent(JSON.stringify(queryBody(start, count)))}`;

export const tagListUrl = () => `${BASE}/IStoreService/GetTagList/v1/?language=english`;

/** The `start` a query URL asks for, for a fake or a log line. */
export function queryStart(url) {
  try {
    const raw = new URL(url).searchParams.get('input_json');
    return raw ? (num(JSON.parse(raw)?.query?.start) ?? null) : null;
  } catch {
    return null;
  }
}

/** The type code as a slug; an unknown code is `type-<n>` rather than a guess. */
export function appType(code) {
  const n = Math.floor(Number(code));
  if (!Number.isFinite(n)) return 'unknown';
  return APP_TYPES[n] ?? `type-${n}`;
}

/** A Steam epoch (seconds) as a Date; zero and junk are null. */
export function steamDate(epoch) {
  const n = num(epoch);
  return n && n > 0 ? new Date(n * 1000) : null;
}

/**
 * One page of the query: the total, where it started, how many rows came back
 * and the rows. Null for a body that is not a page at all.
 */
export function parsePage(body) {
  const r = body?.response;
  const meta = r?.metadata;
  if (!meta || typeof meta !== 'object') return null;
  const rows = Array.isArray(r.store_items) ? r.store_items : [];
  const total = num(meta.total_matching_records);
  if (total === null) return null;
  return {
    total,
    start: num(meta.start) ?? 0,
    count: num(meta.count) ?? rows.length,
    rows,
  };
}

/** GetTagList as tagid -> name. */
export function tagMap(body) {
  const out = new Map();
  for (const t of body?.response?.tags ?? []) {
    const id = num(t?.tagid);
    const name = text(t?.name);
    if (id !== null && name) out.set(id, name);
  }
  return out;
}

const names = (list) =>
  Array.isArray(list) ? list.map((d) => text(d?.name ?? d)).filter(Boolean) : [];

/** One store row -> one item, or null for a row with no name. */
export function appItem(row, tagNames = new Map()) {
  const appid = num(row?.appid ?? row?.id);
  const name = text(row?.name);
  if (appid === null || appid <= 0 || !name) return null;
  const type = appType(row.type);
  const info = row.basic_info ?? {};
  const release = row.release ?? {};
  const p = row.platforms ?? {};
  const platforms = [
    p.windows ? 'windows' : null,
    p.mac ? 'mac' : null,
    p.steamos_linux ? 'linux' : null,
  ].filter(Boolean);
  const tagIds = (Array.isArray(row.tagids) ? row.tagids : [])
    .map((t) => num(t))
    .filter((t) => t !== null);
  const tags = tagIds.map((t) => tagNames.get(t)).filter(Boolean);
  const review = row.reviews?.summary_filtered ?? {};
  const reviewCount = num(review.review_count) ?? 0;
  const releasedAt = steamDate(release.steam_release_date);
  const originalAt = steamDate(release.original_release_date);
  const comingSoon = Boolean(row.is_coming_soon ?? release.is_coming_soon);
  const earlyAccess = Boolean(row.is_early_access ?? release.is_early_access);
  const isFree = Boolean(row.is_free);
  const cents = num(row.best_purchase_option?.final_price_in_cents);
  return {
    externalId: `steam:app:${appid}`,
    kind: 'game',
    title: name,
    summary: text(info.short_description),
    url: `${STORE}/app/${appid}`,
    imageUrl: `${CDN}/${appid}/header.jpg`,
    publishedAt: releasedAt,
    timeKnown: Boolean(releasedAt),
    precision: 'minute',
    tags: [
      'game',
      'steam',
      `type:${type}`,
      ...platforms.map((s) => `platform:${s}`),
      ...tags.map((t) => `tag:${slugify(t)}`),
      isFree ? 'free' : null,
      earlyAccess ? 'early-access' : null,
      comingSoon ? 'coming-soon' : null,
    ].filter(Boolean),
    data: {
      provider: 'steam',
      steamAppId: appid,
      appid,
      type,
      typeCode: num(row.type),
      releaseDate: releasedAt ? releasedAt.toISOString().slice(0, 10) : null,
      originalReleaseDate: originalAt ? originalAt.toISOString().slice(0, 10) : null,
      comingSoon,
      earlyAccess,
      platforms,
      tags,
      tagIds,
      reviewScore: num(review.review_score) || null,
      reviewScoreLabel: text(review.review_score_label),
      reviewPercentPositive: reviewCount > 0 ? num(review.percent_positive) : null,
      reviewCount,
      isFree,
      price: isFree ? 0 : cents !== null ? cents / 100 : null,
      currency: 'USD',
      developers: names(info.developers),
      publishers: names(info.publishers),
      franchises: names(info.franchises),
      parentAppId: num(row.related_items?.parent_appid),
      attribution: ATTRIBUTION,
    },
  };
}

/** Where a run starts: the cursor's next start, or zero once a pass is past the total. */
export function resumeStart(prev) {
  const start = Math.floor(Number(prev?.start));
  if (!Number.isFinite(start) || start < 0) return 0;
  const total = Math.floor(Number(prev?.total));
  if (Number.isFinite(total) && total > 0 && start >= total) return 0;
  return start;
}

export const steamCatalog = defineAdapter({
  name: 'steam-catalog',
  title: 'Steam: every app',
  collection: 'games',
  description:
    "Every app on Steam, close to 300,000: games, demos, DLC, software, soundtracks, videos and hardware, one row each with its type, short description, release date, platforms, top tags, review summary, price, developers and publishers. Keyless. The Steam Web API terms license Steam Data for redistribution to readers for their personal use, as is, at no more than 100,000 calls a day, and never presented as Valve's own or as endorsed by Valve; there is no open-data licence. Walks the storefront query 500 a page, resumes at the next start, and begins the catalogue over once a pass is complete.",
  docs: 'https://steamapi.xpaw.me/#IStoreQueryService/Query',
  kinds: ['game'],
  cadenceMinutes: 1440,
  configFields: [
    {
      key: 'requestCap',
      label: 'Pages per run',
      type: 'number',
      placeholder: String(REQUEST_CAP),
      help: '500 apps a page. The walk stops here and picks up ten minutes later; 40 pages is 20,000 apps.',
    },
    {
      key: 'pauseMs',
      label: 'Pause between pages (ms)',
      type: 'number',
      placeholder: String(PAUSE_MS),
      help: 'Valve publishes no per-service limit; one page a second is polite.',
    },
  ],
  defaults: { requestCap: REQUEST_CAP, pauseMs: PAUSE_MS },
  defaultSources: [
    {
      slug: 'steam-catalog',
      name: 'Games: every app on Steam',
      config: { requestCap: REQUEST_CAP, pauseMs: PAUSE_MS },
    },
  ],
  async pull({ config, cursor: prev, http, log, deadline }) {
    const cap = Math.max(1, Math.floor(Number(config?.requestCap)) || REQUEST_CAP);
    const pause =
      config?.pauseMs === 0 ? 0 : Math.max(0, Math.floor(Number(config?.pauseMs))) || PAUSE_MS;
    const stopAt = Number.isFinite(deadline) ? deadline : Number.POSITIVE_INFINITY;
    const startedAt = resumeStart(prev);
    let start = startedAt;
    let total = Math.floor(Number(prev?.total)) || null;
    const items = [];
    let requests = 0;
    let failures = 0;
    let streak = 0;
    let pages = 0;
    let skipped = 0;
    let done = false;
    let stopped = null;

    const get = async (url) => {
      if (requests > 0) await sleep(pause);
      requests += 1;
      const res = await http.request(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
        timeoutMs: 30_000,
      });
      if (!res.ok) throw new Error(`steam answered ${res.status}`);
      return res.json();
    };

    // Tag ids to names, once a run. Without it rows still land, tagged by id only.
    let tagNames = new Map();
    try {
      tagNames = tagMap(await get(tagListUrl()));
    } catch (err) {
      failures += 1;
      streak += 1;
      log(`tag list unavailable (${err?.message ?? err}); rows carry tag ids only this run`);
    }

    while (pages < cap) {
      if (Date.now() > stopAt) {
        stopped = 'deadline';
        break;
      }
      let page;
      try {
        page = parsePage(await get(queryUrl(start)));
        if (!page) throw new Error('steam answered without a page');
        streak = 0;
      } catch (err) {
        failures += 1;
        streak += 1;
        log(`page at ${start} unavailable (${err?.message ?? err})`);
        if (streak >= FAILURE_STOP) {
          stopped = 'errors';
          break;
        }
        continue;
      }
      pages += 1;
      total = page.total;
      for (const row of page.rows) {
        const item = appItem(row, tagNames);
        if (item) items.push(item);
        else skipped += 1;
      }
      if (page.count === 0) {
        done = true;
        break;
      }
      start += page.count;
      if (start >= total) {
        done = true;
        break;
      }
    }

    if (requests > 0 && failures === requests) {
      throw new Error(`steam: every request failed (${requests} of ${requests}); see the log`);
    }
    if (!done && !stopped) stopped = 'cap';
    const reason =
      stopped === 'cap'
        ? 'at the request cap'
        : stopped === 'deadline'
          ? 'on the run deadline'
          : 'after repeated failures';

    return {
      items,
      cursor: {
        start: done ? 0 : start,
        total,
        walkedAt: done ? new Date().toISOString() : (prev?.walkedAt ?? null),
      },
      nextInMinutes: done ? undefined : 10,
      note:
        `${items.length} apps from ${pages} pages (start ${startedAt} to ${start}` +
        `${total ? ` of ${total}` : ''})` +
        (skipped ? `, ${skipped} unnamed skipped` : '') +
        (failures ? `, ${failures} failed` : '') +
        (done
          ? '; the catalogue is walked, next run starts over at 0'
          : `; stopped ${reason} at ${start}, resuming in 10 min`),
    };
  },
});
