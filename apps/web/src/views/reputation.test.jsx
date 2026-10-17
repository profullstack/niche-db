import { describe, expect, test } from 'bun:test';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';

const { render } = await import('../lib/http.js');
const { reputationReport } = await import('../lib/reputation.js');
const { ReputationPage } = await import('./reputation.jsx');

const indicator = {
  adapter: 'abusech',
  external_id: 'domain:evil.example',
  title: 'evil.example: botnet command-and-control server for AMOS',
  url: 'https://threatfox.abuse.ch/x',
  data: {
    threat: 'botnet_cc',
    feeds: ['threatfox'],
    indicator: 'evil.example',
    lastListed: '2026-10-17',
  },
};

describe('ReputationPage', () => {
  test('the landing page says what it checks and links the lists', async () => {
    const html = await render(<ReputationPage />);
    expect(html).toContain('IP and domain reputation');
    expect(html).toContain('abuse.ch');
    expect(html).toContain('/f/malware-ips');
    expect(html).toContain('threatcrush.com/reputation');
  });

  test('a listed domain shows its indicators and the JSON link', async () => {
    const report = await reputationReport('cdn.evil.example', {
      items: async () => [indicator],
      traffic: async () => null,
    });
    const html = await render(<ReputationPage query="cdn.evil.example" report={report} />);
    expect(html).toContain('Listed.');
    expect(html).toContain('evil.example');
    expect(html).toContain('/api/v1/reputation/cdn.evil.example');
    expect(html).toContain('noindex');
  });

  test('a miss says what was checked, not clean', async () => {
    const report = await reputationReport('45.148.10.8', {
      items: async () => [],
      traffic: async (ip) => ({ ip, listed: false }),
    });
    const html = await render(<ReputationPage query="45.148.10.8" report={report} />);
    expect(html).toContain('not a clean bill of health');
    expect(html).toContain('ThreatCrush bans');
  });

  test('a domain shows the live lists and the listed address it serves from', async () => {
    const report = await reputationReport('dev2.profullstack.com', {
      items: async () => [],
      traffic: async (ip) => ({ ip, listed: false }),
      resolve: async () => ['23.95.228.174'],
      dnsbl: {
        lists: () => ['Spamhaus ZEN'],
        check: async (t, s) =>
          t === 'ip'
            ? [
                {
                  list: 'Spamhaus ZEN',
                  subject: s,
                  status: 'listed',
                  reasons: [{ code: '127.0.0.4', label: 'XBL (exploited host)', policy: false }],
                },
              ]
            : [{ list: 'Spamhaus DBL', subject: s, status: 'clear', reasons: [] }],
      },
    });
    const html = await render(<ReputationPage query="dev2.profullstack.com" report={report} />);
    expect(html).toContain('Listed.');
    expect(html).toContain('The addresses it resolves to');
    expect(html).toContain('23.95.228.174');
    expect(html).toContain('XBL (exploited host) (127.0.0.4)');
    expect(html).toContain('Live DNS blocklists');
  });
});
