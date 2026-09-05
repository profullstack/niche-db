import { defineAdapter, first, xmlItems } from '@nichedb/core/adapter';

/** PyPI publishes two RSS feeds: the last hundred releases, and the newest projects. Keyless. */
export function parseUpdates(xml, kind) {
  const out = [];
  for (const it of xmlItems(xml, 'item')) {
    const title = first(it.title)?.text ?? '';
    const link = first(it.link)?.text ?? '';
    const m = title.match(/^(\S+)\s+(\S+)$/);
    const name = m ? m[1] : title;
    const version = m ? m[2] : null;
    if (!name) continue;
    out.push({
      externalId: version ? `${name}@${version}` : name,
      kind,
      title: version ? `${name} ${version}` : name,
      summary: first(it.description)?.text || null,
      url: link || `https://pypi.org/project/${name}/`,
      publishedAt: first(it.pubDate)?.text || null,
      tags: ['pypi'],
      data: { name, version },
    });
  }
  return out;
}

export const pypi = defineAdapter({
  name: 'pypi',
  title: 'PyPI',
  collection: 'packages',
  description:
    'Every release on the Python Package Index, from its RSS feeds: the latest hundred releases and the newest projects. Keyless.',
  docs: 'https://docs.pypi.org/api/feeds/',
  kinds: ['version', 'package'],
  cadenceMinutes: 5,
  configFields: [
    { key: 'match', label: 'Only names matching', placeholder: 'mcp', help: 'Optional substring.' },
  ],
  defaults: {},
  defaultSources: [{ slug: 'pypi', name: 'PyPI: latest releases' }],
  async pull({ config, http, log }) {
    const [updates, packages] = await Promise.all([
      http.text('https://pypi.org/rss/updates.xml'),
      http.text('https://pypi.org/rss/packages.xml'),
    ]);
    const match = String(config.match ?? '').toLowerCase();
    let items = [...parseUpdates(updates, 'version'), ...parseUpdates(packages, 'package')];
    if (match) items = items.filter((i) => i.data.name.toLowerCase().includes(match));
    log(`${items.length} item(s)`);
    return { items, note: `${items.length} from two feeds` };
  },
});
