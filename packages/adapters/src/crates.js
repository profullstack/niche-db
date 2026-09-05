import { defineAdapter } from '@nichedb/core/adapter';

/** crates.io's own API, sorted by most recently updated. Keyless; it asks for a User-Agent. */
export function toItem(c) {
  const version = c.newest_version ?? c.max_version;
  return {
    externalId: `${c.name}@${version}`,
    kind: 'version',
    title: `${c.name} ${version}`,
    summary: c.description ?? null,
    url: `https://crates.io/crates/${c.name}`,
    publishedAt: c.updated_at,
    tags: ['crates', ...(c.keywords ?? []).slice(0, 10), ...(c.categories ?? []).slice(0, 5)],
    data: {
      name: c.name,
      version,
      downloads: c.downloads,
      recentDownloads: c.recent_downloads,
      repository: c.repository ?? null,
      homepage: c.homepage ?? null,
      documentation: c.documentation ?? null,
      created: c.created_at,
    },
  };
}

export const crates = defineAdapter({
  name: 'crates',
  title: 'crates.io',
  collection: 'packages',
  description: 'Every crate published or updated on crates.io, newest first. Keyless.',
  docs: 'https://crates.io/data-access',
  kinds: ['version'],
  cadenceMinutes: 10,
  configFields: [
    { key: 'pages', label: 'Pages of 100', type: 'number', placeholder: '2' },
    { key: 'match', label: 'Only names matching', placeholder: 'mcp' },
  ],
  defaults: { pages: 2 },
  defaultSources: [{ slug: 'crates', name: 'crates.io: latest' }],
  async pull({ config, http, log }) {
    const pages = Math.min(Math.max(1, Number(config.pages) || 2), 10);
    const match = String(config.match ?? '').toLowerCase();
    const items = [];
    for (let p = 1; p <= pages; p++) {
      const res = await http.json(
        `https://crates.io/api/v1/crates?sort=recent-updates&per_page=100&page=${p}`,
      );
      for (const c of res.crates ?? []) if (!match || c.name.includes(match)) items.push(toItem(c));
      await Bun.sleep(1000);
    }
    log(`${items.length} crate(s)`);
    return { items, note: `${items.length} crates` };
  },
});
