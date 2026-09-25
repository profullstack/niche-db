import { defineAdapter, slugify } from '@nichedb/core/adapter';
import { repoUrl } from './catalogs.js';

/**
 * Claude Code plugin marketplaces, read from the manifest that defines them.
 *
 * A marketplace is a repository with `.claude-plugin/marketplace.json` in it,
 * and that file is the authoritative list of what the repository installs:
 * name, description, version, author, licence and where each plugin lives.
 * It is the one source in this collection that is neither curated by a third
 * party nor scraped from prose — the publisher wrote it for machines, and
 * `claude plugin marketplace add` reads the same bytes.
 *
 * Measured on 2026-09-25: anthropics/claude-code declares 13 plugins,
 * wshobson/agents 94, VoltAgent 158 subagents as plugins. One request per
 * repository, no key, and `HEAD` in the raw URL so a repository that renamed
 * its default branch does not quietly 404.
 *
 * A plugin's `source` is usually a path inside the same repository
 * (`./plugins/documentation-standards`), sometimes an object pointing at
 * another repository. Both resolve to the URL of the thing itself rather than
 * of the marketplace, which keeps 94 plugins from all claiming one URL and
 * collapsing into a single row.
 */

const RAW = (repo, path) => `https://raw.githubusercontent.com/${repo}/HEAD/${path}`;
const MANIFEST = '.claude-plugin/marketplace.json';

/** Where a plugin actually lives, given the marketplace it was declared in. */
export function pluginUrl(source, repo) {
  if (source && typeof source === 'object') {
    const named = source.repo ?? source.url ?? null;
    if (!named) return `https://github.com/${repo}`;
    return repoUrl(String(named).startsWith('http') ? named : `https://github.com/${named}`);
  }
  const s = String(source ?? '').trim();
  if (!s) return `https://github.com/${repo}`;
  if (/^https?:/.test(s)) return repoUrl(s);
  const path = s.replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
  return path
    ? repoUrl(`https://github.com/${repo}/tree/HEAD/${path}`)
    : `https://github.com/${repo}`;
}

export function toItem(p, { repo, marketplace }) {
  const name = String(p?.name ?? '').trim();
  if (!name) return null;
  const url = pluginUrl(p.source, repo);
  if (!url) return null;

  const author =
    typeof p.author === 'string' ? p.author : (p.author?.name ?? p.author?.url ?? null);

  return {
    externalId: `plugin:${repo.toLowerCase()}:${name}`,
    kind: 'plugin',
    title: name.replace(/[-_]/g, ' ').slice(0, 200),
    summary: p.description ? String(p.description).replace(/\s+/g, ' ').trim() : null,
    url,
    publishedAt: null,
    tags: [
      'plugin',
      'claude-code',
      'marketplace',
      slugify(marketplace),
      ...String(repo).toLowerCase().split('/'),
      p.category ? slugify(p.category) : null,
      ...(Array.isArray(p.keywords) ? p.keywords.slice(0, 10).map((k) => slugify(k)) : []),
    ].filter(Boolean),
    data: {
      name,
      marketplace,
      marketplaceRepo: repo,
      source: typeof p.source === 'string' ? p.source : (p.source ?? null),
      version: p.version ?? null,
      author,
      authorUrl: p.author?.url ?? null,
      homepage: p.homepage ?? null,
      license: p.license ?? null,
      category: p.category ?? null,
      keywords: Array.isArray(p.keywords) ? p.keywords : [],
      install: `/plugin marketplace add ${repo}`,
    },
  };
}

export const pluginMarketplaces = defineAdapter({
  name: 'plugin-marketplaces',
  title: 'Claude Code plugin marketplaces',
  collection: 'plugins',
  description:
    'Every plugin declared in the marketplace manifests of the repositories you name, including the official one: what it installs, who wrote it, its version and licence, and the command that adds the marketplace. One request per repository, no key.',
  docs: 'https://docs.claude.com/en/docs/claude-code/plugins',
  kinds: ['plugin'],
  cadenceMinutes: 60 * 4,
  configFields: [
    {
      key: 'repos',
      label: 'Marketplace repositories',
      type: 'list',
      required: true,
      placeholder: 'anthropics/claude-code, wshobson/agents',
      help: 'owner/name. Each must have .claude-plugin/marketplace.json.',
    },
  ],
  defaults: {
    repos: ['anthropics/claude-code', 'wshobson/agents', 'VoltAgent/awesome-claude-code-subagents'],
  },
  defaultSources: [{ slug: 'claude-plugin-marketplaces', name: 'Claude Code plugins' }],
  async pull({ config, http, log }) {
    const repos = (config.repos ?? []).map((r) =>
      String(r)
        .trim()
        .replace(/^\/|\/$/g, ''),
    );
    if (!repos.length) throw new Error('plugin-marketplaces needs at least one repository');

    const items = [];
    const failed = [];
    for (const repo of repos) {
      const manifest = await http.jsonOrNull(RAW(repo, MANIFEST), { timeoutMs: 45_000 });
      const plugins = Array.isArray(manifest?.plugins) ? manifest.plugins : null;
      /*
       * A repository that has moved, renamed its manifest or never had one is
       * not a reason to fail the run and lose the marketplaces that answered.
       * It is a reason to say so in the note, which is where a stale entry in
       * the config becomes visible.
       */
      if (!plugins) {
        failed.push(repo);
        continue;
      }
      const marketplace = String(manifest.name ?? repo);
      for (const p of plugins) {
        const item = toItem(p, { repo, marketplace });
        if (item) items.push(item);
      }
    }

    log(
      `${items.length} plugins from ${repos.length - failed.length}/${repos.length} marketplaces`,
    );
    return {
      items,
      note: `${items.length} plugin(s)${failed.length ? `, no manifest at ${failed.join(', ')}` : ''}`,
    };
  },
});
