/** Live, bounded smoke check: one detail per city, no database writes or paid APIs.
 * bun scripts/check-police-feeds.js [city-slug]
 */
import { policeUpdates } from '../packages/adapters/src/police-updates.js';
import { makeHttp } from '../packages/core/src/http.js';

const http = makeHttp({ userAgent: 'NicheDBPoliceSources/1.0 (+https://nichedb.dev)' });
const checks = [];
for (const source of policeUpdates.defaultSources) {
  if (process.argv[2] && source.config.city !== process.argv[2]) continue;
  try {
    const result = await policeUpdates.pull({
      config: source.config,
      http,
      budget: 1,
      deadline: Date.now() + 60000,
      previous: async () => new Map(),
    });
    const latest = result.items[0];
    if (!latest?.publishedAt) throw new Error('No dated announcement returned');
    checks.push({
      city: source.config.city,
      ok: true,
      items: result.items.length,
      sampleUrl: latest.url,
      publishedAt: latest.publishedAt,
      checkedAt: new Date().toISOString(),
    });
    console.log(`${source.config.city}: ${result.items.length} items; ${latest.publishedAt}`);
  } catch (error) {
    checks.push({
      city: source.config.city,
      ok: false,
      error: error.message,
      checkedAt: new Date().toISOString(),
    });
    console.error(`${source.config.city}: ${error.message}`);
  }
  await Bun.sleep(500);
}
await Bun.write(
  new URL('../docs/data/police-sources/ingestion-check.json', import.meta.url),
  `${JSON.stringify(checks, null, 2)}\n`,
);
if (!checks.length || checks.some((c) => !c.ok)) process.exitCode = 1;
