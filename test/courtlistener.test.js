import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

/**
 * CourtListener in the `law` collection: the live feeds and API on one side,
 * the bulk-data catalogue on the other, sharing ids.
 *
 * The feed fixtures are three entries and two items cut from the live feeds
 * on 2026-09-22, chosen so the parser meets what the feeds carry: a
 * published date in the year 2109, one a month ahead, the court as an Atom
 * author, the PDF as an enclosure, the MP3 with its length and duration.
 * The API rows are built from the shapes the v4 API answered the same day.
 * The catalogue rows are built from the dump headers, and the walk runs
 * against tiny bzip2 files written by the system bzip2 into a temp dump
 * directory, behind a fake S3.
 */
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';

const { config } = await import('../packages/config/src/index.js');
const { normaliseItem } = await import('../packages/core/src/adapter.js');
const { ADAPTERS, adapterByName } = await import('../packages/adapters/src/index.js');
const { COLLECTIONS, DEFAULT_FEEDS } = await import('../packages/core/src/seed.js');
const live = await import('../packages/adapters/src/courtlistener.js');
const cat = await import('../packages/adapters/src/courtlistener-catalog.js');
const { PATCH_ITEMS_SQL, patchRows } = await import('../packages/db/src/queries.js');

const fixture = (name) =>
  readFile(new URL(`../packages/adapters/test/fixtures/${name}`, import.meta.url), 'utf8');

/** Built at runtime so the character itself never appears in this file. */
const EM_DASH = String.fromCharCode(0x2014);

/** 2026-09-22 noon UTC, the day the fixtures were cut. */
const NOW = Date.UTC(2026, 8, 22, 12);

// ── The registry and the seed ────────────────────────────────────────────────

describe('registry and seed', () => {
  test('four adapters in law, one of them the old name, all keyed to the same ids', () => {
    const names = ADAPTERS.filter((a) => a.collection === 'law').map((a) => a.name);
    expect(names.sort()).toEqual([
      'courtlistener',
      'courtlistener-api',
      'courtlistener-catalog',
      'courtlistener-oral-arguments',
    ]);
    expect(
      ADAPTERS.filter((a) => a.name.startsWith('courtlistener') && a.collection !== 'law'),
    ).toEqual([]);
    expect(adapterByName('courtlistener').needsEnv).toBeUndefined();
    expect(adapterByName('courtlistener-oral-arguments').needsEnv).toBeUndefined();
    expect(adapterByName('courtlistener-api').needsEnv).toEqual(['courtlistenerToken']);
    expect(adapterByName('courtlistener-catalog').budgetMs).toBe(cat.BUDGET_MS);
  });

  test('the default sources, their cadences, and the API budget they spend', () => {
    const sources = ADAPTERS.filter((a) => a.collection === 'law').flatMap((a) =>
      a.defaultSources.map((s) => ({
        ...s,
        adapter: a.name,
        cadence: s.cadenceMinutes ?? a.cadenceMinutes,
      })),
    );
    const bySlug = Object.fromEntries(sources.map((s) => [s.slug, s]));
    expect(Object.keys(bySlug).sort()).toEqual([
      'courtlistener-catalog',
      'courtlistener-disclosures',
      'courtlistener-dockets',
      'courtlistener-judges',
      'courtlistener-opinions',
      'courtlistener-opinions-scotus',
      'courtlistener-oral-arguments',
    ]);
    expect(bySlug['courtlistener-opinions-scotus'].config).toEqual({ court: 'scotus' });
    // The all-courts source rotates through the courts' own feeds, so it runs often.
    expect(bySlug['courtlistener-opinions'].cadence).toBe(live.ALL_COURTS_CADENCE_MINUTES);
    expect(bySlug['courtlistener-opinions'].refresh).toBe(true);
    expect(bySlug['courtlistener-opinions-scotus'].cadence).toBe(30);
    expect(bySlug['courtlistener-oral-arguments'].cadence).toBe(60);
    expect(bySlug['courtlistener-dockets'].cadence).toBe(120);
    expect(bySlug['courtlistener-judges'].cadence).toBe(1440);
    expect(bySlug['courtlistener-disclosures'].cadence).toBe(1440);
    // One request a run, so requests a day is runs a day.
    const perDay = sources
      .filter((s) => s.adapter === 'courtlistener-api')
      .reduce((n, s) => n + (24 * 60) / s.cadence, 0);
    expect(perDay).toBe(live.DEFAULT_API_REQUESTS_PER_DAY);
    expect(perDay).toBeLessThanOrEqual(20);
    expect(perDay).toBeLessThan(live.DAILY_API_BUDGET / 5);
  });

  test('the law collection, its feeds, and filings no longer claiming opinions', () => {
    const law = COLLECTIONS.find((c) => c.slug === 'law');
    expect(law.name).toBe('Courts & case law');
    expect(law.description).toContain('CourtListener');
    expect(COLLECTIONS.find((c) => c.slug === 'filings').description).not.toContain('opinion');
    const feeds = DEFAULT_FEEDS.filter((f) => f.collection === 'law');
    expect(feeds.map((f) => f.slug)).toEqual([
      'court-opinions',
      'scotus-opinions',
      'precedential-opinions',
      'oral-arguments',
      'federal-dockets',
      'federal-judges',
      'judicial-financial-disclosures',
      'courts',
    ]);
    const q = Object.fromEntries(feeds.map((f) => [f.slug, f.query]));
    expect(q['court-opinions']).toEqual({ kinds: ['opinion'] });
    expect(q['scotus-opinions']).toEqual({ kinds: ['opinion'], tags: ['scotus'] });
    expect(q['precedential-opinions']).toEqual({ kinds: ['opinion'], tags: ['precedential'] });
    expect(q['federal-dockets']).toEqual({ kinds: ['docket'] });
    expect(q.courts).toEqual({ kinds: ['court'] });
    for (const f of feeds) expect(f.description ?? '').not.toContain(EM_DASH);
    expect(
      DEFAULT_FEEDS.filter((f) => f.collection === 'filings').flatMap((f) => f.query.sources),
    ).not.toContain('courtlistener-opinions');
  });

  test('no em dashes in the adapters', async () => {
    for (const name of ['courtlistener.js', 'courtlistener-catalog.js']) {
      const src = await readFile(
        new URL(`../packages/adapters/src/${name}`, import.meta.url),
        'utf8',
      );
      expect(src).not.toContain(EM_DASH);
    }
  });
});

// ── The feeds ────────────────────────────────────────────────────────────────

describe('feeds', () => {
  test('feedDate keeps the day the court wrote and drops one it could not have', () => {
    const day = (y, m, d) => new Date(Date.UTC(y, m - 1, d, 12));
    expect(live.feedDate('2026-09-22T00:00:00-07:00', NOW)).toEqual({
      publishedAt: day(2026, 9, 22),
      timeKnown: false,
      precision: 'day',
    });
    expect(live.feedDate('Mon, 21 Sep 2026 00:00:00 -0400', NOW).publishedAt).toEqual(
      day(2026, 9, 21),
    );
    expect(live.feedDate('2109-09-06T00:00:00-08:00', NOW).publishedAt).toBeNull();
    expect(live.feedDate('2026-10-20T00:00:00-07:00', NOW).publishedAt).toBeNull();
    expect(live.feedDate('2026-09-23T00:00:00-07:00', NOW).publishedAt).toEqual(day(2026, 9, 23));
    expect(live.feedDate('', NOW).publishedAt).toBeNull();
    expect(live.feedDate('not a date', NOW).publishedAt).toBeNull();
  });

  test('the opinion feed: cluster ids, the court, the status tags, a date of 2109 stored as none', async () => {
    const items = live.parseOpinionFeed(await fixture('courtlistener-opinions.atom'), { now: NOW });
    expect(items).toHaveLength(3);
    const guam = items[0];
    expect(guam.externalId).toBe('10929933');
    expect(guam.kind).toBe('opinion');
    expect(guam.title).toBe('People v. Chewek, I and Detor, M.');
    expect(guam.url).toBe(
      'https://www.courtlistener.com/opinion/10929933/people-v-chewek-i-and-detor-m/',
    );
    expect(guam.publishedAt).toBeNull();
    expect(guam.data.published).toBe('2109-09-06T00:00:00-08:00');
    expect(guam.data.court).toBe('Superior Court of Guam');
    expect(guam.data.pdf).toMatch(/^https:\/\/storage\.courtlistener\.com\/pdf\//);
    expect(guam.data.precedentialStatus).toBe('Unknown');
    expect(guam.tags).toEqual(['courtlistener']);
    expect(guam.summary).not.toContain('Original document');
    expect(guam.data.attribution).toBe(live.ATTRIBUTION);
    // The one a month ahead is undated too; the one from today keeps its day.
    expect(items[1].publishedAt).toBeNull();
    expect(items[2].publishedAt).toEqual(new Date(Date.UTC(2026, 8, 22, 12)));
    const published = items.find((i) => i.data.precedentialStatus === 'Published');
    expect(published.tags).toEqual(['courtlistener', 'published', 'precedential']);
    for (const i of items) {
      const n = normaliseItem(i);
      expect(n).not.toBeNull();
      expect(n.precision).toBe('day');
      expect(n.timeKnown).toBe(false);
    }
    // A per-court source tags its court.
    const scotus = live.parseOpinionFeed(await fixture('courtlistener-opinions.atom'), {
      court: 'scotus',
      now: NOW,
    });
    expect(scotus[0].tags).toContain('scotus');
    expect(scotus[0].data.courtId).toBe('scotus');
  });

  test('the podcast: audio ids, the MP3, its size and duration, the court and the day', async () => {
    const items = live.parseOralArgumentFeed(await fixture('courtlistener-podcast.xml'), {
      now: NOW,
    });
    expect(items).toHaveLength(2);
    const [a] = items;
    expect(a.externalId).toBe('106466');
    expect(a.kind).toBe('oral-argument');
    expect(a.title).toBe('United States v. Malakhov');
    expect(a.url).toBe(
      'https://www.courtlistener.com/audio/106466/united-states-of-america-v-malakhov/',
    );
    expect(a.summary).toBeNull(); // the description repeats the title
    expect(a.publishedAt).toEqual(new Date(Date.UTC(2026, 8, 21, 12)));
    expect(a.data).toMatchObject({
      court: 'Court of Appeals for the Second Circuit',
      mp3: 'https://storage.courtlistener.com/mp3/2026/09/21/united_states_v._malakhov_cl_3.mp3',
      mp3Bytes: 8448903,
      durationSeconds: 1388,
      attribution: live.ATTRIBUTION,
    });
    expect(a.tags).toEqual(['courtlistener']);
    expect(normaliseItem(a)).not.toBeNull();
  });

  test('URLs: all courts by default, one court by id, junk ignored', () => {
    expect(live.opinionFeedUrl()).toBe('https://www.courtlistener.com/feed/court/all/');
    expect(live.opinionFeedUrl('scotus')).toBe('https://www.courtlistener.com/feed/court/scotus/');
    expect(live.opinionFeedUrl(' CA9 ')).toBe('https://www.courtlistener.com/feed/court/ca9/');
    expect(live.opinionFeedUrl('../etc')).toBe('https://www.courtlistener.com/feed/court/all/');
    expect(live.podcastUrl('ca2')).toBe('https://www.courtlistener.com/podcast/court/ca2/');
    expect(live.statusTags('Published')).toEqual(['published', 'precedential']);
    expect(live.statusTags('Unpublished')).toEqual(['unpublished']);
    expect(live.statusTags('Unknown')).toEqual([]);
    expect(live.statusTags('')).toEqual([]);
  });
});

describe('all courts: the rotation through each court feed in turn', () => {
  test('the courts scraped for opinions, sorted; the rotation wraps', () => {
    const rows = [
      { id: 'nc', in_use: 't', has_opinion_scraper: 't' },
      { id: 'ca9', in_use: 't', has_opinion_scraper: 't' },
      { id: 'minnag', in_use: 't', has_opinion_scraper: 'f' },
      { id: 'old', in_use: 'f', has_opinion_scraper: 't' },
      { id: '../x', in_use: 't', has_opinion_scraper: 't' },
    ];
    expect(live.scrapedCourts(rows)).toEqual(['ca9', 'nc']);
    const courts = ['a', 'b', 'c', 'd', 'e'];
    expect(live.rotation(courts, undefined, 2)).toEqual({ picked: ['a', 'b'], next: 2 });
    expect(live.rotation(courts, 4, 3)).toEqual({ picked: ['e', 'a', 'b'], next: 2 });
    expect(live.rotation(courts, 12, 2)).toEqual({ picked: ['c', 'd'], next: 4 });
    // Asking for more than there are reads each once.
    expect(live.rotation(courts, 1, 9)).toEqual({ picked: ['b', 'c', 'd', 'e', 'a'], next: 1 });
    expect(live.rotation([], 3, 2)).toEqual({ picked: [], next: 0 });
  });

  /** A fake CourtListener: the all-courts feed, each court's feed, the bucket and the courts file. */
  function site({ fail = [] } = {}) {
    const calls = [];
    const atom = (court, id) =>
      `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Case ${id}</title><link href="https://www.courtlistener.com/opinion/${id}/case/"/><author><name>${court}</name></author><published>2026-09-22T00:00:00-07:00</published><category term="Published"/></entry></feed>`;
    const http = {
      async text(url) {
        calls.push(url);
        const m = url.match(/\/feed\/court\/([a-z0-9_-]+)\//);
        if (m) {
          if (fail.includes(m[1])) throw new Error('503');
          return atom(m[1], m[1] === 'all' ? 1 : 100 + calls.length);
        }
        return '<r><IsTruncated>false</IsTruncated><Contents><Key>bulk-data/courts-2026-06-30.csv.bz2</Key><Size>900</Size></Contents></r>';
      },
      async download(url, path) {
        calls.push(url);
        await writeFile(path, courtsFile);
        return { path, bytes: courtsFile.length, complete: true };
      },
    };
    return { http, calls };
  }
  let courtsFile;
  let dir;
  let savedDataDir;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nichedb-cl-courts-'));
    savedDataDir = config.ingest.dataDir;
    config.ingest.dataDir = dir;
    const plain = join(dir, 'courts.csv');
    await writeFile(
      plain,
      'id,in_use,has_opinion_scraper\n"nc","t","t"\n"ca9","t","t"\n"cal","t","t"\n"minnag","t","f"\n',
    );
    const proc = Bun.spawn(['bzip2', '-f', plain], { stderr: 'pipe' });
    expect(await proc.exited).toBe(0);
    courtsFile = await readFile(`${plain}.bz2`);
  });
  afterAll(async () => {
    config.ingest.dataDir = savedDataDir;
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const pullAll = (ctx) =>
    live.courtlistener.pull({
      config: { ...live.courtlistener.defaults, pauseMs: 0, ...(ctx.config ?? {}) },
      cursor: ctx.cursor ?? {},
      http: ctx.http,
      log: () => {},
      now: ctx.now ?? NOW,
    });

  test.skipIf(!Bun.which('bzip2'))(
    'a first run lists the courts from the dump, reads the all-courts feed and the next courts',
    async () => {
      const { http, calls } = site();
      const r = await pullAll({ http, config: { perRun: 2 } });
      expect(r.cursor).toEqual({
        courts: ['ca9', 'cal', 'nc'],
        listedAt: new Date(NOW).toISOString(),
        next: 2,
      });
      const feeds = calls.filter((u) => u.includes('/feed/court/'));
      expect(feeds).toEqual([
        'https://www.courtlistener.com/feed/court/all/',
        'https://www.courtlistener.com/feed/court/ca9/',
        'https://www.courtlistener.com/feed/court/cal/',
      ]);
      expect(r.items.map((i) => i.data.courtId)).toEqual([null, 'ca9', 'cal']);
      expect(r.items[1].tags).toContain('ca9');
      expect(r.note).toContain('2 courts (ca9 to cal)');

      // The next run keeps the list (a day has not passed) and carries on, wrapping.
      const { http: http2, calls: calls2 } = site();
      const r2 = await pullAll({ http: http2, config: { perRun: 2 }, cursor: r.cursor });
      expect(calls2.filter((u) => u.endsWith('.bz2') || u.includes('list-type'))).toEqual([]);
      expect(calls2.slice(1)).toEqual([
        'https://www.courtlistener.com/feed/court/nc/',
        'https://www.courtlistener.com/feed/court/ca9/',
      ]);
      expect(r2.cursor.next).toBe(1);
    },
  );

  test('a feed that fails is logged and skipped; only every feed failing fails the run', async () => {
    const cursor = { courts: ['ca9', 'nc'], listedAt: new Date(NOW).toISOString(), next: 0 };
    const some = await pullAll({ http: site({ fail: ['ca9'] }).http, cursor });
    expect(some.items).toHaveLength(2);
    expect(some.note).toContain('1 feed(s) failed');
    await expect(
      pullAll({ http: site({ fail: ['all', 'ca9', 'nc'] }).http, cursor }),
    ).rejects.toThrow(/every feed failed/);
  });

  test('one court by id, or `all` alone, reads one feed and keeps no rotation', async () => {
    for (const court of ['scotus', 'all']) {
      const { http, calls } = site();
      const r = await pullAll({ http, config: { court } });
      expect(calls).toEqual([`https://www.courtlistener.com/feed/court/${court}/`]);
      expect(r.cursor).toBeUndefined();
    }
    const { http, calls } = site();
    const off = await pullAll({ http, config: { perRun: 0 }, cursor: { next: 3 } });
    expect(calls).toEqual(['https://www.courtlistener.com/feed/court/all/']);
    expect(off.cursor).toEqual({ next: 3 });
  });
});

// ── The API ──────────────────────────────────────────────────────────────────

describe('API', () => {
  test('one request: newest first, twenty rows, and only what changed since the cursor', () => {
    expect(live.apiUrl('dockets')).toBe(
      'https://www.courtlistener.com/api/rest/v4/dockets/?order_by=-date_modified&page_size=20',
    );
    expect(live.apiUrl('people', { maxModified: '2026-09-22T00:30:08.200681-07:00' })).toBe(
      'https://www.courtlistener.com/api/rest/v4/people/?order_by=-date_modified&page_size=20&date_modified__gt=2026-09-22T00%3A30%3A08.200681-07%3A00',
    );
    expect(live.apiUrl('financial-disclosures', { maxModified: null })).toContain(
      '/financial-disclosures/?',
    );
  });

  test('the cursor is the newest instant, compared across offsets and kept verbatim', () => {
    const next = live.nextCursor({ maxModified: '2026-09-21T23:00:00-07:00' }, [
      { date_modified: '2026-09-22T00:30:08.200681-07:00' },
      { date_modified: '2026-09-22T08:00:00+01:00' }, // 07:00Z, before 07:30Z: earlier
      { date_modified: 'garbage' },
      {},
    ]);
    expect(next.maxModified).toBe('2026-09-22T00:30:08.200681-07:00');
    expect(typeof next.checkedAt).toBe('string');
    expect(
      live.nextCursor({ maxModified: '2026-09-23T00:00:00-07:00' }, [
        { date_modified: '2026-09-22T00:00:00-07:00' },
      ]).maxModified,
    ).toBe('2026-09-23T00:00:00-07:00');
    expect(live.nextCursor({}, []).maxModified).toBeNull();
  });

  const docket = {
    id: 74829702,
    court_id: 'ilnb',
    absolute_url: '/docket/74829702/basje-l-lewis/',
    date_modified: '2026-09-22T00:30:08.200681-07:00',
    source: 1,
    assigned_to_str: 'Dorothy Eisenberg',
    date_filed: '2026-09-22',
    date_terminated: null,
    case_name: 'Basje L Lewis',
    case_name_full: '',
    slug: 'basje-l-lewis',
    docket_number: '26-15664',
    pacer_case_id: '1646171',
    cause: '',
    nature_of_suit: '',
    blocked: false,
  };

  test('a docket row: the case with its number, the court as a tag, blocked ones left out', () => {
    const item = live.docketItem(docket);
    expect(item).toMatchObject({
      externalId: '74829702',
      kind: 'docket',
      title: 'Basje L Lewis (26-15664)',
      url: 'https://www.courtlistener.com/docket/74829702/basje-l-lewis/',
      tags: ['courtlistener', 'ilnb'],
      precision: 'day',
      timeKnown: false,
    });
    expect(item.publishedAt).toEqual(new Date(Date.UTC(2026, 8, 22, 12)));
    expect(item.data).toEqual({
      provider: 'courtlistener',
      court: 'ilnb',
      docketNumber: '26-15664',
      natureOfSuit: null,
      cause: null,
      dateFiled: '2026-09-22',
      dateTerminated: null,
      assignedTo: 'Dorothy Eisenberg',
      pacerCaseId: '1646171',
      source: 1,
      dateModified: '2026-09-22T00:30:08.200681-07:00',
      attribution: live.ATTRIBUTION,
    });
    expect(live.docketItem({ ...docket, blocked: true })).toBeNull();
    expect(live.docketItem({ ...docket, absolute_url: null }).url).toBe(
      'https://www.courtlistener.com/docket/74829702/basje-l-lewis/',
    );
    expect(normaliseItem(item)).not.toBeNull();
  });

  test('a person row: the name assembled, the page built from id and slug, aliases left out', () => {
    const person = {
      id: 14468,
      is_alias_of: null,
      slug: 'mark-christopher-scarsi',
      name_first: 'Mark',
      name_middle: 'Christopher',
      name_last: 'Scarsi',
      name_suffix: '',
      date_dob: '1964-01-01',
      dob_city: 'Syracuse',
      dob_state: 'NY',
      dob_country: 'United States',
      gender: 'm',
      has_photo: false,
      date_modified: '2026-06-24T10:55:24.258243-07:00',
    };
    const item = live.judgeItem(person);
    expect(item).toMatchObject({
      externalId: '14468',
      kind: 'judge',
      title: 'Mark Christopher Scarsi',
      url: 'https://www.courtlistener.com/person/14468/mark-christopher-scarsi/',
      tags: ['courtlistener', 'judge'],
    });
    expect(item.data.birthplace).toBe('Syracuse, NY, United States');
    expect(
      live.judgeItem({
        ...person,
        is_alias_of: 'https://www.courtlistener.com/api/rest/v4/people/1/',
      }),
    ).toBeNull();
    expect(
      live.personName({
        name_first: 'Robert',
        name_middle: 'P.',
        name_last: 'Young',
        name_suffix: 'jr',
      }),
    ).toBe('Robert P. Young jr');
    expect(normaliseItem(item)).not.toBeNull();
  });

  test('a disclosure row: the person off its URL, the year as the date, the PDF as the link', () => {
    const item = live.disclosureItem({
      id: 32190,
      person: 'https://www.courtlistener.com/api/rest/v4/people/338/',
      filepath:
        'https://storage.courtlistener.com/us/federal/judicial/financial-disclosures/338/richard-franklin-boulware-ii-disclosure.2019.pdf',
      thumbnail:
        'https://storage.courtlistener.com/us/federal/judicial/financial-disclosures/338/x.png',
      year: 2019,
      page_count: 7,
      report_type: -1,
      is_amended: false,
      sha1: 'befbe774dab5b55366140b64364bd5103ca8b986',
      date_modified: '2024-11-14T23:46:19.228654-08:00',
    });
    expect(item).toMatchObject({
      externalId: '32190',
      kind: 'financial-disclosure',
      title: 'Financial disclosure 2019 (person 338)',
      url: 'https://storage.courtlistener.com/us/federal/judicial/financial-disclosures/338/richard-franklin-boulware-ii-disclosure.2019.pdf',
      precision: 'year',
    });
    expect(item.publishedAt).toEqual(new Date(Date.UTC(2019, 6, 1, 12)));
    expect(item.data).toMatchObject({
      year: 2019,
      pageCount: 7,
      personId: '338',
      isAmended: false,
    });
    expect(normaliseItem(item)).not.toBeNull();
  });

  test('pull: one request with the token, the cursor moved, and no token is an error', async () => {
    const calls = [];
    const http = {
      async json(url, opts) {
        calls.push({ url, auth: opts.headers.authorization, ua: opts.headers['user-agent'] });
        return {
          count: 'x',
          next: 'y',
          results: [
            docket,
            { ...docket, id: 2, blocked: true, date_modified: '2026-09-22T01:00:00-07:00' },
          ],
        };
      },
    };
    const res = await live.courtlistenerApi.pull({
      config: { resource: 'dockets' },
      cursor: { maxModified: '2026-09-21T00:00:00-07:00' },
      env: { courtlistenerToken: 'secret' },
      http,
      log: () => {},
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].auth).toBe('Token secret');
    expect(calls[0].ua).toBe(live.USER_AGENT);
    expect(calls[0].url).toContain('date_modified__gt=2026-09-21T00%3A00%3A00-07%3A00');
    expect(res.items).toHaveLength(1);
    expect(res.cursor.maxModified).toBe('2026-09-22T01:00:00-07:00');
    expect(res.note).toContain('1 request');
    await expect(
      live.courtlistenerApi.pull({ config: {}, cursor: {}, env: {}, http, log: () => {} }),
    ).rejects.toThrow(/COURTLISTENER_TOKEN/);
    expect(calls).toHaveLength(1);
  });
});

// ── The catalogue: listing, cursor, rows ─────────────────────────────────────

const HEADERS = {
  courts:
    'id,pacer_court_id,pacer_has_rss_feed,pacer_rss_entry_types,date_last_pacer_contact,fjc_court_id,date_modified,in_use,has_opinion_scraper,has_oral_argument_scraper,position,citation_string,short_name,full_name,url,start_date,end_date,jurisdiction,notes,parent_court_id',
  'people-db-people':
    'id,date_created,date_modified,date_completed,fjc_id,slug,name_first,name_middle,name_last,name_suffix,date_dob,date_granularity_dob,date_dod,date_granularity_dod,dob_city,dob_state,dob_country,dod_city,dod_state,dod_country,gender,religion,ftm_total_received,ftm_eid,has_photo,is_alias_of_id',
  'people-db-positions':
    'id,date_created,date_modified,position_type,job_title,sector,organization_name,location_city,location_state,date_nominated,date_elected,date_recess_appointment,date_referred_to_judicial_committee,date_judicial_committee_action,judicial_committee_action,date_hearing,date_confirmation,date_start,date_granularity_start,date_termination,termination_reason,date_granularity_termination,date_retirement,nomination_process,vote_type,voice_vote,votes_yes,votes_no,votes_yes_percent,votes_no_percent,how_selected,has_inferred_values,appointer_id,court_id,person_id,predecessor_id,school_id,supervisor_id',
  'financial-disclosures':
    'id,date_created,date_modified,year,download_filepath,filepath,thumbnail,thumbnail_status,page_count,sha1,report_type,is_amended,addendum_content_raw,addendum_redacted,has_been_extracted,person_id',
  'oral-arguments':
    'id,date_created,date_modified,source,case_name_short,case_name,case_name_full,judges,sha1,download_url,local_path_mp3,local_path_original_file,filepath_ia,ia_upload_failure_count,duration,processing_complete,date_blocked,blocked,stt_status,stt_transcript,stt_source,docket_id',
  'opinion-clusters':
    'id,date_created,date_modified,judges,date_filed,date_filed_is_approximate,slug,case_name_short,case_name,case_name_full,scdb_id,scdb_decision_direction,scdb_votes_majority,scdb_votes_minority,source,procedural_history,attorneys,nature_of_suit,posture,syllabus,headnotes,summary,disposition,history,other_dates,cross_reference,correction,citation_count,precedential_status,date_blocked,blocked,filepath_json_harvard,filepath_pdf_harvard,docket_id,arguments,headmatter',
  dockets:
    'id,date_created,date_modified,source,appeal_from_str,assigned_to_str,referred_to_str,panel_str,date_last_index,date_cert_granted,date_cert_denied,date_argued,date_reargued,date_reargument_denied,date_filed,date_terminated,date_last_filing,case_name_short,case_name,case_name_full,slug,docket_number,docket_number_core,pacer_case_id,cause,nature_of_suit,jury_demand,jurisdiction_type,appellate_fee_status,appellate_case_type_information,mdl_status,filepath_local,filepath_ia,filepath_ia_json,ia_upload_failure_count,ia_needs_upload,ia_date_first_change,view_count,date_blocked,blocked,appeal_from_id,assigned_to_id,court_id,idb_data_id,originating_court_information_id,referred_to_id,federal_dn_case_type,federal_dn_office_code,federal_dn_judge_initials_assigned,federal_dn_judge_initials_referred,federal_defendant_number,parent_docket_id,docket_number_raw,docket_number_source',
  'fjc-integrated-database':
    'id,date_created,date_modified,dataset_source,office,docket_number,origin,date_filed,jurisdiction,nature_of_suit,title,section,subsection,diversity_of_residence,class_action,monetary_demand,county_of_residence,arbitration_at_filing,arbitration_at_termination,multidistrict_litigation_docket_number,plaintiff,defendant,date_transfer,transfer_office,transfer_docket_number,transfer_origin,date_terminated,termination_class_action_status,procedural_progress,disposition,nature_of_judgement,amount_received,judgment,pro_se,year_of_tape,nature_of_offense,version,circuit_id,district_id',
  citations: 'id,volume,reporter,page,type,cluster_id,date_created,date_modified',
  'people-db-schools': 'id,date_created,date_modified,name,ein,is_alias_of_id',
  'people-db-educations':
    'id,date_created,date_modified,degree_level,degree_detail,degree_year,person_id,school_id',
  'people-db-political-affiliations':
    'id,date_created,date_modified,political_party,source,date_start,date_granularity_start,date_end,date_granularity_end,person_id',
  'financial-disclosure-investments':
    'id,date_created,date_modified,page_number,description,redacted,income_during_reporting_period_code,income_during_reporting_period_type,gross_value_code,gross_value_method,transaction_during_reporting_period,transaction_date_raw,transaction_date,transaction_value_code,transaction_gain_code,transaction_partner,has_inferred_values,financial_disclosure_id',
  'financial-disclosures-gifts':
    'id,date_created,date_modified,source,description,value,redacted,financial_disclosure_id',
  'financial-disclosures-debts':
    'id,date_created,date_modified,creditor_name,description,value_code,redacted,financial_disclosure_id',
  'financial-disclosures-positions':
    'id,date_created,date_modified,position,organization_name,redacted,financial_disclosure_id',
  'financial-disclosures-agreements':
    'id,date_created,date_modified,date_raw,parties_and_terms,redacted,financial_disclosure_id',
  'financial-disclosures-reimbursements':
    'id,date_created,date_modified,source,date_raw,location,purpose,items_paid_or_provided,redacted,financial_disclosure_id',
  'financial-disclosures-spousal-income':
    'id,date_created,date_modified,source_type,date_raw,redacted,financial_disclosure_id',
  'financial-disclosures-non-investment-income':
    'id,date_created,date_modified,date_raw,source_type,income_amount,redacted,financial_disclosure_id',
};

/** A row object with every column of the table null except the ones given. */
function rowOf(table, values) {
  const row = {};
  for (const h of HEADERS[table].split(',')) row[h] = null;
  return { ...row, ...values };
}

const ROWS = {
  courts: [
    rowOf('courts', {
      id: 'nc',
      date_modified: '2016-09-08 20:38:41.131652+00',
      in_use: 't',
      has_opinion_scraper: 't',
      has_oral_argument_scraper: 'f',
      position: '366.97',
      citation_string: 'N.C.',
      short_name: 'Supreme Court of North Carolina',
      full_name: 'Supreme Court of North Carolina',
      url: 'http://www.nccourts.org/courts/appellate/supreme/',
      start_date: '1799-01-01',
      jurisdiction: 'S',
      notes: 'Created by Lawbox\nStart date: http://example.org',
      pacer_rss_entry_types: '',
    }),
    rowOf('courts', {
      id: 'minnag',
      date_modified: '2017-02-01 17:56:35.255825+00',
      in_use: 't',
      short_name: "Minn. Att'y Gen.",
      full_name: 'Minnesota Attorney General Reports',
      jurisdiction: 'SAG',
      parent_court_id: 'minn',
    }),
  ],
  'people-db-people': [
    rowOf('people-db-people', {
      id: '2749',
      date_modified: '2020-11-25 16:30:20.6966+00',
      fjc_id: '2031',
      slug: 'spottswood-william-robinson-iii',
      name_first: 'Spottswood',
      name_middle: 'William',
      name_last: 'Robinson',
      name_suffix: '3',
      date_dob: '1916-07-26',
      date_granularity_dob: '%Y-%m-%d',
      date_dod: '1998-10-11',
      dob_city: 'Richmond',
      dob_state: 'VA',
      dob_country: 'United States',
      gender: 'm',
      has_photo: 't',
    }),
    rowOf('people-db-people', {
      id: '7607',
      date_modified: '2018-06-27 21:22:40.185313+00',
      slug: 'robert-p-young-jr',
      name_first: 'Robert',
      name_middle: 'P.',
      name_last: 'Young',
      name_suffix: 'jr',
      has_photo: 'f',
      is_alias_of_id: '4803',
    }),
  ],
  'people-db-positions': [
    rowOf('people-db-positions', {
      id: '172',
      date_modified: '2016-04-20 15:15:55.6036+00',
      position_type: 'jud',
      job_title: '',
      court_id: 'cadc',
      date_start: '1966-10-06',
      date_termination: '1998-10-11',
      appointer_id: '3355',
      how_selected: 'a_pres',
      person_id: '2749',
    }),
    rowOf('people-db-positions', {
      id: '173',
      date_modified: '2016-04-20 15:15:55.612603+00',
      job_title: 'Private practice',
      organization_name: '',
      location_city: 'Richmond',
      date_start: '1943-01-01',
      date_granularity_start: '%Y',
      date_termination: '1966-01-01',
      person_id: '2749',
    }),
  ],
  'financial-disclosures': [
    rowOf('financial-disclosures', {
      id: '1108',
      date_modified: '2021-01-04 03:23:52.327643+00',
      year: '2009',
      download_filepath:
        'https://example.org/Harry S Mattice Financial Disclosure Report for 2009.pdf',
      filepath:
        'us/federal/judicial/financial-disclosures/2084/harry-sandlin-mattice-jr-disclosure.2009.pdf',
      thumbnail: 'us/federal/judicial/financial-disclosures/2084/x-thumbnail_1.png',
      page_count: '7',
      sha1: '329210df4a94fa23ed0423f64220deca8a7a0a3e',
      report_type: '-1',
      is_amended: 'f',
      addendum_content_raw: 'Par III. A, "Non-Investment Income".\nTrust Assets',
      person_id: '2084',
    }),
  ],
  'oral-arguments': [
    rowOf('oral-arguments', {
      id: '17',
      date_created: '2014-10-31 02:33:10.810318+00',
      date_modified: '2024-06-25 04:29:12.146483+00',
      source: 'C',
      case_name_short: 'Ayala',
      case_name: 'Ayala v. Shinseki',
      case_name_full: '',
      judges: '',
      sha1: '898f21803ba8c5eea92aba5072e1d3c8a3714b96',
      download_url: 'http://www.ca1.uscourts.gov/files/audio/13-2260.mp3',
      local_path_mp3: 'mp3/2014/10/28/ayala_v._shinseki_cl.mp3',
      duration: '879',
      blocked: 'f',
      docket_id: '4272451',
    }),
    rowOf('oral-arguments', {
      id: '18',
      date_modified: '2024-06-25 04:29:12.146483+00',
      case_name: 'Sealed v. Sealed',
      local_path_mp3: 'mp3/2014/10/28/sealed.mp3',
      blocked: 't',
    }),
  ],
  'opinion-clusters': [
    rowOf('opinion-clusters', {
      id: '7290305',
      date_modified: '2024-11-05 19:51:49.079046+00',
      judges: '',
      date_filed: '2002-06-06',
      date_filed_is_approximate: 'f',
      slug: 'lawless-v-muskingum-county',
      case_name_short: 'Lawless',
      case_name: 'Lawless v. Muskingum County',
      case_name_full: 'Robert J. LAWLESS v. MUSKINGUM COUNTY, OHIO',
      scdb_id: '',
      source: 'U',
      attorneys: 'Latham Castle, for appellant.',
      syllabus: `Held: ${'the court said so. '.repeat(60)}`,
      citation_count: '2',
      precedential_status: 'Published',
      blocked: 'f',
      docket_id: '64278691',
    }),
    rowOf('opinion-clusters', {
      id: '108713',
      date_modified: '2024-11-08 17:44:17.193082+00',
      judges: 'Warren',
      date_filed: '1954-05-17',
      date_filed_is_approximate: 't',
      slug: 'brown-v-board-of-education',
      case_name: 'Brown v. Board of Education',
      scdb_id: '1953-081',
      scdb_decision_direction: '2',
      source: 'LR',
      summary: 'Separate is not equal.',
      citation_count: '9000',
      precedential_status: 'Published',
      blocked: 'f',
      docket_id: '1',
    }),
    rowOf('opinion-clusters', {
      id: '1',
      date_modified: '2024-11-08 17:44:17.193082+00',
      case_name: 'Hidden',
      precedential_status: 'Unknown',
      blocked: 't',
    }),
  ],
  dockets: [
    rowOf('dockets', {
      id: '29439169',
      date_modified: '2021-01-19 07:30:57.748622+00',
      source: '1',
      assigned_to_str: 'Dorothy Eisenberg',
      date_filed: '1998-07-31',
      date_terminated: '1998-10-15',
      case_name_short: 'Huaranca',
      case_name: 'Huaranca v. Internal Revenue Service',
      slug: 'huaranca-v-internal-revenue-service',
      docket_number: '8-98-08457',
      pacer_case_id: '80578',
      cause: '',
      nature_of_suit: '',
      blocked: 'f',
      court_id: 'nyeb',
    }),
  ],
  'fjc-integrated-database': [
    rowOf('fjc-integrated-database', {
      id: '17442742',
      date_modified: '2022-01-26 22:02:36.499814+00',
      dataset_source: '9',
      office: '2',
      docket_number: '8907217',
      origin: '1',
      date_filed: '1989-10-05',
      jurisdiction: '4',
      nature_of_suit: '190',
      monetary_demand: '75',
      plaintiff: 'A.T. CHADWICK CO., INC.',
      defendant: 'DEZCON CONTRACTORS, INC.',
      date_terminated: '1989-11-15',
      disposition: '4',
      amount_received: '75',
      judgment: '1',
      circuit_id: 'ca3',
      district_id: 'paed',
    }),
  ],
  // Cut from the 2026-06-30 dump; Brown carries two cites, one row has no reporter.
  citations: [
    rowOf('citations', {
      id: '1',
      volume: '347',
      reporter: 'U.S.',
      page: '483',
      type: '1',
      cluster_id: '108713',
      date_modified: '2022-03-01 00:00:00.000000+00',
    }),
    rowOf('citations', {
      id: '2',
      volume: '74',
      reporter: 'S. Ct.',
      page: '686',
      type: '3',
      cluster_id: '108713',
      date_modified: '2022-03-01 00:00:00.000000+00',
    }),
    rowOf('citations', {
      id: '3',
      volume: '2002',
      reporter: 'Ohio',
      page: '2851',
      type: '8',
      cluster_id: '7290305',
      date_modified: '2022-03-01 00:00:00.000000+00',
    }),
    rowOf('citations', { id: '4', volume: '1', reporter: '', page: '1', cluster_id: '9' }),
  ],
  'people-db-schools': [
    rowOf('people-db-schools', { id: '4697', name: 'Howard University', ein: '530204707' }),
  ],
  'people-db-educations': [
    rowOf('people-db-educations', {
      id: '1',
      degree_level: 'llb',
      degree_detail: 'LL.B.',
      degree_year: '1939',
      person_id: '2749',
      school_id: '4697',
    }),
  ],
  'people-db-political-affiliations': [
    rowOf('people-db-political-affiliations', {
      id: '1',
      political_party: 'd',
      source: 'a',
      person_id: '2749',
    }),
  ],
  'financial-disclosure-investments': [
    rowOf('financial-disclosure-investments', {
      id: '4558608',
      date_modified: '2021-01-04 00:00:00.000000+00',
      description: 'Fidelity Cash Reserves',
      redacted: 'f',
      income_during_reporting_period_code: 'A',
      income_during_reporting_period_type: 'Int/Div',
      gross_value_code: 'K',
      financial_disclosure_id: '1108',
    }),
    rowOf('financial-disclosure-investments', {
      id: '4558609',
      date_modified: '2021-01-04 00:00:00.000000+00',
      description: '',
      redacted: 't',
      financial_disclosure_id: '1108',
    }),
  ],
  'financial-disclosures-gifts': [
    rowOf('financial-disclosures-gifts', {
      id: '11',
      source: 'Bar Association',
      description: 'Books',
      redacted: 'f',
      financial_disclosure_id: '1108',
    }),
  ],
  'financial-disclosures-debts': [
    rowOf('financial-disclosures-debts', {
      id: '20',
      creditor_name: 'Goldman, Sachs',
      description: 'Margin Account',
      value_code: 'J',
      redacted: 'f',
      financial_disclosure_id: '1108',
    }),
  ],
  'financial-disclosures-positions': [
    rowOf('financial-disclosures-positions', {
      id: '19',
      position: 'Trustee',
      organization_name: 'Family Trust',
      redacted: 'f',
      financial_disclosure_id: '1108',
    }),
  ],
  'financial-disclosures-agreements': [],
  'financial-disclosures-reimbursements': [],
  'financial-disclosures-spousal-income': [],
  'financial-disclosures-non-investment-income': [
    rowOf('financial-disclosures-non-investment-income', {
      id: '9',
      date_raw: '2009',
      source_type: 'Law school, adjunct teaching',
      income_amount: '$10,000.00',
      redacted: 'f',
      financial_disclosure_id: '1108',
    }),
  ],
};

describe('catalogue: listing and cursor', () => {
  test('the S3 listing: keys with sizes, and the newest date with every table in it', async () => {
    const page = cat.parseListing(await fixture('courtlistener-s3-listing.xml'));
    expect(page.truncated).toBe(false);
    expect(page.next).toBeNull();
    expect(page.entries).toHaveLength(19);
    expect(page.entries.find((e) => e.key === 'bulk-data/courts-2026-06-30.csv.bz2').size).toBe(
      81180,
    );
    // 2026-09-30 lists courts, people and disclosures but an empty clusters
    // file and no oral arguments or positions yet: not a dump, so June wins.
    const before = [...cat.LEGACY_FILES.slice(0, 5), 'people-db-positions'];
    expect(cat.newestCompleteDate(page.entries, before)).toBe('2026-06-30');
    // The fixture listing predates the tables the walk has since taken on.
    expect(cat.newestCompleteDate(page.entries, cat.neededFiles({}))).toBeNull();
    expect(cat.newestCompleteDate(page.entries, ['courts'])).toBe('2026-09-30');
    expect(cat.newestCompleteDate(page.entries, ['courts', 'opinion-clusters'])).toBe('2026-06-30');
    expect(cat.newestCompleteDate(page.entries, [...before, 'dockets'])).toBe('2026-06-30');
    expect(cat.newestCompleteDate(page.entries, [...before, 'fjc-integrated-database'])).toBeNull();
    expect(cat.newestCompleteDate([], ['courts'])).toBeNull();
  });

  test('a truncated listing page carries its continuation token, decoded', () => {
    const xml =
      '<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>1BGs+tQ&amp;x</NextContinuationToken><Contents><Key>bulk-data/courts-2026-06-30.csv.bz2</Key><Size>100</Size></Contents></ListBucketResult>';
    const page = cat.parseListing(xml);
    expect(page.truncated).toBe(true);
    expect(page.next).toBe('1BGs+tQ&x');
    expect(cat.listingUrl(page.next)).toContain('continuation-token=1BGs%2BtQ%26x');
    expect(cat.listingUrl()).toBe(
      'https://com-courtlistener-storage.s3-us-west-2.amazonaws.com/?list-type=2&prefix=bulk-data%2F&max-keys=1000',
    );
    expect(cat.parseKey('bulk-data/people-db-people-2026-06-30.csv.bz2')).toEqual({
      table: 'people-db-people',
      date: '2026-06-30',
    });
    expect(cat.parseKey('bulk-data/load-bulk-data-2026-06-30.sh')).toBeNull();
    expect(cat.parseKey('bulk-data/schema-2024-08-15.sql')).toBeNull();
  });

  test('resolveVersion follows the pages and stops at the first that says it is last', async () => {
    const calls = [];
    const http = {
      async text(url) {
        calls.push(url);
        if (calls.length === 1) {
          return '<r><IsTruncated>true</IsTruncated><NextContinuationToken>tok</NextContinuationToken><Contents><Key>bulk-data/courts-2026-06-30.csv.bz2</Key><Size>100</Size></Contents></r>';
        }
        return '<r><IsTruncated>false</IsTruncated><Contents><Key>bulk-data/people-db-positions-2026-06-30.csv.bz2</Key><Size>100</Size></Contents></r>';
      },
    };
    expect(await cat.resolveVersion(http, ['courts', 'people-db-positions'])).toBe('2026-06-30');
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('continuation-token=tok');
    await expect(cat.resolveVersion(http, ['courts', 'dockets'])).rejects.toThrow(/no date/);
  });

  test('files: six always, the FJC on by default, dockets by config, side files always needed', () => {
    expect(cat.filesFor({})).toEqual(cat.FILES);
    expect(cat.filesFor({ dockets: 'false', fjc: false })).toEqual(cat.FILES);
    expect(cat.filesFor({ dockets: 'true' })).toEqual([...cat.FILES, 'dockets']);
    expect(cat.filesFor({ dockets: true, fjc: '1' })).toEqual([
      ...cat.FILES,
      'fjc-integrated-database',
      'dockets',
    ]);
    expect(cat.filesFor(cat.courtlistenerCatalog.defaults)).toEqual([
      ...cat.FILES,
      'fjc-integrated-database',
    ]);
    expect(cat.neededFiles({})).toEqual([...cat.FILES, ...cat.SIDE_FILES]);
    // Citations patch the clusters, so they come after them.
    expect(cat.FILES.indexOf('citations')).toBe(cat.FILES.indexOf('opinion-clusters') + 1);
    expect(cat.fileUrl('courts', '2026-06-30')).toBe(
      'https://com-courtlistener-storage.s3-us-west-2.amazonaws.com/bulk-data/courts-2026-06-30.csv.bz2',
    );
    expect(
      cat.staleFiles(
        ['courts-2026-03-31.csv.bz2', 'courts-2026-06-30.csv.bz2', 'other.txt'],
        '2026-06-30',
      ),
    ).toEqual(['courts-2026-03-31.csv.bz2']);
  });

  test('the cursor: where to resume, and what is stale on a second pass', () => {
    expect(cat.resumeFrom(undefined)).toEqual({
      version: null,
      walked: [],
      file: 'courts',
      record: 0,
      modifiedWatermark: null,
      maxModified: null,
      done: false,
    });
    expect(
      cat.resumeFrom({
        version: '2026-06-30',
        file: 'opinion-clusters',
        record: 12000,
        done: false,
      }),
    ).toMatchObject({
      version: '2026-06-30',
      // A cursor from before the id scheme: of the tables before its file,
      // only the courts keep their rows; the re-keyed three are walked again.
      walked: ['courts'],
      file: 'opinion-clusters',
      record: 12000,
      done: false,
    });
    // A cursor in a table that was turned off starts the first table not walked.
    expect(
      cat.resumeFrom({ version: '2026-06-30', file: 'dockets', record: 500 }, cat.FILES),
    ).toMatchObject({
      walked: ['courts', 'opinion-clusters'],
      file: 'people-db-people',
      record: 0,
    });
    expect(
      cat.resumeFrom(
        { version: '2026-06-30', file: 'dockets', record: 500 },
        cat.filesFor({ dockets: 'true' }),
      ),
    ).toMatchObject({
      file: 'dockets',
      record: 500,
    });
    expect(cat.resumeFrom({ version: 'june', done: true }).done).toBe(false);
    // A pass completed before the id scheme is not complete now, and its
    // watermark goes: the re-keyed tables must be walked whole.
    expect(
      cat.resumeFrom({
        version: '2026-06-30',
        done: true,
        modifiedWatermark: '2026-06-01 00:00:00+00',
      }),
    ).toMatchObject({
      walked: ['courts', 'opinion-clusters'],
      file: 'people-db-people',
      done: false,
      modifiedWatermark: null,
    });
    const complete = {
      idScheme: cat.ID_SCHEME,
      version: '2026-06-30',
      walked: cat.FILES,
      done: true,
      modifiedWatermark: '2026-06-01 00:00:00+00',
    };
    expect(cat.resumeFrom(complete)).toMatchObject({
      file: null,
      done: true,
      modifiedWatermark: '2026-06-01 00:00:00+00',
    });
    // A table turned on after a pass completed is walked on its own.
    expect(cat.resumeFrom(complete, cat.filesFor({ fjc: 'true' }))).toMatchObject({
      walked: cat.FILES,
      file: 'fjc-integrated-database',
      record: 0,
      done: false,
    });
    expect(cat.isStale('2024-11-05 19:51:49.079046+00', '2026-06-01 00:00:00+00')).toBe(true);
    expect(cat.isStale('2026-06-02 00:00:00+00', '2026-06-01 00:00:00+00')).toBe(false);
    expect(cat.isStale('2024-11-05 19:51:49.079046+00', null)).toBe(false);
    expect(cat.isStale(null, '2026-06-01 00:00:00+00')).toBe(false);
  });
});

describe('catalogue: rows', () => {
  test('a court', () => {
    const [nc, ag] = ROWS.courts.map(cat.courtItem);
    expect(nc).toMatchObject({
      externalId: 'nc',
      kind: 'court',
      title: 'Supreme Court of North Carolina',
      url: 'http://www.nccourts.org/courts/appellate/supreme/',
      tags: ['courtlistener', 'court', 'jurisdiction:s'],
    });
    expect(nc.data).toMatchObject({
      courtId: 'nc',
      citationString: 'N.C.',
      jurisdiction: 'S',
      startDate: '1799-01-01',
      endDate: null,
      inUse: true,
      hasOpinionScraper: true,
      hasOralArgumentScraper: false,
      parentCourtId: null,
      pacerCourtId: null,
      position: 366.97,
      attribution: live.ATTRIBUTION,
    });
    expect(ag.url).toBe('https://www.courtlistener.com/?court=minnag');
    expect(ag.data.parentCourtId).toBe('minn');
    expect(cat.courtItem(rowOf('courts', { id: 'x' }))).toBeNull();
    expect(normaliseItem(nc)).not.toBeNull();
  });

  test('a judge with their positions joined, an alias left out', async () => {
    const positions = new Map([['2749', ROWS['people-db-positions'].map(cat.positionOf)]]);
    const [robinson, alias] = ROWS['people-db-people'].map((r) => cat.judgeItem(r, positions));
    expect(alias).toBeNull();
    expect(robinson).toMatchObject({
      externalId: 'judge:2749',
      kind: 'judge',
      title: 'Spottswood William Robinson 3',
      url: 'https://www.courtlistener.com/person/2749/spottswood-william-robinson-iii/',
      tags: ['courtlistener', 'judge', 'cadc'],
    });
    expect(robinson.summary).toBe('jud, cadc (1966 to 1998); Private practice (1943 to 1966)');
    expect(robinson.data.positions).toEqual([
      {
        type: 'jud',
        jobTitle: null,
        organization: null,
        courtId: 'cadc',
        dateStart: '1966-10-06',
        dateTermination: '1998-10-11',
        appointerId: '3355',
        howSelected: 'a_pres',
      },
      {
        type: null,
        jobTitle: 'Private practice',
        organization: null,
        courtId: null,
        dateStart: '1943-01-01',
        dateTermination: '1966-01-01',
        appointerId: null,
        howSelected: null,
      },
    ]);
    expect(robinson.data).toMatchObject({
      fjcId: 2031,
      dateOfBirth: '1916-07-26',
      dateOfDeath: '1998-10-11',
      birthplace: 'Richmond, VA, United States',
      gender: 'm',
      hasPhoto: true,
    });
    // Without the positions file loaded a judge still has a row.
    expect(cat.judgeItem(ROWS['people-db-people'][0]).data.positions).toEqual([]);
    expect(normaliseItem(robinson)).not.toBeNull();
  });

  test('a financial disclosure, titled by the judge when the people file is loaded', () => {
    const row = ROWS['financial-disclosures'][0];
    const named = cat.disclosureItem(row, new Map([['2084', 'Harry Sandlin Mattice Jr.']]));
    expect(named).toMatchObject({
      externalId: 'disclosure:1108',
      summary: null,
      kind: 'financial-disclosure',
      title: 'Harry Sandlin Mattice Jr. financial disclosure 2009',
      url: 'https://storage.courtlistener.com/us/federal/judicial/financial-disclosures/2084/harry-sandlin-mattice-jr-disclosure.2009.pdf',
      imageUrl:
        'https://storage.courtlistener.com/us/federal/judicial/financial-disclosures/2084/x-thumbnail_1.png',
      precision: 'year',
    });
    expect(named.publishedAt).toEqual(new Date(Date.UTC(2009, 6, 1, 12)));
    expect(named.data).toMatchObject({
      year: 2009,
      reportType: '-1',
      isAmended: false,
      pageCount: 7,
      personId: '2084',
      personName: 'Harry Sandlin Mattice Jr.',
    });
    const anon = cat.disclosureItem(row);
    expect(anon.title).toBe('Financial disclosure 2009 (person 2084)');
    expect(cat.disclosureItem(rowOf('financial-disclosures', { ...row, filepath: '' })).url).toBe(
      row.download_filepath,
    );
    expect(normaliseItem(named)).not.toBeNull();
  });

  test('a judge with education and party, summarised and tagged', () => {
    const positions = new Map([['2749', ROWS['people-db-positions'].map(cat.positionOf)]]);
    const schools = new Map([['4697', 'Howard University']]);
    const educations = new Map([
      ['2749', ROWS['people-db-educations'].map((r) => cat.educationOf(r, schools))],
    ]);
    const affiliations = new Map([
      ['2749', ROWS['people-db-political-affiliations'].map(cat.affiliationOf)],
    ]);
    const judge = cat.judgeItem(ROWS['people-db-people'][0], positions, {
      educations,
      affiliations,
    });
    expect(judge.summary).toBe(
      'jud, cadc (1966 to 1998); Private practice (1943 to 1966). Education: Howard University (LL.B., 1939)',
    );
    expect(judge.tags).toEqual(['courtlistener', 'judge', 'party:democratic', 'cadc']);
    expect(judge.data.politicalAffiliations).toEqual([
      { party: 'Democratic', source: 'a', dateStart: null, dateEnd: null },
    ]);
    expect(cat.affiliationOf({ political_party: 'q' }).party).toBe('q');
    expect(cat.educationOf({ school_id: '1' }).school).toBeNull();
  });

  test('a disclosure with what the report says; redacted rows counted, never quoted', () => {
    const detail = new Map([
      [
        '1108',
        {
          investments: {
            count: 2,
            items: ROWS['financial-disclosure-investments'].map((r) =>
              cat.detailOf('investments', r),
            ),
          },
          positions: {
            count: 1,
            items: ROWS['financial-disclosures-positions'].map((r) => cat.detailOf('positions', r)),
          },
        },
      ],
    ]);
    const item = cat.disclosureItem(ROWS['financial-disclosures'][0], new Map(), detail);
    expect(item.summary).toBe(
      'Positions (1): Trustee, Family Trust; Investments (2): Fidelity Cash Reserves',
    );
    expect(item.data.investments[0]).toEqual({
      description: 'Fidelity Cash Reserves',
      incomeCode: 'A',
      incomeType: 'Int/Div',
      grossValueCode: 'K',
      transaction: null,
      transactionDate: null,
      transactionValueCode: null,
      redacted: false,
    });
    expect(item.data.investments[1].redacted).toBe(true);
    expect(item.data.counts.investments).toBe(2);
    expect(item.data.gifts).toEqual([]);
    expect(cat.detailOf('nope', {})).toBeNull();
    expect(normaliseItem(item)).not.toBeNull();
  });

  test('a citation is a patch to its opinion, never a row', () => {
    expect(cat.citationPatch(ROWS.citations[0])).toEqual({
      externalId: '108713',
      tags: ['347 U.S. 483'],
      append: { citations: ['347 U.S. 483'] },
    });
    expect(cat.citationPatch(ROWS.citations[3])).toBeNull();
    expect(cat.citationPatch({ ...ROWS.citations[0], cluster_id: 'x' })).toBeNull();
    expect(cat.rowItem('citations', ROWS.citations[1])).toEqual({
      patch: cat.citationPatch(ROWS.citations[1]),
    });
  });

  test('an oral argument with its MP3, a blocked one left out', () => {
    const [ayala, sealed] = ROWS['oral-arguments'].map(cat.audioItem);
    expect(sealed).toBeNull();
    expect(ayala).toMatchObject({
      externalId: 'audio:17',
      kind: 'oral-argument',
      title: 'Ayala v. Shinseki',
      url: 'https://www.courtlistener.com/audio/17/ayala-v-shinseki/',
      tags: ['courtlistener'],
      publishedAt: null,
    });
    expect(ayala.data).toMatchObject({
      mp3: 'https://storage.courtlistener.com/mp3/2014/10/28/ayala_v._shinseki_cl.mp3',
      durationSeconds: 879,
      judges: null,
      docketId: '4272451',
      source: 'C',
      dateCreated: '2014-10-31 02:33:10.810318+00',
    });
    expect(cat.pageSlug('A'.repeat(200)).length).toBe(75);
    expect(cat.pageSlug('')).toBe('case');
    expect(normaliseItem(ayala)).not.toBeNull();
  });

  test('an opinion cluster: status and SCDB tags, the syllabus trimmed, blocked ones left out', () => {
    const [lawless, brown, hidden] = ROWS['opinion-clusters'].map(cat.clusterItem);
    expect(hidden).toBeNull();
    expect(lawless).toMatchObject({
      externalId: '7290305',
      kind: 'opinion',
      title: 'Lawless v. Muskingum County',
      url: 'https://www.courtlistener.com/opinion/7290305/lawless-v-muskingum-county/',
      tags: ['courtlistener', 'published', 'precedential'],
      precision: 'day',
      timeKnown: false,
    });
    expect(lawless.publishedAt).toEqual(new Date(Date.UTC(2002, 5, 6, 12)));
    expect(lawless.summary.length).toBeLessThanOrEqual(cat.SUMMARY_CHARS + 3);
    expect(lawless.summary.endsWith('...')).toBe(true);
    expect(lawless.data).toMatchObject({
      caseNameFull: 'Robert J. LAWLESS v. MUSKINGUM COUNTY, OHIO',
      judges: null,
      citationCount: 2,
      docketId: '64278691',
      attorneys: 'Latham Castle, for appellant.',
      precedentialStatus: 'Published',
      scdbId: null,
      source: 'U',
      dateFiledApproximate: false,
    });
    expect(brown.tags).toEqual(['courtlistener', 'published', 'precedential', 'scotus']);
    expect(brown.summary).toBe('Separate is not equal.');
    expect(brown.data).toMatchObject({
      scdbId: '1953-081',
      scdbDecisionDirection: 2,
      dateFiledApproximate: true,
    });
    expect(normaliseItem(lawless)).not.toBeNull();
  });

  test('a docket row is the shape the API source writes, and an FJC case has no page', () => {
    const docket = cat.docketRowItem(ROWS.dockets[0]);
    expect(docket).toMatchObject({
      externalId: 'docket:29439169',
      kind: 'docket',
      title: 'Huaranca v. Internal Revenue Service (8-98-08457)',
      url: 'https://www.courtlistener.com/docket/29439169/huaranca-v-internal-revenue-service/',
      tags: ['courtlistener', 'nyeb'],
    });
    expect(Object.keys(docket.data).sort()).toEqual(
      Object.keys(live.docketItem({ id: 1, case_name: 'x', court_id: 'nyeb' }).data).sort(),
    );
    expect(docket.data).toMatchObject({
      court: 'nyeb',
      dateFiled: '1998-07-31',
      dateTerminated: '1998-10-15',
      assignedTo: 'Dorothy Eisenberg',
      pacerCaseId: '80578',
      natureOfSuit: null,
    });
    expect(cat.docketRowItem(rowOf('dockets', { ...ROWS.dockets[0], blocked: 't' }))).toBeNull();

    const fjc = cat.fjcItem(ROWS['fjc-integrated-database'][0]);
    expect(fjc).toMatchObject({
      externalId: 'fjc:17442742',
      kind: 'case',
      title: 'A.T. CHADWICK CO., INC. v. DEZCON CONTRACTORS, INC. (8907217)',
      url: null,
      tags: ['courtlistener', 'fjc', 'paed'],
    });
    expect(fjc.publishedAt).toEqual(new Date(Date.UTC(1989, 9, 5, 12)));
    expect(fjc.data).toMatchObject({
      natureOfSuit: '190',
      disposition: '4',
      amountReceived: 75,
      dateTerminated: '1989-11-15',
      circuit: 'ca3',
      district: 'paed',
    });
    expect(normaliseItem(fjc).dedupeKey).toBeNull();
    expect(cat.rowItem('nope', {})).toBeNull();
    expect(cat.rowItem('courts', ROWS.courts[0]).kind).toBe('court');
  });
});

// ── The catalogue: the walk ──────────────────────────────────────────────────

/** A table as COPY writes it: quoted strings with backslash escapes, nothing for NULL. */
function csvOf(table, rows) {
  const header = HEADERS[table].split(',');
  const cell = (v) =>
    v === null || v === undefined
      ? ''
      : `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return `${header.join(',')}\n${rows.map((r) => header.map((h) => cell(r[h])).join(',')).join('\n')}\n`;
}

const haveBzip2 = Bun.which('bzip2');
describe.skipIf(!haveBzip2)('catalogue: the walk', () => {
  const VERSION = '2026-06-30';
  let dir;
  let savedDataDir;
  const files = {};

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nichedb-cl-test-'));
    savedDataDir = config.ingest.dataDir;
    config.ingest.dataDir = dir;
    for (const table of Object.keys(HEADERS)) {
      const plain = join(dir, `${table}.csv`);
      await writeFile(plain, csvOf(table, ROWS[table]));
      const proc = Bun.spawn(['bzip2', '-f', plain], { stderr: 'pipe' });
      expect(await proc.exited).toBe(0);
      files[table] = await readFile(`${plain}.bz2`);
    }
  });
  afterAll(async () => {
    config.ingest.dataDir = savedDataDir;
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  /** A fake bucket: the listing names every table at VERSION; downloads write the fixtures. */
  function bucket({ listing = null } = {}) {
    const calls = [];
    const http = {
      async text(url) {
        calls.push(url);
        if (listing) return listing;
        const contents = Object.keys(HEADERS)
          .map(
            (t) =>
              `<Contents><Key>bulk-data/${t}-${VERSION}.csv.bz2</Key><Size>${files[t].length}</Size></Contents>`,
          )
          .join('');
        return `<r><IsTruncated>false</IsTruncated>${contents}</r>`;
      },
      async download(url, path) {
        calls.push(url);
        const m = url.match(/bulk-data\/([a-z0-9-]+)-(\d{4}-\d{2}-\d{2})\.csv\.bz2$/);
        expect(m[2]).toBe(VERSION);
        await writeFile(path, files[m[1]]);
        return { path, bytes: files[m[1]].length, complete: true };
      },
    };
    return { http, calls };
  }

  async function drain(gen) {
    const batches = [];
    for (;;) {
      const r = await gen.next();
      if (r.done) return { batches, result: r.value };
      batches.push(r.value);
    }
  }

  const pull = (ctx) =>
    cat.courtlistenerCatalog.pull({
      config: { ...cat.courtlistenerCatalog.defaults, ...(ctx.config ?? {}) },
      cursor: ctx.cursor ?? {},
      http: ctx.http,
      log: ctx.log ?? (() => {}),
      deadline: ctx.deadline ?? Date.now() + 60_000,
    });

  test('one run walks every default table, then says unchanged', async () => {
    const { http, calls } = bucket();
    const { batches, result } = await drain(pull({ http }));
    const items = batches.flatMap((b) => b.items);
    const kinds = {};
    for (const i of items) kinds[i.kind] = (kinds[i.kind] ?? 0) + 1;
    expect(kinds).toEqual({
      court: 2,
      judge: 1,
      'financial-disclosure': 1,
      'oral-argument': 1,
      opinion: 2,
      case: 1,
    });
    // Every id unique across the tables that share the source.
    expect(new Set(items.map((i) => i.externalId)).size).toBe(items.length);
    // The judge carries positions, education and party from the side files.
    const judge = items.find((i) => i.kind === 'judge');
    expect(judge.data.positions).toHaveLength(2);
    expect(judge.data.educations).toEqual([
      {
        school: 'Howard University',
        schoolId: '4697',
        degreeLevel: 'llb',
        degree: 'LL.B.',
        year: 1939,
      },
    ]);
    expect(judge.tags).toContain('party:democratic');
    // The disclosure carries what the report says from the eight detail tables.
    const disclosure = items.find((i) => i.kind === 'financial-disclosure');
    expect(disclosure.data.counts).toEqual({
      investments: 2,
      gifts: 1,
      debts: 1,
      positions: 1,
      agreements: 0,
      reimbursements: 0,
      spousalIncome: 0,
      nonInvestmentIncome: 1,
    });
    expect(disclosure.summary).toContain('Investments (2): Fidelity Cash Reserves');
    // Citations are patches to the opinions, never rows; the one with no reporter is skipped.
    const patches = batches.flatMap((b) => b.patches ?? []);
    expect(patches.map((p) => `${p.externalId} ${p.tags[0]}`)).toEqual([
      '108713 347 U.S. 483',
      '108713 74 S. Ct. 686',
      '7290305 2002 Ohio 2851',
    ]);
    // The disclosure's person (2084) is not in the people fixture, so the fallback title.
    expect(items.find((i) => i.kind === 'financial-disclosure').title).toBe(
      'Financial disclosure 2009 (person 2084)',
    );
    expect(result.cursor).toMatchObject({
      idScheme: cat.ID_SCHEME,
      version: VERSION,
      walked: [...cat.FILES, 'fjc-integrated-database'],
      file: null,
      record: 0,
      done: true,
      modifiedWatermark: '2024-11-08 17:44:17.193082+00',
    });
    expect(result.note).toContain('complete');
    // The listing, then a download call per table needed: seven walked, four
    // beside the judges, nine beside the disclosures (the people file again,
    // which `http.download` finds whole on disk: one Range request).
    expect(calls.filter((u) => u.includes('list-type')).length).toBe(1);
    expect(calls.filter((u) => u.endsWith('.csv.bz2')).length).toBe(20);
    // The walked copies are gone from the shared disk.
    expect((await readdir(join(dir, cat.DUMP_DIR))).filter((n) => n.endsWith('.bz2'))).toEqual([]);

    const again = await drain(pull({ http, cursor: result.cursor }));
    expect(again.batches).toEqual([]);
    expect(again.result.note).toContain('unchanged');
  });

  test('a deadline already near yields nothing, downloads nothing and asks for ten minutes', async () => {
    const { http, calls } = bucket();
    const { batches, result } = await drain(pull({ http, deadline: Date.now() - 1 }));
    expect(batches).toEqual([]);
    expect(calls.filter((u) => u.endsWith('.csv.bz2'))).toEqual([]);
    expect(result.nextInMinutes).toBe(cat.RESUME_MINUTES);
    expect(result.note).toContain('out of time before the courts download');
  });

  test('a run out of time stops with a cursor the next run resumes from', async () => {
    const { http } = bucket();
    // The clock jumps past the deadline once the first batch is out, which is
    // where a long walk meets it: between two batches.
    const realNow = Date.now;
    let past = false;
    const clock = spyOn(Date, 'now').mockImplementation(() => (past ? 1e15 : realNow()));
    let first;
    try {
      const gen = pull({ http, config: { batchRows: 1 }, deadline: realNow() + 3_600_000 });
      const batches = [];
      for (;;) {
        const r = await gen.next();
        if (r.done) {
          first = { batches, result: r.value };
          break;
        }
        batches.push(r.value);
        past = true;
      }
    } finally {
      clock.mockRestore();
    }
    expect(first.batches).toHaveLength(1);
    expect(first.batches[0].items[0].externalId).toBe('nc');
    expect(first.result.cursor).toMatchObject({
      version: VERSION,
      file: 'courts',
      record: 1,
      done: false,
    });
    expect(first.result.nextInMinutes).toBe(cat.RESUME_MINUTES);

    const rest = await drain(pull({ http, config: { batchRows: 1 }, cursor: first.result.cursor }));
    const ids = rest.batches.flatMap((b) => b.items.map((i) => i.externalId));
    expect(ids).toEqual([
      'minnag',
      'judge:2749',
      'disclosure:1108',
      'audio:17',
      '7290305',
      '108713',
      'fjc:17442742',
    ]);
    expect(rest.result.cursor.done).toBe(true);
  });

  test('a second pass on a new dump skips rows modified before the watermark', async () => {
    const { http } = bucket();
    const prev = {
      idScheme: cat.ID_SCHEME,
      version: '2026-03-31',
      walked: [...cat.FILES, 'fjc-integrated-database'],
      file: null,
      record: 0,
      done: true,
      modifiedWatermark: '2024-11-06 00:00:00+00',
    };
    const { batches, result } = await drain(pull({ http, cursor: prev }));
    const ids = batches.flatMap((b) => b.items.map((i) => i.externalId));
    // Only the cluster modified on 2024-11-08 is newer than the watermark.
    expect(ids).toEqual(['108713']);
    // Citations are walked whole every pass: a patch already applied costs nothing.
    expect(batches.flatMap((b) => b.patches ?? [])).toHaveLength(3);
    expect(result.note).toContain('unchanged skipped');
    expect(result.cursor.modifiedWatermark).toBe('2024-11-08 17:44:17.193082+00');
  });

  test('a cursor from before the id scheme finishes its table, then walks the re-keyed ones', async () => {
    const { http } = bucket();
    // The production cursor on 2026-09-23, in the clusters with no `walked`.
    const cursor = {
      version: VERSION,
      file: 'opinion-clusters',
      record: 0,
      modifiedWatermark: null,
      maxModified: '2026-06-30 08:17:05.895051+00',
      done: false,
    };
    const { batches, result } = await drain(pull({ http, cursor }));
    const order = [];
    for (const b of batches) {
      for (const i of b.items) if (order.at(-1) !== i.kind) order.push(i.kind);
      if (b.patches?.length && order.at(-1) !== 'citations') order.push('citations');
    }
    expect(order).toEqual([
      'opinion',
      'judge',
      'financial-disclosure',
      'oral-argument',
      'citations',
      'case',
    ]);
    // The table in progress first, then the rest in FILES order; the courts are not walked again.
    expect(batches.flatMap((b) => b.items).some((i) => i.kind === 'court')).toBe(false);
    expect(result.cursor).toMatchObject({ idScheme: cat.ID_SCHEME, done: true });
    expect(result.cursor.walked.sort()).toEqual([...cat.FILES, 'fjc-integrated-database'].sort());
  });

  test('dockets and the FJC join the walk only when turned on', async () => {
    const { http } = bucket();
    const { batches } = await drain(pull({ http, config: { dockets: 'true', fjc: 'true' } }));
    const kinds = new Set(batches.flatMap((b) => b.items.map((i) => i.kind)));
    expect(kinds.has('docket')).toBe(true);
    expect(kinds.has('case')).toBe(true);
    const off = await drain(pull({ http, config: { dockets: 'false', fjc: 'false' } }));
    const offKinds = new Set(off.batches.flatMap((b) => b.items.map((i) => i.kind)));
    expect(offKinds.has('docket')).toBe(false);
    expect(offKinds.has('case')).toBe(false);
  });

  test('a bucket that cannot be listed: a first run fails, a walk in progress carries on', async () => {
    let listings = 0;
    const good = bucket();
    const http = {
      async text() {
        listings += 1;
        throw new Error('503');
      },
      download: good.http.download,
    };
    // Nothing known yet and every request failed: the run is an error.
    await expect(drain(pull({ http, config: { pauseMs: 0 } }))).rejects.toThrow(
      /every request failed/,
    );
    expect(listings).toBe(cat.FAILURE_STOP);
    // A walk in progress does not need to know what is newest.
    const cursor = {
      idScheme: cat.ID_SCHEME,
      version: VERSION,
      walked: ['courts', 'people-db-people', 'financial-disclosures'],
      file: 'oral-arguments',
      record: 0,
      done: false,
    };
    const { batches, result } = await drain(pull({ http, config: { pauseMs: 0 }, cursor }));
    expect(batches.flatMap((b) => b.items.map((i) => i.kind))).toEqual([
      'oral-argument',
      'opinion',
      'opinion',
      'case',
    ]);
    expect(result.cursor.done).toBe(true);
  });
});

// ── The migration ────────────────────────────────────────────────────────────

describe('migrations 0027 and 0028, and the patch query', () => {
  let db;
  const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
  beforeAll(async () => {
    db = await new PGlite({ extensions: { citext, pg_trgm } });
    for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
      await db.exec(await readFile(dir + f, 'utf8'));
    }
  }, 60_000);
  afterAll(async () => db?.close());

  test('moves every CourtListener source, and its items, from filings into law; idempotent', async () => {
    const one = async (sql, params) => (await db.query(sql, params)).rows[0];
    const law = await one(`select id, name from collections where slug = 'law'`);
    expect(law.name).toBe('Courts & case law');
    const filings = await one(
      `insert into collections (slug, name, description) values ('filings', 'Filings', 'SEC filings, and court opinions.') returning id`,
    );
    const src = await one(
      `insert into sources (collection_id, adapter, slug, name, cursor, last_error)
       values ($1, 'courtlistener', 'courtlistener-opinions', 'old', '{"page":2}', 'COURTLISTENER_TOKEN is not set') returning id`,
      [filings.id],
    );
    const edgar = await one(
      `insert into sources (collection_id, adapter, slug, name) values ($1, 'edgar', 'edgar-form-d', 'EDGAR') returning id`,
      [filings.id],
    );
    await db.query(
      `insert into items (collection_id, source_id, external_id, title, content_hash) values ($1, $2, '1', 'x', 'h')`,
      [filings.id, src.id],
    );
    const migration = await readFile(`${dir}0027_law_collection.sql`, 'utf8');
    await db.exec(migration);
    expect(
      (await one(`select collection_id, cursor, last_error from sources where id = $1`, [src.id]))
        .collection_id,
    ).toBe(law.id);
    expect(
      (await one(`select cursor, last_error from sources where id = $1`, [src.id])).cursor,
    ).toEqual({});
    expect(
      (await one(`select last_error from sources where id = $1`, [src.id])).last_error,
    ).toBeNull();
    expect(
      (await one(`select collection_id from items where source_id = $1`, [src.id])).collection_id,
    ).toBe(law.id);
    expect(
      (await one(`select collection_id from sources where id = $1`, [edgar.id])).collection_id,
    ).toBe(filings.id);
    expect(
      (await one(`select description from collections where slug = 'filings'`)).description,
    ).not.toContain('opinion');
    await db.exec(migration);
    expect(
      (await one(`select count(*)::int as n from sources where adapter like 'courtlistener%'`)).n,
    ).toBe(1);
  });

  test('0028 deletes the bare-id rows the collision left, keeps clusters, turns the FJC on', async () => {
    const one = async (sql, params) => (await db.query(sql, params)).rows[0];
    const law = await one(`select id from collections where slug = 'law'`);
    const catalog = await one(
      `insert into sources (collection_id, adapter, slug, name, config, item_count)
       values ($1, 'courtlistener-catalog', 'courtlistener-catalog', 'catalog',
               '{"dockets":"false","fjc":"false","batchRows":500}', 7) returning id`,
      [law.id],
    );
    const api = await one(
      `insert into sources (collection_id, adapter, slug, name) values ($1, 'courtlistener-api', 'courtlistener-judges', 'api') returning id`,
      [law.id],
    );
    const rows = [
      [catalog.id, '17', 'oral-argument'],
      [catalog.id, '2749', 'judge'],
      [catalog.id, '1108', 'financial-disclosure'],
      [catalog.id, '108713', 'opinion'],
      [catalog.id, 'judge:2749', 'judge'],
      [catalog.id, 'nc', 'court'],
      [api.id, '2749', 'judge'],
    ];
    for (const [src, id, kind] of rows) {
      await db.query(
        `insert into items (collection_id, source_id, external_id, kind, title) values ($1, $2, $3, $4, 'x')`,
        [law.id, src, id, kind],
      );
    }
    const migration = await readFile(`${dir}0028_courtlistener_catalog_ids.sql`, 'utf8');
    await db.exec(migration);
    const left = (
      await db.query(
        `select source_id, external_id from items where source_id in ($1, $2) order by source_id, external_id`,
        [catalog.id, api.id],
      )
    ).rows.map((r) => `${r.source_id === catalog.id ? 'catalog' : 'api'} ${r.external_id}`);
    expect(left).toEqual(['catalog 108713', 'catalog judge:2749', 'catalog nc', 'api 2749']);
    const src = await one(`select config, item_count from sources where id = $1`, [catalog.id]);
    expect(src.config).toEqual({ dockets: 'false', fjc: 'true', batchRows: 500 });
    expect(src.item_count).toBe(4);
    // Idempotent, and a config someone set by hand is theirs.
    await db.query(`update sources set config = '{"fjc":"no"}' where id = $1`, [catalog.id]);
    await db.exec(migration);
    expect((await one(`select config from sources where id = $1`, [catalog.id])).config).toEqual({
      fjc: 'no',
    });
  });

  test('0029 turns the FJC on when the config is stored as a jsonb string, keeping that form', async () => {
    const one = async (sql, params) => (await db.query(sql, params)).rows[0];
    const law = await one(`select id from collections where slug = 'law'`);
    // Production's form: insertSource's `${JSON.stringify(config)}::jsonb` reaches
    // Postgres as a JSON string, so the column holds a string, not the object.
    const asString = await one(
      `insert into sources (collection_id, adapter, slug, name, config)
       values ($1, 'courtlistener-catalog', 'catalog-string', 's',
               to_jsonb('{"dockets":"false","fjc":"false","batchRows":500}'::text)) returning id`,
      [law.id],
    );
    const asObject = await one(
      `insert into sources (collection_id, adapter, slug, name, config)
       values ($1, 'courtlistener-catalog', 'catalog-object', 'o', '{"fjc":"false"}') returning id`,
      [law.id],
    );
    const handSet = await one(
      `insert into sources (collection_id, adapter, slug, name, config)
       values ($1, 'courtlistener-catalog', 'catalog-hand', 'h', to_jsonb('{"fjc":"no"}'::text)) returning id`,
      [law.id],
    );
    // 0028 alone cannot see inside the string.
    await db.exec(await readFile(`${dir}0028_courtlistener_catalog_ids.sql`, 'utf8'));
    const typed = async (id) =>
      one(`select jsonb_typeof(config) t, config #>> '{}' txt, config from sources where id = $1`, [
        id,
      ]);
    expect(JSON.parse((await typed(asString.id)).txt).fjc).toBe('false');

    const migration = await readFile(`${dir}0029_courtlistener_fjc_on_string_config.sql`, 'utf8');
    await db.exec(migration);
    await db.exec(migration);
    const str = await typed(asString.id);
    expect(str.t).toBe('string');
    expect(JSON.parse(str.txt)).toEqual({ dockets: 'false', fjc: 'true', batchRows: 500 });
    const obj = await typed(asObject.id);
    expect(obj.t).toBe('object');
    expect(obj.config).toEqual({ fjc: 'true' });
    expect(JSON.parse((await typed(handSet.id)).txt)).toEqual({ fjc: 'no' });
  });

  test('patchItems: tags and data arrays appended once, missing rows and full rows untouched', async () => {
    const one = async (sql, params) => (await db.query(sql, params)).rows[0];
    const law = await one(`select id from collections where slug = 'law'`);
    const src = await one(
      `insert into sources (collection_id, adapter, slug, name) values ($1, 'courtlistener-catalog', 'patch-test', 'p') returning id`,
      [law.id],
    );
    await db.query(
      `insert into items (collection_id, source_id, external_id, kind, title, tags, data)
       values ($1, $2, '108713', 'opinion', 'Brown v. Board of Education', '{courtlistener,scotus}', '{"judges":"Warren"}')`,
      [law.id, src.id],
    );
    const rows = patchRows(
      ROWS.citations
        .map(cat.citationPatch)
        .filter(Boolean)
        .concat([
          { externalId: '108713', tags: ['347 U.S. 483'], append: { citations: ['347 U.S. 483'] } },
        ]),
    );
    // One row per id: Postgres applies only one FROM row per target.
    expect(rows.map((r) => r.external_id)).toEqual(['108713', '7290305']);
    expect(rows[0].append.citations).toEqual(['347 U.S. 483', '74 S. Ct. 686']);
    const run = async () =>
      (await db.query(PATCH_ITEMS_SQL, [JSON.stringify(rows), src.id])).rows.length;
    // The cluster 7290305 has no row here, so only Brown changes.
    expect(await run()).toBe(1);
    const brown = await one(`select tags, data from items where source_id = $1`, [src.id]);
    expect(brown.tags).toEqual(['courtlistener', 'scotus', '347 U.S. 483', '74 S. Ct. 686']);
    expect(brown.data).toEqual({ judges: 'Warren', citations: ['347 U.S. 483', '74 S. Ct. 686'] });
    // Applied again it touches nothing.
    expect(await run()).toBe(0);
    // A rewritten row (a changed cluster drops what patches added) takes them again.
    await db.query(`update items set tags = '{courtlistener}', data = '{}' where source_id = $1`, [
      src.id,
    ]);
    expect(await run()).toBe(1);
    expect((await one(`select data from items where source_id = $1`, [src.id])).data).toEqual({
      citations: ['347 U.S. 483', '74 S. Ct. 686'],
    });
  });
});
