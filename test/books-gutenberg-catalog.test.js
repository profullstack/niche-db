import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

import {
  bookItem,
  CATALOG_URL,
  CsvParser,
  catalogRow,
  coverUrl,
  csvRecords,
  formatUrls,
  gutenbergCatalog,
  headerKeys,
  isDatePart,
  parseAuthor,
  parseAuthors,
  parseCsv,
  resumeFrom,
  shelfSlug,
  USER_AGENT,
} from '../packages/adapters/src/gutenberg-catalog.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

const fixture = async (name) =>
  JSON.parse(
    await readFile(new URL(`../packages/adapters/test/fixtures/${name}`, import.meta.url), 'utf8'),
  );

/** The first 200 lines of the live feed, cut on a record boundary. */
const head = await fixture('gutenberg-catalog-head.json');
/** Raw records lifted from the live feed for the edges the parser has to survive. */
const edge = await fixture('gutenberg-catalog-rows.json');

/** Built at runtime so the character itself never appears in this file. */
const EM_DASH = String.fromCharCode(0x2014);

const HEADER = `${edge.header}\n`;
const KEYS = headerKeys(parseCsv(HEADER)[0]);

/** One raw record, as the item builder sees it. */
const rowOf = (name) => catalogRow(KEYS, parseCsv(edge.rows[name])[0]);

/**
 * A fake gutenberg.org. Serves `body` as the catalogue in chunks of `chunk`
 * bytes, so the parser sees quotes and multibyte characters split across
 * chunks the way a real download splits them; `fail` decides per request.
 */
function provider({
  body = head.body,
  chunk = 700,
  fail = () => false,
  breakAfter = () => null,
  lastModified = head.headers['last-modified'],
} = {}) {
  const urls = [];
  const requests = [];
  const http = {
    async request(url, opts) {
      urls.push(url);
      requests.push(opts);
      const n = urls.length;
      if (fail(n)) return new Response('nope', { status: 500 });
      if (opts?.headers?.['if-modified-since'] === lastModified)
        return new Response(null, { status: 304 });
      const bytes = new TextEncoder().encode(body);
      const cutAt = breakAfter(n);
      let at = 0;
      const stream = new ReadableStream({
        pull(controller) {
          if (cutAt !== null && at >= cutAt) {
            controller.error(new Error('connection reset'));
            return;
          }
          if (at >= bytes.length) {
            controller.close();
            return;
          }
          controller.enqueue(bytes.slice(at, at + chunk));
          at += chunk;
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/csv', 'last-modified': lastModified },
      });
    },
    async json(url) {
      throw new Error(`500 from ${url}`);
    },
  };
  return { http, urls, requests };
}

const run = (config = {}, cursor = {}, p = provider(), deadline = Number.POSITIVE_INFINITY) =>
  gutenbergCatalog.pull({
    config: { rowsPerRun: 0, pauseMs: 0, ...config },
    cursor,
    env: {},
    http: p.http,
    log: () => {},
    deadline,
  });

describe('the csv parser', () => {
  test('quoted commas, doubled quotes and newlines inside a field', () => {
    const text = 'a,b,c\n1,"x, y","say ""hi"""\r\n2,"two\nlines",plain\n';
    expect(parseCsv(text)).toEqual([
      ['a', 'b', 'c'],
      ['1', 'x, y', 'say "hi"'],
      ['2', 'two\nlines', 'plain'],
    ]);
  });

  test('a last line without a newline, empty fields and empty lines', () => {
    expect(parseCsv('a,,c\n\n,,\n"",x')).toEqual([
      ['a', '', 'c'],
      ['', '', ''],
      ['', 'x'],
    ]);
    expect(parseCsv('')).toEqual([]);
  });

  test('the same records whatever the chunk boundaries', async () => {
    const text = 'id,title\n63,"The Number ""e"""\n464,"In the South Seas\nAboard the ""Casco"""\n';
    const whole = parseCsv(text);
    for (const size of [1, 2, 3, 7, 1000]) {
      const chunks = [];
      for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
      const p = new CsvParser();
      const got = chunks.flatMap((c) => p.push(c)).concat(p.end());
      expect(got).toEqual(whole);
    }
    expect(whole[1][1]).toBe('The Number "e"');
  });

  test('utf-8 split across byte chunks comes out whole', async () => {
    const text = 'id,name\n21,"Aesop’s fables, Böök"\n';
    const bytes = new TextEncoder().encode(text);
    const chunks = [];
    for (let i = 0; i < bytes.length; i += 3) chunks.push(bytes.slice(i, i + 3));
    const out = [];
    for await (const r of csvRecords(chunks)) out.push(r);
    expect(out).toEqual([
      ['id', 'name'],
      ['21', 'Aesop’s fables, Böök'],
    ]);
  });

  test('the live head parses to one record a book, nine cells each', () => {
    const records = parseCsv(head.body);
    expect(records[0]).toEqual([
      'Text#',
      'Type',
      'Issued',
      'Title',
      'Language',
      'Authors',
      'Subjects',
      'LoCC',
      'Bookshelves',
    ]);
    expect(records.length).toBeGreaterThan(100);
    for (const r of records) expect(r).toHaveLength(9);
    // Row 2's title carries its subtitle on a second line, which is the whole
    // point of a real parser. The feed ends that line with CRLF, which the
    // parser keeps as the standard says and catalogRow folds to a newline.
    const bill = records.find((r) => r[0] === '2');
    expect(bill[3].split(/\r?\n/)).toEqual([
      'The United States Bill of Rights',
      'The Ten Original Amendments to the Constitution of the United States',
    ]);
    expect(catalogRow(KEYS, bill).title).not.toContain('\r');
    expect(records.find((r) => r[0] === '1')[5]).toBe('Jefferson, Thomas, 1743-1826');
  });

  test('the header must be the catalogue', () => {
    expect(headerKeys(['Text#', 'Type', 'Title'])).toEqual(['id', 'type', 'title']);
    expect(headerKeys(['\uFEFFText#', 'Type', 'Title'])).toEqual(['id', 'type', 'title']);
    expect(headerKeys(['id', 'name'])).toBeNull();
    expect(headerKeys('<html>')).toBeNull();
  });
});

describe('authors', () => {
  test('"Last, First, years [Role]" becomes a display name with the original kept', () => {
    expect(parseAuthor('Jefferson, Thomas, 1743-1826')).toEqual({
      name: 'Thomas Jefferson',
      original: 'Jefferson, Thomas, 1743-1826',
      role: null,
      years: '1743-1826',
    });
    expect(parseAuthor('Townsend, George Fyler, 1814-1900 [Translator]')).toMatchObject({
      name: 'George Fyler Townsend',
      role: 'Translator',
      years: '1814-1900',
    });
    expect(parseAuthor('Aesop, 621? BCE-565? BCE')).toMatchObject({
      name: 'Aesop',
      years: '621? BCE-565? BCE',
    });
    expect(parseAuthor('Raymond, Eric S., 1957- [Editor]')).toMatchObject({
      name: 'Eric S. Raymond',
      years: '1957-',
    });
    expect(parseAuthor('Orczy, Emmuska Orczy, Baroness, 1865-1947')).toMatchObject({
      name: 'Emmuska Orczy Orczy, Baroness',
      years: '1865-1947',
    });
    expect(parseAuthor('Krestovskii, Vs. Vl. (Vsevolod Vladimirovich), 1840-1895')).toMatchObject({
      name: 'Vs. Vl. (Vsevolod Vladimirovich) Krestovskii',
    });
    expect(parseAuthor('United States')).toMatchObject({ name: 'United States', years: null });
    expect(parseAuthor('Anonymous, active 17th century')).toMatchObject({
      name: 'Anonymous',
      years: 'active 17th century',
    });
    expect(parseAuthor('')).toBeNull();
  });

  test('a date part is a date part, a name is not', () => {
    for (const s of ['1809-1892', '1951-', '-1934', '621? BCE-565? BCE', 'active 1600-1650'])
      expect(isDatePart(s)).toBe(true);
    for (const s of ['Thomas', 'Baroness', 'Jr.', '', 'Route 66 Press'])
      expect(isDatePart(s)).toBe(false);
  });

  test('the list splits on the semicolon', () => {
    const list = parseAuthors(
      'Luther, Martin, 1483-1546; Allen, Nathan H. (Nathan Hale), 1848-1925 [Editor]',
    );
    expect(list.map((a) => a.name)).toEqual(['Martin Luther', 'Nathan H. (Nathan Hale) Allen']);
    expect(list[1].role).toBe('Editor');
    expect(parseAuthors('')).toEqual([]);
  });
});

describe('bookItem', () => {
  test('one Text row becomes one book item with the fields a reader wants', () => {
    const records = parseCsv(head.body);
    const row = catalogRow(
      KEYS,
      records.find((r) => r[0] === '1'),
    );
    const item = normaliseItem(bookItem(row));
    expect(item.externalId).toBe('gutenberg:1');
    expect(item.kind).toBe('book');
    expect(item.title).toBe('The Declaration of Independence of the United States of America');
    expect(item.summary).toBe('by Thomas Jefferson');
    expect(item.url).toBe('https://www.gutenberg.org/ebooks/1');
    expect(item.imageUrl).toBe('https://www.gutenberg.org/cache/epub/1/pg1.cover.medium.jpg');
    expect(item.publishedAt.toISOString()).toBe('1971-12-01T12:00:00.000Z');
    expect(item.timeKnown).toBe(false);
    expect(item.precision).toBe('day');
    expect(item.tags).toContain('book');
    expect(item.tags).toContain('gutenberg');
    expect(item.tags).toContain('lang:en');
    expect(item.tags).toContain('subject:united-states-history-revolution-1775-1783-sources');
    expect(item.tags).toContain('shelf:politics');
    expect(item.tags).toContain('shelf:essays-letters-speeches');
    expect(item.data.provider).toBe('gutenberg');
    expect(item.data.id).toBe('1');
    expect(item.data.title).toBe(item.title);
    expect(item.data.authors).toEqual(['Thomas Jefferson']);
    expect(item.data.contributors[0].original).toBe('Jefferson, Thomas, 1743-1826');
    expect(item.data.subjects).toEqual([
      'United States -- History -- Revolution, 1775-1783 -- Sources',
      'United States. Declaration of Independence',
    ]);
    expect(item.data.locc).toEqual(['E201', 'JK']);
    expect(item.data.bookshelves).toContain('American Revolutionary War');
    expect(item.data.language).toBe('en');
    expect(item.data.issued).toBe('1971-12-01');
    expect(item.data.formats).toEqual({
      epub: 'https://www.gutenberg.org/ebooks/1.epub3.images',
      kindle: 'https://www.gutenberg.org/ebooks/1.kf8.images',
      txt: 'https://www.gutenberg.org/ebooks/1.txt.utf-8',
      html: 'https://www.gutenberg.org/ebooks/1.html.images',
    });
    expect(item.data.attribution).toBe('Project Gutenberg');
    expect(JSON.stringify(item)).not.toContain(EM_DASH);
  });

  test('a subtitle on a second line is not part of the title', () => {
    const item = bookItem(rowOf('newlineAndQuotes'));
    expect(item.title).toBe('In the South Seas');
    expect(item.data.subtitle).toContain('the Yacht "Casco" (1888)');
    expect(item.summary).toBe(`${item.data.subtitle} · by Robert Louis Stevenson`);
    expect(item.data.fullTitle).toContain('\n');
  });

  test('a recording is not a book, a row with no author still is', () => {
    expect(bookItem(rowOf('sound'))).toBeNull();
    const compact = bookItem(rowOf('noAuthor'));
    expect(compact.externalId).toBe('gutenberg:7');
    expect(compact.data.authors).toEqual([]);
    expect(compact.summary).toBeNull();
    expect(bookItem(null)).toBeNull();
    expect(bookItem({ id: 'x', type: 'Text', title: 'T' })).toBeNull();
    expect(bookItem({ id: '9', type: 'Text', title: '' })).toBeNull();
  });

  test('two languages are two tags, a translator is a contributor and not an author', () => {
    const item = bookItem(rowOf('multiLanguage'));
    expect(item.tags).toContain('lang:de');
    expect(item.tags).toContain('lang:en');
    expect(item.data.languages).toEqual(['de', 'en']);
    expect(item.data.language).toBe('de');
    expect(item.data.authors).toEqual(['Martin Luther']);
    expect(item.data.contributors.map((c) => c.role)).toEqual([null, 'Editor', 'Editor']);
    const aesop = bookItem(rowOf('bce'));
    expect(aesop.data.authors).toEqual(['Aesop']);
    expect(aesop.data.contributors[1]).toMatchObject({
      name: 'George Fyler Townsend',
      role: 'Translator',
    });
  });

  test('doubled quotes come through as one, and the urls are built from the id', () => {
    expect(bookItem(rowOf('quotedQuote')).title).toBe('The Number "e"');
    expect(coverUrl(1342)).toBe(
      'https://www.gutenberg.org/cache/epub/1342/pg1342.cover.medium.jpg',
    );
    expect(formatUrls('1342').txt).toBe('https://www.gutenberg.org/ebooks/1342.txt.utf-8');
    expect(shelfSlug('Category: History - American')).toBe('history-american');
    expect(shelfSlug('Best Books Ever Listings')).toBe('best-books-ever-listings');
  });

  test('every row of the live head is a book or a known non-book, and tags stay under the cap', () => {
    const records = parseCsv(head.body).slice(1);
    const items = records.map((r) => bookItem(catalogRow(KEYS, r))).filter(Boolean);
    expect(items.length).toBeGreaterThan(records.length - 10);
    for (const item of items) {
      const n = normaliseItem(item);
      expect(n).not.toBeNull();
      expect(n.tags.length).toBeLessThanOrEqual(40);
      expect(n.tags.every((t) => !t.endsWith(':'))).toBe(true);
    }
  });
});

describe('the walk', () => {
  test('one request reads the whole catalogue and the pass is done', async () => {
    const p = provider();
    const out = await run({}, {}, p);
    const records = parseCsv(head.body).length - 1;
    expect(out.items.length).toBeGreaterThan(100);
    expect(out.items[0].externalId).toBe('gutenberg:1');
    expect(out.cursor.offset).toBeNull();
    expect(out.cursor.rows).toBe(records);
    expect(out.cursor.books).toBe(out.items.length);
    expect(out.cursor.lastModified).toBe(head.headers['last-modified']);
    expect(out.cursor.walkedAt).toMatch(/^\d{4}-/);
    expect(out.nextInMinutes).toBeUndefined();
    expect(out.note).toContain('the catalogue is read');
    expect(p.urls).toEqual([CATALOG_URL]);
    expect(p.requests[0].headers['user-agent']).toBe(USER_AGENT);
    expect(p.requests[0].headers['if-modified-since']).toBeUndefined();
    expect(JSON.parse(JSON.stringify(out.cursor))).toEqual(out.cursor);
  });

  test('stops at the row cap and resumes from the cursor without repeating a row', async () => {
    const p = provider();
    const first = await run({ rowsPerRun: 5 }, {}, p);
    expect(first.items.map((i) => i.externalId)).toEqual([
      'gutenberg:1',
      'gutenberg:2',
      'gutenberg:3',
      'gutenberg:4',
      'gutenberg:5',
    ]);
    expect(first.cursor.offset).toBe(5);
    expect(first.cursor.walkedAt).toBeNull();
    expect(first.nextInMinutes).toBe(10);
    expect(first.note).toContain('stopped at the row cap at record 5');

    const second = await run({ rowsPerRun: 3 }, first.cursor, p);
    expect(second.items.map((i) => i.externalId)).toEqual([
      'gutenberg:6',
      'gutenberg:7',
      'gutenberg:8',
    ]);
    expect(second.cursor.offset).toBe(8);
    expect(second.cursor.books).toBe(8);
    // A resumed pass asks for the bytes, not whether they changed.
    expect(p.requests[1].headers['if-modified-since']).toBeUndefined();

    const rest = await run({ rowsPerRun: 0 }, second.cursor, p);
    expect(rest.items[0].externalId).toBe('gutenberg:9');
    expect(rest.cursor.offset).toBeNull();
    expect(rest.cursor.books).toBe(8 + rest.items.length);
    expect(rest.nextInMinutes).toBeUndefined();
    expect(p.urls).toHaveLength(3);
  });

  test('the run deadline stops the walk with the place kept', async () => {
    const p = provider();
    const out = await run({}, {}, p, Date.now() - 1);
    // The clock is read every 256 records; the head is shorter than that, so
    // a deadline already past shows up as the pass completing on a short file
    // and as a cut on a long one.
    const long = provider({
      body: head.body + head.body.split('\n').slice(1).join('\n').repeat(3),
    });
    const cut = await run({}, {}, long, Date.now() - 1);
    expect(out.cursor.offset).toBeNull();
    expect(cut.cursor.offset).toBe(256);
    // 256 records, less the recordings and datasets among them.
    expect(cut.items.length).toBeGreaterThan(230);
    expect(cut.items.length).toBeLessThanOrEqual(256);
    expect(cut.nextInMinutes).toBe(10);
    expect(cut.note).toContain('on the run deadline');
  });

  test('a finished pass asks If-Modified-Since and a 304 is a quiet week', async () => {
    const p = provider();
    const first = await run({}, {}, p);
    const again = await run({}, first.cursor, p);
    expect(p.requests[1].headers['if-modified-since']).toBe(head.headers['last-modified']);
    expect(again.items).toEqual([]);
    expect(again.cursor.walkedAt).toBe(first.cursor.walkedAt);
    expect(again.cursor.lastModified).toBe(first.cursor.lastModified);
    expect(again.nextInMinutes).toBeUndefined();
    expect(again.note).toContain('unchanged');

    const moved = provider({ lastModified: 'Sun, 20 Sep 2026 21:29:25 GMT' });
    const fresh = await run({}, first.cursor, moved);
    expect(fresh.items.length).toBeGreaterThan(100);
    expect(fresh.cursor.lastModified).toBe('Sun, 20 Sep 2026 21:29:25 GMT');
  });

  test('a feed that changed under a resumed walk starts the walk over', async () => {
    const p = provider();
    const first = await run({ rowsPerRun: 5 }, {}, p);
    const moved = provider({ lastModified: 'Sun, 20 Sep 2026 21:29:25 GMT' });
    const second = await run({ rowsPerRun: 5 }, first.cursor, moved);
    expect(second.items.map((i) => i.externalId)).toEqual([
      'gutenberg:1',
      'gutenberg:2',
      'gutenberg:3',
      'gutenberg:4',
      'gutenberg:5',
    ]);
    expect(second.cursor.offset).toBe(5);
    expect(second.cursor.books).toBe(5);
  });

  test('a failed download is retried, three in a row stop the run, and a dead feed throws', async () => {
    const flaky = provider({ fail: (n) => n === 1 });
    const out = await run({}, {}, flaky);
    expect(out.items.length).toBeGreaterThan(100);
    expect(flaky.urls).toHaveLength(2);
    expect(out.note).toContain('1 download failed');
    expect(out.cursor.offset).toBeNull();

    const dead = provider({ fail: () => true });
    await expect(run({}, {}, dead)).rejects.toThrow(/every request failed \(3 of 3\)/);
    expect(dead.urls).toHaveLength(3);

    // A download that breaks part way: the rows already out are kept, the
    // retries start from there, and three breaks in a row end the run with
    // the place kept rather than throwing the rows away.
    const broken = provider({ breakAfter: () => 3000 });
    const part = await run({}, {}, broken);
    expect(part.items.length).toBeGreaterThan(2);
    expect(part.items.length).toBeLessThan(20);
    expect(part.cursor.offset).toBe(part.items.length);
    expect(part.cursor.walkedAt).toBeNull();
    expect(part.nextInMinutes).toBe(10);
    expect(part.note).toContain('after repeated failures');
    expect(part.note).toContain('3 downloads failed');
    expect(broken.urls).toHaveLength(3);

    // And a later run that gets the whole file finishes the pass from there.
    const whole = provider();
    const rest = await run({}, part.cursor, whole);
    expect(rest.items[0].externalId).toBe(`gutenberg:${part.items.length + 1}`);
    expect(rest.cursor.offset).toBeNull();
    expect(rest.cursor.books).toBe(part.items.length + rest.items.length);
  });

  test('a retry never asks If-Modified-Since, so a changed feed that broke once is still read', async () => {
    // The weekly run: the feed moved (200, new stamp) but the connection died
    // after the header line. The retry must ask for the bytes; asking with the
    // new stamp would be answered 304 and the changed catalogue never read.
    const NEW = 'Sun, 20 Sep 2026 21:29:25 GMT';
    const asked = [];
    const http = {
      async request(_url, opts) {
        asked.push(opts.headers['if-modified-since'] ?? null);
        if (opts.headers['if-modified-since'] === NEW) return new Response(null, { status: 304 });
        if (asked.length === 1) {
          const bytes = new TextEncoder().encode(`${head.body.split('\n')[0]}\n`);
          let sent = false;
          const stream = new ReadableStream({
            pull(controller) {
              if (sent) controller.error(new Error('connection reset'));
              else {
                sent = true;
                controller.enqueue(bytes);
              }
            },
          });
          return new Response(stream, { status: 200, headers: { 'last-modified': NEW } });
        }
        return new Response(head.body, { status: 200, headers: { 'last-modified': NEW } });
      },
    };
    const first = await run({}, {}, provider());
    const out = await run({}, first.cursor, { http });
    expect(asked).toEqual([head.headers['last-modified'], null]);
    expect(out.items.length).toBeGreaterThan(100);
    expect(out.cursor.offset).toBeNull();
    expect(out.cursor.lastModified).toBe(NEW);
    expect(out.note).toContain('1 download failed');
  });

  test('a body that is not the catalogue is a failure, not a pass of nothing', async () => {
    const p = provider({ body: '<html>maintenance</html>' });
    await expect(run({}, {}, p)).rejects.toThrow(/every request failed/);
  });

  test('resume defaults', () => {
    expect(resumeFrom({})).toMatchObject({ offset: 0, lastModified: null, walkedAt: null });
    expect(resumeFrom({ offset: 'x' })).toMatchObject({ offset: 0 });
    expect(resumeFrom({ offset: 12, lastModified: 'Sun, 06 Sep 2026 21:29:25 GMT' })).toMatchObject(
      {
        offset: 12,
        lastModified: 'Sun, 06 Sep 2026 21:29:25 GMT',
      },
    );
  });

  test('the adapter is described honestly', () => {
    expect(gutenbergCatalog.collection).toBe('books');
    expect(gutenbergCatalog.kinds).toEqual(['book']);
    expect(gutenbergCatalog.cadenceMinutes).toBe(10_080);
    expect(gutenbergCatalog.defaultSources[0].slug).toBe('gutenberg-catalog');
    expect(gutenbergCatalog.description).toContain('public domain');
    expect(gutenbergCatalog.description).not.toContain(EM_DASH);
  });
});
