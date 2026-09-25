import { defineAdapter } from '@nichedb/core/adapter';
import { repoSlug, repoUrl } from './catalogs.js';

/**
 * Smithery's registry: the servers people are actually installing.
 *
 * Smithery hosts and proxies MCP servers, so unlike a list of repositories it
 * knows `useCount` — how many times a server has been called through it — and
 * whether the thing is deployed and reachable right now. That is the one
 * signal in this collection that comes from usage rather than from curation.
 *
 * TWO MEASURED LIMITS (2026-09-25), both of which shape the walk:
 *
 *   * The anonymous listing stops at 500 rows. `pagination.totalCount` says
 *     17,195 and `totalPages` says 5 at `pageSize=100`; page 6 and every page
 *     after it comes back empty. So a plain sweep reaches the most-used 500
 *     and no further, however politely it asks.
 *   * `?q=` is a real filter with its own pagination — `q=database` reports
 *     174 rows across 2 pages — so a list of category words reaches past the
 *     500 that the unfiltered listing will admit to. That is what `queries`
 *     is: not search, a partition.
 *
 * The cursor is a position in (query, page) and the sweep restarts when it
 * runs off the end, because a registry with no date ordering gives no way to
 * ask only for what is new.
 *
 * The URL is the server's repository when Smithery knows one, and its Smithery
 * page otherwise. Never the vendor homepage: `brave.com/search/api` is the
 * homepage of one server today and of three tomorrow, and this collection
 * deduplicates on URL, so a shared marketing page would silently swallow
 * servers that are genuinely different.
 */

const BASE = 'https://registry.smithery.ai/servers';

/** Category words that partition the registry past the 500-row listing cap. */
export const QUERIES = [
  '',
  'database',
  'search',
  'github',
  'cloud',
  'api',
  'file',
  'browser',
  'ai',
  'crypto',
  'email',
  'calendar',
  'slack',
  'docs',
  'monitoring',
  'security',
  'payment',
  'data',
  'image',
  'video',
  'sql',
  'analytics',
  'automation',
  'maps',
  'weather',
  'finance',
];

export function toItem(s) {
  const name = String(s?.qualifiedName ?? '').trim();
  if (!name) return null;
  const page = `https://smithery.ai/server/${encodeURIComponent(name)}`;
  const home = repoUrl(s.homepage);
  const url = repoSlug(home ?? '') ? home : page;

  return {
    externalId: `smithery:${name}`,
    kind: 'mcp-server',
    title: String(s.displayName || name).slice(0, 200),
    summary: s.description ? String(s.description).replace(/\s+/g, ' ').trim() : null,
    url,
    imageUrl: s.iconUrl ?? null,
    publishedAt: s.createdAt ?? null,
    tags: [
      'mcp',
      'smithery',
      s.remote ? 'remote' : 'local',
      s.isDeployed ? 'deployed' : null,
      s.verified ? 'verified' : null,
      s.inactive ? 'inactive' : null,
      s.bySmithery ? 'first-party' : null,
      s.namespace ? String(s.namespace).toLowerCase() : null,
    ].filter(Boolean),
    data: {
      qualifiedName: name,
      namespace: s.namespace ?? null,
      smithery: page,
      homepage: s.homepage ?? null,
      repo: repoSlug(home ?? ''),
      useCount: Number.isFinite(s.useCount) ? s.useCount : null,
      remote: Boolean(s.remote),
      deployed: Boolean(s.isDeployed),
      verified: Boolean(s.verified),
      inactive: Boolean(s.inactive),
      createdAt: s.createdAt ?? null,
    },
  };
}

export const smithery = defineAdapter({
  name: 'smithery',
  title: 'Smithery MCP registry',
  collection: 'mcp',
  description:
    'Servers listed on Smithery, with how many times each has been called through its proxy, whether it is deployed and whether it is verified. Keyless. The anonymous listing stops at 500 rows, so the sweep partitions the registry by category word to reach further.',
  docs: 'https://smithery.ai/docs',
  kinds: ['mcp-server'],
  cadenceMinutes: 60 * 3,
  configFields: [
    {
      key: 'queries',
      label: 'Category words',
      type: 'list',
      help: 'Each is swept separately. Blank means the unfiltered listing.',
    },
    { key: 'pagesPerRun', label: 'Pages per run', type: 'number', placeholder: '8' },
    { key: 'pageSize', label: 'Page size', type: 'number', placeholder: '100' },
  ],
  defaults: { queries: QUERIES, pagesPerRun: 8, pageSize: 100 },
  defaultSources: [{ slug: 'smithery-servers', name: 'MCP servers on Smithery' }],
  async pull({ config, cursor, http, log }) {
    const queries = (config.queries?.length ? config.queries : QUERIES).map((q) => String(q ?? ''));
    const pageSize = Math.min(Math.max(Number(config.pageSize) || 100, 10), 100);
    const budget = Math.min(Math.max(Number(config.pagesPerRun) || 8, 1), 40);

    let qi = Math.min(Number(cursor?.queryIndex) || 0, queries.length - 1);
    let page = Math.max(Number(cursor?.page) || 1, 1);

    const items = [];
    const seen = new Set();
    let sweeps = 0;

    for (let n = 0; n < budget; n++) {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (queries[qi]) params.set('q', queries[qi]);
      const res = await http.json(`${BASE}?${params}`);
      const rows = Array.isArray(res?.servers) ? res.servers : [];

      for (const s of rows) {
        const item = toItem(s);
        if (!item || seen.has(item.externalId)) continue;
        seen.add(item.externalId);
        items.push(item);
      }

      // Empty, short, or past the reported end: this query is exhausted.
      const end = rows.length < pageSize || page >= (res?.pagination?.totalPages ?? page);
      if (!end) {
        page += 1;
        continue;
      }
      qi += 1;
      page = 1;
      if (qi >= queries.length) {
        qi = 0;
        sweeps += 1;
        break;
      }
    }

    const where = queries[qi] ? `q=${queries[qi]}` : 'the full listing';
    log(`${items.length} servers, next at ${where} page ${page}`);
    return {
      items,
      cursor: { queryIndex: qi, page },
      note: `${items.length} server(s)${sweeps ? ', sweep complete' : ''}`,
    };
  },
});
