import { describe, expect, test } from 'bun:test';
import { copyFile, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';
process.env.INGEST_DATA_DIR = await mkdtemp(join(tmpdir(), 'neiss-test-'));

const FIX = join(import.meta.dir, '../packages/adapters/test/fixtures');
const SAMPLE = join(FIX, 'neiss-sample.tsv');

const {
  ageBand,
  ageOf,
  cleanLabel,
  estimateItem,
  FORMAT_URL,
  headerIndex,
  narrativeActivities,
  neiss,
  parseFormats,
  productShort,
  tallyVisit,
  toRecord,
  treatmentDate,
  unstable,
  visitItem,
  yearUrl,
} = await import('../packages/adapters/src/neiss.js');
const { ADAPTERS, adapterByName } = await import('../packages/adapters/src/index.js');
const { normaliseItem } = await import('../packages/core/src/adapter.js');
const { csvRecords } = await import('../packages/core/src/dump.js');
const { COLLECTIONS, DEFAULT_FEEDS } = await import('../packages/core/src/seed.js');

const fmtText = await readFile(join(FIX, 'neiss-fmt.txt'), 'utf8');
const fmt = parseFormats(fmtText);

async function sampleRecords() {
  const out = [];
  let idx = null;
  for await (const cells of csvRecords(Bun.file(SAMPLE).stream(), { delimiter: '\t' })) {
    if (!idx) {
      idx = headerIndex(cells);
      continue;
    }
    out.push(toRecord(cells, idx));
  }
  return out;
}

describe('the injuries collection is wired up', () => {
  test('collection, adapter and feeds exist and agree', () => {
    expect(COLLECTIONS.some((c) => c.slug === 'injuries')).toBe(true);
    expect(adapterByName('neiss')).toBe(neiss);
    expect(ADAPTERS).toContain(neiss);
    expect(neiss.collection).toBe('injuries');
    const feeds = DEFAULT_FEEDS.filter((f) => f.collection === 'injuries');
    expect(feeds.length).toBeGreaterThanOrEqual(8);
    for (const f of feeds) {
      for (const k of f.query.kinds ?? []) expect(neiss.kinds).toContain(k);
    }
  });

  test('urls', () => {
    expect(yearUrl(2024)).toBe(
      'https://www.cpsc.gov/cgibin/NEISSQuery/Data/Archived%20Data/2024/neiss2024.tsv',
    );
    expect(FORMAT_URL).toContain('Info%20Docs/NEISS_FMT.txt');
  });
});

describe('NEISS code tables and fields', () => {
  test('format file parses to labelled maps, skipping ranges', () => {
    expect(fmt.PROD.get('1267')).toBe('SOCCER (ACTIVITY, APPAREL OR EQUIPMENT)');
    expect(fmt.DIAG.get('64')).toBe('STRAIN, SPRAIN');
    expect(fmt.DISP.get('8')).toBe('FATALITY INCL. DOA, DIED IN ER');
    expect(fmt.LOC.get('9')).toBe('SPORTS');
    // AGELTTWO 2..120 is a range; the single months are kept.
    expect(fmt.AGELTTWO.has('2')).toBe(false);
    expect(fmt.AGELTTWO.get('209')).toBe('9 MONTHS');
  });

  test('labels, ages and dates', () => {
    expect(cleanLabel('64 - STRAIN, SPRAIN')).toBe('STRAIN, SPRAIN');
    expect(productShort('SOCCER (ACTIVITY, APPAREL OR EQUIPMENT)')).toBe('soccer');
    expect(productShort('SQUASH, RACQUET BALL OR PADDLE BALL')).toBe(
      'squash, racquet ball or paddle ball',
    );
    expect(ageOf('209')).toEqual({ years: 0, months: 9 });
    expect(ageOf('16')).toEqual({ years: 16, months: null });
    expect(ageOf('0')).toBeNull();
    expect(ageBand(0)).toBe('age-0-4');
    expect(ageBand(16)).toBe('age-15-24');
    expect(ageBand(80)).toBe('age-65-plus');
    expect(ageBand(null)).toBeNull();
    expect(treatmentDate('01/02/2024')).toBe('2024-01-02');
    expect(treatmentDate('2024-01-02')).toBeNull();
  });

  test('a changed layout is refused, not misread', () => {
    expect(() => headerIndex(['CPSC_Case_Number', 'Treatment_Date'])).toThrow(/layout changed/);
  });
});

describe('reading the file', () => {
  test('tab-delimited RFC quoting: a tab inside quotes and doubled quotes', async () => {
    const recs = await sampleRecords();
    expect(recs).toHaveLength(8);
    const tabbed = recs.find((r) => r.caseNumber === '250101825');
    expect(tabbed.otherDiagnosis).toBe('SYNCOPE, SEIZURE-LIKE ACTIVITY');
    expect(tabbed.disposition).toBe('4');
    expect(tabbed.products).toEqual(['1211']);
    const quoted = recs.find((r) => r.caseNumber === '240112877');
    expect(quoted.narrative).toContain('WAS "ROUGH HOUSING" AT HOME');
    for (const r of recs) expect(r.weight).toBeGreaterThan(0);
  });

  test('csvRecords stays comma-separated by default', async () => {
    const chunks = (async function* () {
      yield new TextEncoder().encode('a,b\t c\n"x,y",z\n');
    })();
    const rows = [];
    for await (const r of csvRecords(chunks)) rows.push(r);
    expect(rows).toEqual([
      ['a', 'b\t c'],
      ['x,y', 'z'],
    ]);
  });
});

describe('narrative activities', () => {
  test('pickleball as the nurses spell it, and not its neighbours', () => {
    for (const s of [
      'PLAYING PICKLEBALL',
      'PICKLE BALL',
      'PICKELBALL',
      'PICKEBALL',
      'PICKLBALL',
      'PICKLEYBALL',
      'PICKELLBALL',
      'PICKEL BALL',
      'PICIKEBALL',
      'playing pickleball',
    ]) {
      expect(narrativeActivities(s)).toEqual(['pickleball']);
    }
    for (const s of [
      'PICK BALL UP',
      'SPIKE BALL',
      'SPIKED BALL',
      'PICKUP BASKETBALL',
      'KICKBALL',
    ]) {
      expect(narrativeActivities(s)).toEqual([]);
    }
    expect(narrativeActivities('PLAYING PADEL')).toEqual(['padel']);
  });

  test('a pickleball visit coded as other ball sports is found and estimated', async () => {
    const recs = await sampleRecords();
    const rec = recs.find((r) => r.caseNumber === '240202396');
    expect(rec.products).toEqual(['3235']);
    expect(rec.activities).toEqual(['pickleball']);
    const item = visitItem(rec, fmt);
    expect(item.tags).toEqual(
      expect.arrayContaining(['pickleball', 'racquet-sports', 'product-3235']),
    );
    const tallies = new Map();
    tallyVisit(tallies, rec);
    const est = estimateItem('a:pickleball', tallies.get('a:pickleball'), 2024, fmt, null);
    expect(est.externalId).toBe('neiss-estimate-2024-pickleball');
    expect(est.title).toMatch(/^Pickleball: about \d/);
    expect(est.tags).toEqual(
      expect.arrayContaining(['activity-pickleball', 'pickleball', 'racquet-sports']),
    );
    expect(est.data).toMatchObject({ activity: 'pickleball', productCode: null });
  });
});

describe('visit items', () => {
  test('a soccer visit', async () => {
    const recs = await sampleRecords();
    const item = visitItem(
      recs.find((r) => r.caseNumber === '240108461'),
      fmt,
    );
    expect(item.externalId).toBe('neiss-240108461');
    expect(item.kind).toBe('er-visit');
    expect(item.title).toBe('Strain, sprain (shoulder) · soccer · 16-year-old male');
    expect(item.publishedAt).toBe('2024-01-01');
    expect(item.tags).toEqual(
      expect.arrayContaining([
        'product-1267',
        'soccer',
        'body-shoulder',
        'dx-strain-sprain',
        'released',
        'at-sports-venue',
        'age-15-24',
        'male',
      ]),
    );
    expect(item.data.weight).toBeCloseTo(104.4634, 4);
    expect(item.summary).toContain('PLAYING SOCCER');
    const n = normaliseItem(item);
    expect(n.precision).toBe('day');
    expect(n.timeKnown).toBe(false);
  });

  test('an infant, a death, an e-bike and a second product', async () => {
    const recs = await sampleRecords();
    const by = (id) =>
      visitItem(
        recs.find((r) => r.caseNumber === id),
        fmt,
      );
    expect(by('240112883').title).toContain('9-month-old female');
    expect(by('240112883').tags).toContain('age-0-4');
    expect(by('240143219').tags).toContain('fatal');
    expect(by('240124079').tags).toEqual(expect.arrayContaining(['e-mobility', 'admitted']));
    const paddle = by('240130078');
    expect(paddle.tags).toEqual(expect.arrayContaining(['racquet-sports', 'product-1607']));
    expect(paddle.data.products.map((p) => p.code)).toEqual(['3256', '1607']);
  });
});

describe('estimates', () => {
  test('weights sum per product, a case counts toward each of its products', async () => {
    const recs = await sampleRecords();
    const tallies = new Map();
    for (const r of recs) tallyVisit(tallies, r);
    const paddle = recs.find((r) => r.caseNumber === '240130078');
    expect(tallies.get('3256').w).toBeCloseTo(paddle.weight, 4);
    expect(tallies.get('1607').w).toBeCloseTo(paddle.weight, 4);
    expect(tallies.get('3256').n).toBe(1);
    expect(unstable(tallies.get('3256'))).toBe(true);
  });

  test('an estimate item carries the change on the year and the breakdowns', () => {
    const t = {
      n: 1912,
      w: 110000,
      sex: { male: 60000, female: 50000 },
      age: { 'age-5-14': 66000, 'age-15-24': 44000 },
      disposition: { 1: 100000, 4: 8000, 2: 2000 },
      body: { 37: 20000, 79: 10000 },
      diagnosis: { 57: 34100, 64: 26400 },
      location: { 1: 90000 },
    };
    const item = estimateItem('1233', t, 2024, fmt, 88000);
    expect(item.externalId).toBe('neiss-estimate-2024-1233');
    expect(item.kind).toBe('estimate');
    expect(item.title).toBe('Product 1233: about 110,000 ER visits in 2024');
    expect(item.data.changePct).toBe(25);
    expect(item.tags).toEqual(
      expect.arrayContaining(['estimate', 'year-2024', 'product-1233', 'stable', 'rising']),
    );
    expect(item.data.admittedOrTransferredPct).toBe(9.1);
    expect(item.data.diagnoses[0]).toMatchObject({ key: '57', name: 'FRACTURE', share: 31 });
    expect(item.summary).toContain('Up 25% on 2023 (88,000).');
    expect(normaliseItem(item).precision).toBe('year');
  });
});

describe('the pull', () => {
  // A fake CPSC: 2024 is published, every other year is not.
  function fakeHttp(lastModified = 'Wed, 06 May 2026 13:51:40 GMT') {
    const calls = { downloads: 0 };
    return {
      calls,
      async text(url) {
        expect(url).toBe(FORMAT_URL);
        return fmtText;
      },
      async request(url) {
        const published = url === yearUrl(2024);
        return new Response(published ? 'x' : 'not found', {
          status: published ? 206 : 404,
          headers: published
            ? { 'content-range': 'bytes 0-0/12345', 'last-modified': lastModified }
            : {},
        });
      },
      async download(url, path) {
        expect(url).toBe(yearUrl(2024));
        calls.downloads += 1;
        await copyFile(SAMPLE, path);
        return { path, bytes: 1, complete: true };
      },
    };
  }

  async function run(http, cursor = null) {
    const batches = [];
    const gen = neiss.pull({
      config: { fromYear: 2023, visits: 'yes' },
      cursor,
      http,
      log: () => {},
      deadline: Date.now() + 10 * 60_000,
    });
    for (;;) {
      const { value, done } = await gen.next();
      if (done) return { batches, result: value };
      batches.push(value);
    }
  }

  test('estimates then visits, and a second run is a no-op until CPSC republishes', async () => {
    const http = fakeHttp();
    const first = await run(http);
    const kinds = first.batches.flatMap((b) => b.items.map((i) => i.kind));
    expect(kinds.filter((k) => k === 'estimate').length).toBe(10);
    expect(kinds.filter((k) => k === 'er-visit').length).toBe(8);
    expect(kinds.indexOf('estimate')).toBeLessThan(kinds.indexOf('er-visit'));
    const cursor = first.result.cursor;
    expect(cursor.years['2024']).toMatchObject({ estimates: true, visits: 'done' });
    expect(cursor.years['2023']).toBeUndefined();
    expect(Object.keys(cursor.totals['2024']).length).toBe(10);
    expect(cursor.totals['2024']['a:pickleball']).toBeGreaterThan(0);

    const again = await run(http, cursor);
    expect(again.batches.flatMap((b) => b.items)).toHaveLength(0);
    expect(http.calls.downloads).toBe(2);

    const republished = fakeHttp('Thu, 01 Oct 2026 00:00:00 GMT');
    const redo = await run(republished, cursor);
    expect(redo.batches.flatMap((b) => b.items).length).toBe(18);
  });

  test('visits resume from the record the cursor names', async () => {
    const http = fakeHttp();
    const first = await run(http);
    const cursor = structuredClone(first.result.cursor);
    // As if the run stopped after the header and four visits.
    cursor.years['2024'].visits = 5;
    const resumed = await run(http, cursor);
    const ids = resumed.batches.flatMap((b) => b.items.map((i) => i.externalId));
    expect(ids).toEqual([
      'neiss-240143219',
      'neiss-240124079',
      'neiss-240130078',
      'neiss-240202396',
    ]);
  });
});
