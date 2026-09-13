import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The Podcast Index dump, walked without the dump.
 *
 * The real file is a 1.8 GB tgz holding a 5.1 GB SQLite database, so nothing
 * here downloads it. What is real is the schema: the CREATE TABLE in
 * `podcastindex-catalog-schema.sql` was cut from the first 4 MB of the archive
 * on 2026-09-13, and every test database here is created from it, so the
 * column names the adapter resolves are the ones the dump actually has. The
 * HEAD fixture is the real server's answer the same day, and the listing is
 * the real tar member.
 */
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';

const { config } = await import('../packages/config/src/index.js');
const { normaliseItem } = await import('../packages/core/src/adapter.js');
const {
  ATTRIBUTION,
  BUDGET_MS,
  CADENCE_MINUTES,
  categoriesOf,
  discoverSchema,
  dumpVersion,
  epochDate,
  FIELD_NAMES,
  flag,
  langTag,
  MAX_FAILURES,
  normaliseFeedUrl,
  pickTable,
  podcastindexCatalog,
  resolveColumns,
  RESUME_IN_MINUTES,
  rowsToItems,
  selectSql,
  summaryOf,
  toItem,
  userAgent,
  versionStamp,
} = await import('../packages/adapters/src/podcastindex-catalog.js');

const FIXTURES = join(import.meta.dir, '../packages/adapters/test/fixtures');
const SCHEMA = await readFile(join(FIXTURES, 'podcastindex-catalog-schema.sql'), 'utf8');
const HEAD = await readFile(join(FIXTURES, 'podcastindex-catalog-head.txt'), 'utf8');
const NEWSFEEDS = await readFile(join(FIXTURES, 'podcastindex-catalog-newsfeeds.sql'), 'utf8');
const LISTING = await readFile(join(FIXTURES, 'podcastindex-catalog-listing.txt'), 'utf8');

/** The real HEAD response as a header map. */
function headersOf(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^([a-z0-9-]+):\s*(.*)$/i);
    if (m) out[m[1].toLowerCase()] = m[2].trim();
  }
  return out;
}
const REAL_HEAD = headersOf(HEAD);

/** The 42 real column names, from the fixture DDL. */
const REAL_COLUMNS = [...SCHEMA.matchAll(/^\s{4}(\w+)\s+(?:INTEGER|TEXT)/gm)].map((m) => m[1]);

/** The repository's MySQL DDL column names, in case a dump ever follows it. */
const NEWSFEEDS_COLUMNS = [
  ...NEWSFEEDS.matchAll(/^\s{2}`(\w+)`\s+(?:bigint|varchar|int|tinyint|longtext|mediumtext)/gm),
].map((m) => m[1]);

/**
 * Rows in the dump's own column names. The first two carry the values of the
 * first two rows of the repository's sample CSV (Libsyn and Anchor shows); the
 * rest are the edge cases a real dump has by the thousand.
 */
const ROWS = [
  {
    id: 1,
    url: 'https://markalanwilliams.libsyn.com/rss',
    title: 'Christianity Questions and Answers',
    lastUpdate: 1599840661,
    link: 'http://markalanwilliams.libsyn.com/webpage',
    dead: 0,
    itunesId: 1000000618,
    itunesAuthor: 'Dr. Mark Alan Williams',
    explicit: 0,
    imageUrl: 'https://ssl-static.libsyn.com/p/assets/e/7/5/d/e75de19145e2153b/thumb.jpg',
    generator: 'Libsyn WebEngine 2.0',
    newestItemPubdate: 1592074395,
    language: '',
    episodeCount: 12,
    host: 'libsyn.com',
    description:
      'Dr. Mark Alan Williams and friends answer questions about the Christian faith: questions about the God, Jesus, the Bible, eternity, belief, religion the reasonableness of faith and others.',
    category1: 'Religion',
    category2: 'Spirituality',
    category3: 'Christianity',
  },
  {
    id: 2,
    url: 'https://anchor.fm/s/19ccb320/podcast/rss',
    title: 'Rahdo Talks Through',
    lastUpdate: 1600183477,
    link: 'https://patreon.com/rahdo',
    dead: 0,
    itunesId: 1000016089,
    itunesAuthor: 'Richard Ham',
    explicit: 0,
    imageUrl:
      'https://d3t3ozftmdmh3i.cloudfront.net/staging/podcast_uploaded_nologo/4228456/81316933823cb437.jpeg',
    generator: 'Anchor Podcasts',
    newestItemPubdate: 1599770045,
    language: 'en',
    episodeCount: 340,
    host: 'anchor.fm',
    description: 'A podcast all about boardgames, hosted by Richard "Rahdo" Ham',
    category1: 'Leisure',
    category2: 'Games',
    category3: 'Hobbies',
    category4: 'Leisure',
  },
  // Dead: too many errors, no longer checked. Not a podcast anyone can fetch.
  { id: 3, url: 'https://dead.example/feed.xml', title: 'Gone', dead: 1, language: 'en' },
  // No title.
  { id: 4, url: 'https://untitled.example/feed.xml', title: '   ', dead: 0 },
  // A feed url that does not parse.
  { id: 5, url: 'not a url', title: 'Broken Feed', dead: 0 },
  // Upper-case host, trailing slash, fragment, no site: url falls back to the feed.
  {
    id: 6,
    url: 'HTTPS://Example.COM/Feeds/Show/#top',
    title: 'Self Hosted &amp; Proud',
    link: '',
    dead: 0,
    language: 'DE-de',
    description: '<p>Hello &amp; welcome to the show&rsquo;s feed.</p><br>Second   line.',
    newestItemPubdate: 0,
    explicit: 1,
    imageUrl: '',
  },
  // Text where numbers should be, from a CSV import gone wrong.
  {
    id: 7,
    url: 'http://plain.example/rss',
    title: 'Odd Numbers',
    dead: 'no',
    newestItemPubdate: 'soon',
    explicit: 'yes',
    itunesId: null,
    language: 'en-US',
    episodeCount: -3,
  },
];

/**
 * A row as the walk hands it to `toItem`: `selectSql` aliases the dump's
 * columns onto the logical field names, so a direct call maps them the same way.
 */
const { columns: REAL_MAP } = resolveColumns(REAL_COLUMNS);
function logical(row) {
  const out = {};
  for (const [field, real] of Object.entries(REAL_MAP)) {
    if (real && row[real] !== undefined) out[field] = row[real];
  }
  for (const k of Object.keys(row)) if (/^category\d+$/.test(k)) out[k] = row[k];
  return out;
}

const listing = LISTING.trim().split(/\s+/);
/** The member name inside the real archive, from the real listing. */
const MEMBER = listing[listing.length - 1];

let work;
let tgz;
let dataDirBefore;

/** A SQLite database created from the real DDL, filled with `rows`, as a tgz laid out like the real one. */
async function makeArchive(rows, name = 'dump') {
  const src = join(work, `${name}-src`);
  await mkdir(src, { recursive: true });
  const dbPath = join(src, MEMBER.replace(/^\.\//, ''));
  const db = new Database(dbPath);
  db.run(SCHEMA);
  const cols = REAL_COLUMNS;
  const insert = db.prepare(
    `insert into podcasts (${cols.map((c) => `"${c}"`).join(', ')}) values (${cols.map(() => '?').join(', ')})`,
  );
  for (const row of rows) {
    insert.run(
      ...cols.map((c) => {
        if (row[c] !== undefined) return row[c];
        // The real table is NOT NULL on its text columns and defaults nothing.
        return /TEXT/.test(SCHEMA.match(new RegExp(`\\n\\s+${c}\\s+(\\w+)`))?.[1] ?? '')
          ? ''
          : null;
      }),
    );
  }
  db.close();
  const out = join(work, `${name}.tgz`);
  const proc = Bun.spawn(['tar', '-czf', out, '-C', src, MEMBER], {
    stdout: 'ignore',
    stderr: 'pipe',
  });
  if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
  return out;
}

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), 'nichedb-podcastindex-test-'));
  dataDirBefore = config.ingest.dataDir;
  // dumpDir reads this at call time; the module is shared with every other test file.
  config.ingest.dataDir = join(work, 'data');
  tgz = await makeArchive(ROWS);
});

afterAll(async () => {
  config.ingest.dataDir = dataDirBefore;
  await rm(work, { recursive: true, force: true });
});

/**
 * A stand-in for ctx.http: HEAD answers with the fixture headers, download
 * copies the archive (or a prefix of it) to where the adapter asked.
 */
function fakeHttp({
  headers = REAL_HEAD,
  archive = () => tgz,
  partial = false,
  headFails = 0,
  downloadFails = 0,
} = {}) {
  const seen = { heads: [], downloads: [], agents: [] };
  let hf = headFails;
  let df = downloadFails;
  const http = {
    async request(url, opts = {}) {
      seen.heads.push(url);
      seen.agents.push(opts.headers?.['user-agent']);
      expect(opts.method).toBe('HEAD');
      if (hf > 0) {
        hf -= 1;
        throw new Error('socket hang up');
      }
      return new Response(null, { status: 200, headers });
    },
    async download(_url, filePath, opts = {}) {
      seen.downloads.push(filePath);
      seen.agents.push(opts.headers?.['user-agent']);
      if (df > 0) {
        df -= 1;
        throw new Error('ECONNRESET');
      }
      const bytes = await readFile(archive());
      const part = partial ? bytes.subarray(0, 64) : bytes;
      await writeFile(filePath, part);
      return { path: filePath, bytes: part.length, complete: !partial };
    },
  };
  return { http, seen };
}

/** Run pull to the end, collecting the batches and the return value. */
async function drain(gen) {
  const batches = [];
  for (;;) {
    const { value, done } = await gen.next();
    if (done) return { batches, outcome: value };
    batches.push(value);
  }
}

const pull = (http, { cursor = {}, deadline = Number.POSITIVE_INFINITY, batchSize = 50 } = {}) =>
  podcastindexCatalog.pull({
    config: { batchSize, pauseMs: 0 },
    cursor,
    env: { contactEmail: 'ops@nichedb.test' },
    http,
    log: () => {},
    deadline,
  });

const ids = (batches) => batches.flatMap((b) => b.items.map((i) => i.externalId));

describe('registration', () => {
  test('podcasts collection, show kind, a weekly cadence and a 55 minute budget', () => {
    expect(podcastindexCatalog.name).toBe('podcastindex-catalog');
    expect(podcastindexCatalog.collection).toBe('podcasts');
    expect(podcastindexCatalog.kinds).toEqual(['show']);
    expect(podcastindexCatalog.cadenceMinutes).toBe(CADENCE_MINUTES);
    expect(CADENCE_MINUTES).toBe(7 * 24 * 60);
    expect(podcastindexCatalog.budgetMs).toBe(BUDGET_MS);
    expect(BUDGET_MS).toBe(55 * 60_000);
    expect(podcastindexCatalog.defaultSources.map((s) => s.slug)).toEqual(['podcastindex-catalog']);
  });

  test('the description states the licence and nothing here carries an em dash', async () => {
    expect(podcastindexCatalog.description).toMatch(/MIT/);
    const src = await readFile(
      join(import.meta.dir, '../packages/adapters/src/podcastindex-catalog.js'),
      'utf8',
    );
    const emDash = String.fromCharCode(0x2014);
    expect(src.includes(emDash)).toBe(false);
    expect(podcastindexCatalog.description.includes(emDash)).toBe(false);
  });

  test('the user agent says who is asking and how to reach them', () => {
    expect(userAgent({ contactEmail: 'ops@nichedb.test' })).toBe(
      'niche-db podcastindex-catalog/1 (+https://nichedb.dev; weekly read of the public dump; ops@nichedb.test)',
    );
    expect(userAgent({})).toMatch(/^niche-db podcastindex-catalog\/1 \(\+https:\/\/nichedb\.dev/);
  });
});

describe('the real schema', () => {
  test('the fixture is the dump as published: a podcasts table with camelCase columns', () => {
    expect(SCHEMA.startsWith('CREATE TABLE podcasts (')).toBe(true);
    expect(REAL_COLUMNS).toHaveLength(42);
    expect(REAL_COLUMNS).toContain('newestItemPubdate');
    expect(REAL_COLUMNS).toContain('episodeCount');
    expect(REAL_COLUMNS).toContain('category10');
    expect(MEMBER).toBe('./podcastindex_feeds.db');
  });

  test('every field resolves against the real columns, and the categories are in order', () => {
    const { columns, categories } = resolveColumns(REAL_COLUMNS);
    expect(columns.id).toBe('id');
    expect(columns.url).toBe('url');
    expect(columns.image).toBe('imageUrl');
    expect(columns.newestItemPubdate).toBe('newestItemPubdate');
    expect(columns.episodeCount).toBe('episodeCount');
    expect(columns.guid).toBe('podcastGuid');
    expect(columns.host).toBe('host');
    expect(categories).toEqual(Array.from({ length: 10 }, (_, i) => `category${i + 1}`));
    for (const field of Object.keys(FIELD_NAMES)) expect(columns).toHaveProperty(field);
  });

  test('the repository DDL (newsfeeds, snake_case) resolves too, with nulls where it has nothing', () => {
    expect(NEWSFEEDS_COLUMNS.length).toBeGreaterThan(30);
    const { columns, categories } = resolveColumns(NEWSFEEDS_COLUMNS);
    expect(columns.image).toBe('artwork_url_600');
    expect(columns.newestItemPubdate).toBe('newest_item_pubdate');
    expect(columns.episodeCount).toBe('item_count');
    expect(columns.itunesId).toBe('itunes_id');
    expect(columns.host).toBeNull();
    expect(categories).toEqual([]);
  });

  test('a table without id, url and title is refused by name', () => {
    expect(() => resolveColumns(['id', 'feedTitle'])).toThrow(/no url, title column/);
  });

  test('the table is picked by name first, then by shape', () => {
    expect(
      pickTable([
        { name: 'other', columns: ['url', 'title'] },
        { name: 'podcasts', columns: [] },
      ]).name,
    ).toBe('podcasts');
    expect(pickTable([{ name: 'newsfeeds', columns: [] }]).name).toBe('newsfeeds');
    expect(pickTable([{ name: 'feeds', columns: ['URL', 'Title'] }]).name).toBe('feeds');
    expect(pickTable([{ name: 'episodes', columns: ['id'] }])).toBeNull();
    expect(pickTable(null)).toBeNull();
  });

  test('discoverSchema reads it from the file and selectSql keys the walk on the id', async () => {
    const src = join(work, 'dump-src', 'podcastindex_feeds.db');
    const schema = discoverSchema(src);
    expect(schema.table).toBe('podcasts');
    const sql = selectSql(schema);
    expect(sql).toMatch(/^select "id" as "id", "url" as "url", "title" as "title"/);
    expect(sql).toMatch(/"imageUrl" as "image"/);
    expect(sql).toMatch(/"category10" as "category10"/);
    expect(sql).toMatch(/from "podcasts" where "id" > \? order by "id" limit \?$/);
  });
});

describe('the version', () => {
  test('is the real ETag, with the Last-Modified and size beside it', () => {
    const v = dumpVersion(REAL_HEAD);
    expect(v.version).toBe('b60fa45859813600fc0320e710b1a73f-117');
    expect(v.etag).toBe('b60fa45859813600fc0320e710b1a73f-117');
    expect(v.lastModified).toBe('2026-09-12T23:24:31.000Z');
    expect(v.bytes).toBe(1826623856);
    expect(dumpVersion(new Headers(REAL_HEAD)).version).toBe(v.version);
  });

  test('falls back to Last-Modified, then to nothing', () => {
    expect(dumpVersion({ 'last-modified': 'Sat, 12 Sep 2026 23:24:31 GMT' }).version).toBe(
      '2026-09-12T23:24:31.000Z',
    );
    expect(dumpVersion({}).version).toBeNull();
    expect(dumpVersion(null).version).toBeNull();
  });

  test('is a file name', () => {
    expect(versionStamp('b60fa45859813600fc0320e710b1a73f-117')).toBe(
      'b60fa45859813600fc0320e710b1a73f-117',
    );
    expect(versionStamp('2026-09-12T23:24:31.000Z')).toMatch(/^2026-09-12t/);
    expect(versionStamp('')).toBe('dump');
  });
});

describe('one row as an item', () => {
  test('the show, in the podcasts collection shape', () => {
    const item = toItem(logical(ROWS[1]));
    expect(item.externalId).toBe('podcastindex:feed:2');
    expect(item.kind).toBe('show');
    expect(item.title).toBe('Rahdo Talks Through');
    expect(item.url).toBe('https://patreon.com/rahdo');
    expect(item.imageUrl).toMatch(/^https:\/\/d3t3ozftmdmh3i\.cloudfront\.net/);
    expect(item.publishedAt).toEqual(new Date(1599770045 * 1000));
    expect(item.summary).toBe('A podcast all about boardgames, hosted by Richard "Rahdo" Ham');
    expect(item.tags).toEqual([
      'show',
      'podcast',
      'podcastindex',
      'lang:en',
      'category:leisure',
      'category:games',
      'category:hobbies',
    ]);
    expect(item.data.feedUrl).toBe('https://anchor.fm/s/19ccb320/podcast/rss');
    expect(item.data.feedId).toBe(2);
    expect(item.data.itunesId).toBe(1000016089);
    expect(item.data.language).toBe('en');
    expect(item.data.categories).toEqual(['Leisure', 'Games', 'Hobbies']);
    expect(item.data.episodeCount).toBe(340);
    expect(item.data.newestItemPubdate).toBe('2020-09-10T20:34:05.000Z');
    expect(item.data.lastUpdate).toBe('2020-09-15T15:24:37.000Z');
    expect(item.data.explicit).toBe(false);
    expect(item.data.generator).toBe('Anchor Podcasts');
    expect(item.data.host).toBe('anchor.fm');
    expect(item.data.platform).toBe('anchor.fm');
    expect(item.data.author).toBe('Richard Ham');
    expect(item.data.attribution).toBe(ATTRIBUTION);
    expect(ATTRIBUTION).toBe('Podcast Index; dump under its terms, index data MIT');

    const stored = normaliseItem(item);
    expect(stored).not.toBeNull();
    expect(stored.dedupeKey).toBeTruthy();
    expect(stored.data.feedUrl).toBe(item.data.feedUrl);
  });

  test('the feed url is the join key: lowercase host, no trailing slash, no fragment, scheme kept', () => {
    const item = toItem(logical(ROWS[5]));
    expect(item.data.feedUrl).toBe('https://example.com/Feeds/Show');
    expect(item.url).toBe('https://example.com/Feeds/Show');
    expect(item.data.siteUrl).toBeNull();
    expect(item.title).toBe('Self Hosted &amp; Proud');
    expect(item.summary).toBe('Hello & welcome to the show’s feed. Second line.');
    expect(item.tags).toContain('lang:de');
    expect(item.publishedAt).toBeNull();
    expect(item.imageUrl).toBeNull();
    expect(item.data.explicit).toBe(true);
    expect(item.data.platform).toBeNull();

    expect(normaliseFeedUrl('http://Host.Example:8080/a/b/?x=1#f')).toBe(
      'http://host.example:8080/a/b?x=1',
    );
    expect(normaliseFeedUrl('https://host.example/')).toBe('https://host.example');
    expect(normaliseFeedUrl('ftp://host.example/feed')).toBeNull();
    expect(normaliseFeedUrl('feed.xml')).toBeNull();
    expect(normaliseFeedUrl(null)).toBeNull();
  });

  test('a language tag is its base; categories keep column order and drop repeats', () => {
    expect(langTag('en-US')).toBe('lang:en');
    expect(langTag('DE-de')).toBe('lang:de');
    expect(langTag('')).toBeNull();
    expect(langTag('english')).toBeNull();
    expect(
      categoriesOf({ category2: 'B', category1: 'A', category10: 'A', category3: '' }),
    ).toEqual(['A', 'B']);
  });

  test('dead, untitled and unparseable rows are nothing', () => {
    expect(toItem(logical(ROWS[2]))).toBeNull();
    expect(toItem(logical(ROWS[3]))).toBeNull();
    expect(toItem(logical(ROWS[4]))).toBeNull();
    expect(toItem({ id: 'x', url: 'https://a.example/f', title: 'A' })).toBeNull();
    expect(toItem(null)).toBeNull();
  });

  test('text in numeric columns becomes null, never NaN or a throw', () => {
    const item = toItem(logical(ROWS[6]));
    expect(item).not.toBeNull();
    expect(item.publishedAt).toBeNull();
    expect(item.data.newestItemPubdate).toBeNull();
    expect(item.data.explicit).toBe(true);
    expect(item.data.itunesId).toBeNull();
    expect(item.data.episodeCount).toBeNull();
    expect(item.tags).toContain('lang:en');
    expect(flag('no')).toBe(false);
    expect(flag(1)).toBe(true);
    expect(flag('0')).toBe(false);
    expect(epochDate(0)).toBeNull();
    expect(epochDate(4_200_000_000)).toBeNull();
    expect(summaryOf(`<b>${'x'.repeat(700)}</b>`)).toHaveLength(600);
  });

  test('a row that throws inside the mapping is one bad row, not a failed batch', () => {
    const cursed = {
      id: 9,
      url: 'https://a.example/f',
      get title() {
        throw new Error('corrupt cell');
      },
    };
    const logged = [];
    const out = rowsToItems([logical(ROWS[0]), cursed, logical(ROWS[2])], {
      log: (m) => logged.push(m),
    });
    expect(out.items.map((i) => i.externalId)).toEqual(['podcastindex:feed:1']);
    expect(out).toMatchObject({ kept: 1, bad: 1, skipped: 1 });
    expect(logged[0]).toMatch(/row 9 dropped: corrupt cell/);
    expect(rowsToItems(null)).toEqual({ items: [], kept: 0, skipped: 0, bad: 0 });
  });
});

describe('the walk', () => {
  test('one run: HEAD, download, extract, then every batch carries the id to resume from', async () => {
    const { http, seen } = fakeHttp();
    const { batches, outcome } = await drain(pull(http, { batchSize: 50 }));

    expect(seen.heads).toEqual(['https://public.podcastindex.org/podcastindex_feeds.db.tgz']);
    expect(seen.downloads).toHaveLength(1);
    expect(seen.downloads[0]).toBe(
      join(work, 'data', 'podcastindex', 'b60fa45859813600fc0320e710b1a73f-117.db.tgz'),
    );
    // A descriptive user agent on every request.
    for (const ua of seen.agents)
      expect(ua).toMatch(/^niche-db podcastindex-catalog\/1 \(.*ops@nichedb\.test\)$/);

    // 7 rows in one batch of 50: 4 shows, 3 skipped.
    expect(batches).toHaveLength(1);
    expect(ids(batches)).toEqual([
      'podcastindex:feed:1',
      'podcastindex:feed:2',
      'podcastindex:feed:6',
      'podcastindex:feed:7',
    ]);
    expect(batches[0].cursor).toEqual({
      version: 'b60fa45859813600fc0320e710b1a73f-117',
      lastModified: '2026-09-12T23:24:31.000Z',
      afterId: 7,
    });
    expect(outcome.cursor).toEqual({ ...batches[0].cursor, done: true });
    expect(outcome.note).toMatch(/^complete: 4 shows, 3 skipped, 0 bad rows$/);
    expect(outcome.nextInMinutes).toBeUndefined();

    // The archive was deleted after extraction; the database and its marker stay.
    const dir = join(work, 'data', 'podcastindex', 'b60fa45859813600fc0320e710b1a73f-117');
    await expect(stat(seen.downloads[0])).rejects.toThrow();
    expect((await stat(join(dir, 'ready'))).isFile()).toBe(true);
    expect((await stat(join(dir, 'podcastindex_feeds.db'))).isFile()).toBe(true);
  });

  test('a run out of time stops after the batch in hand and the next resumes exactly there', async () => {
    // Batches of 50 are the floor, so a two-run walk needs a database with more rows.
    const many = Array.from({ length: 120 }, (_, i) => ({
      id: 100 + i,
      url: `https://many.example/${i}/feed.xml`,
      title: `Show ${i}`,
      dead: i % 10 === 9 ? 1 : 0,
      language: 'en',
    }));
    const archive = await makeArchive(many, 'many');
    const headers = { ...REAL_HEAD, etag: '"many-1"' };
    const p = fakeHttp({ headers, archive: () => archive });

    // Deadline already past: the first batch is still yielded, then the run returns.
    const first = await drain(pull(p.http, { batchSize: 50, deadline: Date.now() - 1 }));
    expect(first.batches).toHaveLength(1);
    expect(first.batches[0].items).toHaveLength(45);
    expect(first.batches[0].cursor).toEqual({
      version: 'many-1',
      lastModified: '2026-09-12T23:24:31.000Z',
      afterId: 149,
    });
    expect(first.outcome.cursor).toEqual(first.batches[0].cursor);
    expect(first.outcome.nextInMinutes).toBe(RESUME_IN_MINUTES);
    expect(first.outcome.note).toMatch(/out of time at id 149/);

    // Next run, from that cursor: no second download (the extract is cached), rows after 149 only.
    const second = await drain(pull(p.http, { batchSize: 50, cursor: first.outcome.cursor }));
    expect(p.seen.downloads).toHaveLength(1);
    expect(second.batches.map((b) => b.cursor.afterId)).toEqual([199, 219]);
    expect(ids(second.batches)[0]).toBe('podcastindex:feed:150');
    expect(ids(second.batches)).toHaveLength(63);
    expect(ids(second.batches)).not.toContain('podcastindex:feed:149');
    expect(second.outcome.cursor).toEqual({
      version: 'many-1',
      lastModified: '2026-09-12T23:24:31.000Z',
      afterId: 219,
      done: true,
    });
    expect(second.outcome.nextInMinutes).toBeUndefined();

    // Same file, walk done: one HEAD and nothing else.
    const third = await drain(pull(p.http, { cursor: second.outcome.cursor }));
    expect(third.batches).toEqual([]);
    expect(third.outcome).toEqual({ cursor: second.outcome.cursor, note: 'unchanged' });
    expect(p.seen.downloads).toHaveLength(1);

    // A new file on the server: the walk starts over and the old extract is pruned.
    const fresh = fakeHttp({ headers: { ...REAL_HEAD, etag: '"many-2"' }, archive: () => archive });
    const fourth = await drain(pull(fresh.http, { cursor: second.outcome.cursor }));
    expect(fresh.seen.downloads).toHaveLength(1);
    expect(fourth.batches[0].cursor).toMatchObject({ version: 'many-2', afterId: 149 });
    expect(fourth.outcome.cursor.done).toBe(true);
    await expect(stat(join(work, 'data', 'podcastindex', 'many-1'))).rejects.toThrow();
    expect((await stat(join(work, 'data', 'podcastindex', 'many-2'))).isDirectory()).toBe(true);
  });

  test('a download still in progress yields nothing and comes back in ten minutes', async () => {
    const headers = { ...REAL_HEAD, etag: '"partial-1"' };
    const partial = fakeHttp({ headers, partial: true });
    const cursor = { version: 'partial-1', lastModified: '2026-09-12T23:24:31.000Z', afterId: 0 };
    const first = await drain(pull(partial.http, { cursor }));
    expect(first.batches).toEqual([]);
    expect(first.outcome).toEqual({
      cursor,
      note: 'download in progress',
      nextInMinutes: RESUME_IN_MINUTES,
    });
    const file = join(work, 'data', 'podcastindex', 'partial-1.db.tgz');
    expect((await stat(file)).size).toBe(64);

    // The next run finishes the download (the real http.download resumes with Range) and walks.
    const whole = fakeHttp({ headers });
    const second = await drain(pull(whole.http, { cursor: first.outcome.cursor }));
    expect(whole.seen.downloads).toEqual([file]);
    expect(ids(second.batches)).toHaveLength(4);
    expect(second.outcome.cursor.done).toBe(true);
  });

  test('three consecutive download failures stop the run and keep the place', async () => {
    const headers = { ...REAL_HEAD, etag: '"flaky-1"' };
    const cursor = { version: 'flaky-1', lastModified: '2026-09-12T23:24:31.000Z', afterId: 4 };
    const flaky = fakeHttp({ headers, downloadFails: MAX_FAILURES });
    const out = await drain(pull(flaky.http, { cursor }));
    expect(out.batches).toEqual([]);
    expect(flaky.seen.downloads).toHaveLength(MAX_FAILURES);
    expect(out.outcome.cursor).toEqual(cursor);
    expect(out.outcome.nextInMinutes).toBe(RESUME_IN_MINUTES);
    expect(out.outcome.note).toMatch(/repeated failures/);

    // Two failures and a third success is a normal run.
    const recovering = fakeHttp({ headers, downloadFails: MAX_FAILURES - 1 });
    const ok = await drain(pull(recovering.http, { cursor }));
    expect(recovering.seen.downloads).toHaveLength(MAX_FAILURES);
    expect(ids(ok.batches)).toEqual(['podcastindex:feed:6', 'podcastindex:feed:7']);
    expect(ok.outcome.cursor.done).toBe(true);
  });

  test('a run in which every request failed throws', async () => {
    const dead = fakeHttp({ headFails: MAX_FAILURES });
    await expect(drain(pull(dead.http))).rejects.toThrow(
      /every request failed; last: socket hang up/,
    );
    expect(dead.seen.heads).toHaveLength(MAX_FAILURES);
    expect(dead.seen.downloads).toHaveLength(0);
  });

  test('a 403 (no user agent) is a failed request too', async () => {
    const http = {
      async request() {
        return new Response('forbidden', { status: 403 });
      },
      async download() {
        throw new Error('never reached');
      },
    };
    await expect(drain(pull(http))).rejects.toThrow(/403 from HEAD/);
  });
});
