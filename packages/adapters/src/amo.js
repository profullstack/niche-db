import { defineAdapter, stripHtml } from '@nichedb/core/adapter';

/** Firefox Add-ons (AMO): newest or most recently updated extensions. Keyless. */
const t = (v) => (typeof v === 'string' ? v : (v?.['en-US'] ?? Object.values(v ?? {})[0] ?? null));

export function toItem(a) {
  return {
    externalId: String(a.id),
    kind: 'extension',
    title: t(a.name) ?? a.slug,
    summary: stripHtml(t(a.summary) ?? '').slice(0, 400) || null,
    url: a.url,
    imageUrl: a.icon_url ?? null,
    publishedAt: a.last_updated ?? a.created,
    tags: [
      'firefox',
      'amo',
      ...(Array.isArray(a.categories)
        ? a.categories
        : Object.values(a.categories ?? {}).flat()
      ).slice(0, 6),
      a.is_recommended ? 'recommended' : null,
    ].filter(Boolean),
    data: {
      slug: a.slug,
      authors: (a.authors ?? []).map((x) => x.name),
      users: a.average_daily_users ?? 0,
      rating: a.ratings?.average ?? null,
      ratings: a.ratings?.count ?? 0,
      version: a.current_version?.version ?? null,
      homepage: t(a.homepage?.url) ?? null,
      created: a.created,
    },
  };
}

export const firefoxAddons = defineAdapter({
  name: 'firefox-addons',
  title: 'Firefox add-ons',
  collection: 'extensions',
  description:
    'Extensions published or updated on addons.mozilla.org, with icon, category, users and rating. Keyless.',
  docs: 'https://mozilla.github.io/addons-server/topics/api/addons.html',
  kinds: ['extension'],
  cadenceMinutes: 30,
  configFields: [
    {
      key: 'sort',
      label: 'Sort',
      type: 'select',
      options: ['created', 'updated', 'hotness'],
      required: true,
    },
    { key: 'q', label: 'Search', placeholder: 'privacy' },
  ],
  defaults: { sort: 'created' },
  defaultSources: [
    {
      slug: 'firefox-new-extensions',
      name: 'Firefox: new extensions',
      config: { sort: 'created' },
    },
    {
      slug: 'firefox-updated-extensions',
      name: 'Firefox: recently updated',
      config: { sort: 'updated' },
      cadenceMinutes: 60,
    },
  ],
  async pull({ config, http, log }) {
    const params = new URLSearchParams({
      type: 'extension',
      page_size: '50',
      sort: ['created', 'updated', 'hotness'].includes(config.sort) ? config.sort : 'created',
      lang: 'en-US',
    });
    if (config.q) params.set('q', String(config.q));
    const items = [];
    for (let p = 1; p <= 2; p++) {
      params.set('page', String(p));
      const res = await http.json(`https://addons.mozilla.org/api/v5/addons/search/?${params}`);
      for (const a of res.results ?? []) items.push(toItem(a));
      if (!res.next) break;
    }
    log(`${items.length} add-ons`);
    return { items, note: `${items.length} add-ons` };
  },
});
