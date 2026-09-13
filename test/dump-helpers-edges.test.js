import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';

const { makeHttp } = await import('../packages/core/src/http.js');
const { gzipLines, tsvJsonLines, xzLines, sqliteRows, lineOffsetReader } = await import(
  '../packages/core/src/dump.js'
);

const http = () => makeHttp({ userAgent: 'review/1' });
const collect = async (it) => {
  const out = [];
  for await (const x of it) out.push(x);
  return out;
};

let dir;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nichedb-review-'));
});
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

const fdCount = async () => (await readdir('/proc/self/fd')).length;

describe('gzipLines', () => {
  test('a 1 MB line with no trailing newline arrives whole', async () => {
    const big = 'é'.repeat(600_000); // 1.2 MB of UTF-8
    const path = join(dir, 'big.gz');
    await writeFile(path, gzipSync(`first\n${big}`));
    const got = await collect(gzipLines(path));
    expect(got.length).toBe(2);
    expect(got[0]).toBe('first');
    expect(got[1].length).toBe(600_000);
    expect(got[1]).toBe(big);
    expect(await collect(gzipLines(path, { skip: 1 }))).toEqual([big]);
    expect(await collect(gzipLines(path, { skip: 2 }))).toEqual([]);
  });

  test('a corrupt gzip file rejects rather than yielding nothing', async () => {
    const path = join(dir, 'bad.gz');
    await writeFile(path, Buffer.from('this is not gzip at all, not even close'));
    await expect(collect(gzipLines(path))).rejects.toThrow();
  });

  test('a missing file rejects', async () => {
    await expect(collect(gzipLines(join(dir, 'nope.gz')))).rejects.toThrow();
  });

  test('returning early from many readers does not leak file descriptors', async () => {
    const path = join(dir, 'many.gz');
    await writeFile(path, gzipSync(Array.from({ length: 20000 }, (_, i) => `l${i}`).join('\n')));
    const before = await fdCount();
    for (let i = 0; i < 100; i += 1) {
      const it = gzipLines(path);
      expect((await it.next()).value).toBe('l0');
      await it.return();
    }
    await Bun.sleep(50);
    const after = await fdCount();
    expect(after - before).toBeLessThan(10);
  });
});

describe('tsvJsonLines', () => {
  test('escaped tabs and quotes inside the JSON column survive; short lines are skipped', async () => {
    const json = JSON.stringify({
      title: 'A "quoted"\ttitle',
      key: '/works/OL1W',
      notes: { value: 'line\nbreak\\slash' },
    });
    const rows = [
      `/type/work\t/works/OL1W\t3\t2020-01-01T00:00:00.000000\t${json}`,
      '',
      'junk\tline',
      `/type/author\t/authors/OL1A\t1\t2019-01-01\t{"name":"x"}`,
    ];
    const path = join(dir, 'ol.txt');
    await writeFile(path, `${rows.join('\n')}\n`);
    const got = await collect(tsvJsonLines(path));
    expect(got.length).toBe(2);
    expect(got[0].json.title).toBe('A "quoted"\ttitle');
    expect(got[0].json.notes.value).toBe('line\nbreak\\slash');
    expect(got[0].lineNo).toBe(1);
    expect(got[1].lineNo).toBe(4);
    expect(got[1].type).toBe('/type/author');
    // resume from lineNo of the first record yields only the fourth
    expect((await collect(tsvJsonLines(path, { skip: 1 }))).map((r) => r.lineNo)).toEqual([4]);
    // gz path identical
    const gz = join(dir, 'ol.txt.gz');
    await writeFile(gz, gzipSync(`${rows.join('\n')}\n`));
    expect((await collect(tsvJsonLines(gz))).map((r) => r.lineNo)).toEqual([1, 4]);
  });

  test('bad JSON names the line', async () => {
    const path = join(dir, 'olbad.txt');
    await writeFile(path, `/type/work\t/w\t1\t2020\t{"ok":1}\n/type/work\t/w2\t1\t2020\t{nope\n`);
    await expect(collect(tsvJsonLines(path))).rejects.toThrow(/line 2/);
  });
});

const haveXz = Bun.which('xz') && Bun.which('tar');
describe.skipIf(!haveXz)('review: xzLines', () => {
  test('a corrupt xz rejects instead of ending as an empty file', async () => {
    const path = join(dir, 'corrupt.xz');
    await writeFile(path, Buffer.from('definitely not xz'));
    await expect(collect(xzLines(path))).rejects.toThrow(/xz exited/);
  });

  test('a truncated xz stream yields what it can then rejects', async () => {
    const text = Array.from({ length: 5000 }, (_, i) => `row ${i} ${'y'.repeat(50)}`).join('\n');
    const xz = Bun.spawn(['xz', '-zc'], { stdin: new Response(text).body, stdout: 'pipe' });
    const whole = Buffer.from(await new Response(xz.stdout).arrayBuffer());
    const path = join(dir, 'trunc.xz');
    await writeFile(path, whole.subarray(0, Math.floor(whole.length / 2)));
    let n = 0;
    let err = null;
    try {
      for await (const _ of xzLines(path)) n += 1;
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeNull();
    expect(String(err.message)).toMatch(/xz exited/);
    expect(n).toBeLessThan(5000);
  });

  test('no orphan process after an early return', async () => {
    const text = Array.from({ length: 200000 }, (_, i) => `row ${i}`).join('\n');
    const xz = Bun.spawn(['xz', '-zc'], { stdin: new Response(text).body, stdout: 'pipe' });
    const path = join(dir, 'long.xz');
    await writeFile(path, Buffer.from(await new Response(xz.stdout).arrayBuffer()));
    const before = await fdCount();
    for (let i = 0; i < 20; i += 1) {
      const it = xzLines(path);
      await it.next();
      await it.return();
    }
    await Bun.sleep(100);
    expect((await fdCount()) - before).toBeLessThan(10);
  });
});

describe('sqliteRows', () => {
  test('iterates rows lazily with params', async () => {
    const { Database } = await import('bun:sqlite');
    const path = join(dir, 'p.db');
    const db = new Database(path);
    db.exec('create table podcasts (id integer primary key, title text)');
    for (let i = 1; i <= 10; i += 1) db.query('insert into podcasts values (?, ?)').run(i, `p${i}`);
    db.close();
    const rows = [...sqliteRows(path, 'select * from podcasts where id > ? order by id', [7])];
    expect(rows.map((r) => r.id)).toEqual([8, 9, 10]);
  });
});

describe('lineOffsetReader', () => {
  test('offset after a CRLF line and a multibyte line lands on the next line', async () => {
    const path = join(dir, 'crlf.txt');
    await writeFile(path, 'ab\r\nçd\r\nlast');
    const got = await collect(lineOffsetReader(path));
    expect(got.map((r) => r.line)).toEqual(['ab', 'çd', 'last']);
    const resumed = await collect(lineOffsetReader(path, { offset: got[0].offset }));
    expect(resumed.map((r) => r.line)).toEqual(['çd', 'last']);
    expect(resumed[1].offset).toBe(Buffer.byteLength('ab\r\nçd\r\nlast'));
  });
});

/* ------------------------------------------------------------ download -- */

const BODY = Buffer.alloc(300_000);
for (let i = 0; i < BODY.length; i += 1) BODY[i] = i % 251;

let server;
let base;
const hits = [];
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const range = req.headers.get('range');
      hits.push({ path: url.pathname, range });
      const total = BODY.length;
      if (url.pathname === '/small') {
        // pretends to be smaller than our partial file
        if (range) {
          return new Response(null, { status: 416, headers: { 'content-range': 'bytes */1000' } });
        }
        return new Response(BODY.subarray(0, 1000), { headers: { 'content-length': '1000' } });
      }
      if (url.pathname === '/nolen') {
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(BODY.subarray(0, 100_000));
              c.close();
            },
          }),
        );
      }
      if (url.pathname === '/huge') {
        const size = 200 * 1024 * 1024;
        const chunk = new Uint8Array(1024 * 1024);
        let sent = 0;
        return new Response(
          new ReadableStream({
            pull(c) {
              if (sent >= size) return c.close();
              c.enqueue(chunk);
              sent += chunk.length;
            },
          }),
          { headers: { 'content-length': String(size) } },
        );
      }
      if (url.pathname === '/ignores') {
        return new Response(BODY, { headers: { 'content-length': String(total) } });
      }
      if (url.pathname === '/wrongstart') {
        // a broken server that honours a range but says a different start
        return new Response(BODY.subarray(10), {
          status: 206,
          headers: { 'content-range': `bytes 10-${total - 1}/${total}` },
        });
      }
      if (!range) {
        return new Response(BODY, { headers: { 'content-length': String(total) } });
      }
      const start = Number(range.match(/bytes=(\d+)-/)?.[1]);
      if (start >= total) {
        return new Response(null, {
          status: 416,
          headers: { 'content-range': `bytes */${total}` },
        });
      }
      return new Response(BODY.subarray(start), {
        status: 206,
        headers: { 'content-range': `bytes ${start}-${total - 1}/${total}` },
      });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

/** Raw TCP server that sends MORE than its Content-Length. */
let over;
let overBase;
beforeAll(() => {
  over = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data(socket) {
        const head = ['HTTP/1.1 200 OK', 'Content-Length: 1000', 'Connection: close', '', ''].join(
          '\r\n',
        );
        socket.write(head);
        socket.write(BODY.subarray(0, 5000));
        socket.flush();
        setTimeout(() => socket.end(), 30);
      },
    },
  });
  overBase = `http://127.0.0.1:${over.port}`;
});

afterAll(() => {
  server?.stop(true);
  over?.stop(true);
});

describe('http.download', () => {
  test('206 appends exactly the missing tail', async () => {
    const path = join(dir, 'a.bin');
    await writeFile(path, BODY.subarray(0, 123_456));
    hits.length = 0;
    const r = await http().download(`${base}/file`, path);
    expect(r).toEqual({ path, bytes: BODY.length, complete: true });
    expect(hits[0].range).toBe('bytes=123456-');
    expect(await readFile(path)).toEqual(BODY);
  });

  test('200 to a ranged request restarts the file, no duplicate prefix', async () => {
    const path = join(dir, 'b.bin');
    await writeFile(path, BODY.subarray(0, 123_456));
    const r = await http().download(`${base}/ignores`, path);
    expect(r.complete).toBe(true);
    expect((await stat(path)).size).toBe(BODY.length);
    expect(await readFile(path)).toEqual(BODY);
  });

  test('416 on a whole file is complete with no write', async () => {
    const path = join(dir, 'c.bin');
    await writeFile(path, BODY);
    const m1 = (await stat(path)).mtimeMs;
    await Bun.sleep(20);
    const r = await http().download(`${base}/file`, path);
    expect(r).toEqual({ path, bytes: BODY.length, complete: true });
    expect((await stat(path)).mtimeMs).toBe(m1);
  });

  test('416 where our file is longer than theirs unlinks and throws', async () => {
    const path = join(dir, 'd.bin');
    await writeFile(path, BODY.subarray(0, 2000));
    await expect(http().download(`${base}/small`, path)).rejects.toThrow(/server has 1000/);
    expect(await stat(path).catch(() => null)).toBeNull();
    // and the next call downloads the right file from scratch
    const r = await http().download(`${base}/small`, path);
    expect(r).toEqual({ path, bytes: 1000, complete: true });
  });

  test('a 206 whose Content-Range start is not what we asked for is refused', async () => {
    const path = join(dir, 'e.bin');
    await writeFile(path, BODY.subarray(0, 500));
    await expect(http().download(`${base}/wrongstart`, path)).rejects.toThrow(
      /asked for bytes=500-/,
    );
    expect((await stat(path)).size).toBe(500);
  });

  test('a body longer than Content-Length is cut at the declared length by fetch itself', async () => {
    const path = join(dir, 'f.bin');
    const r = await http().download(`${overBase}/x`, path);
    expect(r).toEqual({ path, bytes: 1000, complete: true });
    expect((await stat(path)).size).toBe(1000);
  });

  test('no Content-Length: whatever arrived counts as complete', async () => {
    const path = join(dir, 'g.bin');
    const r = await http().download(`${base}/nolen`, path);
    expect(r.complete).toBe(true);
    expect(r.bytes).toBe(100_000);
  });

  test('200 MB streams to disk with flat memory', async () => {
    const path = join(dir, 'huge.bin');
    Bun.gc(true);
    const before = process.memoryUsage().rss;
    let peak = before;
    const r = await http().download(`${base}/huge`, path, {
      onProgress: ({ bytes }) => {
        if (bytes % (32 * 1024 * 1024) === 0) peak = Math.max(peak, process.memoryUsage().rss);
      },
    });
    Bun.gc(true);
    const after = process.memoryUsage().rss;
    expect(r).toEqual({ path, bytes: 200 * 1024 * 1024, complete: true });
    expect((await stat(path)).size).toBe(200 * 1024 * 1024);
    console.log(
      `rss before ${(before / 1e6).toFixed(0)} MB, peak ${(peak / 1e6).toFixed(0)} MB, after ${(after / 1e6).toFixed(0)} MB`,
    );
    expect(peak - before).toBeLessThan(120 * 1024 * 1024);
    await rm(path);
  }, 120_000);
});
