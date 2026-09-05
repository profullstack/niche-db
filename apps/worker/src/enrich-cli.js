import { enrichPending } from '@nichedb/core';
import { close } from '@nichedb/db';

/** Run enrichment from a terminal: `bun apps/worker/src/enrich-cli.js [n]`. */
const limit = Number(process.argv[2]) || 40;
console.log(JSON.stringify(await enrichPending({ log: console.log, limit })));
await close();
