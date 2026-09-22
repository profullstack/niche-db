import { Database } from 'bun:sqlite';
import { createReadStream } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { config } from '@nichedb/config';
import unbzip2 from 'unbzip2-stream';

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

/** Decoded bytes `bzip2Chunks` holds back before it pauses the decoder. */
export const BZIP2_HIGH_WATER = 4 * 1024 * 1024;

/** The 48-bit end-of-stream mark every bzip2 stream closes with, sqrt(pi) in BCD. */
const BZIP2_EOS_BITS = (0x177245385090).toString(2).padStart(48, '0');

/**
 * Whether these bytes, the tail of a file, close a bzip2 stream.
 *
 * A stream is bit-packed, so the end mark can sit at any bit offset in the
 * last few bytes; it is followed by a 32-bit CRC and padding to the byte.
 * Hand this the last 32 bytes or more. A file cut short by a download has
 * no mark; a corrupt file that reached its end still has one, which is how
 * the reader tells the two apart without reading the decoder's mind.
 */
export function bzip2EndsCleanly(tail) {
  const buf = asBuffer(tail);
  let bits = '';
  for (const b of buf.subarray(Math.max(0, buf.length - 32)))
    bits += b.toString(2).padStart(8, '0');
  return bits.includes(BZIP2_EOS_BITS);
}

/** The last `n` bytes of a file, or fewer for a short one. */
async function tailBytes(path, n) {
  const fh = await open(path, 'r');
  try {
    const size = (await fh.stat()).size;
    const len = Math.min(n, size);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    return buf;
  } finally {
    await fh.close();
  }
}

/**
 * Decompressed chunks of a bzip2 file, through the pure JS decoder.
 *
 * The production image has tar, xz and gzip and no bzip2, and CourtListener
 * ships every bulk table as .csv.bz2, so this is unbzip2-stream (about 10 MB
 * of decompressed text a second on one core) rather than a spawned binary.
 * That package returns a classic `through` stream, which has no async
 * iterator, so this bridges it: chunks queue as the decoder emits them, the
 * decoder is paused when the queue holds `BZIP2_HIGH_WATER` bytes (pause is
 * honoured by `pipe`, so the file read stops too) and resumed as the
 * consumer drains it. Memory is one bzip2 block (900 KB inflated at -9) plus
 * that queue.
 *
 * A file that ends mid-stream, which a Range download cut short is, fails in
 * the decoder exactly as a corrupt one does, and for a small file both fail
 * after the input has ended, since the decoder buffers a block's worth
 * before it starts. So the two are told apart by the file itself: a whole
 * stream closes with an end mark (`bzip2EndsCleanly`) and a cut one does
 * not. The cut one ends the iteration cleanly, after every block decoded
 * before the cut, and calls `onTruncated(err)` so a caller that expected a
 * whole file can say so; the smoke test on a 3 MB slice of an 11 GB table
 * depends on it. A failure in a file that does close is corruption and is
 * thrown.
 *
 * @param {string} path
 * @param {{ onTruncated?: (err: Error) => void }} [opts]
 * @returns {AsyncGenerator<Buffer>}
 */
export async function* bzip2Chunks(path, { onTruncated } = {}) {
  const whole = bzip2EndsCleanly(await tailBytes(path, 64));
  const rs = createReadStream(path);
  const bz = unbzip2();
  const queue = [];
  let queued = 0;
  let ended = false;
  let failure = null;
  let wake = null;
  const notify = () => {
    if (wake) {
      const w = wake;
      wake = null;
      w();
    }
  };
  rs.on('error', (err) => {
    failure = failure ?? err;
    ended = true;
    notify();
  });
  bz.on('data', (chunk) => {
    const buf = asBuffer(chunk);
    queue.push(buf);
    queued += buf.length;
    if (queued >= BZIP2_HIGH_WATER) bz.pause();
    notify();
  });
  bz.on('end', () => {
    ended = true;
    notify();
  });
  bz.on('error', (err) => {
    if (whole) failure = failure ?? err;
    // Not whole: every block before the cut is out; what is missing is the tail.
    else onTruncated?.(err);
    ended = true;
    notify();
  });
  rs.pipe(bz);
  try {
    for (;;) {
      if (queue.length) {
        const buf = queue.shift();
        queued -= buf.length;
        if (queued < BZIP2_HIGH_WATER / 2 && bz.paused) bz.resume();
        yield buf;
        continue;
      }
      if (ended) break;
      await new Promise((r) => {
        wake = r;
      });
    }
    if (failure) throw new Error(`bzip2: ${failure.message}`);
  } finally {
    rs.destroy();
    bz.destroy();
  }
}

/**
 * CSV records out of byte chunks: RFC 4180 as Postgres COPY writes it.
 *
 * A record is an array of fields. Fields are separated by commas and records
 * by a newline, a quoted field may hold commas, newlines and `""` for a
 * quote, and a trailing CR before the LF is dropped. Two things a line
 * splitter cannot do are the reason this exists: a record may span lines
 * (opinion syllabi and court notes do), and COPY writes NULL as nothing at
 * all and the empty string as `""`, which are different facts about a court
 * (no end date, versus an end date somebody typed as blank). So an unquoted
 * empty field is `null` and a quoted one is `''`.
 *
 * The bytes are decoded as UTF-8 through a streaming decoder, so a character
 * split across two chunks is whole before the parser sees it. A blank line
 * yields nothing. The last record is flushed with or without a newline.
 *
 * `escape` is COPY's ESCAPE option. RFC 4180 writes a quote inside a quoted
 * field as `""` and that is the default; CourtListener's dumps are written
 * `WITH (FORMAT csv, ESCAPE '\')` (its own load script says so), where a
 * backslash before a quote or a backslash makes it literal and `""` inside
 * a field is quotes closing and reopening, as Postgres reads it. Reading a
 * backslash-escaped file as RFC splits a record at the first `\"` and every
 * record after it is noise, so the option is not optional for those files.
 *
 * `skip` counts records from the top, the header included, and the skipped
 * ones are scanned for quote state only, never assembled; the cost of a
 * resume is the decoder's, not this reader's. `keepHeader` yields the first
 * record whatever `skip` says, for a reader that needs the column names
 * before the rows it resumes at.
 *
 * @param {AsyncIterable<Uint8Array>} chunks
 * @param {{ skip?: number, keepHeader?: boolean, escape?: string|null }} [opts]
 * @returns {AsyncGenerator<Array<string|null>>}
 */
export async function* csvRecords(
  chunks,
  { skip = 0, keepHeader = false, escape: escapeChar = null } = {},
) {
  const decoder = new TextDecoder('utf-8');
  const esc = escapeChar ? String(escapeChar).charCodeAt(0) : -1;
  let seen = 0;
  let fields = [];
  let field = '';
  let quoted = false; // this field was opened with a quote
  let inQuotes = false; // the cursor is inside the quotes
  let started = false; // the record has any content yet (a blank line has none)
  const wanted = (index) => index >= skip || (keepHeader && index === 0);
  const keep = () => wanted(seen);

  const endField = () => {
    if (keep()) fields.push(quoted ? field : field === '' ? null : field);
    field = '';
    quoted = false;
  };
  const endRecord = function* () {
    endField();
    const index = seen;
    seen += 1;
    const out = fields;
    fields = [];
    started = false;
    if (wanted(index)) yield out;
  };

  /*
   * A quote inside quotes needs the next character to be read (is it `""`?)
   * and so does a CR (is it CRLF?). When that character is in the next
   * chunk, the one in hand is carried over rather than decided blind: the
   * escaped quote that straddles two of the decoder's blocks would
   * otherwise close the field and split the record at its next comma.
   */
  let carry = '';
  const feed = function* (chunk, final) {
    const text = carry ? carry + chunk : chunk;
    carry = '';
    let i = 0;
    const n = text.length;
    let nextEsc = -2; // not looked up yet in this chunk; -1 once there is none left
    while (i < n) {
      const c = text.charCodeAt(i);
      if (
        !final &&
        i === n - 1 &&
        ((inQuotes && (c === 34 || c === esc)) || (!inQuotes && c === 13))
      ) {
        carry = text[i];
        break;
      }
      if (inQuotes) {
        if (c === esc) {
          const next = text.charCodeAt(i + 1);
          if (next === 34 || next === esc) {
            if (keep()) field += text[i + 1];
            i += 2;
            continue;
          }
          if (keep()) field += text[i];
          i += 1;
          continue;
        }
        if (c === 34) {
          if (esc === -1 && text.charCodeAt(i + 1) === 34) {
            if (keep()) field += '"';
            i += 2;
            continue;
          }
          inQuotes = false;
          i += 1;
          continue;
        }
        // The run up to the next quote or escape, appended whole. The escape
        // position is found once per chunk, not once per field: a chunk with
        // no backslash in it would otherwise be scanned to its end for every
        // quoted field, which made a 10 MB file fifteen times slower.
        const at = text.indexOf('"', i);
        if (esc !== -1 && nextEsc !== -1 && nextEsc < i) nextEsc = text.indexOf(escapeChar, i);
        let stop = at === -1 ? n : at;
        if (esc !== -1 && nextEsc !== -1 && nextEsc < stop) stop = nextEsc;
        if (keep()) field += text.slice(i, stop);
        i = stop;
        continue;
      }
      if (c === 34) {
        // Quotes opening, or reopening after they closed inside the same
        // field, which is how Postgres reads a quote wherever it stands.
        quoted = true;
        inQuotes = true;
        started = true;
        i += 1;
        continue;
      }
      if (c === 44) {
        started = true;
        endField();
        i += 1;
        continue;
      }
      if (c === 10) {
        if (started) yield* endRecord();
        i += 1;
        continue;
      }
      if (c === 13 && text.charCodeAt(i + 1) === 10) {
        i += 1;
        continue;
      }
      started = true;
      if (keep()) field += text[i];
      i += 1;
    }
  };

  for await (const chunk of chunks) {
    yield* feed(decoder.decode(asBuffer(chunk), { stream: true }), false);
  }
  yield* feed(decoder.decode(), true);
  if (started || field !== '' || fields.length) yield* endRecord();
}

/**
 * Rows of a bzip2-compressed CSV with a header, as objects keyed by it.
 *
 * The header is read whatever `skip` says, then `skip` data rows are passed
 * over, then each row is yielded with its 1-based `recordNo` among the data
 * rows so the cursor can be `{ skip: recordNo }`. A row shorter than the
 * header leaves the missing keys undefined; a longer one keeps the extras
 * under their index. `onTruncated` is `bzip2Chunks`'s.
 *
 * Resume cost: as `gzipLines` in shape, at bzip2's speed, which is a tenth of
 * gzip's: a 2.5 GB table (11 GB inflated) is twenty minutes to walk past on
 * one core, so a run resuming near its end spends a third of its budget
 * getting there. Fine for a quarterly dump walked once.
 *
 * @param {string} path
 * @param {{ skip?: number, escape?: string|null, onTruncated?: (err: Error) => void }} [opts]
 * @returns {AsyncGenerator<{ row: Record<string, string|null>, recordNo: number }>}
 */
export async function* bzip2CsvRows(
  path,
  { skip = 0, escape: escapeChar = null, onTruncated } = {},
) {
  let header = null;
  let recordNo = Math.max(0, Math.floor(skip) || 0);
  let truncated = false;
  const records = csvRecords(
    bzip2Chunks(path, {
      onTruncated: (err) => {
        truncated = true;
        onTruncated?.(err);
      },
    }),
    { skip: recordNo + 1, keepHeader: true, escape: escapeChar },
  );
  // One row is held back: the last record of a cut file is a partial one
  // (its fields stop where the bytes did) and is known to be the last only
  // once the stream has ended, by which time the cut has been reported.
  let held = null;
  for await (const fields of records) {
    if (header === null) {
      header = fields.map((h) => String(h ?? '').trim());
      continue;
    }
    if (held) yield held;
    recordNo += 1;
    const row = {};
    for (let i = 0; i < fields.length; i++) row[header[i] ?? String(i)] = fields[i];
    held = { row, recordNo };
  }
  if (held && !truncated) yield held;
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
