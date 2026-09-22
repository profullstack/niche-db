import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

import {
  buildFilter,
  buildQuery,
  filterClauses,
  MAILTO,
  openalex,
  PAGES_PER_RUN,
  PER_PAGE,
  rebuildAbstract,
  shortId,
  todayUtc,
  USER_AGENT,
  workItem,
} from '../packages/adapters/src/openalex.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

const fixture = JSON.parse(
  await readFile(
    new URL('../packages/adapters/test/fixtures/openalex-works.json', import.meta.url),
    'utf8',
  ),
);

const TODAY = '2026-09-22';

/** A fake works API: page 1 answers `body`, every later page is empty. */
function provider(body = fixture) {
  const urls = [];
  const headers = [];
  const http = {
    async json(url, opts) {
      urls.push(url);
      headers.push(opts?.headers ?? {});
      const page = new URL(url).searchParams.get('page');
      return page === '1' ? body : { results: [] };
    },
  };
  return { http, urls, headers };
}

describe('openalex query', () => {
  test('carries mailto, the date ceiling, the search term and the field filter', () => {
    const url = buildQuery(openalex.defaultSources[0].config, TODAY);
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://api.openalex.org/works');
    expect(u.searchParams.get('mailto')).toBe(MAILTO);
    expect(u.searchParams.get('sort')).toBe('publication_date:desc');
    expect(u.searchParams.get('per-page')).toBe(String(PER_PAGE));
    expect(u.searchParams.get('page')).toBe('1');
    const filter = u.searchParams.get('filter');
    expect(filter).toBe(
      `primary_topic.field.id:17,title_and_abstract.search:algorithm,to_publication_date:${TODAY}`,
    );
    /* Encoded once: the raw query string carries no double-encoded percent. */
    expect(url).not.toContain('%25');
    expect(u.searchParams.get('select')).toContain('abstract_inverted_index');
  });

  test('the date ceiling is always there, even with no other clause', () => {
    expect(buildFilter({}, TODAY)).toBe(`to_publication_date:${TODAY}`);
    expect(buildFilter({ openAccessOnly: 'yes' }, TODAY)).toBe(
      `open_access.is_oa:true,to_publication_date:${TODAY}`,
    );
    expect(buildFilter({ filter: ' a:1 , ,b:2 ', search: 'sort' }, TODAY)).toBe(
      `a:1,b:2,title_and_abstract.search:sort,to_publication_date:${TODAY}`,
    );
    expect(filterClauses(undefined)).toEqual([]);
  });

  test('todayUtc is a UTC calendar day', () => {
    expect(todayUtc(new Date('2026-09-22T23:59:59Z'))).toBe('2026-09-22');
    expect(todayUtc(new Date('2026-09-22T00:00:01Z'))).toBe('2026-09-22');
  });

  test('a page number goes on the URL', () => {
    expect(new URL(buildQuery({}, TODAY, 3)).searchParams.get('page')).toBe('3');
  });
});

describe('openalex works', () => {
  test('an inverted index is rebuilt in position order', () => {
    expect(rebuildAbstract({ fun: [2], Sorting: [0], is: [1] })).toBe('Sorting is fun');
    expect(rebuildAbstract({ a: [0, 2], b: [1] })).toBe('a b a');
    expect(rebuildAbstract(null)).toBeNull();
    expect(rebuildAbstract({})).toBeNull();
  });

  test('shortId keeps the W id', () => {
    expect(shortId('https://openalex.org/W7213758545')).toBe('W7213758545');
    expect(shortId(null)).toBeNull();
  });

  test('a fixture work becomes a day-precision paper with topic, oa and authors', () => {
    const item = workItem(fixture.results[0]);
    expect(item.externalId).toBe('W7213758545');
    expect(item.kind).toBe('paper');
    expect(item.url).toBe('https://doi.org/10.61467/2007.1558.2027.v18i1.1464');
    expect(item.precision).toBe('day');
    expect(item.timeKnown).toBe(false);
    expect(item.publishedAt.toISOString()).toBe('2026-09-21T12:00:00.000Z');
    expect(item.summary.startsWith('This research devoelops and validates')).toBe(true);
    expect(item.summary.length).toBeLessThanOrEqual(1200);
    expect(item.tags).toEqual([
      'openalex',
      'scientific-research-and-technology',
      'computer-science-applications',
      'oa:diamond',
      'article',
    ]);
    expect(item.data.field).toBe('Computer Science');
    expect(item.data.oaUrl).toBe('https://doi.org/10.61467/2007.1558.2027.v18i1.1464');
    expect(item.data.authors.length).toBeGreaterThan(0);
    expect(item.data.citedBy).toBe(0);
  });

  test('a work with no doi links to OpenAlex, and one with no title is skipped', () => {
    const w = { ...fixture.results[0], doi: null };
    expect(workItem(w).url).toBe('https://openalex.org/W7213758545');
    expect(workItem({ ...w, title: '' })).toBeNull();
  });

  test('every fixture work passes normaliseItem', () => {
    for (const w of fixture.results) {
      const n = normaliseItem(workItem(w));
      expect(n).not.toBeNull();
      expect(n.kind).toBe('paper');
      expect(n.precision).toBe('day');
    }
  });
});

describe('openalex pull', () => {
  test('reads a short page once, dedupes by id, and identifies itself', async () => {
    const twice = { ...fixture, results: [...fixture.results, fixture.results[0]] };
    const { http, urls, headers } = provider(twice);
    const { items, note } = await openalex.pull({
      config: { ...openalex.defaults, ...openalex.defaultSources[0].config },
      http,
      log: () => {},
    });
    expect(items.map((i) => i.externalId)).toEqual(['W7213758545', 'W7213764490', 'W7213780729']);
    expect(note).toBe('3 works');
    /* Four rows is a short page, so page 2 is never asked for. */
    expect(urls.length).toBe(1);
    expect(headers[0]['user-agent']).toBe(USER_AGENT);
    expect(new URL(urls[0]).searchParams.get('filter')).toContain(
      `to_publication_date:${todayUtc()}`,
    );
  });

  test('a full page asks for the next, up to the run cap', async () => {
    const full = { results: Array.from({ length: PER_PAGE }, () => fixture.results[1]) };
    const urls = [];
    const http = {
      async json(url) {
        urls.push(url);
        return full;
      },
    };
    const { items } = await openalex.pull({ config: {}, http, log: () => {} });
    expect(urls.length).toBe(PAGES_PER_RUN);
    expect(items.length).toBe(1);
  });
});
