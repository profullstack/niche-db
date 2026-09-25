import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { defineAdapter, looseDate, slugify } from '@nichedb/core/adapter';
import { dumpDir, xzLines } from '@nichedb/core/dump';

/**
 * MusicBrainz: every artist and every release group, for the `music` collection.
 *
 * musicbrainz-upcoming asks the web service for the releases dated in the next
 * few months; this is the rest of the database. MetaBrainz publishes the whole
 * thing twice a week as JSON dumps, one tar.xz per entity, and inside each the
 * member `mbdump/<entity>` is NDJSON: one object per line, the last line
 * without a newline. The core data is CC0, so it can be carried whole with a
 * credit; the tags, genres, ratings and annotations in the same rows are CC
 * BY-NC-SA and are dropped before anything is stored, as are the relation
 * lists, which are most of the bytes and none of the catalogue.
 *
 * THE WALK
 *
 * `LATEST` names the current dump directory. Each run resolves it, downloads
 * the current entity's archive into the dump directory with `http.download`
 * (which resumes with Range; MetaBrainz honours it), and streams the member
 * through `xzLines` from the line the cursor names, yielding a batch every
 * few hundred rows with the cursor `{ dir, entity, line }` after it. The
 * artist file is 1.7 GB and the walk is a couple of million lines, so a run
 * is budgeted 55 minutes and stops itself short of that with a cursor and a
 * ten-minute resume; a run that is still downloading yields nothing and asks
 * for the same. Artists first, then release groups; when both are read the
 * cursor is marked done and the weekly run only compares `LATEST`, restarting
 * at line 0 of the artist file when a new directory appears.
 *
 * Memory is one batch of items: the archive is read by a spawned `tar`, each
 * line is parsed, mapped and dropped, and the row's relations never survive
 * the mapping. Resuming into an xz stream re-inflates from the top of the
 * member (two to three minutes at the end of the artist file), which an hourly
 * run absorbs.
 *
 * Every request carries a descriptive user agent. A failed `LATEST` is retried
 * three times and a run in which every request failed throws; a download that
 * fails three times in a row ends the run with the place kept (the partial
 * file stays on disk for the next resume). A line that is not JSON, or not an
 * entity, is counted and skipped, never thrown. An archive on disk that tar
 * cannot read is removed and fetched once more in the same run, from the last
 * batch yielded; a second unreadable copy throws.
 */

export const BASE = 'https://data.metabrainz.org/pub/musicbrainz/data/json-dumps';
export const LATEST_URL = `${BASE}/LATEST`;

/** Entities walked, in this order. */
export const ENTITIES = ['artist', 'release-group'];

/** Who is asking. */
export const USER_AGENT = 'nichedb (https://nichedb.dev; hello@nichedb.dev)';

export const PROVIDER = 'musicbrainz';
export const ATTRIBUTION = 'MusicBrainz, CC0';

/** Rows per yielded batch: the memory a run holds at once. */
export const BATCH_SIZE = 500;

/** The dumps land twice a week; a week keeps one full walk between them. */
export const CADENCE_MINUTES = 10_080;

/** Wall-clock budget of one run. */
export const BUDGET_MS = 55 * 60_000;

/** When a run stops early (deadline, download, failures) it asks to continue in this many minutes. */
export const RESUME_MINUTES = 10;

/** A run stops yielding this close to its deadline, so the last batch lands inside the lock. */
export const NEAR_MS = 60_000;

/** Pause before retrying a failed request. */
export const RETRY_PAUSE_MS = 5_000;

/** Consecutive failures after which a run stops asking. */
const FAILURE_STOP = 3;

const UA_HEADERS = { 'user-agent': USER_AGENT };

/** The reader's own failure: tar could not read the archive on disk. Anything else is not the file's fault. */
const unreadable = (err) => /^(?:tar|xz) exited \d+/.test(String(err?.message ?? ''));

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

export const dumpUrl = (dir, entity) =>
  `${BASE}/${encodeURIComponent(String(dir))}/${encodeURIComponent(String(entity))}.tar.xz`;

/** The NDJSON member inside an entity's archive. */
export const memberOf = (entity) => `mbdump/${entity}`;

/** Where an entity's archive lives on disk; the dump directory is in the name so a new dump is a new file. */
export const localFile = (dataDir, dir, entity) => join(dataDir, `${dir}-${entity}.tar.xz`);

/** `LATEST` is one line, `20260912-001001`. Anything else is not a directory name. */
export function parseLatest(text) {
  const first = String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  return first && /^\d{8}-\d{6}$/.test(first) ? first : null;
}

/**
 * Where a run starts. A cursor from another dump directory restarts the walk
 * at the first entity's first line; `done` only holds for the same directory.
 */
export function resumeFrom(prev, dir, entities = ENTITIES) {
  if (!prev || typeof prev !== 'object' || prev.dir !== dir) {
    return { dir, entity: entities[0], line: 0, done: false };
  }
  const entity = entities.includes(prev.entity) ? prev.entity : entities[0];
  const line = Math.max(0, Math.floor(Number(prev.line)) || 0);
  return { dir, entity, line, done: prev.done === true };
}

/** One dump line as an object, or null: a bad line is the caller's count, not its crash. */
export function parseRow(line) {
  if (typeof line !== 'string' || !line.trim()) return null;
  try {
    const row = JSON.parse(line);
    return row && typeof row === 'object' && !Array.isArray(row) ? row : null;
  } catch {
    return null;
  }
}

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const strings = (v) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
const uniq = (xs) => [...new Set(xs.filter(Boolean))];
const names = (v) => uniq(Array.isArray(v) ? v.map((a) => str(a?.name)) : []);

/** An artist row as an item. The CC BY-NC-SA fields and the relations never reach it. */
export function artistItem(a) {
  const id = str(a?.id);
  const name = str(a?.name);
  if (!id || !name) return null;
  const type = str(a.type);
  const country = str(a.country);
  const life = a['life-span'] && typeof a['life-span'] === 'object' ? a['life-span'] : {};
  return {
    externalId: `musicbrainz:artist:${id}`,
    kind: 'artist',
    title: name,
    summary: str(a.disambiguation),
    url: `https://musicbrainz.org/artist/${id}`,
    imageUrl: null,
    tags: uniq([
      'artist',
      PROVIDER,
      type ? `type:${slugify(type)}` : null,
      country ? `country:${country.toLowerCase()}` : null,
    ]),
    data: {
      mbid: id,
      sortName: str(a['sort-name']),
      type,
      gender: str(a.gender),
      country,
      area: str(a.area?.name),
      beginArea: str(a['begin-area']?.name),
      lifeSpan: {
        begin: str(life.begin),
        end: str(life.end),
        ended: life.ended === true,
      },
      aliases: names(a.aliases),
      isnis: strings(a.isnis),
      ipis: strings(a.ipis),
      attribution: ATTRIBUTION,
    },
  };
}

/** The credited artists of a release group: `[{ name, mbid }]`, in credit order. */
export function artistCredit(credit) {
  if (!Array.isArray(credit)) return [];
  return credit
    .map((c) => ({ name: str(c?.name) ?? str(c?.artist?.name), mbid: str(c?.artist?.id) }))
    .filter((c) => c.name);
}

/** The credit as it reads on a sleeve: names joined by their join phrases. */
export function creditText(credit) {
  if (!Array.isArray(credit)) return null;
  const text = credit
    .map((c) => `${str(c?.name) ?? str(c?.artist?.name) ?? ''}${c?.joinphrase ?? ''}`)
    .join('')
    .trim();
  return text || null;
}

/**
 * A release group row as an item. The cover is hot-linked from the Cover Art
 * Archive by release-group id; it answers 404 for a group with no art.
 */
export function releaseGroupItem(g) {
  const id = str(g?.id);
  const title = str(g?.title);
  if (!id || !title) return null;
  const primary = str(g['primary-type']);
  const secondary = strings(g['secondary-types']);
  const credit = creditText(g['artist-credit']);
  const firstReleaseDate = str(g['first-release-date']);
  const when = looseDate(firstReleaseDate ?? '');
  const disambiguation = str(g.disambiguation);
  return {
    externalId: `musicbrainz:release-group:${id}`,
    kind: 'release-group',
    title,
    summary:
      [credit ? `by ${credit}` : null, disambiguation ? `(${disambiguation})` : null]
        .filter(Boolean)
        .join(' ') || null,
    url: `https://musicbrainz.org/release-group/${id}`,
    imageUrl: `https://coverartarchive.org/release-group/${id}/front-250`,
    publishedAt: when.publishedAt,
    timeKnown: false,
    precision: when.precision,
    tags: uniq([
      'release-group',
      PROVIDER,
      primary ? `type:${slugify(primary)}` : null,
      ...secondary.map((s) => `secondary:${slugify(s)}`),
    ]),
    data: {
      mbid: id,
      primaryType: primary,
      secondaryTypes: secondary,
      firstReleaseDate,
      artistCredit: artistCredit(g['artist-credit']),
      attribution: ATTRIBUTION,
    },
  };
}

/** The item for one row of the named entity's member, or null when it is not one. */
export function toItem(entity, row) {
  if (!row) return null;
  if (entity === 'artist') return artistItem(row);
  if (entity === 'release-group') return releaseGroupItem(row);
  return null;
}

/** The entity after this one, or null at the end of the list. */
export const nextEntity = (entity, entities = ENTITIES) =>
  entities[entities.indexOf(entity) + 1] ?? null;

/**
 * Drop the archives of any other dump directory. The disk under the dump
 * directory is a cache and this keeps it to one dump's worth.
 */
export async function pruneOthers(dataDir, dir) {
  const keep = `${dir}-`;
  let removed = 0;
  for (const name of await readdir(dataDir)) {
    if (!name.endsWith('.tar.xz') || name.startsWith(keep)) continue;
    await unlink(join(dataDir, name)).catch(() => {});
    removed += 1;
  }
  return removed;
}

/**
 * The walk itself, as the async generator the core drains.
 *
 * `opts` is the test seam: `dataDir` in place of `dumpDir('musicbrainz')`,
 * `pauseMs` in place of the retry pause and `now` in place of the clock. The
 * adapter's `pull` passes none of them.
 *
 * It is also how another adapter walks other entities of the same dump:
 * `entities` in place of ENTITIES, `map(entity, row)` in place of `toItem`
 * and `dumpName` for a cache directory of its own, so neither adapter's
 * prune removes an archive the other is part way through.
 */
export async function* walk(
  { config, cursor: prev, http, log, deadline },
  {
    dataDir = null,
    pauseMs = RETRY_PAUSE_MS,
    now = Date.now,
    entities = ENTITIES,
    map = toItem,
    dumpName = 'musicbrainz',
  } = {},
) {
  const stopAt = Number.isFinite(deadline) ? deadline : Number.POSITIVE_INFINITY;
  const batchSize = Math.max(1, Math.floor(Number(config?.batchSize)) || BATCH_SIZE);
  const near = () => now() > stopAt - NEAR_MS;
  const stopIn = RESUME_MINUTES;
  let requests = 0;
  let failures = 0;

  // The current dump directory. Three tries; a run that never reached the server throws.
  let dir = null;
  for (let attempt = 0; attempt < FAILURE_STOP && !dir; attempt++) {
    if (attempt > 0) await sleep(pauseMs);
    requests += 1;
    try {
      const text = await http.text(LATEST_URL, {
        headers: { ...UA_HEADERS, accept: 'text/plain, */*' },
        timeoutMs: 20_000,
      });
      dir = parseLatest(text);
      if (!dir)
        throw new Error(`LATEST is not a dump directory name: ${String(text).slice(0, 40)}`);
    } catch (err) {
      failures += 1;
      log(`LATEST unavailable (${err?.message ?? err})`);
    }
  }
  if (!dir) throw new Error(`musicbrainz: every request failed (${requests}); see the log`);

  const state = resumeFrom(prev, dir, entities);
  if (state.done) {
    log(`dump ${dir} already walked; nothing to do`);
    return { cursor: prev, note: 'unchanged' };
  }

  const base = dataDir ?? (await dumpDir(dumpName));
  const pruned = await pruneOthers(base, dir).catch(() => 0);
  if (pruned) log(`${pruned} archive${pruned === 1 ? '' : 's'} of an older dump removed`);

  let entity = state.entity;
  let line = state.line;
  let seen = 0;
  let bad = 0;
  const reread = new Set();
  const at = () => ({ dir, entity, line });
  const progress = () => `${seen} rows${bad ? `, ${bad} bad` : ''}`;

  while (entity) {
    // ── Download, resuming whatever is on disk ────────────────────────────
    const file = localFile(base, dir, entity);
    let dl = null;
    let streak = 0;
    while (!dl) {
      if (near()) {
        return {
          cursor: at(),
          note: `${progress()}; ${entity} download deferred by the run deadline at line ${line}, resuming in ${stopIn} min`,
          nextInMinutes: stopIn,
        };
      }
      requests += 1;
      let lastLogged = 0;
      try {
        dl = await http.download(dumpUrl(dir, entity), file, {
          headers: UA_HEADERS,
          timeoutMs: Number.isFinite(stopAt)
            ? Math.max(60_000, stopAt - now() - NEAR_MS)
            : 60 * 60_000,
          onProgress: ({ bytes, total }) => {
            if (bytes - lastLogged < 256 * 1024 * 1024) return;
            lastLogged = bytes;
            log(
              `${entity}: ${Math.round(bytes / 1_048_576)} of ${total ? Math.round(total / 1_048_576) : '?'} MB`,
            );
          },
        });
      } catch (err) {
        failures += 1;
        streak += 1;
        log(`${entity} download failed (${err?.message ?? err})`);
        if (streak >= FAILURE_STOP) {
          if (failures === requests)
            throw new Error(`musicbrainz: every request failed (${requests}); see the log`);
          return {
            cursor: at(),
            note: `${progress()}; ${entity} download failed ${streak} times, resuming in ${stopIn} min from line ${line}`,
            nextInMinutes: stopIn,
          };
        }
        await sleep(pauseMs);
      }
    }
    if (!dl.complete) {
      log(`${entity}: ${dl.bytes} bytes on disk, download in progress`);
      return {
        cursor: at(),
        note: `${progress()}; ${entity} download in progress (${Math.round(dl.bytes / 1_048_576)} MB), resuming in ${stopIn} min`,
        nextInMinutes: stopIn,
      };
    }

    // ── Stream the member from the cursor's line ──────────────────────────
    let batch = [];
    let yielded = line;
    try {
      for await (const text of xzLines(file, { member: memberOf(entity), skip: line })) {
        line += 1;
        const item = map(entity, parseRow(text));
        if (!item) {
          if (text.trim()) bad += 1;
          continue;
        }
        batch.push(item);
        if (batch.length >= batchSize) {
          seen += batch.length;
          yield { items: batch, cursor: at() };
          yielded = line;
          batch = [];
          if (near()) {
            return {
              cursor: at(),
              note: `${progress()}; stopped on the run deadline at ${entity} line ${line} of ${dir}, resuming in ${stopIn} min`,
              nextInMinutes: stopIn,
            };
          }
        }
      }
    } catch (err) {
      if (!unreadable(err)) throw err;
      // The file on disk is not one tar can read (a bad write, a volume that
      // outlived a different build of the archive). Left there it would fail
      // every run, since http.download sees a whole file and fetches nothing.
      // Drop it and fetch it once more, resuming from the last batch yielded.
      await unlink(file).catch(() => {});
      log(`${entity}: archive of ${dir} removed, ${err.message}`);
      if (reread.has(entity)) {
        throw new Error(
          `musicbrainz: ${entity} archive of ${dir} unreadable twice (${err.message})`,
        );
      }
      reread.add(entity);
      line = yielded;
      continue;
    }
    if (batch.length) {
      seen += batch.length;
      yield { items: batch, cursor: at() };
      batch = [];
    }
    log(`${entity}: ${line} lines of ${dir} read`);

    const next = nextEntity(entity, entities);
    if (!next) {
      return {
        cursor: { ...at(), done: true },
        note: `${progress()}; dump ${dir} walked, ${entities.join(' and ')} complete`,
      };
    }
    entity = next;
    line = 0;
  }
  return { cursor: at(), note: progress() };
}

export const musicbrainzCatalog = defineAdapter({
  name: 'musicbrainz-catalog',
  title: 'MusicBrainz: every artist and release group',
  collection: 'music',
  description:
    'Every artist and every release group in MusicBrainz, from the twice-weekly JSON dumps: an artist row carries the name, sort name, disambiguation, type, gender, country, area, life span, aliases, ISNIs and IPIs; a release group row carries the title, artist credit, primary and secondary types, first release date and a Cover Art Archive front image where one exists. The core MusicBrainz data is CC0 and is carried whole with a credit on every row, while the tags, genres, ratings and annotations in the dumps are CC BY-NC-SA and are dropped. Downloads the 1.7 GB artist and 1.2 GB release-group archives with resume and streams them in 55-minute runs, resuming from its cursor until a dump is walked; a new dump restarts the walk.',
  docs: 'https://musicbrainz.org/doc/MusicBrainz_Database/Download',
  kinds: ['artist', 'release-group'],
  cadenceMinutes: CADENCE_MINUTES,
  budgetMs: BUDGET_MS,
  configFields: [
    {
      key: 'batchSize',
      label: 'Rows per batch',
      type: 'number',
      placeholder: String(BATCH_SIZE),
      help: 'Rows mapped and written together; the cursor is saved after each batch.',
    },
  ],
  defaults: { batchSize: BATCH_SIZE },
  defaultSources: [
    {
      slug: 'musicbrainz-catalog',
      name: 'Music: every artist and release group on MusicBrainz',
      config: { batchSize: BATCH_SIZE },
    },
  ],
  pull: (ctx) => walk(ctx),
});
