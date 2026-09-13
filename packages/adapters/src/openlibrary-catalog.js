import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { defineAdapter, looseDate, slugify } from '@nichedb/core/adapter';
import { dumpDir, gzipLines } from '@nichedb/core/dump';

/**
 * Open Library: every work and every author, from the monthly dumps.
 *
 * openlibrary-new asks the search API for the books first published this
 * year, a few hundred rows. This is the rest of the catalogue: Open Library
 * publishes its whole database once a month as gzipped tab-separated files on
 * archive.org (openlibrary.org/developers/dumps), one row per record with
 * five columns: type, key, revision, last_modified and the record as JSON.
 * The authors file is 780 MB compressed (about 15 million rows) and the works
 * file 4 GB (about 40 million), so nothing here fits in a run or in memory:
 * the file is downloaded with resume into the dump directory, then walked as
 * lines, 500 rows a batch, with the cursor after every batch saying which file
 * and which line to continue from. A run stops when its budget is spent and
 * the next one, ten minutes later, re-inflates up to that line and carries on.
 *
 * The `_latest` URLs redirect twice (openlibrary.org, then archive.org, then
 * an archive.org mirror) and land on a file named with the dump date. That
 * date is the version: one HEAD request at the start of a run resolves it, the
 * download then asks the DATED URL directly so a resume can never append the
 * bytes of a newer dump to an older partial file, and a cursor that names a
 * different date starts the walk over. Once both files are walked the cursor
 * is `done` and every run until the date changes costs one HEAD request.
 *
 * A re-ingest of a new dump writes every row again in principle, but the
 * table skips an unchanged row by hash and the walk skips a row before it
 * reaches the table: the cursor of a complete pass carries the newest
 * `last_modified` it saw, and the next pass drops rows modified before that
 * mark, which on a monthly dump is nearly all of them.
 *
 * Works keep the `/works/OL...W` key as the external id, exactly as
 * openlibrary-new does, so a work walked here and the same work found by the
 * search source are one row. Authors are new here, `/authors/OL...A`.
 *
 * The data is Open Library's, published by the Internet Archive without a new
 * copyright claim (the records are contributed and pooled from library
 * catalogues); every row carries that attribution.
 */

/** Who is asking; archive.org and openlibrary.org both want a readable agent. */
export const USER_AGENT = 'nichedb (https://nichedb.dev; hello@nichedb.dev)';

export const PROVIDER = 'openlibrary';
export const ATTRIBUTION = 'Open Library (Internet Archive); no new copyright asserted';

/** The subdirectory of the dump directory the two files live in. */
export const DUMP_DIR = 'openlibrary-catalog';

/** The files of one dump, in the order they are walked. */
export const FILES = ['authors', 'works'];

/** Rows handed to the core at once; the memory a run holds. */
export const BATCH_ROWS = 500;

/** A run's wall-clock budget. The walk of the works file is several of these. */
export const BUDGET_MS = 55 * 60_000;

/** Open Library publishes a dump once a month. */
export const CADENCE_MINUTES = 30 * 24 * 60;

/** How soon an unfinished walk, or an unfinished download, picks up again. */
export const RESUME_MINUTES = 10;

/** The least a download is given; with less than this left a run does not start one. */
export const DOWNLOAD_MIN_MS = 30_000;

/** Consecutive failed requests after which a run stops asking. */
export const FAILURE_STOP = 3;

/** Pause before a retry; three requests in a second at archive.org looks like hammering. */
export const PAUSE_MS = 2000;

/** Summary and bio length. */
export const SUMMARY_CHARS = 600;

/** Subjects that become tags; the data keeps more. */
export const SUBJECT_TAGS = 5;

/** How many entries of a list field the data keeps, so one row stays a row. */
export const LIST_KEPT = 100;

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

// ── URLs and files ───────────────────────────────────────────────────────────

/** The always-current URL of one file; a HEAD on it resolves the dump date. */
export const latestUrl = (kind) => `https://openlibrary.org/data/ol_dump_${kind}_latest.txt.gz`;

/** The dated file on archive.org, the same bytes for the life of the dump. */
export const datedUrl = (kind, version) =>
  `https://archive.org/download/ol_dump_${version}/ol_dump_${kind}_${version}.txt.gz`;

/** Where one file of one dump is kept locally. */
export const localName = (kind, version) => `ol_dump_${kind}_${version}.txt.gz`;

/** The dump date in a resolved URL, `2026-08-31`, or null. */
export function versionFromUrl(url) {
  const m = String(url ?? '').match(
    /ol_dump_(?:authors|works|editions|all)_(\d{4}-\d{2}-\d{2})\.txt\.gz/,
  );
  return m ? m[1] : null;
}

// ── Rows ─────────────────────────────────────────────────────────────────────

/**
 * One line of a dump: `type \t key \t revision \t last_modified \t JSON`, the
 * JSON being everything after the fourth tab. Null for a line that is not a
 * row (blank, short, or cut mid-JSON, which the last line of a truncated
 * download is); the caller counts it and moves on.
 */
export function parseRow(line) {
  if (!line) return null;
  const cols = splitN(line, '\t', 5);
  if (cols.length < 5) return null;
  let json;
  try {
    json = JSON.parse(cols[4]);
  } catch {
    return null;
  }
  if (!json || typeof json !== 'object') return null;
  return {
    type: cols[0],
    key: cols[1],
    revision: Number(cols[2]) || 0,
    lastModified: cols[3],
    json,
  };
}

/** `s.split(sep)` limited to `n` fields, the last one keeping the rest. */
export function splitN(s, sep, n) {
  const out = [];
  let from = 0;
  while (out.length < n - 1) {
    const at = s.indexOf(sep, from);
    if (at === -1) break;
    out.push(s.slice(from, at));
    from = at + 1;
  }
  out.push(s.slice(from));
  return out;
}

/** A text field that is a string or `{ type: '/type/text', value }`. */
export function textOf(v) {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && typeof v.value === 'string') return v.value;
  return '';
}

/** Whitespace collapsed and cut to `n` characters on a word where it can. */
export function trimTo(s, n = SUMMARY_CHARS) {
  const text = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= n) return text || null;
  const cut = text.slice(0, n);
  const at = cut.lastIndexOf(' ');
  return `${(at > n / 2 ? cut.slice(0, at) : cut).trim()}...`;
}

/** Strings only, trimmed, non-empty, at most `n` of them. */
export function strings(v, n = LIST_KEPT) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const s of v) {
    if (typeof s !== 'string') continue;
    const t = s.trim();
    if (t) out.push(t);
    if (out.length >= n) break;
  }
  return out;
}

/** Author keys of a work: `authors: [{ author: { key } }]`, or bare `{ key }`. */
export function authorKeys(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const a of v) {
    const key = a?.author?.key ?? a?.key;
    if (typeof key === 'string' && key.startsWith('/authors/')) out.push(key);
  }
  return out;
}

const MONTHS = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

const pad = (n) => String(n).padStart(2, '0');

/**
 * `first_publish_date` is free text: `1964`, `June 1940`, `January 1, 1967`,
 * `August 9, 2007`, `1907-02-16`, and worse. Read the shapes that occur, fall
 * back to the first four-digit year in the string, and hand the result to
 * looseDate so the precision matches what the text actually said.
 */
export function publishDate(s) {
  const text = String(s ?? '').trim();
  if (!text) return looseDate('');
  if (/^\d{4}(-\d{2}){0,2}$/.test(text)) return looseDate(text);
  let m = text.match(/^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m && MONTHS[m[1].toLowerCase()]) {
    return looseDate(`${m[3]}-${pad(MONTHS[m[1].toLowerCase()])}-${pad(m[2])}`);
  }
  m = text.match(/^([A-Za-z]+)\.?,?\s+(\d{4})$/);
  if (m && MONTHS[m[1].toLowerCase()]) {
    return looseDate(`${m[2]}-${pad(MONTHS[m[1].toLowerCase()])}`);
  }
  m = text.match(/^(\d{1,2})\s+([A-Za-z]+)\.?\s+(\d{4})$/);
  if (m && MONTHS[m[2].toLowerCase()]) {
    return looseDate(`${m[3]}-${pad(MONTHS[m[2].toLowerCase()])}-${pad(m[1])}`);
  }
  m = text.match(/\b(\d{4})\b/);
  return looseDate(m ? m[1] : '');
}

/** A cover or photo id becomes a URL; Open Library uses -1 for "none". */
export function coverUrl(ids, kind) {
  const id = Array.isArray(ids) ? Number(ids[0]) : Number.NaN;
  if (!Number.isInteger(id) || id <= 0) return null;
  return `https://covers.openlibrary.org/${kind}/id/${id}-M.jpg`;
}

/** One work row as an item, or null for a row without a key or a title. */
export function workItem(row) {
  const d = row?.json;
  const key = typeof d?.key === 'string' ? d.key : row?.key;
  const title = typeof d?.title === 'string' ? d.title.trim() : '';
  if (!key || !/^\/works\/OL\d+W$/.test(key) || !title) return null;
  const when = publishDate(d.first_publish_date);
  const subjects = strings(d.subjects);
  const subtitle = typeof d.subtitle === 'string' ? d.subtitle.trim() : '';
  return {
    externalId: key,
    kind: 'book',
    title: subtitle ? `${title}: ${subtitle}` : title,
    summary: trimTo(textOf(d.description)),
    url: `https://openlibrary.org${key}`,
    imageUrl: coverUrl(d.covers, 'b'),
    publishedAt: when.publishedAt,
    timeKnown: when.timeKnown,
    precision: when.precision,
    tags: [
      'book',
      PROVIDER,
      ...subjects
        .slice(0, SUBJECT_TAGS)
        .map((s) => slugify(s))
        .filter(Boolean)
        .map((s) => `subject:${s}`),
    ],
    data: {
      provider: PROVIDER,
      olKey: key,
      title,
      subtitle: subtitle || null,
      authors: authorKeys(d.authors),
      subjects,
      subjectPlaces: strings(d.subject_places),
      subjectPeople: strings(d.subject_people),
      subjectTimes: strings(d.subject_times),
      firstPublishDate: typeof d.first_publish_date === 'string' ? d.first_publish_date : null,
      covers: Array.isArray(d.covers)
        ? d.covers.filter((c) => Number.isInteger(c)).slice(0, 10)
        : [],
      revision: row.revision,
      lastModified: row.lastModified,
      attribution: ATTRIBUTION,
    },
  };
}

/** The ids Open Library keeps for an author elsewhere; only the ones asked for. */
export function remoteIds(v) {
  if (!v || typeof v !== 'object') return {};
  const out = {};
  for (const k of ['wikidata', 'viaf', 'isni']) {
    if (typeof v[k] === 'string' && v[k].trim()) out[k] = v[k].trim();
  }
  return out;
}

/** `links: [{ title, url }]`, kept as that. */
export function authorLinks(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const l of v) {
    if (typeof l?.url !== 'string' || !/^https?:\/\//.test(l.url)) continue;
    out.push({ title: typeof l.title === 'string' ? l.title : null, url: l.url });
    if (out.length >= 20) break;
  }
  return out;
}

/** One author row as an item, or null for a row without a key or a name. */
export function authorItem(row) {
  const d = row?.json;
  const key = typeof d?.key === 'string' ? d.key : row?.key;
  const name = typeof d?.name === 'string' ? d.name.trim() : '';
  if (!key || !/^\/authors\/OL\d+A$/.test(key) || !name) return null;
  return {
    externalId: key,
    kind: 'author',
    title: name,
    summary: trimTo(textOf(d.bio)),
    url: `https://openlibrary.org${key}`,
    imageUrl: coverUrl(d.photos, 'a'),
    publishedAt: null,
    timeKnown: false,
    precision: 'day',
    tags: ['author', PROVIDER],
    data: {
      provider: PROVIDER,
      olKey: key,
      name,
      personalName: typeof d.personal_name === 'string' ? d.personal_name : null,
      birthDate: typeof d.birth_date === 'string' ? d.birth_date : null,
      deathDate: typeof d.death_date === 'string' ? d.death_date : null,
      alternateNames: strings(d.alternate_names, 20),
      links: authorLinks(d.links),
      remoteIds: remoteIds(d.remote_ids),
      revision: row.revision,
      lastModified: row.lastModified,
      attribution: ATTRIBUTION,
    },
  };
}

/** A parsed row as an item by its type; a redirect, a delete or a stray type is nothing. */
export function rowItem(row) {
  if (row?.type === '/type/work') return workItem(row);
  if (row?.type === '/type/author') return authorItem(row);
  return null;
}

// ── Cursor ───────────────────────────────────────────────────────────────────

/**
 * Where a run starts.
 *
 * `version` is the dump date the walk is over; `file` and `line` the position
 * in it (the line count already read, so the reader skips that many);
 * `lastModifiedWatermark` the newest last_modified a COMPLETE pass has seen,
 * below which a later pass skips rows; `maxLastModified` the same for the pass
 * in progress; `done` that both files of `version` are walked.
 */
export function resumeFrom(prev) {
  const version = /^\d{4}-\d{2}-\d{2}$/.test(String(prev?.version ?? '')) ? prev.version : null;
  const file = FILES.includes(prev?.file) ? prev.file : FILES[0];
  const line = Math.floor(Number(prev?.line));
  const watermark =
    typeof prev?.lastModifiedWatermark === 'string' && prev.lastModifiedWatermark
      ? prev.lastModifiedWatermark
      : null;
  const max =
    typeof prev?.maxLastModified === 'string' && prev.maxLastModified ? prev.maxLastModified : null;
  return {
    version,
    file,
    line: line > 0 ? line : 0,
    lastModifiedWatermark: watermark,
    maxLastModified: max,
    done: version !== null && prev?.done === true,
  };
}

/** A row modified before the watermark was in the previous pass unchanged. */
export const isStale = (lastModified, watermark) =>
  Boolean(watermark) && typeof lastModified === 'string' && lastModified < watermark;

/** The local files of other dumps than `version`, which nothing will read again. */
export function staleFiles(names, version) {
  return names.filter(
    (n) =>
      /^ol_dump_(?:authors|works)_\d{4}-\d{2}-\d{2}\.txt\.gz$/.test(n) &&
      !n.includes(`_${version}.`),
  );
}

// ── The adapter ──────────────────────────────────────────────────────────────

/**
 * The dump date behind the `_latest` URL: one HEAD request through the two
 * redirects, the date read off the final URL. Nothing else names the dump:
 * Last-Modified is the upload, days after the date in the file name, and a
 * dated URL built from it would ask archive.org for an item it does not have.
 * A mirror that hands back something unnamed is a failed request, and a walk
 * in progress carries on with the date its cursor already knows.
 */
export async function resolveVersion(http) {
  const res = await http.request(latestUrl(FILES[0]), {
    method: 'HEAD',
    headers: { 'user-agent': USER_AGENT, accept: '*/*' },
    timeoutMs: 30_000,
  });
  await res.body?.cancel?.().catch?.(() => {});
  if (!res.ok) throw new Error(`openlibrary answered ${res.status} for the latest dump`);
  const version = versionFromUrl(res.url);
  if (!version) {
    throw new Error(
      `openlibrary did not say which dump is latest (${String(res.url).slice(0, 120)})`,
    );
  }
  return version;
}

export const openlibraryCatalog = defineAdapter({
  name: 'openlibrary-catalog',
  title: 'Open Library: every work and author',
  collection: 'books',
  description:
    'Every work and every author in Open Library, from the monthly dumps: about 40 million works as book rows (title, description, cover, first publish date, subjects, author keys) and 15 million authors (name, bio, photo, dates, alternate names, links, Wikidata, VIAF and ISNI ids). Open Library data is published by the Internet Archive with no new copyright asserted and is attributed on every row. Downloads the two gzipped dumps with resume, walks them 500 rows a batch across as many runs as it takes, and after a complete pass skips the rows an earlier dump already carried. Works share the openlibrary-new external id, so the two sources merge.',
  docs: 'https://openlibrary.org/developers/dumps',
  kinds: ['book', 'author'],
  cadenceMinutes: CADENCE_MINUTES,
  budgetMs: BUDGET_MS,
  configFields: [
    {
      key: 'batchRows',
      label: 'Rows per batch',
      type: 'number',
      placeholder: String(BATCH_ROWS),
      help: 'Rows handed to the table at once. The cursor is saved after every batch.',
    },
    {
      key: 'pauseMs',
      label: 'Pause before a retry (ms)',
      type: 'number',
      placeholder: String(PAUSE_MS),
      help: 'After a failed request. Three failures in a row end the run; it resumes in ten minutes.',
    },
  ],
  defaults: { batchRows: BATCH_ROWS, pauseMs: PAUSE_MS },
  defaultSources: [
    {
      slug: 'openlibrary-catalog',
      name: 'Books: every work and author in Open Library',
      config: { batchRows: BATCH_ROWS, pauseMs: PAUSE_MS },
    },
  ],
  async *pull({ config, cursor: prev, http, log, deadline }) {
    const batchRows = Math.max(1, Math.floor(Number(config?.batchRows)) || BATCH_ROWS);
    const pause =
      config?.pauseMs === 0 ? 0 : Math.max(0, Math.floor(Number(config?.pauseMs))) || PAUSE_MS;
    const stopAt = Number.isFinite(deadline) ? deadline : Number.POSITIVE_INFINITY;
    const state = resumeFrom(prev);
    let requests = 0;
    let failures = 0;
    let streak = 0;

    const failed = (what, err) => {
      failures += 1;
      streak += 1;
      log(`${what} failed (${err?.message ?? err})`);
      return streak >= FAILURE_STOP;
    };
    const allFailed = () => {
      if (requests > 0 && failures === requests)
        throw new Error(`openlibrary: every request failed (${requests}); see the log`);
    };

    // ── Which dump ───────────────────────────────────────────────────────
    let version = null;
    while (version === null) {
      requests += 1;
      try {
        version = await resolveVersion(http);
        streak = 0;
      } catch (err) {
        if (failed('resolving the latest dump', err)) break;
        await sleep(pause);
      }
    }
    if (version === null) {
      // The walk in progress does not need to know what is newest.
      if (state.version && !state.done) version = state.version;
      else {
        allFailed();
        return {
          cursor: prev ?? {},
          note: 'could not resolve the latest dump; resuming in 10 min',
          nextInMinutes: RESUME_MINUTES,
        };
      }
    }

    if (state.version === version && state.done) {
      log(`dump ${version} already walked; nothing to do`);
      return { cursor: prev, note: `unchanged (${version})` };
    }

    const fresh = state.version !== version;
    const watermark = state.lastModifiedWatermark;
    let file = fresh ? FILES[0] : state.file;
    let line = fresh ? 0 : state.line;
    let maxLastModified = fresh ? null : state.maxLastModified;
    const cursorAt = (f, n) => ({
      version,
      file: f,
      line: n,
      lastModifiedWatermark: watermark,
      maxLastModified,
      done: false,
    });
    if (fresh) {
      log(
        `dump ${version}${state.version ? ` replaces ${state.version}` : ''}` +
          (watermark ? `; rows modified before ${watermark} are skipped` : ''),
      );
    }

    const dir = await dumpDir(DUMP_DIR);
    for (const name of staleFiles(await readdir(dir).catch(() => []), version)) {
      await unlink(join(dir, name)).catch(() => {});
    }

    let batches = 0;
    let rows = 0;
    let bad = 0;
    let stale = 0;
    let written = 0;

    // ── The walk ─────────────────────────────────────────────────────────
    for (let fi = FILES.indexOf(file); fi < FILES.length; fi++) {
      const kind = FILES[fi];
      const path = join(dir, localName(kind, version));
      const summary = () =>
        `${written} rows written in ${batches} batches` +
        (stale ? `, ${stale} unchanged skipped` : '') +
        (bad ? `, ${bad} unreadable` : '') +
        (failures ? `, ${failures} requests failed` : '');

      // Download, resuming whatever is on disk, until the file is whole.
      // With less than the floor of the transfer timeout left there is no
      // point starting one: stop here and let the next run make the request.
      // Past that the transfer is bounded by the run's own deadline through
      // timeoutMs, and a cut past it is reported as in progress below, with
      // the partial file kept for the resume.
      if (stopAt - Date.now() < DOWNLOAD_MIN_MS) {
        return {
          cursor: cursorAt(kind, line),
          note: `${summary()}; out of time before the ${kind} download, resuming in 10 min`,
          nextInMinutes: RESUME_MINUTES,
        };
      }
      let dl = null;
      while (dl === null) {
        requests += 1;
        try {
          dl = await http.download(datedUrl(kind, version), path, {
            headers: { 'user-agent': USER_AGENT },
            // The whole transfer, but never past the run's own deadline.
            timeoutMs: Number.isFinite(stopAt)
              ? Math.max(DOWNLOAD_MIN_MS, stopAt - Date.now())
              : BUDGET_MS,
          });
          streak = 0;
        } catch (err) {
          if (Date.now() > stopAt) {
            // The budget ran out mid-transfer; the partial file is on disk.
            log(`${kind} download cut by the run deadline (${err?.message ?? err})`);
            return {
              cursor: cursorAt(kind, line),
              note: `${summary()}; ${kind} download in progress, resuming in 10 min`,
              nextInMinutes: RESUME_MINUTES,
            };
          }
          if (failed(`${kind} download`, err)) {
            allFailed();
            return {
              cursor: cursorAt(kind, line),
              note: `${summary()}; stopped after repeated failures on the ${kind} download, resuming in 10 min`,
              nextInMinutes: RESUME_MINUTES,
            };
          }
          await sleep(pause);
        }
      }
      if (!dl.complete) {
        log(`${kind} dump ${version}: ${dl.bytes} bytes so far`);
        return {
          cursor: cursorAt(kind, line),
          note: `${summary()}; ${kind} download in progress (${dl.bytes} bytes), resuming in 10 min`,
          nextInMinutes: RESUME_MINUTES,
        };
      }

      // Walk the lines from where the cursor says, a batch at a time.
      let batch = [];
      let n = line;
      let outOfTime = false;
      try {
        for await (const raw of gzipLines(path, { skip: line })) {
          n += 1;
          if (!raw) continue;
          const row = parseRow(raw);
          if (!row) {
            bad += 1;
            if (bad <= 5) log(`${kind} line ${n}: not a row`);
            continue;
          }
          rows += 1;
          if (maxLastModified === null || row.lastModified > maxLastModified) {
            maxLastModified = row.lastModified;
          }
          if (isStale(row.lastModified, watermark)) {
            stale += 1;
            continue;
          }
          const item = rowItem(row);
          if (!item) continue;
          batch.push(item);
          if (batch.length >= batchRows) {
            written += batch.length;
            batches += 1;
            yield { items: batch, cursor: cursorAt(kind, n) };
            batch = [];
            if (Date.now() > stopAt) {
              outOfTime = true;
              break;
            }
          }
        }
      } catch (err) {
        // A file gzip cannot read is not a file worth keeping: a resume would
        // hand the same bytes back forever. Drop it so the next run downloads
        // it again; the batches already written keep their cursor.
        await unlink(path).catch(() => {});
        throw new Error(
          `${kind} dump ${version} unreadable at line ${n}, removed (${err?.message ?? err})`,
        );
      }
      if (batch.length) {
        written += batch.length;
        batches += 1;
        yield { items: batch, cursor: cursorAt(kind, n) };
        batch = [];
      }
      if (outOfTime) {
        return {
          cursor: cursorAt(kind, n),
          note: `${summary()}; out of time at ${kind} line ${n}, resuming in 10 min`,
          nextInMinutes: RESUME_MINUTES,
        };
      }

      // The file is walked. Drop it (the disk is shared) and move the cursor to
      // the next file NOW, as an empty batch, so a crash before the next file's
      // first batch does not send the next run back into this one.
      log(`${kind} dump ${version} walked: ${n} lines`);
      await unlink(path).catch(() => {});
      line = 0;
      file = FILES[fi + 1] ?? null;
      if (file) yield { items: [], cursor: cursorAt(file, 0) };
    }

    return {
      cursor: {
        version,
        file: null,
        line: 0,
        lastModifiedWatermark: maxLastModified ?? watermark,
        maxLastModified: null,
        done: true,
        completedAt: new Date().toISOString(),
      },
      note:
        `complete: dump ${version}, ${rows} rows read this run, ${written} written in ${batches} batches` +
        (stale ? `, ${stale} unchanged skipped` : '') +
        (bad ? `, ${bad} unreadable` : '') +
        (failures ? `, ${failures} requests failed` : ''),
    };
  },
});
