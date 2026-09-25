import { defineAdapter, slugify } from '@nichedb/core/adapter';
import { parseMarkdownList, repoSlug } from './catalogs.js';

/**
 * The hand-curated MCP server lists, read as data.
 *
 * The official registry knows what has been PUBLISHED to it. The awesome lists
 * know what people actually use, which is a different and larger set: measured
 * on 2026-09-25, punkpeye/awesome-mcp-servers alone carried 4,281 entries and
 * the four lists together 4,761, of which 4,507 were distinct once URLs were
 * folded. They are also the only place a server that lives inside a monorepo,
 * or behind a hosted endpoint with no package at all, gets named.
 *
 * Every one of them is a README in a public repo, so this is one request per
 * list per run and no key anywhere. The lists disagree about markdown dialect
 * and about nothing else; `parseMarkdownList` absorbs the dialect.
 *
 * WHAT IS DELIBERATELY DROPPED
 *
 * Half of an "awesome MCP servers" list is not MCP servers: clients, SDKs,
 * frameworks, tutorials, a legend explaining the emoji, a sponsor table and a
 * table of contents. `skipSections` names the headings whose entries are not
 * what this collection collects, per source, because each list files its
 * non-servers under different words.
 *
 * The duplicates between lists are NOT dropped here. The collection has
 * `dedupe_urls` set, so the core drops an entry another source in the
 * collection already carries, and the winner is whichever source ran first —
 * which is why the official registry is seeded ahead of these.
 */

/** Headings whose entries are not servers, in the words the lists use. */
export const SKIP_SECTIONS = [
  'client',
  'framework',
  'sdk',
  'tutorial',
  'tips',
  'legend',
  'contribut',
  'star history',
  'table of contents',
  'sponsor',
  'community',
  'what is mcp',
  'getting started',
  'related',
  'other resources',
];

export function toItem(entry, { list }) {
  const slug = repoSlug(entry.url);
  const title = entry.title.includes('/') && slug ? entry.title.split('/').pop() : entry.title;
  const where = [entry.section, entry.subsection].filter(Boolean);

  return {
    externalId: entry.url,
    kind: 'mcp-server',
    title: title.slice(0, 200),
    summary: entry.description || null,
    url: entry.url,
    // A list entry has no date. The row is new when we first saw it, which is
    // what the default ordering uses; inventing a publication date here would
    // claim the list said something it did not.
    publishedAt: null,
    tags: [
      'mcp',
      'awesome-list',
      list,
      slug ? 'github' : 'hosted',
      ...where.map((w) => slugify(w)).filter(Boolean),
    ],
    data: {
      repo: slug,
      list,
      section: entry.section || null,
      subsection: entry.subsection ?? null,
      listedAs: entry.title,
    },
  };
}

export const awesomeMcp = defineAdapter({
  name: 'awesome-mcp',
  title: 'Curated MCP server lists',
  collection: 'mcp',
  description:
    'MCP servers as the big community lists carry them: punkpeye, wong2 and appcypher, plus the reference servers in the protocol repo itself. One README per source, no key, and the entries other sources already carry are dropped by the collection rather than stored twice.',
  docs: 'https://github.com/punkpeye/awesome-mcp-servers',
  kinds: ['mcp-server'],
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
      help: 'Relative links in the README resolve against this. The protocol repo links its own servers as src/git.',
      placeholder: 'https://github.com/owner/repo/blob/main/',
    },
    {
      key: 'list',
      label: 'List name',
      help: 'Tagged on every row so a reader can follow one list.',
      placeholder: 'punkpeye',
    },
    {
      key: 'skipSections',
      label: 'Headings to skip',
      type: 'list',
      help: 'Lowercase fragments. An entry under a matching heading is not ingested.',
    },
  ],
  defaults: { skipSections: SKIP_SECTIONS },
  defaultSources: [
    {
      slug: 'awesome-mcp-punkpeye',
      name: 'MCP servers: punkpeye list',
      config: {
        url: 'https://raw.githubusercontent.com/punkpeye/awesome-mcp-servers/main/README.md',
        base: 'https://github.com/punkpeye/awesome-mcp-servers/blob/main/',
        list: 'punkpeye',
      },
    },
    {
      slug: 'awesome-mcp-wong2',
      name: 'MCP servers: wong2 list',
      config: {
        url: 'https://raw.githubusercontent.com/wong2/awesome-mcp-servers/main/README.md',
        base: 'https://github.com/wong2/awesome-mcp-servers/blob/main/',
        list: 'wong2',
      },
    },
    {
      slug: 'awesome-mcp-appcypher',
      name: 'MCP servers: appcypher list',
      config: {
        url: 'https://raw.githubusercontent.com/appcypher/awesome-mcp-servers/main/README.md',
        base: 'https://github.com/appcypher/awesome-mcp-servers/blob/main/',
        list: 'appcypher',
      },
    },
    {
      slug: 'awesome-mcp-reference',
      name: 'MCP reference servers',
      config: {
        url: 'https://raw.githubusercontent.com/modelcontextprotocol/servers/main/README.md',
        base: 'https://github.com/modelcontextprotocol/servers/blob/main/',
        list: 'modelcontextprotocol',
        // Its H1 is the page title, and the links directly under it are the
        // language SDKs rather than servers.
        skipSections: [...SKIP_SECTIONS, 'model context protocol servers'],
      },
    },
  ],
  async pull({ config, http, log }) {
    const url = String(config.url ?? '').trim();
    if (!url) throw new Error('awesome-mcp needs a README URL');
    const list = slugify(String(config.list ?? '')) || 'list';

    const md = await http.text(url, { headers: { accept: 'text/plain, text/markdown, */*' } });
    const entries = parseMarkdownList(md, {
      base: config.base || undefined,
      skipSections: (config.skipSections ?? SKIP_SECTIONS).map((s) => String(s).toLowerCase()),
    });

    // One list can name the same server twice (an aggregator section and a
    // category section). First mention wins, as it does across sources.
    const seen = new Set();
    const items = [];
    for (const e of entries) {
      if (seen.has(e.url)) continue;
      seen.add(e.url);
      items.push(toItem(e, { list }));
    }

    log(`${items.length} servers from ${entries.length} entries`);
    return { items, note: `${items.length} server(s)` };
  },
});
