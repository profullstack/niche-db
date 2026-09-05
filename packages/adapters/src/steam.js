import { dateOnly, defineAdapter, looseDate } from '@nichedb/core/adapter';

/**
 * The Steam store's front-page lists, keyless.
 *
 * `featuredcategories` returns new releases, coming soon, top sellers and
 * specials in one request; `appdetails` fills in the release date, genres and
 * description one app at a time. The list is thirty or so items and refreshes
 * through the day, so a source on an hourly cadence sees everything that
 * passes through it and the detail budget is never the limit.
 */

const STORE = 'https://store.steampowered.com';

export const CATEGORIES = {
  new_releases: 'New releases',
  coming_soon: 'Coming soon',
  top_sellers: 'Top sellers',
  specials: 'Specials',
};

const MONTHS = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/** "Jul 9, 2013", "9 Jul, 2013", "October 2026", "Q4 2026", "2027", "Coming soon". */
export function parseSteamDate(s) {
  const str = String(s ?? '').trim();
  let m = str.match(/^([A-Za-z]{3})[a-z]* (\d{1,2}), (\d{4})$/);
  if (m)
    return {
      publishedAt: dateOnly(+m[3], MONTHS[m[1].toLowerCase()], +m[2]),
      timeKnown: false,
      precision: 'day',
    };
  m = str.match(/^(\d{1,2}) ([A-Za-z]{3})[a-z]*,? (\d{4})$/);
  if (m)
    return {
      publishedAt: dateOnly(+m[3], MONTHS[m[2].toLowerCase()], +m[1]),
      timeKnown: false,
      precision: 'day',
    };
  m = str.match(/^([A-Za-z]{3})[a-z]* (\d{4})$/);
  if (m && MONTHS[m[1].toLowerCase()]) {
    return {
      publishedAt: dateOnly(+m[2], MONTHS[m[1].toLowerCase()], 15),
      timeKnown: false,
      precision: 'month',
    };
  }
  m = str.match(/^Q([1-4]) (\d{4})$/i);
  if (m)
    return {
      publishedAt: dateOnly(+m[2], (+m[1] - 1) * 3 + 2, 15),
      timeKnown: false,
      precision: 'month',
    };
  m = str.match(/^(\d{4})$/);
  if (m) return looseDate(m[1]);
  return { publishedAt: null, timeKnown: false, precision: 'day' };
}

/** Turn a featured-list entry plus its (optional) appdetails into an item. */
export function toItem(entry, details, categoryKey) {
  const d = details ?? {};
  const when = d.release_date?.date ? parseSteamDate(d.release_date.date) : { publishedAt: null };
  const genres = (d.genres ?? []).map((g) => g.description);
  const platforms = Object.entries(d.platforms ?? {})
    .filter(([, on]) => on)
    .map(([k]) => k);
  const tags = [categoryKey.replace('_', '-'), ...genres, ...platforms];
  if (d.is_free || entry.final_price === 0) tags.push('free');
  if (entry.discounted) tags.push('discounted');
  if (d.release_date?.coming_soon) tags.push('coming-soon');
  return {
    externalId: String(entry.id),
    kind: 'game',
    title: d.name ?? entry.name,
    summary: d.short_description ?? null,
    url: `${STORE}/app/${entry.id}/`,
    imageUrl: d.header_image ?? entry.large_capsule_image ?? entry.small_capsule_image ?? null,
    publishedAt: when.publishedAt,
    timeKnown: when.timeKnown ?? false,
    precision: when.precision ?? 'day',
    tags,
    data: {
      appid: entry.id,
      category: categoryKey,
      price: entry.final_price != null ? entry.final_price / 100 : null,
      currency: entry.currency ?? 'USD',
      discountPercent: entry.discount_percent ?? 0,
      releaseDate: d.release_date?.date ?? null,
      comingSoon: Boolean(d.release_date?.coming_soon),
      developers: d.developers ?? [],
      publishers: d.publishers ?? [],
      genres,
      platforms,
      metacritic: d.metacritic?.score ?? null,
    },
  };
}

export const steam = defineAdapter({
  name: 'steam',
  title: 'Steam store lists',
  collection: 'games',
  description:
    "One of the Steam store's front-page lists: new releases, coming soon, top sellers or specials. Keyless. Each app is enriched with its release date, genres and description.",
  docs: 'https://store.steampowered.com/api/featuredcategories',
  kinds: ['game'],
  cadenceMinutes: 60,
  configFields: [
    {
      key: 'category',
      label: 'Store list',
      type: 'select',
      options: Object.keys(CATEGORIES),
      required: true,
      help: 'Which front-page list to follow.',
    },
    {
      key: 'cc',
      label: 'Country code',
      placeholder: 'us',
      help: 'Prices and availability are per store region.',
    },
  ],
  defaults: { category: 'new_releases', cc: 'us' },
  defaultSources: [
    {
      slug: 'steam-new-releases',
      name: 'Steam: new releases',
      config: { category: 'new_releases' },
    },
    { slug: 'steam-coming-soon', name: 'Steam: coming soon', config: { category: 'coming_soon' } },
    {
      slug: 'steam-top-sellers',
      name: 'Steam: top sellers',
      config: { category: 'top_sellers' },
      cadenceMinutes: 180,
    },
    {
      slug: 'steam-specials',
      name: 'Steam: specials',
      config: { category: 'specials' },
      cadenceMinutes: 180,
    },
  ],
  async pull({ config, cursor, http, log, budget, deadline }) {
    const cc = config.cc || 'us';
    const list = await http.json(`${STORE}/api/featuredcategories?cc=${cc}&l=en`);
    const key = CATEGORIES[config.category] ? config.category : 'new_releases';
    const entries = list?.[key]?.items ?? [];

    // Details are cached by appid for a day inside the cursor, so an app that
    // sits on the list all week costs one lookup, not one per run.
    const cache = cursor.details ?? {};
    const now = Date.now();
    const items = [];
    let spent = 0;
    for (const entry of entries) {
      if (Date.now() > deadline) break;
      const cached = cache[entry.id];
      let details = cached && now - cached.at < 86_400_000 ? cached.d : null;
      if (!details && spent < budget) {
        spent++;
        const res = await http.jsonOrNull(
          `${STORE}/api/appdetails?appids=${entry.id}&cc=${cc}&l=en`,
        );
        details = res?.[String(entry.id)]?.success ? res[String(entry.id)].data : null;
        if (details) {
          const keep = (({
            name,
            short_description,
            header_image,
            release_date,
            genres,
            platforms,
            developers,
            publishers,
            is_free,
            metacritic,
          }) => ({
            name,
            short_description,
            header_image,
            release_date,
            genres,
            platforms,
            developers,
            publishers,
            is_free,
            metacritic,
          }))(details);
          cache[entry.id] = { at: now, d: keep };
          details = keep;
        }
      }
      items.push(toItem(entry, details, key));
    }
    // Keep the cache bounded to what is on the list plus a little history.
    const keepIds = new Set(entries.map((e) => String(e.id)));
    for (const id of Object.keys(cache)) {
      if (!keepIds.has(id) && now - cache[id].at > 7 * 86_400_000) delete cache[id];
    }
    log(`${key}: ${entries.length} on the list, ${spent} detail lookups`);
    return { items, cursor: { details: cache }, note: `${entries.length} on ${CATEGORIES[key]}` };
  },
});

/**
 * Patch notes and announcements for named apps, from the Steam news API.
 * Keyless. Add the appids of the games you care about.
 */
export const steamNews = defineAdapter({
  name: 'steam-news',
  title: 'Steam app news',
  collection: 'games',
  description:
    'Patch notes, updates and announcements for specific games, by Steam appid. Keyless. This is how you follow a game after it is out.',
  docs: 'https://partner.steamgames.com/doc/webapi/ISteamNews',
  kinds: ['news'],
  cadenceMinutes: 30,
  configFields: [
    {
      key: 'appids',
      label: 'App ids',
      type: 'list',
      required: true,
      placeholder: '570, 730, 1245620',
      help: 'The number in a store URL: store.steampowered.com/app/570 is 570.',
    },
  ],
  defaults: { appids: [] },
  async pull({ config, http, budget, deadline }) {
    const ids = (
      Array.isArray(config.appids) ? config.appids : String(config.appids ?? '').split(',')
    )
      .map((s) => String(s).trim())
      .filter((s) => /^\d+$/.test(s))
      .slice(0, budget);
    const items = [];
    for (const appid of ids) {
      if (Date.now() > deadline) break;
      const res = await http.jsonOrNull(
        `https://api.steampowered.com/ISteamNews/v0002/GetNewsForApp/v0002/?appid=${appid}&count=20&maxlength=600&format=json`,
      );
      for (const n of res?.appnews?.newsitems ?? []) {
        items.push({
          externalId: n.gid,
          kind: 'news',
          title: n.title,
          summary: n.contents,
          url: n.url,
          publishedAt: new Date(n.date * 1000),
          tags: [`app-${appid}`, n.feedlabel, ...(n.tags ?? [])].filter(Boolean),
          data: { appid: Number(appid), author: n.author, feed: n.feedname },
        });
      }
    }
    return { items, note: `${ids.length} app(s)` };
  },
});
