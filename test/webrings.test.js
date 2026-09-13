import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { ADAPTERS, adapterByName } from '../packages/adapters/src/index.js';
import {
  descriptorUrl,
  MADE_BY,
  memberItem,
  openwebring,
  parseHost,
  parseRingFile,
  ringItem,
  ringsOf,
  servedByHost,
  siteKey,
} from '../packages/adapters/src/openwebring.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';
const { COLLECTIONS, DEFAULT_FEEDS } = await import('../packages/core/src/seed.js');

const fixture = (name) =>
  readFile(new URL(`../packages/adapters/test/fixtures/${name}`, import.meta.url), 'utf8');
const json = async (name) => JSON.parse(await fixture(name));

const HOST_URL = 'https://rssamplifier.com/.well-known/openwebring.json';
const RING_URL = 'https://rssamplifier.com/ring/profullstack/openwebring.json';

describe('OpenWebring hosts: where one is read and whether it is believed', () => {
  test('a bare origin is read at the well-known path; a full URL as given', () => {
    expect(descriptorUrl('rssamplifier.com')).toBe(HOST_URL);
    expect(descriptorUrl('https://rssamplifier.com/')).toBe(HOST_URL);
    expect(descriptorUrl('https://cdn.rssamplifier.com/x/openwebring.json')).toBe(
      'https://cdn.rssamplifier.com/x/openwebring.json',
    );
    expect(descriptorUrl('not a url')).toBeNull();
  });

  test('a host descriptor is believed from the origin it names, a subdomain either way, and nowhere else', async () => {
    const doc = await json('openwebring-host.json');
    expect(servedByHost(HOST_URL, doc)).toBe(true);
    expect(servedByHost('https://www.rssamplifier.com/openwebring.json', doc)).toBe(true);
    expect(servedByHost('https://evil.example/openwebring.json', doc)).toBe(false);
    expect(parseHost(doc, 'https://evil.example/openwebring.json')).toEqual({
      rings: [],
      rejected: 'origin',
    });
    const noSite = { hosts: [{ slug: 'x', url: 'https://ring.example/ring/x' }] };
    expect(servedByHost('https://ring.example/.well-known/openwebring.json', noSite)).toBe(true);
    expect(servedByHost('https://ring.example/some/openwebring.json', noSite)).toBe(false);
  });

  test('a host with rings but no site name or url is refused; a ring with no url and no slug is not a ring', async () => {
    const doc = await json('openwebring-host.json');
    expect(ringsOf(doc).map((r) => r.slug)).toEqual(['profullstack', 'business']);
    expect(parseHost({ hosts: doc.hosts }, HOST_URL)).toEqual({ rings: [], rejected: 'site' });
  });

  test('a member url is matched without scheme, www or a trailing slash', () => {
    expect(siteKey('https://www.Example.com/blog/')).toBe('example.com/blog');
    expect(siteKey('http://example.com')).toBe('example.com');
    expect(siteKey('example.com/')).toBe('example.com');
  });
});

describe('OpenWebring hosts: the rows', () => {
  test('a ring row carries what the host said, with counts from its file when read', async () => {
    const doc = await json('openwebring-host.json');
    const row = ringItem(doc, ringsOf(doc)[0], HOST_URL, { members: 5, active: 3 });
    expect(row.externalId).toBe('openwebring:ring:https://rssamplifier.com/ring/profullstack');
    expect(row.kind).toBe('ring');
    expect(row.title).toBe('Profullstack');
    expect(row.url).toBe('https://rssamplifier.com/ring/profullstack');
    expect(row.summary).toBe('The sites Profullstack, Inc. publishes. 5 members, 3 active.');
    expect(row.tags).toEqual(['ring', 'openwebring', 'host:rssamplifier.com']);
    expect(row.data.ring.members_url).toBe(RING_URL);
    expect(row.data.ring.opml).toBe('https://rssamplifier.com/ring/profullstack/opml');
    expect(row.data.attribution).toBe(
      'RSS Amplifier (rssamplifier.com), from its own OpenWebring descriptor',
    );
    expect(row.publishedAt?.toISOString()).toBe('2026-09-13T10:00:00.000Z');
    expect(normaliseItem(row)).not.toBeNull();

    const business = ringItem(doc, ringsOf(doc)[1], HOST_URL);
    expect(business.tags).toEqual([
      'ring',
      'openwebring',
      'host:rssamplifier.com',
      'accepts:human',
      'accepts:both',
    ]);
    expect(business.summary).toBe('100 members.');
    expect(business.data.members).toBe(100);
    expect(business.data.active).toBeNull();
  });

  test('a member row: made_by as the member said it, lower-cased, unstated when absent or outside the vocabulary', async () => {
    const host = await json('openwebring-host.json');
    const file = await json('openwebring-ring.json');
    const { items, members, active } = parseRingFile(host, ringsOf(host)[0], file, HOST_URL);
    expect(members).toBe(5);
    expect(items).toHaveLength(4);
    expect(active).toBe(2);
    expect(items.map((i) => i.externalId)).toEqual([
      'openwebring:member:https://rssamplifier.com/ring/profullstack#dev.profullstack.com/~anthony/blog',
      'openwebring:member:https://rssamplifier.com/ring/profullstack#logicsrc.com/blog',
      'openwebring:member:https://rssamplifier.com/ring/profullstack#github.com/profullstack/logicsrc/releases',
      'openwebring:member:https://rssamplifier.com/ring/profullstack#crawlproof.com/blog',
    ]);
    for (const it of items) expect(normaliseItem(it)).not.toBeNull();

    const [chovy, logicsrc, releases, crawlproof] = items;
    expect(chovy.kind).toBe('member');
    expect(chovy.title).toBe("Chovy's Blog");
    expect(chovy.url).toBe('https://dev.profullstack.com/~anthony/blog/');
    expect(chovy.tags).toEqual([
      'member',
      'openwebring',
      'host:rssamplifier.com',
      'ring:profullstack',
      'status:active',
      'made_by:both',
      'disclosure:ai-assisted',
      'lang:en-us',
    ]);
    expect(chovy.summary).toBe(
      "Chovy's Blog, active in the Profullstack ring on rssamplifier.com: made by a person and AI both (ai-assisted).",
    );
    expect(chovy.publishedAt?.toISOString()).toBe('2026-09-13T09:55:00.000Z');
    expect(chovy.data.position).toBe(0);
    expect(chovy.data.member).toEqual(file.members[0]);

    expect(logicsrc.tags).toContain('made_by:both');
    expect(logicsrc.tags).toContain('disclosure:ai-generated');

    expect(releases.tags).toContain('status:pending');
    expect(releases.tags).toContain('made_by:unstated');
    expect(releases.summary).toContain('who makes it unstated');
    expect(releases.data.member['x-note']).toBe('kept as given');
    expect(releases.publishedAt?.toISOString()).toBe('2026-09-13T10:00:00.000Z');

    expect(crawlproof.tags).toContain('made_by:unstated');
    expect(crawlproof.data.made_by).toBeNull();
    expect(crawlproof.tags).toContain('status:inactive');
  });

  test('a member with no name is called by its host; a member with no status is pending', () => {
    const doc = {
      site: { url: 'https://h.example/', name: 'H' },
      hosts: [{ slug: 'r', url: 'https://h.example/ring/r' }],
    };
    const row = memberItem(
      doc,
      doc.hosts[0],
      { url: 'https://blog.example/' },
      'https://h.example/.well-known/openwebring.json',
      3,
    );
    expect(row.title).toBe('blog.example');
    expect(row.tags).toContain('status:pending');
    expect(row.tags).toContain('made_by:unstated');
    expect(row.data.position).toBe(3);
    expect(row.publishedAt).toBeNull();
    expect(MADE_BY).toEqual(['human', 'ai', 'both']);
  });
});

describe('OpenWebring hosts: the pull and the registry', () => {
  test('a pull reads the host, then each ring file the host names, and rejects a descriptor from the wrong origin', async () => {
    const host = await json('openwebring-host.json');
    const file = await json('openwebring-ring.json');
    const asked = [];
    const http = {
      json: async (url) => {
        asked.push(url);
        if (url === HOST_URL) return host;
        if (url === RING_URL) return file;
        if (url === 'https://rssamplifier.com/ring/business/openwebring.json')
          return { members: [] };
        if (url === 'https://evil.example/.well-known/openwebring.json') return host;
        throw new Error('404');
      },
    };
    const log = [];
    const result = await openwebring.pull({
      config: { urls: ['rssamplifier.com', 'https://evil.example'] },
      http,
      log: (l) => log.push(l),
      deadline: Date.now() + 60_000,
    });
    expect(asked).toEqual([
      HOST_URL,
      RING_URL,
      'https://rssamplifier.com/ring/business/openwebring.json',
      'https://evil.example/.well-known/openwebring.json',
    ]);
    const kinds = result.items.map((i) => i.kind);
    expect(kinds.filter((k) => k === 'ring')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'member')).toHaveLength(4);
    const ring = result.items.find(
      (i) => i.externalId === 'openwebring:ring:https://rssamplifier.com/ring/profullstack',
    );
    expect(ring.data.members).toBe(5);
    expect(ring.data.active).toBe(2);
    expect(result.note).toBe('1 hosts, 2 rings, 4 members; 1 reads failed');
    expect(log[0]).toContain('failed: evil.example (not served by the host it names)');
  });

  test('registered: the adapter, the collection, its feeds, and the default source', () => {
    expect(adapterByName('openwebring')).toBe(openwebring);
    expect(ADAPTERS).toContain(openwebring);
    expect(openwebring.collection).toBe('webrings');
    expect(openwebring.kinds).toEqual(['ring', 'member']);
    expect(openwebring.defaultSources[0].slug).toBe('rssamplifier-rings');
    expect(COLLECTIONS.find((c) => c.slug === 'webrings')?.name).toBe('Webrings');
    const feeds = DEFAULT_FEEDS.filter((f) => f.collection === 'webrings').map((f) => f.slug);
    expect(feeds).toEqual([
      'rings',
      'ring-members',
      'human-made-members',
      'ai-made-members',
      'active-members',
    ]);
  });
});
