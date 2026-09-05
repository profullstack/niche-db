import { defineAdapter } from '@nichedb/core/adapter';

/** The VS Code marketplace, newest published or updated first. Keyless gallery query. */
export function toItem(e) {
  const v = e.versions?.[0];
  const icon =
    (v?.files ?? []).find((f) => f.assetType === 'Microsoft.VisualStudio.Services.Icons.Default')
      ?.source ?? null;
  const stat = (n) => Number((e.statistics ?? []).find((s) => s.statisticName === n)?.value ?? 0);
  const id = `${e.publisher?.publisherName}.${e.extensionName}`;
  return {
    externalId: id,
    kind: 'extension',
    title: `${e.displayName} (${id})`,
    summary: e.shortDescription ?? null,
    url: `https://marketplace.visualstudio.com/items?itemName=${id}`,
    imageUrl: icon,
    publishedAt: e.lastUpdated ?? e.publishedDate,
    tags: [
      'vscode',
      ...(e.categories ?? []).map((c) => c.toLowerCase()).slice(0, 4),
      ...(e.tags ?? []).filter((t) => !t.startsWith('__')).slice(0, 6),
      e.publisher?.flags?.includes('verified') ? 'verified-publisher' : null,
    ].filter(Boolean),
    data: {
      id,
      publisher: e.publisher?.displayName ?? null,
      version: v?.version ?? null,
      installs: stat('install'),
      rating: stat('averagerating') || null,
      published: e.publishedDate ?? null,
    },
  };
}

export const vscodeExtensions = defineAdapter({
  name: 'vscode-extensions',
  title: 'VS Code extensions',
  collection: 'extensions',
  description:
    'Extensions published or updated on the Visual Studio Marketplace, with icon, categories and install counts. Keyless.',
  docs: 'https://marketplace.visualstudio.com/',
  kinds: ['extension'],
  cadenceMinutes: 30,
  configFields: [
    {
      key: 'sort',
      label: 'Sort',
      type: 'select',
      options: ['published', 'updated', 'installs'],
      required: true,
    },
    { key: 'q', label: 'Search', placeholder: 'mcp' },
  ],
  defaults: { sort: 'published' },
  defaultSources: [
    {
      slug: 'vscode-new-extensions',
      name: 'VS Code: new extensions',
      config: { sort: 'published' },
    },
  ],
  async pull({ config, http, log }) {
    const sortBy = { published: 10, updated: 1, installs: 4 }[config.sort] ?? 10;
    const criteria = [{ filterType: 8, value: 'Microsoft.VisualStudio.Code' }];
    if (config.q) criteria.push({ filterType: 10, value: String(config.q) });
    const res = await http.json(
      'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json;api-version=7.1-preview.1',
        },
        body: JSON.stringify({
          filters: [{ criteria, pageNumber: 1, pageSize: 100, sortBy, sortOrder: 0 }],
          flags: 914,
        }),
      },
    );
    const items = (res.results?.[0]?.extensions ?? []).map(toItem);
    log(`${items.length} extensions`);
    return { items, note: `${items.length} extensions` };
  },
});
