import { ADAPTERS } from '@nichedb/adapters';
import { createNiche, upsertOpportunity } from '@nichedb/db/knowledge';
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
  {
    slug: 'music',
    name: 'Music',
    description:
      'Upcoming album and single releases from MusicBrainz, with cover art, videos and artist pages.',
  },
  {
    slug: 'books',
    name: 'Books',
    description:
      'New books as they are catalogued at Open Library, with covers, descriptions and subjects.',
  },
  {
    slug: 'tabletop',
    name: 'Tabletop',
    description:
      'Magic: The Gathering sets and the newest cards, with images, oracle text and prices.',
  },
  {
    slug: 'space',
    name: 'Space',
    description:
      'Every upcoming rocket launch worldwide: net time, provider, pad, mission and webcast.',
  },
  {
    slug: 'chess',
    name: 'Chess',
    description: 'Official tournaments relayed live on Lichess, one row per event and per round.',
  },
  {
    slug: 'alerts',
    name: 'Alerts',
    description:
      'Earthquakes, US weather warnings and global disaster alerts, minutes after they are issued.',
  },
  {
    slug: 'outages',
    name: 'Outages',
    description:
      'Incidents from the status pages of the platforms developers depend on, as they are posted and resolved.',
  },
  {
    slug: 'extensions',
    name: 'Extensions',
    description:
      'New Firefox add-ons, VS Code extensions and MCP servers, with icons, categories and repo stats.',
  },
  {
    slug: 'health',
    name: 'Health',
    description:
      'FDA recalls and clinical trials as they are posted, with sponsor, phase and reason.',
  },
  {
    slug: 'research',
    name: 'Research',
    description: 'New preprints and DOIs with abstracts, authors, TL;DRs and citation counts.',
  },
  {
    slug: 'automotive',
    name: 'Automotive',
    description:
      'Every make, model and year sold in the US, and what is known about each one: safety recalls, what owners report going wrong, crash-test ratings, engines and mpg. Decode a VIN and get all of it for one car.',
  },
  {
    slug: 'housing',
    name: 'Housing',
    description:
      'What homes cost and what is being built: every property sold in England and Wales with its address and price, harmonised house price indices across Europe, the weekly US mortgage rate, and the building permits US cities issue months before ground is broken.',
  },
  {
    slug: 'jobs',
    name: 'Jobs',
    description:
      'The labour market as governments measure it: the US jobs report series from the BLS, harmonised unemployment and employment rates across Europe, and the WARN notices employers must file before a mass layoff — the one public, named record of jobs actually being cut.',
  },
  {
    slug: 'ai-incidents',
    name: 'AI incidents',
    description:
      'What autonomous AI agents have actually been caught doing, and the harms AI systems have caused in the world, each entry linked to the primary source that evidenced it.',
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
  {
    collection: 'music',
    slug: 'new-albums',
    name: 'Upcoming albums',
    query: { tags: ['album'], upcoming: true },
  },
  {
    collection: 'music',
    slug: 'new-singles',
    name: 'Upcoming singles',
    query: { tags: ['single'], upcoming: true },
  },
  { collection: 'books', slug: 'new-books', name: 'New books', query: {} },
  {
    collection: 'tabletop',
    slug: 'mtg-set-calendar',
    name: 'Magic sets and release dates',
    query: { kinds: ['set'] },
  },
  {
    collection: 'tabletop',
    slug: 'mtg-mythics',
    name: 'Magic: new mythics and rares',
    query: { kinds: ['card'], tags: ['mythic', 'rare'] },
  },
  { collection: 'space', slug: 'launches', name: 'Rocket launches', query: { upcoming: true } },
  {
    collection: 'space',
    slug: 'spacex-launches',
    name: 'SpaceX launches',
    query: { tags: ['spacex'], upcoming: true },
  },
  { collection: 'chess', slug: 'chess-live', name: 'Chess: tournaments and rounds', query: {} },
  {
    collection: 'alerts',
    slug: 'big-earthquakes',
    name: 'Earthquakes M5+',
    query: { kinds: ['earthquake'], tags: ['moderate', 'strong', 'major'] },
  },
  {
    collection: 'alerts',
    slug: 'severe-weather-us',
    name: 'Severe weather (US)',
    query: { kinds: ['alert'] },
  },
  {
    collection: 'alerts',
    slug: 'disasters',
    name: 'Global disasters',
    query: { kinds: ['disaster'] },
  },
  { collection: 'outages', slug: 'outages-all', name: 'Vendor incidents', query: {} },
  {
    collection: 'outages',
    slug: 'ai-outages',
    name: 'AI platform incidents',
    query: { tags: ['openai', 'claude'] },
  },
  {
    collection: 'extensions',
    slug: 'new-firefox-addons',
    name: 'New Firefox add-ons',
    query: { sources: ['firefox-new-extensions'] },
  },
  {
    collection: 'extensions',
    slug: 'new-vscode-extensions',
    name: 'New VS Code extensions',
    query: { sources: ['vscode-new-extensions'] },
  },
  {
    collection: 'extensions',
    slug: 'new-mcp-servers',
    name: 'New MCP servers',
    query: { kinds: ['mcp-server'] },
  },
  { collection: 'health', slug: 'fda-recalls', name: 'FDA recalls', query: { kinds: ['recall'] } },
  {
    collection: 'health',
    slug: 'trials-recruiting',
    name: 'Clinical trials now recruiting',
    query: { sources: ['clinical-trials-recruiting'] },
  },
  {
    collection: 'research',
    slug: 'ai-papers',
    name: 'New AI papers',
    query: { sources: ['arxiv-ai'] },
  },
  {
    collection: 'research',
    slug: 'security-papers',
    name: 'New security papers',
    query: { sources: ['arxiv-security'] },
  },
  {
    collection: 'packages',
    slug: 'go-tagged',
    name: 'Go: tagged module versions',
    query: { sources: ['go-modules'] },
  },
  {
    collection: 'automotive',
    slug: 'do-not-drive',
    name: 'Do not drive: the urgent recalls',
    description: 'Recalls where NHTSA’s advice is to stop driving the car or park it outside.',
    query: { kinds: ['recall'], tags: ['do-not-drive', 'park-outside'] },
  },
  {
    collection: 'automotive',
    slug: 'vehicle-recalls',
    name: 'Vehicle recalls',
    query: { kinds: ['recall'] },
  },
  {
    collection: 'automotive',
    slug: 'owner-complaints',
    name: 'What owners report going wrong',
    query: { kinds: ['complaint'] },
  },
  {
    collection: 'automotive',
    slug: 'crashes-and-fires',
    name: 'Complaints involving a crash or a fire',
    query: { kinds: ['complaint'], tags: ['crash', 'fire', 'injury', 'fatality'] },
  },
  {
    collection: 'automotive',
    slug: 'crash-test-ratings',
    name: 'Crash-test ratings',
    query: { kinds: ['safety-rating'] },
  },
  {
    collection: 'automotive',
    slug: 'vehicle-catalog',
    name: 'Makes, models and years',
    query: { kinds: ['model'] },
  },
  /* Housing. The events first, then the series: a sale and a permit are things
     that happened, and an index is a summary of many of them. */
  {
    collection: 'housing',
    slug: 'property-sales',
    name: 'Property sales',
    description:
      'Every home sold in England and Wales, with the address and the price actually paid.',
    query: { kinds: ['property-sale'] },
  },
  {
    collection: 'housing',
    slug: 'million-pound-homes',
    name: 'Homes sold for £1m and up',
    query: { kinds: ['property-sale'], tags: ['million-plus'] },
  },
  {
    collection: 'housing',
    slug: 'new-builds',
    name: 'New-build sales',
    query: { kinds: ['property-sale'], tags: ['new-build'] },
  },
  {
    collection: 'housing',
    slug: 'building-permits',
    name: 'Building permits',
    description: 'What is about to be built, months before ground is broken.',
    query: { kinds: ['building-permit'] },
  },
  {
    collection: 'housing',
    slug: 'new-construction',
    name: 'New construction permits',
    query: { kinds: ['building-permit'], tags: ['new-construction'] },
  },
  {
    collection: 'housing',
    slug: 'house-prices',
    name: 'House prices and mortgage rates',
    query: { kinds: ['housing-statistic'] },
  },
  {
    collection: 'housing',
    slug: 'mortgage-rates',
    name: 'US mortgage rates',
    query: { kinds: ['housing-statistic'], tags: ['mortgage'] },
  },

  /* Jobs. A statistic describes the market; a WARN notice names a company. */
  {
    collection: 'jobs',
    slug: 'jobs-report',
    name: 'The jobs numbers',
    description:
      'Unemployment, payrolls, openings, quits and earnings as the statistical agencies publish them.',
    query: { kinds: ['labour-statistic'] },
  },
  {
    collection: 'jobs',
    slug: 'us-jobs-report',
    name: 'US jobs report',
    query: { kinds: ['labour-statistic'], tags: ['bls'] },
  },
  {
    collection: 'jobs',
    slug: 'unemployment',
    name: 'Unemployment',
    query: { kinds: ['labour-statistic'], tags: ['unemployment', 'unemployment-rate'] },
  },
  {
    collection: 'jobs',
    slug: 'layoffs',
    name: 'Layoffs',
    description: 'WARN notices: the companies actually cutting jobs, named, counted and dated.',
    query: { kinds: ['layoff-notice'] },
  },
  {
    collection: 'jobs',
    slug: 'big-layoffs',
    name: 'Layoffs of 100 or more',
    query: { kinds: ['layoff-notice'], tags: ['hundred-plus'] },
  },
  {
    collection: 'ai-incidents',
    slug: 'rogue-agent-incidents',
    name: 'Rogue agent incidents',
    query: { kinds: ['incident'] },
  },
  {
    collection: 'ai-incidents',
    slug: 'ai-harms',
    name: 'AI harms as they are reported',
    query: { kinds: ['incident-report'] },
  },
  {
    collection: 'ai-incidents',
    slug: 'agent-research',
    name: 'Research on agents and multi-agent systems',
    query: { kinds: ['research'] },
  },
];

/**
 * A niche for every collection this deployment ships.
 *
 * A niche is a market someone can know, and the markets this site already
 * holds data about are the ones worth offering first: whoever knows how
 * package registries or SEC filings are actually used can improve what is
 * here today. Nothing invented, nothing scored — an opportunity score nobody
 * has measured is left null and the page says so rather than printing a
 * number it cannot defend.
 *
 * Every one is created `open`, so the marketplace has something real on it
 * and an admin can archive or add to the list without a migration.
 */
async function ensureNiches(byCollection, log) {
  let created = 0;
  for (const c of COLLECTIONS) {
    const collection = byCollection[c.slug];
    if (!collection) continue;
    const niche = await createNiche({
      slug: c.slug,
      name: c.name,
      description: c.description,
      collectionId: collection.id,
    }).catch(() => null);
    if (!niche) continue;
    await upsertOpportunity({ nicheId: niche.id, score: null });
    created++;
  }
  if (created) log(`[seed] opened ${created} niche(s) for Knowledge Influencers`);
  return created;
}

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
  const niches = await ensureNiches(byCollection, log);
  return { created, niches };
}
