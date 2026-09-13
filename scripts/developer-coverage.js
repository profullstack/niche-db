/**
 * Run the developer enricher over the FindHost register without a database
 * and say what it found: how many providers got a CLI, a Terraform provider,
 * API docs, a status page, and which came from the seed versus a registry.
 *
 *   bun scripts/developer-coverage.js [limit]
 *
 * Reads providers.json live (CC BY 4.0, FindHost) and the home-URL corpus the
 * storefront survey saved, so it needs the network but no Postgres.
 */

import { toItem } from '../packages/adapters/src/findhost.js';
import { makeHttp } from '../packages/core/src/http.js';
import { developer } from '../packages/enrichers/src/developer.js';

const limit = Number(process.argv[2]) || Number.POSITIVE_INFINITY;
const http = makeHttp({ userAgent: 'nichedb/1.0 (+https://nichedb.dev; developer-coverage)' });
const doc = await http.json('https://www.findhost.app/providers.json', { timeoutMs: 60_000 });
const items = (doc.providers ?? [])
  .map((p) => toItem(p))
  .filter(Boolean)
  .slice(0, limit);

const tally = {
  total: items.length,
  noHome: 0,
  cli: 0,
  cliGuide: 0,
  cliRegistry: 0,
  terraform: 0,
  api: 0,
  status: 0,
  none: 0,
};
const rows = [];
let n = 0;
for (const item of items) {
  n++;
  const out = await developer
    .enrich(item, { http, env: {}, log: () => {} })
    .catch((err) => ({ error: String(err.message) }));
  if (!out) {
    tally.noHome++;
    rows.push([item.data.provider, 'no home url']);
    console.log(`${item.data.provider}\tno home url`);
    continue;
  }
  if (out.cli) {
    tally.cli++;
    if (out.cli.verified === 'guide') tally.cliGuide++;
    else tally.cliRegistry++;
  }
  if (out.terraform) tally.terraform++;
  if (out.api_docs) tally.api++;
  if (out.status) tally.status++;
  if (!out.cli && !out.terraform && !out.api_docs && !out.status) tally.none++;
  const row = [
    item.data.provider,
    out.cli ? `${out.cli.name} (${out.cli.verified})` : '-',
    out.terraform?.source ?? '-',
    out.api_docs ? 'api' : '-',
    out.status ? 'status' : '-',
  ];
  rows.push(row);
  // Streamed as it goes, so a run cut short still leaves its rows behind.
  console.log(row.join('\t'));
  if (n % 20 === 0) console.error(`${n}/${items.length}`);
}
console.log(JSON.stringify(tally));
