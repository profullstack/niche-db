import { describe, expect, test } from 'bun:test';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';

const { render } = await import('../apps/web/src/lib/http.js');
const { TrafficIpPage, TrafficPage, TrafficReviewPage } = await import(
  '../apps/web/src/views/traffic.jsx'
);

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
  test('the public page says it is human-reviewed and shows approved rows', async () => {
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
    expect(html).toContain('reviewed and approved by a human');
    expect(html).toContain('45.148.10.7');
    expect(html).toContain('/traffic/blocklist.txt');
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
    expect(listed).toContain('A person reviewed the evidence');
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
