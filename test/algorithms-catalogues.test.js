import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

import {
  CADENCE_MINUTES as DADS_CADENCE,
  pageUrl as dadsPageUrl,
  KIND_BY_FLAG,
  kindOf,
  nistDads,
  parseTermPage,
  parseTermsArea,
  TERMS_URL,
  termItem,
} from '../packages/adapters/src/nist-dads.js';
import {
  datasetItem,
  isSpam,
  methodItem,
  CADENCE_MINUTES as PWC_CADENCE,
  parsePage,
  pwcArchive,
  pageUrl as pwcPageUrl,
} from '../packages/adapters/src/pwc-archive.js';
import {
  algorithmItem,
  bindings,
  pageQuery,
  ROOTS,
  CADENCE_MINUTES as WD_CADENCE,
  resumeFrom as wdResume,
  wikidataAlgorithms,
  wikidataDate,
} from '../packages/adapters/src/wikidata-algorithms.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

const fixture = (name) =>
  readFile(new URL(`../packages/adapters/test/fixtures/${name}`, import.meta.url), 'utf8');

const drain = async (gen) => {
  const batches = [];
  let result;
  for (;;) {
    const n = await gen.next();
    if (n.done) {
      result = n.value;
      break;
    }
    batches.push(n.value);
  }
  return { batches, result, items: batches.flatMap((b) => b.items) };
};

const ctx = (http, cursor = {}, config = {}) => ({
  config: { pauseMs: 0, ...config },
  cursor,
  http,
  log: () => {},
  deadline: Date.now() + 60_000,
});

describe('nist-dads', () => {
  test('the index lists every page once with its names, area and type letter', async () => {
    const terms = parseTermsArea(await fixture('nist-dads-terms-area.html'));
    expect(terms.length).toBeGreaterThan(1000);
    expect(new Set(terms.map((t) => t.file)).size).toBe(terms.length);
    const q = terms.find((t) => t.file === 'multikeyQuicksort.html');
    expect(q.names).toEqual(
      expect.arrayContaining(['multikey Quicksort', 'three-way radix quicksort']),
    );
    expect(q.flag).toBe('A');
    expect(q.area).toBeTruthy();
    const dfa = terms.find((t) => t.file === 'determFinitStateMach.html');
    expect(dfa.area).toBe('Automata and State Machines');
    expect(dfa.names.length).toBeGreaterThanOrEqual(2);
    expect(KIND_BY_FLAG[dfa.flag]).toBe('definition');
  });

  test('a page parses into definition, relations, note, author and implementations', async () => {
    const page = parseTermPage(await fixture('nist-dads-quicksort.html'));
    expect(page.title).toBe('quicksort');
    expect(page.type).toBe('algorithm');
    expect(page.definition).toMatch(/^Pick an element from the array \(the pivot\)/);
    expect(page.definition).not.toContain('<');
    expect(page.generalizations.map((l) => l.name)).toEqual([
      'in-place sort',
      'Las Vegas algorithm',
    ]);
    expect(page.generalizations[0].file).toBe('inplacesort.html');
    expect(page.specializations.map((l) => l.name)).toContain('introspective sort');
    expect(page.partOf.map((l) => l.name)).toEqual(['q sort']);
    expect(page.uses.map((l) => l.name)).toContain('divide and conquer');
    expect(page.seeAlso.map((l) => l.name)).toEqual(['external quicksort', 'dual-pivot quicksort']);
    expect(page.note).toMatch(/^Quicksort has running time/);
    expect(page.note).toContain('dual-pivot quicksort');
    expect(page.author).toBe('CM');
    expect(page.implementations.length).toBeGreaterThanOrEqual(3);
    expect(page.implementations[0].url).toMatch(/^https:\/\//);
    expect(page.moreInformation.length).toBeGreaterThan(0);
    const array = parseTermPage(await fixture('nist-dads-array.html'));
    expect(array.type).toBe('data structure');
    expect(kindOf(array, { flag: 'D' })).toBe('data-structure');
    expect(kindOf({ type: null }, { flag: 'T' })).toBe('technique');
    expect(kindOf({ type: null }, { flag: null })).toBe('definition');
    expect(parseTermPage('<html><body>Not Found</body></html>')).toBeNull();
  });

  test('an item keeps the graph, the aliases and the public-domain line', async () => {
    const terms = parseTermsArea(await fixture('nist-dads-terms-area.html'));
    const entry = terms.find((t) => t.file === 'quicksort.html');
    const item = termItem(parseTermPage(await fixture('nist-dads-quicksort.html')), entry);
    expect(item.externalId).toBe('quicksort');
    expect(item.kind).toBe('algorithm');
    expect(item.url).toBe('https://xlinux.nist.gov/dads/HTML/quicksort.html');
    expect(item.tags).toContain('nist');
    expect(item.tags).toContain('algorithm');
    expect(item.data.uses.map((l) => l.file)).toContain('partition.html');
    expect(item.data.license).toMatch(/public domain/);
    expect(item.publishedAt).toBeNull();
    expect(normaliseItem(item)).not.toBeNull();
  });

  test('a pull walks the index in order, yields batches with a cursor and rests a month after a pass', async () => {
    const index = await fixture('nist-dads-terms-area.html');
    const quicksort = await fixture('nist-dads-quicksort.html');
    const array = await fixture('nist-dads-array.html');
    const urls = [];
    const http = {
      async text(url) {
        urls.push(url);
        if (url === TERMS_URL) return index;
        if (url.endsWith('/broken.html')) throw new Error('boom');
        return url.includes('array') ? array : quicksort;
      },
    };
    const terms = parseTermsArea(index);
    const first = await drain(nistDads.pull(ctx(http, {}, { pagesPerRun: 60 })));
    expect(first.items.length).toBe(60);
    expect(first.batches.length).toBe(3);
    expect(first.batches[0].cursor.index).toBe(25);
    expect(first.result.cursor.index).toBe(60);
    expect(first.result.nextInMinutes).toBeUndefined();
    expect(urls[0]).toBe(TERMS_URL);
    expect(urls[1]).toBe(dadsPageUrl(terms[0].file));
    expect(first.items.every((i) => normaliseItem(i))).toBe(true);

    // resume from the cursor, all the way to the end of the index
    const rest = await drain(nistDads.pull(ctx(http, first.result.cursor, { pagesPerRun: 5000 })));
    expect(rest.items.length).toBe(terms.length - 60);
    expect(rest.result.nextInMinutes).toBe(DADS_CADENCE);
    expect(rest.result.cursor.index).toBe(0);
    expect(rest.result.cursor.passes).toBe(1);
  });

  test('three failures in a row stop the run and keep its place', async () => {
    const index =
      '<h2><a name="x">X</a></h2><li><a href="HTML/a.html">a</a> [<strong>A</strong>]</li><li><a href="HTML/b.html">b</a> [<strong>A</strong>]</li><li><a href="HTML/c.html">c</a> [<strong>A</strong>]</li><li><a href="HTML/d.html">d</a> [<strong>A</strong>]</li>';
    const http = {
      async text(url) {
        if (url === TERMS_URL) return index;
        throw new Error('503');
      },
    };
    const run = await drain(nistDads.pull(ctx(http)));
    expect(run.items).toEqual([]);
    expect(run.result.cursor.index).toBe(2);
    expect(run.result.nextInMinutes).toBeUndefined();
  });
});

describe('wikidata-algorithms', () => {
  test('the query pages by offset under the root and reads rows into items', async () => {
    const q = pageQuery('Q8366', 500, 500);
    expect(q).toContain('wdt:P279* wd:Q8366');
    expect(q).toContain('LIMIT 500 OFFSET 500');
    expect(q).toContain('P3752');
    const rows = bindings(JSON.parse(await fixture('wikidata-algorithms-page.json')));
    expect(rows.length).toBe(3);
    const buddy = algorithmItem(rows[0], ROOTS[0]);
    expect(buddy.externalId).toBe('Q1001112');
    expect(buddy.kind).toBe('algorithm');
    expect(buddy.title).toBe('Buddy memory allocation');
    expect(buddy.url).toBe('https://en.wikipedia.org/wiki/Buddy_memory_allocation');
    expect(buddy.data.discoverers).toEqual(['Harry Markowitz']);
    expect(buddy.data.classes).toEqual(['algorithm']);
    expect(buddy.data.license).toBe('CC0');
    expect(buddy.tags).toContain('wikidata');
    expect(normaliseItem(buddy)).not.toBeNull();
    const noWiki = algorithmItem(rows[2], ROOTS[1]);
    expect(noWiki.kind).toBe('data-structure');
    expect(noWiki.url).toBe('https://www.wikidata.org/wiki/Q100452164');
    expect(algorithmItem({ item: 'http://www.wikidata.org/entity/Q1' }, ROOTS[0])).toBeNull();
  });

  test('a Wikidata timestamp is read at the precision it carries', () => {
    expect(wikidataDate('1960-01-01T00:00:00Z')).toBe('1960');
    expect(wikidataDate('1960-05-01T00:00:00Z')).toBe('1960-05');
    expect(wikidataDate('1960-05-17T00:00:00Z')).toBe('1960-05-17');
    expect(wikidataDate(null)).toBeNull();
    const item = algorithmItem(
      { item: 'http://www.wikidata.org/entity/Q5', label: 'x', since: '1960-01-01T00:00:00Z' },
      ROOTS[0],
    );
    expect(item.precision).toBe('year');
    expect(item.data.inception).toBe('1960');
  });

  test('a pass walks both roots, moves the offset on a full page and rests a week', async () => {
    const body = JSON.parse(await fixture('wikidata-algorithms-page.json'));
    const asked = [];
    const http = {
      async request(url) {
        const query = new URL(url).searchParams.get('query');
        const root = query.match(/wd:(Q\d+) \./)[1];
        const offset = Number(query.match(/OFFSET (\d+)/)[1]);
        asked.push({ root, offset });
        // the algorithm root fills one page of 3 then answers a short one; the data-structure root is short at once
        const full = root === 'Q8366' && offset === 0;
        return new Response(JSON.stringify(full ? body : { results: { bindings: [] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    };
    const run = await drain(
      wikidataAlgorithms.pull(ctx(http, {}, { pageRows: 3, requestsPerRun: 10 })),
    );
    expect(asked).toEqual([
      { root: 'Q8366', offset: 0 },
      { root: 'Q8366', offset: 3 },
      { root: 'Q175263', offset: 0 },
    ]);
    expect(run.items.length).toBe(3);
    expect(run.result.nextInMinutes).toBe(WD_CADENCE);
    expect(run.result.cursor.passes).toBe(1);

    // a run capped mid-pass keeps root and offset
    const capped = await drain(
      wikidataAlgorithms.pull(ctx(http, {}, { pageRows: 3, requestsPerRun: 1 })),
    );
    expect(capped.result.cursor).toMatchObject({ root: 'algorithm', offset: 3 });
    expect(capped.result.nextInMinutes).toBeUndefined();
    expect(wdResume(capped.result.cursor)).toMatchObject({ rootIndex: 0, offset: 3 });
    expect(wdResume({ root: 'nope', offset: 9 })).toMatchObject({ rootIndex: 0, offset: 0 });
  });
});

describe('pwc-archive', () => {
  test('the spam the site died with is recognised and real methods are not', () => {
    expect(isSpam({ name: 'How to Speak Directly in Robinhood? Call +1-844-610-2676 Now' })).toBe(
      true,
    );
    expect(isSpam({ name: '[FaQ`s`HeLpline]What is the Seabourn refund policy?' })).toBe(true);
    expect(isSpam({ name: 'Assistance-How do I call people in Qatar?' })).toBe(true);
    expect(
      isSpam({ name: '24(×)7【guide!!】¿Cómo hablo con una persona en American Airlines?' }),
    ).toBe(true);
    expect(isSpam({ name: 'Nice Method', description: 'Ring us on +1→808→470→7107 today' })).toBe(
      true,
    );
    expect(isSpam({ name: '' })).toBe(true);
    expect(isSpam({ name: 'REM' })).toBe(false);
    expect(isSpam({ name: 'Neural Tangent Transfer' })).toBe(false);
    expect(
      isSpam({
        name: 'GPipe',
        description: 'Pipeline parallelism with 2048 x 2048 tiles on 8 devices',
      }),
    ).toBe(false);
    expect(isSpam({ name: 'Support Vector Machine' })).toBe(true); // the one the vocabulary costs; noted, accepted
    expect(isSpam({ name: 'Fixup Initialization' })).toBe(false);
  });

  test('a methods page keeps the catalogue and drops the spam; 2000 is not a year', async () => {
    const body = JSON.parse(await fixture('pwc-methods-rows-tail.json'));
    const page = parsePage(body, 'method');
    expect(page.rows).toBe(25);
    expect(page.total).toBe(8725);
    expect(page.spam).toBeGreaterThan(5);
    expect(page.items.length + page.spam).toBe(25);
    const gpipe = page.items.find((i) => i.title === 'GPipe');
    expect(gpipe.externalId).toBe('method:gpipe');
    expect(gpipe.kind).toBe('method');
    expect(gpipe.publishedAt).toBeUndefined();
    expect(gpipe.data.introducedYear).toBeNull();
    expect(gpipe.data.license).toBe('CC-BY-SA-4.0');
    expect(gpipe.tags).toContain('papers-with-code');
    expect(gpipe.data.areas.length).toBeGreaterThan(0);
    expect(page.items.every((i) => normaliseItem(i))).toBe(true);
    expect(page.items.some((i) => /\+1|call|refund/i.test(i.title))).toBe(false);
    const dated = methodItem({
      url: 'https://paperswithcode.com/method/relu',
      name: 'ReLU',
      introduced_year: 2011,
      collections: [],
    });
    expect(dated.precision).toBe('year');
    expect(dated.publishedAt.toISOString()).toBe('2011-07-01T12:00:00.000Z');
    expect(methodItem({ name: 'x' })).toBeNull();
  });

  test('a datasets page reads modalities, tasks, loaders and the date', async () => {
    const body = JSON.parse(await fixture('pwc-datasets-rows-head.json'));
    const page = parsePage(body, 'dataset');
    expect(page.total).toBe(15008);
    const mnist = page.items.find((i) => i.title === 'MNIST');
    expect(mnist.externalId).toBe('dataset:mnist');
    expect(mnist.kind).toBe('dataset');
    expect(mnist.url).toBe('http://yann.lecun.com/exdb/mnist/');
    expect(mnist.imageUrl).toMatch(/^https:\/\//);
    expect(mnist.precision).toBe('day');
    expect(mnist.data.modalities).toEqual(['Images']);
    expect(mnist.data.tasks).toContain('Image Classification');
    expect(mnist.data.dataLoaders[0].repo).toContain('huggingface/datasets');
    expect(mnist.data.numPapers).toBe(7651);
    expect(mnist.tags).toContain('images');
    expect(normaliseItem(mnist)).not.toBeNull();
    expect(
      datasetItem({ url: 'https://paperswithcode.com/dataset/x', name: 'X', image: 'None' })
        .imageUrl,
    ).toBeNull();
  });

  test('a pull pages the rows API by offset, resumes from the cursor and rests a month after the last page', async () => {
    const methods = JSON.parse(await fixture('pwc-methods-rows-tail.json'));
    const urls = [];
    const http = {
      async json(url) {
        urls.push(url);
        const offset = Number(new URL(url).searchParams.get('offset'));
        // pretend the archive is 125 rows: a full page of 100 (the tail rows padded), then the 25-row tail
        if (offset === 0) {
          const rows = Array.from({ length: 100 }, (_, i) => ({
            row: {
              ...methods.rows[i % 25].row,
              url: `https://paperswithcode.com/method/m${i}`,
              name: `Method ${i}`,
              description: 'A method.',
            },
          }));
          return { rows, num_rows_total: 125 };
        }
        return { ...methods, num_rows_total: 125 };
      },
    };
    const first = await drain(
      pwcArchive.pull(ctx(http, {}, { catalogue: 'methods', requestsPerRun: 1 })),
    );
    expect(urls[0]).toBe(pwcPageUrl('pwc-archive/methods', 0));
    expect(urls[0]).toContain('length=100');
    expect(first.items.length).toBe(100);
    expect(first.result.cursor).toMatchObject({ catalogue: 'methods', offset: 100, total: 125 });
    expect(first.result.nextInMinutes).toBeUndefined();

    const rest = await drain(
      pwcArchive.pull(ctx(http, first.result.cursor, { catalogue: 'methods', requestsPerRun: 5 })),
    );
    expect(urls[1]).toBe(pwcPageUrl('pwc-archive/methods', 100));
    expect(urls.length).toBe(2);
    expect(rest.items.length).toBeGreaterThan(0);
    expect(rest.result.nextInMinutes).toBe(PWC_CADENCE);
    expect(rest.result.cursor).toMatchObject({ catalogue: 'methods', offset: 0, passes: 1 });

    // a cursor from the other catalogue does not carry over
    const other = await drain(
      pwcArchive.pull(
        ctx(
          http,
          { catalogue: 'datasets', offset: 100 },
          { catalogue: 'methods', requestsPerRun: 1 },
        ),
      ),
    );
    expect(urls[2]).toBe(pwcPageUrl('pwc-archive/methods', 0));
    expect(other.result.cursor.offset).toBe(100);
  });
});
