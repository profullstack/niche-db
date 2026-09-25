import { describe, expect, test } from 'bun:test';
import { COMMANDS, makeClient, parseArgs, run } from '../src/index.js';

describe('parseArgs', () => {
  test('flags, repeated config, positionals', () => {
    const { flags, positional } = parseArgs([
      'source',
      'add',
      'npm',
      '--name',
      'N',
      '--config',
      'match=mcp',
      '--config',
      'x=1',
      '--json',
    ]);
    expect(positional).toEqual(['source', 'add', 'npm']);
    expect(flags.name).toBe('N');
    expect(flags.config).toEqual(['match=mcp', 'x=1']);
    expect(flags.json).toBe(true);
    expect(parseArgs(['--webhook-url=https://x']).flags.webhookUrl).toBe('https://x');
  });
});

describe('client', () => {
  test('sends the bearer key and reads errors', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ error: 'nope' }), { status: 403 });
    };
    const c = makeClient({ api: 'https://x/', key: 'ndb_1', fetchImpl });
    await expect(c.get('/api/v1/me')).rejects.toThrow('nope');
    expect(calls[0].url).toBe('https://x/api/v1/me');
    expect(calls[0].init.headers.authorization).toBe('Bearer ndb_1');
  });
});

describe('run', () => {
  test('help lists every command', async () => {
    const chunks = [];
    const orig = process.stdout.write;
    process.stdout.write = (s) => {
      chunks.push(String(s));
      return true;
    };
    try {
      expect(await run(['help'])).toBe(0);
    } finally {
      process.stdout.write = orig;
    }
    const text = chunks.join('');
    for (const c of COMMANDS) expect(text).toContain(c.usage.split(' ')[0]);
  });
});

describe('tlds and check', () => {
  const capture = async (argv, body) => {
    const urls = [];
    const fetchImpl = async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' },
      });
    };
    const chunks = [];
    const orig = process.stdout.write;
    process.stdout.write = (s) => {
      chunks.push(String(s));
      return true;
    };
    try {
      expect(await run([...argv, '--api', 'https://x'], { fetchImpl })).toBe(0);
    } finally {
      process.stdout.write = orig;
    }
    return { urls, text: chunks.join('') };
  };

  test('tlds passes filters through and prints renewal beside the first year', async () => {
    const { urls, text } = await capture(
      ['tlds', 'watch', '--max-renew', '50', '--trap', '--registrar', 'porkbun'],
      {
        total: 1,
        compare_currency: null,
        tlds: [
          {
            tld: 'watches',
            manager: 'Identity Digital Limited',
            renewal_ratio: 4.96,
            best: {
              register: { amount: 52.01, currency: 'USD' },
              renew: { amount: 257.98, currency: 'USD', registrar_name: 'Porkbun' },
              transfer: { amount: 257.98, currency: 'USD' },
            },
          },
        ],
      },
    );
    const u = new URL(urls[0]);
    expect(u.pathname).toBe('/api/v1/tlds');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      q: 'watch',
      registrar: 'porkbun',
      max_renew: '50',
      trap: '1',
    });
    expect(text).toContain('.watches');
    expect(text).toContain('257.98');
    expect(text).toContain('4.96x');
  });

  test('check never says available', async () => {
    const { urls, text } = await capture(['check', 'foo', '--tlds', 'com,watches'], {
      results: [
        { name: 'foo.com', status: 'registered', registrar: 'MarkMonitor Inc.' },
        {
          name: 'foo.watches',
          status: 'not_registered',
          cheapest: {
            register: { amount: 52.01, registrar_name: 'Porkbun' },
            renew: { amount: 257.98 },
          },
        },
      ],
    });
    expect(new URL(urls[0]).searchParams.get('tlds')).toBe('com,watches');
    expect(text).toContain('taken');
    expect(text).toContain('not registered');
    expect(text).toContain('renews 257.98');
    expect(text).not.toContain('available');
  });
});
