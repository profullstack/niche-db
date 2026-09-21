/**
 * NIST, four ways: the NVD CVE catalogue, the Science Data Portal's datasets,
 * CSRC's drafts open for comment, and the newsroom feeds by topic. What would
 * be embarrassing: an NVD timestamp read as local time, a window wider than
 * the API allows, a cursor advanced past pages never read, a CVSS v2 row with
 * no severity, a CSRC feed rejected for its byte-order mark, a closed draft
 * left open, or every NIST story filed under the outlet "gov".
 */
import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { githubReleases } from '../packages/adapters/src/github.js';
import { ADAPTERS, adapterByName } from '../packages/adapters/src/index.js';
import {
  NIST_FEEDS,
  newsfeed,
  outletOf,
  parseFeed,
  SECTIONS,
  splitFeedSpec,
} from '../packages/adapters/src/newsfeed.js';
import {
  closesOf,
  toItem as draftItem,
  FEED,
  nistCsrcDrafts,
  parseDrafts,
  seriesOf,
} from '../packages/adapters/src/nist-csrc.js';
import {
  PAGE as DATASET_PAGE,
  toItem as datasetItem,
  modifiedOf,
  nistDatasets,
  recordsUrl,
  sinceOf,
  themesOf,
} from '../packages/adapters/src/nist-data.js';
import {
  ATTRIBUTION,
  affectedOf,
  CHUNK_DAYS,
  toItem as cveItem,
  cvssOf,
  cwesOf,
  gistOf,
  MAX_WINDOW_DAYS,
  nvd,
  nvdDate,
  nvdParam,
  pageUrl,
  windowFor,
} from '../packages/adapters/src/nvd.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';
const { COLLECTIONS, DEFAULT_FEEDS } = await import('../packages/core/src/seed.js');

const fixture = (name) =>
  readFile(new URL(`../packages/adapters/test/fixtures/${name}`, import.meta.url), 'utf8');

const DAY = 86_400_000;
const feed = (slug) => DEFAULT_FEEDS.find((f) => f.slug === slug);
const collection = (slug) => COLLECTIONS.find((c) => c.slug === slug);

describe('NVD: dates and windows', () => {
  test('an NVD timestamp has no offset and is UTC', () => {
    expect(nvdDate('2026-09-21T08:16:34.610').toISOString()).toBe('2026-09-21T08:16:34.610Z');
    expect(nvdDate('2026-09-21T08:16:34.610Z').toISOString()).toBe('2026-09-21T08:16:34.610Z');
    expect(nvdDate('2026-09-20')).toBeInstanceOf(Date);
    expect(nvdDate(null)).toBeNull();
    expect(nvdDate('never')).toBeNull();
  });

  test('a query parameter carries an explicit offset', () => {
    expect(nvdParam(new Date('2026-09-21T08:00:00Z'))).toBe('2026-09-21T08:00:00.000+00:00');
    const url = pageUrl({
      start: new Date('2026-09-19T08:00:00Z'),
      end: new Date('2026-09-21T08:00:00Z'),
      startIndex: 2000,
    });
    expect(url).toContain('lastModStartDate=2026-09-19T08%3A00%3A00.000%2B00%3A00');
    expect(url).toContain('resultsPerPage=2000');
    expect(url).toContain('startIndex=2000');
  });

  test('the first run reads a week, two days at a time, and says there is more', () => {
    const now = new Date('2026-09-21T09:00:00Z');
    const w = windowFor({}, now);
    expect(w.start.toISOString()).toBe(new Date(now.getTime() - 7 * DAY).toISOString());
    expect(w.end.getTime() - w.start.getTime()).toBe(CHUNK_DAYS * DAY);
    expect(w.more).toBe(true);
    expect(w.clamped).toBe(false);
  });

  test('a recent cursor reads to now with a few minutes of overlap', () => {
    const now = new Date('2026-09-21T09:00:00Z');
    const lastMod = new Date(now.getTime() - 3_600_000).toISOString();
    const w = windowFor({ lastMod }, now);
    expect(w.start.getTime()).toBe(new Date(lastMod).getTime() - 5 * 60_000);
    expect(w.end.toISOString()).toBe(now.toISOString());
    expect(w.more).toBe(false);
  });

  test('a cursor older than the API allows is clamped, not sent', () => {
    const now = new Date('2026-09-21T09:00:00Z');
    const w = windowFor({ lastMod: new Date(now.getTime() - 200 * DAY).toISOString() }, now);
    expect(w.clamped).toBe(true);
    expect(w.start.toISOString()).toBe(
      new Date(now.getTime() - MAX_WINDOW_DAYS * DAY).toISOString(),
    );
    expect(w.more).toBe(true);
  });
});

describe('NVD: a CVE as a row', () => {
  const page = fixture('nvd-cves.json').then(JSON.parse);

  test('the newest CVSS wins, Primary before Secondary, and v2 keeps its severity on the metric', async () => {
    const { vulnerabilities } = await page;
    const kev = cvssOf(vulnerabilities[2].cve.metrics);
    expect(kev.version).toBe('4.0');
    expect(kev.score).toBe(9.3);
    expect(kev.severity).toBe('critical');
    const live = cvssOf(vulnerabilities[0].cve.metrics);
    expect(live.version).toBe('3.1');
    expect(live.score).toBe(7.5);
    expect(live.severity).toBe('high');
    expect(cvssOf({})).toBeNull();
    expect(
      cvssOf({
        cvssMetricV2: [{ baseSeverity: 'MEDIUM', cvssData: { version: '2.0', baseScore: 5 } }],
      }).severity,
    ).toBe('medium');
  });

  test('weaknesses are CWE ids; NVD placeholders are not', () => {
    expect(
      cwesOf([
        { description: [{ lang: 'en', value: 'CWE-770' }] },
        { description: [{ lang: 'en', value: 'NVD-CWE-noinfo' }] },
        { description: [{ lang: 'en', value: 'cwe-79' }] },
      ]),
    ).toEqual(['CWE-770', 'CWE-79']);
    expect(cwesOf(undefined)).toEqual([]);
  });

  test('vendors and products come from the CNA block and from CPE criteria alike', async () => {
    const { vulnerabilities } = await page;
    expect(affectedOf(vulnerabilities[2].cve)).toEqual({
      vendors: ['example'],
      products: ['router-firmware'],
    });
    expect(
      affectedOf({
        affected: [{ vendor: 'Red Hat', product: 'Red Hat Enterprise Linux 10' }],
      }),
    ).toEqual({ vendors: ['red-hat'], products: ['red-hat-enterprise-linux-10'] });
    expect(affectedOf(vulnerabilities[0].cve)).toEqual({ vendors: [], products: [] });
  });

  test('a title carries the id and the first sentence, cut short', () => {
    expect(gistOf('Example Router before 2.1 allows remote command injection. More follows.')).toBe(
      'Example Router before 2.1 allows remote command injection.',
    );
    expect(gistOf(`${'x'.repeat(200)}.`).length).toBeLessThanOrEqual(140);
    expect(gistOf('')).toBe('');
  });

  test('a KEV entry is a critical cve with its CISA dates, and normalises', async () => {
    const { vulnerabilities } = await page;
    const it = cveItem(vulnerabilities[2]);
    expect(it.externalId).toBe('CVE-2026-99999');
    expect(it.kind).toBe('cve');
    expect(it.title).toBe(
      'CVE-2026-99999: Example Router before 2.1 allows remote command injection via the ping endpoint.',
    );
    expect(it.url).toBe('https://nvd.nist.gov/vuln/detail/CVE-2026-99999');
    expect(it.publishedAt.toISOString()).toBe('2026-09-19T14:00:00.000Z');
    expect(it.tags).toEqual(
      expect.arrayContaining([
        'nvd',
        'cve',
        'severity:critical',
        'status:analyzed',
        'kev',
        'cwe:cwe-78',
        'vendor:example',
      ]),
    );
    expect(it.data.kev).toEqual({
      added: '2026-09-20',
      due: '2026-10-11',
      name: 'Example Router Command Injection Vulnerability',
      action: 'Apply mitigations per vendor instructions.',
    });
    expect(it.data.attribution).toBe(ATTRIBUTION);
    expect(normaliseItem(it)).not.toBeNull();
    expect(cveItem({ cve: {} })).toBeNull();
  });

  test('a CVE awaiting analysis has no KEV and its status as a tag', async () => {
    const { vulnerabilities } = await page;
    const it = cveItem(vulnerabilities[0]);
    expect(it.tags).toContain('status:awaiting-analysis');
    expect(it.tags).not.toContain('kev');
    expect(it.data.kev).toBeNull();
    expect(it.data.references.length).toBeLessThanOrEqual(20);
  });
});

describe('NVD: a run', () => {
  const ctx = (http, cursor = {}) => ({
    config: {},
    cursor,
    env: {},
    http,
    log: () => {},
    budget: 10,
    deadline: Date.now() + 60_000,
    previous: async () => new Map(),
  });

  test('one page, a whole window read: the cursor moves to its end and the run says there is more', async () => {
    const body = JSON.parse(await fixture('nvd-cves.json'));
    const urls = [];
    const http = {
      json: async (url) => {
        urls.push(url);
        return body;
      },
    };
    const r = await nvd.pull(ctx(http));
    expect(urls.length).toBe(1);
    expect(urls[0]).toContain('lastModStartDate=');
    expect(r.items.length).toBe(3);
    expect(r.items.map((i) => i.externalId)).toContain('CVE-2026-99999');
    expect(new Date(r.cursor.lastMod).getTime()).toBeLessThanOrEqual(Date.now());
    expect(r.nextInMinutes).toBe(1);
    expect(r.note).toContain('catching up');
  });

  test('a failed page keeps the old cursor so the window is read again', async () => {
    const cursor = { lastMod: new Date(Date.now() - 3_600_000).toISOString() };
    const http = {
      json: async () => {
        throw new Error('403 Forbidden');
      },
    };
    const r = await nvd.pull(ctx(http, cursor));
    expect(r.items).toEqual([]);
    expect(r.cursor).toEqual(cursor);
    expect(r.note).toContain('partial');
    expect(r.nextInMinutes).toBe(5);
  });

  test('the adapter is registered in threats with its source and feeds', () => {
    expect(adapterByName('nvd')).toBe(nvd);
    expect(nvd.collection).toBe('threats');
    expect(nvd.cadenceMinutes).toBe(15);
    expect(nvd.defaultSources.map((s) => s.slug)).toEqual(['nvd-cves']);
    expect(nvd.description).toContain(ATTRIBUTION);
    expect(feed('cves')).toMatchObject({ collection: 'threats', query: { kinds: ['cve'] } });
    expect(feed('critical-cves').query).toEqual({ kinds: ['cve'], tags: ['severity:critical'] });
    expect(feed('known-exploited-cves').query).toEqual({ kinds: ['cve'], tags: ['kev'] });
    // The OpenThreat feeds name their kinds, so a CVE never leaks into them.
    expect(feed('all-threats').query.kinds).not.toContain('cve');
    expect(collection('threats').description).toContain('NVD');
  });
});

describe('NIST Science Data Portal', () => {
  const doc = fixture('nist-datasets.json').then(JSON.parse);

  test('the records URL sorts by modified, pages from one and limits the fields', () => {
    const url = recordsUrl(2);
    expect(url).toContain('page=2');
    expect(url).toContain(`size=${DATASET_PAGE}`);
    expect(url).toContain('sort.desc=modified');
    expect(url).toContain('include=ediid%2Ctitle');
  });

  test('modified arrives in two shapes and only the date is read', () => {
    expect(modifiedOf({ modified: '2026-09-14 00:00:00' })).toBe('2026-09-14');
    expect(modifiedOf({ modified: '2026-08-27' })).toBe('2026-08-27');
    expect(modifiedOf({ issued: '2025-01-02' })).toBe('2025-01-02');
    expect(modifiedOf({})).toBeNull();
  });

  test('themes are Family: Subject, and the family becomes the tag', async () => {
    const { ResultData } = await doc;
    const { all, families } = themesOf(ResultData[0]);
    expect(all).toContain('Resilience: Community resilience');
    expect(families).toEqual(['resilience', 'standards', 'metrology']);
  });

  test('a record is a dataset row dated by its revision, at noon UTC', async () => {
    const { ResultData } = await doc;
    const it = datasetItem(ResultData[0]);
    expect(it.externalId).toBe('ark:/88434/mds2-3978');
    expect(it.kind).toBe('dataset');
    expect(it.title).toBe('Tracking Community Resilience (TraCR) Database');
    expect(it.url).toBe('https://data.nist.gov/od/id/mds2-3978');
    expect(it.precision).toBe('day');
    expect(it.publishedAt.toISOString()).toBe('2026-09-14T12:00:00.000Z');
    expect(it.tags).toEqual(expect.arrayContaining(['nist', 'dataset', 'theme:resilience']));
    expect(it.data.doi).toBe('doi:10.18434/mds2-3978');
    expect(it.data.version).toBe('1.2.0');
    expect(it.data.authors.length).toBeGreaterThan(0);
    expect(normaliseItem(it)).not.toBeNull();
    expect(datasetItem({ title: 'no id' })).toBeNull();
  });

  test('the cursor is pushed back two days for the overlap', () => {
    expect(sinceOf({ since: '2026-09-14' })).toBe('2026-09-12');
    expect(sinceOf({ since: '2026-09-14 00:00:00' })).toBe('2026-09-12');
    expect(sinceOf({})).toBeNull();
  });

  test('a run walks newest first, stops at the cursor, and remembers the newest revision', async () => {
    const body = await doc;
    const http = { json: async () => body };
    const base = {
      config: {},
      env: {},
      http,
      log: () => {},
      budget: 10,
      deadline: Date.now() + 60_000,
    };
    const first = await nistDatasets.pull({ ...base, cursor: {} });
    expect(first.items.length).toBe(2);
    expect(first.cursor).toEqual({ since: '2026-09-14' });
    const later = await nistDatasets.pull({ ...base, cursor: { since: '2026-09-20' } });
    expect(later.items).toEqual([]);
    expect(later.cursor).toEqual({ since: '2026-09-20' });
  });

  test('registered in research with its source and feed', () => {
    expect(adapterByName('nist-datasets')).toBe(nistDatasets);
    expect(nistDatasets.collection).toBe('research');
    expect(nistDatasets.defaultSources.map((s) => s.slug)).toEqual(['nist-datasets']);
    expect(feed('nist-datasets')).toMatchObject({
      collection: 'research',
      query: { sources: ['nist-datasets'] },
    });
    expect(collection('research').description).toContain('NIST');
  });
});

describe('NIST CSRC: drafts open for comment', () => {
  const raw = fixture('csrc-drafts-open-for-comment.json');

  test('the feed is served with a byte-order mark, which JSON.parse rejects and parseDrafts removes', async () => {
    const text = await raw;
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(() => JSON.parse(text)).toThrow();
    const { entries, updated } = parseDrafts(text);
    expect(entries.length).toBe(9);
    expect(updated).toContain('2026-09-20');
  });

  test('the series is read off the title', () => {
    expect(seriesOf('SP 800-73-6, Interfaces for PIV')).toBe('sp-800');
    expect(seriesOf('NIST SP 1800-35, Zero Trust')).toBe('sp-1800');
    expect(seriesOf('FIPS 140-3 Implementation Guidance')).toBe('fips');
    expect(seriesOf('NIST IR 8547, Transition to PQC')).toBe('ir');
    expect(seriesOf('NIST AI 100-2 E2025')).toBe('ai');
    expect(seriesOf('CSWP 39, Cybersecurity Framework Profile')).toBe('cswp');
    expect(seriesOf('Something Untitled')).toBeNull();
  });

  test('the closing date is read from the one-line content, or absent', () => {
    expect(closesOf('Comment period closes September 30, 2026')).toEqual({
      closes: '2026-09-30',
      note: 'Comment period closes September 30, 2026',
    });
    expect(closesOf('No Due Date: Comment Period Remains Open').closes).toBeNull();
    expect(closesOf('').closes).toBeNull();
  });

  test('an entry is an open draft row with its series and deadline', async () => {
    const { entries } = parseDrafts(await raw);
    const it = draftItem(entries[0]);
    expect(it.externalId).toBe('https://csrc.nist.gov/pubs/sp/800/73/pt1/6/iwd');
    expect(it.kind).toBe('draft');
    expect(it.url).toBe('https://csrc.nist.gov/pubs/sp/800/73/pt1/6/iwd');
    expect(it.title).toContain('SP 800-73-6');
    expect(it.summary).not.toContain('<p>');
    expect(it.precision).toBe('day');
    expect(it.publishedAt.toISOString()).toBe('2026-06-12T12:00:00.000Z');
    expect(it.tags).toEqual(
      expect.arrayContaining([
        'nist',
        'csrc',
        'draft',
        'status:open',
        'series:sp-800',
        'no-due-date',
      ]),
    );
    expect(it.data.entry.id).toBe(it.externalId);
    expect(normaliseItem(it)).not.toBeNull();
    const closed = draftItem(entries[0], 'closed');
    expect(closed.tags).toContain('status:closed');
    expect(closed.tags).not.toContain('no-due-date');
  });

  test('a draft that left the feed is re-emitted closed from what it was stored with', async () => {
    const text = await raw;
    const http = { text: async (url) => (url === FEED ? text : '') };
    const gone = 'https://csrc.nist.gov/pubs/sp/800/999/ipd';
    const previous = async (ids) =>
      new Map(
        ids
          .filter((id) => id === gone)
          .map((id) => [
            id,
            {
              status: 'open',
              entry: {
                id,
                title: 'SP 800-999, A Draft That Closed',
                summary: '<p>Gone.</p>',
                link: gone,
                content: 'Comment period closes September 1, 2026',
                published: '2026-07-01T00:00:00',
                updated: '2026-07-01T00:00:00',
              },
            },
          ]),
      );
    const r = await nistCsrcDrafts.pull({
      config: {},
      cursor: { ids: [gone, 'https://csrc.nist.gov/pubs/sp/800/73/pt1/6/iwd'] },
      env: {},
      http,
      previous,
      log: () => {},
      budget: 10,
      deadline: Date.now() + 60_000,
    });
    expect(r.items.length).toBe(10);
    const closed = r.items.find((i) => i.externalId === gone);
    expect(closed.tags).toContain('status:closed');
    expect(closed.tags).toContain('series:sp-800');
    expect(closed.data.closes).toBe('2026-09-01');
    expect(r.cursor.ids.length).toBe(9);
    expect(r.cursor.ids).not.toContain(gone);
  });

  test('registered in research with its source and feed', () => {
    expect(adapterByName('nist-csrc-drafts')).toBe(nistCsrcDrafts);
    expect(nistCsrcDrafts.collection).toBe('research');
    expect(feed('nist-drafts-open-for-comment')).toMatchObject({
      collection: 'research',
      query: { sources: ['nist-csrc-drafts'], tags: ['status:open'] },
    });
  });
});

describe('NIST newsroom feeds', () => {
  test('the outlet of a .gov feed is the agency, not "gov"', () => {
    expect(outletOf('https://www.nist.gov/news-events/news/rss.xml')).toBe('nist');
    expect(outletOf('https://feeds.npr.org/1001/rss.xml')).toBe('npr');
    expect(outletOf('https://feeds.bbci.co.uk/news/world/rss.xml')).toBe('bbci');
  });

  test('every NIST feed names a shipped section, the catch-all comes first, and the empty topics are absent', () => {
    expect(NIST_FEEDS.length).toBeGreaterThanOrEqual(25);
    expect(NIST_FEEDS.length).toBeLessThanOrEqual(60);
    expect(splitFeedSpec(NIST_FEEDS[0]).url).toBe('https://www.nist.gov/news-events/news/rss.xml');
    const urls = NIST_FEEDS.map((s) => splitFeedSpec(s).url);
    expect(new Set(urls).size).toBe(urls.length);
    for (const spec of NIST_FEEDS) {
      const { section, url } = splitFeedSpec(spec);
      expect(SECTIONS).toContain(section);
      expect(url.startsWith('https://www.nist.gov/')).toBe(true);
    }
    // Fetched empty on 2026-09-21: forty items in every other topic, none here.
    expect(urls).not.toContain('https://www.nist.gov/news-events/bioscience/rss.xml');
    expect(urls).not.toContain('https://www.nist.gov/news-events/cybersecurity/rss.xml');
  });

  test('a NIST story parses with the section it was filed under and the outlet nist', async () => {
    const xml = await fixture('nist-news.xml');
    const items = parseFeed(xml, 'https://www.nist.gov/news-events/news/rss.xml', 'science');
    expect(items.length).toBe(3);
    expect(items[0].externalId).toBe('nist:https://www.nist.gov/node/1920201');
    expect(items[0].tags).toEqual(expect.arrayContaining(['news', 'science', 'nist']));
    expect(items[0].data.outlet).toBe('nist');
    expect(items[0].data.author).toBe('Sarah Henderson');
    expect(normaliseItem(items[0])).not.toBeNull();
  });

  test('the nist-news source and feed are seeded', () => {
    const src = newsfeed.defaultSources.find((s) => s.slug === 'nist-news');
    expect(src.config.feeds).toBe(NIST_FEEDS);
    expect(src.cadenceMinutes).toBe(60);
    expect(feed('nist-news')).toMatchObject({
      collection: 'news',
      query: { sources: ['nist-news'] },
    });
  });
});

describe('NIST software on GitHub', () => {
  test('a releases source over usnistgov, read slowly on the keyless allowance', () => {
    const src = githubReleases.defaultSources.find((s) => s.slug === 'github-releases-nist');
    expect(src.cadenceMinutes).toBe(180);
    expect(src.config.repos.length).toBeGreaterThanOrEqual(6);
    for (const r of src.config.repos) expect(r.startsWith('usnistgov/')).toBe(true);
    expect(feed('nist-software-releases')).toMatchObject({
      collection: 'packages',
      query: { sources: ['github-releases-nist'] },
    });
  });

  test('no two adapters or seeded slugs collide after the additions', () => {
    const names = ADAPTERS.map((a) => a.name);
    expect(new Set(names).size).toBe(names.length);
    const slugs = ADAPTERS.flatMap((a) => (a.defaultSources ?? []).map((s) => s.slug));
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});
