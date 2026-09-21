/**
 * SURBL: the lists as a catalogue, and watched domains checked by DNS. What
 * would be embarrassing: a bit decoded to the wrong list, an IP queried
 * unreversed, NXDOMAIN read as an error, the 127.0.0.1 "you are blocked"
 * answer written as a listing for every domain, or a row rewritten on every
 * run because its date is the check time rather than the change time.
 */
import { describe, expect, test } from 'bun:test';
import { adapterByName } from '../packages/adapters/src/index.js';
import {
  CATALOGUE_DATE,
  DEFAULT_DOMAINS,
  decode,
  domainsOf,
  LISTS,
  listItem,
  lookup,
  normaliseDomain,
  queryName,
  reputationItem,
  surbl,
  ZONE,
} from '../packages/adapters/src/surbl.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';
const { COLLECTIONS, DEFAULT_FEEDS } = await import('../packages/core/src/seed.js');

const feed = (slug) => DEFAULT_FEEDS.find((f) => f.slug === slug);

describe('what is asked', () => {
  test('a domain is a bare lower-case host, whatever was written', () => {
    expect(normaliseDomain('https://WWW.Example.com/path?q=1')).toBe('example.com');
    expect(normaliseDomain('user@mail.example.org')).toBe('mail.example.org');
    expect(normaliseDomain('example.com.')).toBe('example.com');
    expect(normaliseDomain('203.0.113.5')).toBe('203.0.113.5');
    expect(normaliseDomain('not a domain')).toBeNull();
    expect(normaliseDomain('')).toBeNull();
    expect(normaliseDomain('-bad.example')).toBeNull();
  });

  test('the query is the domain under the zone; an address goes in reversed', () => {
    expect(queryName('example.com')).toBe(`example.com.${ZONE}`);
    expect(queryName('203.0.113.5')).toBe(`5.113.0.203.${ZONE}`);
  });

  test('the config list is normalised, deduplicated and capped', () => {
    expect(
      domainsOf({ domains: ['Example.com', 'https://example.com/', 'test.surbl.org'] }),
    ).toEqual(['example.com', 'test.surbl.org']);
    expect(domainsOf({ domains: 'a.example, b.example' })).toEqual(['a.example', 'b.example']);
    expect(domainsOf({}).length).toBe(0);
  });
});

describe('what is answered', () => {
  test('the last octet is a sum of list bits', () => {
    expect(decode(['127.0.0.8'])).toEqual({ blocked: false, lists: ['ph'] });
    expect(decode(['127.0.0.80'])).toEqual({ blocked: false, lists: ['mw', 'abuse'] });
    expect(decode(['127.0.0.254']).lists).toEqual(['ph', 'mw', 'abuse', 'cr', 'ct', 'dm']);
    expect(decode(['127.0.0.4'])).toEqual({ blocked: false, lists: ['dm'] });
    expect(decode(['127.0.0.32'])).toEqual({ blocked: false, lists: ['ct'] });
    expect(decode(['127.0.0.128'])).toEqual({ blocked: false, lists: ['cr'] });
  });

  test('127.0.0.1 means blocked, and an answer outside 127/8 means nothing', () => {
    expect(decode(['127.0.0.1'])).toEqual({ blocked: true, lists: [] });
    expect(decode(['10.0.0.1'])).toEqual({ blocked: false, lists: [] });
    expect(decode([])).toEqual({ blocked: false, lists: [] });
  });

  test('a lookup: listed, clear on NXDOMAIN, error otherwise', async () => {
    expect(await lookup('bad.example', async () => ['127.0.0.8'])).toEqual({
      domain: 'bad.example',
      status: 'listed',
      lists: ['ph'],
    });
    const nx = Object.assign(new Error('queryA ENOTFOUND'), { code: 'ENOTFOUND' });
    expect(
      await lookup('good.example', async () => {
        throw nx;
      }),
    ).toEqual({ domain: 'good.example', status: 'clear', lists: [] });
    const timeout = Object.assign(new Error('queryA ETIMEOUT'), { code: 'ETIMEOUT' });
    const r = await lookup('slow.example', async () => {
      throw timeout;
    });
    expect(r.status).toBe('error');
    expect(r.error).toBe('ETIMEOUT');
  });
});

describe('the rows', () => {
  test('the catalogue: seven lists, multi first, dated once and stable', () => {
    expect(LISTS.map((l) => l.code)).toEqual(['multi', 'ph', 'mw', 'abuse', 'cr', 'ct', 'dm']);
    const rows = LISTS.map(listItem);
    for (const it of rows) {
      expect(it.kind).toBe('list');
      expect(it.publishedAt).toBe(CATALOGUE_DATE);
      expect(it.precision).toBe('day');
      expect(it.url).toBe('https://surbl.org/lists');
      expect(normaliseItem(it)).not.toBeNull();
    }
    expect(rows[1].externalId).toBe('surbl:list:ph');
    expect(rows[1].summary).toContain('Bit 8');
    expect(rows[0].summary).not.toContain('Bit');
    expect(normaliseItem(rows[1]).contentHash).toBe(normaliseItem(listItem(LISTS[1])).contentHash);
  });

  test('a standing keeps its date while unchanged, and moves when it changes', () => {
    const now = new Date('2026-09-21T10:00:00Z');
    const prev = { status: 'clear', lists: [], since: '2026-09-01T00:00:00.000Z' };
    const same = reputationItem({ domain: 'a.example', status: 'clear', lists: [] }, prev, now);
    expect(same.publishedAt).toBe('2026-09-01T00:00:00.000Z');
    expect(same.title).toBe('a.example: not on SURBL');
    expect(same.tags).toEqual(['surbl', 'reputation', 'status:clear']);
    const changed = reputationItem(
      { domain: 'a.example', status: 'listed', lists: ['ph', 'mw'] },
      prev,
      now,
    );
    expect(changed.publishedAt).toBe(now.toISOString());
    expect(changed.title).toBe('a.example: listed on SURBL PH, MW');
    expect(changed.tags).toEqual(['surbl', 'reputation', 'status:listed', 'list:ph', 'list:mw']);
    expect(changed.summary).toContain('phishing, malware');
    expect(changed.externalId).toBe('surbl:a.example');
    expect(changed.url).toBeNull();
    expect(normaliseItem(changed).dedupeKey).toBeNull();
    const fresh = reputationItem(
      { domain: 'b.example', status: 'clear', lists: [] },
      undefined,
      now,
    );
    expect(fresh.publishedAt).toBe(now.toISOString());
  });
});

describe('a run', () => {
  const resolve = async (name) => {
    if (name === `test.surbl.org.${ZONE}`) return ['127.0.0.254'];
    throw Object.assign(new Error('queryA ENOTFOUND'), { code: 'ENOTFOUND' });
  };
  const base = {
    env: {},
    http: {},
    log: () => {},
    budget: 10,
    deadline: Date.now() + 60_000,
  };

  test('the catalogue plus one standing per domain, carrying the previous date', async () => {
    const previous = async (ids) =>
      new Map(
        ids
          .filter((id) => id === 'surbl:example.com')
          .map((id) => [id, { status: 'clear', lists: [], since: '2026-09-01T00:00:00.000Z' }]),
      );
    const r = await surbl.pull({
      ...base,
      config: { domains: ['Example.com', 'test.surbl.org', 'https://example.com/'] },
      cursor: {},
      previous,
      resolve,
    });
    expect(r.items.length).toBe(LISTS.length + 2);
    const example = r.items.find((i) => i.externalId === 'surbl:example.com');
    expect(example.tags).toContain('status:clear');
    expect(example.publishedAt).toBe('2026-09-01T00:00:00.000Z');
    const canary = r.items.find((i) => i.externalId === 'surbl:test.surbl.org');
    expect(canary.tags).toContain('status:listed');
    expect(canary.tags.filter((t) => t.startsWith('list:')).length).toBe(6);
    expect(r.note).toContain('2 domains checked, 1 listed');
  });

  test('a blocked resolver writes the catalogue and no standings, and backs off', async () => {
    const r = await surbl.pull({
      ...base,
      config: { domains: ['example.com'] },
      cursor: {},
      previous: async () => new Map(),
      resolve: async () => ['127.0.0.1'],
    });
    expect(r.items.length).toBe(LISTS.length);
    expect(r.note).toContain('blocked');
    expect(r.nextInMinutes).toBe(720);
  });

  test('no domains: the catalogue alone', async () => {
    const r = await surbl.pull({
      ...base,
      config: { domains: [] },
      cursor: {},
      previous: async () => new Map(),
      resolve,
    });
    expect(r.items.length).toBe(LISTS.length);
  });

  test('registered in threats, with the house watch list, the canary and the three feeds', () => {
    expect(adapterByName('surbl')).toBe(surbl);
    expect(surbl.collection).toBe('threats');
    expect(surbl.cadenceMinutes).toBe(30);
    expect(surbl.kinds).toEqual(['list', 'reputation']);
    const src = surbl.defaultSources.find((s) => s.slug === 'surbl-watch');
    expect(src.config.domains).toBe(DEFAULT_DOMAINS);
    expect(DEFAULT_DOMAINS).toContain('test.surbl.org');
    expect(DEFAULT_DOMAINS).toContain('nichedb.dev');
    expect(DEFAULT_DOMAINS.length).toBeLessThan(50);
    expect(feed('surbl-lists')).toMatchObject({
      collection: 'threats',
      query: { kinds: ['list'] },
    });
    expect(feed('surbl-watch')).toMatchObject({
      collection: 'threats',
      query: { kinds: ['reputation'] },
    });
    expect(feed('surbl-listed').query).toEqual({ kinds: ['reputation'], tags: ['status:listed'] });
    expect(COLLECTIONS.find((c) => c.slug === 'threats').description).toContain('SURBL');
  });
});
