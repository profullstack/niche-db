import { config } from '@nichedb/config';
import { describeAdapters, describeEnrichers } from '@nichedb/core';
import * as q from '@nichedb/db/queries';
import { parseLoyalty } from './pricing.js';

/**
 * llms.txt: the deployment described for language models, in one request.
 * Served at /llms.txt and as the MCP server's one resource.
 */
/** "20% off after $10, 40% after $50, 60% after $100" from the loyalty ladder. */
function loyaltyLine() {
  const tiers = parseLoyalty(config.x402.loyalty);
  if (!tiers.length) return 'one price for everyone';
  return tiers
    .map((t) => `${Math.round(t.off * 100)}% off after $${(t.spentCents / 100).toFixed(0)}`)
    .join(', ');
}

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
    '## Vehicles',
    '',
    'One car, everything known about it, assembled live from NHTSA (VIN decode, recalls,',
    'complaints, crash tests), the EPA fuel-economy database and OpenStreetMap:',
    '',
    `- \`GET ${base}/api/v1/automotive/vin/{vin}\` — decode a VIN and return recalls, complaints,`,
    '  crash ratings, mpg, service intervals, parts searches and, with `?lat=&lon=`, mechanics nearby',
    `- \`GET ${base}/api/v1/automotive/vehicle/{year}/{make}/{model}\` — the same without a VIN`,
    `- \`GET ${base}/api/v1/automotive/makes\`, \`/models?make=\`, \`/years\` — the catalogue, free`,
    `- \`GET ${base}/api/v1/automotive/mechanics?lat=&lon=\` — repair shops, OpenStreetMap, ODbL`,
    `- \`GET ${base}/api/v1/automotive/parts?year=&make=&model=&part=\` — where to buy the part`,
    '',
    `The catalogue and every automotive feed are free. Assembled vehicle lookups are`,
    `${config.automotive.freeLookupsPerHour} an hour free, then $${(config.automotive.dayCents / 100).toFixed(2)} a day on a crawl pass or`,
    `$${(config.automotive.monthlyCents / 100).toFixed(0)} a month. Recalls, complaints, crash tests and the catalogue are US`,
    'public domain and may be redistributed; the service schedule is a general interval model,',
    'not any manufacturer’s schedule, and says so in the payload.',
    '',
    '## AI incidents',
    '',
    'What autonomous agents have been caught doing, and the harms AI systems have caused.',
    'Rogue AI Tracker entries are indexed by reference under that site’s content signal —',
    'title, its own summary, and the primary sources it cites, never the review body — so',
    'follow the source link for the evidence. AI Incident Database rows are CC BY-SA 4.0.',
    '',
    '## Access and pricing',
    '',
    'Reading, following and querying is free, and free pages and feeds carry one sponsored',
    'item and a tracker. Two paid ways in:',
    '',
    `- **Pro, $${(config.membership.priceCents / 100).toFixed(0)} a month** (${base}/pro): no ads, no tracking,`,
    `  ${config.api.proPerHour.toLocaleString('en-US')} API requests an hour, unlimited feeds, your own sources, and a crawl pass`,
    '  for the whole term so your own agents walk through the paywall on your key. Paid in',
    '  crypto through CoinPay.',
    `- **A crawl pass over x402** (${base}/crawl): $${(config.x402.priceCents / 100).toFixed(2)} a day for everything, bought`,
    '  by any x402 client (the CoinPay CLI, @profullstack/x402-client) with no account. The more',
    `  you have paid here the less a day costs: ${loyaltyLine()}.`,
    '  A pass may switch ads or tracking off for its own requests with `?disable=ads,tracking`.',
    '',
    `Source code: https://github.com/profullstack/niche-db (MIT).`,
  ];
  return lines.join('\n');
}
