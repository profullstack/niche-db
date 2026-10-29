/**
 * Vulns: OSV, CISA KEV, ExploitGym and OpenVuln publishers, joined per
 * vulnerability into one OpenVuln record. What would be embarrassing: a
 * backfill that skips records because the list moved under it, a high-water
 * mark advanced past a record that failed to fetch, a kernelCTF suffix kept on
 * a CVE, "in a benchmark" shown as "an agent exploited it", a CVE missing
 * from KEV shown as unchecked (or a non-CVE shown as not in KEV), a
 * publisher's record believed from someone else's host, an alias that does not
 * find its record, or exploit code in a house record.
 */
import { describe, expect, test } from 'bun:test';
import { migratedPglite, pgliteSql } from './helpers/pglite.js';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';

const { adapterByName } = await import('../packages/adapters/src/index.js');
const osvMod = await import('../packages/adapters/src/osv.js');
const kevMod = await import('../packages/adapters/src/cisa-kev.js');
const eg = await import('../packages/adapters/src/exploitgym.js');
const ovMod = await import('../packages/adapters/src/openvuln.js');
const core = await import('../packages/core/src/openvuln.js');
const { DEFAULT_FEEDS, COLLECTIONS } = await import('../packages/core/src/seed.js');
const { itemsForKeys } = await import('../packages/db/src/vulns.js');
const { vulnReport } = await import('../apps/web/src/lib/vulns.js');
const sig = await import('../packages/adapters/src/exploit-signals.js');
const tb = await import('../packages/adapters/src/repo-tarballs.js');
const { tarGzEntries } = await import('../packages/core/src/dump.js');

const GEMINI = {
  id: 'GHSA-wpqr-6v78-jr5g',
  aliases: ['CVE-2026-12537'],
  summary: 'Gemini CLI: Remote Code Execution via workspace trust and tool allowlisting bypasses',
  published: '2026-04-24T19:30:01Z',
  modified: '2026-05-01T00:00:00Z',
  severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H' }],
  affected: [
    {
      package: { name: '@google/gemini-cli', ecosystem: 'npm' },
      ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '0.39.1' }] }],
    },
  ],
  references: [{ type: 'ADVISORY', url: 'https://github.com/advisories/GHSA-wpqr-6v78-jr5g' }],
  database_specific: { severity: 'CRITICAL', cwe_ids: ['CWE-77'] },
};

describe('osv adapter', () => {
  test('is registered in vulns with two default sources whose config it accepts', () => {
    const a = adapterByName('osv');
    expect(a.collection).toBe('vulns');
    expect(a.defaultSources.map((s) => s.slug)).toEqual(['osv-advisories', 'osv-malicious']);
  });

  test('parses a modified list newest first, drops a cut last line, and orders ties by id', () => {
    const text =
      '2026-10-29T00:00:02Z,B\n2026-10-29T00:00:02Z,A\n2026-10-28T00:00:00Z,C\n2026-10-27T0';
    expect(osvMod.parseModifiedCsv(text, { complete: false }).map((r) => r.id)).toEqual([
      'A',
      'B',
      'C',
    ]);
    expect(osvMod.parseModifiedCsv('garbage\n\n', {})).toEqual([]);
  });

  test('keeps advisory prefixes, skips MAL in the advisory source', () => {
    const f = { prefixes: osvMod.ADVISORY_PREFIXES, skipPrefixes: ['MAL'] };
    expect(osvMod.wanted('GHSA-aaaa-bbbb-cccc', f)).toBe(true);
    expect(osvMod.wanted('MAL-2026-1', f)).toBe(false);
    expect(osvMod.wanted('CGA-xxxx', f)).toBe(false);
    expect(osvMod.wanted('MAL-2026-1', { prefixes: ['MAL'] })).toBe(true);
  });

  test('a record becomes a row tagged with every id it answers to', () => {
    const item = osvMod.toItem(GEMINI, { ecosystem: 'npm' });
    expect(item.externalId).toBe('GHSA-wpqr-6v78-jr5g');
    expect(item.kind).toBe('vuln');
    expect(item.tags).toContain('id:ghsa-wpqr-6v78-jr5g');
    expect(item.tags).toContain('id:cve-2026-12537');
    expect(item.tags).toContain('severity:critical');
    expect(item.tags).toContain('fix:fixed');
    expect(item.tags).toContain('pkg:npm/@google/gemini-cli');
    expect(item.data.fix).toEqual({ status: 'fixed', versions: ['0.39.1'] });
  });

  test('a fix only for some ranges is partial, none is unfixed, MAL is a malicious package', () => {
    const open = { ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }] }] };
    const shut = { ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '2' }] }] };
    expect(osvMod.fixOf({ affected: [open, shut] }).status).toBe('partial');
    expect(osvMod.fixOf({ affected: [open] }).status).toBe('unfixed');
    expect(osvMod.fixOf({ affected: [] })).toBeNull();
    const mal = osvMod.toItem({
      id: 'MAL-2026-18177',
      summary: 'Malicious code in data-pipeline-testmetest (npm)',
      affected: [{ package: { name: 'data-pipeline-testmetest', ecosystem: 'npm' }, ...open }],
    });
    expect(mal.kind).toBe('malicious-package');
    expect(mal.tags).toContain('class:malicious-package');
  });

  test('an OSS-Fuzz record carries its issue number', () => {
    expect(
      osvMod.ossFuzzIssue({
        references: [{ url: 'https://bugs.chromium.org/p/oss-fuzz/issues/detail?id=58813' }],
      }),
    ).toBe('58813');
    expect(
      osvMod.ossFuzzIssue({
        references: [{ url: 'https://issues.oss-fuzz.com/issues/378102638' }],
      }),
    ).toBe('378102638');
    expect(
      osvMod.toItem({
        id: 'OSV-2023-390',
        summary: 'x',
        references: [{ url: 'https://bugs.chromium.org/p/oss-fuzz/issues/detail?id=58813' }],
      }).tags,
    ).toContain('oss-fuzz:58813');
  });

  // A fake bucket: one ecosystem's list and records, with a Range read on the head.
  function bucket(list, { fail = new Set() } = {}) {
    const calls = [];
    const csv = () => list.map((r) => `${r.modified},${r.id}`).join('\n');
    return {
      calls,
      http: {
        async request(url, { headers } = {}) {
          calls.push(['head', url, headers?.range]);
          const body = csv();
          return new Response(body, {
            status: 206,
            headers: { 'content-range': `bytes 0-${body.length - 1}/${body.length}` },
          });
        },
        async text(url) {
          calls.push(['full', url]);
          return csv();
        },
        async json(url) {
          const id = decodeURIComponent(
            url
              .split('/')
              .pop()
              .replace(/\.json$/, ''),
          );
          calls.push(['record', id]);
          if (fail.has(id)) throw new Error('503');
          return { id, summary: `record ${id}`, modified: list.find((r) => r.id === id)?.modified };
        },
      },
    };
  }
  const run = (http, cursor, config = {}) =>
    osvMod.osv.pull({
      config: { ecosystems: ['npm'], prefixes: [], skipPrefixes: [], perRun: 2, ...config },
      cursor,
      http,
      log: () => {},
      deadline: Date.now() + 60_000,
    });

  test('first run marks the high water, then the backlog is walked oldest-unread in slices without skipping', async () => {
    const list = [
      { modified: '2026-10-29T00:00:00Z', id: 'GHSA-4' },
      { modified: '2026-10-28T00:00:00Z', id: 'GHSA-3' },
      { modified: '2026-10-27T00:00:00Z', id: 'GHSA-2' },
      { modified: '2026-10-26T00:00:00Z', id: 'GHSA-1' },
    ];
    const b = bucket(list);
    const r1 = await run(b.http, {});
    expect(r1.cursor.ecosystems.npm.hw.id).toBe('GHSA-4');
    // The first run marks the high water and also starts the backlog, newest first, two at a time.
    expect(r1.items.map((i) => i.externalId)).toEqual(['GHSA-4', 'GHSA-3']);
    // A new record lands at the top: the walk is by position, not line number, so nothing is skipped.
    list.unshift({ modified: '2026-10-30T00:00:00Z', id: 'GHSA-5' });
    const r2 = await run(b.http, r1.cursor);
    expect(r2.items.map((i) => i.externalId)).toEqual(['GHSA-5', 'GHSA-2']);
    expect(r2.cursor.ecosystems.npm.hw.id).toBe('GHSA-5');
    const r3 = await run(b.http, r2.cursor);
    expect(r3.items.map((i) => i.externalId)).toEqual(['GHSA-1']);
    expect(r3.cursor.ecosystems.npm.bfDone).toBe(true);
    expect(r3.nextInMinutes).toBeUndefined();
    // Steady state reads only the head of the list.
    b.calls.length = 0;
    await run(b.http, r3.cursor);
    expect(b.calls.filter((c) => c[0] === 'full')).toEqual([]);
    expect(b.calls[0][2]).toBe(`bytes=0-${osvMod.HEAD_BYTES - 1}`);
  });

  test('a record that fails to fetch holds the high water where it was', async () => {
    const list = [{ modified: '2026-10-28T00:00:00Z', id: 'GHSA-1' }];
    const b = bucket(list, { fail: new Set(['GHSA-2']) });
    const r1 = await run(b.http, {}, { perRun: 5 });
    list.unshift({ modified: '2026-10-29T00:00:00Z', id: 'GHSA-2' });
    const r2 = await run(b.http, r1.cursor, { perRun: 5 });
    expect(r2.cursor.ecosystems.npm.hw.id).toBe('GHSA-1');
  });

  test('backfillDays stops the backlog at the floor', async () => {
    const now = Date.now();
    const iso = (days) => new Date(now - days * 86_400_000).toISOString();
    const list = [
      { modified: iso(1), id: 'MAL-3' },
      { modified: iso(2), id: 'MAL-2' },
      { modified: iso(90), id: 'MAL-1' },
    ];
    const r = await run(bucket(list).http, {}, { perRun: 10, backfillDays: 30 });
    expect(r.items.map((i) => i.externalId)).toEqual(['MAL-3', 'MAL-2']);
    expect(r.cursor.ecosystems.npm.bfDone).toBe(true);
  });
});

describe('cisa-kev adapter', () => {
  const entry = {
    cveID: 'CVE-2026-41940',
    vendorProject: 'WebPros',
    product: 'cPanel & WHM and WP2 (WordPress Squared)',
    vulnerabilityName:
      'WebPros cPanel & WHM Missing Authentication for Critical Function Vulnerability',
    dateAdded: '2026-04-30',
    shortDescription: 'An authentication bypass in the login flow.',
    requiredAction: 'Apply mitigations per vendor instructions.',
    dueDate: '2026-05-03',
    knownRansomwareCampaignUse: 'Known',
    cwes: ['CWE-306'],
  };
  test('an entry is a kev row with ransomware use, due date and the id tag', () => {
    const item = kevMod.toItem(entry);
    expect(item.kind).toBe('kev');
    expect(item.tags).toEqual(
      expect.arrayContaining([
        'kev',
        'id:cve-2026-41940',
        'ransomware',
        'vendor:webpros',
        'cwe:cwe-306',
      ]),
    );
    expect(item.data).toMatchObject({
      added: '2026-04-30',
      due: '2026-05-03',
      ransomware: 'known',
    });
    expect(kevMod.toItem({ cveID: 'not a cve' })).toBeNull();
  });
  test('an unchanged catalog version writes nothing', async () => {
    const http = { json: async () => ({ catalogVersion: '2026.10.28', vulnerabilities: [entry] }) };
    const first = await kevMod.cisaKev.pull({ cursor: {}, http, log: () => {} });
    expect(first.items).toHaveLength(1);
    const again = await kevMod.cisaKev.pull({ cursor: first.cursor, http, log: () => {} });
    expect(again.items).toEqual([]);
  });
});

describe('exploitgym adapter', () => {
  test('task ids become the keys that join them to the rest of /c/vulns', () => {
    expect(eg.parseTask('kernel:kernelctf/CVE-2023-3776_lts')).toMatchObject({
      ids: ['CVE-2023-3776'],
      keys: [],
    });
    expect(eg.parseTask('user:nofuzz/GHSA-44mr-8vmm-wjhg').ids).toEqual(['GHSA-44mr-8vmm-wjhg']);
    expect(eg.parseTask('user:cybergym/arvo_60557').keys).toEqual(['oss-fuzz:60557']);
    expect(eg.parseTask('user:cybergym/oss-fuzz_378102638').keys).toEqual(['oss-fuzz:378102638']);
    expect(eg.parseTask('kernel:syzbot/03d6270b6425df1605bf').keys).toEqual([
      'syzbot:03d6270b6425df1605bf',
    ]);
    expect(eg.parseTask('v8:clusterfuzz/361124378').keys).toEqual(['crbug:361124378']);
    expect(eg.parseTask('nonsense')).toBeNull();
  });
  test('a row says the vulnerability is in the benchmark, not that an agent succeeded', () => {
    const item = eg.toItem(
      eg.parseTask('kernel:kernelctf/CVE-2023-3776_lts'),
      'A use-after-free in cls_fw.',
    );
    expect(item.kind).toBe('ai-exploit');
    expect(item.data.result).toBe('unstated');
    expect(item.tags).toContain('id:cve-2023-3776');
    expect(item.url).toContain('/tree/main/data/tasks/kernel/kernelctf/CVE-2023-3776_lts');
  });
  test('only description files are read, never the proof of concept', async () => {
    const asked = [];
    const http = {
      text: async (url) => {
        asked.push(url);
        if (url.endsWith('v1.txt')) return 'user:cybergym/arvo_1\n';
        if (url.endsWith('description.txt')) return 'A heap overflow.';
        throw new Error('404');
      },
    };
    const r = await eg.exploitgym.pull({
      http,
      log: () => {},
      previous: async () => new Map(),
      deadline: Date.now() + 10_000,
    });
    expect(r.items[0].summary).toBe('A heap overflow.');
    expect(asked.some((u) => /\/(poc|pov)(\/|$)|exploit/.test(u.replace('exploitgym', '')))).toBe(
      false,
    );
  });
});

describe('openvuln adapter and the house records', () => {
  test('every house record is OSV-shaped, OpenVuln 0.1, attributed, and carries no exploit code', () => {
    for (const r of ovMod.HOUSE.records) {
      expect(r.id).toMatch(/^NDB-\d{4}-\d{4}$/);
      expect(r.summary).toBeTruthy();
      const ov = r.database_specific.openvuln;
      expect(ov.version).toBe('0.1');
      expect(ov.sources.length).toBeGreaterThan(0);
      expect(ov.deep_dive.made_by).toBe('ai');
      expect(JSON.stringify(r)).not.toMatch(/<script|eval\(|child_process|curl\s+-[a-z]*\s+http/i);
      // Indicators are defanged.
      for (const i of r.database_specific.iocs ?? [])
        expect(i.value).not.toMatch(/https?:\/\/|\d+\.\d+\.\d+\.\d+/);
    }
  });
  test('house records become rows tagged by id, alias and related id', () => {
    const item = ovMod.toItem(ovMod.HOUSE.records[0], ovMod.HOUSE.publisher);
    expect(item.externalId).toBe('nichedb.dev:NDB-2026-0001');
    expect(item.tags).toEqual(
      expect.arrayContaining([
        'id:ndb-2026-0001',
        'related:mal-2026-18177',
        'subject:campaign',
        'class:agent-config',
      ]),
    );
    const gem = ovMod.toItem(ovMod.HOUSE.records[1], ovMod.HOUSE.publisher);
    expect(gem.tags).toEqual(
      expect.arrayContaining(['id:cve-2026-12537', 'id:ghsa-wpqr-6v78-jr5g']),
    );
  });
  test('an index is believed only from the publisher it names', async () => {
    const http = { json: async () => ({ id: 'X-1', summary: 'remote' }) };
    const doc = {
      publisher: { name: 'Acme', web: 'https://acme.example' },
      records: [
        { id: 'ACME-1', summary: 'inline' },
        { id: 'X-1', url: 'https://evil.example/x.json' },
      ],
    };
    const ok = await ovMod.readIndex(doc, 'https://acme.example/.well-known/openvuln.json', http);
    expect(ok.items.map((i) => i.externalId)).toEqual(['acme.example:ACME-1']);
    const bad = await ovMod.readIndex(
      doc,
      'https://mirror.example/.well-known/openvuln.json',
      http,
    );
    expect(bad.rejected).toBe('origin');
    expect(ovMod.indexUrl('acme.example')).toBe('https://acme.example/.well-known/openvuln.json');
  });
});

describe('seed', () => {
  test('the vulns collection and its feeds exist, with unique slugs', () => {
    expect(COLLECTIONS.find((c) => c.slug === 'vulns').description).toContain('EPSS');
    const vf = DEFAULT_FEEDS.filter((f) => f.collection === 'vulns').map((f) => f.slug);
    expect(vf).toEqual(
      expect.arrayContaining([
        'kev',
        'malicious-packages',
        'ai-exploit-benchmark',
        'openvuln-records',
      ]),
    );
    const all = DEFAULT_FEEDS.map((f) => f.slug);
    expect(new Set(all).size).toBe(all.length);
  });
});

// Rows as the database hands them back.
const row = (item, extra = {}) => ({
  id: Math.floor(Math.random() * 1e9),
  adapter: extra.adapter ?? 'osv',
  source: extra.source ?? 'osv-advisories',
  source_name: extra.source_name ?? 'OSV',
  external_id: item.externalId,
  kind: item.kind,
  title: item.title,
  summary: item.summary,
  url: item.url,
  published_at: item.publishedAt,
  tags: item.tags,
  data: item.data,
  updated_at: '2026-10-29T00:00:00Z',
});

describe('buildRecord', () => {
  const osvRow = row(osvMod.toItem(GEMINI, { ecosystem: 'npm' }));
  const houseRow = row(ovMod.toItem(ovMod.HOUSE.records[1], ovMod.HOUSE.publisher), {
    adapter: 'openvuln',
    source_name: 'nichedb.dev OpenVuln records',
  });

  test('OSV alone: affected, fix, label from GitHub, KEV checked and absent for its CVE', () => {
    const { record } = core.buildRecord('GHSA-wpqr-6v78-jr5g', {
      rows: [osvRow],
      epss: { cve: 'CVE-2026-12537', score: 0.00212, percentile: 0.11456, date: '2026-10-28' },
    });
    const ov = record.database_specific.openvuln;
    expect(record.id).toBe('GHSA-wpqr-6v78-jr5g');
    expect(record.aliases).toEqual(['CVE-2026-12537']);
    expect(ov.label).toBe('critical');
    expect(ov.fix.status).toBe('fixed');
    expect(ov.exploitation.kev).toBeNull();
    expect(ov.exploitation.status).toBeUndefined();
    expect(ov.exploitation.epss.score).toBe(0.00212);
    expect(ov.sources.map((s) => s.name)).toEqual(
      expect.arrayContaining(['OSV', 'CISA KEV', 'FIRST EPSS']),
    );
  });

  test('the publisher record wins for words, and asking by CVE finds it', () => {
    const { record } = core.buildRecord('CVE-2026-12537', { rows: [houseRow, osvRow] });
    expect(record.id).toBe('NDB-2026-0002');
    expect(record.aliases).toEqual(
      expect.arrayContaining(['CVE-2026-12537', 'GHSA-wpqr-6v78-jr5g']),
    );
    expect(record.database_specific.openvuln.subject.kind).toBe('agent');
    expect(record.database_specific.openvuln.exploitation.status).toBe('poc-public');
    expect(record.database_specific.openvuln.deep_dive.made_by).toBe('ai');
  });

  test('KEV with ransomware use is the strongest exploitation status, and an AI task is listed as unstated', () => {
    const kev = row(
      kevMod.toItem({
        cveID: 'CVE-2023-3776',
        vulnerabilityName: 'x',
        dateAdded: '2024-01-01',
        knownRansomwareCampaignUse: 'Known',
      }),
      { adapter: 'cisa-kev' },
    );
    const ai = row(eg.toItem(eg.parseTask('kernel:kernelctf/CVE-2023-3776_lts'), 'uaf'), {
      adapter: 'exploitgym',
    });
    const { record } = core.buildRecord('CVE-2023-3776', { rows: [kev, ai] });
    const ex = record.database_specific.openvuln.exploitation;
    expect(ex.status).toBe('exploited-ransomware');
    expect(ex.kev.ransomware).toBe(true);
    expect(ex.ai).toEqual([
      expect.objectContaining({ benchmark: 'ExploitGym', result: 'unstated' }),
    ]);
  });

  test('a malicious package shows the campaign it belongs to', () => {
    const mal = row(
      osvMod.toItem({
        id: 'MAL-2026-18177',
        summary: 'Malicious code in data-pipeline-testmetest (npm)',
      }),
    );
    const camp = row(ovMod.toItem(ovMod.HOUSE.records[0], ovMod.HOUSE.publisher), {
      adapter: 'openvuln',
    });
    const { record, parts } = core.buildRecord('MAL-2026-18177', { rows: [mal, camp] });
    expect(record.id).toBe('MAL-2026-18177');
    expect(parts.campaigns.map((c) => c.data.record.id)).toEqual(['NDB-2026-0001']);
    expect(record.related).toContain('NDB-2026-0001');
    expect(record.database_specific.openvuln.class).toContain('malicious-package');
    expect(record.database_specific.openvuln.exploitation.status).toBe('exploited');
    // No CVE, so KEV is not "checked and absent": it is unstated.
    expect('kev' in record.database_specific.openvuln.exploitation).toBe(false);
  });

  test('the NVD alone still makes a record, labelled from its CVSS', () => {
    const nvd = {
      external_id: 'CVE-2020-0001',
      title: 'CVE-2020-0001: A bug.',
      summary: 'A bug.',
      url: 'https://nvd.nist.gov/vuln/detail/CVE-2020-0001',
      updated_at: '2026-10-01',
      data: {
        cvss: { version: '3.1', score: 7.5, severity: null, vector: 'CVSS:3.1/AV:N' },
        cwes: ['CWE-20'],
        published: '2020-01-01T00:00:00.000',
      },
    };
    const { record } = core.buildRecord('CVE-2020-0001', { nvd });
    expect(record.database_specific.openvuln.label).toBe('high');
    expect(record.severity[0].type).toBe('CVSS_V3');
    expect(record.database_specific.cwe_ids).toEqual(['CWE-20']);
  });

  test('a label the NVD supplies names the NVD once in sources', () => {
    const nvd = {
      external_id: 'CVE-2020-0002',
      title: 'CVE-2020-0002: A bug.',
      url: 'https://nvd.nist.gov/vuln/detail/CVE-2020-0002',
      data: { cvss: { version: '3.1', score: 9.8, severity: 'critical', vector: 'CVSS:3.1/AV:N' } },
    };
    const { record } = core.buildRecord('CVE-2020-0002', { nvd });
    const ov = record.database_specific.openvuln;
    expect(ov.label).toBe('critical');
    expect(ov.sources.filter((s) => s.name === 'NVD')).toHaveLength(1);
  });

  test('nothing known is null', () => {
    expect(core.buildRecord('CVE-1999-0001', {})).toBeNull();
    expect(core.normaliseId('cve-2026-12537.json')).toBe('CVE-2026-12537');
    expect(core.normaliseId('<script>')).toBeNull();
  });
});

describe('itemsForKeys + vulnReport', () => {
  test('the overlap query finds rows by any key, only in vulns', async () => {
    const sql = pgliteSql(await migratedPglite());
    const [{ id: vid }] =
      await sql`insert into collections (slug, name) values ('vulns', 'Vulnerabilities') returning id`;
    const [{ id: tid }] =
      await sql`insert into collections (slug, name) values ('threats', 'Threats') returning id`;
    const [{ id: s1 }] =
      await sql`insert into sources (collection_id, adapter, slug, name) values (${vid}, 'osv', 'osv-advisories', 'OSV') returning id`;
    const [{ id: s2 }] =
      await sql`insert into sources (collection_id, adapter, slug, name) values (${tid}, 'other', 'other', 'Other') returning id`;
    await sql`insert into items (collection_id, source_id, external_id, kind, title, tags, data)
      values (${vid}, ${s1}, 'GHSA-1', 'vuln', 'one', '{id:ghsa-1,id:cve-2026-1}', '{}'),
             (${vid}, ${s1}, 'OSV-2', 'vuln', 'two', '{id:osv-2,oss-fuzz:9}', '{}'),
             (${tid}, ${s2}, 'X', 'vuln', 'decoy', '{id:cve-2026-1}', '{}')`;
    const rows = await itemsForKeys(['id:cve-2026-1', 'oss-fuzz:9'], { db: sql });
    expect(rows.map((r) => r.external_id).sort()).toEqual(['GHSA-1', 'OSV-2']);
    expect(await itemsForKeys([], { db: sql })).toEqual([]);
  });

  test('a page finds the KEV entry through the alias, and an id not ingested yet is read live from OSV', async () => {
    const osvRow = row(osvMod.toItem(GEMINI, { ecosystem: 'npm' }));
    const kev = row(
      kevMod.toItem({ cveID: 'CVE-2026-12537', vulnerabilityName: 'x', dateAdded: '2026-10-01' }),
      { adapter: 'cisa-kev' },
    );
    const byKey = (rows) => async (keys) =>
      rows.filter((r) => r.tags.some((t) => keys.includes(t)));
    const deps = {
      itemsForKeys: byKey([osvRow, kev]),
      nvdFor: async () => [],
      epss: async () => null,
      live: async () => null,
    };
    const r = await vulnReport('GHSA-wpqr-6v78-jr5g', deps);
    expect(r.record.database_specific.openvuln.exploitation.status).toBe('exploited');

    const live = { ...GEMINI, id: 'GHSA-live-live-live', aliases: ['CVE-2026-12537'] };
    const r2 = await vulnReport('GHSA-live-live-live', {
      ...deps,
      itemsForKeys: byKey([kev]),
      live: async () => live,
    });
    expect(r2.record.id).toBe('GHSA-live-live-live');
    expect(r2.record.database_specific.openvuln.sources.map((s) => s.name)).toContain(
      'OSV (read live)',
    );
    expect(r2.record.database_specific.openvuln.exploitation.kev.added).toBe('2026-10-01');

    const none = await vulnReport('CVE-1999-0001', { ...deps, itemsForKeys: async () => [] });
    expect(none.status).toBe(404);
    expect((await vulnReport('', deps)).status).toBe(400);
  });
});

describe('exploit signals', () => {
  test('Exploit-DB CSV: quoted commas and newlines, CVEs from codes, rows without a CVE dropped', () => {
    const csv =
      'id,file,description,date_published,author,type,platform,port,date_added,date_updated,verified,codes,tags,aliases,screenshot_url,application_url,source_url\n' +
      '16929,exploits/aix/dos/16929.rb,"AIX rpc.cmsd, Opcode 21 - ""Buffer"" Overflow",2010-11-11,Metasploit,dos,aix,,2010-11-11,2011-03-06,1,CVE-2009-3699;OSVDB-58726,,,,,\n' +
      '1,exploits/x/1.txt,"no cve\nat all",2001-01-01,x,local,linux,,2001-01-01,2001-01-01,0,OSVDB-1,,,,,\n';
    const items = sig.parseExploitDb(csv);
    expect(items).toHaveLength(1);
    expect(items[0].externalId).toBe('EDB-16929');
    expect(items[0].title).toContain('"Buffer"');
    expect(items[0].tags).toEqual(
      expect.arrayContaining(['id:cve-2009-3699', 'verified', 'platform:aix']),
    );
    expect(items[0].url).toBe('https://www.exploit-db.com/exploits/16929');
  });

  test('Metasploit: only modules that reference a CVE, rank named', () => {
    const m = sig.metasploitItem('x', {
      name: 'Log4Shell',
      fullname: 'exploit/multi/http/log4shell',
      type: 'exploit',
      rank: 600,
      references: ['CVE-2021-44228', 'URL-https://x'],
      path: '/modules/exploits/multi/http/log4shell.rb',
      check: true,
    });
    expect(m.tags).toEqual(
      expect.arrayContaining(['metasploit', 'id:cve-2021-44228', 'rank:excellent', 'has-check']),
    );
    expect(sig.metasploitItem('y', { references: ['OSVDB-1'] })).toBeNull();
  });

  test('Nuclei: one template line per CVE', () => {
    const n = sig.nucleiItem(
      '{"ID":"CVE-2000-0114","Info":{"Name":"FrontPage","Severity":"medium"},"file_path":"http/cves/2000/CVE-2000-0114.yaml"}',
    );
    expect(n.kind).toBe('scanner-check');
    expect(n.tags).toEqual(['nuclei', 'id:cve-2000-0114', 'severity:medium']);
    expect(sig.nucleiItem('not json')).toBeNull();
  });

  test('Vulnrichment: SSVC from the CISA ADP container, mapped to an exploitation status', () => {
    const rec = {
      cveMetadata: { cveId: 'CVE-2026-41940' },
      containers: {
        cna: { title: 'cPanel auth bypass' },
        adp: [
          { providerMetadata: { shortName: 'CVE' }, metrics: [] },
          {
            providerMetadata: { shortName: 'CISA-ADP' },
            metrics: [
              {
                other: {
                  type: 'ssvc',
                  content: {
                    options: [
                      { Exploitation: 'active' },
                      { Automatable: 'yes' },
                      { 'Technical Impact': 'total' },
                    ],
                    timestamp: '2026-04-30T16:41:31Z',
                  },
                },
              },
              { other: { type: 'kev', content: { dateAdded: '2026-04-30' } } },
            ],
          },
        ],
      },
    };
    const item = tb.vulnrichmentItem(rec);
    expect(item.data.status).toBe('exploited');
    expect(item.tags).toEqual(
      expect.arrayContaining([
        'id:cve-2026-41940',
        'ssvc-exploitation:active',
        'ssvc-automatable:yes',
        'kev',
      ]),
    );
    expect(
      tb.vulnrichmentItem({ cveMetadata: { cveId: 'CVE-2026-1' }, containers: { adp: [] } }),
    ).toBeNull();
  });

  test('PoC-in-GitHub: forks dropped, best-starred first, always unvetted', () => {
    const item = tb.pocItem(
      [
        { html_url: 'https://github.com/a/fork', fork: true, stargazers_count: 99 },
        {
          html_url: 'https://github.com/a/low',
          stargazers_count: 1,
          created_at: '2026-05-01T00:00:00Z',
        },
        {
          html_url: 'https://github.com/a/high',
          stargazers_count: 26,
          created_at: '2026-04-29T00:00:00Z',
        },
      ],
      'PoC-in-GitHub-master/2026/CVE-2026-41940.json',
    );
    expect(item.data.repos.map((r) => r.url)).toEqual([
      'https://github.com/a/high',
      'https://github.com/a/low',
    ]);
    expect(item.data.vetted).toBe(false);
    expect(item.url).toBe(
      'https://github.com/nomi-sec/PoC-in-GitHub/blob/master/2026/CVE-2026-41940.json',
    );
    expect(item.publishedAt).toBe('2026-04-29T00:00:00Z');
  });

  test('tarGzEntries streams members, honours pax long names, and skips filtered ones', async () => {
    const dir = await import('node:fs/promises').then((f) =>
      f.mkdtemp(`${process.env.TMPDIR ?? '/tmp'}/tgz-`),
    );
    const long = `${'d'.repeat(120)}/CVE-2026-1.json`;
    const fs = await import('node:fs/promises');
    await fs.mkdir(`${dir}/src/${'d'.repeat(120)}`, { recursive: true });
    await fs.writeFile(`${dir}/src/${long}`, '{"a":1}');
    await fs.writeFile(`${dir}/src/skip.txt`, 'x'.repeat(2000));
    const p = Bun.spawnSync([
      'tar',
      '--format=pax',
      '-czf',
      `${dir}/a.tgz`,
      '-C',
      `${dir}/src`,
      '.',
    ]);
    expect(p.exitCode).toBe(0);
    const got = [];
    for await (const e of tarGzEntries(`${dir}/a.tgz`, { filter: (n) => n.endsWith('.json') }))
      got.push([e.name, e.body.toString()]);
    expect(got).toEqual([[`./${long}`, '{"a":1}']]);
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('the merge: SSVC active and a Metasploit module raise the status; PoC claims alone do not', () => {
    const msf = row(
      sig.metasploitItem('k', {
        name: 'cPanel bypass',
        fullname: 'exploit/x/cpanel',
        type: 'exploit',
        rank: 600,
        references: ['CVE-2026-41940'],
        path: '/m.rb',
      }),
      { adapter: 'metasploit' },
    );
    const poc = row(
      tb.pocItem(
        [{ html_url: 'https://github.com/a/b', stargazers_count: 3 }],
        'x/2026/CVE-2026-41940.json',
      ),
      { adapter: 'poc-in-github' },
    );
    const ssvcNone = row(
      {
        ...tb.vulnrichmentItem({
          cveMetadata: { cveId: 'CVE-2026-41940' },
          containers: {
            adp: [
              {
                providerMetadata: { shortName: 'CISA-ADP' },
                metrics: [
                  { other: { type: 'ssvc', content: { options: [{ Exploitation: 'none' }] } } },
                ],
              },
            ],
          },
        }),
      },
      { adapter: 'vulnrichment' },
    );

    const onlyPoc = core.buildRecord('CVE-2026-41940', { rows: [poc] }).record.database_specific
      .openvuln.exploitation;
    expect(onlyPoc.status).toBeUndefined();
    expect(onlyPoc.claims[0]).toMatchObject({ vetted: false });

    const ssvcAndMsf = core.buildRecord('CVE-2026-41940', { rows: [ssvcNone, msf, poc] }).record
      .database_specific.openvuln;
    expect(ssvcAndMsf.exploitation.status).toBe('poc-public');
    expect(ssvcAndMsf.exploitation.ssvc.exploitation).toBe('none');
    expect(ssvcAndMsf.exploitation.public[0]).toMatchObject({
      source: 'Metasploit',
      rank: 'excellent',
    });
    expect(ssvcAndMsf.version).toBe('0.1.1');
    expect(ssvcAndMsf.sources.map((s) => s.name)).toEqual(
      expect.arrayContaining(['CISA Vulnrichment (SSVC)', 'Metasploit', 'PoC-in-GitHub']),
    );
  });
});
