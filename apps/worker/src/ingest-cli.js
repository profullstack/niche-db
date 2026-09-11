import { config } from '@nichedb/config';
import { ensureDefaults, envFor, runSource } from '@nichedb/core';
import { close } from '@nichedb/db';
import { migrate } from '@nichedb/db/migrate';
import * as q from '@nichedb/db/queries';

/**
 * Run sources from a terminal, without Redis: `bun run ingest [slug ...]`.
 * No arguments runs everything that is enabled.
 */
await migrate({ log: () => {} });
await ensureDefaults({ env: envFor(), log: () => {} });
const wanted = process.argv.slice(2);
const sources = await q.listSources({ all: true });
const chosen = wanted.length
  ? sources.filter((s) => wanted.includes(s.slug))
  : sources.filter((s) => s.enabled);
if (chosen.length === 0) {
  console.error(`no sources matched; known: ${sources.map((s) => s.slug).join(', ')}`);
  process.exit(1);
}
for (const s of chosen) {
  const r = await runSource(s.id, { log: console.log });
  console.log(`${s.slug}: ${JSON.stringify(r)}`);
}
await close();
