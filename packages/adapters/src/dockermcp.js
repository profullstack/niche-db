import { defineAdapter, slugify } from '@nichedb/core/adapter';
import { repoSlug, repoUrl } from './catalogs.js';

/**
 * Docker's MCP catalogue: the servers somebody has already packaged.
 *
 * Every entry here is a signed image on Docker Hub with a pull count, a
 * category, a licence and the list of tools the server exposes — which is a
 * different and much harder-won kind of fact than "this repository exists".
 * Measured on 2026-09-25 the catalogue held 270 entries, 237 of them servers,
 * with pull counts into the hundreds of thousands.
 *
 * It is published as one 537 KB YAML file, and this repository has no YAML
 * parser (nothing else needed one). Rather than take a dependency for one
 * upstream, `parseCatalog` reads the shape this file actually has: a flat map
 * of entries at one indent, scalars at the next, and two nested blocks
 * (`tools`, `metadata`) that matter. It is checked against a sample of the
 * real file in the tests; if Docker ever reaches for a folded scalar or an
 * anchor that test is what will say so, and the answer then is a real parser
 * rather than a cleverer regex.
 *
 * WHICH URL IDENTIFIES A SERVER HERE
 *
 * `upstream` is the repository and `source` is the same repository pinned to
 * the sha Docker built, including the path within it. Keying on `upstream`
 * looks obviously right and loses data: 82 of the 270 entries share a
 * repository with another, because `awslabs/mcp` and its like hold a dozen
 * servers under `src/`, and this collection deduplicates on URL. So the
 * subpath form wins when there is one — `repoUrl` folds the sha to `HEAD`, so
 * it is stable across rebuilds and agrees with the way the awesome lists link
 * the same server — and `upstream` is the fallback for an entry whose source
 * is the repository root.
 */

const CATALOG = 'https://desktop.docker.com/mcp/catalog/v2/catalog.yaml';

const unquote = (v) => {
  const s = String(v ?? '').trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
};

/**
 * The `registry` block of Docker's catalogue, as entries.
 *
 * @param {string} yaml
 * @returns {object[]}
 */
export function parseCatalog(yaml) {
  const out = [];
  let inRegistry = false;
  let entry = null;
  let block = null; // 'tools' | 'metadata' | 'tags' | null

  for (const line of String(yaml ?? '').split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;

    if (/^[A-Za-z]/.test(line)) {
      inRegistry = /^registry:\s*$/.test(line);
      if (entry) out.push(entry);
      entry = null;
      continue;
    }
    if (!inRegistry) continue;

    const indent = line.length - line.trimStart().length;
    const text = line.trim();

    if (indent === 2) {
      const key = /^([A-Za-z0-9._-]+):\s*(.*)$/.exec(text);
      if (!key) continue;
      if (entry) out.push(entry);
      entry = { name: key[1], tools: [], tags: [], metadata: {} };
      block = null;
      continue;
    }
    if (!entry) continue;

    if (indent === 4) {
      const pair = /^([A-Za-z0-9._-]+):\s*(.*)$/.exec(text);
      if (!pair) continue;
      block = pair[2] === '' ? pair[1] : null;
      if (pair[2] !== '') entry[pair[1]] = unquote(pair[2]);
      continue;
    }
    if (block === 'tools' && indent === 6) {
      const tool = /^-\s*name:\s*(.+)$/.exec(text);
      if (tool) entry.tools.push(unquote(tool[1]));
      continue;
    }
    if (block === 'metadata' && indent === 6) {
      const pair = /^([A-Za-z0-9._-]+):\s*(.*)$/.exec(text);
      if (!pair) continue;
      if (pair[1] === 'tags' && pair[2] === '') {
        block = 'metadata.tags';
        continue;
      }
      if (pair[2] !== '') entry.metadata[pair[1]] = unquote(pair[2]);
      continue;
    }
    if (block === 'metadata.tags' && indent === 8) {
      const tag = /^-\s*(.+)$/.exec(text);
      if (tag) entry.tags.push(unquote(tag[1]));
      continue;
    }
    // Back out to the metadata block when a tag list ends.
    if (block === 'metadata.tags' && indent === 6) {
      block = 'metadata';
      const pair = /^([A-Za-z0-9._-]+):\s*(.*)$/.exec(text);
      if (pair && pair[2] !== '') entry.metadata[pair[1]] = unquote(pair[2]);
    }
  }
  if (entry) out.push(entry);
  return out;
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export function toItem(e) {
  if (!e?.name) return null;
  const pinned = repoUrl(e.source);
  const upstream = repoUrl(e.upstream);
  const repo = pinned?.includes('/tree/HEAD/') ? pinned : (upstream ?? pinned);
  const url = repo ?? `https://hub.docker.com/r/${String(e.image ?? '').split('@')[0]}`;
  const meta = e.metadata ?? {};

  return {
    externalId: `docker:${e.name}`,
    kind: 'mcp-server',
    title: String(e.title || e.name).slice(0, 200),
    summary: e.description ? String(e.description).replace(/\s+/g, ' ').trim() : null,
    url,
    imageUrl: e.icon ?? null,
    publishedAt: e.dateAdded ?? null,
    tags: [
      'mcp',
      'docker',
      'packaged',
      e.type ? slugify(e.type) : null,
      meta.category ? slugify(meta.category) : null,
      meta.owner ? String(meta.owner).toLowerCase() : null,
      ...e.tags.map((t) => slugify(t)).filter(Boolean),
    ].filter(Boolean),
    data: {
      name: e.name,
      type: e.type ?? null,
      image: e.image ?? null,
      // The repository, and the same repository pinned to the built sha.
      upstream: e.upstream ?? null,
      pinnedSource: e.source ?? null,
      repo: repoSlug(repo ?? ''),
      readme: e.readme ?? null,
      toolsUrl: e.toolsUrl ?? null,
      tools: e.tools,
      toolCount: e.tools.length,
      category: meta.category ?? null,
      license: meta.license ?? null,
      owner: meta.owner ?? null,
      pulls: num(meta.pulls),
      stars: num(meta.stars),
      githubStars: num(meta.githubStars),
      dateAdded: e.dateAdded ?? null,
    },
  };
}

export const dockerMcp = defineAdapter({
  name: 'docker-mcp',
  title: 'Docker MCP catalogue',
  collection: 'mcp',
  description:
    'The MCP servers Docker has packaged as images, with pull counts, categories, licences and the tools each server exposes. One keyless YAML file, a few hundred entries, updated as Docker adds them.',
  docs: 'https://github.com/docker/mcp-registry',
  kinds: ['mcp-server'],
  cadenceMinutes: 60 * 12,
  defaults: {},
  defaultSources: [{ slug: 'docker-mcp-catalog', name: 'MCP servers packaged by Docker' }],
  async pull({ http, log }) {
    const yaml = await http.text(CATALOG, {
      headers: { accept: 'text/yaml, */*' },
      timeoutMs: 60_000,
    });
    const entries = parseCatalog(yaml);
    if (!entries.length) throw new Error('Docker catalogue parsed to nothing');

    const items = entries.map(toItem).filter(Boolean);
    log(`${items.length} catalogue entries`);
    return { items, note: `${items.length} packaged server(s)` };
  },
});
