import { Database } from 'bun:sqlite';
import { createReadStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { config } from '@nichedb/config';

/**
 * Reading bulk dumps without holding them.
 *
 * A dump adapter downloads a file of gigabytes (`http.download`), then walks it
 * as lines, a batch at a time, and yields those batches to the core with a
 * cursor that says how far it got. Everything here is an async generator over
 * a byte stream: at any moment the memory held is one decompressor chunk, the
 * tail of the line being assembled and the line being handed over. The whole
 * inflated file never exists in memory and, for the compressed readers, never
 * on disk either.
 *
 * Resuming has a cost and it differs by reader, so each one says what it is.
 */

/**
 * The directory a dump lives in, created. Under `INGEST_DATA_DIR` when the
 * deployment sets one (a mounted volume), else the OS temp dir, which a
 * redeploy wipes: the adapter's cursor, not the directory, is the walk.
 */
export async function dumpDir(name) {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(String(name))) {
    throw new Error(`dump dir name ${name} must be a slug`);
  }
  const dir = join(config.ingest.dataDir || join(tmpdir(), 'nichedb-dumps'), name);
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Lines of a gzip file, streamed through node:zlib.
 *
 * Every line is yielded, empty ones included, and the final line is flushed
 * whether or not the file ends in a newline (MusicBrainz's does not), so
 * `skip + lines yielded` is always the file position: keep that in the cursor.
 *
 * Resume cost: `skip` re-inflates from the start of the file and counts
 * newlines without decoding, at roughly the inflater's speed (hundreds of MB/s
 * of inflated text on one core). Open Library's 20 GB works file is a few
 * tens of seconds per gigabyte to walk past, which an hourly run absorbs.
 *
 * @param {string} path
 * @param {{ skip?: number }} [opts]
 * @returns {AsyncGenerator<string>}
 */
export async function* gzipLines(path, opts = {}) {
  const rs = createReadStream(path);
  const gz = createGunzip();
  // pipeline, not pipe: a reader that stops early (every run that hits its
  // deadline mid-file) destroys the gunzip side, and pipeline takes the file
  // stream down with it. `pipe` leaves that stream, and its descriptor, open.
  // Errors on either side reach the consumer through gz's own 'error'.
  pipeline(rs, gz, () => {});
  try {
    yield* splitLines(gz, opts);
  } finally {
    rs.destroy();
    gz.destroy();
  }
}

/**
 * Lines of an xz file, or of one member of an xz-compressed tar.
 *
 * Bun.Archive cannot read xz and buffers a whole archive anyway, so this
 * spawns the system tools and streams their stdout: `tar --to-stdout` for a
 * member (tar handles the base-256 sizes of members past 8 GB, which
 * MusicBrainz's artist file is), `xz -dc` for a plain .xz. Chosen over
 * extracting the member to disk because the inflated member is ten times the
 * archive (17.5 GB for artist, 374 GB for release) and the disk is ephemeral
 * and shared with the web role; an adapter that wants byte-seek resume on a
 * member that fits can `untar` it once and read it with `lineOffsetReader`.
 * Needs `xz` on the host (xz-utils in the image).
 *
 * Resume cost: as `gzipLines`, but xz inflates at a fraction of gzip's speed
 * (100-200 MB/s), so skipping to the end of the artist member is two to three
 * minutes of one core. Fine for an hourly walk that moves hundreds of
 * thousands of lines a run; if it is not, extract once and seek.
 *
 * @param {string} path
 * @param {{ member?: string, skip?: number }} [opts]
 * @returns {AsyncGenerator<string>}
 */
export function xzLines(path, { member, skip = 0 } = {}) {
  const cmd = member
    ? ['tar', '--extract', '--xz', '--to-stdout', '--file', path, member]
    : ['xz', '-dc', path];
  return processLines(cmd, { skip });
}

/**
 * Open Library's dump rows: `type \t key \t revision \t last_modified \t JSON`.
 *
 * The JSON column is the fifth field and the rest of the line, split on the
 * first four tabs only. Each record carries its 1-based `lineNo` in the file
 * so the cursor can be `{ skip: lineNo }` even though a blank or malformed
 * line yields nothing. Reads .gz through `gzipLines`, anything else as plain
 * text, with the same resume cost as the reader underneath.
 *
 * @param {string} path
 * @param {{ skip?: number }} [opts]
 * @returns {AsyncGenerator<{ type: string, key: string, revision: number, lastModified: string, json: object, lineNo: number }>}
 */
export async function* tsvJsonLines(path, { skip = 0 } = {}) {
  const lines = path.endsWith('.gz') ? gzipLines(path, { skip }) : plainLines(path, { skip });
  let lineNo = skip;
  for await (const line of lines) {
    lineNo += 1;
    if (!line) continue;
    const cols = splitN(line, '\t', 5);
    if (cols.length < 5) continue;
    let json;
    try {
      json = JSON.parse(cols[4]);
    } catch (err) {
      throw new Error(`${path} line ${lineNo}: ${err.message}`);
    }
    yield {
      type: cols[0],
      key: cols[1],
      revision: Number(cols[2]),
      lastModified: cols[3],
      json,
      lineNo,
    };
  }
}

/**
 * Lines of a plain text file with the position to resume from.
 *
 * Yields `{ line, lineNo, offset }` where `offset` is the byte just after this
 * line's newline: store it and pass it back as `offset` to continue in O(1),
 * a seek. `skip` is the other way in, counting lines from `offset` at disk
 * speed without decoding, O(bytes skipped). `lineNo` counts from `offset`,
 * not from the top of the file, so a cursor is `{ offset }` or `{ skip }`,
 * not both.
 *
 * @param {string} path
 * @param {{ offset?: number, skip?: number }} [opts]
 * @returns {AsyncGenerator<{ line: string, lineNo: number, offset: number }>}
 */
export async function* lineOffsetReader(path, { offset = 0, skip = 0 } = {}) {
  let pos = offset;
  let lineNo = 0;
  let rest = null;
  for await (const chunk of createReadStream(path, { start: offset })) {
    let buf = rest ? Buffer.concat([rest, asBuffer(chunk)]) : asBuffer(chunk);
    rest = null;
    let start = 0;
    let idx = buf.indexOf(10, start);
    while (idx !== -1) {
      lineNo += 1;
      pos += idx + 1 - start;
      if (lineNo > skip) yield { line: lineText(buf, start, idx), lineNo, offset: pos };
      start = idx + 1;
      idx = buf.indexOf(10, start);
    }
    if (start < buf.length) rest = Buffer.from(buf.subarray(start));
    buf = null;
  }
  if (rest?.length) {
    lineNo += 1;
    pos += rest.length;
    if (lineNo > skip) yield { line: lineText(rest, 0, rest.length), lineNo, offset: pos };
  }
}

/**
 * Rows of a SQLite file, one at a time (Podcast Index ships one inside a
 * tgz). `bun:sqlite` walks the statement lazily, so a five-gigabyte table
 * costs one row of memory. Sync, because the driver is.
 */
export function* sqliteRows(dbPath, sqlText, params = []) {
  const db = new Database(dbPath, { readonly: true });
  try {
    yield* db.query(sqlText).iterate(...params);
  } finally {
    db.close();
  }
}

/**
 * Extract an archive (tar, tar.gz, tar.xz; tar sniffs the compression) into
 * `dir`, optionally only the named members. For the case where the inflated
 * file is what you need on disk: a SQLite database, or a member you would
 * rather seek through than re-inflate.
 */
export async function untar(path, dir, { members = [] } = {}) {
  await mkdir(dir, { recursive: true });
  const proc = Bun.spawn(['tar', '--extract', '--file', path, '--directory', dir, ...members], {
    stdout: 'ignore',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`tar exited ${code}${err ? `: ${err.trim().slice(0, 200)}` : ''}`);
  }
}

/**
 * Byte chunks in, lines out.
 *
 * The newline is one byte in UTF-8 and never inside a multibyte sequence, so
 * the split happens on bytes and each complete line is decoded whole; a
 * character straddling two chunks is reassembled before anyone reads it. The
 * remainder after the last newline is copied out of the chunk so the chunk
 * itself can be freed. A trailing CR is dropped. Lines under `skip` are
 * counted, not decoded.
 *
 * @param {AsyncIterable<Uint8Array>} chunks
 * @param {{ skip?: number }} [opts]
 * @returns {AsyncGenerator<string>}
 */
export async function* splitLines(chunks, { skip = 0 } = {}) {
  let rest = null;
  let seen = 0;
  for await (const chunk of chunks) {
    let buf = rest ? Buffer.concat([rest, asBuffer(chunk)]) : asBuffer(chunk);
    rest = null;
    let start = 0;
    let idx = buf.indexOf(10, start);
    while (idx !== -1) {
      seen += 1;
      if (seen > skip) yield lineText(buf, start, idx);
      start = idx + 1;
      idx = buf.indexOf(10, start);
    }
    if (start < buf.length) rest = Buffer.from(buf.subarray(start));
    buf = null;
  }
  if (rest?.length) {
    seen += 1;
    if (seen > skip) yield lineText(rest, 0, rest.length);
  }
}

/** Plain-text lines, the string-only counterpart of `lineOffsetReader`. */
function plainLines(path, opts) {
  return splitLines(createReadStream(path), opts);
}

/** Lines of a process's stdout; the process is killed if the reader stops early. */
async function* processLines(cmd, opts) {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  let finished = false;
  try {
    yield* splitLines(proc.stdout, opts);
    const code = await proc.exited;
    finished = true;
    if (code !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`${cmd[0]} exited ${code}${err ? `: ${err.trim().slice(0, 200)}` : ''}`);
    }
  } finally {
    if (!finished && proc.exitCode === null) proc.kill();
  }
}

const asBuffer = (c) =>
  Buffer.isBuffer(c) ? c : Buffer.from(c.buffer, c.byteOffset, c.byteLength);

function lineText(buf, start, end) {
  const stop = end > start && buf[end - 1] === 13 ? end - 1 : end;
  return buf.toString('utf8', start, stop);
}

/** `s.split(sep)` limited to `n` fields, the last one keeping the rest. */
function splitN(s, sep, n) {
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
