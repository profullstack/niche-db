import { defineAdapter, slugify } from '@nichedb/core/adapter';
import { repoUrl } from './catalogs.js';

/**
 * Repositories by topic, newest push first — the live edge of both catalogues.
 *
 * Every other source here is a list somebody maintains, and a maintained list
 * is always behind: a server published this morning reaches the official
 * registry when its author remembers to publish it and an awesome list when a
 * PR is merged. GitHub's search knows about it immediately. Measured on
 * 2026-09-25, `topic:mcp-server` matched 30,246 repositories and
 * `topic:claude-code` 77,213, against 4,507 distinct entries in the four big
 * MCP lists — so this is not a supplement to them, it is most of the ground.
 *
 * Because it is that much larger it is also that much noisier: a topic is a
 * label the repository's author chose, and nobody checks it. So this keeps the
 * `minStars` floor (default 1) and skips forks and archived repositories,
 * which is the cheapest filter that removes the great majority of abandoned
 * template clones without needing to open anything.
 *
 * Sorted by `updated`, walked a few pages per run from where the last run
 * stopped, and restarted at page 1 when a sweep finishes: search caps out at
 * 1,000 results per query however it is paged, which is why `topics` is a list
 * rather than one broad query.
 *
 * Unauthenticated search allows 10 requests a minute, which is enough at this
 * cadence; `GITHUB_TOKEN` on the deployment raises it to 30.
 */

const SEARCH = 'https://api.github.com/search/repositories';

export function toItem(r, { topic, kind }) {
  const full = String(r?.full_name ?? '').trim();
  if (!full) return null;
  const url = repoUrl(r.html_url) ?? `https://github.com/${full}`;

  return {
    externalId: `gh:${full.toLowerCase()}`,
    kind,
    title: full,
    summary: r.description ? String(r.description).replace(/\s+/g, ' ').trim() : null,
    url,
    imageUrl: r.owner?.avatar_url ?? null,
    // When the code last moved, which is the question this source answers.
    publishedAt: r.pushed_at ?? r.updated_at ?? null,
    tags: [
      kind === 'mcp-server' ? 'mcp' : 'agent',
      'github',
      'topic',
      slugify(topic),
      String(r.owner?.login ?? '').toLowerCase() || null,
      r.language ? slugify(r.language) : null,
      ...(Array.isArray(r.topics) ? r.topics.slice(0, 12).map((t) => slugify(t)) : []),
    ].filter(Boolean),
    data: {
      repo: full,
      topic,
      stars: Number(r.stargazers_count) || 0,
      forks: Number(r.forks_count) || 0,
      openIssues: Number(r.open_issues_count) || 0,
      language: r.language ?? null,
      license: r.license?.spdx_id ?? null,
      homepage: r.homepage || null,
      createdAt: r.created_at ?? null,
      pushedAt: r.pushed_at ?? null,
      topics: Array.isArray(r.topics) ? r.topics : [],
    },
  };
}

/**
 * The shared walk. One adapter per collection, because an adapter belongs to
 * exactly one, and these two want the same machinery over different words.
 */
function topicPull({ kind, fallback }) {
  return async function pull({ config, cursor, env, http, log }) {
    const topics = (config.topics?.length ? config.topics : fallback).map((t) =>
      String(t).trim().toLowerCase(),
    );
    const minStars = Math.max(Number(config.minStars) || 0, 0);
    const budget = Math.min(Math.max(Number(config.pagesPerRun) || 4, 1), 20);
    const headers = env.githubToken
      ? { authorization: `Bearer ${env.githubToken}`, accept: 'application/vnd.github+json' }
      : { accept: 'application/vnd.github+json' };

    let ti = Math.min(Number(cursor?.topicIndex) || 0, topics.length - 1);
    let page = Math.max(Number(cursor?.page) || 1, 1);

    const items = [];
    const seen = new Set();

    for (let n = 0; n < budget; n++) {
      const q = [
        `topic:${topics[ti]}`,
        minStars > 0 ? `stars:>=${minStars}` : null,
        'fork:false',
        'archived:false',
      ]
        .filter(Boolean)
        .join(' ');
      const params = new URLSearchParams({
        q,
        sort: 'updated',
        order: 'desc',
        per_page: '100',
        page: String(page),
      });
      const res = await http.json(`${SEARCH}?${params}`, { headers, timeoutMs: 45_000 });
      const rows = Array.isArray(res?.items) ? res.items : [];

      for (const r of rows) {
        const item = toItem(r, { topic: topics[ti], kind });
        if (!item || seen.has(item.externalId)) continue;
        seen.add(item.externalId);
        items.push(item);
      }

      // Search refuses to page past 1,000 results, so a sweep of one topic is
      // ten pages at most however many it says it matched.
      const end = rows.length < 100 || page >= 10;
      if (!end) {
        page += 1;
        continue;
      }
      ti += 1;
      page = 1;
      if (ti >= topics.length) {
        ti = 0;
        break;
      }
    }

    log(`${items.length} repositories, next at topic:${topics[ti]} page ${page}`);
    return {
      items,
      cursor: { topicIndex: ti, page },
      note: `${items.length} repo(s) from topic:${topics[ti]}`,
    };
  };
}

const FIELDS = [
  {
    key: 'topics',
    label: 'Topics',
    type: 'list',
    help: 'GitHub topic names. Each is swept separately, newest push first.',
  },
  {
    key: 'minStars',
    label: 'Minimum stars',
    type: 'number',
    help: 'A topic is a label the author chose and nobody checks. One star removes most of the noise.',
    placeholder: '1',
  },
  { key: 'pagesPerRun', label: 'Pages per run', type: 'number', placeholder: '4' },
];

export const MCP_TOPICS = ['mcp-server', 'mcp-servers', 'model-context-protocol', 'mcp'];
export const AGENT_TOPICS = [
  'claude-code',
  'claude-code-plugin',
  'claude-code-agents',
  'claude-skills',
  'agent-skills',
  'claude-code-hooks',
  'subagents',
];

export const githubMcpTopics = defineAdapter({
  name: 'github-mcp-topics',
  title: 'New MCP repositories on GitHub',
  collection: 'mcp',
  description:
    'Repositories tagged as MCP servers, newest push first. The fastest of these sources by a wide margin — a server is searchable the moment it is tagged, rather than when a list maintainer merges a PR — and the noisiest, so forks, archived repositories and anything with no stars are skipped.',
  docs: 'https://docs.github.com/en/rest/search/search#search-repositories',
  kinds: ['mcp-server'],
  cadenceMinutes: 60,
  configFields: FIELDS,
  defaults: { topics: MCP_TOPICS, minStars: 1, pagesPerRun: 4 },
  defaultSources: [{ slug: 'github-mcp-topics', name: 'MCP servers tagged on GitHub' }],
  pull: topicPull({ kind: 'mcp-server', fallback: MCP_TOPICS }),
});

export const githubAgentTopics = defineAdapter({
  name: 'github-agent-topics',
  title: 'New agent workflow repositories on GitHub',
  collection: 'workflows',
  description:
    'Repositories tagged for Claude Code, agent skills, subagents, hooks and plugins, newest push first. Where a workflow shows up before any list has it.',
  docs: 'https://docs.github.com/en/rest/search/search#search-repositories',
  kinds: ['agent-repo'],
  cadenceMinutes: 60,
  configFields: FIELDS,
  defaults: { topics: AGENT_TOPICS, minStars: 1, pagesPerRun: 4 },
  defaultSources: [{ slug: 'github-agent-topics', name: 'Agent workflow repos on GitHub' }],
  pull: topicPull({ kind: 'agent-repo', fallback: AGENT_TOPICS }),
});
