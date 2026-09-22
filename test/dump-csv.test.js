import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * CSV records out of a bzip2 stream: the reader CourtListener's bulk data
 * needs. The record reader is exercised over in-memory chunks, split at
 * every byte position so that nothing depends on where a decoder happens to
 * cut its blocks; the bzip2 side is exercised on files the system `bzip2`
 * writes (skipped where there is none) including one cut short and one
 * corrupted, which the reader must tell apart.
 */
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';

const { bzip2Chunks, bzip2CsvRows, bzip2EndsCleanly, csvRecords } = await import(
  '../packages/core/src/dump.js'
);

/** The text as byte chunks of `size`, so a boundary can fall anywhere. */
async function* chunksOf(text, size) {
  const buf = Buffer.from(text, 'utf8');
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, Math.min(buf.length, i + size));
}

async function parse(text, { size = 1 << 20, ...opts } = {}) {
  const out = [];
  for await (const r of csvRecords(chunksOf(text, size), opts)) out.push(r);
  return out;
}

describe('csvRecords', () => {
  test('reads RFC 4180 as Postgres COPY writes it: null, empty, quotes, newlines, CRLF', async () => {
    const text =
      'id,name,note\r\n1,"Smith, J.","two\nlines"\r\n2,,""\r\n3,"say ""hi""",x\r\n4,plain,end';
    expect(await parse(text)).toEqual([
      ['id', 'name', 'note'],
      ['1', 'Smith, J.', 'two\nlines'],
      ['2', null, ''],
      ['3', 'say "hi"', 'x'],
      ['4', 'plain', 'end'],
    ]);
  });

  test('a blank line is nothing and a trailing newline adds no record', async () => {
    expect(await parse('a,b\n\n1,2\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(await parse('')).toEqual([]);
  });

  test('backslash escape, as CourtListener writes it', async () => {
    const text =
      'id,html\n' +
      '"1","<p id=\\"x\\">a\\\\b</p>"\n' +
      '"2","a\\nb"\n' + // a backslash before anything else is a backslash
      '"3","closed""reopened"\n'; // "" inside a field: quotes close and reopen
    expect(await parse(text, { escape: '\\' })).toEqual([
      ['id', 'html'],
      ['1', '<p id="x">a\\b</p>'],
      ['2', 'a\\nb'],
      ['3', 'closedreopened'],
    ]);
  });

  test('the records do not depend on where the chunks are cut', async () => {
    const rfc =
      'id,text,n\n1,"caf\u00e9 \u{1F3DB}\ufe0f ""quoted"" and, comma\nsecond line",\n2,,""\r\n3,"\u00e9\u00e9\u00e9",9';
    const esc = 'id,text\n"1","<a href=\\"\u00e9\\">\\\\</a>"\r\n"2",""\n"3","a""b"\n4,';
    const whole = await parse(rfc);
    const wholeEsc = await parse(esc, { escape: '\\' });
    expect(whole).toHaveLength(4);
    expect(wholeEsc).toHaveLength(5);
    for (let size = 1; size <= 12; size++) {
      expect(await parse(rfc, { size })).toEqual(whole);
      expect(await parse(esc, { size, escape: '\\' })).toEqual(wholeEsc);
    }
  });

  test('skip counts records from the top; keepHeader hands the first one over anyway', async () => {
    const text = 'a,b\n1,x\n2,y\n3,z\n';
    expect(await parse(text, { skip: 2 })).toEqual([
      ['2', 'y'],
      ['3', 'z'],
    ]);
    expect(await parse(text, { skip: 3, keepHeader: true })).toEqual([
      ['a', 'b'],
      ['3', 'z'],
    ]);
    // Skipped records still carry the quote state across their lines.
    const quoted = 'a\n"multi\nline"\n"x,y"\nz\n';
    expect(await parse(quoted, { skip: 2 })).toEqual([['x,y'], ['z']]);
    expect(await parse(quoted, { skip: 2, size: 1 })).toEqual([['x,y'], ['z']]);
  });
});

const haveBzip2 = Bun.which('bzip2');
describe.skipIf(!haveBzip2)('bzip2Chunks and bzip2CsvRows', () => {
  let dir;
  let whole;
  let cut;
  let corrupt;
  const ROWS = 6000;
  const csv = `${['id', 'name', 'note', 'flag'].map((h) => h).join(',')}\n${Array.from(
    { length: ROWS },
    (_, i) =>
      `"${i + 1}","Person \\"${i}\\"","line one\nline two ${'x'.repeat(i % 23)}",${i % 2 ? '"t"' : ''}`,
  ).join('\n')}\n`;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nichedb-bz2-test-'));
    const plain = join(dir, 'rows.csv');
    await writeFile(plain, csv);
    // -1: 100k blocks, so a 300 KB file is several and a cut lands between rows.
    const proc = Bun.spawn(['bzip2', '-1', '-k', '-f', plain], { stderr: 'pipe' });
    expect(await proc.exited).toBe(0);
    whole = `${plain}.bz2`;
    const bytes = await readFile(whole);
    cut = join(dir, 'cut.csv.bz2');
    await writeFile(cut, bytes.subarray(0, Math.floor(bytes.length / 2)));
    corrupt = join(dir, 'corrupt.csv.bz2');
    const bad = Buffer.from(bytes);
    for (let i = 0; i < 8; i++) bad[Math.floor(bad.length / 3) + i] ^= 0xff;
    await writeFile(corrupt, bad);
  });
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test('bzip2EndsCleanly sees the end mark of a whole stream and not of a cut one', async () => {
    expect(bzip2EndsCleanly(await readFile(whole))).toBe(true);
    expect(bzip2EndsCleanly((await readFile(whole)).subarray(-32))).toBe(true);
    expect(bzip2EndsCleanly(await readFile(cut))).toBe(false);
    expect(bzip2EndsCleanly(Buffer.alloc(0))).toBe(false);
  });

  test('decodes the whole file, chunk by chunk, to the bytes bzip2 read', async () => {
    const parts = [];
    for await (const c of bzip2Chunks(whole)) parts.push(c);
    expect(parts.length).toBeGreaterThan(1);
    expect(Buffer.concat(parts).toString('utf8')).toBe(csv);
  });

  test('yields rows keyed by the header, with the escape, and resumes by record', async () => {
    const rows = [];
    for await (const r of bzip2CsvRows(whole, { escape: '\\' })) rows.push(r);
    expect(rows).toHaveLength(ROWS);
    expect(rows[0]).toEqual({
      recordNo: 1,
      row: { id: '1', name: 'Person "0"', note: 'line one\nline two ', flag: null },
    });
    expect(rows[1].row.flag).toBe('t');
    expect(rows[ROWS - 1].recordNo).toBe(ROWS);

    const tail = [];
    for await (const r of bzip2CsvRows(whole, { escape: '\\', skip: ROWS - 3 })) tail.push(r);
    expect(tail.map((r) => r.recordNo)).toEqual([ROWS - 2, ROWS - 1, ROWS]);
    expect(tail[0].row).toEqual(rows[ROWS - 3].row);
  });

  test('a file cut short yields every whole record before the cut and stops', async () => {
    let truncated = null;
    const rows = [];
    for await (const r of bzip2CsvRows(cut, {
      escape: '\\',
      onTruncated: (err) => {
        truncated = err;
      },
    })) {
      rows.push(r);
    }
    expect(truncated).toBeInstanceOf(Error);
    expect(rows.length).toBeGreaterThan(100);
    expect(rows.length).toBeLessThan(ROWS);
    // Every row handed over is a whole one: the partial last record is held back.
    for (const r of rows) expect(Object.keys(r.row)).toEqual(['id', 'name', 'note', 'flag']);
    expect(rows.map((r) => r.recordNo)).toEqual(rows.map((_, i) => i + 1));
  });

  test('a corrupt file that still closes its stream is thrown, not treated as cut', async () => {
    let truncated = false;
    const read = async () => {
      for await (const _ of bzip2CsvRows(corrupt, {
        escape: '\\',
        onTruncated: () => {
          truncated = true;
        },
      })) {
        // drain
      }
    };
    await expect(read()).rejects.toThrow(/bzip2/);
    expect(truncated).toBe(false);
  });

  test('stopping early leaves nothing running', async () => {
    const it = bzip2CsvRows(whole, { escape: '\\' });
    expect((await it.next()).value.recordNo).toBe(1);
    await it.return();
  });
});
