import { describe, expect, test } from 'bun:test';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';

const { render } = await import('../lib/http.js');
const { TrafficIpPage, TrafficOwnersPage, TrafficPage, TrafficReviewPage } = await import(
  './traffic.jsx'
);
const { ownerOf, ownersList } = await import('@nichedb/core/traffic/owners');

const row = {
  ip: '45.148.10.7',
  category: 'exploit',
  first_seen: '2026-10-01T00:00:00Z',
  last_seen: '2026-10-16T00:00:00Z',
  blocks: 4,
  servers: 2,
  rules: ['exploit-probe-pattern'],
  max_severity: 'high',
  reviewed_at: '2026-10-17T00:00:00Z',
  evidence: { titles: ['Exploit probe: /.env'], paths: ['/.env'] },
};
const stats = (over = {}) => ({
  approved: 1,
  pending: 3,
  rejected: 1,
  reviewers: 1,
  last_review: null,
  categories: [{ category: 'exploit', n: 1 }],
  ...over,
});

describe('traffic views', () => {
  test('the owners page lists every known network with its count and source', async () => {
    const owners = ownersList().map((o) => ({ ...o, banned: o.slug === 'applebot' ? 112 : 0 }));
    const html = String(
      await render(<TrafficOwnersPage owners={owners} fetchedAt="2026-10-19T00:00:00Z" />),
    );
    expect(html).toContain('Who owns an IP');
    expect(html).toContain('Applebot (Apple)');
    expect(html).toContain('17.0.0.0/8');
    expect(html).toContain('112');
    expect(html).toContain('search.developer.apple.com');
  });

  test('an address page names its owner: a known network, or RDAP with the abuse contact', async () => {
    const known = String(
      await render(
        <TrafficIpPage
          query="17.166.22.207"
          result={{ ip: '17.166.22.207', listed: false }}
          owner={{ known: ownerOf('17.166.22.207'), rdap: null }}
        />,
      ),
    );
    expect(known).toContain('Applebot (Apple)');
    expect(known).toContain('never listed');
    const rdap = String(
      await render(
        <TrafficIpPage
          query="45.33.32.156"
          result={{ ip: '45.33.32.156', listed: false }}
          owner={{
            known: null,
            rdap: {
              owner: 'Linode',
              network: 'LINODE',
              range: '45.33.0.0/17',
              abuse_email: 'abuse@linode.com',
              registry: 'whois.arin.net',
              source: 'https://rdap.arin.net/registry/ip/45.33.0.0',
            },
          }}
        />,
      ),
    );
    expect(rdap).toContain('Linode');
    expect(rdap).toContain('mailto:abuse@linode.com');
  });

  test('the public page says how it is reviewed and shows approved rows', async () => {
    const html = String(
      await render(
        <TrafficPage
          stats={stats()}
          rows={[row]}
          params={{ full: false, limit: 100, offset: 0 }}
          sync={null}
          reviewer={false}
        />,
      ),
    );
    expect(html).toContain('reviewed against what it actually');
    expect(html).toContain('riotcoder');
    expect(html).toContain('45.148.10.7');
    expect(html).toContain('/traffic/blocklist.txt');
    expect(html).toContain('ThreatCrush verified');
    expect(html).toContain('href="https://threatcrush.com"');
  });

  test('an empty list explains that nothing is published until reviewed', async () => {
    const html = String(
      await render(
        <TrafficPage
          stats={stats({ approved: 0 })}
          rows={[]}
          params={{ full: true, limit: 100, offset: 0 }}
          sync={null}
          reviewer
        />,
      ),
    );
    expect(html).toContain('Nothing is published yet');
    expect(html).toContain('/traffic/review');
  });

  test('a lookup of an unlisted address says why it may be absent', async () => {
    const html = String(
      await render(
        <TrafficIpPage query="45.148.10.8" result={{ ip: '45.148.10.8', listed: false }} />,
      ),
    );
    expect(html).toContain('Not on the list');
    const listed = String(
      await render(<TrafficIpPage query="45.148.10.7" result={{ listed: true, ...row }} />),
    );
    expect(listed).toContain('Reviewed by a person');
    const byAgent = String(
      await render(
        <TrafficIpPage
          query="45.148.10.7"
          result={{
            listed: true,
            ...row,
            reviewer: 'riotcoder',
            review_note: 'riotcoder review: exploit probes, e.g. /.env',
          }}
        />,
      ),
    );
    expect(byAgent).toContain('riotcoder');
    expect(byAgent).toContain('exploit probes, e.g. /.env');
  });

  test('the review queue shows evidence and the decision buttons', async () => {
    const html = String(
      await render(
        <TrafficReviewPage
          stats={stats()}
          rows={[{ ...row, score: 60, status: 'pending' }]}
          status="pending"
          offset={0}
        />,
      ),
    );
    expect(html).toContain('Approve selected');
    expect(html).toContain('Reject selected');
    expect(html).toContain('exploit-probe-pattern');
  });
});
