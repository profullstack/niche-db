/**
 * Run the phone adapters against the live publishers without a database:
 * counts what each would write and prints a few rows. A smoke check before a
 * deploy, not a test (it downloads ~15 MB from NANPA and pages the FCC).
 *
 *   DATABASE_URL=postgres://x bun scripts/smoke-phone-adapters.js [nanpa] [fcc]
 */
import { adapterByName } from '../packages/adapters/src/index.js';
import { makeHttp } from '../packages/core/src/http.js';

const want = process.argv.slice(2);
const run = async (name, cursor = {}, maxBatches = Infinity) => {
  const a = adapterByName(name);
  const http = makeHttp({ userAgent: 'niche-db/0.1', log: (m) => console.log(`  [http] ${m}`) });
  const started = Date.now();
  const kinds = {};
  const samples = {};
  let n = 0;
  let batches = 0;
  const gen = a.pull({ cursor, http, log: (m) => console.log(`  [${name}] ${m}`), config: {} });
  let r = await gen.next();
  while (!r.done) {
    for (const it of r.value.items ?? []) {
      n++;
      kinds[it.kind] = (kinds[it.kind] ?? 0) + 1;
      samples[it.kind] ??= it;
      if (it.externalId === 'nanp:202-200' || it.externalId === 'nanp:907-201')
        samples[it.externalId] = it;
    }
    if (++batches >= maxBatches) break;
    r = await gen.next();
  }
  console.log(
    `${name}: ${n} items in ${((Date.now() - started) / 1000).toFixed(1)}s`,
    kinds,
    r.value?.note ?? '',
  );
  for (const [k, it] of Object.entries(samples)) {
    console.log(`  ${k}: ${it.title}\n    ${it.summary}\n    tags ${it.tags.join(' ')}`);
    if (it.data?.blocks?.length)
      console.log(`    blocks ${JSON.stringify(it.data.blocks.slice(0, 2))}`);
  }
};

if (!want.length || want.includes('nanpa')) await run('nanpa');
if (!want.length || want.includes('fcc'))
  await run('fcc-unwanted-calls', { since: '2026-11-24T00:00:00.000' }, 2);
