import { defineAdapter } from '@nichedb/core/adapter';

/**
 * IGDB (Twitch): the broadest free game database. Needs a Twitch developer
 * client id and secret, which are free; the adapter keeps the OAuth token in
 * its cursor and renews it before it expires.
 */

async function token({ cursor, env, http }) {
  if (cursor.token && cursor.tokenExpires > Date.now() + 60_000) return cursor.token;
  const url = `https://id.twitch.tv/oauth2/token?client_id=${encodeURIComponent(env.igdbClientId)}&client_secret=${encodeURIComponent(env.igdbClientSecret)}&grant_type=client_credentials`;
  const res = await http.json(url, { method: 'POST' });
  cursor.token = res.access_token;
  cursor.tokenExpires = Date.now() + (res.expires_in ?? 3600) * 1000;
  return cursor.token;
}

export function toItem(g, window) {
  const cover = g.cover?.url ? `https:${g.cover.url}`.replace('t_thumb', 't_cover_big') : null;
  const genres = (g.genres ?? []).map((x) => x.name);
  const platforms = (g.platforms ?? []).map((x) => x.abbreviation ?? x.name).filter(Boolean);
  return {
    externalId: String(g.id),
    kind: 'game',
    title: g.name,
    summary: g.summary ?? null,
    url: g.url ?? `https://www.igdb.com/games/${g.slug}`,
    imageUrl: cover,
    publishedAt: g.first_release_date ? new Date(g.first_release_date * 1000) : null,
    timeKnown: false,
    precision: 'day',
    tags: [window, ...genres, ...platforms],
    data: {
      igdbId: g.id,
      slug: g.slug,
      hypes: g.hypes ?? 0,
      rating: g.total_rating ?? null,
      genres,
      platforms,
    },
  };
}

export const igdb = defineAdapter({
  name: 'igdb',
  title: 'IGDB (Twitch)',
  collection: 'games',
  description:
    'Upcoming or recent releases across every platform from IGDB. Free, but needs a Twitch developer client id and secret set on the deployment (IGDB_CLIENT_ID, IGDB_CLIENT_SECRET).',
  docs: 'https://api-docs.igdb.com/',
  kinds: ['game'],
  cadenceMinutes: 180,
  needsEnv: ['igdbClientId', 'igdbClientSecret'],
  configFields: [
    {
      key: 'window',
      label: 'Window',
      type: 'select',
      options: ['upcoming', 'recent'],
      required: true,
    },
    {
      key: 'days',
      label: 'Days',
      type: 'number',
      placeholder: '90',
      help: 'How far ahead (or back) to look.',
    },
    {
      key: 'platform',
      label: 'Platform id',
      placeholder: '6',
      help: 'Optional IGDB platform id. 6 is PC, 167 is PS5, 130 is Switch.',
    },
  ],
  defaults: { window: 'upcoming', days: 90 },
  defaultSources: [
    {
      slug: 'igdb-upcoming',
      name: 'IGDB: upcoming releases',
      config: { window: 'upcoming', days: 120 },
    },
    {
      slug: 'igdb-recent',
      name: 'IGDB: released recently',
      config: { window: 'recent', days: 30 },
    },
  ],
  async pull({ config, cursor, env, http, log }) {
    if (!env.igdbClientId || !env.igdbClientSecret)
      throw new Error('IGDB_CLIENT_ID and IGDB_CLIENT_SECRET are not set');
    const t = await token({ cursor, env, http });
    const now = Math.floor(Date.now() / 1000);
    const days = Number(config.days) || 90;
    const range =
      config.window === 'recent'
        ? `first_release_date >= ${now - days * 86400} & first_release_date <= ${now}`
        : `first_release_date >= ${now} & first_release_date <= ${now + days * 86400}`;
    const platform = config.platform ? ` & platforms = (${Number(config.platform)})` : '';
    const items = [];
    for (let offset = 0; offset < 1500; offset += 500) {
      const body = `fields name,slug,summary,first_release_date,cover.url,genres.name,platforms.abbreviation,platforms.name,url,hypes,total_rating; where ${range}${platform}; sort first_release_date ${config.window === 'recent' ? 'desc' : 'asc'}; limit 500; offset ${offset};`;
      const page = await http.json('https://api.igdb.com/v4/games', {
        method: 'POST',
        headers: {
          'client-id': env.igdbClientId,
          authorization: `Bearer ${t}`,
          'content-type': 'text/plain',
        },
        body,
      });
      for (const g of page) items.push(toItem(g, config.window));
      if (page.length < 500) break;
      await Bun.sleep(300);
    }
    log(`${items.length} ${config.window} games`);
    return { items, cursor, note: `${items.length} games` };
  },
});
