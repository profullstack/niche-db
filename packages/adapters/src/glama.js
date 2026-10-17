import { defineAdapter } from '@nichedb/core/adapter';
import { repoSlug, repoUrl } from './catalogs.js';

/**
 * Glama's MCP server directory (glama.ai/mcp/servers), through its API.
 *
 * Glama is the largest of the curated directories and overlaps most of what
 * this collection already reads: it is itself built from the official
 * registry, the punkpeye awesome list and community submissions. So it is
 * registered LAST among the MCP sources, and its rows are keyed on the same
 * folded repository URL (`repoUrl`) as everybody else's. The collection drops
 * an item whose URL another source already carries, so what Glama adds is the
 * servers nobody else knew about, and the rest stay with the source that had
 * them first.
 *
 * TWO CONDITIONS OF USE, both from Glama's API Data License (the OpenAPI
 * document at glama.ai/api/mcp/openapi.json spells them out):
 *
 *   * A key is required (`Authorization: Bearer`), from glama.ai/settings/api-keys.
 *     The source is seeded paused without GLAMA_API_KEY.
 *   * Attribution. Every page that shows the data credits Glama with a plain
 *     (followed) link to https://glama.ai, and every server presented links to
 *     its own Glama listing, the `url` the API returns, in addition to whatever
 *     else the row links to. That is why every item carries `data.credit`
 *     ({ text, url, listing }): the site renders it beside the row wherever
 *     the row appears, and it travels with the item through the API and feeds.
 *
 * THE WALK. `GET /v1/servers?sort=added-at:desc` is the order Glama documents
 * for full catalogue synchronisation: newest first, forward-only cursors
 * (`after` = the previous page's `endCursor`, opaque, never parsed), and the
 * sort must not change while a cursor is followed. A run reads a capped number
 * of pages with a pause between them, saves the cursor, and comes back in half
 * an hour until `hasNextPage` is false; then the sweep starts again from the
 * newest on the daily cadence. The limit is 100 requests a second per IP and
 * ten consecutive 429s earn a ban that does not lift by itself, so this runs
 * at one request a second, reads `RateLimit-Remaining`, and stops the run
 * (keeping its place) at the first 429 or 403 rather than retrying into one.
 */

const BASE = 'https://glama.ai/api/mcp/v1/servers';

/** What every Glama-sourced row must show, per the API Data License. */
export const CREDIT = Object.freeze({
  name: 'Glama',
  text: 'MCP data from Glama',
  url: 'https://glama.ai',
});

/** The server's own listing on Glama, which the licence requires a link to. */
export const listingUrl = (s) =>
  s?.url ||
  (s?.namespace && s?.slug
    ? `https://glama.ai/mcp/servers/${encodeURIComponent(s.namespace)}/${encodeURIComponent(s.slug)}`
    : null);

const HOSTING = {
  'hosting:local-only': 'local',
  'hosting:remote-capable': 'remote',
  'hosting:hybrid': 'hybrid',
};

/**
 * One Glama server as a collection row.
 *
 * The URL is the repository, folded, when Glama knows one: that is the key the
 * other sources agree on. Without one it is the Glama listing, which is unique
 * per server. Tool input schemas are left behind (a page of a hundred servers
 * runs to megabytes of them); the names say what a server does.
 */
export function toItem(s) {
  const id = String(s?.id ?? '').trim();
  const listing = listingUrl(s);
  if (!id || !listing) return null;
  const repo = repoUrl(s.repository?.url);
  const attrs = Array.isArray(s.attributes) ? s.attributes : [];
  const tools = (Array.isArray(s.tools) ? s.tools : []).map((t) => t?.name).filter(Boolean);
  const env = s.environmentVariablesJsonSchema?.properties
    ? Object.keys(s.environmentVariablesJsonSchema.properties)
    : [];
  const license = s.spdxLicense?.name ?? null;
  const name = String(s.name || `${s.namespace}/${s.slug}`).trim();

  return {
    externalId: `glama:${id}`,
    kind: 'mcp-server',
    title: name.slice(0, 200),
    summary: s.description ? String(s.description).replace(/\s+/g, ' ').trim() : null,
    url: repo ?? listing,
    imageUrl: s.thumbnailUrl ?? null,
    tags: [
      'mcp',
      'glama',
      ...attrs.map((a) => HOSTING[a]),
      attrs.includes('author:official') ? 'official' : null,
      tools.length ? 'tools' : null,
      s.namespace ? String(s.namespace).toLowerCase() : null,
    ].filter(Boolean),
    data: {
      glamaId: id,
      namespace: s.namespace ?? null,
      slug: s.slug ?? null,
      glama: listing,
      repository: s.repository?.url ?? null,
      repo: repoSlug(repo ?? ''),
      license,
      qualityScore: Number.isFinite(s.qualityScore) ? s.qualityScore : null,
      attributes: attrs,
      toolCount: tools.length,
      tools: tools.slice(0, 50),
      envVars: env.slice(0, 50),
      credit: { ...CREDIT, listing },
    },
  };
}

/**
 * A repository URL that two servers in the same batch both claim names
 * neither of them (one row would swallow the other in a collection that
 * deduplicates on URL), so those fall back to their own Glama listings.
 */
export function collapse(items) {
  const claims = new Map();
  for (const it of items) claims.set(it.url, (claims.get(it.url) ?? 0) + 1);
  for (const it of items) {
    if ((claims.get(it.url) ?? 0) > 1 && it.url !== it.data.glama) {
      it.data = { ...it.data, sharedRepository: it.url };
      it.url = it.data.glama;
    }
  }
  return items;
}

const sleep = (ms) => (ms > 0 ? Bun.sleep(ms) : Promise.resolve());

export const glamaMcp = defineAdapter({
  name: 'glama-mcp',
  title: 'Glama MCP directory',
  collection: 'mcp',
  description:
    "Servers in Glama's MCP directory (glama.ai/mcp/servers), with their tools, licence, hosting mode and Glama's tool-definition quality score. Needs GLAMA_API_KEY. Glama overlaps the other sources heavily, so it runs last and adds only the servers they lack. Licensed data: every row credits Glama and links to its Glama listing.",
  docs: 'https://glama.ai/api/mcp/openapi.json',
  kinds: ['mcp-server'],
  cadenceMinutes: 60 * 24,
  needsEnv: ['glamaApiKey'],
  attribution: CREDIT,
  configFields: [
    { key: 'pagesPerRun', label: 'Pages per run', type: 'number', placeholder: '20' },
    { key: 'pageSize', label: 'Page size', type: 'number', placeholder: '100' },
    { key: 'delayMs', label: 'Pause between pages (ms)', type: 'number', placeholder: '1000' },
  ],
  defaults: { pagesPerRun: 20, pageSize: 100, delayMs: 1000 },
  defaultSources: [{ slug: 'glama-servers', name: 'MCP servers on Glama' }],
  async pull({ config, cursor, env, http, log, deadline }) {
    if (!env?.glamaApiKey) throw new Error('GLAMA_API_KEY is not set');
    const pageSize = Math.min(Math.max(Number(config.pageSize) || 100, 10), 100);
    const budget = Math.min(Math.max(Number(config.pagesPerRun) || 20, 1), 60);
    const delay = Math.max(Number(config.delayMs ?? 1000) || 0, 0);
    const headers = { authorization: `Bearer ${env.glamaApiKey}`, accept: 'application/json' };

    let after = typeof cursor?.after === 'string' && cursor.after ? cursor.after : null;
    let sweeps = Number(cursor?.sweeps) || 0;
    const items = [];
    const seen = new Set();
    let pages = 0;
    let done = false;
    let stopped = null;

    while (pages < budget) {
      if (pages > 0 && deadline && Date.now() > deadline - 5_000) break;
      const params = new URLSearchParams({ first: String(pageSize), sort: 'added-at:desc' });
      if (after) params.set('after', after);
      const res = await http.request(`${BASE}?${params}`, { headers });

      if (res.status === 429 || res.status === 403) {
        // http.request already waited out one 429. A second one, or the ban
        // itself, ends the run where it is: the cursor is kept, and pressing
        // on is how a 429 becomes a 403 that does not lift.
        await res.body?.cancel().catch(() => {});
        stopped = res.status;
        if (pages === 0) throw new Error(`${res.status} from glama.ai; cursor kept`);
        break;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        if (pages === 0) throw new Error(`${res.status} from glama.ai: ${body.slice(0, 200)}`);
        // Glama answers the odd 503 mid-walk (seen 2026-10-17). The pages
        // already read are kept and the walk resumes from here next run.
        stopped = res.status;
        break;
      }
      const page = await res.json();
      pages++;

      for (const s of Array.isArray(page?.servers) ? page.servers : []) {
        const item = toItem(s);
        if (!item || seen.has(item.externalId)) continue;
        seen.add(item.externalId);
        items.push(item);
      }

      const info = page?.pageInfo ?? {};
      if (!info.hasNextPage || !info.endCursor) {
        done = true;
        break;
      }
      after = info.endCursor;

      // Pace: a fixed pause, and the window's reset whenever it is nearly spent.
      const remaining = Number(res.headers.get('ratelimit-remaining'));
      const reset = Number(res.headers.get('ratelimit-reset'));
      const wait = Number.isFinite(remaining) && remaining <= 2 && reset > 0 ? reset * 1000 : 0;
      if (pages < budget) await sleep(Math.max(delay, wait));
    }

    if (done) {
      after = null;
      sweeps += 1;
    }
    const rows = collapse(items);
    log(
      `${rows.length} servers in ${pages} page(s)${done ? ', sweep complete' : ''}${stopped ? `, stopped on ${stopped}` : ''}`,
    );
    return {
      items: rows,
      cursor: { after, sweeps },
      note: `${rows.length} server(s), ${pages} page(s)${done ? ', sweep complete' : ', more remain'}`,
      // Mid-sweep, come back in half an hour; a finished sweep waits the daily cadence.
      ...(done ? {} : { nextInMinutes: stopped === 429 || stopped === 403 ? 60 : 30 }),
    };
  },
});
