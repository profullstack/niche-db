import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

/**
 * The pieces a dump adapter is built from: a download that resumes, and line
 * readers that never hold the file. The server here is a local Bun.serve that
 * speaks Range the way archive.org, MusicBrainz and Podcast Index do, plus one
 * route that ignores it the way Discogs does.
 */
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';

const { makeHttp } = await import('../packages/core/src/http.js');
const { dumpDir, gzipLines, lineOffsetReader, splitLines, tsvJsonLines, xzLines, untar } =
  await import('../packages/core/src/dump.js');

let dir;
let server;
let base;
const seenUA = [];
const BODY = Buffer.from(
  Array.from({ length: 4000 }, (_, i) => `line ${i} ${'x'.repeat(i % 37)}`).join('\n'),
);

/** How many bytes each request served, so a resume can be shown to be one. */
const served = [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nichedb-dump-test-'));
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      seenUA.push(req.headers.get('user-agent'));
      const range = req.headers.get('range');

      if (url.pathname === '/redirect') return Response.redirect(`${base}/file`, 302);
      if (url.pathname === '/noranges') {
        // Discogs: a 200 with the whole body whatever was asked for.
        served.push(BODY.length);
        return new Response(BODY, { headers: { 'content-length': String(BODY.length) } });
      }
      if (url.pathname !== '/file') return new Response('no', { status: 404 });

      const total = BODY.length;
      if (!range) {
        served.push(total);
        return new Response(BODY, {
          headers: { 'content-length': String(total), 'accept-ranges': 'bytes' },
        });
      }
      const start = Number(range.match(/bytes=(\d+)-/)?.[1]);
      if (start >= total) {
        served.push(0);
        return new Response(null, {
          status: 416,
          headers: { 'content-range': `bytes */${total}` },
        });
      }
      const slice = BODY.subarray(start);
      served.push(slice.length);
      return new Response(slice, {
        status: 206,
        headers: {
          'content-length': String(slice.length),
          'content-range': `bytes ${start}-${total - 1}/${total}`,
        },
      });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

/**
 * A server that promises the rest of the file and hangs up after CUT bytes.
 * Raw TCP, because Bun.serve corrects a Content-Length that the body does not
 * live up to, and the point is a body that stops short of its header.
 */
const CUT = 40_000;
let cutter;
let cutBase;
beforeAll(() => {
  cutter = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data(socket, data) {
        const start = Number(String(data).match(/range: bytes=(\d+)-/i)?.[1] ?? 0);
        const total = BODY.length;
        const slice = BODY.subarray(start, Math.min(start + CUT, total));
        served.push(slice.length);
        const head = [
          `HTTP/1.1 ${start ? '206 Partial Content' : '200 OK'}`,
          `Content-Length: ${total - start}`,
          ...(start ? [`Content-Range: bytes ${start}-${total - 1}/${total}`] : []),
          'Connection: close',
          '',
          '',
        ].join('\r\n');
        socket.write(head);
        socket.write(slice);
        socket.flush();
        // A beat before hanging up, so the bytes are read before the close is;
        // a close in the same packet makes Bun's fetch drop the lot.
        setTimeout(() => socket.end(), 30);
      },
    },
  });
  cutBase = `http://127.0.0.1:${cutter.port}`;
});

afterAll(async () => {
  server?.stop(true);
  cutter?.stop(true);
  if (dir) await rm(dir, { recursive: true, force: true });
});

const http = () => makeHttp({ userAgent: 'niche-db-test/1 (+https://nichedb.test)' });

describe('http.download', () => {
  test('streams a whole file to disk with the caller user agent', async () => {
    const path = join(dir, 'whole.bin');
    served.length = 0;
    const progress = [];
    const r = await http().download(`${base}/file`, path, {
      onProgress: (p) => progress.push(p),
    });
    expect(r).toEqual({ path, bytes: BODY.length, complete: true });
    expect(await readFile(path)).toEqual(BODY);
    expect(served).toEqual([BODY.length]);
    expect(seenUA.at(-1)).toBe('niche-db-test/1 (+https://nichedb.test)');
    expect(progress.at(-1)).toEqual({ bytes: BODY.length, total: BODY.length });
  });

  test('resumes a partial file with Range and appends the 206', async () => {
    const path = join(dir, 'partial.bin');
    await writeFile(path, BODY.subarray(0, 1500));
    served.length = 0;
    const r = await http().download(`${base}/file`, path);
    expect(r).toEqual({ path, bytes: BODY.length, complete: true });
    expect(await readFile(path)).toEqual(BODY);
    // Only the missing tail crossed the wire.
    expect(served).toEqual([BODY.length - 1500]);
  });

  test('a file already whole is a 416 and no transfer', async () => {
    const path = join(dir, 'done.bin');
    await writeFile(path, BODY);
    served.length = 0;
    const r = await http().download(`${base}/file`, path);
    expect(r).toEqual({ path, bytes: BODY.length, complete: true });
    expect(served).toEqual([0]);
  });

  test('a server that ignores Range restarts the file rather than appending', async () => {
    const path = join(dir, 'noranges.bin');
    await writeFile(path, BODY.subarray(0, 1500));
    const r = await http().download(`${base}/noranges`, path);
    expect(r.complete).toBe(true);
    expect((await stat(path)).size).toBe(BODY.length);
    expect(await readFile(path)).toEqual(BODY);
  });

  test('a connection that drops mid-body leaves a partial file the next call resumes', async () => {
    const path = join(dir, 'cut.bin');
    served.length = 0;
    // Each attempt either throws (the socket closed under the body) or reports
    // `complete: false`; either way the bytes that arrived are on disk and the
    // next call asks for the rest: three calls for this file.
    const attempt = () =>
      http()
        .download(`${cutBase}/file`, path)
        .catch(() => null);
    let r = null;
    for (let i = 0; i < 20 && !r?.complete; i += 1) {
      r = await attempt();
      if (r) expect(r.complete).toBe((await stat(path)).size === BODY.length);
    }
    expect(r).toEqual({ path, bytes: BODY.length, complete: true });
    expect(await readFile(path)).toEqual(BODY);
    expect(served).toEqual([CUT, CUT, BODY.length - 2 * CUT]);
  });

  test('follows redirects, as Open Library needs, and lands the right bytes', async () => {
    const path = join(dir, 'redirected.bin');
    const r = await http().download(`${base}/redirect`, path);
    expect(r.complete).toBe(true);
    expect(await readFile(path)).toEqual(BODY);
  });

  test('a 404 is an error and writes nothing', async () => {
    const path = join(dir, 'missing.bin');
    await expect(http().download(`${base}/nope`, path)).rejects.toThrow(/404/);
    expect(await stat(path).catch(() => null)).toBeNull();
  });
});

describe('dumpDir', () => {
  test('is created under the data dir and refuses a path that is not a slug', async () => {
    const d = await dumpDir('musicbrainz');
    expect((await stat(d)).isDirectory()).toBe(true);
    expect(d.endsWith(join('nichedb-dumps', 'musicbrainz'))).toBe(true);
    await expect(dumpDir('../etc')).rejects.toThrow(/slug/);
  });
});

const collect = async (it) => {
  const out = [];
  for await (const x of it) out.push(x);
  return out;
};

describe('gzipLines', () => {
  const lines = Array.from({ length: 2500 }, (_, i) => JSON.stringify({ i, name: `né ${i}` }));

  test('yields every line and flushes a final line with no trailing newline', async () => {
    const path = join(dir, 'a.ndjson.gz');
    await writeFile(path, gzipSync(lines.join('\n')));
    const got = await collect(gzipLines(path));
    expect(got.length).toBe(2500);
    expect(got[0]).toBe(lines[0]);
    expect(got.at(-1)).toBe(lines.at(-1));
    expect(JSON.parse(got[1234]).name).toBe('né 1234');
  });

  test('a trailing newline does not add a phantom empty line, CRLF is stripped', async () => {
    const path = join(dir, 'b.gz');
    await writeFile(path, gzipSync(`one\r\ntwo\r\n`));
    expect(await collect(gzipLines(path))).toEqual(['one', 'two']);
  });

  test('skip counts lines from the top so a cursor of { skip } resumes exactly', async () => {
    const path = join(dir, 'a.ndjson.gz');
    const got = await collect(gzipLines(path, { skip: 2497 }));
    expect(got).toEqual(lines.slice(2497));
  });

  test('a line larger than one chunk arrives whole, multibyte and all', async () => {
    const big = `{"pad":"${'é'.repeat(200_000)}"}`;
    const path = join(dir, 'c.gz');
    await writeFile(path, gzipSync(`${big}\nshort`));
    const got = await collect(gzipLines(path));
    expect(got.length).toBe(2);
    expect(got[0]).toBe(big);
    expect(JSON.parse(got[0]).pad.length).toBe(200_000);
  });
});

describe('tsvJsonLines', () => {
  test('splits the five Open Library columns and parses the JSON', async () => {
    const rows = [
      `/type/author\t/authors/OL1A\t1\t2021-12-26T21:23:30.303089\t{"key":"/authors/OL1A","name":"A\\u00e9"}`,
      '',
      `/type/work\t/works/OL2W\t3\t2010-04-28T06:54:19.472104\t{"key":"/works/OL2W","title":"T\\twith tab"}`,
    ];
    const path = join(dir, 'ol.txt.gz');
    await writeFile(path, gzipSync(rows.join('\n')));
    const got = await collect(tsvJsonLines(path));
    expect(got).toEqual([
      {
        type: '/type/author',
        key: '/authors/OL1A',
        revision: 1,
        lastModified: '2021-12-26T21:23:30.303089',
        json: { key: '/authors/OL1A', name: 'Aé' },
        lineNo: 1,
      },
      {
        type: '/type/work',
        key: '/works/OL2W',
        revision: 3,
        lastModified: '2010-04-28T06:54:19.472104',
        json: { key: '/works/OL2W', title: 'T\twith tab' },
        lineNo: 3,
      },
    ]);
    // Resume from the record's own lineNo.
    expect((await collect(tsvJsonLines(path, { skip: 1 }))).map((r) => r.key)).toEqual([
      '/works/OL2W',
    ]);
  });
});

describe('lineOffsetReader', () => {
  test('offsets resume in O(1) and skip resumes by count', async () => {
    const path = join(dir, 'plain.txt');
    await writeFile(path, 'alpha\nbéta\ngamma\ndelta');
    const all = await collect(lineOffsetReader(path));
    expect(all.map((r) => r.line)).toEqual(['alpha', 'béta', 'gamma', 'delta']);
    expect(all.map((r) => r.lineNo)).toEqual([1, 2, 3, 4]);
    // 'alpha\n' is 6 bytes, 'béta\n' is 6 bytes (two-byte e-acute), 'gamma\n' 6, 'delta' 5.
    expect(all.map((r) => r.offset)).toEqual([6, 12, 18, 23]);
    const rest = await collect(lineOffsetReader(path, { offset: 12 }));
    expect(rest.map((r) => r.line)).toEqual(['gamma', 'delta']);
    expect(rest.map((r) => r.offset)).toEqual([18, 23]);
    const skipped = await collect(lineOffsetReader(path, { skip: 3 }));
    expect(skipped).toEqual([{ line: 'delta', lineNo: 4, offset: 23 }]);
  });
});

describe('splitLines', () => {
  test('reassembles a line split across chunks and flushes the last one', async () => {
    async function* chunks() {
      yield Buffer.from('ab');
      yield Buffer.from('c\nd');
      yield Buffer.from('e');
    }
    expect(await collect(splitLines(chunks()))).toEqual(['abc', 'de']);
  });
});

const haveXz = Bun.which('xz') && Bun.which('tar');
describe.skipIf(!haveXz)('xzLines', () => {
  test('streams one member out of a tar.xz through the system tar', async () => {
    const src = join(dir, 'mb');
    await Bun.write(join(src, 'TIMESTAMP'), '2026-09-12 01:28:38+00');
    await Bun.write(join(src, 'mbdump', 'instrument'), '{"id":1}\n{"id":2}\n{"id":3}');
    await Bun.write(join(src, 'JSON_DUMPS_SCHEMA_NUMBER'), '1');
    const archive = join(dir, 'instrument.tar.xz');
    const tar = Bun.spawn(
      [
        'tar',
        '-cJf',
        archive,
        '-C',
        src,
        'TIMESTAMP',
        'mbdump/instrument',
        'JSON_DUMPS_SCHEMA_NUMBER',
      ],
      { stderr: 'pipe' },
    );
    expect(await tar.exited).toBe(0);

    const got = await collect(xzLines(archive, { member: 'mbdump/instrument' }));
    expect(got).toEqual(['{"id":1}', '{"id":2}', '{"id":3}']);
    expect(await collect(xzLines(archive, { member: 'mbdump/instrument', skip: 2 }))).toEqual([
      '{"id":3}',
    ]);

    // Stopping early kills the process rather than leaving it to fill a pipe.
    const it = xzLines(archive, { member: 'mbdump/instrument' });
    expect((await it.next()).value).toBe('{"id":1}');
    await it.return();

    // A missing member is an error, not an empty file.
    await expect(collect(xzLines(archive, { member: 'mbdump/nope' }))).rejects.toThrow(
      /tar exited/,
    );

    // untar puts the member on disk for the byte-seek path.
    const out = join(dir, 'untarred');
    await untar(archive, out, { members: ['mbdump/instrument'] });
    expect((await stat(join(out, 'mbdump', 'instrument'))).size).toBe(26);
  });

  test('reads a plain .xz file too', async () => {
    const plain = join(dir, 'plain.txt.xz');
    const xz = Bun.spawn(['xz', '-zc'], { stdin: new Response('p\nq\n').body, stdout: 'pipe' });
    await Bun.write(plain, await new Response(xz.stdout).arrayBuffer());
    expect(await collect(xzLines(plain))).toEqual(['p', 'q']);
  });
});
