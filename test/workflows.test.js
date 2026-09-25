import { describe, expect, test } from 'bun:test';
import { toItem as aitmplItem, GROUP_KINDS } from '../packages/adapters/src/aitmpl.js';
import { toItem as agentItem } from '../packages/adapters/src/awesomeagents.js';
import {
  toItem as accItem,
  parseCsv,
  parseTable,
  tableDate,
} from '../packages/adapters/src/awesomeclaudecode.js';
import { toItem as topicItem } from '../packages/adapters/src/ghtopics.js';
import { adapterByName } from '../packages/adapters/src/index.js';
import { toItem as pluginItem, pluginUrl } from '../packages/adapters/src/pluginmarketplaces.js';
import {
  parseWorkflow,
  plain,
  toItem as redditItem,
} from '../packages/adapters/src/redditworkflows.js';
import { normaliseItem } from '../packages/core/src/adapter.js';
import { isReservedNicheSlug } from '../packages/knowledge/src/index.js';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';
const { COLLECTIONS, DEFAULT_FEEDS } = await import('../packages/core/src/seed.js');

/* A workflow post as the library's bot writes one. */
const post = (over = {}) => ({
  id: '1wpq3f6',
  subreddit: 'ClaudeWorkflows',
  author: 'ClaudeAI-mod-bot',
  link_flair_text: 'Selected Workflow',
  score: 12,
  num_comments: 3,
  created_utc: 1790321831,
  title: '[Workflow] Parallel Development with Multi-Agent Lanes and Git Worktrees',
  selftext: `# Parallel Development with Multi-Agent Lanes

**Workflow value:** 75/100
**Status:** active · **Freshness:** 70/100 · **Confidence:** 0.90 · **Level:** beginner
**Categories:** Quality Control, Token Saving, Context & Memory
**Original source:** [r/ClaudeCode post/comment](https://www.reddit.com/r/ClaudeCode/comments/1wpmq18/x/)

## What problem this solves

Running several agents at once without them **overwriting** each other's work.

## Steps

1. Make a worktree.
`,
  ...over,
});

describe('the workflow library on Reddit', () => {
  const item = redditItem(post());

  test('the template fields become fields, not prose', () => {
    expect(item.data.value).toBe(75);
    expect(item.data.freshness).toBe(70);
    expect(item.data.confidence).toBe(0.9);
    expect(item.data.status).toBe('active');
    expect(item.data.level).toBe('beginner');
    expect(item.data.categories).toEqual(['Quality Control', 'Token Saving', 'Context & Memory']);
    expect(item.data.originalSource).toContain('/r/ClaudeCode/');
  });

  test('the summary is what the workflow is for, not the whole post', () => {
    expect(item.summary).toBe(
      "Running several agents at once without them overwriting each other's work.",
    );
  });

  test('the tag prefix is dropped from the title and the votes are kept', () => {
    expect(item.title).toBe('Parallel Development with Multi-Agent Lanes and Git Worktrees');
    expect(item.data.score).toBe(12);
    expect(item.kind).toBe('workflow');
  });

  test('categories, level and flair are all followable', () => {
    const tags = normaliseItem(item).tags;
    expect(tags).toContain('token-saving');
    expect(tags).toContain('beginner');
    expect(tags).toContain('selected-workflow');
  });

  test('the post links to itself on reddit, at a stable URL', () => {
    expect(item.url).toBe('https://www.reddit.com/r/ClaudeWorkflows/comments/1wpq3f6/');
    expect(item.publishedAt).toBe(new Date(1790321831 * 1000).toISOString());
  });

  test("the library's own index posts are marked as maps rather than workflows", () => {
    const idx = redditItem(post({ title: 'Claude Workflow Library: Hooks', selftext: '# Hooks' }));
    expect(idx.kind).toBe('workflow-index');
    expect(normaliseItem(idx).tags).toContain('index');
  });

  test('a post without the template still becomes a readable row', () => {
    const free = redditItem(post({ selftext: 'Just some prose about a trick I use.' }));
    expect(free.summary).toBe('Just some prose about a trick I use.');
    expect(free.data.value).toBeNull();
    expect(free.data.categories).toEqual([]);
  });

  test('markdown does not reach the summary', () => {
    expect(plain('# H\n\n**bold** [link](https://x.test)\n\n```\ncode()\n```')).toBe('H bold link');
  });

  test('a missing id or title is not an item', () => {
    expect(redditItem({ title: 'no id' })).toBeNull();
    expect(parseWorkflow('').categories).toEqual([]);
  });
});

describe('awesome-claude-code, read from its table', () => {
  const csv = `ID,Display Name,Category,Sub-Category,Link,Author Name,Author Link,Active,Date Added,Last Checked,Description,Stale
skills-1,Librarian,Skills,Obsidian,https://github.com/ngmeyer/librarian-mcp,ngmeyer,https://github.com/ngmeyer,TRUE,2026-06-29:21-22-44,2026-06-29:21-22-44,"A server that gives Claude a ""second brain"", with search.",FALSE
docs-2,Dead Thing,Documentation,,https://github.com/gone/away,Someone,https://github.com/someone,FALSE,,,No longer resolves.,FALSE
docs-3,Best Practices,Start Here,,https://code.claude.com/docs/en/best-practices,Anthropic,https://anthropic.com,TRUE,,,The official guide.,TRUE
`;

  const rows = parseTable(csv);

  test('quoted commas and doubled quotes survive the parse', () => {
    expect(rows.length).toBe(3);
    expect(rows[0].Description).toBe('A server that gives Claude a "second brain", with search.');
  });

  test('an entry the maintainer marked dead is not ingested', () => {
    const items = rows.map(accItem).filter(Boolean);
    expect(items.length).toBe(2);
    expect(items.some((i) => i.title === 'Dead Thing')).toBe(false);
  });

  test('a category that is its own kind becomes one, and is split off', () => {
    expect(accItem(rows[0]).kind).toBe('skill');
    expect(accItem(rows[2]).kind).toBe('workflow');
    // The skill rows go to /skills, the rest to /workflows, from one CSV.
    expect(adapterByName('awesome-claude-code-skills').collection).toBe('skills');
    expect(adapterByName('awesome-claude-code').collection).toBe('workflows');
  });

  test('stale is kept as a tag rather than a deletion', () => {
    expect(normaliseItem(accItem(rows[2])).tags).toContain('stale');
  });

  test("the list's own date format is converted rather than guessed at", () => {
    expect(tableDate('2026-06-29:21-22-44')).toBe('2026-06-29T21:22:44Z');
    expect(tableDate('2026-06-29')).toBe('2026-06-29T12:00:00Z');
    expect(tableDate('')).toBeNull();
    expect(new Date(tableDate('2026-06-29:21-22-44')).toString()).not.toBe('Invalid Date');
  });

  test('a row keeps its author and its repository', () => {
    const item = accItem(rows[0]);
    expect(item.data.author).toBe('ngmeyer');
    expect(item.data.repo).toBe('ngmeyer/librarian-mcp');
    expect(item.url).toBe('https://github.com/ngmeyer/librarian-mcp');
  });

  test('an empty table is an empty list, not a crash', () => {
    expect(parseTable('')).toEqual([]);
    expect(parseCsv('a,b\n1,2\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
});

describe('plugin marketplaces', () => {
  test('a plugin is located by where it lives, not by its marketplace', () => {
    expect(pluginUrl('./plugins/documentation-standards', 'wshobson/agents')).toBe(
      'https://github.com/wshobson/agents/tree/HEAD/plugins/documentation-standards',
    );
    expect(pluginUrl({ source: 'github', repo: 'other/plugin' }, 'wshobson/agents')).toBe(
      'https://github.com/other/plugin',
    );
    expect(pluginUrl('', 'wshobson/agents')).toBe('https://github.com/wshobson/agents');
  });

  test('94 plugins in one repository are 94 rows, not one', () => {
    const a = pluginItem(
      { name: 'one', source: './plugins/one' },
      { repo: 'wshobson/agents', marketplace: 'claude-code-workflows' },
    );
    const b = pluginItem(
      { name: 'two', source: './plugins/two' },
      { repo: 'wshobson/agents', marketplace: 'claude-code-workflows' },
    );
    expect(normaliseItem(a).dedupeKey).not.toBe(normaliseItem(b).dedupeKey);
  });

  test('the row says how to install it', () => {
    const item = pluginItem(
      {
        name: 'documentation-standards',
        source: './plugins/documentation-standards',
        description: 'Semantic tagging for docs.',
        version: '1.1.0',
        author: { name: 'Niksa Barlovic', url: 'https://github.com/catcam' },
        license: 'MIT',
        category: 'documentation',
      },
      { repo: 'wshobson/agents', marketplace: 'claude-code-workflows' },
    );
    expect(item.kind).toBe('plugin');
    expect(item.title).toBe('documentation standards');
    expect(item.data.install).toBe('/plugin marketplace add wshobson/agents');
    expect(item.data.author).toBe('Niksa Barlovic');
    expect(normaliseItem(item).tags).toContain('documentation');
  });
});

describe('aitmpl components', () => {
  test('a component links to its own file and says how to install it', () => {
    const item = aitmplItem(
      {
        name: 'accessibility-tester',
        path: 'accessibility/accessibility-tester.md',
        category: 'accessibility',
        description: '"Use this agent when conducting accessibility audits"',
        downloads: 50,
      },
      { group: 'agents', kind: 'agent' },
    );
    expect(item.url).toContain('/cli-tool/components/agents/accessibility/accessibility-tester.md');
    expect(item.summary).toBe('Use this agent when conducting accessibility audits');
    expect(item.data.install).toContain('--agent accessibility/accessibility-tester');
    expect(item.data.downloads).toBe(50);
  });

  test('each group lands in the collection somebody would look for it in', () => {
    const where = {
      'aitmpl-skills': 'skills',
      'aitmpl-agents': 'agents',
      'aitmpl-commands': 'commands',
      'aitmpl-hooks': 'hooks',
      'aitmpl-components': 'workflows',
      'aitmpl-mcps': 'mcp',
    };
    for (const [name, collection] of Object.entries(where)) {
      expect(adapterByName(name)?.collection).toBe(collection);
    }
    // Every group of components.json is ingested by exactly one of them.
    const covered = Object.keys(where).flatMap((n) => adapterByName(n).kinds);
    for (const kind of GROUP_KINDS.values()) expect(covered).toContain(kind);
  });

  test('a component with nothing to link to is not a row', () => {
    // All 14 project templates are pathless. Ingesting them would put 14 rows
    // on one URL, which a collection that deduplicates on URL turns into one.
    expect(
      aitmplItem(
        { name: 'angular-app', category: 'frameworks' },
        {
          group: 'templates',
          kind: 'template',
        },
      ),
    ).toBeNull();
    expect(GROUP_KINDS.has('templates')).toBe(false);
  });
});

describe('the collections', () => {
  test('each thing people install has a collection of its own', () => {
    // Served from the site root as /workflows, /skills, /agents, /commands,
    // /plugins and /hooks, because a niche's page is its slug.
    for (const slug of ['workflows', 'skills', 'agents', 'commands', 'plugins', 'hooks']) {
      expect(COLLECTIONS.find((x) => x.slug === slug)).toBeTruthy();
      expect(DEFAULT_FEEDS.some((f) => f.collection === slug)).toBe(true);
    }
  });

  test('none of those names is one the site already owns at the root', () => {
    // A reserved slug would be shadowed by a real route, so the niche page
    // would never answer. `mcp` is reserved, which is why the servers stay
    // at /c/mcp.
    for (const slug of ['workflows', 'skills', 'agents', 'commands', 'plugins', 'hooks']) {
      expect(isReservedNicheSlug(slug)).toBe(false);
    }
    expect(isReservedNicheSlug('mcp')).toBe(true);
  });

  test('every workflow adapter is registered and points at its collection', () => {
    const where = {
      'reddit-workflows': 'workflows',
      'awesome-claude-code': 'workflows',
      'aitmpl-components': 'workflows',
      'github-agent-topics': 'workflows',
      'awesome-claude-code-skills': 'skills',
      'aitmpl-skills': 'skills',
      'awesome-agents': 'agents',
      'aitmpl-agents': 'agents',
      'aitmpl-commands': 'commands',
      'aitmpl-hooks': 'hooks',
      'plugin-marketplaces': 'plugins',
    };
    for (const [name, collection] of Object.entries(where)) {
      expect(adapterByName(name)?.collection).toBe(collection);
    }
  });

  test('a curated subagent list names one subagent per row', () => {
    const item = agentItem(
      {
        title: 'api-designer',
        url: 'https://github.com/voltagent/awesome-claude-code-subagents/tree/HEAD/categories/01-core-development/api-designer.md',
        description: 'REST and GraphQL API architect',
        section: 'Categories',
        subsection: '01. Core Development',
      },
      { list: 'voltagent' },
    );
    expect(item.kind).toBe('agent');
    expect(item.title).toBe('api designer');
    expect(normaliseItem(item).tags).toContain('voltagent');
  });

  test('a tagged agent repository is an agent-repo, not an MCP server', () => {
    const item = topicItem(
      { full_name: 'a/b', html_url: 'https://github.com/a/b', owner: { login: 'a' } },
      { topic: 'claude-code', kind: 'agent-repo' },
    );
    expect(item.kind).toBe('agent-repo');
    expect(normaliseItem(item).tags).toContain('agent');
  });
});
