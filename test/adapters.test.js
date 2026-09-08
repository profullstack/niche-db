import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { parseFeed as parseArxiv } from '../packages/adapters/src/arxiv.js';
import { parseFeed as parseEdgar, parseTitle } from '../packages/adapters/src/edgar.js';
import { toItem as frItem } from '../packages/adapters/src/federalregister.js';
import { parseFeed as parseGdacs } from '../packages/adapters/src/gdacs.js';
import { toItem as hfItem } from '../packages/adapters/src/huggingface.js';
import { ADAPTERS, adapterByName } from '../packages/adapters/src/index.js';
import { toItem as launchItem } from '../packages/adapters/src/launchlibrary.js';
import { toItem as npmItem } from '../packages/adapters/src/npm.js';
import { parseUpdates } from '../packages/adapters/src/pypi.js';
import { toItem as statusItem } from '../packages/adapters/src/statuspage.js';
import { parseSteamDate, toItem as steamItem } from '../packages/adapters/src/steam.js';
import { toItem as usgsItem } from '../packages/adapters/src/usgs.js';
import { looseDate, normaliseItem, xmlItems } from '../packages/core/src/adapter.js';

const fixture = (name) =>
  readFile(new URL(`../packages/adapters/test/fixtures/${name}`, import.meta.url), 'utf8');

describe('registry', () => {
  test('every adapter is well formed and unique', () => {
    const names = new Set();
    for (const a of ADAPTERS) {
      expect(a.name).toMatch(/^[a-z0-9-]+$/);
      expect(names.has(a.name)).toBe(false);
      names.add(a.name);
      expect(typeof a.pull).toBe('function');
      expect(a.kinds.length).toBeGreaterThan(0);
      expect([
        'games',
        'packages',
        'filings',
        'music',
        'books',
        'tabletop',
        'space',
        'chess',
        'alerts',
        'outages',
        'extensions',
        'health',
        'automotive',
        'ai-incidents',
        'research',
        'markets',
        'crime',
        'public-money',
        'weather',
        'housing',
        'jobs',
        'news',
      ]).toContain(a.collection);
    }
    expect(adapterByName('steam').title).toContain('Steam');
    expect(adapterByName('nope')).toBeNull();
  });
  test('every default source names a real collection and passes its own config fields', () => {
    for (const a of ADAPTERS) {
      for (const s of a.defaultSources ?? []) {
        expect(s.slug).toMatch(/^[a-z0-9-]+$/);
        for (const k of Object.keys(s.config ?? {})) {
          expect(a.configFields.map((f) => f.key)).toContain(k);
        }
      }
    }
  });
});

describe('core helpers', () => {
  test('looseDate keeps precision honest and anchors at noon UTC', () => {
    expect(looseDate('2026-09-05')).toMatchObject({ timeKnown: false, precision: 'day' });
    expect(looseDate('2026-09-05').publishedAt.toISOString()).toBe('2026-09-05T12:00:00.000Z');
    expect(looseDate('2026-09')).toMatchObject({ precision: 'month' });
    expect(looseDate('2027')).toMatchObject({ precision: 'year' });
    expect(looseDate('2026-09-05T10:00:00Z')).toMatchObject({
      timeKnown: true,
      precision: 'minute',
    });
  });
  test('normaliseItem stamps a content hash that changes only when content does', () => {
    const a = normaliseItem({ externalId: '1', title: 'A', tags: ['X', 'x', ' y '] });
    const b = normaliseItem({ externalId: '1', title: 'A', tags: ['x', 'y'] });
    const c = normaliseItem({ externalId: '1', title: 'B', tags: ['x', 'y'] });
    expect(a.tags).toEqual(['x', 'y']);
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.contentHash).not.toBe(c.contentHash);
    expect(normaliseItem({ title: 'no id' })).toBeNull();
  });
  test('xmlItems reads RSS items with CDATA and attributes', () => {
    const xml = `<rss><channel><item><title><![CDATA[a &amp; b]]></title><link href="https://x"/><pubDate>Sat, 05 Sep 2026 15:59:32 GMT</pubDate></item></channel></rss>`;
    const [it] = xmlItems(xml, 'item');
    expect(it.title.text).toBe('a & b');
    expect(it.link.attrs.href).toBe('https://x');
  });
});

describe('steam', () => {
  test('parses every date shape the store uses', () => {
    expect(parseSteamDate('Jul 9, 2013')).toMatchObject({ precision: 'day' });
    expect(parseSteamDate('Jul 9, 2013').publishedAt.toISOString()).toBe(
      '2013-07-09T12:00:00.000Z',
    );
    expect(parseSteamDate('9 Jul, 2013').publishedAt.toISOString()).toBe(
      '2013-07-09T12:00:00.000Z',
    );
    expect(parseSteamDate('October 2026')).toMatchObject({ precision: 'month' });
    expect(parseSteamDate('Q4 2026')).toMatchObject({ precision: 'month' });
    expect(parseSteamDate('2027')).toMatchObject({ precision: 'year' });
    expect(parseSteamDate('Coming soon').publishedAt).toBeNull();
  });
  test('turns a list entry plus details into an item', () => {
    const it = steamItem(
      { id: 570, name: 'Dota 2', final_price: 0, discounted: false, currency: 'USD' },
      {
        name: 'Dota 2',
        short_description: 'MOBA',
        header_image: 'https://img',
        release_date: { coming_soon: false, date: 'Jul 9, 2013' },
        genres: [{ description: 'Action' }],
        platforms: { windows: true, mac: false },
        developers: ['Valve'],
        is_free: true,
      },
      'top_sellers',
    );
    expect(it.externalId).toBe('570');
    expect(it.tags).toEqual(['top-sellers', 'Action', 'windows', 'free']);
    expect(it.data.developers).toEqual(['Valve']);
    expect(it.url).toBe('https://store.steampowered.com/app/570/');
  });
});

describe('edgar', () => {
  test('reads the latest-filings atom feed', async () => {
    const items = parseEdgar(await fixture('edgar-form-d.atom'));
    expect(items.length).toBe(2);
    expect(items[0].externalId).toBe('0002153540-26-000001');
    expect(items[0].data.cik).toBe('0002153540');
    expect(items[0].data.form).toBe('D');
    expect(items[0].title).toContain('Balto Series');
    expect(items[0].url).toContain('sec.gov/Archives');
    expect(items[0].tags).toContain('edgar');
  });
  test('title parser handles the SEC shape', () => {
    expect(parseTitle('8-K - ACME CORP (0000123456) (Filer)')).toEqual({
      form: '8-K',
      company: 'ACME CORP',
      cik: '0000123456',
      role: 'Filer',
    });
  });
});

describe('pypi', () => {
  test('reads the updates feed', async () => {
    const items = parseUpdates(await fixture('pypi-updates.xml'), 'version');
    expect(items.length).toBe(2);
    expect(items[0].externalId).toBe('yield-audit@0.3.2');
    expect(items[0].data).toEqual({ name: 'yield-audit', version: '0.3.2' });
    expect(items[0].url).toBe('https://pypi.org/project/yield-audit/0.3.2/');
  });
});

describe('simple mappers', () => {
  test('npm', () => {
    const it = npmItem(
      '@scope/pkg',
      {
        version: '1.2.3',
        description: 'd',
        keywords: ['a'],
        repository: { url: 'git+https://github.com/x/y.git' },
        bin: { pkg: 'cli.js' },
      },
      new Date('2026-09-05T00:00:00Z'),
    );
    expect(it.externalId).toBe('@scope/pkg@1.2.3');
    expect(it.tags).toEqual(['npm', '@scope', 'a']);
    expect(it.data.repository).toBe('https://github.com/x/y');
    expect(it.data.bin).toEqual(['pkg']);
  });
  test('huggingface', () => {
    const it = hfItem(
      {
        id: 'org/model',
        lastModified: '2026-09-05T16:21:40.000Z',
        tags: ['transformers', 'region:us'],
        pipeline_tag: 'text-generation',
        likes: 3,
      },
      'models',
    );
    expect(it.kind).toBe('model');
    expect(it.url).toBe('https://huggingface.co/org/model');
    expect(it.tags).toEqual(['huggingface', 'text-generation', 'transformers']);
    expect(hfItem({ id: 'd/s' }, 'datasets').url).toBe('https://huggingface.co/datasets/d/s');
  });
  test('federal register', () => {
    const it = frItem({
      document_number: '2026-18279',
      title: 'T',
      type: 'Proposed Rule',
      abstract: 'A',
      html_url: 'https://fr/x',
      publication_date: '2026-09-08',
      agencies: [{ name: 'FCC' }],
    });
    expect(it.externalId).toBe('2026-18279');
    expect(it.precision).toBe('day');
    expect(it.tags).toEqual(['federal-register', 'proposed-rule', 'fcc']);
  });
});

describe('new niches', () => {
  test('arxiv atom', () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/2609.01234v1</id><title>A  Paper</title><summary>Abstract here.</summary><published>2026-09-05T00:00:00Z</published><author><name>A. Person</name></author><category term="cs.AI"/><category term="cs.LG"/></entry></feed>`;
    const [p] = parseArxiv(xml);
    expect(p.externalId).toBe('2609.01234v1');
    expect(p.url).toBe('https://arxiv.org/abs/2609.01234');
    expect(p.tags).toEqual(['arxiv', 'cs.ai', 'cs.lg']);
    expect(p.data.authors).toEqual(['A. Person']);
  });
  test('gdacs rss', () => {
    const xml = `<rss><channel><item><title>Green earthquake alert</title><link>https://www.gdacs.org/report.aspx?eventid=1</link><guid>EQ1</guid><description>&lt;p&gt;M5&lt;/p&gt;</description><pubDate>Sat, 05 Sep 2026 10:00:00 GMT</pubDate><gdacs:eventtype>EQ</gdacs:eventtype><gdacs:alertlevel>Green</gdacs:alertlevel><gdacs:country>Japan</gdacs:country></item></channel></rss>`;
    const [d] = parseGdacs(xml);
    expect(d.externalId).toBe('EQ1');
    expect(d.tags).toEqual(['gdacs', 'earthquake', 'green-alert', 'japan']);
    expect(d.summary).toBe('M5');
  });
  test('launch precision maps to time_known', () => {
    const base = {
      id: 'x',
      name: 'Falcon 9 | Starlink',
      slug: 'f9',
      net: '2026-09-06T01:00:00Z',
      launch_service_provider: { name: 'SpaceX' },
      rocket: { configuration: { name: 'Falcon 9' } },
      status: { name: 'Go', abbrev: 'Go' },
    };
    expect(launchItem({ ...base, net_precision: { name: 'Minute' } })).toMatchObject({
      timeKnown: true,
      precision: 'minute',
    });
    expect(launchItem({ ...base, net_precision: { name: 'Month' } })).toMatchObject({
      timeKnown: false,
      precision: 'month',
    });
    expect(launchItem(base).tags).toContain('SpaceX');
  });
  test('usgs bands magnitude', () => {
    const f = {
      id: 'q1',
      properties: {
        mag: 6.2,
        place: '10 km N of Somewhere, Japan',
        time: 1788631318736,
        url: 'https://u',
        tsunami: 0,
      },
      geometry: { coordinates: [1, 2, 10] },
    };
    const it = usgsItem(f);
    expect(it.title).toBe('M6.2 — 10 km N of Somewhere, Japan');
    expect(it.tags).toContain('strong');
    expect(it.tags).toContain('japan');
  });
  test('statuspage incident carries its latest update', () => {
    const it = statusItem(
      'www.githubstatus.com',
      { name: 'GitHub' },
      {
        id: 'i1',
        name: 'Slow pushes',
        status: 'monitoring',
        impact: 'minor',
        created_at: '2026-09-05T00:00:00Z',
        shortlink: 'https://stspg.io/x',
        incident_updates: [{ status: 'monitoring', body: 'A fix <b>is</b> deployed.' }],
        components: [{ name: 'Git Operations' }],
      },
    );
    expect(it.externalId).toBe('www.githubstatus.com:i1');
    expect(it.summary).toBe('monitoring: A fix is deployed.');
    expect(it.tags).toEqual([
      'statuspage',
      'github',
      'monitoring',
      'impact-minor',
      'git operations',
    ]);
  });
});
