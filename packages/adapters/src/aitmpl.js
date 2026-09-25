import { defineAdapter, slugify } from '@nichedb/core/adapter';

/**
 * claude-code-templates (aitmpl.com): the largest single pile of components.
 *
 * It publishes `docs/components.json`, an index of everything the installer
 * can drop into a project. Measured on 2026-09-25: 889 skills, 422 subagents,
 * 288 slash commands, 104 MCP server configs, 72 settings bundles, 62 hooks,
 * 29 mods, 18 loops and 14 project templates — and a `downloads` count per
 * component, which is the only install signal in these collections.
 *
 * ONE FILE, SIX ADAPTERS
 *
 * A subagent, a skill, a slash command and a hook are four different things to
 * go looking for, so they are four collections, and an adapter writes into
 * exactly one. That makes this file a factory rather than one adapter with a
 * switch: each collection gets a source of its own, which is also what a
 * reader follows and what the run log reports on. The cost is that the same
 * 2 MB file is fetched once per collection, which is why the cadences are
 * slow and staggered rather than hourly.
 *
 * Two groups are deliberately not ingested: `sandbox`, whose entries are
 * documentation rather than components and whose `type` arrives truncated to
 * `sandbo`, and `templates`, which are project scaffolds and the only group
 * with no `path` — all 14 of them would land on one URL, and in a collection
 * that deduplicates on URL that is 13 rows discarded to publish one that links
 * nowhere useful.
 */

const INDEX =
  'https://raw.githubusercontent.com/davila7/claude-code-templates/main/docs/components.json';
const REPO = 'https://github.com/davila7/claude-code-templates';
const BLOB = `${REPO}/blob/main/cli-tool/components`;

/** Every group this file reads, and what one of its rows is. */
export const GROUP_KINDS = new Map([
  ['skills', 'skill'],
  ['agents', 'agent'],
  ['commands', 'command'],
  ['hooks', 'hook'],
  ['settings', 'setting'],
  ['loops', 'loop'],
  ['mods', 'mod'],
  ['mcps', 'mcp-config'],
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
  const flag = kind === 'mcp-config' ? 'mcp' : kind;

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
      flag,
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
      install: `npx claude-code-templates@latest --${flag} ${c.category ? `${c.category}/` : ''}${name}`,
    },
  };
}

/**
 * One adapter over the groups of components.json that belong in one
 * collection.
 *
 * @param {{ name: string, title: string, collection: string, groups: string[],
 *           description: string, cadenceMinutes: number }} spec
 */
function aitmplAdapter({ name, title, collection, groups, description, cadenceMinutes }) {
  return defineAdapter({
    name,
    title,
    collection,
    description,
    docs: 'https://aitmpl.com',
    kinds: [...new Set(groups.map((g) => GROUP_KINDS.get(g)))],
    cadenceMinutes,
    defaults: {},
    defaultSources: [{ slug: name, name: title }],
    async pull({ http, log }) {
      const index = await http.json(INDEX, { timeoutMs: 60_000 });
      if (!index || typeof index !== 'object') throw new Error('components.json is not an object');

      const items = [];
      for (const group of groups) {
        const kind = GROUP_KINDS.get(group);
        for (const c of index[group] ?? []) {
          const item = toItem(c, { group, kind });
          if (item) items.push(item);
        }
      }
      log(`${items.length} components from ${groups.join(', ')}`);
      return { items, note: `${items.length} component(s)` };
    },
  });
}

export const aitmplSkills = aitmplAdapter({
  name: 'aitmpl-skills',
  title: 'Skills (aitmpl)',
  collection: 'skills',
  groups: ['skills'],
  cadenceMinutes: 60 * 8,
  description:
    'The skills claude-code-templates ships, with the install count and the one-line command that installs each. Around 890 of them, keyless.',
});

export const aitmplAgents = aitmplAdapter({
  name: 'aitmpl-agents',
  title: 'Subagents (aitmpl)',
  collection: 'agents',
  groups: ['agents'],
  cadenceMinutes: 60 * 8,
  description:
    'The subagents claude-code-templates ships, by category, with the install count and the command that installs each. Around 420 of them, keyless.',
});

export const aitmplCommands = aitmplAdapter({
  name: 'aitmpl-commands',
  title: 'Slash commands (aitmpl)',
  collection: 'commands',
  groups: ['commands'],
  cadenceMinutes: 60 * 12,
  description:
    'The slash commands claude-code-templates ships, with the install count and the command that installs each. Around 290 of them, keyless.',
});

export const aitmplHooks = aitmplAdapter({
  name: 'aitmpl-hooks',
  title: 'Hooks (aitmpl)',
  collection: 'hooks',
  groups: ['hooks'],
  cadenceMinutes: 60 * 12,
  description:
    'The hooks claude-code-templates ships — what runs before and after a tool call, a prompt or a session — with the install count for each. Keyless.',
});

export const aitmplComponents = aitmplAdapter({
  name: 'aitmpl-components',
  title: 'Settings, loops and mods (aitmpl)',
  collection: 'workflows',
  groups: ['settings', 'loops', 'mods'],
  cadenceMinutes: 60 * 12,
  description:
    'The claude-code-templates components that are a way of working rather than a thing installed: settings bundles, agent loops and behaviour mods. The skills, subagents, commands and hooks from the same file have collections of their own.',
});

export const aitmplMcps = aitmplAdapter({
  name: 'aitmpl-mcps',
  title: 'MCP configs (aitmpl)',
  collection: 'mcp',
  groups: ['mcps'],
  cadenceMinutes: 60 * 12,
  description:
    'The MCP servers claude-code-templates ships a ready-made config for, with the install count for each. One file, keyless; the servers themselves are elsewhere in this collection, so most of these rows are dropped as duplicates and what is left is what only this list carries.',
});
