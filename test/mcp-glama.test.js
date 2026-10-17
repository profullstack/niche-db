import { describe, expect, test } from 'bun:test';
import { buildRss } from '../apps/web/src/lib/rss.js';
import { ItemList } from '../apps/web/src/views/components.jsx';
import {
  CREDIT,
  collapse,
  glamaMcp,
  MIN_QUALITY,
  rejectReason,
  toItem,
} from '../packages/adapters/src/glama.js';
import { ADAPTERS, adapterByName } from '../packages/adapters/src/index.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

/*
 * Glama's MCP directory. Shapes below are trimmed from a recorded
 * `GET /v1/servers?first=100&sort=added-at:desc` page (2026-10-17); no test
 * here touches the network.
 */

const server = (over = {}) => ({
  attributes: ['hosting:local-only'],
  description: 'Enables AI agents to fetch webpages and convert them to Markdown.',
  environmentVariablesJsonSchema: {
    type: 'object',
    properties: { API_KEY: { type: 'string', description: 'The key' } },
  },
  id: 'ribzv4ybt9',
  isBoosted: false,
  name: 'read-website-fast',
  namespace: 'cCastillo2488',
  qualityScore: 4.2,
  repository: { url: 'https://github.com/cCastillo2488/mcp-read-website-fast' },
  slug: 'mcp-read-website-fast',
  spdxLicense: { name: 'MIT License', url: 'https://spdx.org/licenses/MIT.json' },
  thumbnailUrl: null,
  tools: [
    { name: 'read_website', description: 'Read a page', inputSchema: { type: 'object' } },
    { name: 'crawl', description: null, inputSchema: { type: 'object' } },
  ],
  url: 'https://glama.ai/mcp/servers/ribzv4ybt9',
  ...over,
});

const page = (servers, { next = null } = {}) => ({
  pageInfo: {
    endCursor: next,
    hasNextPage: Boolean(next),
    hasPreviousPage: false,
    startCursor: null,
  },
  servers,
});

/** A fake `http` that answers from a script of responses and records each URL. */
function fakeHttp(script) {
  const calls = [];
  return {
    calls,
    async request(url, opts) {
      calls.push({ url, headers: opts?.headers ?? {} });
      const next = script.shift();
      if (!next) throw new Error(`unexpected request ${url}`);
      const status = next.status ?? 200;
      return new Response(status === 200 ? JSON.stringify(next.body) : '{"error":{}}', {
        status,
        headers: { 'ratelimit-remaining': String(next.remaining ?? 99), 'ratelimit-reset': '1' },
      });
    },
  };
}

const run = (http, cursor = {}, config = {}) =>
  glamaMcp.pull({
    config: { ...glamaMcp.defaults, delayMs: 0, ...config },
    cursor,
    env: { glamaApiKey: 'test-key' },
    http,
    log: () => {},
    deadline: Date.now() + 60_000,
  });

describe('Glama: a server as a row', () => {
  test('keyed on the folded repository, like every other MCP source', () => {
    const item = toItem(server());
    expect(item.externalId).toBe('glama:ribzv4ybt9');
    expect(item.url).toBe('https://github.com/ccastillo2488/mcp-read-website-fast');
    expect(item.data.repo).toBe('ccastillo2488/mcp-read-website-fast');
    expect(item.tags).toEqual(expect.arrayContaining(['mcp', 'glama', 'local', 'tools']));
    expect(item.data.tools).toEqual(['read_website', 'crawl']);
    expect(item.data.envVars).toEqual(['API_KEY']);
    expect(item.data.license).toBe('MIT License');
    expect(item.data.qualityScore).toBe(4.2);
    // Tool input schemas are left behind.
    expect(JSON.stringify(item.data)).not.toContain('inputSchema');
    expect(normaliseItem(item)).not.toBeNull();
  });

  test('every row carries the credit and its own Glama listing, as the licence requires', () => {
    const item = toItem(server());
    expect(item.data.credit).toEqual({
      name: 'Glama',
      text: 'MCP data from Glama',
      url: 'https://glama.ai',
      listing: 'https://glama.ai/mcp/servers/ribzv4ybt9',
    });
    expect(item.data.glama).toBe('https://glama.ai/mcp/servers/ribzv4ybt9');
  });

  test('the listing is the url the API returns; namespace/slug only when it returns none', () => {
    const item = toItem(server({ url: undefined }));
    expect(item.data.credit.listing).toBe(
      'https://glama.ai/mcp/servers/cCastillo2488/mcp-read-website-fast',
    );
  });

  test('no repository: the Glama listing is the key, which is unique per server', () => {
    const item = toItem(server({ repository: null }));
    expect(item.url).toBe('https://glama.ai/mcp/servers/ribzv4ybt9');
  });

  test('official and hosting attributes become tags', () => {
    const item = toItem(server({ attributes: ['author:official', 'hosting:remote-capable'] }));
    expect(item.tags).toContain('official');
    expect(item.tags).toContain('remote');
  });

  test('a record with no id is not a row', () => {
    expect(toItem(server({ id: '' }))).toBeNull();
  });

  test('a repository two servers claim keys neither: both fall back to their listings', () => {
    const rows = collapse([
      toItem(server({ id: 'aaaaaaaaaa', url: 'https://glama.ai/mcp/servers/aaaaaaaaaa' })),
      toItem(server({ id: 'bbbbbbbbbb', url: 'https://glama.ai/mcp/servers/bbbbbbbbbb' })),
      toItem(server({ id: 'cccccccccc', repository: { url: 'https://github.com/x/y' } })),
    ]);
    expect(rows.map((r) => r.url)).toEqual([
      'https://glama.ai/mcp/servers/aaaaaaaaaa',
      'https://glama.ai/mcp/servers/bbbbbbbbbb',
      'https://github.com/x/y',
    ]);
    expect(rows[0].data.sharedRepository).toBe(
      'https://github.com/ccastillo2488/mcp-read-website-fast',
    );
  });
});

describe('Glama: only quality-scored servers, not the clone spam', () => {
  test('the threshold is 3.5 and a scored server that owns its repository passes', () => {
    expect(MIN_QUALITY).toBe(3.5);
    expect(rejectReason(server({ qualityScore: 3.5 }))).toBeNull();
    expect(rejectReason(server({ qualityScore: 4.9 }))).toBeNull();
  });

  test('an unscored server is left out, official or not', () => {
    expect(rejectReason(server({ qualityScore: null }))).toBe('unscored');
    expect(rejectReason(server({ qualityScore: null, attributes: ['author:official'] }))).toBe(
      'unscored',
    );
  });

  test('a score under the bar is left out; the bar is configurable', () => {
    expect(rejectReason(server({ qualityScore: 3.4 }))).toBe('below-threshold');
    expect(rejectReason(server({ qualityScore: 3.4 }), { minQuality: 3 })).toBeNull();
  });

  test("somebody else's repository re-listed under another namespace is left out", () => {
    // Recorded shape: a random account listing a copy of a popular server.
    const clone = server({
      namespace: 'julie85552',
      repository: { url: 'https://github.com/freshtechbro/vibe-coder-mcp' },
      qualityScore: 4.1,
    });
    expect(rejectReason(clone)).toBe('not-owner');
    // Owner comparison ignores case, and a host other than GitHub/GitLab is not judged.
    expect(rejectReason(server({ namespace: 'CCASTILLO2488', qualityScore: 4 }))).toBeNull();
    expect(
      rejectReason(
        server({
          namespace: 'x',
          repository: { url: 'https://codeberg.org/y/z' },
          qualityScore: 4,
        }),
      ),
    ).toBeNull();
    expect(rejectReason(server({ repository: null, qualityScore: 4 }))).toBeNull();
  });

  test('the walk keeps only what passes, and still advances the cursor past the rest', async () => {
    const http = fakeHttp([
      {
        body: page(
          [
            server({ id: 'aaaaaaaaaa', qualityScore: 4 }),
            server({ id: 'bbbbbbbbbb', qualityScore: null }),
            server({ id: 'cccccccccc', qualityScore: 2.1 }),
          ],
          { next: 'c1' },
        ),
      },
      { body: page([server({ id: 'dddddddddd', qualityScore: null })], { next: 'c2' }) },
    ]);
    const out = await run(http, {}, { pagesPerRun: 2 });
    expect(out.items.map((i) => i.externalId)).toEqual(['glama:aaaaaaaaaa']);
    expect(out.cursor).toEqual({ after: 'c2', sweeps: 0 });
    expect(out.note).toContain('1 server(s) kept, 3 below the quality bar');
    expect(out.nextInMinutes).toBe(30);
  });
});

describe('Glama: the walk', () => {
  test('sends the key, walks newest-first by cursor and stops at the page budget', async () => {
    const http = fakeHttp([
      { body: page([server({ id: 'aaaaaaaaaa' })], { next: 'c1' }) },
      { body: page([server({ id: 'bbbbbbbbbb' })], { next: 'c2' }) },
    ]);
    const out = await run(http, {}, { pagesPerRun: 2 });
    expect(http.calls).toHaveLength(2);
    expect(http.calls[0].headers.authorization).toBe('Bearer test-key');
    expect(http.calls[0].url).toContain('sort=added-at%3Adesc');
    expect(http.calls[0].url).not.toContain('after=');
    expect(http.calls[1].url).toContain('after=c1');
    expect(out.items.map((i) => i.externalId)).toEqual(['glama:aaaaaaaaaa', 'glama:bbbbbbbbbb']);
    expect(out.cursor).toEqual({ after: 'c2', sweeps: 0 });
    expect(out.nextInMinutes).toBe(30);
  });

  test('resumes from the saved cursor, and a finished sweep starts over on the cadence', async () => {
    const http = fakeHttp([{ body: page([server()]) }]);
    const out = await run(http, { after: 'c9', sweeps: 3 });
    expect(http.calls[0].url).toContain('after=c9');
    expect(out.cursor).toEqual({ after: null, sweeps: 4 });
    expect(out.nextInMinutes).toBeUndefined();
  });

  test('a 429 mid-run keeps the pages read and the place, and does not press on', async () => {
    const http = fakeHttp([
      { body: page([server({ id: 'aaaaaaaaaa' })], { next: 'c1' }) },
      { status: 429 },
    ]);
    const out = await run(http);
    expect(http.calls).toHaveLength(2);
    expect(out.items).toHaveLength(1);
    expect(out.cursor.after).toBe('c1');
    expect(out.nextInMinutes).toBe(60);
  });

  test('a 503 mid-run is kept the same way; on the first page it fails the run', async () => {
    const mid = await run(fakeHttp([{ body: page([server()], { next: 'c1' }) }, { status: 503 }]));
    expect(mid.items).toHaveLength(1);
    expect(mid.cursor.after).toBe('c1');
    await expect(run(fakeHttp([{ status: 403 }]))).rejects.toThrow('403');
  });

  test('without GLAMA_API_KEY it refuses rather than calling', async () => {
    const http = fakeHttp([]);
    await expect(
      glamaMcp.pull({ config: glamaMcp.defaults, cursor: {}, env: {}, http, log: () => {} }),
    ).rejects.toThrow('GLAMA_API_KEY');
    expect(http.calls).toHaveLength(0);
  });
});

describe('Glama: registration and attribution on the site', () => {
  test('registered for mcp, keyed, credited, and after every other MCP source', () => {
    const a = adapterByName('glama-mcp');
    expect(a?.collection).toBe('mcp');
    expect(a.needsEnv).toEqual(['glamaApiKey']);
    expect(a.attribution).toEqual(CREDIT);
    expect(a.defaultSources[0].slug).toBe('glama-servers');
    const order = ADAPTERS.map((x) => x.name);
    for (const other of [
      'mcp-registry',
      'docker-mcp',
      'smithery',
      'awesome-mcp',
      'aitmpl-mcps',
      'github-mcp-topics',
      'installmap-yc-mcp',
    ]) {
      expect(order.indexOf(other)).toBeLessThan(order.indexOf('glama-mcp'));
    }
  });

  const row = (data) => ({
    id: 7,
    title: 'read-website-fast',
    summary: null,
    kind: 'mcp-server',
    source_slug: 'glama-servers',
    source_name: 'MCP servers on Glama',
    url: 'https://github.com/ccastillo2488/mcp-read-website-fast',
    tags: [],
    enrichment: {},
    collection_slug: 'mcp',
    published_at: null,
    first_seen_at: '2026-10-17T00:00:00.000Z',
    data,
  });

  test('a Glama row shows the credit and its listing, with followed links', () => {
    const html = ItemList({ items: [row(toItem(server()).data)] }).toString();
    expect(html).toContain('<a href="https://glama.ai">MCP data from Glama</a>');
    expect(html).toContain('<a href="https://glama.ai/mcp/servers/ribzv4ybt9">on Glama</a>');
  });

  test('jsonb that arrives as a string is read the same way', () => {
    const html = ItemList({ items: [row(JSON.stringify(toItem(server()).data))] }).toString();
    expect(html).toContain('MCP data from Glama');
  });

  test('a row from any other source shows no credit', () => {
    const html = ItemList({ items: [row({ repo: 'x/y' })] }).toString();
    expect(html).not.toContain('MCP data from Glama');
    expect(html).not.toContain('glama.ai');
  });

  test('the RSS item carries the credit and the listing too', () => {
    const xml = buildRss({
      title: 't',
      link: 'https://nichedb.dev',
      selfUrl: 'https://nichedb.dev/f/x.rss',
      siteUrl: 'https://nichedb.dev',
      items: [row(toItem(server()).data)],
    });
    expect(xml).toContain('MCP data from Glama: https://glama.ai');
    expect(xml).toContain('On Glama: https://glama.ai/mcp/servers/ribzv4ybt9');
  });
});
