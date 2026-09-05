import { defineAdapter } from '@nichedb/core/adapter';

/** The official MCP server registry. Keyless, cursor paged. */
export function toItem(entry) {
  const s = entry.server ?? entry;
  const meta = entry._meta?.['io.modelcontextprotocol.registry/official'] ?? {};
  const remotes = (s.remotes ?? []).map((r) => r.url).filter(Boolean);
  const pkgs = (s.packages ?? []).map(
    (p) => `${p.registryType ?? p.registry_name ?? 'pkg'}:${p.identifier ?? p.name}`,
  );
  return {
    externalId: s.name,
    kind: 'mcp-server',
    title: s.title ? `${s.title} (${s.name})` : s.name,
    summary: s.description ?? null,
    url:
      s.repository?.url ??
      s.websiteUrl ??
      remotes[0] ??
      `https://registry.modelcontextprotocol.io/v0/servers/${encodeURIComponent(s.name)}`,
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
      remotes,
      packages: pkgs,
      status: meta.status ?? null,
      published: meta.publishedAt ?? null,
    },
  };
}

export const mcpRegistry = defineAdapter({
  name: 'mcp-registry',
  title: 'MCP server registry',
  collection: 'extensions',
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
    log(`${items.length} servers`);
    return { items, note: `${items.length} servers` };
  },
});
