import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { gzip as gzipCallback } from 'node:zlib';
import { config } from '@nichedb/config';
import { sql } from '@nichedb/db';
import { defaultEnrichers } from '@nichedb/enrichers';
import { S3Client } from 'bun';

const gzip = promisify(gzipCallback);
const LOCK = 7341999;
const PART_BYTES = 16 * 1024 * 1024;
const MAX_DURATION_MS = 50 * 60_000;
let client;

export function dumpStorage() {
  if (!config.dataDumps.enabled) throw new Error('Data dump storage is not configured');
  client ??= new S3Client({
    endpoint: config.dataDumps.endpoint,
    bucket: config.dataDumps.bucket,
    region: config.dataDumps.region,
    accessKeyId: config.dataDumps.accessKeyId,
    secretAccessKey: config.dataDumps.secretAccessKey,
  });
  return {
    put: (key, bytes) => client.file(key).write(bytes, { type: 'application/gzip' }),
    remove: (key) => client.file(key).delete(),
    list: (options) => client.list(options),
    download: (key, expiresIn) => client.file(key).presign({ expiresIn }),
  };
}

/** Same public item fields as the read API. No accounts, billing, source config or private feeds. */
export function dumpItem(row) {
  const allowed = new Set(defaultEnrichers(row.collection));
  return {
    id: String(row.id),
    collection: row.collection,
    source: row.source,
    adapter: row.adapter,
    external_id: row.external_id,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    url: row.url,
    image_url: row.image_url,
    published_at: row.published_at,
    time_known: row.time_known,
    precision: row.precision,
    tags: row.tags,
    data: row.data,
    first_seen_at: row.first_seen_at,
    updated_at: row.updated_at,
    enrichment: Object.fromEntries(
      Object.entries(row.enrichment ?? {}).filter(([key]) => allowed.has(key)),
    ),
  };
}

/** Keyset pages within the caller's repeatable-read transaction. */
export async function* dumpRows(tx, { batchSize = 1000 } = {}) {
  let after = '0';
  while (true) {
    const rows = await tx`
      select i.id, c.slug as collection, s.slug as source, s.adapter,
             i.external_id, i.kind, i.title, i.summary, i.url, i.image_url,
             i.published_at, i.time_known, i.precision, i.tags, i.data,
             i.first_seen_at, i.updated_at, i.enrichment
      from items i join collections c on c.id = i.collection_id
                   join sources s on s.id = i.source_id
      where c.public and not c.early_access and i.id > ${after}::bigint
      order by i.id limit ${batchSize}
    `;
    if (!rows.length) return;
    for (const row of rows) yield dumpItem(row);
    after = String(rows.at(-1).id);
  }
}

/** Bounded-size, independently compressed parts. A failed upload never creates a published manifest. */
export async function writeDumpParts({
  rows,
  id,
  storage,
  partBytes = PART_BYTES,
  deadline = Date.now() + MAX_DURATION_MS,
  uploaded = [],
}) {
  const parts = [];
  let lines = [],
    size = 0;
  const flush = async () => {
    if (!lines.length) return;
    const bytes = await gzip(Buffer.concat(lines), { level: 1 });
    const file = `part-${String(parts.length + 1).padStart(5, '0')}.ndjson.gz`;
    const key = `snapshots/${id}/${file}`;
    uploaded.push(key);
    await storage.put(key, bytes);
    parts.push({
      file,
      key,
      rows: lines.length,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    lines = [];
    size = 0;
  };
  for await (const row of rows) {
    if (Date.now() > deadline)
      throw new Error('Hourly dump exceeded its 50-minute generation window');
    const line = Buffer.from(`${JSON.stringify(row)}\n`);
    if (size && size + line.length > partBytes) await flush();
    lines.push(line);
    size += line.length;
  }
  await flush();
  return parts;
}

export async function latestDump(db = sql) {
  const [row] = await db`
    select manifest from data_dumps
    where completed_at > now() - make_interval(hours => ${config.dataDumps.retentionHours}::int)
    order by snapshot_at desc limit 1
  `;
  return row?.manifest ?? null;
}

export async function findDump(id, db = sql) {
  const [row] = await db`
    select manifest from data_dumps where id = ${id}::uuid
      and completed_at > now() - make_interval(hours => ${config.dataDumps.retentionHours}::int)
  `;
  return row?.manifest ?? null;
}

/** Keep completed snapshots for the advertised window; never delete the last good one. */
export async function expireDumps({ db = sql, storage = dumpStorage() } = {}) {
  const old = await db`
    select id, manifest from data_dumps
    where completed_at < now() - make_interval(hours => ${config.dataDumps.retentionHours}::int)
      and id <> (select id from data_dumps order by snapshot_at desc limit 1)
  `;
  for (const row of old) {
    for (const part of row.manifest.parts) await storage.remove(part.key);
    await db`delete from data_dumps where id = ${row.id}::uuid`;
  }
  // A killed worker cannot run its catch block. Reap its unreferenced uploads too.
  if (storage.list) {
    const kept = await db`select manifest from data_dumps`;
    const keys = new Set(kept.flatMap((row) => row.manifest.parts.map((part) => part.key)));
    const cutoff = Date.now() - config.dataDumps.retentionHours * 60 * 60_000;
    let startAfter;
    do {
      const page = await storage.list({ prefix: 'snapshots/', maxKeys: 1000, startAfter });
      for (const object of page.contents ?? []) {
        if (!keys.has(object.key) && new Date(object.lastModified).getTime() < cutoff)
          await storage.remove(object.key);
      }
      startAfter = page.isTruncated ? page.contents?.at(-1)?.key : undefined;
    } while (startAfter);
  }
}

/** One global job; repeatable-read keeps every page at the same database snapshot. */
export async function generateDump({ db = sql, storage = dumpStorage(), log = console.log } = {}) {
  const id = randomUUID();
  const uploaded = [];
  let published = false;
  try {
    const result = await db.begin(async (tx) => {
      await tx`set transaction isolation level repeatable read`;
      await tx`set local statement_timeout = '120s'`;
      const [lock] = await tx`select pg_try_advisory_xact_lock(${LOCK}) as acquired`;
      if (!lock.acquired) return { skipped: 'another dump is running' };
      const [recent] =
        await tx`select id from data_dumps where snapshot_at >= date_trunc('hour', now()) limit 1`;
      if (recent) return { skipped: 'this hour is already published' };
      const [{ snapshot_at }] = await tx`select now() as snapshot_at`;
      const collections =
        await tx`select slug, name, description from collections where public and not early_access order by slug`;
      const sources = await tx`
        select s.slug, s.name, s.adapter, c.slug as collection from sources s
        join collections c on c.id = s.collection_id where c.public and not c.early_access order by s.slug
      `;
      const parts = await writeDumpParts({ rows: dumpRows(tx), id, storage, uploaded });
      const manifest = {
        version: 1,
        id,
        snapshot_at: new Date(snapshot_at).toISOString(),
        completed_at: new Date().toISOString(),
        format: 'ndjson.gz',
        cadence_minutes: 60,
        rows: parts.reduce((n, part) => n + part.rows, 0),
        bytes: parts.reduce((n, part) => n + part.bytes, 0),
        collections,
        sources,
        parts,
      };
      await tx`insert into data_dumps (id, snapshot_at, completed_at, manifest)
        values (${id}::uuid, ${manifest.snapshot_at}::timestamptz, ${manifest.completed_at}::timestamptz, ${JSON.stringify(manifest)}::jsonb)`;
      return manifest;
    });
    published = Boolean(result.id);
    if (published)
      log(`[dumps] published ${id}: ${result.rows} rows in ${result.parts.length} parts`);
    await expireDumps({ db, storage }).catch((error) =>
      log(`[dumps] retention cleanup: ${error.message}`),
    );
    return result;
  } catch (error) {
    if (!published && uploaded.length) {
      // A connection error during COMMIT is ambiguous. Preserve files unless the
      // database confirms that no manifest was published; retention reaps orphans.
      const committed = await db`select id from data_dumps where id = ${id}::uuid`.catch(
        () => null,
      );
      if (committed?.length === 0)
        await Promise.allSettled(uploaded.map((key) => storage.remove(key)));
    }
    throw error;
  }
}
