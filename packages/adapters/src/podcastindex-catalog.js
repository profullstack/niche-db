import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeEntities, defineAdapter, slugify, stripHtml } from '@nichedb/core/adapter';
import { dumpDir, sqliteRows, untar } from '@nichedb/core/dump';

import { platformOf } from './podcastplatforms.js';

/**
 * Every podcast in the Podcast Index, from the database it publishes.
 *
 * The two `podcasts` sources read rssamplifier, a live crawl of a large slice
 * of this catalogue, because that is what a fifteen-minute poll can keep up
 * with. This is the census behind it: the Podcast Index's own table of every
 * feed it has ever indexed, published as one SQLite file inside a 1.8 GB tgz
 * at public.podcastindex.org, keyless, rebuilt on its own schedule. A row here
 * carries the same normalised feed URL the other two sources carry in
 * `data.feedUrl`, which is the join.
 *
 * HOW A 1.8 GB FILE BECOMES ROWS
 *
 * One weekly run, budgeted at 55 minutes, in three parts that each resume:
 *
 * - A HEAD first. The dump's ETag (or its Last-Modified) is the version, and a
 *   version the cursor already marks `done` ends the run before a byte is
 *   fetched. That is what makes a weekly cadence cheap when nothing changed.
 * - `http.download` with Range resume into `dumpDir('podcastindex')`. The
 *   server honours Range, so a run that stops mid-transfer leaves a partial
 *   file the next run appends to. It refuses a request without a descriptive
 *   user agent (403), so one is sent explicitly on every request.
 * - `tar` extracts the 5.1 GB database beside the archive (Bun.Archive would
 *   hold the whole file in memory), the archive is deleted, and the walk is
 *   `select ... where id > ? order by id limit 500` with the last id in the
 *   cursor. Each batch of 500 is yielded and its cursor saved before the next
 *   is read, so a crash costs one re-written batch and never the walk.
 *
 * THE SCHEMA IS DISCOVERED, NOT ASSUMED
 *
 * The repository's `create_table_statement.sql` describes a MySQL table called
 * `newsfeeds` with snake_case columns (`newest_item_pubdate`, `item_count`).
 * The file actually published is a SQLite table called `podcasts` with
 * camelCase columns (`newestItemPubdate`, `episodeCount`) and ten `categoryN`
 * columns the MySQL DDL never mentions, confirmed from the first 4 MB of the
 * real archive on 2026-09-13. So the table and its columns are read from
 * `sqlite_master` and `pragma table_info` at run time, and every field this
 * adapter wants is resolved from a list of the names it has been called under.
 * A dump that renames a column again degrades to a null field, not a crash;
 * only `id`, `url` and `title` are required.
 *
 * WHAT IS LEFT OUT
 *
 * Rows flagged `dead` (too many fetch errors, no longer checked), rows with no
 * title and rows whose feed URL does not parse. About a third of the index is
 * dead feeds, and a directory of podcasts nobody can fetch is not a directory.
 */

export const DUMP_URL = 'https://public.podcastindex.org/podcastindex_feeds.db.tgz';
export const DOCS_URL = 'https://github.com/Podcastindex-org/database';

/** Rows per batch: the memory a run holds at once, and the unit the cursor moves by. */
export const BATCH = 500;
/** A weekly read. The HEAD makes an unchanged week cost one request. */
export const CADENCE_MINUTES = 7 * 24 * 60;
/** Download, extract and a good part of the walk fit in one run. */
export const BUDGET_MS = 55 * 60_000;
/** How soon an unfinished run picks up again. */
export const RESUME_IN_MINUTES = 10;
/** A run stops yielding this far before its deadline, so the batch in flight lands inside it. */
export const DEADLINE_MARGIN_MS = 30_000;
/** Consecutive request failures that end a run. */
export const MAX_FAILURES = 3;
/** Pause between retries. */
export const PAUSE_MS = 5_000;

export const ATTRIBUTION = 'Podcast Index; dump under its terms, index data MIT';

/** The last epoch second this adapter believes: 2100-01-01. The dump has a few pubdates past it. */
const EPOCH_CEILING = 4_102_444_800;

/**
 * The names each field has been published under, lowercased, in order of
 * preference. The first list is the SQLite dump as it is; the second is the
 * repository's MySQL DDL, in case a future dump follows it.
 */
export const FIELD_NAMES = {
  id: ['id'],
  url: ['url', 'feedurl', 'feed_url'],
  title: ['title'],
  link: ['link', 'website', 'siteurl', 'site_url'],
  description: ['description'],
  image: ['imageurl', 'image_url', 'artwork_url_600', 'artworkurl', 'artwork', 'image'],
  dead: ['dead'],
  itunesId: ['itunesid', 'itunes_id'],
  language: ['language'],
  episodeCount: ['episodecount', 'item_count', 'itemcount'],
  newestItemPubdate: ['newestitempubdate', 'newest_item_pubdate'],
  oldestItemPubdate: ['oldestitempubdate', 'oldest_item_pubdate'],
  lastUpdate: ['lastupdate', 'last_update'],
  explicit: ['explicit'],
  generator: ['generator'],
  host: ['host'],
  author: ['itunesauthor', 'itunes_author'],
  guid: ['podcastguid', 'podcast_guid'],
  popularity: ['popularityscore', 'popularity_score', 'popularity'],
  duplicateOf: ['duplicateof', 'duplicate_of'],
  lastHttpStatus: ['lasthttpstatus', 'last_http_status'],
};

/** Without these there is no item to make. */
const REQUIRED = ['id', 'url', 'title'];

const sleep = (ms) => (ms > 0 ? Bun.sleep(ms) : Promise.resolve());

const message = (err) => String(err?.message ?? err).slice(0, 200);

/** Trimmed, whitespace-collapsed text, or null when nothing is left. */
export function clean(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s || null;
}

/** A positive integer, or null. Zero is the dump's "unknown" for every numeric column. */
export function positiveInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/** An epoch-seconds column as a Date, or null when zero, absent, or past the ceiling. */
export function epochDate(v) {
  const n = positiveInt(v);
  return n !== null && n < EPOCH_CEILING ? new Date(n * 1000) : null;
}

/** The dump's tinyint flags: 1 is set, 0 is not, and text arrives from a CSV import. */
export function flag(v) {
  if (v === null || v === undefined || v === '') return false;
  const n = Number(v);
  if (Number.isFinite(n)) return n > 0;
  return /^(true|yes|y|t)$/i.test(String(v).trim());
}

/**
 * The feed URL as the join key.
 *
 * Lowercase host (the URL class does that), no trailing slash, no fragment,
 * the scheme the row declares and never upgraded: a feed that only answers on
 * http is not made https by wishing. Anything that is not an http(s) URL is
 * null, and a row with a null feed URL is skipped.
 */
export function normaliseFeedUrl(raw) {
  const s = clean(raw);
  if (!s) return null;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname) return null;
  const path = u.pathname.replace(/\/+$/, '');
  return `${u.protocol}//${u.host}${path}${u.search}`;
}

/** The show's own site, if the row has a usable one. */
export function siteUrl(raw) {
  const s = clean(raw);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * A language tag reduced to its base, as the `podcasts` sources do: the feed
 * says `en`, `en-us` and `EN-US` for one language, and a tag per spelling is
 * a tag nobody can follow.
 */
export function langTag(language) {
  const base = String(language ?? '')
    .toLowerCase()
    .split(/[-_]/)[0]
    .trim();
  return /^[a-z]{2,3}$/.test(base) ? `lang:${base}` : null;
}

/** The non-empty `categoryN` columns of a row, in column order, de-duplicated. */
export function categoriesOf(row) {
  const keys = Object.keys(row ?? {})
    .filter((k) => /^category\d+$/i.test(k))
    .sort((a, b) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, '')));
  const out = [];
  for (const k of keys) {
    const c = clean(row[k]);
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

/** Description text: tags out, entities resolved, one line, 600 characters. */
export function summaryOf(description) {
  const text = clean(decodeEntities(stripHtml(description)));
  return text ? text.slice(0, 600) : null;
}

/**
 * One row of the dump as an item, or null when it is not a podcast a reader
 * can reach: dead, untitled, or without a feed URL that parses.
 *
 * The row arrives with the logical field names (`selectSql` aliases the
 * dump's columns onto them), so this never sees the dump's own spelling.
 */
export function toItem(row) {
  const id = positiveInt(row?.id);
  if (id === null) return null;
  if (flag(row.dead)) return null;

  const title = clean(row.title);
  const feedUrl = normaliseFeedUrl(row.url);
  if (!title || !feedUrl) return null;

  const site = siteUrl(row.link);
  const language = clean(row.language);
  const categories = categoriesOf(row);
  const newest = epochDate(row.newestItemPubdate);
  const host = clean(row.host)?.toLowerCase() ?? null;

  return {
    externalId: `podcastindex:feed:${id}`,
    kind: 'show',
    title: title.slice(0, 500),
    summary: summaryOf(row.description),
    url: site ?? feedUrl,
    imageUrl: siteUrl(row.image),
    /*
     * The newest episode's date, as the `podcasts` sources use `lastPublishedAt`:
     * "when did this show last speak" is the question a podcast directory is
     * asked, and for most of this catalogue the answer is years ago.
     */
    publishedAt: newest,
    tags: [
      'show',
      'podcast',
      'podcastindex',
      langTag(language),
      ...categories.map((c) => `category:${slugify(c)}`).filter((t) => t.length > 9),
    ].filter(Boolean),
    data: {
      feedId: id,
      feedUrl,
      siteUrl: site,
      itunesId: positiveInt(row.itunesId),
      podcastGuid: clean(row.guid),
      author: clean(row.author),
      language,
      categories,
      episodeCount: positiveInt(row.episodeCount),
      newestItemPubdate: newest?.toISOString() ?? null,
      oldestItemPubdate: epochDate(row.oldestItemPubdate)?.toISOString() ?? null,
      lastUpdate: epochDate(row.lastUpdate)?.toISOString() ?? null,
      explicit: flag(row.explicit),
      generator: clean(row.generator),
      /* The dump's own `host` column (its registrable domain, occasionally a bare
       * public suffix), beside the platform the house list files the feed under. */
      host,
      platform: platformOf(feedUrl),
      popularity: positiveInt(row.popularity),
      duplicateOf: positiveInt(row.duplicateOf),
      lastHttpStatus: positiveInt(row.lastHttpStatus),
      attribution: ATTRIBUTION,
      source: 'Podcast Index database dump',
      dataset: DUMP_URL,
    },
  };
}

/**
 * A batch of rows as items, with the tally. One row that throws is one row
 * lost and one line in the log; it never ends the walk.
 */
export function rowsToItems(rows, { log = () => {} } = {}) {
  const items = [];
  let kept = 0;
  let skipped = 0;
  let bad = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    try {
      const item = toItem(row);
      if (item) {
        items.push(item);
        kept += 1;
      } else {
        skipped += 1;
      }
    } catch (err) {
      bad += 1;
      if (bad <= 5) log(`row ${row?.id ?? '?'} dropped: ${message(err)}`);
    }
  }
  return { items, kept, skipped, bad };
}

/**
 * What identifies the file on the server, from its HEAD. The ETag is the
 * version when there is one (S3-style, changes with every upload); the
 * Last-Modified is the fallback and is kept beside it either way, because a
 * date is what a person reading the cursor wants to see.
 */
export function dumpVersion(headers) {
  const get = (k) =>
    typeof headers?.get === 'function'
      ? headers.get(k)
      : (headers?.[k] ?? headers?.[k.toLowerCase()]);
  const etag =
    String(get('etag') ?? '')
      .replace(/^W\//i, '')
      .replace(/"/g, '')
      .trim() || null;
  const lmRaw = clean(get('last-modified'));
  const lm = lmRaw ? new Date(lmRaw) : null;
  const lastModified = lm && !Number.isNaN(lm.getTime()) ? lm.toISOString() : null;
  const bytes = positiveInt(get('content-length'));
  return { version: etag ?? lastModified, etag, lastModified, bytes };
}

/** A version as a file name. */
export function versionStamp(version) {
  return slugify(version).slice(0, 80) || 'dump';
}

/** The user agent the Podcast Index asks for: who, why, and how to reach us. */
export function userAgent(env = {}) {
  const contact = clean(env?.contactEmail);
  return `niche-db podcastindex-catalog/1 (+https://nichedb.dev; weekly read of the public dump${
    contact ? `; ${contact}` : ''
  })`;
}

/**
 * Which table holds the feeds: `podcasts` as published, `newsfeeds` as
 * documented, else the first table that has both a url and a title column.
 *
 * @param {{ name: string, columns: string[] }[]} tables
 */
export function pickTable(tables) {
  const list = Array.isArray(tables) ? tables : [];
  for (const want of ['podcasts', 'newsfeeds']) {
    const hit = list.find((t) => String(t?.name).toLowerCase() === want);
    if (hit) return hit;
  }
  return (
    list.find((t) => {
      const cols = new Set((t?.columns ?? []).map((c) => String(c).toLowerCase()));
      return cols.has('url') && cols.has('title');
    }) ?? null
  );
}

/**
 * The dump's column for each logical field, plus its category columns.
 *
 * @param {string[]} columnNames as `pragma table_info` reports them
 * @returns {{ columns: Record<string, string|null>, categories: string[] }}
 */
export function resolveColumns(columnNames) {
  const byLower = new Map();
  for (const name of Array.isArray(columnNames) ? columnNames : []) {
    const key = String(name).toLowerCase();
    if (!byLower.has(key)) byLower.set(key, String(name));
  }
  const columns = {};
  for (const [field, names] of Object.entries(FIELD_NAMES)) {
    columns[field] = names.map((n) => byLower.get(n)).find(Boolean) ?? null;
  }
  const missing = REQUIRED.filter((f) => !columns[f]);
  if (missing.length) {
    throw new Error(
      `the feeds table has no ${missing.join(', ')} column; columns are ${[...byLower.values()].join(', ')}`,
    );
  }
  const categories = [...byLower.entries()]
    .filter(([k]) => /^category_?\d+$/.test(k))
    .sort((a, b) => Number(a[0].replace(/\D/g, '')) - Number(b[0].replace(/\D/g, '')))
    .map(([, real]) => real);
  return { columns, categories };
}

const quoteIdent = (name) => `"${String(name).replace(/"/g, '""')}"`;

/**
 * The walk's statement: every resolved column aliased onto its logical name,
 * categories as `category1..N`, keyed and ordered on the id so `id > ?` is an
 * index seek and the last id of a batch is the cursor.
 */
export function selectSql({ table, columns, categories }) {
  const parts = [];
  for (const [field, real] of Object.entries(columns)) {
    if (real) parts.push(`${quoteIdent(real)} as ${quoteIdent(field)}`);
  }
  categories.forEach((real, i) => {
    parts.push(`${quoteIdent(real)} as ${quoteIdent(`category${i + 1}`)}`);
  });
  const id = quoteIdent(columns.id);
  return `select ${parts.join(', ')} from ${quoteIdent(table)} where ${id} > ? order by ${id} limit ?`;
}

/** The table and columns of a dump, read from the file rather than the docs. */
export function discoverSchema(dbPath) {
  const names = [
    ...sqliteRows(
      dbPath,
      "select name from sqlite_master where type = 'table' and name not like 'sqlite_%'",
    ),
  ].map((r) => r.name);
  const tables = names.map((name) => ({
    name,
    columns: [...sqliteRows(dbPath, `pragma table_info(${quoteIdent(name)})`)].map((c) => c.name),
  }));
  const table = pickTable(tables);
  if (!table) {
    throw new Error(`no feeds table in the dump; tables: ${names.join(', ') || 'none'}`);
  }
  return { table: table.name, ...resolveColumns(table.columns) };
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** The extracted database, if the marker written after extraction says it is whole. */
async function readyDatabase(marker) {
  if (!(await exists(marker))) return null;
  const path = (await readFile(marker, 'utf8')).trim();
  return path && (await exists(path)) ? path : null;
}

/** The one `.db` file tar left in the directory, wherever in it the member landed. */
async function findDatabase(dir, depth = 0) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith('.db')) return join(dir, e.name);
  }
  if (depth < 2) {
    for (const e of entries) {
      if (e.isDirectory()) {
        const hit = await findDatabase(join(dir, e.name), depth + 1);
        if (hit) return hit;
      }
    }
  }
  return null;
}

/**
 * Everything in the dump directory that is not this version: the previous
 * dump's 5 GB database, or a partial archive of a file the server has since
 * replaced. Disk is the constraint here (7 GB per version), not history.
 */
async function pruneOthers(dir, stamp, log) {
  const keep = new Set([stamp, `${stamp}.db.tgz`]);
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (keep.has(e.name)) continue;
    await rm(join(dir, e.name), { recursive: true, force: true });
    log(`removed ${e.name} from the dump directory`);
  }
}

export const podcastindexCatalog = defineAdapter({
  name: 'podcastindex-catalog',
  title: 'Podcast Index: every feed',
  collection: 'podcasts',
  description:
    'Every podcast the Podcast Index has catalogued, several million feeds, read weekly from the SQLite database it publishes as a 1.8 GB download rather than from its keyed API: title, description, website, artwork, language, categories, episode count, the newest episode date, the iTunes id, the generator and the hosting platform, with dead feeds left out. The dump is published under the Podcast Index terms and the index data itself is MIT licensed. Keyless; the schema is read from the file at run time and each row carries the same normalised feed URL the other podcast sources do.',
  docs: DOCS_URL,
  kinds: ['show'],
  cadenceMinutes: CADENCE_MINUTES,
  budgetMs: BUDGET_MS,
  configFields: [
    {
      key: 'batchSize',
      label: 'Rows per batch',
      type: 'number',
      placeholder: String(BATCH),
      help: 'Rows read and written at once; the cursor moves by this much. 50 to 2,000.',
    },
    {
      key: 'pauseMs',
      label: 'Pause between retries (ms)',
      type: 'number',
      placeholder: String(PAUSE_MS),
      help: `A failed request is retried up to ${MAX_FAILURES} times with this pause.`,
    },
  ],
  defaults: { batchSize: BATCH, pauseMs: PAUSE_MS },
  defaultSources: [
    {
      slug: 'podcastindex-catalog',
      name: 'Podcasts: every feed in the Podcast Index',
      config: { batchSize: BATCH, pauseMs: PAUSE_MS },
    },
  ],
  async *pull({ config, cursor: prev, env, http, log, deadline }) {
    const batchSize = Math.max(50, Math.min(Math.floor(Number(config?.batchSize)) || BATCH, 2000));
    const pause =
      config?.pauseMs === 0 ? 0 : Math.max(0, Math.floor(Number(config?.pauseMs))) || PAUSE_MS;
    const stopAt = Number.isFinite(deadline)
      ? deadline - DEADLINE_MARGIN_MS
      : Number.POSITIVE_INFINITY;
    const ua = userAgent(env);
    const headers = { 'user-agent': ua };
    let succeeded = 0;

    /* One request, retried on consecutive failure. Returns null when the run
     * should stop: either every request so far failed (thrown, so the run is
     * an error) or this one failed three times after others succeeded (the
     * place is kept and the run resumes in ten minutes). */
    const attempt = async (what, fn) => {
      for (let failures = 0; ; ) {
        try {
          const out = await fn();
          succeeded += 1;
          return out;
        } catch (err) {
          failures += 1;
          log(`${what} failed (${failures}/${MAX_FAILURES}): ${message(err)}`);
          if (failures >= MAX_FAILURES) {
            if (succeeded === 0) throw new Error(`every request failed; last: ${message(err)}`);
            return null;
          }
          if (Date.now() >= stopAt) return null;
          await sleep(pause);
        }
      }
    };

    // 1. What the server has, and whether the cursor already walked it.
    const head = await attempt('HEAD', async () => {
      const res = await http.request(DUMP_URL, { method: 'HEAD', headers, timeoutMs: 60_000 });
      await res.body?.cancel().catch(() => {});
      if (!res.ok) throw new Error(`${res.status} from HEAD ${DUMP_URL}`);
      return dumpVersion(res.headers);
    });
    if (!head) return { cursor: prev ?? {}, note: 'HEAD failed', nextInMinutes: RESUME_IN_MINUTES };

    let { version } = head;
    const { lastModified, bytes } = head;
    if (!version) {
      version = new Date().toISOString().slice(0, 10);
      log(`the dump has no etag or last-modified; using today (${version}) as its version`);
    }

    const same = prev?.version === version;
    if (same && prev?.done) {
      log(`dump ${version} (${lastModified ?? 'no date'}) unchanged and fully read`);
      return { cursor: prev, note: 'unchanged' };
    }
    let afterId = same ? Math.max(0, Math.floor(Number(prev?.afterId)) || 0) : 0;
    const at = (extra = {}) => ({ version, lastModified, afterId, ...extra });
    if (!same && prev?.version) log(`new dump ${version}; the walk starts over`);

    // 2. The file, on disk and extracted. Resumable at every step.
    const dir = await dumpDir('podcastindex');
    const stamp = versionStamp(version);
    const tgz = join(dir, `${stamp}.db.tgz`);
    const extractDir = join(dir, stamp);
    const marker = join(extractDir, 'ready');
    let dbPath = await readyDatabase(marker);

    if (!dbPath) {
      await pruneOthers(dir, stamp, log);
      let lastLogged = 0;
      const dl = await attempt('download', () =>
        http.download(DUMP_URL, tgz, {
          headers,
          timeoutMs: Math.max(60_000, stopAt - Date.now()),
          onProgress: ({ bytes: got, total }) => {
            if (got - lastLogged < 200 * 1024 * 1024) return;
            lastLogged = got;
            log(
              `downloaded ${Math.round(got / 1e6)} of ${total ? Math.round(total / 1e6) : '?'} MB`,
            );
          },
        }),
      );
      if (!dl) {
        // Either the deadline arrived mid-transfer or three attempts failed in a
        // row; the partial file is on disk either way and the next run resumes it.
        const why =
          Date.now() >= stopAt
            ? 'download in progress'
            : 'download stopped after repeated failures';
        return { cursor: at(), note: why, nextInMinutes: RESUME_IN_MINUTES };
      }
      if (!dl.complete) {
        log(`download in progress: ${dl.bytes} of ${bytes ?? '?'} bytes`);
        return { cursor: at(), note: 'download in progress', nextInMinutes: RESUME_IN_MINUTES };
      }

      log(`extracting ${Math.round(dl.bytes / 1e6)} MB archive`);
      await untar(tgz, extractDir);
      dbPath = await findDatabase(extractDir);
      if (!dbPath) throw new Error('the archive held no .db file');
      await writeFile(marker, `${dbPath}\n`);
      // 1.8 GB the walk never reads again; the next version is a new download anyway.
      await rm(tgz, { force: true });
      log(`extracted ${dbPath}`);
    }

    // 3. The walk, 500 rows and one cursor at a time.
    const schema = discoverSchema(dbPath);
    const sql = selectSql(schema);
    log(
      `reading ${schema.table} (${Object.values(schema.columns).filter(Boolean).length} columns, ${schema.categories.length} category columns) from id ${afterId}`,
    );

    let batches = 0;
    let kept = 0;
    let skipped = 0;
    let bad = 0;
    for (;;) {
      const rows = [...sqliteRows(dbPath, sql, [afterId, batchSize])];
      if (rows.length === 0) {
        log(`walk complete at id ${afterId}: ${kept} shows, ${skipped} skipped, ${bad} bad rows`);
        return {
          cursor: at({ done: true }),
          note: `complete: ${kept} shows, ${skipped} skipped, ${bad} bad rows`,
        };
      }

      const out = rowsToItems(rows, { log });
      kept += out.kept;
      skipped += out.skipped;
      bad += out.bad;

      const lastId = positiveInt(rows[rows.length - 1]?.id);
      if (lastId === null || lastId <= afterId) {
        throw new Error(`the walk did not advance past id ${afterId}`);
      }
      afterId = lastId;
      batches += 1;
      yield { items: out.items, cursor: at() };

      if (Date.now() >= stopAt) {
        log(`out of time at id ${afterId} after ${batches} batches: ${kept} shows this run`);
        return {
          cursor: at(),
          note: `out of time at id ${afterId}: ${kept} shows, ${skipped} skipped`,
          nextInMinutes: RESUME_IN_MINUTES,
        };
      }
    }
  },
});
