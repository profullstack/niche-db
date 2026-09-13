import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

/**
 * Open Library's monthly dumps, walked as batches.
 *
 * The fixtures are 100 real rows of each dump, lifted from a Range GET of the
 * first 4 MB of `ol_dump_authors_latest` and `ol_dump_works_latest` on
 * 2026-09-13 (dump 2026-08-31), chosen so the parser meets what the files
 * carry: descriptions and bios as strings and as `{ value }`, publish dates
 * in every shape, `-1` covers, authors without a name, links, remote ids.
 * The network is a fake that writes those rows, gzipped, where the resume
 * helper would; the dump directory is a temp dir the tests own.
 */
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';

const { config } = await import('../packages/config/src/index.js');
const { normaliseItem } = await import('../packages/core/src/adapter.js');
const { toItem: searchItem } = await import('../packages/adapters/src/openlibrary.js');
const {
  ATTRIBUTION,
  authorItem,
  BUDGET_MS,
  CADENCE_MINUTES,
  coverUrl,
  datedUrl,
  FILES,
  isStale,
  latestUrl,
  localName,
  openlibraryCatalog,
  parseRow,
  publishDate,
  resolveVersion,
  resumeFrom,
  rowItem,
  splitN,
  staleFiles,
  textOf,
  trimTo,
  USER_AGENT,
  versionFromUrl,
  workItem,
} = await import('../packages/adapters/src/openlibrary-catalog.js');

const fixture = (name) =>
  readFile(new URL(`../packages/adapters/test/fixtures/${name}`, import.meta.url), 'utf8');

const bodies = {
  authors: await fixture('openlibrary-catalog-authors.tsv'),
  works: await fixture('openlibrary-catalog-works.tsv'),
};

/** Built at runtime so the character itself never appears in this file. */
const EM_DASH = String.fromCharCode(0x2014);

const VERSION = '2026-08-31';
const rowsOf = (kind) => bodies[kind].split('\n').filter(Boolean).map(parseRow);
const itemsOf = (kind) => rowsOf(kind).map(rowItem).filter(Boolean);
const rowByKey = (kind, key) => rowsOf(kind).find((r) => r.key === key);

/**
 * A fake openlibrary.org + archive.org. `request` answers the HEAD with the
 * mirror URL of the dated file; `download` writes the fixture, gzipped, to
 * the path the adapter asked for, or half of it when `complete` says no.
 * `fail(n)` decides per request, counting HEADs and downloads together.
 */
function provider({
  version = VERSION,
  fail = () => false,
  complete = () => true,
  files = bodies,
  raw = null,
} = {}) {
  const calls = [];
  const http = {
    async request(url, opts) {
      calls.push({ kind: 'head', url, method: opts?.method, headers: opts?.headers ?? {} });
      if (fail(calls.length)) throw new Error('connection reset');
      return {
        ok: true,
        status: 200,
        url: `https://ia800909.us.archive.org/1/items/ol_dump_${version}/ol_dump_authors_${version}.txt.gz`,
        headers: new Headers({ 'last-modified': 'Wed, 02 Sep 2026 16:01:56 GMT' }),
        body: null,
      };
    },
    async download(url, path, opts) {
      calls.push({ kind: 'download', url, path, headers: opts?.headers ?? {} });
      if (fail(calls.length)) throw new Error('connection reset');
      const kind = url.includes('_authors_') ? 'authors' : 'works';
      const bytes = raw?.[kind] ?? gzipSync(files[kind]);
      if (!complete(calls.length, kind)) {
        const half = Math.floor(bytes.length / 2);
        await writeFile(path, bytes.subarray(0, half));
        return { path, bytes: half, complete: false };
      }
      await writeFile(path, bytes);
      return { path, bytes: bytes.length, complete: true };
    },
  };
  return { http, calls };
}

/**
 * Drive the generator by hand: every batch, then the return value.
 *
 * `stopAfterBatches` is the clock: the deadline is an hour away until that
 * many batches have come out, then `Date.now` jumps past it, so the adapter
 * meets its deadline exactly where a long walk would, between two batches.
 */
async function run({
  config: cfg = {},
  cursor = {},
  p = provider(),
  deadline,
  stopAfterBatches = Number.POSITIVE_INFINITY,
  log,
} = {}) {
  const realNow = Date.now;
  let past = false;
  const clock = spyOn(Date, 'now').mockImplementation(() => (past ? 1e15 : realNow()));
  try {
    const gen = openlibraryCatalog.pull({
      config: { batchRows: 40, pauseMs: 0, ...cfg },
      cursor,
      env: {},
      http: p.http,
      log: log ?? (() => {}),
      deadline:
        deadline ??
        (Number.isFinite(stopAfterBatches) ? realNow() + 3_600_000 : Number.POSITIVE_INFINITY),
    });
    const batches = [];
    for (;;) {
      const { value, done } = await gen.next();
      if (done) return { batches, outcome: value, calls: p.calls };
      batches.push(value);
      if (batches.length >= stopAfterBatches) past = true;
    }
  } finally {
    clock.mockRestore();
  }
}

const idsOf = (batches) => batches.flatMap((b) => b.items.map((i) => i.externalId));

let dir;
let savedDataDir;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nichedb-openlibrary-catalog-'));
  savedDataDir = config.ingest.dataDir;
  config.ingest.dataDir = dir;
});
afterAll(async () => {
  config.ingest.dataDir = savedDataDir;
  await rm(dir, { recursive: true, force: true });
});

const exists = (p) =>
  stat(p).then(
    () => true,
    () => false,
  );
const localPath = (kind, version = VERSION) =>
  join(dir, 'openlibrary-catalog', localName(kind, version));

describe('the rows', () => {
  test('every fixture line is a five-column row with the JSON whole', () => {
    for (const kind of FILES) {
      const rows = rowsOf(kind);
      expect(rows).toHaveLength(100);
      for (const r of rows) {
        expect(r).not.toBeNull();
        expect(r.type).toBe(kind === 'authors' ? '/type/author' : '/type/work');
        expect(r.key).toBe(r.json.key);
        expect(r.revision).toBeGreaterThan(0);
        expect(r.lastModified).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      }
    }
  });

  test('a cut line, a short line, a blank and garbage are not rows', () => {
    const line = bodies.works.split('\n')[0];
    expect(parseRow(line.slice(0, line.length - 20))).toBeNull();
    expect(parseRow('/type/work\t/works/OL1W\t3')).toBeNull();
    expect(parseRow('')).toBeNull();
    expect(parseRow(null)).toBeNull();
    expect(parseRow('<html>')).toBeNull();
    expect(parseRow('/type/work\t/works/OL1W\t3\t2020-01-01T00:00:00\t"just a string"')).toBeNull();
  });

  test('the JSON column keeps its own tabs', () => {
    expect(splitN('a\tb\tc\td\t{"x":"1\t2"}', '\t', 5)).toEqual([
      'a',
      'b',
      'c',
      'd',
      '{"x":"1\t2"}',
    ]);
    expect(splitN('a\tb', '\t', 5)).toEqual(['a', 'b']);
  });

  test('text fields come as strings or as {value}', () => {
    expect(textOf('plain')).toBe('plain');
    expect(textOf({ type: '/type/text', value: 'boxed' })).toBe('boxed');
    expect(textOf(null)).toBe('');
    expect(textOf(42)).toBe('');
    expect(trimTo('  a   b  ')).toBe('a b');
    expect(trimTo('')).toBeNull();
    const long = trimTo('word '.repeat(200), 600);
    expect(long.length).toBeLessThanOrEqual(603);
    expect(long.endsWith('...')).toBe(true);
  });

  test('first_publish_date in every shape the dump uses', () => {
    const day = (s) => publishDate(s).publishedAt?.toISOString().slice(0, 10);
    expect(publishDate('1964')).toMatchObject({ precision: 'year', timeKnown: false });
    expect(day('1964')).toBe('1964-07-01');
    expect(publishDate('June 1940')).toMatchObject({ precision: 'month' });
    expect(day('June 1940')).toBe('1940-06-15');
    expect(publishDate('January 1, 1967')).toMatchObject({ precision: 'day' });
    expect(day('January 1, 1967')).toBe('1967-01-01');
    expect(day('August 9, 2007')).toBe('2007-08-09');
    expect(day('9 August 2007')).toBe('2007-08-09');
    expect(day('1907-02-16')).toBe('1907-02-16');
    expect(day('2005-03')).toBe('2005-03-15');
    expect(publishDate('c. 1850').precision).toBe('year');
    expect(day('c. 1850')).toBe('1850-07-01');
    expect(publishDate('unknown').publishedAt).toBeNull();
    expect(publishDate('').publishedAt).toBeNull();
    expect(publishDate(null).publishedAt).toBeNull();
  });

  test('covers and photos: an id becomes a URL, -1 and rubbish become nothing', () => {
    expect(coverUrl([3146558], 'b')).toBe('https://covers.openlibrary.org/b/id/3146558-M.jpg');
    expect(coverUrl([8445544], 'a')).toBe('https://covers.openlibrary.org/a/id/8445544-M.jpg');
    expect(coverUrl([-1], 'b')).toBeNull();
    expect(coverUrl([-1, 12], 'b')).toBeNull();
    expect(coverUrl([], 'b')).toBeNull();
    expect(coverUrl(null, 'b')).toBeNull();
    expect(coverUrl(['x'], 'b')).toBeNull();
  });
});

describe('the work item', () => {
  test('the shape, on a row with a boxed description, a cover and many subjects', () => {
    const row = rowByKey('works', '/works/OL1000806W');
    const item = workItem(row);
    expect(item.externalId).toBe('/works/OL1000806W');
    expect(item.kind).toBe('book');
    expect(item.title).toBe(row.json.title);
    expect(item.summary).toBe(trimTo(row.json.description.value));
    expect(item.summary.length).toBeLessThanOrEqual(603);
    expect(item.url).toBe('https://openlibrary.org/works/OL1000806W');
    expect(item.imageUrl).toBe(`https://covers.openlibrary.org/b/id/${row.json.covers[0]}-M.jpg`);
    expect(item.tags.slice(0, 2)).toEqual(['book', 'openlibrary']);
    const subjectTags = item.tags.filter((t) => t.startsWith('subject:'));
    expect(subjectTags).toHaveLength(5);
    expect(subjectTags[0]).toBe('subject:fiction');
    expect(item.data).toMatchObject({
      provider: 'openlibrary',
      olKey: '/works/OL1000806W',
      subjects: row.json.subjects,
      authors: row.json.authors.map((a) => a.author.key),
      lastModified: row.lastModified,
      attribution: ATTRIBUTION,
    });
    expect(item.data.authors[0]).toMatch(/^\/authors\/OL\d+A$/);
    expect(normaliseItem(item)).not.toBeNull();
  });

  test('the external id is the one openlibrary-new writes, so the rows merge', () => {
    const row = rowByKey('works', '/works/OL1041137W');
    const viaSearch = searchItem({ key: row.json.key, title: row.json.title });
    expect(workItem(row).externalId).toBe(viaSearch.externalId);
    expect(workItem(row).url).toBe(viaSearch.url);
  });

  test('publish dates land with the precision the text had', () => {
    expect(workItem(rowByKey('works', '/works/OL1041137W'))).toMatchObject({
      precision: 'year',
      timeKnown: false,
    });
    expect(workItem(rowByKey('works', '/works/OL1041137W')).data.firstPublishDate).toBe('1898');
    const day = workItem(rowByKey('works', '/works/OL1194091W'));
    expect(day.precision).toBe('day');
    expect(day.publishedAt.toISOString().slice(0, 10)).toBe('2007-08-09');
    const month = workItem(rowByKey('works', '/works/OL1197509W'));
    expect(month.precision).toBe('month');
    expect(month.publishedAt.toISOString().slice(0, 7)).toBe('2005-01');
    const none = workItem(rowByKey('works', '/works/OL10000152W'));
    expect(none.publishedAt).toBeNull();
    expect(none.data.firstPublishDate).toBeNull();
  });

  test('a -1 cover is no image, no authors is an empty list, no description is no summary', () => {
    const item = workItem(rowByKey('works', '/works/OL10616291W'));
    expect(item.imageUrl).toBeNull();
    expect(workItem(rowByKey('works', '/works/OL12081419W')).data.authors).toEqual([]);
    expect(workItem(rowByKey('works', '/works/OL10000152W')).summary).toBeNull();
  });

  test('a subject list and the places, people and times ride in the data', () => {
    const row = rowsOf('works').find((r) => r.json.subject_people?.length);
    const item = workItem(row);
    expect(item.data.subjectPeople).toEqual(row.json.subject_people);
    expect(Array.isArray(item.data.subjectPlaces)).toBe(true);
    expect(Array.isArray(item.data.subjectTimes)).toBe(true);
  });

  test('every fixture work is an item the core accepts', () => {
    const items = itemsOf('works');
    expect(items).toHaveLength(100);
    for (const it of items) {
      expect(normaliseItem(it)).not.toBeNull();
      expect(it.externalId).toMatch(/^\/works\/OL\d+W$/);
      expect(it.data.attribution).toBe(ATTRIBUTION);
    }
  });

  test('no key, no title, or the wrong type is nothing', () => {
    const row = rowByKey('works', '/works/OL1041137W');
    expect(workItem({ ...row, json: { ...row.json, title: '' } })).toBeNull();
    expect(workItem({ ...row, json: { ...row.json, key: '/books/OL1M' } })).toBeNull();
    expect(workItem(null)).toBeNull();
    expect(rowItem({ ...row, type: '/type/redirect' })).toBeNull();
    expect(rowItem({ ...row, type: '/type/delete' })).toBeNull();
  });
});

describe('the author item', () => {
  test('the shape, on a row with a bio, a photo, links, ids and alternate names', () => {
    const row = rowByKey('authors', '/authors/OL1004923A');
    const item = authorItem(row);
    expect(item).toMatchObject({
      externalId: '/authors/OL1004923A',
      kind: 'author',
      title: row.json.name,
      url: 'https://openlibrary.org/authors/OL1004923A',
      imageUrl: 'https://covers.openlibrary.org/a/id/8445544-M.jpg',
      publishedAt: null,
      tags: ['author', 'openlibrary'],
    });
    expect(item.summary).toBe(trimTo(row.json.bio.value));
    expect(item.data).toEqual({
      provider: 'openlibrary',
      olKey: '/authors/OL1004923A',
      name: row.json.name,
      personalName: row.json.personal_name ?? null,
      birthDate: row.json.birth_date,
      deathDate: row.json.death_date,
      alternateNames: row.json.alternate_names,
      links: [
        {
          title: 'Open Library subject',
          url: 'https://openlibrary.org/subjects/person:dorothea_von_schlegel_(1764-1839)',
        },
      ],
      remoteIds: { wikidata: 'Q77271', viaf: '95307649', isni: '000000011827805X' },
      revision: row.revision,
      lastModified: row.lastModified,
      attribution: ATTRIBUTION,
    });
    expect(normaliseItem(item)).not.toBeNull();
  });

  test('only wikidata, viaf and isni are kept of the remote ids', () => {
    const item = authorItem(rowByKey('authors', '/authors/OL10075763A'));
    expect(item.data.remoteIds).toEqual({
      viaf: '34156809515545121342',
      isni: '0000000500680162',
    });
  });

  test('an author without a name is skipped, not thrown', () => {
    const nameless = rowsOf('authors').filter((r) => r.json.name === undefined);
    expect(nameless.length).toBeGreaterThanOrEqual(3);
    for (const r of nameless) expect(authorItem(r)).toBeNull();
    expect(itemsOf('authors')).toHaveLength(100 - nameless.length);
  });

  test('every fixture author with a name is an item the core accepts', () => {
    for (const it of itemsOf('authors')) {
      expect(normaliseItem(it)).not.toBeNull();
      expect(it.externalId).toMatch(/^\/authors\/OL\d+A$/);
      expect(it.summary === null || it.summary.length <= 603).toBe(true);
    }
  });
});

describe('the cursor', () => {
  test('resumeFrom reads what it wrote and starts over on rubbish', () => {
    expect(resumeFrom({})).toEqual({
      version: null,
      file: 'authors',
      line: 0,
      lastModifiedWatermark: null,
      maxLastModified: null,
      done: false,
    });
    expect(
      resumeFrom({
        version: VERSION,
        file: 'works',
        line: 12500,
        lastModifiedWatermark: '2026-07-30T00:00:00',
        maxLastModified: '2026-08-31T01:00:00',
        done: false,
      }),
    ).toEqual({
      version: VERSION,
      file: 'works',
      line: 12500,
      lastModifiedWatermark: '2026-07-30T00:00:00',
      maxLastModified: '2026-08-31T01:00:00',
      done: false,
    });
    expect(resumeFrom({ version: 'latest', file: 'editions', line: -3, done: true })).toMatchObject(
      {
        version: null,
        file: 'authors',
        line: 0,
        done: false,
      },
    );
  });

  test('stale means modified before the watermark; no watermark means nothing is stale', () => {
    expect(isStale('2021-01-01T00:00:00', '2022-01-01T00:00:00')).toBe(true);
    expect(isStale('2022-01-01T00:00:00', '2022-01-01T00:00:00')).toBe(false);
    expect(isStale('2023-01-01T00:00:00', '2022-01-01T00:00:00')).toBe(false);
    expect(isStale('2021-01-01T00:00:00', null)).toBe(false);
    expect(isStale(undefined, '2022-01-01T00:00:00')).toBe(false);
  });

  test('the version comes off the mirror URL, never off Last-Modified, and other dumps are stale files', async () => {
    expect(
      versionFromUrl(
        'https://ia800909.us.archive.org/1/items/ol_dump_2026-08-31/ol_dump_authors_2026-08-31.txt.gz',
      ),
    ).toBe('2026-08-31');
    expect(versionFromUrl('https://openlibrary.org/data/ol_dump_works_latest.txt.gz')).toBeNull();
    expect(versionFromUrl(null)).toBeNull();
    // Last-Modified is the upload (Sep 2 for the Aug 31 dump): a date taken
    // from it would name an archive.org item that does not exist.
    const unnamed = provider({}).http;
    unnamed.request = async () => ({
      ok: true,
      status: 200,
      url: 'https://ia800909.us.archive.org/1/items/ol_dump_latest/ol_dump_authors_latest.txt.gz',
      headers: new Headers({ 'last-modified': 'Wed, 02 Sep 2026 16:01:56 GMT' }),
      body: null,
    });
    await expect(resolveVersion(unnamed)).rejects.toThrow(/did not say which dump is latest/);
    expect(
      staleFiles(
        [
          'ol_dump_authors_2026-07-31.txt.gz',
          'ol_dump_works_2026-08-31.txt.gz',
          'ol_dump_works_2026-08-31.txt.gz.part',
          'notes.txt',
        ],
        '2026-08-31',
      ),
    ).toEqual(['ol_dump_authors_2026-07-31.txt.gz']);
    expect(latestUrl('works')).toBe('https://openlibrary.org/data/ol_dump_works_latest.txt.gz');
    expect(datedUrl('works', '2026-08-31')).toBe(
      'https://archive.org/download/ol_dump_2026-08-31/ol_dump_works_2026-08-31.txt.gz',
    );
  });
});

describe('the walk', () => {
  test('a run cut by its deadline stops after one batch; the next resumes from the cursor and completes', async () => {
    const authorIds = itemsOf('authors').map((i) => i.externalId);
    const workIds = itemsOf('works').map((i) => i.externalId);

    // Run 1: the deadline passes after the first batch, so one batch and out.
    const first = await run({ stopAfterBatches: 1 });
    expect(first.batches).toHaveLength(1);
    expect(first.batches[0].items).toHaveLength(40);
    expect(first.batches[0].items[0].kind).toBe('author');
    expect(first.batches[0].cursor).toMatchObject({
      version: VERSION,
      file: 'authors',
      done: false,
    });
    const line = first.batches[0].cursor.line;
    expect(line).toBeGreaterThanOrEqual(40);
    expect(first.outcome).toMatchObject({ nextInMinutes: 10 });
    expect(first.outcome.cursor).toEqual(first.batches[0].cursor);
    expect(first.outcome.note).toMatch(/out of time at authors line \d+/);
    expect(first.calls.map((c) => c.kind)).toEqual(['head', 'download']);
    expect(first.calls[0].method).toBe('HEAD');
    for (const c of first.calls) expect(c.headers['user-agent']).toBe(USER_AGENT);
    expect(first.calls[1].url).toBe(datedUrl('authors', VERSION));
    expect(first.calls[1].path).toBe(localPath('authors'));
    expect(await exists(localPath('authors'))).toBe(true);

    // Run 2: from that cursor, with all the time in the world.
    const second = await run({ cursor: first.outcome.cursor });
    const kinds = second.batches.map((b) => [b.items.length, b.cursor.file]);
    expect(kinds).toEqual([
      [40, 'authors'],
      [17, 'authors'],
      [0, 'works'],
      [40, 'works'],
      [40, 'works'],
      [20, 'works'],
    ]);
    expect(second.batches[2].cursor).toMatchObject({ file: 'works', line: 0, version: VERSION });
    expect(second.batches[3].cursor.line).toBeGreaterThanOrEqual(40);
    for (const b of second.batches) expect(b.cursor.version).toBe(VERSION);
    expect(second.outcome.nextInMinutes).toBeUndefined();
    expect(second.outcome.note).toMatch(/^complete: dump 2026-08-31/);
    expect(second.outcome.cursor).toMatchObject({
      version: VERSION,
      file: null,
      line: 0,
      done: true,
      maxLastModified: null,
      lastModifiedWatermark: '2026-08-31T04:15:19.397201',
    });
    expect(second.calls.map((c) => c.kind)).toEqual(['head', 'download', 'download']);
    expect(second.calls[2].url).toBe(datedUrl('works', VERSION));

    // Across the two runs: every row once, nothing twice.
    const ids = [...idsOf(first.batches), ...idsOf(second.batches)];
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual([...authorIds, ...workIds].sort());
    // The walked files are gone; the disk is shared.
    expect(await exists(localPath('authors'))).toBe(false);
    expect(await exists(localPath('works'))).toBe(false);

    // Run 3: same dump, already walked: one HEAD, nothing else.
    const third = await run({ cursor: second.outcome.cursor });
    expect(third.batches).toEqual([]);
    expect(third.outcome).toMatchObject({ note: `unchanged (${VERSION})` });
    expect(third.outcome.nextInMinutes).toBeUndefined();
    expect(third.outcome.cursor).toEqual(second.outcome.cursor);
    expect(third.calls.map((c) => c.kind)).toEqual(['head']);
  });

  test('a deadline already near yields nothing, makes no download and asks for ten minutes', async () => {
    for (const deadline of [0, Date.now() - 1, Date.now() + 5_000]) {
      const p = provider();
      const got = await run({
        p,
        deadline,
        cursor: { version: VERSION, file: 'works', line: 700 },
      });
      expect(got.batches).toEqual([]);
      expect(got.outcome).toMatchObject({
        cursor: { version: VERSION, file: 'works', line: 700, done: false },
        nextInMinutes: 10,
      });
      expect(got.outcome.note).toMatch(/out of time before the works download/);
      expect(p.calls.map((c) => c.kind)).toEqual(['head']);
    }
    expect(await exists(localPath('works'))).toBe(false);
  });

  test('a new dump after a complete pass skips the rows modified before the watermark', async () => {
    const watermark = '2021-12-27T14:49:34.041676';
    const expected = FILES.flatMap((kind) =>
      rowsOf(kind)
        .filter((r) => r.lastModified >= watermark)
        .map(rowItem)
        .filter(Boolean)
        .map((i) => i.externalId),
    );
    expect(expected.length).toBeGreaterThan(10);
    expect(expected.length).toBeLessThan(190);
    const logs = [];
    const got = await run({
      cursor: {
        version: '2026-07-31',
        file: null,
        line: 0,
        lastModifiedWatermark: watermark,
        done: true,
      },
      log: (m) => logs.push(m),
    });
    expect(idsOf(got.batches).sort()).toEqual(expected.sort());
    expect(got.outcome.cursor).toMatchObject({
      version: VERSION,
      done: true,
      lastModifiedWatermark: '2026-08-31T04:15:19.397201',
    });
    expect(got.outcome.note).toMatch(/unchanged skipped/);
    expect(logs.some((m) => m.includes('replaces 2026-07-31'))).toBe(true);
    for (const b of got.batches) expect(b.cursor.lastModifiedWatermark).toBe(watermark);
  });

  test('a new dump while a walk is in progress starts the walk over, keeping the old pass watermark', async () => {
    const got = await run({
      stopAfterBatches: 1,
      cursor: {
        version: '2026-07-31',
        file: 'works',
        line: 9000,
        lastModifiedWatermark: '2000-01-01T00:00:00',
        maxLastModified: '2026-08-01T00:00:00',
        done: false,
      },
    });
    expect(got.batches[0].cursor).toMatchObject({ version: VERSION, file: 'authors' });
    expect(got.batches[0].cursor.lastModifiedWatermark).toBe('2000-01-01T00:00:00');
    expect(got.batches[0].items[0].kind).toBe('author');
    expect(got.calls[1].url).toBe(datedUrl('authors', VERSION));
    await rm(localPath('authors'), { force: true });
  });

  test('a stale file of another dump is removed before the walk', async () => {
    const old = localPath('works', '2026-06-30');
    await writeFile(old, 'old');
    await run({ stopAfterBatches: 1 });
    expect(await exists(old)).toBe(false);
    await rm(localPath('authors'), { force: true });
  });

  test('a download still in progress yields nothing and comes back in ten minutes', async () => {
    const p = provider({ complete: () => false });
    const got = await run({ p });
    expect(got.batches).toEqual([]);
    expect(got.outcome).toMatchObject({
      cursor: { version: VERSION, file: 'authors', line: 0, done: false },
      nextInMinutes: 10,
    });
    expect(got.outcome.note).toMatch(/authors download in progress/);
    expect(p.calls.map((c) => c.kind)).toEqual(['head', 'download']);
    // The partial file stays where the resume helper will pick it up.
    expect((await stat(localPath('authors'))).size).toBeGreaterThan(0);
    await rm(localPath('authors'), { force: true });
  });

  test('the works download in progress keeps the cursor at works line 0, after the authors', async () => {
    const p = provider({ complete: (_n, kind) => kind !== 'works' });
    const got = await run({ p });
    expect(got.batches.map((b) => [b.items.length, b.cursor.file])).toEqual([
      [40, 'authors'],
      [40, 'authors'],
      [17, 'authors'],
      [0, 'works'],
    ]);
    expect(got.outcome).toMatchObject({
      cursor: { version: VERSION, file: 'works', line: 0 },
      nextInMinutes: 10,
    });
    expect(got.outcome.note).toMatch(/works download in progress/);
    await rm(localPath('works'), { force: true });
  });

  test('a bad row is counted and skipped; the line count still names the file position', async () => {
    const lines = bodies.authors.split('\n').filter(Boolean);
    const broken = [
      lines[0],
      lines[1].slice(0, lines[1].length - 30),
      '',
      'this is not a row at all',
      ...lines.slice(2),
      lines[3].slice(0, 40),
    ].join('\n');
    const logs = [];
    const p = provider({ files: { authors: broken, works: bodies.works } });
    const got = await run({ p, log: (m) => logs.push(m) });
    const authorBatches = got.batches.filter((b) => b.cursor.file === 'authors' && b.items.length);
    expect(idsOf(authorBatches)).toHaveLength(itemsOf('authors').length - 1);
    expect(authorBatches.at(-1).cursor.line).toBe(lines.length + 3);
    expect(logs.filter((m) => /not a row/.test(m))).toHaveLength(3);
    expect(got.outcome.note).toMatch(/3 unreadable/);
    expect(got.outcome.cursor.done).toBe(true);
  });

  test('a file gzip cannot read is removed and the run fails; the place is kept by the batches', async () => {
    const p = provider({ raw: { authors: Buffer.from('this is not gzip') } });
    await expect(run({ p })).rejects.toThrow(/authors dump 2026-08-31 unreadable/);
    expect(await exists(localPath('authors'))).toBe(false);
  });
});

describe('failures', () => {
  test('three failed downloads stop the run without losing the place; the HEAD counts as a request that worked', async () => {
    const p = provider({ fail: (n) => n > 1 });
    const got = await run({
      p,
      cursor: { version: VERSION, file: 'works', line: 500, done: false },
    });
    expect(got.batches).toEqual([]);
    expect(got.outcome).toMatchObject({
      cursor: { version: VERSION, file: 'works', line: 500 },
      nextInMinutes: 10,
    });
    expect(got.outcome.note).toMatch(/repeated failures on the works download/);
    expect(p.calls.map((c) => c.kind)).toEqual(['head', 'download', 'download', 'download']);
  });

  test('a run in which every request failed throws', async () => {
    const p = provider({ fail: () => true });
    await expect(run({ p })).rejects.toThrow(/every request failed \(3\)/);
    expect(p.calls.map((c) => c.kind)).toEqual(['head', 'head', 'head']);
  });

  test('a walk in progress carries on when the latest dump cannot be resolved', async () => {
    const p = provider({ fail: (n) => n <= 3 });
    const got = await run({
      p,
      stopAfterBatches: 1,
      cursor: { version: '2026-07-31', file: 'works', line: 0, done: false },
    });
    expect(p.calls.map((c) => c.kind)).toEqual(['head', 'head', 'head', 'download']);
    expect(p.calls[3].url).toBe(datedUrl('works', '2026-07-31'));
    expect(got.batches[0].cursor).toMatchObject({ version: '2026-07-31', file: 'works' });
    expect(got.batches[0].items[0].kind).toBe('book');
    await rm(localPath('works', '2026-07-31'), { force: true });
  });

  test('nothing in progress and no version is a stop, and with every request failed a throw', async () => {
    const p = provider({ fail: () => true });
    await expect(
      run({ p, cursor: { version: VERSION, file: null, line: 0, done: true } }),
    ).rejects.toThrow(/every request failed/);
  });
});

describe('the adapter', () => {
  test('declares the walk: books collection, both kinds, a 55 minute budget, a monthly cadence', () => {
    expect(openlibraryCatalog.name).toBe('openlibrary-catalog');
    expect(openlibraryCatalog.collection).toBe('books');
    expect(openlibraryCatalog.kinds).toEqual(['book', 'author']);
    expect(openlibraryCatalog.budgetMs).toBe(BUDGET_MS);
    expect(BUDGET_MS).toBe(55 * 60_000);
    expect(openlibraryCatalog.cadenceMinutes).toBe(CADENCE_MINUTES);
    expect(CADENCE_MINUTES).toBe(30 * 24 * 60);
    expect(openlibraryCatalog.defaultSources[0].slug).toBe('openlibrary-catalog');
    expect(openlibraryCatalog.defaults).toEqual({ batchRows: 500, pauseMs: 2000 });
  });

  test('the description states the licence and nothing carries an em dash', async () => {
    expect(openlibraryCatalog.description).toMatch(/no new copyright asserted/);
    expect(ATTRIBUTION).toMatch(/Open Library/);
    const src = await readFile(
      new URL('../packages/adapters/src/openlibrary-catalog.js', import.meta.url),
      'utf8',
    );
    expect(src).not.toContain(EM_DASH);
    expect(openlibraryCatalog.description).not.toContain(EM_DASH);
    for (const kind of FILES) {
      for (const it of itemsOf(kind)) {
        expect(JSON.stringify(it.data)).toContain(ATTRIBUTION);
      }
    }
  });
});
