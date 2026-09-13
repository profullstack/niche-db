import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * MusicBrainz's JSON dumps, walked a batch at a time.
 *
 * The fixtures are real bytes: `instrument.tar.xz` exactly as MetaBrainz
 * serves it (the smallest dump, 468 KB), and the first 200 rows of the real
 * artist and release-group members, cut out of a Range GET of each archive's
 * first 2 MB and re-packed as tar.xz with the same member names and the same
 * missing final newline. The walk runs against a fake `http` whose download
 * copies a fixture into a temp dump directory, so what is under test is the
 * adapter's cursor, its deadline, its resume and its mapping, not the network.
 */
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';

const {
  ATTRIBUTION,
  BATCH_SIZE,
  BUDGET_MS,
  ENTITIES,
  LATEST_URL,
  NEAR_MS,
  USER_AGENT,
  artistCredit,
  artistItem,
  creditText,
  dumpUrl,
  localFile,
  memberOf,
  musicbrainzCatalog,
  nextEntity,
  parseLatest,
  parseRow,
  pruneOthers,
  releaseGroupItem,
  resumeFrom,
  toItem,
  walk,
} = await import('../packages/adapters/src/musicbrainz-catalog.js');
const { normaliseItem } = await import('../packages/core/src/adapter.js');
const { xzLines } = await import('../packages/core/src/dump.js');

const FIXTURES = new URL('../packages/adapters/test/fixtures/', import.meta.url).pathname;
const fixture = (entity) => join(FIXTURES, `musicbrainz-catalog-${entity}-200.tar.xz`);
const INSTRUMENT = join(FIXTURES, 'musicbrainz-catalog-instrument.tar.xz');

const DIR = '20260912-001001';
const NEWER = '20260915-001001';

let tmp;
let rows;

const collect = async (it) => {
  const out = [];
  for await (const x of it) out.push(x);
  return out;
};

/** The first few real rows of each member, parsed. */
async function firstRows(entity, n) {
  const out = [];
  for await (const line of xzLines(fixture(entity), { member: memberOf(entity) })) {
    out.push(JSON.parse(line));
    if (out.length >= n) break;
  }
  return out;
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'nichedb-mb-catalog-'));
  rows = {
    artist: await firstRows('artist', 3),
    'release-group': await firstRows('release-group', 3),
  };
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/**
 * A stand-in for the core's http. `latest` is what LATEST answers (a function
 * may throw); `files` maps an entity to the archive a download copies into
 * place, or to `{ partial }` for a download that is not done, or to a
 * function that throws.
 */
function provider({ latest = DIR, files = {} } = {}) {
  const calls = { text: [], download: [] };
  const archives = {
    artist: fixture('artist'),
    'release-group': fixture('release-group'),
    ...files,
  };
  return {
    calls,
    http: {
      async text(url, opts) {
        calls.text.push({ url, headers: opts?.headers ?? {} });
        return typeof latest === 'function' ? latest() : `${latest}\n`;
      },
      async download(url, filePath, opts) {
        calls.download.push({ url, filePath, headers: opts?.headers ?? {} });
        const entity = ENTITIES.find((e) => url.endsWith(`/${e}.tar.xz`));
        const src = archives[entity];
        if (typeof src === 'function') return src(filePath);
        if (src && typeof src === 'object' && src.partial) {
          await writeFile(filePath, Buffer.alloc(src.partial));
          return { path: filePath, bytes: src.partial, complete: false };
        }
        await copyFile(src, filePath);
        return { path: filePath, bytes: (await readFile(filePath)).length, complete: true };
      },
    },
  };
}

const ctx = (
  p,
  { cursor = {}, deadline = Number.POSITIVE_INFINITY, batchSize = BATCH_SIZE } = {},
) => ({
  config: { batchSize },
  cursor,
  env: {},
  http: p.http,
  log: () => {},
  deadline,
});

/** Drain a walk by hand, keeping its return value the way the core does. */
async function drain(gen) {
  const batches = [];
  const it = gen[Symbol.asyncIterator]();
  for (;;) {
    const { value, done } = await it.next();
    if (done) return { batches, outcome: value };
    batches.push(value);
  }
}

const run = (p, opts = {}, seam = {}) =>
  drain(walk(ctx(p, opts), { dataDir: seam.dataDir ?? tmp, pauseMs: 0, ...seam }));

describe('the fixtures are real dump bytes', () => {
  test('instrument.tar.xz as served: 1058 JSON rows, the last one without a newline, none of them an item here', async () => {
    const lines = await collect(xzLines(INSTRUMENT, { member: memberOf('instrument') }));
    expect(lines).toHaveLength(1058);
    for (const l of lines) expect(typeof JSON.parse(l).id).toBe('string');
    expect(lines.at(-1)).toMatch(/\}$/);
    expect(toItem('instrument', parseRow(lines[0]))).toBeNull();
  });

  test('the artist and release-group members hold 200 rows each with the fields the dump carries', async () => {
    for (const entity of ENTITIES) {
      const lines = await collect(xzLines(fixture(entity), { member: memberOf(entity) }));
      expect(lines).toHaveLength(200);
    }
    const a = rows.artist[0];
    for (const k of [
      'id',
      'name',
      'sort-name',
      'life-span',
      'aliases',
      'relations',
      'tags',
      'genres',
      'rating',
      'annotation',
    ]) {
      expect(a).toHaveProperty(k);
    }
    const g = rows['release-group'][0];
    for (const k of [
      'id',
      'title',
      'artist-credit',
      'primary-type',
      'secondary-types',
      'first-release-date',
      'tags',
      'genres',
      'rating',
    ]) {
      expect(g).toHaveProperty(k);
    }
  });
});

describe('items', () => {
  test('an artist row: MusicBrainz id in the external id, the CC0 fields kept, the CC BY-NC-SA fields and relations dropped', () => {
    const a = rows.artist[0];
    const item = artistItem(a);
    expect(item.externalId).toBe(`musicbrainz:artist:${a.id}`);
    expect(item.kind).toBe('artist');
    expect(item.title).toBe(a.name);
    expect(item.summary).toBe(a.disambiguation || null);
    expect(item.url).toBe(`https://musicbrainz.org/artist/${a.id}`);
    expect(item.imageUrl).toBeNull();
    expect(item.tags).toContain('artist');
    expect(item.tags).toContain('musicbrainz');
    expect(item.tags).toContain(`type:${a.type.toLowerCase()}`);
    expect(item.tags).toContain(`country:${a.country.toLowerCase()}`);
    expect(item.data).toMatchObject({
      mbid: a.id,
      sortName: a['sort-name'],
      type: a.type,
      gender: a.gender,
      country: a.country,
      area: a.area.name,
      beginArea: a['begin-area'].name,
      lifeSpan: { begin: a['life-span'].begin, end: a['life-span'].end, ended: false },
      attribution: ATTRIBUTION,
    });
    expect(item.data.aliases).toEqual([...new Set(a.aliases.map((x) => x.name))]);
    expect(item.data.isnis).toEqual(a.isnis);
    expect(item.data.ipis).toEqual(a.ipis);
    for (const k of ['tags', 'genres', 'rating', 'annotation', 'relations']) {
      expect(item.data).not.toHaveProperty(k);
    }
    expect(JSON.stringify(item)).not.toContain('"relations"');
    const stored = normaliseItem(item);
    expect(stored.externalId).toBe(item.externalId);
    expect(stored.data.attribution).toBe('MusicBrainz, CC0');
  });

  test('a release group row: title, credit, types, first release date as a loose date, Cover Art Archive front', () => {
    const g = rows['release-group'][0];
    const item = releaseGroupItem(g);
    expect(item.externalId).toBe(`musicbrainz:release-group:${g.id}`);
    expect(item.kind).toBe('release-group');
    expect(item.title).toBe(g.title);
    expect(item.summary).toBe(`by ${creditText(g['artist-credit'])}`);
    expect(item.url).toBe(`https://musicbrainz.org/release-group/${g.id}`);
    expect(item.imageUrl).toBe(`https://coverartarchive.org/release-group/${g.id}/front-250`);
    expect(item.tags).toEqual(
      expect.arrayContaining([
        'release-group',
        'musicbrainz',
        `type:${g['primary-type'].toLowerCase()}`,
        ...g['secondary-types'].map((s) => `secondary:${s.toLowerCase()}`),
      ]),
    );
    expect(item.data).toEqual({
      mbid: g.id,
      primaryType: g['primary-type'],
      secondaryTypes: g['secondary-types'],
      firstReleaseDate: g['first-release-date'],
      artistCredit: g['artist-credit'].map((c) => ({ name: c.name, mbid: c.artist.id })),
      attribution: ATTRIBUTION,
    });
    // "1979" is a year: the date lands mid-year at year precision.
    expect(g['first-release-date']).toBe('1979');
    expect(item.precision).toBe('year');
    expect(item.publishedAt.toISOString()).toBe('1979-07-01T12:00:00.000Z');
    expect(item.timeKnown).toBe(false);
    expect(normaliseItem(item)).not.toBeNull();
  });

  test('credits: join phrases read on the sleeve, ids ride along, rubbish is ignored', () => {
    const credit = [
      { name: 'Simon', joinphrase: ' & ', artist: { id: 'a1', name: 'Paul Simon' } },
      { name: 'Garfunkel', joinphrase: '', artist: { id: 'a2', name: 'Art Garfunkel' } },
      { junk: true },
    ];
    expect(creditText(credit)).toBe('Simon & Garfunkel');
    expect(artistCredit(credit)).toEqual([
      { name: 'Simon', mbid: 'a1' },
      { name: 'Garfunkel', mbid: 'a2' },
    ]);
    expect(creditText(null)).toBeNull();
    expect(artistCredit('no')).toEqual([]);
  });

  test('rows that are not entities map to nothing', () => {
    expect(artistItem({ id: 'x' })).toBeNull();
    expect(artistItem({ name: 'x' })).toBeNull();
    expect(releaseGroupItem({ id: 'x', title: '' })).toBeNull();
    expect(toItem('artist', null)).toBeNull();
    expect(toItem('label', { id: 'x', name: 'y' })).toBeNull();
    expect(parseRow('not json')).toBeNull();
    expect(parseRow('[1,2]')).toBeNull();
    expect(parseRow('')).toBeNull();
    expect(parseRow('{"id":"x"}')).toEqual({ id: 'x' });
  });

  test('an artist with no type or country carries neither tag and empty lists', () => {
    const item = artistItem({ id: 'abc', name: 'Nobody', type: null, country: null });
    expect(item.tags).toEqual(['artist', 'musicbrainz']);
    expect(item.data.aliases).toEqual([]);
    expect(item.data.lifeSpan).toEqual({ begin: null, end: null, ended: false });
  });
});

describe('pure pieces', () => {
  test('LATEST', () => {
    expect(parseLatest('20260912-001001\n')).toBe('20260912-001001');
    expect(parseLatest('  \n20260912-001001')).toBe('20260912-001001');
    expect(parseLatest('<html>')).toBeNull();
    expect(parseLatest('')).toBeNull();
    expect(parseLatest(null)).toBeNull();
  });

  test('urls and files', () => {
    expect(dumpUrl(DIR, 'artist')).toBe(
      'https://data.metabrainz.org/pub/musicbrainz/data/json-dumps/20260912-001001/artist.tar.xz',
    );
    expect(memberOf('release-group')).toBe('mbdump/release-group');
    expect(localFile('/d', DIR, 'artist')).toBe('/d/20260912-001001-artist.tar.xz');
    expect(nextEntity('artist')).toBe('release-group');
    expect(nextEntity('release-group')).toBeNull();
  });

  test('resume: same dump keeps the place, another dump restarts, done holds only for the same dump', () => {
    expect(resumeFrom({}, DIR)).toEqual({ dir: DIR, entity: 'artist', line: 0, done: false });
    expect(resumeFrom({ dir: DIR, entity: 'release-group', line: 1200 }, DIR)).toEqual({
      dir: DIR,
      entity: 'release-group',
      line: 1200,
      done: false,
    });
    expect(resumeFrom({ dir: DIR, entity: 'release-group', line: 99, done: true }, DIR).done).toBe(
      true,
    );
    expect(resumeFrom({ dir: DIR, entity: 'release-group', line: 99, done: true }, NEWER)).toEqual({
      dir: NEWER,
      entity: 'artist',
      line: 0,
      done: false,
    });
    expect(resumeFrom({ dir: DIR, entity: 'label', line: -4 }, DIR)).toEqual({
      dir: DIR,
      entity: 'artist',
      line: 0,
      done: false,
    });
  });

  test('pruning keeps the current dump and removes the others', async () => {
    const d = await mkdtemp(join(tmp, 'prune-'));
    await writeFile(join(d, `${DIR}-artist.tar.xz`), 'a');
    await writeFile(join(d, `${NEWER}-artist.tar.xz`), 'b');
    await writeFile(join(d, `${NEWER}-release-group.tar.xz`), 'c');
    await writeFile(join(d, 'notes.txt'), 'd');
    expect(await pruneOthers(d, DIR)).toBe(2);
    expect(await readFile(join(d, `${DIR}-artist.tar.xz`), 'utf8')).toBe('a');
    expect(await readFile(join(d, 'notes.txt'), 'utf8')).toBe('d');
  });
});

describe('the walk', () => {
  test('batches carry the cursor after their rows, a run stops near its deadline, the next run resumes there and finishes both entities', async () => {
    const d = await mkdtemp(join(tmp, 'walk-'));
    const p = provider();
    let t = 0;
    const now = () => t;

    // Run 1: the clock is far from the deadline until the first batch is out.
    const it = walk(ctx(p, { batchSize: 80, deadline: NEAR_MS + 1 }), {
      dataDir: d,
      pauseMs: 0,
      now,
    })[Symbol.asyncIterator]();
    const first = await it.next();
    expect(first.done).toBe(false);
    expect(first.value.items).toHaveLength(80);
    expect(first.value.items[0].externalId).toBe(`musicbrainz:artist:${rows.artist[0].id}`);
    expect(first.value.cursor).toEqual({ dir: DIR, entity: 'artist', line: 80 });
    t = NEAR_MS + 2;
    const stop = await it.next();
    expect(stop.done).toBe(true);
    expect(stop.value.cursor).toEqual({ dir: DIR, entity: 'artist', line: 80 });
    expect(stop.value.nextInMinutes).toBe(10);
    expect(stop.value.note).toContain('deadline');
    expect(p.calls.download).toHaveLength(1);
    expect(p.calls.download[0].url).toBe(dumpUrl(DIR, 'artist'));
    expect(p.calls.download[0].filePath).toBe(localFile(d, DIR, 'artist'));

    // Run 2: from line 80, through the rest of the artists and all the release groups.
    const second = await run(p, { batchSize: 80, cursor: stop.value.cursor }, { dataDir: d });
    expect(second.batches.map((b) => [b.cursor.entity, b.items.length, b.cursor.line])).toEqual([
      ['artist', 80, 160],
      ['artist', 40, 200],
      ['release-group', 80, 80],
      ['release-group', 80, 160],
      ['release-group', 40, 200],
    ]);
    expect(second.batches[0].items[0].externalId).not.toBe(first.value.items[0].externalId);
    expect(second.batches[2].items[0].externalId).toBe(
      `musicbrainz:release-group:${rows['release-group'][0].id}`,
    );
    expect(second.outcome.cursor).toEqual({
      dir: DIR,
      entity: 'release-group',
      line: 200,
      done: true,
    });
    expect(second.outcome.nextInMinutes).toBeUndefined();
    expect(second.outcome.note).toContain('walked');
    // The artist archive is asked for again (a whole file on disk is one Range
    // request answered 416, which http.download reports complete), then the
    // release-group one.
    expect(p.calls.download.slice(1).map((c) => c.url)).toEqual([
      dumpUrl(DIR, 'artist'),
      dumpUrl(DIR, 'release-group'),
    ]);

    // Run 3: same LATEST, done cursor: nothing read, nothing fetched.
    const third = await run(p, { cursor: second.outcome.cursor }, { dataDir: d });
    expect(third.batches).toEqual([]);
    expect(third.outcome).toEqual({ cursor: second.outcome.cursor, note: 'unchanged' });
    expect(p.calls.download).toHaveLength(3);

    // Run 4: a new dump restarts at the first artist line and the old archives go.
    const p2 = provider({ latest: NEWER });
    const fourth = await run(p2, { cursor: second.outcome.cursor }, { dataDir: d });
    expect(fourth.batches[0].cursor).toEqual({ dir: NEWER, entity: 'artist', line: 200 });
    expect(fourth.batches[0].items).toHaveLength(200);
    expect(p2.calls.download[0].url).toBe(dumpUrl(NEWER, 'artist'));
    await expect(readFile(localFile(d, DIR, 'artist'))).rejects.toThrow();
  });

  test('every item of a whole run is one the table would store, and no row holds the CC BY-NC-SA fields', async () => {
    const d = await mkdtemp(join(tmp, 'store-'));
    const { batches } = await run(provider(), {}, { dataDir: d });
    const items = batches.flatMap((b) => b.items);
    expect(items).toHaveLength(400);
    expect(new Set(items.map((i) => i.externalId)).size).toBe(400);
    for (const it of items) {
      const stored = normaliseItem(it);
      expect(stored).not.toBeNull();
      expect(stored.data.attribution).toBe(ATTRIBUTION);
      expect(stored.data).not.toHaveProperty('tags');
      expect(stored.data).not.toHaveProperty('genres');
      expect(stored.data).not.toHaveProperty('rating');
      expect(stored.data).not.toHaveProperty('annotation');
    }
    expect(items.filter((i) => i.kind === 'artist')).toHaveLength(200);
    expect(items.filter((i) => i.kind === 'release-group')).toHaveLength(200);
  });

  test('a download still in progress yields nothing and asks to resume in ten minutes', async () => {
    const d = await mkdtemp(join(tmp, 'partial-'));
    const p = provider({ files: { artist: { partial: 4096 } } });
    const { batches, outcome } = await run(p, {}, { dataDir: d });
    expect(batches).toEqual([]);
    expect(outcome.cursor).toEqual({ dir: DIR, entity: 'artist', line: 0 });
    expect(outcome.nextInMinutes).toBe(10);
    expect(outcome.note).toContain('download in progress');
    expect((await readFile(localFile(d, DIR, 'artist'))).length).toBe(4096);
  });

  test('a run that reaches its deadline while a second entity is still to be fetched keeps that place', async () => {
    const d = await mkdtemp(join(tmp, 'switch-'));
    const p = provider();
    let t = 0;
    const it = walk(ctx(p, { batchSize: 500, deadline: NEAR_MS + 1 }), {
      dataDir: d,
      pauseMs: 0,
      now: () => t,
    })[Symbol.asyncIterator]();
    const first = await it.next();
    expect(first.value.cursor).toEqual({ dir: DIR, entity: 'artist', line: 200 });
    t = NEAR_MS + 2;
    const stop = await it.next();
    expect(stop.done).toBe(true);
    expect(stop.value.cursor).toEqual({ dir: DIR, entity: 'release-group', line: 0 });
    expect(stop.value.nextInMinutes).toBe(10);
    expect(p.calls.download.map((c) => c.url)).toEqual([dumpUrl(DIR, 'artist')]);
  });

  test('a bad row is counted and skipped, never thrown; the line count still moves past it', async () => {
    const d = await mkdtemp(join(tmp, 'bad-'));
    const good = rows.artist.map((r) => JSON.stringify(r));
    const member = [good[0], 'this is not json', '', '[1,2,3]', '{"name":"no id"}', good[1]].join(
      '\n',
    );
    await mkdir(join(d, 'src', 'mbdump'), { recursive: true });
    await writeFile(join(d, 'src', 'mbdump', 'artist'), member);
    // The archive lives outside the dump directory, which the walk prunes.
    const archive = join(d, 'src', 'bad-artist.tar.xz');
    const proc = Bun.spawn(['tar', '-cJf', archive, '-C', join(d, 'src'), 'mbdump/artist']);
    expect(await proc.exited).toBe(0);
    await mkdir(join(d, 'data'));
    const p = provider({ files: { artist: archive } });
    const { batches, outcome } = await run(p, { batchSize: 500 }, { dataDir: join(d, 'data') });
    expect(batches[0].items.map((i) => i.data.mbid)).toEqual([
      rows.artist[0].id,
      rows.artist[1].id,
    ]);
    expect(batches[0].cursor).toEqual({ dir: DIR, entity: 'artist', line: 6 });
    expect(outcome.note).toContain('3 bad');
    expect(outcome.cursor.done).toBe(true);
  });

  test('every request carries the user agent', async () => {
    const d = await mkdtemp(join(tmp, 'ua-'));
    const p = provider();
    await run(p, {}, { dataDir: d });
    expect(p.calls.text[0].url).toBe(LATEST_URL);
    for (const c of [...p.calls.text, ...p.calls.download]) {
      expect(c.headers['user-agent']).toBe(USER_AGENT);
    }
  });
});

describe('failures', () => {
  test('LATEST failing three times is a run in which every request failed, and it throws', async () => {
    const d = await mkdtemp(join(tmp, 'latest-'));
    const p = provider({
      latest: () => {
        throw new Error('503 from data.metabrainz.org');
      },
    });
    await expect(run(p, {}, { dataDir: d })).rejects.toThrow(/every request failed \(3\)/);
    expect(p.calls.text).toHaveLength(3);
    expect(p.calls.download).toHaveLength(0);
  });

  test('a LATEST that is not a directory name counts as a failure too', async () => {
    const d = await mkdtemp(join(tmp, 'latest2-'));
    const p = provider({ latest: '<html>maintenance</html>' });
    await expect(run(p, {}, { dataDir: d })).rejects.toThrow(/every request failed/);
  });

  test('a download failing three times in a row ends the run with the place kept and no throw', async () => {
    const d = await mkdtemp(join(tmp, 'dl-'));
    const p = provider({
      files: {
        artist: () => {
          throw new Error('socket hang up');
        },
      },
    });
    const cursor = { dir: DIR, entity: 'artist', line: 12_345 };
    const { batches, outcome } = await run(p, { cursor }, { dataDir: d });
    expect(batches).toEqual([]);
    expect(outcome.cursor).toEqual(cursor);
    expect(outcome.nextInMinutes).toBe(10);
    expect(outcome.note).toContain('failed 3 times');
    expect(p.calls.download).toHaveLength(3);
  });

  test('a download that fails twice and then lands resets the streak and the walk goes on', async () => {
    const d = await mkdtemp(join(tmp, 'dl2-'));
    let tries = 0;
    const p = provider({
      files: {
        artist: async (filePath) => {
          tries += 1;
          if (tries < 3) throw new Error('reset by peer');
          await copyFile(fixture('artist'), filePath);
          return { path: filePath, bytes: 1, complete: true };
        },
      },
    });
    const { batches, outcome } = await run(p, {}, { dataDir: d });
    expect(tries).toBe(3);
    expect(batches[0].items).toHaveLength(200);
    expect(outcome.cursor.done).toBe(true);
  });
});

describe('the adapter', () => {
  test('declares what the core needs and says the licence', async () => {
    expect(musicbrainzCatalog.name).toBe('musicbrainz-catalog');
    expect(musicbrainzCatalog.collection).toBe('music');
    expect(musicbrainzCatalog.kinds).toEqual(['artist', 'release-group']);
    expect(musicbrainzCatalog.budgetMs).toBe(BUDGET_MS);
    expect(BUDGET_MS).toBe(55 * 60_000);
    expect(musicbrainzCatalog.cadenceMinutes).toBe(10_080);
    expect(musicbrainzCatalog.defaultSources[0].slug).toBe('musicbrainz-catalog');
    expect(musicbrainzCatalog.description).toContain('CC0');
    expect(musicbrainzCatalog.description).toContain('CC BY-NC-SA');
    expect(typeof musicbrainzCatalog.pull).toBe('function');
    const src = await readFile(
      new URL('../packages/adapters/src/musicbrainz-catalog.js', import.meta.url),
      'utf8',
    );
    expect(src).not.toContain(String.fromCharCode(0x2014));
  });

  test('pull is the walk: an async iterable the core can drain, and close before it starts', async () => {
    const p = provider();
    const out = musicbrainzCatalog.pull(ctx(p));
    expect(typeof out[Symbol.asyncIterator]).toBe('function');
    expect(typeof out.next).toBe('function');
    // Closed before its first step: nothing was asked of the network.
    expect(await out.return()).toEqual({ value: undefined, done: true });
    expect(p.calls.text).toHaveLength(0);
  });
});
