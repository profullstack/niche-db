import { defineAdapter } from '@nichedb/core/adapter';

import { toItem } from './igdb.js';

/**
 * Every game IGDB knows, for the `games` collection.
 *
 * igdb-upcoming and igdb-recent carry a window; this carries the catalogue,
 * about 350,000 games. IGDB is the one games database that says so in its
 * own words: the API is "free for both non-commercial and commercial
 * projects" and "we prefer if you store and serve the data"
 * (api-docs.igdb.com, Twitch Developer Services Agreement). Credit IGDB on
 * the row; a monetised product is asked to email partner@igdb.com.
 *
 * The walk is by id: `where id > N; sort id asc; limit 500;` hands back the
 * next 500 games in one POST, so the whole catalogue is about 700 requests
 * at the 4-a-second limit, capped per run so no run holds the queue. Once a
 * pass is complete the source asks only for what changed: `where updated_at >
 * <last refresh>; sort updated_at asc;` walked the same way, which covers new
 * games too (a new game has a fresh updated_at). Clear the cursor to re-walk.
 *
 * Rows extend igdb.js's toItem with the fields a catalogue wants and a
 * window a reader can filter on: the companies, themes, modes, the game
 * type (main game, DLC, expansion, remake...), status, rating counts and the
 * external ids IGDB keeps (Steam and others) under `data.external`.
 */

export const GAMES_URL = 'https://api.igdb.com/v4/games';

/** Requests per run: 100 requests is 50,000 games, seven runs for the catalogue. */
export const REQUESTS_PER_RUN = 100;

/** 260 ms between requests keeps under IGDB's 4 a second with room for the token call. */
export const PAUSE_MS = 260;

export const FIELDS =
  'name,slug,summary,storyline,first_release_date,updated_at,cover.url,genres.name,platforms.abbreviation,platforms.name,url,hypes,total_rating,total_rating_count,aggregated_rating,aggregated_rating_count,rating,rating_count,category,status,themes.name,game_modes.name,player_perspectives.name,involved_companies.company.name,involved_companies.developer,involved_companies.publisher,external_games.category,external_games.uid,websites.category,websites.url,collection.name,franchise.name,parent_game';

/** IGDB's `category` enum, in the docs' own words. */
export const CATEGORY = [
  'main_game',
  'dlc_addon',
  'expansion',
  'bundle',
  'standalone_expansion',
  'mod',
  'episode',
  'season',
  'remake',
  'remaster',
  'expanded_game',
  'port',
  'fork',
  'pack',
  'update',
];

/** IGDB's `status` enum. */
export const STATUS = {
  0: 'released',
  2: 'alpha',
  3: 'beta',
  4: 'early_access',
  5: 'offline',
  6: 'cancelled',
  7: 'rumored',
  8: 'delisted',
};

/** external_games.category: the stores IGDB cross-references. */
export const EXTERNAL = {
  1: 'steam',
  5: 'gog',
  10: 'youtube',
  11: 'microsoft',
  13: 'apple',
  14: 'twitch',
  15: 'android',
  20: 'amazon_asin',
  22: 'amazon_luna',
  23: 'amazon_adg',
  26: 'epic',
  28: 'oculus',
  29: 'utomik',
  30: 'itch',
  31: 'xbox_marketplace',
  32: 'kartridge',
  36: 'playstation_store_us',
  37: 'focus_entertainment',
  54: 'xbox_game_pass_ultimate_cloud',
  55: 'gamejolt',
};

/** websites.category. */
export const WEBSITE = {
  1: 'official',
  2: 'wikia',
  3: 'wikipedia',
  4: 'facebook',
  5: 'twitter',
  6: 'twitch',
  8: 'instagram',
  9: 'youtube',
  10: 'iphone',
  11: 'ipad',
  12: 'android',
  13: 'steam',
  14: 'reddit',
  15: 'itch',
  16: 'epicgames',
  17: 'gog',
  18: 'discord',
};

const names = (xs) => (Array.isArray(xs) ? xs.map((x) => x?.name).filter(Boolean) : []);
const tagSlug = (x) =>
  String(x)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

export const walkQuery = (afterId, limit = 500) =>
  `fields ${FIELDS}; where id > ${Math.max(0, Math.floor(afterId))}; sort id asc; limit ${limit};`;
export const deltaQuery = (sinceEpoch, afterId, limit = 500) =>
  `fields ${FIELDS}; where updated_at > ${Math.max(0, Math.floor(sinceEpoch))} & id > ${Math.max(0, Math.floor(afterId))}; sort id asc; limit ${limit};`;

/** One game as a catalogue row. */
export function catalogItem(g) {
  const base = toItem(g, 'catalog');
  const companies = (g.involved_companies ?? [])
    .map((c) => ({
      name: c?.company?.name ?? null,
      developer: !!c?.developer,
      publisher: !!c?.publisher,
    }))
    .filter((c) => c.name);
  const external = {};
  for (const e of g.external_games ?? []) {
    const key = EXTERNAL[e?.category] ?? (e?.category != null ? `category_${e.category}` : null);
    if (key && e?.uid && !external[key]) external[key] = String(e.uid);
  }
  const websites = {};
  for (const w of g.websites ?? []) {
    const key = WEBSITE[w?.category] ?? null;
    if (key && w?.url && !websites[key]) websites[key] = w.url;
  }
  const category =
    CATEGORY[g.category] ?? (g.category != null ? `category_${g.category}` : 'main_game');
  const status = STATUS[g.status] ?? null;
  return {
    ...base,
    externalId: `igdb:game:${g.id}`,
    summary: base.summary ?? g.storyline ?? null,
    tags: [
      'game',
      'igdb',
      `type:${category}`,
      ...(status ? [`status:${status}`] : []),
      ...base.data.genres.map((x) => `genre:${tagSlug(x)}`),
      ...base.data.platforms.map((x) => `platform:${tagSlug(x)}`),
    ],
    data: {
      ...base.data,
      provider: 'igdb',
      category,
      status,
      storyline: g.storyline ?? null,
      themes: names(g.themes),
      modes: names(g.game_modes),
      perspectives: names(g.player_perspectives),
      companies,
      developers: companies.filter((c) => c.developer).map((c) => c.name),
      publishers: companies.filter((c) => c.publisher).map((c) => c.name),
      collection: g.collection?.name ?? null,
      franchise: g.franchise?.name ?? null,
      parentGame: g.parent_game ?? null,
      ratingCount: g.total_rating_count ?? null,
      criticRating: g.aggregated_rating ?? null,
      criticRatingCount: g.aggregated_rating_count ?? null,
      userRating: g.rating ?? null,
      userRatingCount: g.rating_count ?? null,
      external,
      websites,
      steamAppId: external.steam ?? null,
      updatedAt: g.updated_at ? new Date(g.updated_at * 1000).toISOString() : null,
      attribution: 'Data from IGDB.com (Twitch)',
    },
  };
}

export function resumeFrom(prev) {
  const afterId = Math.floor(Number(prev?.afterId));
  const walkedAt = typeof prev?.walkedAt === 'string' ? prev.walkedAt : null;
  const refreshedAt = typeof prev?.refreshedAt === 'string' ? prev.refreshedAt : walkedAt;
  const deltaAfterId = Math.floor(Number(prev?.deltaAfterId));
  return {
    afterId: afterId >= 0 ? afterId : 0,
    walkedAt,
    refreshedAt,
    deltaAfterId: deltaAfterId >= 0 ? deltaAfterId : 0,
  };
}

async function token({ cursor, env, http }) {
  if (cursor.token && cursor.tokenExpires > Date.now() + 60_000) return cursor.token;
  const url = `https://id.twitch.tv/oauth2/token?client_id=${encodeURIComponent(env.igdbClientId)}&client_secret=${encodeURIComponent(env.igdbClientSecret)}&grant_type=client_credentials`;
  const res = await http.json(url, { method: 'POST' });
  cursor.token = res.access_token;
  cursor.tokenExpires = Date.now() + (res.expires_in ?? 3600) * 1000;
  return cursor.token;
}

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

export const igdbCatalog = defineAdapter({
  name: 'igdb-catalog',
  title: 'IGDB: every game',
  collection: 'games',
  description:
    'Every game IGDB knows, about 350,000, as game rows: name, summary, release date, cover, genres, platforms, themes, modes, developers and publishers, game type and status, ratings and counts, the store ids IGDB cross-references (Steam, GOG, Epic, ...) and the official and social websites. Walks by id 500 a request once, then asks only for what changed since the last refresh. Needs IGDB_CLIENT_ID and IGDB_CLIENT_SECRET (a free Twitch developer app); IGDB allows commercial use and asks to be credited.',
  docs: 'https://api-docs.igdb.com/',
  kinds: ['game'],
  cadenceMinutes: 720,
  configFields: [
    {
      key: 'requestsPerRun',
      label: 'Requests per run',
      type: 'number',
      placeholder: String(REQUESTS_PER_RUN),
      help: '500 games a request. The walk stops here and picks up ten minutes later.',
    },
    {
      key: 'pauseMs',
      label: 'Pause between requests (ms)',
      type: 'number',
      placeholder: String(PAUSE_MS),
      help: 'IGDB allows 4 requests a second.',
    },
  ],
  defaults: { requestsPerRun: REQUESTS_PER_RUN, pauseMs: PAUSE_MS },
  defaultSources: [
    {
      slug: 'igdb-catalog',
      name: 'Games: every game on IGDB',
      config: { requestsPerRun: REQUESTS_PER_RUN, pauseMs: PAUSE_MS },
    },
  ],
  async pull({ config, cursor: prev, env, http, log, deadline }) {
    if (!env?.igdbClientId || !env?.igdbClientSecret)
      throw new Error('IGDB_CLIENT_ID and IGDB_CLIENT_SECRET are not set');
    const cap = Math.max(1, Math.floor(Number(config?.requestsPerRun)) || REQUESTS_PER_RUN);
    const pause =
      config?.pauseMs === 0 ? 0 : Math.max(0, Math.floor(Number(config?.pauseMs))) || PAUSE_MS;
    const stopAt = Number.isFinite(deadline) ? deadline : Number.POSITIVE_INFINITY;
    const cursor = { ...(prev ?? {}) };
    const state = resumeFrom(cursor);
    const t = await token({ cursor, env, http });
    const now = new Date();
    const items = [];
    let requests = 0;
    let stopped = null;

    const query = async (body) => {
      if (requests > 0) await sleep(pause);
      requests += 1;
      const res = await http.request(GAMES_URL, {
        method: 'POST',
        headers: {
          'client-id': env.igdbClientId,
          authorization: `Bearer ${t}`,
          'content-type': 'text/plain',
          accept: 'application/json',
        },
        body,
        timeoutMs: 30_000,
      });
      if (!res.ok) throw new Error(`igdb answered ${res.status}`);
      const page = await res.json();
      return Array.isArray(page) ? page : [];
    };

    const delta = !!state.walkedAt;
    const sinceEpoch = delta
      ? Math.floor(new Date(state.refreshedAt ?? state.walkedAt).getTime() / 1000)
      : 0;
    let afterId = delta ? state.deltaAfterId : state.afterId;
    let done = false;
    while (requests < cap) {
      if (Date.now() > stopAt) {
        stopped = 'deadline';
        break;
      }
      const page = await query(delta ? deltaQuery(sinceEpoch, afterId) : walkQuery(afterId));
      for (const g of page) {
        if (!g?.id || !g.name) continue;
        items.push(catalogItem(g));
        afterId = Math.max(afterId, g.id);
      }
      if (page.length < 500) {
        done = true;
        break;
      }
    }
    if (!done && !stopped) stopped = 'cap';
    log(`${items.length} games in ${requests} requests${delta ? ' (changes)' : ''}`);

    const next = delta
      ? {
          ...cursor,
          afterId: null,
          walkedAt: state.walkedAt,
          refreshedAt: done ? now.toISOString() : (state.refreshedAt ?? state.walkedAt),
          deltaAfterId: done ? 0 : afterId,
        }
      : done
        ? {
            ...cursor,
            afterId: null,
            walkedAt: now.toISOString(),
            refreshedAt: now.toISOString(),
            deltaAfterId: 0,
          }
        : { ...cursor, afterId, walkedAt: null, refreshedAt: null, deltaAfterId: 0 };
    const reason = stopped === 'cap' ? 'at the request cap' : 'on the run deadline';
    return {
      items,
      cursor: next,
      nextInMinutes: done ? undefined : 10,
      note: delta
        ? `${items.length} games changed since the last refresh, ${requests} requests${done ? '; caught up' : `; more to come, stopped ${reason} at id ${afterId}, resuming in 10 min`}`
        : `${items.length} games in ${requests} requests (ids up to ${afterId})${done ? '; the catalogue is walked, changes from here on' : `; stopped ${reason}, resuming in 10 min`}`,
    };
  },
});
