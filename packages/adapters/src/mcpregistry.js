import { defineAdapter } from '@nichedb/core/adapter';
import { repoSlug, repoUrl } from './catalogs.js';

/** A server's own page in the registry: unique per name, always resolvable. */
const registryPage = (name) =>
  `https://registry.modelcontextprotocol.io/v0/servers/${encodeURIComponent(name)}`;

/**
 * The official MCP server registry. Keyless, cursor paged.
 *
 * The one source here that is a publication rather than a list: a server is in
 * it because its author published it, with a version, a status and the
 * packages it ships. That is why it is seeded first — the collection drops a
 * URL another source already claimed, so whoever runs first owns the row, and
 * the registry's account of a server is the one worth keeping.
 *
 * The repository URL is folded to the comparable form (`repoUrl`) so that the
 * same server arriving from an awesome list, from Docker or from Smithery
 * lands on this row rather than beside it, and the declared `subfolder` is
 * kept, because a dozen servers publishing from one monorepo are a dozen
 * servers.
 *
 * TWO THINGS THE FEED DOES THAT A ROW MUST NOT
 *
 * It lists every published VERSION as its own entry — `ac.tandem/docs-mcp`
 * appears at 0.3.0, 0.3.1 and 0.3.2 — and this collection wants one row per
 * server, at its newest version. And some publishers put a repository URL in
 * that is not theirs: three unrelated `agency.ottobot/*` servers name
 * `modelcontextprotocol/registry` itself, and four `ai.agentlookups/*` servers
 * share one repository. Measured on 2026-09-25 those two between them turned
 * 300 entries into 174 distinct URLs, which in a collection that deduplicates
 * on URL means 126 published servers silently discarded.
 *
 * `collapse` handles both: newest version per name, and a URL that more than
 * one server name claims identifies none of them, so those fall back to their
 * own registry page — which is unique per name, and honest about what is
 * known.
 */
export function toItem(entry) {
  const s = entry.server ?? entry;
  const meta = entry._meta?.['io.modelcontextprotocol.registry/official'] ?? {};
  const remotes = (s.remotes ?? []).map((r) => r.url).filter(Boolean);
  const pkgs = (s.packages ?? []).map(
    (p) => `${p.registryType ?? p.registry_name ?? 'pkg'}:${p.identifier ?? p.name}`,
  );
  const sub = String(s.repository?.subfolder ?? '')
    .replace(/^\.?\//, '')
    .replace(/\/+$/, '');
  const repo = repoUrl(
    sub && s.repository?.url
      ? `${String(s.repository.url).replace(/\/+$/, '')}/tree/HEAD/${sub}`
      : s.repository?.url,
  );
  return {
    externalId: s.name,
    kind: 'mcp-server',
    title: s.title ? `${s.title} (${s.name})` : s.name,
    summary: s.description ?? null,
    url: repo ?? repoUrl(s.websiteUrl) ?? remotes[0] ?? registryPage(s.name),
    publishedAt: meta.updatedAt ?? meta.publishedAt ?? null,
    tags: [
      'mcp',
      'registry',
      remotes.length ? 'remote' : null,
      pkgs.length ? 'package' : null,
      meta.status ?? null,
      ...pkgs.map((p) => p.split(':')[0]),
    ].filter(Boolean),
    data: {
      name: s.name,
      version: s.version ?? null,
      repository: s.repository?.url ?? null,
      subfolder: sub || null,
      repo: repoSlug(repo ?? ''),
      remotes,
      packages: pkgs,
      status: meta.status ?? null,
      published: meta.publishedAt ?? null,
    },
  };
}

/**
 * One row per server, at its newest version, on a URL that names only it.
 *
 * Versions arrive in publish order, so the last entry for a name is the newest
 * one; where both carry a date the date decides instead, so a feed that stops
 * being ordered does not quietly pin a server to an old version.
 *
 * @param {object[]} items
 * @returns {object[]}
 */
export function collapse(items) {
  const byName = new Map();
  for (const it of items) {
    if (!it?.externalId) continue;
    const have = byName.get(it.externalId);
    if (!have || !have.publishedAt || !it.publishedAt || it.publishedAt >= have.publishedAt) {
      byName.set(it.externalId, it);
    }
  }

  const rows = [...byName.values()];
  const claims = new Map();
  for (const it of rows) claims.set(it.url, (claims.get(it.url) ?? 0) + 1);

  for (const it of rows) {
    if ((claims.get(it.url) ?? 0) > 1) {
      it.data = { ...it.data, sharedRepository: it.url };
      it.url = registryPage(it.data.name ?? it.externalId);
    }
  }
  return rows;
}

export const mcpRegistry = defineAdapter({
  name: 'mcp-registry',
  title: 'MCP server registry',
  collection: 'mcp',
  description:
    'Servers published to the official Model Context Protocol registry, newest first, with their packages and remote endpoints. Keyless.',
  docs: 'https://registry.modelcontextprotocol.io/docs',
  kinds: ['mcp-server'],
  cadenceMinutes: 30,
  configFields: [{ key: 'search', label: 'Search', placeholder: 'github' }],
  defaults: {},
  defaultSources: [{ slug: 'mcp-servers', name: 'MCP: newly registered servers' }],
  async pull({ config, http, log }) {
    const items = [];
    let cursor = null;
    for (let p = 0; p < 3; p++) {
      const params = new URLSearchParams({ limit: '100' });
      if (config.search) params.set('search', String(config.search));
      if (cursor) params.set('cursor', cursor);
      const res = await http.json(`https://registry.modelcontextprotocol.io/v0/servers?${params}`);
      for (const e of res.servers ?? []) items.push(toItem(e));
      cursor = res.metadata?.nextCursor ?? res.metadata?.next_cursor ?? null;
      if (!cursor) break;
    }
    const rows = collapse(items);
    log(`${rows.length} servers from ${items.length} published versions`);
    return { items: rows, note: `${rows.length} server(s) of ${items.length} version(s)` };
  },
});
