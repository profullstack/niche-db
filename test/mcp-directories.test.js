import { describe, expect, test } from 'bun:test';
import { ADAPTERS, adapterByName } from '../packages/adapters/src/index.js';
import {
  FULL_WALK_DAYS,
  firstParagraph,
  mcpMarket,
  mcpServersOrg,
  mcpSo,
  parseMcpMarket,
  parseMcpServers,
  parseMcpSo,
  parseSitemap,
  plan,
  readRecord,
  rowFor,
  WALK_AGAIN_MINUTES,
  wanted,
} from '../packages/adapters/src/mcpdirectories.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

/*
 * The sitemap-only MCP directories. Fixtures are trimmed from real pages and
 * sitemaps recorded on 2026-11-22; nothing here touches the network.
 */

const FIX = `${import.meta.dir}/../packages/adapters/test/fixtures`;
const fixture = (name) => Bun.file(`${FIX}/${name}`).text();

describe('parseSitemap', () => {
  test('a sitemap index lists its children, entities decoded', async () => {
    const { sitemaps, urls } = parseSitemap(await fixture('mcpso-sitemap-index.xml'));
    expect(urls).toEqual([]);
    expect(sitemaps).toContain('https://mcp.so/sitemap.xml?section=servers&page=1');
    expect(sitemaps.filter((l) => /section=servers\b/.test(l)).length).toBe(21);
  });

  test('a urlset gives loc and lastmod, ignoring hreflang alternates', async () => {
    const { urls } = parseSitemap(await fixture('mcpso-sitemap-servers.xml'));
    expect(urls[0]).toEqual({
      loc: 'https://mcp.so/servers/scrapling',
      lastmod: '2026-11-07T02:31:44.173Z',
    });
    expect(urls).toHaveLength(3);
  });

  test('mcpmarket sitemaps carry no lastmod', async () => {
    const { urls } = parseSitemap(await fixture('mcpmarket-sitemap-tools.xml'));
    expect(urls[0]).toEqual({ loc: 'https://mcpmarket.com/server/neon-1', lastmod: null });
  });
});

describe('mcp.so', () => {
  test('readRecord walks the flat hydration record past a README-sized description', () => {
    const desc = `# Title\\n\\n${'x'.repeat(5000)}`;
    const s = `{id:"a",slug:"x",previousSlug:null,name:"X",description:"${desc}",repoUrl:"https://github.com/o/r",isRemote:!0,stars:12,nested:$R[3]={a:1},after:"no"}`;
    const r = readRecord(s, s.indexOf('slug:'));
    expect(r.repoUrl).toBe('https://github.com/o/r');
    expect(r.isRemote).toBe(true);
    expect(r.stars).toBe(12);
    expect(r.previousSlug).toBeNull();
    expect(r.after).toBeUndefined();
  });

  test('a server page maps to a row keyed on the folded repository', async () => {
    const listing = 'https://mcp.so/servers/redis';
    const page = parseMcpSo(await fixture('mcpso-server-redis.html'), listing);
    expect(page).toMatchObject({
      name: 'Redis',
      repository: 'https://github.com/modelcontextprotocol/servers/tree/main/src/redis',
      author: 'modelcontextprotocol',
      category: 'Databases',
    });
    expect(page.extra.tools).toEqual(['hmset']);
    expect(page.extra.license).toBeNull(); // NOASSERTION is no licence

    const row = normaliseItem(rowFor(mcpSo.site, listing, page));
    expect(row.externalId).toBe('mcpso:servers/redis');
    // Same key the registry, Docker and the awesome lists produce for this server.
    expect(row.url).toBe('https://github.com/modelcontextprotocol/servers/tree/HEAD/src/redis');
    expect(row.data.credit).toEqual({
      name: 'mcp.so',
      text: 'Listed on mcp.so',
      url: 'https://mcp.so',
      listing,
    });
    expect(row.tags).toContain('mcpso');
  });

  test('a README description gives its first prose paragraph', () => {
    expect(
      firstParagraph(
        '# Sequential Thinking MCP Server\n\nAn MCP server for **reflective** problem-solving.\n\n## Features',
      ),
    ).toBe('An MCP server for reflective problem-solving.');
  });
});

describe('mcpmarket.com', () => {
  test('the SoftwareApplication record gives the repository, owner, category and likes', async () => {
    const listing = 'https://mcpmarket.com/server/neon-1';
    const page = parseMcpMarket(await fixture('mcpmarket-server-neon.html'), listing);
    expect(page).toMatchObject({
      name: 'Neon',
      repository: 'https://github.com/neondatabase-labs/mcp-server-neon',
      author: 'neondatabase-labs',
      category: 'database-management',
    });
    expect(page.extra.likes).toBe(449);
    expect(page.extra.keywords).not.toContain('MCP');
    const row = normaliseItem(rowFor(mcpMarket.site, listing, page));
    expect(row.url).toBe('https://github.com/neondatabase-labs/mcp-server-neon');
    expect(row.externalId).toBe('mcpmarket:server/neon-1');
    expect(row.data.credit.listing).toBe(listing);
  });

  test("a record naming an npm page still keys on the owner's repository link", async () => {
    const page = parseMcpMarket(await fixture('mcpmarket-server-kubernetes.html'));
    expect(page.repository).toBe('https://github.com/flux159/mcp-server-kubernetes');
    expect(page.extra.website).toBe('https://www.npmjs.com/package/mcp-server-kubernetes');
  });

  test('a page whose url is a website, not a repository, keys on the listing', () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      '@type': 'SoftwareApplication',
      name: 'Hosted Thing',
      url: 'https://thing.example.com',
    })}</script>`;
    const listing = 'https://mcpmarket.com/server/hosted-thing';
    const row = rowFor(mcpMarket.site, listing, parseMcpMarket(html));
    expect(row.url).toBe(listing);
    expect(row.data.website).toBe('https://thing.example.com');
  });
});

describe('mcpservers.org', () => {
  test('the heading, tagline and repository link make the row', async () => {
    const listing = 'https://mcpservers.org/servers/modelcontextprotocol/fetch';
    const page = parseMcpServers(await fixture('mcpservers-server-fetch.html'), listing);
    expect(page).toMatchObject({
      name: 'Fetch',
      summary: 'Web content fetching and conversion for efficient LLM usage',
      repository: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
      category: 'Web Scraping',
    });
    const row = rowFor(mcpServersOrg.site, listing, page);
    expect(row.url).toBe('https://github.com/modelcontextprotocol/servers/tree/HEAD/src/fetch');
  });

  test('a page with no heading is not a server', () => {
    expect(parseMcpServers('<html><body>nothing</body></html>')).toBeNull();
  });
});

describe('the walk plan', () => {
  test('a fresh source starts a full walk', () => {
    const { start, state } = plan({}, Date.parse('2026-11-22T00:00:00Z'));
    expect(start).toBe(true);
    expect(state).toMatchObject({ v: 1, walking: true, mode: 'full', child: 0, at: 0 });
  });

  test('a walk in progress resumes where it stopped', () => {
    const c = { v: 1, walking: true, mode: 'full', child: 3, at: 412 };
    expect(plan(c)).toEqual({ start: false, state: c });
  });

  test('after a full walk the next one is a delta, until the full walk is due', () => {
    const fullAt = '2026-11-01T00:00:00Z';
    const done = { v: 1, walking: false, since: '2026-11-20T00:00:00Z', fullAt, counts: { a: 5 } };
    const soon = plan(done, Date.parse('2026-11-21T00:00:00Z')).state;
    expect(soon).toMatchObject({ mode: 'delta', since: done.since, prevCounts: { a: 5 } });
    const later = plan(done, Date.parse(fullAt) + (FULL_WALK_DAYS + 1) * 86_400_000).state;
    expect(later.mode).toBe('full');
  });

  test('a delta reads newer lastmods, and past the old end where there is no lastmod', () => {
    const state = {
      mode: 'delta',
      since: '2026-11-10T00:00:00Z',
      prevCounts: { c: 2 },
    };
    const urls = [
      { loc: 'old', lastmod: '2026-11-01T00:00:00Z' },
      { loc: 'edited', lastmod: '2026-11-15T00:00:00Z' },
      { loc: 'nolm-seen', lastmod: null },
      { loc: 'nolm-new', lastmod: null },
    ];
    // index 2 has no lastmod but sits past prevCounts.c = 2, so it counts as new too
    expect(wanted(urls, state, 'c').map(([, u]) => u.loc)).toEqual([
      'edited',
      'nolm-seen',
      'nolm-new',
    ]);
    expect(wanted(urls, { ...state, mode: 'full' }, 'c')).toHaveLength(4);
  });
});

/* A fake directory: an index with two children, pages served from a map. */
function site({ blockAt = null, missing = [] } = {}) {
  const calls = [];
  const xml = (urls) =>
    `<urlset>${urls.map((u) => `<url><loc>${u}</loc><lastmod>2026-11-0${(urls.indexOf(u) % 9) + 1}T00:00:00Z</lastmod></url>`).join('')}</urlset>`;
  const children = {
    'https://mcp.so/sitemap.xml?section=servers&page=1': [
      'https://mcp.so/servers/a',
      'https://mcp.so/servers/b',
      'https://mcp.so/servers/c',
    ],
    'https://mcp.so/sitemap.xml?section=servers&page=2': ['https://mcp.so/servers/d'],
  };
  const page = (slug) =>
    `<html><script>x={slug:"${slug}",previousSlug:null,name:"${slug.toUpperCase()}",tagline:"t",repoUrl:"https://github.com/o/${slug}"}</script></html>`;
  const res = (status, body = '') => ({
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(),
    text: async () => body,
    body: null,
  });
  const http = {
    async text(url) {
      calls.push(url);
      if (url === 'https://mcp.so/sitemap.xml')
        return `<sitemapindex>${Object.keys(children)
          .map((c) => `<sitemap><loc>${c.replace(/&/g, '&amp;')}</loc></sitemap>`)
          .join(
            '',
          )}<sitemap><loc>https://mcp.so/sitemap.xml?section=posts</loc></sitemap></sitemapindex>`;
      if (children[url]) return xml(children[url]);
      throw new Error(`unexpected ${url}`);
    },
    async request(url) {
      calls.push(url);
      const slug = url.split('/').pop();
      if (slug === blockAt) return res(429);
      if (missing.includes(slug)) return res(404);
      return res(200, page(slug));
    },
  };
  return { http, calls };
}

async function drain(gen) {
  const batches = [];
  let r = await gen.next();
  while (!r.done) {
    batches.push(r.value);
    r = await gen.next();
  }
  return { batches, result: r.value };
}

const ctx = (http, cursor = {}, config = {}) => ({
  config: { pagesPerRun: 100, delayMs: 0, ...config },
  cursor,
  http,
  log: () => {},
  deadline: Infinity,
});

describe('the directory walk', () => {
  test('a full walk reads every server page across children, cursor per batch', async () => {
    const { http, calls } = site();
    const { batches, result } = await drain(mcpSo.pull(ctx(http)));
    const ids = batches.flatMap((b) => b.items.map((i) => i.externalId));
    expect(ids).toEqual([
      'mcpso:servers/a',
      'mcpso:servers/b',
      'mcpso:servers/c',
      'mcpso:servers/d',
    ]);
    expect(batches.flatMap((b) => b.items).map((i) => i.url)).toContain('https://github.com/o/a');
    expect(calls).not.toContain('https://mcp.so/sitemap.xml?section=posts');
    expect(batches[0].cursor).toMatchObject({ walking: true, child: 0, at: 3 });
    expect(result.cursor).toMatchObject({ v: 1, walking: false });
    expect(result.cursor.fullAt).toBe(result.cursor.since);
    expect(Object.values(result.cursor.counts)).toEqual([3, 1]);
  });

  test('the page budget ends a run mid-child and the next run resumes there', async () => {
    const one = site();
    const first = await drain(mcpSo.pull(ctx(one.http, {}, { pagesPerRun: 2 })));
    expect(first.result.nextInMinutes).toBe(WALK_AGAIN_MINUTES);
    expect(first.result.cursor).toMatchObject({ walking: true, child: 0, at: 2 });

    const two = site();
    const second = await drain(mcpSo.pull(ctx(two.http, first.result.cursor)));
    const ids = second.batches.flatMap((b) => b.items.map((i) => i.externalId));
    expect(ids).toEqual(['mcpso:servers/c', 'mcpso:servers/d']);
    expect(two.calls).not.toContain('https://mcp.so/servers/a');
    expect(second.result.cursor.walking).toBe(false);
  });

  test('a 429 mid-run stops at the cursor and backs off an hour', async () => {
    const { http } = site({ blockAt: 'c' });
    const { batches, result } = await drain(mcpSo.pull(ctx(http)));
    expect(batches.flatMap((b) => b.items.map((i) => i.externalId))).toEqual([
      'mcpso:servers/a',
      'mcpso:servers/b',
    ]);
    expect(result.cursor).toMatchObject({ walking: true, child: 0, at: 2 });
    expect(result.nextInMinutes).toBe(60);
  });

  test('a 429 on the first page throws, so the crawler rule can flag the site', async () => {
    const { http } = site({ blockAt: 'a' });
    await expect(drain(mcpSo.pull(ctx(http)))).rejects.toThrow(/429/);
  });

  test('a removed page (404) is skipped, not fatal', async () => {
    const { http } = site({ missing: ['b'] });
    const { batches } = await drain(mcpSo.pull(ctx(http)));
    expect(batches.flatMap((b) => b.items.map((i) => i.externalId))).toEqual([
      'mcpso:servers/a',
      'mcpso:servers/c',
      'mcpso:servers/d',
    ]);
  });
});

describe('registration', () => {
  test('all three are mcp adapters, seeded after the official registry', () => {
    const names = ADAPTERS.map((a) => a.name);
    for (const a of [mcpSo, mcpMarket, mcpServersOrg]) {
      expect(adapterByName(a.name)).toBe(a);
      expect(a.collection).toBe('mcp');
      expect(a.kinds).toEqual(['mcp-server']);
      expect(a.cadenceMinutes).toBe(1440);
      expect(names.indexOf(a.name)).toBeGreaterThan(names.indexOf('mcp-registry'));
    }
    expect(mcpMarket.defaults.delayMs).toBe(2000); // the crawl delay mcpmarket.com asks for
    expect(mcpSo.defaultSources[0].slug).toBe('mcpso-servers');
  });
});
