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

export const REGISTRY = 'https://registry.modelcontextprotocol.io/v0/servers';
/** How often the whole registry is walked again, so edits and deletions land. */
export const FULL_WALK_EVERY_MS = 7 * 86_400_000;
/** Leave this much of the run's deadline for the last batch to be written. */
const DEADLINE_MARGIN_MS = 20_000;

/** One page of the registry, newest version per server only, deleted servers dropped. */
async function page(http, params) {
  const res = await http.json(`${REGISTRY}?${new URLSearchParams(params)}`);
  const entries = (res.servers ?? []).filter(
    (e) => e._meta?.['io.modelcontextprotocol.registry/official']?.status !== 'deleted',
  );
  return {
    entries,
    seen: (res.servers ?? []).length,
    next: res.metadata?.nextCursor ?? res.metadata?.next_cursor ?? null,
  };
}

/** One retry, a second later: a single slow page is not a broken registry. */
async function pageWithRetry(http, params) {
  try {
    return await page(http, params);
  } catch {
    await new Promise((r) => setTimeout(r, 1000));
    return page(http, params);
  }
}

/**
 * What this run does, from the cursor the last one left.
 *
 * - `walk`: the full backfill. `version=latest` gives one entry per server
 *   (70,100 of them on 2026-11-22, 702 pages), walked in registry order, the
 *   registry's own cursor saved after every page, so a run that hits its
 *   deadline or dies resumes on the next page instead of starting over. The
 *   old pull fetched three pages from the top every time and so only ever saw
 *   the alphabetically first ~300 versions.
 * - `since`: once a walk has finished, only what changed (`updated_since`, the
 *   start of the previous run) until the full walk is due again.
 *
 * @returns {{ mode: 'walk' | 'since', state: object }}
 */
export function plan(cursor, now = Date.now()) {
  const c = cursor?.v === 2 ? cursor : {};
  if (c.walking) return { mode: 'walk', state: c };
  const due = !c.fullAt || now - Date.parse(c.fullAt) > FULL_WALK_EVERY_MS || !c.since;
  if (due)
    return {
      mode: 'walk',
      state: {
        v: 2,
        walking: true,
        next: null,
        walkStarted: new Date(now).toISOString(),
        fullAt: c.fullAt ?? null,
      },
    };
  return { mode: 'since', state: c };
}

export const mcpRegistry = defineAdapter({
  name: 'mcp-registry',
  title: 'MCP server registry',
  collection: 'mcp',
  description:
    'Every server published to the official Model Context Protocol registry, at its newest version, with its packages and remote endpoints: backfilled in full, then kept current from what changed. Keyless.',
  docs: 'https://registry.modelcontextprotocol.io/docs',
  kinds: ['mcp-server'],
  cadenceMinutes: 30,
  configFields: [{ key: 'search', label: 'Search', placeholder: 'github' }],
  defaults: {},
  defaultSources: [{ slug: 'mcp-servers', name: 'MCP: official registry' }],
  async *pull({ config, cursor, http, log, deadline = Infinity }) {
    const started = new Date().toISOString();
    const base = { limit: '100', version: 'latest' };

    // A source with a search term is a narrow slice: walk it whole every run.
    if (config.search) {
      const items = [];
      let next = null;
      do {
        const p = await page(http, {
          ...base,
          search: String(config.search),
          ...(next ? { cursor: next } : {}),
        });
        for (const e of p.entries) items.push(toItem(e));
        next = p.next;
      } while (next && Date.now() < deadline - DEADLINE_MARGIN_MS);
      const rows = collapse(items);
      yield { items: rows };
      return { note: `${rows.length} server(s) matching "${config.search}"` };
    }

    const { mode, state } = plan(cursor);

    if (mode === 'walk') {
      let s = state;
      let pages = 0;
      let servers = 0;
      for (;;) {
        if (Date.now() > deadline - DEADLINE_MARGIN_MS) {
          log(`backfill paused after ${pages} page(s), ${servers} server(s); resumes at ${s.next}`);
          return {
            cursor: s,
            note: `backfill: ${servers} server(s) in ${pages} page(s), continuing`,
            nextInMinutes: 1,
          };
        }
        let p;
        try {
          p = await pageWithRetry(http, { ...base, ...(s.next ? { cursor: s.next } : {}) });
        } catch (err) {
          // Nothing fetched this run: the upstream is down, let the crawler rule flag it.
          if (pages === 0) throw err;
          // Hundreds of pages answered and one would not: keep what was walked and carry
          // on from this page at the normal cadence instead of parking a 700-page walk.
          log(`page at ${s.next} failed twice (${err?.message ?? err}); resuming there next run`);
          return {
            cursor: s,
            note: `backfill: ${servers} server(s) in ${pages} page(s), stopped at a failing page: ${String(err?.message ?? err).slice(0, 120)}`,
          };
        }
        pages++;
        const rows = collapse(p.entries.map(toItem));
        servers += rows.length;
        if (!p.next) {
          // The walk is complete: changes since it started are what the next run asks for.
          s = { v: 2, walking: false, fullAt: s.walkStarted, since: s.walkStarted };
          yield { items: rows, cursor: s };
          log(`backfill complete: ${servers} server(s) this run`);
          return {
            cursor: s,
            note: `backfill complete: ${servers} server(s) in ${pages} page(s) this run`,
          };
        }
        s = { ...s, next: p.next };
        yield { items: rows, cursor: s };
      }
    }

    // Incremental: everything updated since the previous run started.
    const items = [];
    let next = null;
    let seen = 0;
    do {
      const p = await pageWithRetry(http, {
        ...base,
        updated_since: state.since,
        ...(next ? { cursor: next } : {}),
      });
      for (const e of p.entries) items.push(toItem(e));
      seen += p.seen;
      next = p.next;
    } while (next && Date.now() < deadline - DEADLINE_MARGIN_MS);
    const rows = collapse(items);
    // If the deadline cut the walk short, ask again from the same point rather than skip changes.
    const s = next ? state : { ...state, since: started };
    for (let i = 0; i < rows.length; i += 500) yield { items: rows.slice(i, i + 500) };
    log(`${rows.length} server(s) updated since ${state.since}`);
    return {
      cursor: s,
      note: `${rows.length} server(s) updated since ${state.since} (${seen} entries)`,
    };
  },
});
