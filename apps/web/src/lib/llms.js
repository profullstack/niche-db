import { config } from '@nichedb/config';
import { describeAdapters, describeEnrichers } from '@nichedb/core';
import * as q from '@nichedb/db/queries';

/**
 * llms.txt: the deployment described for language models, in one request.
 * Served at /llms.txt and as the MCP server's one resource.
 */
export async function llmsTxt() {
  const base = config.siteUrl;
  const [stats, collections, sources, feeds] = await Promise.all([
    q.siteStats(),
    q.listCollections(),
    q.listSources({ all: false }),
    q.listFeeds(),
  ]);
  const lines = [
    `# ${config.siteName}`,
    '',
    '> An open, ever-growing database of real-time public data. Collections of sources that',
    '> fetch on a schedule; feeds that cut the result into something to follow. Reads need',
    '> no key. Search and retrieval crawlers are welcome; training crawlers pay at /crawl.',
    '',
    `Items: ${stats.items} (${stats.items_today} added in the last day). Sources: ${stats.sources}. Feeds: ${stats.feeds}.`,
    '',
    '## Collections',
    '',
    ...collections.map(
      (c) =>
        `- [${c.name}](${base}/c/${c.slug}): ${c.description ?? ''} (${c.item_count} items, ${c.source_count} sources)`,
    ),
    '',
    '## Sources',
    '',
    ...sources.map(
      (s) =>
        `- [${s.name}](${base}/s/${s.slug}) — adapter ${s.adapter}, ${s.item_count} items, every ${s.cadence_minutes} minutes`,
    ),
    '',
    '## Feeds',
    '',
    ...feeds.map(
      (f) =>
        `- [${f.name}](${base}/f/${f.slug}) — RSS ${base}/f/${f.slug}.rss · JSON ${base}/f/${f.slug}.json`,
    ),
    '',
    '## Adapters available',
    '',
    ...describeAdapters().map((a) => `- ${a.name}: ${a.description}`),
    '',
    '## Enrichment',
    '',
    'Every item is enriched after ingest and carries the results under `enrichment`, keyed by',
    'enricher name. A feed chooses which enrichers it shows; the collection defaults are on.',
    '',
    ...describeEnrichers().map(
      (e) => `- ${e.name}: ${e.description} (default on for ${e.collections.join(', ')})`,
    ),
    '',
    '## Machine-readable',
    '',
    `- API: ${base}/api/v1 (JSON; documentation at ${base}/docs/api)`,
    `- MCP: ${base}/mcp (Streamable HTTP, stateless; documentation at ${base}/docs/mcp)`,
    `- CLI: npm install -g @profullstack/nichedb; nichedb --api ${base}`,
    `- Every feed: ${base}/f/<slug>.rss and .json`,
    `- Search: ${base}/api/v1/search?q=<terms>`,
    '',
    'Every item carries published_at, time_known and precision. When time_known is false the',
    'date is real and the clock is not.',
    '',
    `Source code: https://github.com/profullstack/niche-db (MIT).`,
  ];
  return lines.join('\n');
}
