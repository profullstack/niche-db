import { describe, expect, mock, test } from 'bun:test';

/**
 * The fleet crawler rule (2026-11-08): 10 s per fetch, 30 s per browser
 * render, and a source whose upstream was slow or broken is flagged and left
 * alone for 30 days instead of retried in minutes. runSource runs for real
 * against a recording stand-in for the queries module, as dump-ingest does.
 */
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';

const finishes = [];
const state = { source: null, errorsBefore: 0 };
const realQueries = await import('../packages/db/src/queries.js');
mock.module('../packages/db/src/queries.js', () => ({
  ...realQueries,
  getSourceById: async () => state.source,
  consecutiveErrors: async () => state.errorsBefore,
  startRun: async () => 9,
  finishRun: async (args) => {
    finishes.push(args);
  },
}));

const { runSource } = await import('../packages/core/src/ingest.js');
const {
  BULK_DOWNLOAD_TIMEOUT_MS,
  CRAWL_BROWSER_TIMEOUT_MS,
  CRAWL_FETCH_TIMEOUT_MS,
  FLAG_DAYS,
  failureClass,
} = await import('../packages/core/src/crawl.js');
const { TIMEOUT_MS } = await import('../packages/core/src/opensite.js');
const { makeHttp } = await import('../packages/core/src/http.js');
const { renderWithObscura } = await import('../packages/adapters/src/storefront.js');

const DAY = 86_400_000;
const sysErr = (code, message = code) => Object.assign(new TypeError(message), { code });

describe('crawler rule: the numbers', () => {
  test('10 s fetch, 30 s browser, an hour for a bulk download, 30 days flagged', () => {
    expect(CRAWL_FETCH_TIMEOUT_MS).toBe(10_000);
    expect(CRAWL_BROWSER_TIMEOUT_MS).toBe(30_000);
    expect(BULK_DOWNLOAD_TIMEOUT_MS).toBe(60 * 60_000);
    expect(FLAG_DAYS).toBe(30);
    expect(TIMEOUT_MS).toBe(10_000);
  });
});

describe('failureClass', () => {
  test('timeouts are slow', () => {
    expect(
      failureClass(Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' })),
    ).toBe('slow');
    expect(failureClass(new Error('The operation timed out.'))).toBe('slow');
    expect(failureClass(Object.assign(sysErr('UND_ERR_CONNECT_TIMEOUT'), { upstream: true }))).toBe(
      'slow',
    );
  });
  test('DNS, refused, TLS and 5xx are broken', () => {
    expect(failureClass(sysErr('ENOTFOUND', 'getaddrinfo ENOTFOUND gone.example'))).toBe('broken');
    expect(failureClass(sysErr('ECONNREFUSED'))).toBe('broken');
    expect(failureClass(sysErr('CERT_HAS_EXPIRED', 'certificate has expired'))).toBe('broken');
    expect(
      failureClass(Object.assign(new Error('502 from https://a.example/x'), { status: 502 })),
    ).toBe('broken');
    expect(failureClass(new Error('503 from https://a.example/x: Service Unavailable'))).toBe(
      'broken',
    );
  });
  test('4xx, parse errors, missing keys, our resolver and our database keep the short retry', () => {
    expect(
      failureClass(Object.assign(new Error('404 from https://a.example/x'), { status: 404 })),
    ).toBe(null);
    expect(failureClass(new SyntaxError('JSON Parse error: Unexpected identifier'))).toBe(null);
    expect(failureClass(new Error('IGDB_CLIENT_ID is not set'))).toBe(null);
    expect(failureClass(sysErr('EAI_AGAIN', 'getaddrinfo EAI_AGAIN api.example'))).toBe(null);
    expect(
      failureClass(
        Object.assign(new Error('Connection closed'), { code: 'ERR_POSTGRES_CONNECTION_CLOSED' }),
      ),
    ).toBe(null);
    // A refused Postgres is not a fetch error: no TypeError, no upstream mark.
    expect(
      failureClass(
        Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), { code: 'ECONNREFUSED' }),
      ),
    ).toBe(null);
    expect(failureClass(new Error('canceling statement due to statement timeout'))).toBe(null);
  });
});

describe('our own services keep the short retry (rule 4)', () => {
  test('a house site, a pit.world host or our Supabase is never flagged', () => {
    expect(failureClass(sysErr('ENOTFOUND', 'getaddrinfo ENOTFOUND abcxyz.supabase.co'))).toBe(
      null,
    );
    expect(
      failureClass(
        Object.assign(new Error('502 from https://ch4nnels.com/api/v1/seedboxes'), { status: 502 }),
      ),
    ).toBe(null);
    expect(
      failureClass(
        Object.assign(new Error('The operation timed out.'), {
          name: 'TimeoutError',
          upstreamUrl: 'https://built.indie.pit.world/api/v1/products',
        }),
      ),
    ).toBe(null);
    // A third party on a lookalike name is still a third party.
    expect(
      failureClass(
        Object.assign(new Error('502 from https://notpit.world.example/x'), { status: 502 }),
      ),
    ).toBe('broken');
  });
});

describe('runSource: a slow or broken upstream is flagged for 30 days', () => {
  const fail = (err) => ({ name: 'fake', pull: async () => Promise.reject(err) });
  const run = (adapter) => {
    state.source = {
      id: 3,
      slug: 'fake-src',
      adapter: 'fake',
      enabled: true,
      cadence_minutes: 60,
      config: {},
      cursor: {},
    };
    return runSource(3, {
      log: () => {},
      resolveAdapter: () => adapter,
      closeRetry: { budgetMs: 0 },
    });
  };

  test('a timeout: flag slow, next run 30 days out', async () => {
    finishes.length = 0;
    const before = Date.now();
    const out = await run(
      fail(Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' })),
    );
    expect(out.flag).toBe('slow');
    const f = finishes.at(-1);
    expect(f.status).toBe('error');
    expect(f.flag).toBe('slow');
    expect(f.nextRunAt.getTime() - before).toBeGreaterThanOrEqual(30 * DAY - 1000);
    expect(f.nextRunAt.getTime() - before).toBeLessThan(30 * DAY + 5000);
  });

  test('a 5xx: flag broken, 30 days', async () => {
    finishes.length = 0;
    await run(
      fail(
        Object.assign(new Error('502 from https://api.example/x'), { status: 502, upstream: true }),
      ),
    );
    const f = finishes.at(-1);
    expect(f.flag).toBe('broken');
    expect(f.nextRunAt.getTime() - Date.now()).toBeGreaterThan(29 * DAY);
  });

  test('a 4xx keeps the 15-minute doubling retry and no flag', async () => {
    finishes.length = 0;
    state.errorsBefore = 0;
    await run(fail(Object.assign(new Error('404 from https://api.example/x'), { status: 404 })));
    const f = finishes.at(-1);
    expect(f.flag).toBe(null);
    expect(Math.abs(f.nextRunAt.getTime() - (Date.now() + 15 * 60_000))).toBeLessThan(5000);
  });
});

describe('http: what it throws says it was the upstream', () => {
  test('a 5xx carries status and upstream; ingest reads it as broken', async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response('down', { status: 502 }) });
    try {
      const http = makeHttp({ userAgent: 'test' });
      const err = await http.json(`http://localhost:${server.port}/x`).catch((e) => e);
      expect(err.status).toBe(502);
      expect(err.upstream).toBe(true);
      expect(failureClass(err)).toBe('broken');
    } finally {
      server.stop(true);
    }
  });
  test('a slow answer past timeoutMs rejects as a timeout (slow)', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: async () => {
        await Bun.sleep(500);
        return new Response('late');
      },
    });
    try {
      const http = makeHttp({ userAgent: 'test' });
      const err = await http
        .text(`http://localhost:${server.port}/x`, { timeoutMs: 50 })
        .catch((e) => e);
      expect(err.upstream).toBe(true);
      expect(failureClass(err)).toBe('slow');
    } finally {
      server.stop(true);
    }
  });
});

describe('renderWithObscura: load + bounded settle, never networkidle, and a timeout rejects', () => {
  const reply = (text) =>
    new Response(JSON.stringify({ jsonrpc: '2.0', result: { content: [{ type: 'text', text }] } }));
  test('navigates with waitUntil load and a 30 s budget, settles at most 2 s, closes the tab', async () => {
    const calls = [];
    const slept = [];
    const html = await renderWithObscura('http://obscura.test/mcp', 'https://shop.example/', {
      sleep: async (ms) => void slept.push(ms),
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(init.body);
        calls.push(body.params);
        return reply(body.params.name === 'browser_evaluate' ? '<html>ok</html>' : 'done');
      },
    });
    expect(html).toBe('<html>ok</html>');
    expect(calls[0]).toEqual({
      name: 'browser_navigate',
      arguments: { url: 'https://shop.example/', waitUntil: 'load', timeout: 30_000 },
    });
    expect(calls.map((c) => c.name)).toEqual([
      'browser_navigate',
      'browser_evaluate',
      'browser_close',
    ]);
    expect(slept.every((ms) => ms <= 2_000)).toBe(true);
  });
  test('a render past its budget rejects (and still closes)', async () => {
    const names = [];
    const err = await renderWithObscura('http://obscura.test/mcp', 'https://slow.example/', {
      timeoutMs: 50,
      fetchImpl: (_url, init) => {
        const body = JSON.parse(init.body);
        names.push(body.params.name);
        if (body.params.name === 'browser_close') return Promise.resolve(reply('closed'));
        return new Promise((_, reject) =>
          init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }),
        );
      },
    }).catch((e) => e);
    expect(err?.name).toBe('TimeoutError');
    expect(failureClass(err)).toBe('slow');
    expect(names).toContain('browser_close');
  });
});
