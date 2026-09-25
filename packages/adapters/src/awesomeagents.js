import { defineAdapter, slugify } from '@nichedb/core/adapter';
import { parseMarkdownList, repoSlug } from './catalogs.js';

/**
 * Subagent lists that name one subagent per line.
 *
 * The plugin marketplaces publish bundles — VoltAgent's manifest declares ten
 * of them — but its README lists the 165 subagents inside those bundles one
 * by one, with a description and a file to read. For a collection whose unit
 * is the subagent, the README is the better document, and nothing else
 * publishes the same thing in machine-readable form.
 *
 * The parse is the one the MCP lists use, so the dialect is somebody else's
 * problem; what is different here is the base, because these lists link
 * their subagents relatively (`categories/01-core-development/api-designer.md`)
 * and a relative link is not a row until it is resolved.
 */

/** Headings on a list of subagents whose entries are not subagents. */
export const SKIP_SECTIONS = [
  'install',
  'contribut',
  'star history',
  'table of contents',
  'license',
  'getting started',
  'usage',
  'why',
  'community',
  'about',
  'resources',
  'related',
];

export function toItem(entry, { list }) {
  const where = [entry.section, entry.subsection].filter(Boolean);
  return {
    externalId: entry.url,
    kind: 'agent',
    title: entry.title.replace(/[-_]/g, ' ').slice(0, 200),
    summary: entry.description || null,
    url: entry.url,
    publishedAt: null,
    tags: ['agent', 'claude-code', list, ...where.map((w) => slugify(w)).filter(Boolean)].filter(
      Boolean,
    ),
    data: {
      name: entry.title,
      list,
      repo: repoSlug(entry.url),
      section: entry.section || null,
      subsection: entry.subsection ?? null,
    },
  };
}

export const awesomeAgents = defineAdapter({
  name: 'awesome-agents',
  title: 'Curated subagent lists',
  collection: 'agents',
  description:
    'Subagents as the community lists carry them, one row per subagent with the category it was filed under and the file that defines it. One README per source, no key.',
  docs: 'https://github.com/VoltAgent/awesome-claude-code-subagents',
  kinds: ['agent'],
  cadenceMinutes: 60 * 6,
  configFields: [
    {
      key: 'url',
      label: 'README URL',
      required: true,
      placeholder: 'https://raw.githubusercontent.com/owner/repo/main/README.md',
    },
    {
      key: 'base',
      label: 'Link base',
      help: 'Relative links resolve against this. These lists link their subagents by path.',
      placeholder: 'https://github.com/owner/repo/blob/main/',
    },
    { key: 'list', label: 'List name', placeholder: 'voltagent' },
    { key: 'skipSections', label: 'Headings to skip', type: 'list' },
  ],
  defaults: { skipSections: SKIP_SECTIONS },
  defaultSources: [
    {
      slug: 'awesome-subagents-voltagent',
      name: 'Subagents: VoltAgent list',
      config: {
        url: 'https://raw.githubusercontent.com/VoltAgent/awesome-claude-code-subagents/main/README.md',
        base: 'https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/',
        list: 'voltagent',
      },
    },
  ],
  async pull({ config, http, log }) {
    const url = String(config.url ?? '').trim();
    if (!url) throw new Error('awesome-agents needs a README URL');
    const list = slugify(String(config.list ?? '')) || 'list';

    const md = await http.text(url, { headers: { accept: 'text/plain, text/markdown, */*' } });
    const entries = parseMarkdownList(md, {
      base: config.base || undefined,
      skipSections: (config.skipSections ?? SKIP_SECTIONS).map((s) => String(s).toLowerCase()),
    });

    const seen = new Set();
    const items = [];
    for (const e of entries) {
      if (seen.has(e.url)) continue;
      seen.add(e.url);
      items.push(toItem(e, { list }));
    }

    log(`${items.length} subagents from ${entries.length} entries`);
    return { items, note: `${items.length} subagent(s)` };
  },
});
