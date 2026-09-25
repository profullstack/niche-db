import { defineAdapter, slugify } from '@nichedb/core/adapter';

/**
 * claude-code-templates (aitmpl.com): the largest single pile of components.
 *
 * It publishes `docs/components.json`, an index of everything the installer
 * can drop into a project. Measured on 2026-09-25: 889 skills, 422 subagents,
 * 288 slash commands, 104 MCP server configs, 72 settings bundles, 62 hooks,
 * 29 mods, 18 loops and 14 project templates — and a `downloads` count per
 * component, which is the only install signal in this collection.
 *
 * Two adapters read the one file because a component that configures an MCP
 * server belongs with the MCP servers and the other seven kinds belong with
 * the workflows, and an adapter writes into exactly one collection. They are
 * deliberately not one adapter with a switch: a source is what a reader
 * follows, and "MCP configs from aitmpl" and "subagents from aitmpl" are two
 * different things to follow.
 *
 * The file is 2 MB, so both run on a slow cadence. Two groups are deliberately
 * not ingested: `sandbox`, whose entries are documentation rather than
 * components and whose `type` arrives truncated to `sandbo`, and `templates`,
 * which are project scaffolds and the only group with no `path` — all 14 of
 * them would land on one URL, and in a collection that deduplicates on URL
 * that is 13 rows discarded to publish one that links nowhere useful.
 */

const INDEX =
  'https://raw.githubusercontent.com/davila7/claude-code-templates/main/docs/components.json';
const REPO = 'https://github.com/davila7/claude-code-templates';
const BLOB = `${REPO}/blob/main/cli-tool/components`;

/** The groups in components.json this collection wants, and what each row is. */
export const WORKFLOW_GROUPS = new Map([
  ['skills', 'skill'],
  ['agents', 'agent'],
  ['commands', 'command'],
  ['hooks', 'hook'],
  ['settings', 'setting'],
  ['loops', 'loop'],
  ['mods', 'mod'],
]);

export function toItem(c, { group, kind }) {
  const name = String(c?.name ?? '').trim();
  if (!name) return null;
  // A component addresses one file or one directory in the repository. Without
  // a path there is nothing to link to but the group, which every other
  // component in that group would link to as well, so it is not a row.
  const path = String(c.path ?? '').trim();
  if (!path) return null;
  const url = `${BLOB}/${group}/${path}`;

  return {
    externalId: `aitmpl:${group}:${path}`,
    kind,
    title: name.replace(/[-_]/g, ' ').slice(0, 200),
    summary:
      String(c.description ?? '')
        .replace(/^["']|["']$/g, '')
        .replace(/\s+/g, ' ')
        .trim() || null,
    url,
    publishedAt: null,
    tags: [
      kind,
      'claude-code',
      'aitmpl',
      c.category ? slugify(c.category) : null,
      ...(Array.isArray(c.keywords) ? c.keywords.slice(0, 10).map((k) => slugify(k)) : []),
    ].filter(Boolean),
    data: {
      name,
      component: kind,
      group,
      path,
      category: c.category ?? null,
      author: c.author || null,
      repo: c.repo || REPO,
      version: c.version || null,
      license: c.license || null,
      // How many times the installer has fetched it.
      downloads: Number.isFinite(c.downloads) ? c.downloads : null,
      securityValidated: c.security?.validated === true,
      securityScore: c.security?.score ?? null,
      install: `npx claude-code-templates@latest --${kind} ${c.category ? `${c.category}/` : ''}${name}`,
    },
  };
}

async function load(http) {
  const index = await http.json(INDEX, { timeoutMs: 60_000 });
  if (!index || typeof index !== 'object') throw new Error('components.json is not an object');
  return index;
}

export const aitmplComponents = defineAdapter({
  name: 'aitmpl-components',
  title: 'Claude Code components (aitmpl)',
  collection: 'workflows',
  description:
    'Skills, subagents, slash commands, hooks, settings bundles, loops and mods from claude-code-templates, with the install count and the one-line command that installs each. Around 1,780 components, keyless.',
  docs: 'https://aitmpl.com',
  kinds: [...new Set(WORKFLOW_GROUPS.values())],
  cadenceMinutes: 60 * 8,
  defaults: {},
  defaultSources: [{ slug: 'aitmpl-components', name: 'Claude Code components' }],
  async pull({ http, log }) {
    const index = await load(http);
    const items = [];
    for (const [group, kind] of WORKFLOW_GROUPS) {
      for (const c of index[group] ?? []) {
        const item = toItem(c, { group, kind });
        if (item) items.push(item);
      }
    }
    log(`${items.length} components across ${WORKFLOW_GROUPS.size} groups`);
    return { items, note: `${items.length} component(s)` };
  },
});

export const aitmplMcps = defineAdapter({
  name: 'aitmpl-mcps',
  title: 'MCP configs (aitmpl)',
  collection: 'mcp',
  description:
    'The MCP servers claude-code-templates ships a ready-made config for, with the install count for each. One file, keyless; the servers themselves are elsewhere in this collection, so most of these rows are dropped as duplicates and what is left is what only this list carries.',
  docs: 'https://aitmpl.com',
  kinds: ['mcp-config'],
  cadenceMinutes: 60 * 12,
  defaults: {},
  defaultSources: [{ slug: 'aitmpl-mcps', name: 'MCP configs on aitmpl' }],
  async pull({ http, log }) {
    const index = await load(http);
    const items = [];
    for (const c of index.mcps ?? []) {
      const item = toItem(c, { group: 'mcps', kind: 'mcp-config' });
      if (item) {
        item.tags = ['mcp', ...item.tags.filter((t) => t !== 'mcp-config')];
        items.push(item);
      }
    }
    log(`${items.length} MCP configs`);
    return { items, note: `${items.length} MCP config(s)` };
  },
});
