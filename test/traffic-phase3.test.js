/**
 * /traffic phase 3 (PRD 0020): lists as RPZ and rbldnsd, per-category
 * downloads, the decisions ThreatCrush reads, and delisting requests. What
 * would be embarrassing: an RPZ name a resolver cannot parse, a delisting
 * request accepted for an address that is not listed, a delisted address that
 * a later import puts back, or /decisions answering without the shared token.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { migratedPglite, pgliteSql } from './helpers/pglite.js';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';

const traffic = await import('../packages/core/src/traffic/index.js');
const store = await import('../packages/db/src/traffic.js');
const reputation = await import('../packages/db/src/reputation.js');
const { isFeedPartner } = await import('../apps/web/src/routes/traffic.js');

describe('list formats', () => {
  test('RPZ trigger names for v4 and v6', () => {
    expect(traffic.rpzIpName('45.148.10.7')).toBe('32.7.10.148.45.rpz-ip');
    expect(traffic.rpzIpName('2a01:4f8::1')).toBe('128.1.0.0.0.0.0.4f8.2a01.rpz-ip');
    expect(traffic.expandV6('2a01:4f8::1')).toEqual([
      '2a01',
      '04f8',
      '0000',
      '0000',
      '0000',
      '0000',
      '0000',
      '0001',
    ]);
  });

  test('an IP RPZ is a loadable zone: SOA, NS, one CNAME . per address', () => {
    const z = traffic.rpzForIps(['45.148.10.7', '2a01:4f8::1'], {
      now: new Date('2026-10-17T00:00:00Z'),
    });
    const lines = z.trim().split('\n');
    expect(lines).toContain('$TTL 300');
    expect(lines.find((l) => l.includes(' SOA '))).toContain(
      String(Date.parse('2026-10-17T00:00:00Z') / 1000),
    );
    expect(lines).toContain('  IN NS localhost.');
    expect(lines).toContain('32.7.10.148.45.rpz-ip CNAME .');
    expect(lines.filter((l) => l.endsWith('CNAME .')).length).toBe(2);
  });

  test('a domain RPZ blocks the name and everything under it', () => {
    const z = traffic.rpzForDomains(['evil.example']);
    expect(z).toContain('\nevil.example CNAME .\n*.evil.example CNAME .\n');
  });

  test('rbldnsd ip4set carries the answer line and v4 only', () => {
    const z = traffic.rbldnsdIp4set(['45.148.10.7', '2a01:4f8::1']);
    const lines = z.trim().split('\n');
    expect(lines[1]).toStartWith(':127.0.0.2:');
    expect(lines.slice(2)).toEqual(['45.148.10.7']);
  });
});

describe('feed partner', () => {
  const T = 'shared-feed-token';
  const ctx = (auth) => ({ req: { header: (n) => (n === 'authorization' ? auth : undefined) } });
  test('only the shared token, compared in constant time', () => {
    expect(isFeedPartner(ctx('Bearer shared-feed-token'), T)).toBe(true);
    expect(isFeedPartner(ctx('Bearer shared-feed-tokeX'), T)).toBe(false);
    expect(isFeedPartner(ctx('Bearer short'), T)).toBe(false);
    expect(isFeedPartner(ctx(undefined), T)).toBe(false);
  });
});

describe('decisions, categories and delisting against PGlite', () => {
  let sql;
  let userId;

  beforeEach(async () => {
    sql = pgliteSql(await migratedPglite());
    [{ id: userId }] =
      await sql`insert into users (email, role) values ('reviewer@nichedb.test', 'admin') returning id`;
    const row = (ip, rules) => ({
      ip,
      score: 50,
      category: traffic.categoryFor(rules),
      first_seen: '2026-10-01T00:00:00Z',
      last_seen: '2026-10-16T00:00:00Z',
      blocks: 4,
      servers: 2,
      rules,
      max_severity: 'high',
      evidence: { titles: [], paths: [] },
    });
    await store.upsertCandidates(
      [
        row('45.148.10.7', ['exploit-probe-pattern']),
        row('45.148.10.8', ['ssh-brute-force']),
        row('172.12.140.170', ['web-scanner-detection']),
      ],
      { db: sql },
    );
    await store.reviewIps(
      { ips: ['45.148.10.7', '45.148.10.8'], status: 'approved', userId },
      { db: sql },
    );
    await store.reviewIps(
      { ips: ['172.12.140.170'], status: 'rejected', userId, note: 'ours' },
      { db: sql },
    );
  }, 30_000);

  test('decisions list both halves for ThreatCrush', async () => {
    expect(await store.listDecisions({ db: sql })).toEqual({
      approved: ['45.148.10.7', '45.148.10.8'],
      rejected: ['172.12.140.170'],
    });
  });

  test('a category narrows the download', async () => {
    expect(await store.listPublishedIps({ category: 'brute-force' }, { db: sql })).toEqual([
      '45.148.10.8',
    ]);
    expect((await store.listPublishedIps({}, { db: sql })).length).toBe(2);
  });

  test('a request is only taken for a listed address', async () => {
    const reason = 'This is our office NAT; the scanner was a misconfigured job, now fixed.';
    expect(
      await store.addDelistRequest(
        { ip: '172.12.140.170', email: 'a@b.test', reason },
        { db: sql },
      ),
    ).toBeNull();
    expect(
      await store.addDelistRequest({ ip: '203.0.113.200', email: 'a@b.test', reason }, { db: sql }),
    ).toBeNull();
    const row = await store.addDelistRequest(
      { ip: '45.148.10.7', email: 'a@b.test', reason },
      { db: sql },
    );
    expect(row.status).toBe('open');
    const open = await store.listDelistRequests({}, { db: sql });
    expect(open.map((d) => [d.ip, d.email, d.category])).toEqual([
      ['45.148.10.7', 'a@b.test', 'exploit'],
    ]);
  });

  test('delisting rejects the address for good; declining leaves it; a request is decided once', async () => {
    const reason = 'Reassigned to us last week by the provider; never ours before.';
    const a = await store.addDelistRequest(
      { ip: '45.148.10.7', email: 'a@b.test', reason },
      { db: sql },
    );
    const b = await store.addDelistRequest(
      { ip: '45.148.10.8', email: 'c@d.test', reason },
      { db: sql },
    );
    expect(
      await store.decideDelistRequest({ id: a.id, action: 'delist', userId }, { db: sql }),
    ).toBe(true);
    expect(
      await store.decideDelistRequest(
        { id: a.id, action: 'decline', userId, note: 'x' },
        { db: sql },
      ),
    ).toBe(false);
    expect(
      await store.decideDelistRequest(
        { id: b.id, action: 'decline', userId, note: 'still attacking' },
        { db: sql },
      ),
    ).toBe(true);
    expect((await store.lookupIp('45.148.10.7', { db: sql })).listed).toBe(false);
    expect((await store.lookupIp('45.148.10.8', { db: sql })).listed).toBe(true);
    // A later import refreshes evidence, never the decision.
    await store.upsertCandidates(
      [
        {
          ip: '45.148.10.7',
          score: 90,
          category: 'exploit',
          first_seen: null,
          last_seen: '2026-10-17T00:00:00Z',
          blocks: 9,
          servers: 3,
          rules: [],
          max_severity: 'high',
          evidence: {},
        },
      ],
      { db: sql },
    );
    expect((await store.lookupIp('45.148.10.7', { db: sql })).listed).toBe(false);
    expect((await store.listDecisions({ db: sql })).rejected).toContain('45.148.10.7');
  });

  test('abuse.ch indicators for the downloads, recent only', async () => {
    const [{ id: cid }] =
      await sql`insert into collections (slug, name) values ('threats', 'Threats') returning id`;
    const [{ id: sid }] =
      await sql`insert into sources (collection_id, adapter, slug, name) values (${cid}, 'abusech', 'abusech-indicators', 'abuse.ch') returning id`;
    const today = new Date().toISOString().slice(0, 10);
    await sql`insert into items (collection_id, source_id, external_id, kind, title, tags, data) values
      (${cid}, ${sid}, 'domain:evil.example', 'indicator', 't', '{abusech,ioc:domain}', ${JSON.stringify({ indicator: 'evil.example', lastListed: today })}::jsonb),
      (${cid}, ${sid}, 'domain:old.example', 'indicator', 't', '{abusech,ioc:domain}', '{"indicator":"old.example","lastListed":"2026-01-01"}'::jsonb),
      (${cid}, ${sid}, 'ip:45.148.10.9', 'indicator', 't', '{abusech,ioc:ip}', ${JSON.stringify({ indicator: '45.148.10.9', lastListed: today })}::jsonb)`;
    expect(await reputation.listedIndicators({ type: 'domain', days: 7 }, { db: sql })).toEqual([
      'evil.example',
    ]);
    expect(await reputation.listedIndicators({ type: 'ip', days: 7 }, { db: sql })).toEqual([
      '45.148.10.9',
    ]);
  });
});
