import { ADAPTERS } from '@nichedb/adapters';
import * as q from '@nichedb/db/queries';

/**
 * The three collections this deployment ships with, their default sources and
 * a few feeds worth following on day one. Idempotent: run on every boot.
 *
 * A source whose adapter needs a credential the deployment does not have is
 * still created, DISABLED, so the sources page shows what could be turned on
 * and what it needs.
 */
export const COLLECTIONS = [
  {
    slug: 'games',
    name: 'Games',
    description:
      'Video game releases and what is coming, from the Steam store and IGDB. Follow a genre, a platform or a store category.',
  },
  {
    slug: 'packages',
    name: 'Packages & models',
    description:
      'Every new version on npm, PyPI and crates.io, every model pushed to Hugging Face, every release on the GitHub repos you name.',
  },
  {
    slug: 'filings',
    name: 'Filings',
    description:
      'SEC EDGAR filings as they land (Form D raises, insider trades, 8-K events), Federal Register documents, and court opinions.',
  },
];

export const DEFAULT_FEEDS = [
  {
    collection: 'games',
    slug: 'new-on-steam',
    name: 'New on Steam',
    query: { sources: ['steam-new-releases'] },
  },
  {
    collection: 'games',
    slug: 'coming-soon-steam',
    name: 'Coming soon on Steam',
    query: { sources: ['steam-coming-soon'], upcoming: true },
  },
  {
    collection: 'games',
    slug: 'steam-top-sellers',
    name: 'Steam top sellers',
    query: { sources: ['steam-top-sellers'] },
  },
  {
    collection: 'packages',
    slug: 'npm-latest',
    name: 'npm: latest versions',
    query: { sources: ['npm'] },
  },
  {
    collection: 'packages',
    slug: 'pypi-latest',
    name: 'PyPI: latest releases',
    query: { sources: ['pypi'] },
  },
  {
    collection: 'packages',
    slug: 'crates-latest',
    name: 'crates.io: latest',
    query: { sources: ['crates'] },
  },
  {
    collection: 'packages',
    slug: 'huggingface-models',
    name: 'Hugging Face: new models',
    query: { sources: ['huggingface-models'] },
  },
  {
    collection: 'packages',
    slug: 'mcp-packages',
    name: 'MCP servers on npm and PyPI',
    query: { q: 'mcp', sources: ['npm', 'pypi'] },
  },
  {
    collection: 'filings',
    slug: 'form-d-raises',
    name: 'Form D: who raised money',
    query: { sources: ['edgar-form-d'] },
  },
  {
    collection: 'filings',
    slug: 'insider-trades',
    name: 'Form 4: insider trades',
    query: { sources: ['edgar-form-4'] },
  },
  {
    collection: 'filings',
    slug: 'material-events',
    name: '8-K: material events',
    query: { sources: ['edgar-8k'] },
  },
  {
    collection: 'filings',
    slug: 'federal-register',
    name: 'Federal Register: newest documents',
    query: { sources: ['federal-register'] },
  },
];

export async function ensureDefaults({ env = {}, log = console.log } = {}) {
  const byCollection = {};
  for (const c of COLLECTIONS) byCollection[c.slug] = await q.upsertCollection(c);

  let created = 0;
  for (const adapter of ADAPTERS) {
    for (const s of adapter.defaultSources ?? []) {
      const collection = byCollection[s.collection ?? adapter.collection];
      if (!collection) continue;
      const missingEnv = (adapter.needsEnv ?? []).filter((k) => !env[k]);
      const row = await q.insertSource({
        collectionId: collection.id,
        adapter: adapter.name,
        slug: s.slug,
        name: s.name,
        description: s.description ?? adapter.description,
        config: s.config ?? {},
        cadenceMinutes: s.cadenceMinutes ?? adapter.cadenceMinutes,
        enabled: missingEnv.length === 0,
      });
      if (row.created) created++;
    }
  }

  for (const f of DEFAULT_FEEDS) {
    const collection = byCollection[f.collection];
    if (!collection) continue;
    await q.insertFeed({
      collectionId: collection.id,
      slug: f.slug,
      name: f.name,
      description: f.description ?? null,
      query: f.query,
    });
  }
  if (created) log(`[seed] created ${created} default source(s)`);
  return { created };
}
