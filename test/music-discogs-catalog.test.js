import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

/**
 * The Discogs dump adapter: two gzipped XML files a month, one download
 * attempt a run, a record-tag scanner that never holds the file, and a cursor
 * of `{ month, entity, recordIndex }` the next run picks up exactly.
 *
 * The artists fixture is the first forty records of the real September 2026
 * artists dump, carved from the head of the file; the masters fixture is the
 * documented `<master id="...">` shape. The server here is a fake `fetch`
 * that behaves like data.discogs.com: a 200 with the whole body whatever was
 * asked, a 429 with a retry-after, a 404 for a month that is not there yet.
 */
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';

const {
  artistItem,
  checksumName,
  children,
  decodeXml,
  discogsCatalog,
  dumpMonth,
  dumpUrl,
  fileName,
  findOpenTag,
  masterItem,
  nextDumpMinutes,
  parseAttrs,
  parseChecksums,
  parseElement,
  plainProfile,
  recordItem,
  resumeFrom,
  retryAfterMinutes,
  retryAfterSeconds,
  scanRecords,
  trimTo,
  userAgent,
} = await import('../packages/adapters/src/discogs-catalog.js');
const { normaliseItem } = await import('../packages/core/src/adapter.js');

const FIXTURES = join(import.meta.dir, '../packages/adapters/test/fixtures');
const artistsXml = await readFile(join(FIXTURES, 'discogs-catalog-artists.xml'), 'utf8');
const mastersXml = await readFile(join(FIXTURES, 'discogs-catalog-masters.xml'), 'utf8');
const MONTH = dumpMonth();

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const ARTIST_IDS = [...artistsXml.matchAll(/<artist><id>(\d+)<\/id>/g)].map((m) => Number(m[1]));

/** The forty real records, `copies` times over with ids moved up a block each copy. */
function bigArtists(copies) {
  const body = artistsXml.replace(/^<artists>\n|<\/artists>\n$/g, '');
  const parts = [];
  for (let k = 0; k < copies; k += 1) {
    parts.push(
      body.replace(
        /<artist><id>(\d+)<\/id>/g,
        (_, id) => `<artist><id>${Number(id) + k * 100000}</id>`,
      ),
    );
  }
  return `<artists>\n${parts.join('')}</artists>\n`;
}

/**
 * A fake data.discogs.com. `modes` maps a file name to how it answers:
 * 'ok' (default), 'short' (announces more bytes than it sends), '429',
 * '404', 'throw' (the socket drops), or a function returning a Response.
 */
function provider({ artists = artistsXml, masters = mastersXml, modes = {}, checksums } = {}) {
  const bodies = {
    [fileName(MONTH, 'artists')]: gzipSync(Buffer.from(artists)),
    [fileName(MONTH, 'masters')]: gzipSync(Buffer.from(masters)),
  };
  const sums =
    checksums ??
    Object.entries(bodies)
      .map(([name, buf]) => `${sha256(buf)}  ${name}`)
      .join('\n');
  const requests = [];
  const uas = [];
  const fetch = async (url, init = {}) => {
    const name = decodeURIComponent(new URL(url).searchParams.get('download') ?? '')
      .split('/')
      .pop();
    requests.push(name);
    uas.push(init.headers?.['user-agent']);
    const mode = modes[name] ?? 'ok';
    if (typeof mode === 'function') return mode();
    if (mode === 'throw') throw new Error('ECONNRESET');
    if (mode === '404') return new Response('no', { status: 404 });
    if (mode === '429')
      return new Response('slow down', { status: 429, headers: { 'retry-after': '3359' } });
    if (name === checksumName(MONTH)) return new Response(sums, { status: 200 });
    const body = bodies[name];
    if (!body) return new Response('no', { status: 404 });
    if (mode === 'short') {
      return new Response(body.subarray(0, body.length - 100), {
        status: 200,
        headers: { 'content-length': String(body.length) },
      });
    }
    return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } });
  };
  return { fetch, requests, uas, bodies };
}

let root;
let dirs = 0;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'nichedb-discogs-test-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
function freshDir() {
  dirs += 1;
  return join(root, `run-${dirs}`);
}

/** Drive `pull` the way the core does: collect every batch, keep the return value. */
async function run(p, { cursor = {}, dir, deadline = Number.POSITIVE_INFINITY, log } = {}) {
  const gen = discogsCatalog.pull({
    config: { cacheDir: dir },
    cursor,
    env: { contactEmail: 'ops@nichedb.test' },
    http: { fetch: p.fetch },
    log: log ?? (() => {}),
    deadline,
  });
  const batches = [];
  for (;;) {
    const { value, done } = await gen.next();
    if (done) return { batches, items: batches.flatMap((b) => b.items), ...value };
    batches.push(value);
  }
}

const exists = async (path) => (await stat(path).catch(() => null)) !== null;

describe('the XML pieces', () => {
  test('the five entities and numeric references decode once, nothing else changes', () => {
    expect(decodeXml('Mr. James Barth &amp; A.D. &lt;x&gt; &quot;q&quot; &apos;a&apos;')).toBe(
      'Mr. James Barth & A.D. <x> "q" \'a\'',
    );
    expect(decodeXml('a&#13;b&#x41;')).toBe('a\rbA');
    expect(decodeXml('&amp;#13;')).toBe('&#13;');
    expect(decodeXml('&nbsp;&#1114112;')).toBe('&nbsp;&#1114112;');
  });

  test('an open tag must end at the name, so <artist is not <artists>', () => {
    const xml = '<artists><artist><id>1</id></artist></artists>';
    expect(findOpenTag(xml, 'artist')).toBe(9);
    expect(findOpenTag(xml, 'name')).toBe(-1);
    expect(findOpenTag('<name id="1"/><name>x</name>', 'name', 0, { opening: true })).toBe(14);
  });

  test('attributes in either quote, bare, or unquoted', () => {
    expect(parseAttrs(' id="18500" type=\'primary\' embed=true checked')).toEqual({
      id: '18500',
      type: 'primary',
      embed: 'true',
      checked: '',
    });
    expect(parseAttrs(' uri="a&amp;b"')).toEqual({ uri: 'a&b' });
  });

  test('elements nest by depth, self-close, and survive truncation', () => {
    const el = parseElement('<!-- c --><?xml x?><a x="1"><a>in</a><b/>tail</a><c/>');
    expect(el.name).toBe('a');
    expect(el.attrs).toEqual({ x: '1' });
    expect(el.inner).toBe('<a>in</a><b/>tail');
    expect(parseElement('<c/>', 0)).toMatchObject({ name: 'c', inner: '', end: 4 });
    expect(parseElement('<a><b>never closed', 0)).toMatchObject({
      name: 'a',
      inner: '<b>never closed',
    });
    expect(parseElement('no tags here')).toBeNull();
    expect(children('<a>1</a> <b k="v"/><c>3</c>').map((e) => e.name)).toEqual(['a', 'b', 'c']);
  });

  test('records are found across chunk boundaries and skip counts them', async () => {
    const bytes = Buffer.from(artistsXml);
    async function* chunks(size) {
      for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
    }
    const all = [];
    for await (const r of scanRecords(chunks(7), 'artist')) all.push(r);
    expect(all).toHaveLength(40);
    expect(all[0].startsWith('<artist><id>1</id>')).toBe(true);
    expect(all[39].endsWith('</artist>')).toBe(true);
    const tail = [];
    for await (const r of scanRecords(chunks(4096), 'artist', { skip: 38 })) tail.push(r);
    expect(tail.map((r) => r.match(/<id>(\d+)</)[1])).toEqual(ARTIST_IDS.slice(38).map(String));
    const masters = [];
    for await (const r of scanRecords(chunks(100), 'master')) masters.push(r);
    expect(masters.map((r) => parseElement(r).attrs.id)).toEqual([]);
    const mb = Buffer.from(mastersXml);
    async function* mchunks() {
      for (let i = 0; i < mb.length; i += 50) yield mb.subarray(i, i + 50);
    }
    for await (const r of scanRecords(mchunks(), 'master')) masters.push(r);
    expect(masters.map((r) => parseElement(r).attrs.id)).toEqual(['18500', '18512', '18520']);
  });

  test('profile markup becomes plain text and summaries cut at a word', () => {
    expect(
      plainProfile(
        'Formed [l=Ovum Recordings] with [a=King Britt].&#13;\nSee [url=http://x]site[/url] [b]now[/b].',
      ),
    ).toBe('Formed Ovum Recordings with King Britt.&#13; See site now.');
    expect(trimTo('short', 10)).toBe('short');
    const long = trimTo('word '.repeat(200), 600);
    expect(long.length).toBeLessThanOrEqual(600);
    expect(long.endsWith('...')).toBe(true);
  });
});

describe('the items', () => {
  const records = (xml, tag) => children(parseElement(xml).inner).filter((e) => e.name === tag);

  test('an artist row, from the real first record of the dump', () => {
    const [persuader, barth] = records(artistsXml, 'artist');
    const item = normaliseItem(artistItem(persuader));
    expect(item.externalId).toBe('discogs:artist:1');
    expect(item.kind).toBe('artist');
    expect(item.title).toBe('The Persuader');
    expect(item.url).toBe('https://www.discogs.com/artist/1');
    expect(item.summary).toBe('Electronic artist working out of Stockholm, active since 1994.');
    expect(item.imageUrl).toBeNull();
    expect(item.tags).toEqual(['artist', 'discogs']);
    expect(item.data).toMatchObject({
      discogsId: 1,
      name: 'The Persuader',
      realName: 'Jesper Dahlbäck',
      nameVariations: ['Persuader', 'The Presuader'],
      dataQuality: 'Needs Vote',
      attribution: 'Discogs, CC0',
    });
    expect(item.data.aliases).toContain('Groove Machine');
    expect(item.data.urls).toEqual([
      'https://en.wikipedia.org/wiki/Jesper_Dahlbäck',
      'https://www.last.fm/music/Jesper+Dahlb%C3%A4ck',
    ]);
    expect(item.data.members).toEqual([]);

    const group = artistItem(barth);
    expect(group.title).toBe('Mr. James Barth & A.D.');
    expect(group.data.members).toEqual(['Alexi Delano', 'Cari Lekebusch']);
    expect(group.data.aliases).toContain('Yakari & Delano');
    expect(group.summary).toBeNull();
  });

  test('every real record in the fixture becomes an item with a positive id', () => {
    const items = records(artistsXml, 'artist').map(artistItem);
    expect(items).toHaveLength(40);
    expect(items.every((i) => i && i.data.discogsId > 0 && i.title)).toBe(true);
    expect(items.map((i) => i.data.discogsId)).toEqual(ARTIST_IDS);
    const withGroups = items.filter((i) => i.data.groups.length);
    expect(withGroups.length).toBeGreaterThan(0);
  });

  test('a master row: id from the attribute, artists, genres, styles, year, videos', () => {
    const [soil, stockholm, undated] = records(mastersXml, 'master');
    const item = normaliseItem(masterItem(soil));
    expect(item.externalId).toBe('discogs:master:18500');
    expect(item.kind).toBe('master');
    expect(item.title).toBe('Samuel L Session - New Soil');
    expect(item.url).toBe('https://www.discogs.com/master/18500');
    expect(item.summary).toBe('2001 · Electronic · Techno');
    expect(item.publishedAt.toISOString().slice(0, 4)).toBe('2001');
    expect(item.precision).toBe('year');
    expect(item.tags).toEqual(['master', 'discogs', 'genre:electronic', 'style:techno']);
    expect(item.data).toMatchObject({
      discogsId: 18500,
      title: 'New Soil',
      mainRelease: 155102,
      year: 2001,
      artists: [{ name: 'Samuel L Session', id: 212070 }],
      genres: ['Electronic'],
      styles: ['Techno'],
      dataQuality: 'Correct',
      attribution: 'Discogs, CC0',
    });
    expect(item.data.videos).toEqual([
      'https://www.youtube.com/watch?v=f05Ai921itM',
      'https://www.youtube.com/watch?v=v23rSPG_StA',
    ]);

    const two = masterItem(stockholm);
    expect(two.title).toBe('The Persuader, Mr. James Barth & A.D. - Stockholm <Sessions> "Vol. 1"');
    expect(two.data.title).toBe('Stockholm <Sessions> "Vol. 1"');
    expect(two.tags).toEqual([
      'master',
      'discogs',
      'genre:electronic',
      'genre:hip-hop',
      'style:deep-house',
      'style:tech-house',
    ]);
    expect(two.data.videos).toEqual([]);

    const none = masterItem(undated);
    expect(none.data.year).toBeNull();
    expect(none.publishedAt).toBeNull();
    expect(none.summary).toBe('Electronic · Acid');
  });

  test('a record without its id or its name is null, never a throw', () => {
    expect(recordItem('artists', '<artist><name>Nobody</name></artist>')).toBeNull();
    expect(recordItem('artists', '<artist><id>7</id></artist>')).toBeNull();
    expect(recordItem('artists', '<artist><id>x</id><name>N</name></artist>')).toBeNull();
    expect(recordItem('masters', '<master><title>T</title></master>')).toBeNull();
    expect(recordItem('masters', '<master id="5"></master>')).toBeNull();
    expect(recordItem('masters', null)).toBeNull();
    expect(recordItem('artists', '<garbage')).toBeNull();
  });
});

describe('the small helpers', () => {
  test('month, urls, names', () => {
    expect(dumpMonth(new Date('2026-09-13T10:00:00Z'))).toBe('20260901');
    expect(dumpMonth(new Date('2026-12-31T23:59:59Z'))).toBe('20261201');
    expect(dumpUrl('20260901', fileName('20260901', 'artists'))).toBe(
      'https://data.discogs.com/?download=data%2F2026%2Fdiscogs_20260901_artists.xml.gz',
    );
    expect(checksumName('20260901')).toBe('discogs_20260901_CHECKSUM.txt');
    expect(userAgent({ contactEmail: 'ops@nichedb.test' })).toBe(
      'niche-db discogs-catalog (+https://github.com/profullstack/niche-db; ops@nichedb.test)',
    );
    expect(userAgent({})).toContain('discogs-catalog');
  });

  test('retry-after in seconds or as a date, and the minutes scheduled past it', () => {
    const now = Date.parse('2026-09-13T10:00:00Z');
    expect(retryAfterSeconds('3359', now)).toBe(3359);
    expect(retryAfterSeconds('Sun, 13 Sep 2026 10:10:00 GMT', now)).toBe(600);
    expect(retryAfterSeconds(null, now)).toBe(3600);
    expect(retryAfterSeconds('soon', now)).toBe(3600);
    expect(retryAfterMinutes('3359', now)).toBe(58);
    expect(retryAfterMinutes(undefined, now)).toBe(62);
  });

  test('the next dump is the first of next month, six hours in', () => {
    const m = nextDumpMinutes(new Date('2026-09-30T06:00:00Z'));
    expect(m).toBe(24 * 60);
    expect(nextDumpMinutes(new Date('2026-10-01T05:59:00Z'))).toBeGreaterThan(30 * 24 * 60);
  });

  test('checksum lines in sha256sum form, tolerant of order and tabs', () => {
    const h = 'a'.repeat(64);
    expect(
      parseChecksums(
        `${h}  discogs_20260901_artists.xml.gz\r\ndiscogs_x.xml.gz\t${'B'.repeat(64)}\n\nnoise`,
      ),
    ).toEqual({ 'discogs_20260901_artists.xml.gz': h, 'discogs_x.xml.gz': 'b'.repeat(64) });
  });

  test('a cursor from another month starts over; this month resumes where it was', () => {
    expect(resumeFrom({}, '20260901')).toEqual({
      month: '20260901',
      entity: 'artists',
      recordIndex: 0,
      done: false,
      verified: [],
      checksums: null,
    });
    expect(
      resumeFrom(
        {
          month: '20260901',
          entity: 'masters',
          recordIndex: 1500,
          verified: ['artists'],
          checksums: { a: 'b' },
        },
        '20260901',
      ),
    ).toMatchObject({
      entity: 'masters',
      recordIndex: 1500,
      verified: ['artists'],
      checksums: { a: 'b' },
    });
    expect(
      resumeFrom(
        { month: '20260801', entity: 'masters', recordIndex: 1500, done: true },
        '20260901',
      ),
    ).toMatchObject({ entity: 'artists', recordIndex: 0, done: false });
    expect(
      resumeFrom({ month: '20260901', entity: 'labels', recordIndex: -4 }, '20260901'),
    ).toMatchObject({
      entity: 'artists',
      recordIndex: 0,
    });
  });

  test('the adapter declares its budget, kinds and licence', () => {
    expect(discogsCatalog.name).toBe('discogs-catalog');
    expect(discogsCatalog.collection).toBe('music');
    expect(discogsCatalog.kinds).toEqual(['artist', 'master']);
    expect(discogsCatalog.budgetMs).toBe(55 * 60_000);
    expect(discogsCatalog.description).toContain('CC0');
    expect(discogsCatalog.defaultSources[0].slug).toBe('discogs-catalog');
  });
});

describe('a walk', () => {
  /** Drive `pull` until the cursor says done, the way the scheduler would across runs. */
  async function runs(p, dir, cursor = {}, max = 8) {
    const out = [];
    for (let i = 0; i < max; i += 1) {
      const r = await run(p, { dir, cursor });
      out.push(r);
      cursor = r.cursor;
      if (cursor?.done) break;
    }
    return out;
  }

  test('one request a run: download, checksum list, walk; the second file the same way; then the pass is complete', async () => {
    const dir = freshDir();
    const p = provider();
    const [first, second, third, fourth] = await runs(p, dir);
    // Three requests for the month, one a run, in this order; runs 2 and 3 walk.
    expect(p.requests).toEqual([
      fileName(MONTH, 'artists'),
      checksumName(MONTH),
      fileName(MONTH, 'masters'),
    ]);
    // Run 1 spends its one request on the artists file and stops there.
    expect(p.uas.every((ua) => ua?.includes('discogs-catalog'))).toBe(true);
    expect(first.items).toEqual([]);
    expect(first.cursor).toMatchObject({ month: MONTH, entity: 'artists', recordIndex: 0 });
    expect(first.nextInMinutes).toBe(10);
    expect(first.note).toContain('checksum list');
    expect(await exists(join(dir, fileName(MONTH, 'artists')))).toBe(true);

    // Run 2: the checksum list, the file verified, walked to the end; masters wait.
    expect(p.requests[1]).toBe(checksumName(MONTH));
    expect(second.batches).toHaveLength(1);
    expect(second.items.map((i) => i.externalId)).toEqual(
      ARTIST_IDS.map((id) => `discogs:artist:${id}`),
    );
    expect(second.batches[0].cursor).toMatchObject({
      month: MONTH,
      entity: 'artists',
      recordIndex: 40,
    });
    expect(second.cursor).toMatchObject({
      month: MONTH,
      entity: 'masters',
      recordIndex: 0,
      verified: ['artists'],
    });
    expect(second.cursor.checksums[fileName(MONTH, 'artists')]).toBe(
      sha256(p.bodies[fileName(MONTH, 'artists')]),
    );
    expect(second.nextInMinutes).toBe(10);
    expect(second.note).toContain('one request a run');

    // Run 3: the masters file is the one request; the list is already in the
    // cursor, so the same run verifies it, walks it and completes the pass.
    expect(p.requests[2]).toBe(fileName(MONTH, 'masters'));
    expect(p.requests).toHaveLength(3);
    expect(third.items.map((i) => i.externalId)).toEqual([
      'discogs:master:18500',
      'discogs:master:18512',
      'discogs:master:18520',
    ]);
    expect(third.cursor).toMatchObject({
      month: MONTH,
      entity: 'masters',
      recordIndex: 3,
      done: true,
    });
    expect(third.cursor.verified).toEqual(['artists', 'masters']);
    expect(third.note).toContain('complete');
    expect(third.nextInMinutes).toBeGreaterThanOrEqual(60);
    expect(fourth).toBeUndefined();

    // Another run this month asks nothing and waits for the next dump.
    const again = await run(p, { dir, cursor: third.cursor });
    expect(p.requests).toHaveLength(3);
    expect(again.items).toEqual([]);
    expect(again.note).toContain('unchanged');
    expect(again.cursor.done).toBe(true);
  });

  /** Files on disk and verified, so nothing stands between the deadline and the walk. */
  async function onDisk(dir, p) {
    await Bun.write(join(dir, fileName(MONTH, 'artists')), p.bodies[fileName(MONTH, 'artists')]);
    await Bun.write(join(dir, fileName(MONTH, 'masters')), p.bodies[fileName(MONTH, 'masters')]);
    return {
      month: MONTH,
      entity: 'artists',
      recordIndex: 0,
      verified: ['artists', 'masters'],
      checksums: {},
    };
  }

  test('a deadline already passed yields nothing and asks for ten minutes', async () => {
    const dir = freshDir();
    const p = provider({ artists: bigArtists(30) });
    const verified = await onDisk(dir, p);
    const out = await run(p, { dir, cursor: verified, deadline: Date.now() - 1 });
    expect(p.requests).toEqual([]);
    expect(out.batches).toEqual([]);
    expect(out.cursor).toMatchObject({ entity: 'artists', recordIndex: 0 });
    expect(out.nextInMinutes).toBe(10);
    expect(out.note).toContain('deadline');
  });

  test('the deadline stops a run after a batch and the next run resumes at that record', async () => {
    const dir = freshDir();
    const big = bigArtists(30); // 1,200 records: two full batches and a tail
    const p = provider({ artists: big });
    const verified = await onDisk(dir, p);

    // A clock that jumps a minute per reading: the walk starts inside the
    // deadline and the first batch lands past it.
    const realNow = Date.now;
    const base = realNow();
    let ticks = 0;
    Date.now = () => {
      ticks += 1;
      return base + ticks * 60_000;
    };
    let first;
    try {
      first = await run(p, { dir, cursor: verified, deadline: base + 90_000 });
    } finally {
      Date.now = realNow;
    }
    expect(p.requests).toEqual([]);
    expect(first.batches).toHaveLength(1);
    expect(first.items).toHaveLength(500);
    expect(first.cursor).toMatchObject({ entity: 'artists', recordIndex: 500 });
    expect(first.nextInMinutes).toBe(10);
    expect(first.note).toContain('deadline');

    const second = await run(p, { dir, cursor: first.cursor });
    expect(p.requests).toEqual([]);
    // Record 501 is the 21st record of the 13th copy.
    const expected = ARTIST_IDS[20] + 12 * 100000;
    expect(second.items[0].externalId).toBe(`discogs:artist:${expected}`);
    expect(second.items.filter((i) => i.kind === 'artist')).toHaveLength(700);
    expect(second.items.filter((i) => i.kind === 'master')).toHaveLength(3);
    expect(second.batches.map((b) => b.cursor.recordIndex)).toEqual([1000, 1200, 3]);
    expect(second.cursor).toMatchObject({ entity: 'masters', recordIndex: 3, done: true });
  });

  test('a download the server cut short yields nothing, leaves no file, and tries again in ten minutes', async () => {
    const dir = freshDir();
    const p = provider({ modes: { [fileName(MONTH, 'artists')]: 'short' } });
    const out = await run(p, { dir });
    expect(out.items).toEqual([]);
    expect(out.cursor).toMatchObject({ month: MONTH, entity: 'artists', recordIndex: 0 });
    expect(out.nextInMinutes).toBe(10);
    expect(out.note).toContain('incomplete');
    expect(await exists(join(dir, fileName(MONTH, 'artists')))).toBe(false);
    expect(await exists(join(dir, `${fileName(MONTH, 'artists')}.part`))).toBe(false);
    expect(p.requests).toHaveLength(1);
  });

  test('a 429 schedules the next run past retry-after and keeps the place', async () => {
    const dir = freshDir();
    const p = provider({ modes: { [fileName(MONTH, 'masters')]: '429' } });
    const cursor = {
      month: MONTH,
      entity: 'masters',
      recordIndex: 0,
      verified: ['artists'],
      checksums: {},
    };
    const out = await run(p, { dir, cursor });
    expect(out.items).toEqual([]);
    expect(out.nextInMinutes).toBe(58);
    expect(out.cursor).toMatchObject({
      month: MONTH,
      entity: 'masters',
      recordIndex: 0,
      verified: ['artists'],
    });
    expect(out.note).toContain('rate limited');
    expect(p.requests).toHaveLength(1);

    // The checksum list rate limited the same way, with no retry-after: an hour and two.
    const p2 = provider({
      modes: {
        [checksumName(MONTH)]: () => new Response('slow down', { status: 429 }),
      },
    });
    await Bun.write(join(dir, fileName(MONTH, 'masters')), p2.bodies[fileName(MONTH, 'masters')]);
    const listed = await run(p2, { dir, cursor: { ...cursor, checksums: null } });
    expect(p2.requests).toEqual([checksumName(MONTH)]);
    expect(listed.items).toEqual([]);
    expect(listed.nextInMinutes).toBe(62);
  });

  test('a month whose file is not published yet starts the new month at record 0 and looks again in six hours', async () => {
    const dir = freshDir();
    const p = provider({ modes: { [fileName(MONTH, 'artists')]: '404' } });
    const old = { month: '20250101', entity: 'masters', recordIndex: 9, done: true };
    const out = await run(p, { dir, cursor: old });
    expect(out.items).toEqual([]);
    expect(out.cursor).toMatchObject({ month: MONTH, entity: 'artists', recordIndex: 0 });
    expect(out.cursor.done).toBeFalsy();
    expect(out.nextInMinutes).toBe(360);
    expect(out.note).toContain('not published');
  });

  test('a 404 on the second file never steps the cursor back behind batches already saved', async () => {
    const dir = freshDir();
    const p = provider({
      artists: bigArtists(3),
      modes: { [fileName(MONTH, 'masters')]: '404' },
    });
    await Bun.write(join(dir, fileName(MONTH, 'artists')), p.bodies[fileName(MONTH, 'artists')]);
    const prev = {
      month: MONTH,
      entity: 'artists',
      recordIndex: 40,
      verified: ['artists'],
      checksums: {},
    };
    const out = await run(p, { dir, cursor: prev });
    expect(out.items).toHaveLength(80);
    expect(out.batches[0].cursor).toMatchObject({ entity: 'artists', recordIndex: 120 });
    expect(p.requests).toEqual([fileName(MONTH, 'masters')]);
    expect(out.cursor).toMatchObject({ month: MONTH, entity: 'masters', recordIndex: 0 });
    expect(out.nextInMinutes).toBe(360);
    // And the next run walks nothing of artists again.
    const next = await run(p, { dir, cursor: out.cursor });
    expect(next.items).toEqual([]);
    expect(next.cursor).toMatchObject({ entity: 'masters', recordIndex: 0 });
  });

  test('a bad record is skipped and counted; the rest of the file is written', async () => {
    const dir = freshDir();
    const broken = artistsXml.replace(
      '</artists>',
      '<artist><name>No Id</name></artist>\n<artist><id>77</id></artist>\n<artist><id>78</id><name>After The Bad Ones</name></artist>\n</artists>',
    );
    const p = provider({ artists: broken });
    const notes = [];
    const [, out] = await runs(p, dir, {}, 2);
    expect(out.items).toHaveLength(41);
    expect(out.items.at(-1).externalId).toBe('discogs:artist:78');
    expect(out.batches[0].cursor.recordIndex).toBe(43);
    expect(out.note).toContain('2 records skipped');
    expect(notes).toEqual([]);
  });

  test('a checksum that does not match discards the file; the next run downloads it again', async () => {
    const dir = freshDir();
    const p = provider({ checksums: `${'0'.repeat(64)}  ${fileName(MONTH, 'artists')}` });
    const [, out] = await runs(p, dir, {}, 2);
    expect(out.items).toEqual([]);
    expect(out.nextInMinutes).toBe(10);
    expect(out.note).toContain('checksum');
    expect(await exists(join(dir, fileName(MONTH, 'artists')))).toBe(false);
    expect(out.cursor.checksums[fileName(MONTH, 'artists')]).toBe('0'.repeat(64));
    expect(out.cursor.verified).toEqual([]);

    // The list is remembered; the next run spends its one request on the file again.
    const again = await run(p, { dir, cursor: out.cursor });
    expect(p.requests).toEqual([
      fileName(MONTH, 'artists'),
      checksumName(MONTH),
      fileName(MONTH, 'artists'),
    ]);
    expect(again.items).toEqual([]);
    expect(again.note).toContain('checksum');
  });

  test('a run whose only request fails throws and leaves the cursor alone', async () => {
    const dir = freshDir();
    const p = provider({ modes: { [fileName(MONTH, 'artists')]: 'throw' } });
    await expect(run(p, { dir })).rejects.toThrow(/every request failed \(1\)/);
    const p5 = provider({
      modes: { [fileName(MONTH, 'artists')]: () => new Response('down', { status: 503 }) },
    });
    await expect(run(p5, { dir })).rejects.toThrow(/503/);
    expect(await exists(join(dir, fileName(MONTH, 'artists')))).toBe(false);
  });

  test('too little budget left to download waits rather than starting a transfer it cannot finish', async () => {
    const dir = freshDir();
    const p = provider();
    const out = await run(p, { dir, deadline: Date.now() + 60_000 });
    expect(p.requests).toEqual([]);
    expect(out.items).toEqual([]);
    expect(out.nextInMinutes).toBe(10);
    expect(out.note).toContain('budget');
  });

  test('a new month clears last month files and any partial from the cache', async () => {
    const dir = freshDir();
    const p = provider();
    await Bun.write(join(dir, 'discogs_20250101_artists.xml.gz'), 'old');
    await Bun.write(join(dir, `${fileName(MONTH, 'masters')}.part`), 'half');
    await writeFile(join(dir, 'unrelated.txt'), 'keep');
    const [first, second] = await runs(p, dir, { month: '20250101', done: true }, 2);
    expect(first.cursor).toMatchObject({ month: MONTH, entity: 'artists', recordIndex: 0 });
    expect(second.items).toHaveLength(40);
    expect(await exists(join(dir, 'discogs_20250101_artists.xml.gz'))).toBe(false);
    expect(await exists(join(dir, `${fileName(MONTH, 'masters')}.part`))).toBe(false);
    expect(await exists(join(dir, 'unrelated.txt'))).toBe(true);
  });
});
