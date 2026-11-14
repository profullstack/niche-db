#!/usr/bin/env bun
/**
 * Build the product graph from crawled pages already in /c/sites: every item
 * of kind 'product' the pit.world crawler pushed before the graph existed.
 * New pushes feed the graph on their own (keepProductOffers in sites.js).
 *
 *   bun scripts/backfill-product-graph.js [--before <item id>] [--batch 500] [--max <items>]
 *
 * Walks newest first on items_kind_idx (collection_id, kind, id desc), so
 * every page is an index range, never a scan of items. Resumable: it prints
 * the last id after each batch; pass it back as --before.
 */
import { offersFromRecord } from '../packages/core/src/products.js';
import { sql } from '../packages/db/src/index.js';
import { keepOffers } from '../packages/db/src/products.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
};

let before = arg('before', Number.MAX_SAFE_INTEGER);
const batch = arg('batch', 500);
const max = arg('max', Number.POSITIVE_INFINITY);

const [collection] = await sql`select id from collections where slug = 'sites'`;
if (!collection) throw new Error('no sites collection');

let seen = 0;
let offers = 0;
const started = Date.now();
while (seen < max) {
  const rows = await sql`
    select id, url, data->'record' as record
    from items
    where collection_id = ${collection.id} and kind = 'product' and id < ${before}
    order by id desc
    limit ${batch}
  `;
  if (rows.length === 0) break;
  const pages = [];
  const found = [];
  for (const r of rows) {
    const record = typeof r.record === 'string' ? JSON.parse(r.record) : r.record;
    if (!record) continue;
    const list = offersFromRecord(record);
    const page = list[0]?.pageUrl;
    if (page) pages.push(page);
    found.push(...list);
  }
  if (pages.length) offers += (await keepOffers({ pages, offers: found })).kept;
  seen += rows.length;
  before = rows.at(-1).id;
  const rate = Math.round(seen / ((Date.now() - started) / 1000));
  console.log(`items ${seen} offers ${offers} before ${before} (${rate}/s)`);
}
console.log(`done: ${seen} product pages, ${offers} offers`);
await sql.end?.();
