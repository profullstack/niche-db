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
