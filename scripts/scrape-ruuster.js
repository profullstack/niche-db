import { writeFile } from 'node:fs/promises';
import { ruuster, SAN_JOSE_SEARCH } from '../packages/adapters/src/ruuster.js';
import { normaliseItem } from '../packages/core/src/adapter.js';
import { makeHttp } from '../packages/core/src/http.js';

// Preview/export without a database. Normal ingestion uses:
// bun run ingest ruuster-san-jose-homes
const [savedSearchUrl = SAN_JOSE_SEARCH, output] = process.argv.slice(2);
const http = makeHttp({ userAgent: 'niche-db/0.26 (+https://nichedb.dev)', log: console.error });
const items = new Map();
let cursor = {};
for (let run = 0; run < 100; run++) {
  const result = await ruuster.pull({
    config: { ...ruuster.defaults, savedSearchUrl },
    cursor,
    http,
    budget: 150,
    deadline: Date.now() + 5 * 60000,
    log: console.error,
  });
  for (const raw of result.items) {
    const item = normaliseItem(raw);
    if (item) items.set(item.externalId, item);
  }
  cursor = result.cursor;
  if (!cursor.page) break;
}
if (cursor.page) throw new Error('Ruuster export did not finish within 100 runs');
const json = `${JSON.stringify([...items.values()], null, 2)}\n`;
if (output) await writeFile(output, json, { flag: 'wx' });
else process.stdout.write(json);
console.error(`Exported ${items.size} unique properties${output ? ` to ${output}` : ''}`);
