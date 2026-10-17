import { beforeEach, describe, expect, test } from 'bun:test';
import { migratedPglite, pgliteSql } from './helpers/pglite.js';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';

const traffic = await import('../packages/core/src/traffic/index.js');
const store = await import('../packages/db/src/traffic.js');

describe('normaliseIp / isPublicIp', () => {
  test('keeps public v4 and v6, drops private, reserved and junk', () => {
    expect(traffic.normaliseIp(' 45.148.10.7 ')).toBe('45.148.10.7');
    expect(traffic.normaliseIp('[2A01:4F8::1]')).toBe('2a01:4f8::1');
    for (const bad of [
      '10.0.0.1',
      '192.168.1.1',
      '172.20.0.5',
      '127.0.0.1',
      '100.64.1.1',
      '169.254.1.1',
      '203.0.113.9',
      '198.51.100.2',
      '224.0.0.1',
      '::1',
      'fd00::1',
      'fe80::1',
      '2001:db8::1',
      'not-an-ip',
      '1.2.3',
    ]) {
      expect(traffic.normaliseIp(bad)).toBeNull();
    }
  });
});

describe('categoryFor / toRow', () => {
  test('strongest rule wins', () => {
    expect(traffic.categoryFor(['web-scanner-detection', 'web-sqli-attack'])).toBe('exploit');
    expect(traffic.categoryFor(['ssh-brute-force'])).toBe('brute-force');
    expect(traffic.categoryFor(['web-scanner-user-agent'])).toBe('scanner');
    expect(traffic.categoryFor([])).toBe('other');
    expect(traffic.categoryFor(['attack-path_traversal'])).toBe('exploit');
    expect(traffic.categoryFor(['paywall-hammering'])).toBe('other');
  });
  test('drops a private address and bounds the evidence', () => {
    expect(traffic.toRow({ ip: '10.1.1.1', rules: [] })).toBeNull();
    const row = traffic.toRow({
      ip: '45.148.10.7',
      rules: ['ssh-brute-force', 7],
      score: 41.6,
      blocks: '3',
      titles: Array(9).fill('x'.repeat(500)),
    });
    expect(row).toMatchObject({
      ip: '45.148.10.7',
      category: 'brute-force',
      score: 42,
      blocks: 3,
      rules: ['ssh-brute-force'],
    });
    expect(row.evidence.titles).toHaveLength(5);
    expect(row.evidence.titles[0]).toHaveLength(200);
  });
});

describe('store + sync against PGlite', () => {
  let sql;
  let userId;

  beforeEach(async () => {
    sql = pgliteSql(await migratedPglite());
    [{ id: userId }] =
      await sql`insert into users (email, role) values ('reviewer@nichedb.test', 'admin') returning id`;
  }, 30_000);

  const candidate = (ip, extra = {}) => ({
    ip,
    score: 50,
    first_seen: '2026-10-01T00:00:00Z',
    last_seen: '2026-10-16T00:00:00Z',
    blocks: 4,
    servers: 2,
    rules: ['exploit-probe-pattern'],
    max_severity: 'high',
    titles: ['Exploit probe: /.env'],
    ...extra,
  });

  test('sync pages through the feed and lands everything pending', async () => {
    const calls = [];
    const pages = {
      '': { candidates: [candidate('45.148.10.7'), candidate('10.0.0.1')], next_cursor: 'c2' },
      c2: {
        candidates: [candidate('2a01:4f8::1', { rules: ['ssh-brute-force'] })],
        next_cursor: null,
      },
    };
    const fetchImpl = async (url, init) => {
      calls.push({ url: String(url), auth: init.headers.authorization });
      return new Response(JSON.stringify(pages[new URL(url).searchParams.get('cursor') ?? '']), {
        status: 200,
      });
    };
    const out = await traffic.syncTraffic({
      fetchImpl,
      db: sql,
      log: () => {},
      feedUrl: 'https://threatcrush.test/api/v1/ban-candidates',
      feedToken: 'test-token',
    });
    expect(out).toEqual({ count: 2, added: 2 });
    expect(calls).toHaveLength(2);
    expect(calls[0].auth).toBe('Bearer test-token');
    const stats = await store.trafficStats({ db: sql });
    expect(stats).toMatchObject({ approved: 0, pending: 2, rejected: 0 });
    expect((await store.getSync('threatcrush', { db: sql })).added).toBe(2);
  });

  test('nothing pending or rejected is ever public', async () => {
    await store.upsertCandidates(
      [traffic.toRow(candidate('45.148.10.7')), traffic.toRow(candidate('45.148.10.8'))],
      { db: sql },
    );
    expect(await store.listPublished({}, { db: sql })).toHaveLength(0);
    expect(await store.lookupIp('45.148.10.7', { db: sql })).toEqual({
      ip: '45.148.10.7',
      listed: false,
    });

    await store.reviewIps({ ips: ['45.148.10.7'], status: 'approved', userId }, { db: sql });
    await store.reviewIps(
      { ips: ['45.148.10.8'], status: 'rejected', userId, note: 'a customer VPN' },
      { db: sql },
    );

    const published = await store.listPublished({}, { db: sql });
    expect(published.map((r) => r.ip)).toEqual(['45.148.10.7']);
    expect(await store.listPublishedIps({}, { db: sql })).toEqual(['45.148.10.7']);
    expect((await store.lookupIp('45.148.10.7', { db: sql })).listed).toBe(true);
    expect((await store.lookupIp('45.148.10.8', { db: sql })).listed).toBe(false);
    const rejected = await store.listQueue({ status: 'rejected' }, { db: sql });
    expect(rejected[0]).toMatchObject({
      ip: '45.148.10.8',
      review_note: 'a customer VPN',
      reviewer: 'reviewer@nichedb.test',
    });
  });

  test('a later import refreshes evidence but never overturns a decision', async () => {
    await store.upsertCandidates([traffic.toRow(candidate('45.148.10.8'))], { db: sql });
    await store.reviewIps(
      { ips: ['45.148.10.8'], status: 'rejected', userId, note: 'monitor' },
      { db: sql },
    );
    const added = await store.upsertCandidates(
      [
        traffic.toRow(
          candidate('45.148.10.8', { blocks: 9, servers: 5, last_seen: '2026-10-17T00:00:00Z' }),
        ),
      ],
      { db: sql },
    );
    expect(added).toBe(0);
    const [row] = await store.listQueue({ status: 'rejected' }, { db: sql });
    expect(row).toMatchObject({ status: 'rejected', blocks: 9, servers: 5 });
  });

  test('the review queue is worked strongest evidence first; quiet addresses can be filtered', async () => {
    await store.upsertCandidates(
      [
        traffic.toRow(candidate('45.148.10.1', { score: 10 })),
        traffic.toRow(candidate('45.148.10.2', { score: 90 })),
        traffic.toRow(candidate('45.148.10.3', { score: 50, last_seen: '2020-01-01T00:00:00Z' })),
      ],
      { db: sql },
    );
    expect((await store.listQueue({}, { db: sql })).map((r) => r.ip)).toEqual([
      '45.148.10.2',
      '45.148.10.3',
      '45.148.10.1',
    ]);
    await store.reviewIps(
      { ips: ['45.148.10.1', '45.148.10.3'], status: 'approved', userId },
      { db: sql },
    );
    expect(await store.listPublishedIps({ maxAgeDays: 90 }, { db: sql })).toEqual(['45.148.10.1']);
    expect((await store.trafficStats({ db: sql })).reviewers).toBe(1);
  });
});
