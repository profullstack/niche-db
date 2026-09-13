import { describe, expect, test } from 'bun:test';
import { ADAPTERS, adapterByName } from '../packages/adapters/src/index.js';
import {
  DEFAULT_BASE,
  describeRow,
  directoryItem,
  KINDS,
  outreachgraph,
  pageUrl,
} from '../packages/adapters/src/outreachgraph.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';
const { COLLECTIONS, DEFAULT_FEEDS } = await import('../packages/core/src/seed.js');

const FIRST = 'https://outreachgraph.com/api/v1/public/directory?limit=200';

const company = {
  id: 'co_acme',
  kind: 'company',
  name: 'Acme',
  url: 'https://acme.com',
  description: null,
  topics: ['SaaS', 'Postgres', 'bun'],
  country: null,
  openprofile: null,
  updated: '2026-09-13T04:00:00.000Z',
};

const site = {
  id: 'co_site',
  kind: 'site',
  name: 'example.org',
  url: 'https://example.org',
  description: null,
  topics: [],
  country: null,
  openprofile: null,
  updated: '2026-09-12T00:00:00.000Z',
};

const person = {
  id: 'per_ada',
  kind: 'person',
  name: 'Ada Lovelace',
  url: 'https://ada.example',
  description: 'Analyst at Analytical Engines',
  topics: ['computing', 'mathematics'],
  country: 'GB',
  openprofile: 'https://ada.example/.well-known/openprofile.md',
  updated: '2026-09-13T05:00:00.000Z',
};

describe('OutreachGraph public directory: where it is read', () => {
  test('the first page and a cursor page', () => {
    expect(pageUrl(DEFAULT_BASE)).toBe(FIRST);
    expect(pageUrl('https://outreachgraph.com/', 'abc')).toBe(`${FIRST}&cursor=abc`);
    expect(pageUrl('https://staging.example')).toBe(
      'https://staging.example/api/v1/public/directory?limit=200',
    );
  });
});

describe('OutreachGraph public directory: one row, one item', () => {
  test('a company: domain as url, industry and stack as topic tags, no description invented', () => {
    const item = normaliseItem(directoryItem(company));
    expect(item.externalId).toBe('outreachgraph:company:co_acme');
    expect(item.kind).toBe('company');
    expect(item.title).toBe('Acme');
    expect(item.url).toBe('https://acme.com');
    expect(item.summary).toBe('Acme, at acme.com.');
    expect(item.tags).toEqual(['kind:company', 'topic:saas', 'topic:postgres', 'topic:bun']);
    expect(item.publishedAt.toISOString()).toBe('2026-09-13T04:00:00.000Z');
    expect(item.data.row).toEqual(company);
    expect(item.data.attribution).toContain('outreachgraph.com');
  });

  test('a site is a site: no topics, no country, a plain line', () => {
    const item = normaliseItem(directoryItem(site));
    expect(item.kind).toBe('site');
    expect(item.summary).toBe('A site the crawler read at example.org.');
    expect(item.tags).toEqual(['kind:site']);
  });

  test('a self-published person: the openprofile tag and field, country lower-cased', () => {
    const item = normaliseItem(directoryItem(person));
    expect(item.externalId).toBe('outreachgraph:person:per_ada');
    expect(item.summary).toBe('Analyst at Analytical Engines');
    expect(item.tags).toEqual([
      'kind:person',
      'country:gb',
      'openprofile',
      'topic:computing',
      'topic:mathematics',
    ]);
    expect(item.data.openprofile).toBe('https://ada.example/.well-known/openprofile.md');
  });

  test('a person with no description gets one line that says why they are listed', () => {
    expect(describeRow({ ...person, description: null })).toBe(
      'Ada Lovelace publishes an OpenProfile.md.',
    );
    expect(describeRow({ ...person, description: null, openprofile: null })).toBe(
      'Ada Lovelace, whose profile and home page vouch for each other.',
    );
  });

  test('absent stays absent: no tag for a value the directory did not state', () => {
    const item = normaliseItem(directoryItem({ id: 'x', kind: 'company', name: 'X' }));
    expect(item.tags).toEqual(['kind:company']);
    expect(item.url).toBeNull();
    expect(item.publishedAt).toBeNull();
  });

  test('a row with no id, no name, or a kind the directory does not define is not an item', () => {
    expect(directoryItem({ kind: 'company', name: 'X' })).toBeNull();
    expect(directoryItem({ id: 'x', kind: 'company' })).toBeNull();
    expect(directoryItem({ id: 'x', kind: 'campaign', name: 'X' })).toBeNull();
  });

  test('nothing private can arrive: the item carries only what the row carried', () => {
    const item = normaliseItem(directoryItem(person));
    const text = JSON.stringify(item);
    for (const forbidden of ['email', 'phone', 'score', 'campaign', 'workspace']) {
      expect(text.toLowerCase()).not.toContain(forbidden);
    }
  });
});

describe('OutreachGraph public directory: the adapter', () => {
  test('is registered, keyless, hourly, on the directory collection, with the seeded source', () => {
    expect(adapterByName('outreachgraph')).toBe(outreachgraph);
    expect(ADAPTERS.some((a) => a.name === 'outreachgraph')).toBe(true);
    expect(outreachgraph.collection).toBe('directory');
    expect(outreachgraph.cadenceMinutes).toBe(60);
    expect(outreachgraph.kinds).toEqual(KINDS);
    expect(outreachgraph.defaultSources.map((s) => s.slug)).toEqual(['outreachgraph-directory']);
    expect(outreachgraph.defaultSources[0].enabled).toBe(true);
  });

  test('the collection and its feeds are seeded', () => {
    expect(COLLECTIONS.some((c) => c.slug === 'directory')).toBe(true);
    const feeds = DEFAULT_FEEDS.filter((f) => f.collection === 'directory').map((f) => f.slug);
    expect(feeds).toEqual([
      'directory-all',
      'directory-companies',
      'directory-sites',
      'directory-people',
      'directory-openprofiles',
    ]);
  });

  test('pull walks the cursor to the end and stops at a page with no next', async () => {
    const asked = [];
    const http = {
      json: async (url) => {
        asked.push(url);
        if (url.includes('cursor=')) return { items: [person], next: null };
        return { items: [company, site], next: 'c2' };
      },
    };
    const logs = [];
    const out = await outreachgraph.pull({
      config: { base: DEFAULT_BASE, pages: 50 },
      http,
      log: (m) => logs.push(m),
      deadline: Date.now() + 10_000,
    });
    expect(asked).toEqual([FIRST, `${FIRST}&cursor=c2`]);
    expect(out.items.map((i) => i.externalId)).toEqual([
      'outreachgraph:company:co_acme',
      'outreachgraph:site:co_site',
      'outreachgraph:person:per_ada',
    ]);
    expect(out.note).toBe('2 pages, 3 rows');
    expect(logs[0]).toBe('2 pages: 1 company, 1 site, 1 person');
  });

  test('pull stops at the page cap and at a failed page, keeping what it has', async () => {
    let calls = 0;
    const http = {
      json: async () => {
        calls += 1;
        if (calls === 3) throw new Error('503 from outreachgraph.com');
        return { items: [{ ...company, id: `co_${calls}` }], next: `c${calls}` };
      },
    };
    const capped = await outreachgraph.pull({
      config: { pages: 2 },
      http,
      log: () => {},
      deadline: Date.now() + 10_000,
    });
    expect(capped.items).toHaveLength(2);
    expect(capped.note).toBe('2 pages, 2 rows');

    calls = 0;
    const logs = [];
    const failed = await outreachgraph.pull({
      config: {},
      http,
      log: (m) => logs.push(m),
      deadline: Date.now() + 10_000,
    });
    expect(failed.items).toHaveLength(2);
    expect(logs[0]).toContain('page 3 failed (503');
  });

  test('a 404 before the OutreachGraph endpoint deploys is a logged, empty run, not a crash', async () => {
    const http = {
      json: async () => {
        throw new Error('404 from outreachgraph.com');
      },
    };
    const logs = [];
    const out = await outreachgraph.pull({
      config: {},
      http,
      log: (m) => logs.push(m),
      deadline: Date.now() + 10_000,
    });
    expect(out.items).toEqual([]);
    expect(out.note).toBe('0 pages, 0 rows');
    expect(logs[0]).toContain('page 1 failed (404');
  });
});
