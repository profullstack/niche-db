import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { ADAPTERS, adapterByName } from '../packages/adapters/src/index.js';
import {
  describeThreat,
  descriptorUrl,
  KINDS,
  openthreat,
  parseDescriptor,
  reporterItem,
  servedByReporter,
  threatId,
  threatItem,
} from '../packages/adapters/src/openthreat.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';
const { COLLECTIONS, DEFAULT_FEEDS } = await import('../packages/core/src/seed.js');

const fixture = (name) =>
  readFile(new URL(`../packages/adapters/test/fixtures/${name}`, import.meta.url), 'utf8');
const json = async (name) => JSON.parse(await fixture(name));

const URL_ = 'https://threatcrush.com/.well-known/openthreat.json';

describe('OpenThreat descriptors: where one is read and whether it is believed', () => {
  test('a bare origin is read at the well-known path; a full URL as given', () => {
    expect(descriptorUrl('threatcrush.com')).toBe(URL_);
    expect(descriptorUrl('https://threatcrush.com/')).toBe(URL_);
    expect(descriptorUrl('https://www.threatcrush.com')).toBe(
      'https://www.threatcrush.com/.well-known/openthreat.json',
    );
    expect(descriptorUrl('https://cdn.threatcrush.com/x/openthreat.json')).toBe(
      'https://cdn.threatcrush.com/x/openthreat.json',
    );
    expect(descriptorUrl('not a url')).toBeNull();
  });

  test('a descriptor is believed from the origin it names, a subdomain either way, and nowhere else', async () => {
    const doc = await json('openthreat-descriptor.json');
    expect(servedByReporter(URL_, doc)).toBe(true);
    expect(servedByReporter('https://www.threatcrush.com/openthreat.json', doc)).toBe(true);
    expect(servedByReporter('https://api.threatcrush.com/openthreat.json', doc)).toBe(true);
    expect(servedByReporter('https://evil.example/openthreat.json', doc)).toBe(false);
    expect(servedByReporter('https://threatcrush.com.evil.example/x.json', doc)).toBe(false);
    expect(parseDescriptor(doc, 'https://evil.example/openthreat.json')).toEqual({
      items: [],
      rejected: 'origin',
    });
  });

  test('a descriptor naming no web is believed only at the well-known path', () => {
    const doc = { reporter: { name: 'Sensor' }, threats: [{ title: 'SSH brute force' }] };
    expect(servedByReporter('https://sensor.example/.well-known/openthreat.json', doc)).toBe(true);
    expect(servedByReporter('https://sensor.example/some/openthreat.json', doc)).toBe(false);
    expect(servedByReporter('nonsense', doc)).toBe(false);
  });

  test('no reporter name is no descriptor', () => {
    expect(
      parseDescriptor({ reporter: { web: 'https://threatcrush.com' }, threats: [] }, URL_),
    ).toEqual({ items: [], rejected: 'reporter' });
  });
});

describe('OpenThreat descriptors: the rows', () => {
  test('one reporter row, then one row per threat, ids on the reporter host and the threat id', async () => {
    const doc = await json('openthreat-descriptor.json');
    const { items, rejected } = parseDescriptor(doc, URL_);
    expect(rejected).toBeNull();
    expect(items.map((i) => i.externalId)).toEqual([
      'openthreat:reporter:threatcrush.com',
      'openthreat:threatcrush.com:3f9a1c2b',
      'openthreat:threatcrush.com:b71e0d44',
      'openthreat:threatcrush.com:ssh-91.232.105.3',
      'openthreat:threatcrush.com:c0ffee01',
      `openthreat:threatcrush.com:${threatId(doc.threats[4])}`,
    ]);
    for (const it of items) expect(normaliseItem(it)).not.toBeNull();
  });

  test('the reporter row carries the reporter as written', async () => {
    const doc = await json('openthreat-descriptor.json');
    const r = reporterItem(doc, URL_);
    expect(r.kind).toBe('reporter');
    expect(r.title).toBe('ThreatCrush');
    expect(r.url).toBe('https://threatcrush.com');
    expect(r.summary).toContain('5 threats in the open');
    expect(r.tags).toEqual(['reporter', 'openthreat', 'tool:threatcrush']);
    expect(r.data.reporter).toEqual(doc.reporter);
    expect(r.data.threats).toBe(5);
    expect(r.data.descriptor).toBe(URL_);
    expect(r.data.attribution).toBe(
      'ThreatCrush (threatcrush.com), from its own OpenThreat descriptor',
    );
    expect(r.publishedAt?.toISOString()).toBe('2026-09-13T06:00:00.000Z');
  });

  test('a full finding: every stated field becomes a tag, the threat is kept verbatim, unknown keys included', async () => {
    const doc = await json('openthreat-descriptor.json');
    const t = threatItem(doc, doc.threats[0], URL_);
    expect(t.kind).toBe('finding');
    expect(t.title).toBe('SQL assembled by concatenation');
    expect(t.summary).toBe('A query string is built from request input.');
    expect(t.url).toBe('https://github.com/northwind/api');
    expect(t.publishedAt?.toISOString()).toBe('2026-09-13T05:40:00.000Z');
    expect(t.timeKnown).toBe(true);
    expect(t.tags).toEqual([
      'openthreat',
      'kind:finding',
      'status:open',
      'severity:high',
      'rule:js-sql-string-building',
      'category:code',
      'cwe:cwe-89',
      'subject:northwind/api',
      'reporter:threatcrush.com',
    ]);
    expect(t.data.threat).toEqual(doc.threats[0]);
    expect(t.data.threat['x-threatcrush-scan']).toBe('scan_01J8');
    expect(t.data.threat.location).toEqual({ file: 'src/db/users.ts', line: 42 });
    expect(t.data.reporter).toEqual({ name: 'ThreatCrush', web: 'https://threatcrush.com' });
    expect(t.data.descriptor).toBe(URL_);
    expect(t.data.attribution).toContain('ThreatCrush (threatcrush.com)');
  });

  test('a secret is published unlocated and stays that way: no location, no message, a generated line instead', async () => {
    const doc = await json('openthreat-descriptor.json');
    const t = threatItem(doc, doc.threats[1], URL_);
    expect(t.summary).toBe('critical secret-generic-credential in northwind/api');
    expect(t.data.threat).toEqual(doc.threats[1]);
    expect('location' in t.data.threat).toBe(false);
    expect('message' in t.data.threat).toBe(false);
    expect(JSON.stringify(t)).not.toContain('location');
    expect(t.tags).toContain('category:secret');
    expect(t.tags).toContain('severity:critical');
    expect(t.tags).toContain('cwe:cwe-798');
    // No first_seen: last_seen is the date.
    expect(t.publishedAt?.toISOString()).toBe('2026-09-13T05:40:00.000Z');
  });

  test('an attack keeps its source, target, indicators and count; its url falls back to the reporter', async () => {
    const doc = await json('openthreat-descriptor.json');
    const t = threatItem(doc, doc.threats[2], URL_);
    expect(t.kind).toBe('attack');
    expect(t.url).toBe('https://threatcrush.com');
    expect(t.summary).toBe('medium ssh-bruteforce');
    expect(t.tags).toContain('kind:attack');
    expect(t.tags).toContain('status:blocked');
    expect(t.tags.some((x) => x.startsWith('subject:'))).toBe(false);
    expect(t.data.threat.indicators).toEqual([{ type: 'ip', value: '91.232.105.3' }]);
    expect(t.data.threat.source).toEqual({ ip: '91.232.105.3', country: 'RU' });
    expect(t.data.threat.count).toBe(47);
  });

  test('a withdrawn threat is still emitted, with its status, so the row it retracts updates', async () => {
    const doc = await json('openthreat-descriptor.json');
    const { items } = parseDescriptor(doc, URL_);
    const t = items.find((i) => i.externalId.endsWith(':c0ffee01'));
    expect(t).toBeTruthy();
    expect(t.tags).toContain('status:withdrawn');
    expect(t.tags).not.toContain('status:open');
    // No kind stated reads as a finding; no last_seen falls back to first_seen.
    expect(t.kind).toBe('finding');
    expect(t.tags).toContain('kind:finding');
    expect(t.publishedAt?.toISOString()).toBe('2026-09-11T01:00:00.000Z');
  });

  test('a threat with no id gets one derived from kind, subject, rule and title, stable across reads', async () => {
    const doc = await json('openthreat-descriptor.json');
    const t = doc.threats[4];
    expect(threatId(t)).toMatch(/^[0-9a-f]{16}$/);
    expect(threatId({ ...t })).toBe(threatId(t));
    expect(threatId({ ...t, title: 'Outdated lodash 4' })).not.toBe(threatId(t));
    expect(threatId({ id: ' abc ' })).toBe('abc');
    const item = threatItem(doc, t, URL_);
    expect(item.externalId).toBe(`openthreat:threatcrush.com:${threatId(t)}`);
    // No status and no kind stated: the spec's readings, as tags, for the feeds.
    expect(item.tags).toContain('status:open');
    expect(item.tags).toContain('kind:finding');
    expect(item.tags).toContain('severity:low');
    // No date anywhere on the threat: the descriptor's own.
    expect(item.publishedAt?.toISOString()).toBe('2026-09-13T06:00:00.000Z');
  });

  test('the smallest valid descriptor: a name and a title, everything else absent, never defaulted', () => {
    const doc = { reporter: { name: 'Sensor' }, threats: [{ title: 'SSH brute force' }] };
    const from = 'https://sensor.example/.well-known/openthreat.json';
    const { items, rejected } = parseDescriptor(doc, from);
    expect(rejected).toBeNull();
    expect(items).toHaveLength(2);
    const [r, t] = items;
    expect(r.externalId).toBe('openthreat:reporter:sensor.example');
    expect(r.url).toBe('https://sensor.example');
    expect(r.tags).toEqual(['reporter', 'openthreat']);
    expect(r.publishedAt).toBeNull();
    expect(r.data.openthreat).toBeNull();
    expect(t.externalId).toBe(`openthreat:sensor.example:${threatId(doc.threats[0])}`);
    expect(t.title).toBe('SSH brute force');
    expect(t.summary).toBeNull();
    expect(t.url).toBeNull();
    expect(t.publishedAt).toBeNull();
    expect(t.timeKnown).toBe(false);
    expect(t.tags).toEqual([
      'openthreat',
      'kind:finding',
      'status:open',
      'reporter:sensor.example',
    ]);
    expect(t.tags.some((x) => x.startsWith('severity:'))).toBe(false);
    expect(t.data.threat).toEqual({ title: 'SSH brute force' });
    expect(t.data.reporter).toEqual({ name: 'Sensor', web: null });
    expect(normaliseItem(t)).not.toBeNull();
  });

  test('a threat without a title is not a row; the others still are', () => {
    const doc = {
      reporter: { name: 'Sensor', web: 'https://sensor.example' },
      threats: [{ id: 'x' }, { title: 'One' }],
    };
    const { items } = parseDescriptor(doc, 'https://sensor.example/openthreat.json');
    expect(items.map((i) => i.title)).toEqual(['Sensor', 'One']);
  });

  test('the generated line uses whatever of severity, rule and subject was stated', () => {
    expect(describeThreat({ severity: 'high', rule: 'r', subject: { name: 'a/b' } })).toBe(
      'high r in a/b',
    );
    expect(describeThreat({ rule: 'r', subject: { name: 'a/b' } })).toBe('r in a/b');
    expect(describeThreat({ severity: 'high' })).toBe('high');
    expect(describeThreat({ subject: { name: 'a/b' } })).toBe('in a/b');
    expect(describeThreat({})).toBeNull();
  });
});

describe('the threats collection is registered', () => {
  test('one adapter, hourly, keyless, seeded on threatcrush.com and enabled', () => {
    expect(adapterByName('openthreat')).toBe(openthreat);
    expect(openthreat.collection).toBe('threats');
    expect(openthreat.cadenceMinutes).toBe(60);
    expect(openthreat.needsEnv).toBeUndefined();
    expect(openthreat.kinds).toEqual(['reporter', ...KINDS]);
    expect(ADAPTERS.filter((a) => a.collection === 'threats')).toHaveLength(1);
    const [src] = openthreat.defaultSources;
    expect(src.slug).toBe('threatcrush-discovery');
    expect(src.config.urls).toEqual(['https://threatcrush.com']);
    expect(src.enabled).toBe(true);
  });

  test('the collection and its five feeds are seeded', () => {
    const c = COLLECTIONS.find((c) => c.slug === 'threats');
    expect(c.name).toBe('Threats');
    expect(c.description).toContain('ThreatCrush');
    expect(c.description).toContain('/.well-known/openthreat.json');
    expect(c.description).toContain('Never from a private scan');
    const feeds = DEFAULT_FEEDS.filter((f) => f.collection === 'threats');
    expect(feeds.map((f) => f.slug)).toEqual([
      'all-threats',
      'critical-and-high-threats',
      'threat-findings',
      'threat-attacks',
      'open-threats',
    ]);
    const by = Object.fromEntries(feeds.map((f) => [f.slug, f.query]));
    expect(by['all-threats'].kinds).toEqual(KINDS);
    expect(by['critical-and-high-threats'].tags).toEqual(['severity:critical', 'severity:high']);
    expect(by['threat-findings']).toEqual({ kinds: ['finding'] });
    expect(by['threat-attacks']).toEqual({ kinds: ['attack'] });
    expect(by['open-threats'].tags).toEqual(['status:open']);
    // The reporter row is in no threat feed.
    for (const f of feeds) expect(f.query.kinds).not.toContain('reporter');
  });

  test('feed slugs stay unique across the whole seed', () => {
    const slugs = DEFAULT_FEEDS.map((f) => f.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  test('a 404 from the first reporter is a note, not a failure', async () => {
    const logs = [];
    const http = {
      json: async (url) => {
        throw new Error(`404 from ${url}`);
      },
    };
    const out = await openthreat.pull({
      config: { urls: ['https://threatcrush.com'] },
      http,
      log: (m) => logs.push(m),
      deadline: Date.now() + 10_000,
    });
    expect(out.items).toEqual([]);
    expect(out.note).toBe('0 reporters, 0 threats; 1 descriptors rejected');
    expect(logs[0]).toContain('threatcrush.com (404 from');
  });

  test('pull reads a descriptor at the well-known path and rejects one hosted elsewhere', async () => {
    const doc = await json('openthreat-descriptor.json');
    const asked = [];
    const http = {
      json: async (url) => {
        asked.push(url);
        return doc;
      },
    };
    const out = await openthreat.pull({
      config: { urls: ['threatcrush.com', 'https://mirror.example/openthreat.json'] },
      http,
      log: () => {},
      deadline: Date.now() + 10_000,
    });
    expect(asked).toEqual([URL_, 'https://mirror.example/openthreat.json']);
    expect(out.items).toHaveLength(6);
    expect(out.note).toBe('1 reporters, 5 threats; 1 descriptors rejected');
  });
});
