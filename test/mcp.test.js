import { describe, expect, test } from 'bun:test';
import { toItem as aitmplItem } from '../packages/adapters/src/aitmpl.js';
import { toItem as awesomeItem, SKIP_SECTIONS } from '../packages/adapters/src/awesomemcp.js';
import {
  cleanText,
  parseMarkdownList,
  repoSlug,
  repoUrl,
} from '../packages/adapters/src/catalogs.js';
import { toItem as dockerItem, parseCatalog } from '../packages/adapters/src/dockermcp.js';
import { toItem as topicItem } from '../packages/adapters/src/ghtopics.js';
import { ADAPTERS, adapterByName } from '../packages/adapters/src/index.js';
import { collapse, toItem as registryItem } from '../packages/adapters/src/mcpregistry.js';
import { toItem as smitheryItem } from '../packages/adapters/src/smithery.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';
const { COLLECTIONS, DEFAULT_FEEDS } = await import('../packages/core/src/seed.js');

describe('repoUrl: the form two lists have to agree on', () => {
  test('case, trailing slash and .git are not differences', () => {
    const want = 'https://github.com/owner/repo';
    expect(repoUrl('https://github.com/Owner/Repo')).toBe(want);
    expect(repoUrl('https://github.com/owner/repo/')).toBe(want);
    expect(repoUrl('https://github.com/owner/repo.git')).toBe(want);
    expect(repoUrl('http://www.github.com/OWNER/REPO')).toBe(want);
    expect(repoUrl('https://github.com/owner/repo#readme')).toBe(want);
    expect(repoUrl('https://github.com/owner/repo?tab=readme-ov-file')).toBe(want);
  });

  test('blob, tree and any ref address the same page', () => {
    const want = 'https://github.com/modelcontextprotocol/servers/tree/HEAD/src/git';
    expect(repoUrl('https://github.com/modelcontextprotocol/servers/tree/main/src/git')).toBe(want);
    expect(repoUrl('https://github.com/modelcontextprotocol/servers/blob/main/src/git')).toBe(want);
    expect(repoUrl('https://github.com/modelcontextprotocol/servers/tree/9f8c1ab/src/git')).toBe(
      want,
    );
  });

  test('a subpath is kept, because a monorepo holds many servers', () => {
    expect(repoUrl('https://github.com/awslabs/mcp/tree/main/src/core-mcp-server')).not.toBe(
      repoUrl('https://github.com/awslabs/mcp/tree/main/src/eks-mcp-server'),
    );
  });

  test('relative links resolve against the README they were written in', () => {
    expect(
      repoUrl('src/git', { base: 'https://github.com/modelcontextprotocol/servers/blob/main/' }),
    ).toBe('https://github.com/modelcontextprotocol/servers/tree/HEAD/src/git');
  });

  test('anchors, mailto and nonsense are not URLs', () => {
    expect(repoUrl('#table-of-contents')).toBeNull();
    expect(repoUrl('mailto:someone@example.com')).toBeNull();
    expect(repoUrl('')).toBeNull();
    expect(repoUrl('https://github.com/owner')).toBeNull();
  });

  test('a site keeps its path and loses www and the trailing slash', () => {
    expect(repoUrl('http://www.Example.com/mcp/')).toBe('https://example.com/mcp');
    expect(repoSlug('https://example.com/mcp')).toBeNull();
    expect(repoSlug('https://github.com/owner/repo')).toBe('owner/repo');
  });
});

describe('the awesome lists, in four dialects', () => {
  const md = `# Awesome MCP Servers

## Clients

- [some-client](https://github.com/x/client) - not a server

## Server Implementations

### Aggregators

- [punk/style](https://github.com/Punk/Style) [![badge](https://img.shields.io/x.svg)](https://glama.ai/x) 🐍 ☁️ - Does a thing.
- **[Bold Style](https://github.com/wong/bold)** - Bold list style.
- [Plain Style](https://github.com/appcypher/plain) - Plain list style.
- **[Git](src/git)** - Relative, as the protocol repo writes it.
- [Table of contents](#server-implementations)

\`\`\`json
- [not a server](https://github.com/in/a-fence)
\`\`\`
`;

  const rows = parseMarkdownList(md, {
    base: 'https://github.com/modelcontextprotocol/servers/blob/main/',
    skipSections: SKIP_SECTIONS,
  });

  test('every dialect parses, and the noise does not', () => {
    expect(rows.map((r) => r.url)).toEqual([
      'https://github.com/punk/style',
      'https://github.com/wong/bold',
      'https://github.com/appcypher/plain',
      'https://github.com/modelcontextprotocol/servers/tree/HEAD/src/git',
    ]);
  });

  test('a skipped heading takes its entries with it', () => {
    expect(rows.some((r) => r.url.includes('/x/client'))).toBe(false);
  });

  test('badges and emoji are not part of the description', () => {
    expect(rows[0].description).toBe('Does a thing.');
    expect(rows[0].section).toBe('Server Implementations');
    expect(rows[0].subsection).toBe('Aggregators');
  });

  test('cleanText leaves prose and takes the markup', () => {
    expect(cleanText('**Bold** [link](https://x.test) ![i](https://y.test) 🚀 `code`')).toBe(
      'Bold link code',
    );
  });

  test('an entry becomes an item keyed on the comparable URL', () => {
    const item = normaliseItem(awesomeItem(rows[0], { list: 'punkpeye' }));
    expect(item.kind).toBe('mcp-server');
    expect(item.externalId).toBe('https://github.com/punk/style');
    expect(item.title).toBe('style');
    expect(item.tags).toContain('punkpeye');
    expect(item.tags).toContain('server-implementations');
    // What the collection compares one source's row against another's.
    expect(item.dedupeKey).toBe('github.com/punk/style');
  });

  test('two lists writing the same server reach the same dedupe key', () => {
    const fromPunk = normaliseItem(
      awesomeItem(
        {
          title: 'x',
          url: repoUrl('https://github.com/Owner/Repo'),
          description: '',
          section: 'S',
        },
        { list: 'punkpeye' },
      ),
    );
    const fromWong = normaliseItem(
      awesomeItem(
        {
          title: 'X',
          url: repoUrl('https://github.com/owner/repo/'),
          description: '',
          section: 'T',
        },
        { list: 'wong2' },
      ),
    );
    expect(fromPunk.dedupeKey).toBe(fromWong.dedupeKey);
  });
});

describe("Docker's catalogue", () => {
  const yaml = `version: 2
name: docker-mcp
registry:
  aws-core-mcp-server:
    description: Starting point for using the awslabs MCP servers.
    title: AWS Core
    type: server
    dateAdded: "2025-05-05T20:04:34Z"
    image: mcp/aws-core-mcp-server@sha256:f624
    ref: ""
    source: https://github.com/awslabs/mcp/tree/780e3f1/src/core-mcp-server
    upstream: https://github.com/awslabs/mcp
    icon: https://avatars.githubusercontent.com/u/3299148?v=4
    tools:
      - name: prompt_understanding
      - name: second_tool
    prompts: 0
    resources: {}
    metadata:
      pulls: 124155
      stars: 3
      category: devops
      tags:
        - aws-core-mcp-server
        - devops
      license: Apache License 2.0
      owner: awslabs
  brave:
    description: Search the Web.
    title: Brave Search
    type: server
    dateAdded: "2025-05-05T20:08:35Z"
    image: mcp/brave-search@sha256:f58a
    source: https://github.com/brave/brave-search-mcp-server/tree/fd28e3e
    upstream: https://github.com/brave/brave-search-mcp-server
    tools:
      - name: brave_web_search
    metadata:
      pulls: 273994
      category: search
      tags:
        - brave
      license: MIT License
      owner: brave
`;

  const entries = parseCatalog(yaml);

  test('the shape Docker publishes is read whole', () => {
    expect(entries.length).toBe(2);
    expect(entries[0].title).toBe('AWS Core');
    expect(entries[0].tools).toEqual(['prompt_understanding', 'second_tool']);
    expect(entries[0].tags).toEqual(['aws-core-mcp-server', 'devops']);
    expect(entries[0].metadata.license).toBe('Apache License 2.0');
    expect(entries[0].dateAdded).toBe('2025-05-05T20:04:34Z');
  });

  test('a monorepo server is keyed on its own path, not the repository', () => {
    const item = dockerItem(entries[0]);
    expect(item.url).toBe('https://github.com/awslabs/mcp/tree/HEAD/src/core-mcp-server');
    expect(item.data.pulls).toBe(124155);
    expect(item.data.toolCount).toBe(2);
  });

  test('a server whose source is the repository root keys on the repository', () => {
    const item = dockerItem(entries[1]);
    expect(item.url).toBe('https://github.com/brave/brave-search-mcp-server');
    expect(normaliseItem(item).dedupeKey).toBe('github.com/brave/brave-search-mcp-server');
  });
});

describe('the registries', () => {
  test('the official registry folds its repository URL to the comparable form', () => {
    const item = registryItem({
      server: {
        name: 'io.example/thing',
        title: 'Thing',
        description: 'Does things.',
        version: '1.2.3',
        repository: { url: 'https://github.com/Example/Thing/' },
        packages: [{ registryType: 'npm', identifier: 'thing-mcp' }],
      },
      _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active' } },
    });
    expect(item.url).toBe('https://github.com/example/thing');
    expect(item.data.repo).toBe('example/thing');
    expect(normaliseItem(item).dedupeKey).toBe('github.com/example/thing');
  });

  test('a declared subfolder keeps monorepo publishers apart', () => {
    const item = registryItem({
      server: {
        name: 'io.example/one',
        description: 'One of several in a monorepo.',
        repository: { url: 'https://github.com/Example/Monorepo', subfolder: 'packages/one' },
      },
    });
    expect(item.url).toBe('https://github.com/example/monorepo/tree/HEAD/packages/one');
    expect(item.data.subfolder).toBe('packages/one');
  });

  test('one row per server at its newest version, not one per version', () => {
    const version = (v, at) => ({
      server: {
        name: 'ac.tandem/docs-mcp',
        version: v,
        repository: { url: 'https://github.com/t/d' },
      },
      _meta: { 'io.modelcontextprotocol.registry/official': { publishedAt: at, updatedAt: at } },
    });
    const rows = collapse(
      [
        version('0.3.0', '2026-01-01T00:00:00Z'),
        version('0.3.2', '2026-03-01T00:00:00Z'),
        version('0.3.1', '2026-02-01T00:00:00Z'),
      ].map(registryItem),
    );
    expect(rows.length).toBe(1);
    expect(rows[0].data.version).toBe('0.3.2');
  });

  test('a repository three different servers claim identifies none of them', () => {
    const server = (name) => ({
      server: { name, repository: { url: 'https://github.com/modelcontextprotocol/registry' } },
    });
    const rows = collapse(
      ['agency.ottobot/a', 'agency.ottobot/b', 'agency.ottobot/c'].map((n) =>
        registryItem(server(n)),
      ),
    );
    expect(rows.length).toBe(3);
    expect(new Set(rows.map((r) => r.url)).size).toBe(3);
    for (const r of rows) {
      expect(r.url).toContain('registry.modelcontextprotocol.io/v0/servers/');
      expect(r.data.sharedRepository).toBe('https://github.com/modelcontextprotocol/registry');
    }
  });

  test('a repository only one server claims still keys on the repository', () => {
    const rows = collapse([
      registryItem({ server: { name: 'a/one', repository: { url: 'https://github.com/a/one' } } }),
      registryItem({ server: { name: 'b/two', repository: { url: 'https://github.com/b/two' } } }),
    ]);
    expect(rows.map((r) => r.url)).toEqual([
      'https://github.com/a/one',
      'https://github.com/b/two',
    ]);
  });

  test('Smithery keys on the repository when it knows one', () => {
    const item = smitheryItem({
      qualifiedName: 'owner/thing',
      displayName: 'Thing',
      description: 'A thing.',
      homepage: 'https://github.com/Owner/Thing',
      useCount: 42,
      remote: true,
      isDeployed: true,
      verified: true,
      createdAt: '2026-03-29T11:03:52.456Z',
    });
    expect(item.url).toBe('https://github.com/owner/thing');
    expect(item.data.useCount).toBe(42);
    expect(item.tags).toContain('remote');
  });

  test('a vendor homepage is never the key: two servers would become one', () => {
    const a = smitheryItem({ qualifiedName: 'one', homepage: 'https://vendor.example/api' });
    const b = smitheryItem({ qualifiedName: 'two', homepage: 'https://vendor.example/api' });
    expect(a.url).toBe('https://smithery.ai/server/one');
    expect(b.url).toBe('https://smithery.ai/server/two');
  });

  test('a tagged repository carries its push date, which is the question asked', () => {
    const item = topicItem(
      {
        full_name: 'Someone/Their-Server',
        html_url: 'https://github.com/Someone/Their-Server',
        description: 'An MCP server.',
        pushed_at: '2026-09-25T06:00:00Z',
        stargazers_count: 12,
        topics: ['mcp-server', 'llm'],
        owner: { login: 'Someone' },
      },
      { topic: 'mcp-server', kind: 'mcp-server' },
    );
    expect(item.externalId).toBe('gh:someone/their-server');
    expect(item.url).toBe('https://github.com/someone/their-server');
    expect(item.data.stars).toBe(12);
  });

  test('an aitmpl MCP config is a config, tagged mcp, keyed on its own file', () => {
    const item = aitmplItem(
      { name: 'elevenlabs', path: 'audio/elevenlabs.json', category: 'audio', downloads: 84 },
      { group: 'mcps', kind: 'mcp-config' },
    );
    expect(item.url).toContain('/cli-tool/components/mcps/audio/elevenlabs.json');
    expect(item.data.downloads).toBe(84);
    // Tagged mcp rather than mcp-config, so it is followable beside the servers.
    expect(item.tags).toContain('mcp');
    expect(item.data.install).toContain('--mcp ');
  });
});

describe('the collection', () => {
  test('mcp is seeded, deduplicates and has feeds', () => {
    const c = COLLECTIONS.find((x) => x.slug === 'mcp');
    expect(c?.name).toBe('MCP servers');
    expect(DEFAULT_FEEDS.filter((f) => f.collection === 'mcp').length).toBeGreaterThanOrEqual(3);
  });

  test('every MCP adapter is registered and points at it', () => {
    for (const name of [
      'mcp-registry',
      'docker-mcp',
      'smithery',
      'awesome-mcp',
      'aitmpl-mcps',
      'github-mcp-topics',
    ]) {
      expect(adapterByName(name)?.collection).toBe('mcp');
    }
  });

  test('the registry runs before the lists, because first writer keeps the server', () => {
    const order = ADAPTERS.map((a) => a.name);
    expect(order.indexOf('mcp-registry')).toBeLessThan(order.indexOf('awesome-mcp'));
    expect(order.indexOf('mcp-registry')).toBeLessThan(order.indexOf('github-mcp-topics'));
  });
});
