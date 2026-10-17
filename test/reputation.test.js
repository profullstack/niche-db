/**
 * Reputation: abuse.ch indicators and the one-answer lookup over /traffic,
 * abuse.ch and SURBL. What would be embarrassing: Cloudflare or 8.8.8.8
 * listed as malware, a shared platform suffix (workers.dev) listed whole, a
 * hash or a URL stored as an address, a parent domain's listing missed, or a
 * miss reported as "clean".
 */
import { describe, expect, test } from 'bun:test';
import { migratedPglite, pgliteSql } from './helpers/pglite.js';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';
const { adapterByName } = await import('../packages/adapters/src/index.js');
const {
  abusech,
  cleanDomain,
  cleanIp,
  indicatorItem,
  parseFeodo,
  parseThreatFox,
  parseUrlhausHosts,
} = await import('../packages/adapters/src/abusech.js');
const { normaliseItem } = await import('../packages/core/src/adapter.js');
const { isReservedNicheSlug } = await import('../packages/knowledge/src/index.js');
const { DEFAULT_FEEDS } = await import('../packages/core/src/seed.js');
const { domainChain, parseIndicator, probesFor, reputationReport } = await import(
  '../apps/web/src/lib/reputation.js'
);
const { itemsByAdapterIds } = await import('../packages/db/src/reputation.js');

const THREATFOX = JSON.stringify({
  1: [
    {
      ioc_value: '45.148.10.7:8312',
      ioc_type: 'ip:port',
      threat_type: 'botnet_cc',
      malware_printable: 'Remus',
      confidence_level: 100,
      first_seen_utc: '2026-10-17 15:21:46',
      last_seen_utc: '2026-10-17 15:41:41',
      reference: null,
    },
  ],
  2: [
    {
      ioc_value: 'evil-c2.example',
      ioc_type: 'domain',
      threat_type: 'botnet_cc',
      malware_printable: 'AMOS',
      confidence_level: 90,
      first_seen_utc: '2026-10-16 01:00:00',
      last_seen_utc: null,
    },
  ],
  3: [
    { ioc_value: 'abc123', ioc_type: 'sha256_hash', threat_type: 'payload', confidence_level: 100 },
  ],
  4: [
    {
      ioc_value: 'https://x.example/a',
      ioc_type: 'url',
      threat_type: 'botnet_cc',
      confidence_level: 100,
    },
  ],
  5: [
    {
      ioc_value: '104.16.1.1:443',
      ioc_type: 'ip:port',
      threat_type: 'botnet_cc',
      confidence_level: 100,
    },
  ],
  6: [
    {
      ioc_value: 'guess.example',
      ioc_type: 'domain',
      threat_type: 'botnet_cc',
      confidence_level: 50,
    },
  ],
  7: [
    {
      ioc_value: 'workers.dev',
      ioc_type: 'domain',
      threat_type: 'payload_delivery',
      confidence_level: 100,
    },
  ],
});

const URLHAUS = `# abuse.ch URLhaus Host file
127.0.0.1\tevil-c2.example
127.0.0.1\tbad.workers.dev
127.0.0.1\t45.148.10.7
127.0.0.1\t10.0.0.5
`;

const FEODO = `# Feodo
# DstIP
162.243.103.246
8.8.8.8
`;

describe('abuse.ch parsing', () => {
  test('ThreatFox keeps ip:port and domain rows above the confidence bar, nothing else', () => {
    const acc = parseThreatFox(THREATFOX);
    expect([...acc.keys()].sort()).toEqual(['domain:evil-c2.example', 'ip:45.148.10.7']);
    const ip = acc.get('ip:45.148.10.7');
    expect([...ip.ports]).toEqual([8312]);
    expect([...ip.malware]).toEqual(['Remus']);
    expect(ip.firstSeen.toISOString()).toBe('2026-10-17T15:21:46.000Z');
  });

  test('the feeds fold into one row per address, every feed named', () => {
    const acc = parseThreatFox(THREATFOX);
    parseUrlhausHosts(URLHAUS, acc);
    parseFeodo(FEODO, acc);
    expect([...acc.get('domain:evil-c2.example').feeds].sort()).toEqual(['threatfox', 'urlhaus']);
    expect([...acc.get('ip:45.148.10.7').feeds].sort()).toEqual(['threatfox', 'urlhaus']);
    expect(acc.has('domain:bad.workers.dev')).toBe(true);
    expect(acc.has('ip:162.243.103.246')).toBe(true);
    expect(acc.has('ip:8.8.8.8')).toBe(false);
    expect(acc.has('ip:10.0.0.5')).toBe(false);
  });

  test('shared infrastructure and private space are never listed', () => {
    expect(cleanIp('104.16.1.1')).toBeNull();
    expect(cleanIp('1.1.1.1')).toBeNull();
    expect(cleanIp('2606:4700::1111')).toBeNull();
    expect(cleanIp('192.168.0.1')).toBeNull();
    expect(cleanIp('[2a01:4f8::1]:80')).toBe('2a01:4f8::1');
    expect(cleanIp('45.148.10.7:22')).toBe('45.148.10.7');
    expect(cleanDomain('workers.dev')).toBeNull();
    expect(cleanDomain('bad.workers.dev')).toBe('bad.workers.dev');
    expect(cleanDomain('localhost')).toBeNull();
    expect(cleanDomain('EVIL.example.')).toBe('evil.example');
  });

  test('an item is storable, attributed and tagged for the feeds', () => {
    const acc = parseThreatFox(THREATFOX);
    const item = normaliseItem(
      indicatorItem(acc.get('ip:45.148.10.7'), new Date('2026-10-17T00:00:00Z')),
    );
    expect(item.externalId).toBe('ip:45.148.10.7');
    expect(item.kind).toBe('indicator');
    expect(item.tags).toContain('ioc:ip');
    expect(item.tags).toContain('threat:botnet_cc');
    expect(item.tags).toContain('malware:remus');
    expect(item.data.attribution).toContain('abuse.ch');
    expect(item.data.lastListed).toBe('2026-10-17');
    expect(item.url).toContain('threatfox.abuse.ch');
  });

  test('registered, seeded, and the feeds query what the adapter writes', () => {
    expect(adapterByName('abusech')).toBe(abusech);
    expect(abusech.collection).toBe('threats');
    for (const slug of ['malware-ips', 'malware-domains', 'botnet-c2']) {
      const f = DEFAULT_FEEDS.find((x) => x.slug === slug);
      expect(f?.collection).toBe('threats');
      expect(f.query.kinds).toEqual(['indicator']);
    }
  });

  test('pull reads all three feeds; one failure is a note, all three an error', async () => {
    const http = {
      text: async (url) => {
        if (url.includes('threatfox')) return THREATFOX;
        if (url.includes('urlhaus')) throw new Error('timeout');
        return FEODO;
      },
    };
    const r = await abusech.pull({ http, log: () => {} });
    expect(r.items.length).toBe(3);
    expect(r.note).toContain('urlhaus failed');
    const dead = { text: async () => Promise.reject(new Error('down')) };
    await expect(abusech.pull({ http: dead, log: () => {} })).rejects.toThrow(
      'every abuse.ch feed',
    );
  });
});

describe('reputation lookup', () => {
  test('parses an IP, a domain or a URL, and refuses private space', () => {
    expect(parseIndicator('45.148.10.7')).toEqual({ type: 'ip', value: '45.148.10.7' });
    expect(parseIndicator('https://www.Evil.example/x?y')).toEqual({
      type: 'domain',
      value: 'evil.example',
    });
    expect(parseIndicator('10.0.0.1').error).toBeTruthy();
    expect(parseIndicator('').error).toBeTruthy();
    expect(parseIndicator('not a thing').error).toBeTruthy();
  });

  test('a domain is checked with its parents', () => {
    expect(domainChain('a.b.evil.example')).toEqual([
      'a.b.evil.example',
      'b.evil.example',
      'evil.example',
    ]);
    expect(probesFor({ type: 'domain', value: 'b.evil.example' }).map((p) => p.externalId)).toEqual(
      ['domain:b.evil.example', 'domain:evil.example', 'surbl:b.evil.example'],
    );
  });

  test('a miss names what was checked and never says clean', async () => {
    const r = await reputationReport('45.148.10.8', {
      items: async () => [],
      traffic: async (ip) => ({ ip, listed: false }),
    });
    expect(r.listed).toBe(false);
    expect(r.score).toBe(0);
    expect(r.checked.length).toBe(2);
    expect(r.note).toContain('not a clean bill of health');
    expect(JSON.stringify(r)).not.toMatch(/"clean"/);
  });

  test('two independent lists outrank one', async () => {
    const indicator = {
      adapter: 'abusech',
      external_id: 'ip:45.148.10.7',
      title: '45.148.10.7: botnet command-and-control server for Remus',
      url: 'https://threatfox.abuse.ch/x',
      data: { threat: 'botnet_cc', feeds: ['threatfox'], indicator: '45.148.10.7' },
    };
    const one = await reputationReport('45.148.10.7', {
      items: async () => [indicator],
      traffic: async (ip) => ({ ip, listed: false }),
    });
    const two = await reputationReport('45.148.10.7', {
      items: async () => [indicator],
      traffic: async (ip) => ({ ip, listed: true, servers: 3, blocks: 9 }),
    });
    expect(one.listed).toBe(true);
    expect(one.score).toBe(85);
    expect(two.score).toBeGreaterThan(one.score);
    expect(two.reasons.length).toBe(2);
    expect(two.deeper.url).toContain('threatcrush.com');
  });

  test('reads stored rows by adapter and id, nothing from another adapter', async () => {
    const sql = pgliteSql(await migratedPglite());
    const [{ id: cid }] =
      await sql`insert into collections (slug, name) values ('threats', 'Threats') returning id`;
    const [{ id: a }] =
      await sql`insert into sources (collection_id, adapter, slug, name) values (${cid}, 'abusech', 'abusech-indicators', 'abuse.ch') returning id`;
    const [{ id: o }] =
      await sql`insert into sources (collection_id, adapter, slug, name) values (${cid}, 'other', 'other', 'Other') returning id`;
    await sql`insert into items (collection_id, source_id, external_id, kind, title, data)
      values (${cid}, ${a}, 'domain:evil.example', 'indicator', 'evil.example: malware', '{"threat":"malware_host"}'),
             (${cid}, ${o}, 'domain:evil.example', 'indicator', 'decoy', '{}')`;
    const rows = await itemsByAdapterIds(probesFor({ type: 'domain', value: 'cdn.evil.example' }), {
      db: sql,
    });
    expect(rows.map((r) => [r.adapter, r.external_id])).toEqual([
      ['abusech', 'domain:evil.example'],
    ]);
    expect(await itemsByAdapterIds([], { db: sql })).toEqual([]);
  });

  const zen = (subject) => ({
    list: 'Spamhaus ZEN',
    subject,
    status: 'listed',
    reasons: [
      { code: '127.0.0.2', label: 'SBL (Spamhaus block list)', policy: false },
      { code: '127.0.0.3', label: 'SBL CSS (snowshoe spam)', policy: false },
      { code: '127.0.0.4', label: 'XBL (exploited host)', policy: false },
    ],
  });
  const liveDeps = (byIp = {}, byDomain = {}) => ({
    items: async () => [],
    traffic: async (ip) => ({ ip, listed: false }),
    resolve: async () => ['23.95.228.174', '10.0.0.9'],
    dnsbl: {
      lists: (t) => (t === 'ip' ? ['Spamhaus ZEN', 'SpamCop'] : ['Spamhaus DBL']),
      check: async (t, s) => (t === 'ip' ? (byIp[s] ?? []) : (byDomain[s] ?? [])),
    },
  });

  test('a domain on no list, served from a listed address, is listed, and says which address', async () => {
    const r = await reputationReport(
      'dev2.profullstack.com',
      liveDeps({ '23.95.228.174': [zen('23.95.228.174')] }),
    );
    expect(r.listed).toBe(true);
    expect(r.addresses.map((a) => a.ip)).toEqual(['23.95.228.174']);
    expect(r.addresses[0].listed).toBe(true);
    expect(r.reasons.join(' ')).toContain('23.95.228.174 (A record) on Spamhaus ZEN: SBL');
    expect(r.reasons.join(' ')).toContain('XBL');
    expect(r.score).toBeGreaterThan(0);
    expect(r.checked.map((c) => c.name).join(' ')).toContain('Spamhaus ZEN (live DNS)');
  });

  test('a domain and its parents are asked of the domain lists', async () => {
    const asked = [];
    const deps = liveDeps();
    deps.dnsbl.check = async (t, s) => {
      asked.push(`${t}:${s}`);
      return [];
    };
    await reputationReport('dev2.profullstack.com', deps);
    expect(asked.sort()).toEqual([
      'domain:dev2.profullstack.com',
      'domain:profullstack.com',
      'ip:23.95.228.174',
    ]);
  });

  test('a list that could not be asked is named, and not counted as a miss', async () => {
    const r = await reputationReport(
      '45.148.10.8',
      liveDeps({ '45.148.10.8': [{ list: 'SpamCop', subject: '45.148.10.8', status: 'unknown' }] }),
    );
    expect(r.listed).toBe(false);
    expect(r.unknown).toEqual(['SpamCop']);
    expect(r.note).toContain('Could not ask: SpamCop');
  });

  test('an IP listed live is listed on its own', async () => {
    const r = await reputationReport(
      '23.95.228.174',
      liveDeps({ '23.95.228.174': [zen('23.95.228.174')] }),
    );
    expect(r.listed).toBe(true);
    expect(r.score).toBe(75);
    expect(r.reasons[0]).toBe(
      'Spamhaus ZEN: SBL (Spamhaus block list), SBL CSS (snowshoe spam), XBL (exploited host)',
    );
    expect(r.addresses).toBeUndefined();
  });

  test('/reputation is a reserved niche slug', () => {
    expect(isReservedNicheSlug('reputation')).toBe(true);
  });
});

describe('MCP', () => {
  test('reputation_lookup and traffic_list are listed', async () => {
    const { TOOLS_BY_NAME } = await import('../apps/web/src/lib/mcp/tools.js');
    expect(TOOLS_BY_NAME.has('reputation_lookup')).toBe(true);
    expect(TOOLS_BY_NAME.has('traffic_list')).toBe(true);
    await expect(
      TOOLS_BY_NAME.get('reputation_lookup').run({ indicator: '10.0.0.1' }),
    ).rejects.toThrow();
  });
});
