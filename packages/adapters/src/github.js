import { defineAdapter } from '@nichedb/core/adapter';

/** Releases on the repositories you name. A token raises the rate limit from 60 to 5000 an hour. */
export function toItem(repo, r) {
  const [owner] = repo.split('/');
  return {
    externalId: `${repo}#${r.tag_name}`,
    kind: 'release',
    title: `${repo} ${r.name && r.name !== r.tag_name ? `${r.tag_name} — ${r.name}` : r.tag_name}`,
    summary: r.body ? String(r.body).slice(0, 2000) : null,
    url: r.html_url,
    imageUrl: r.author?.avatar_url ?? null,
    publishedAt: r.published_at ?? r.created_at,
    tags: [owner, repo, r.prerelease ? 'prerelease' : 'stable', 'github'],
    data: {
      repo,
      tag: r.tag_name,
      prerelease: Boolean(r.prerelease),
      draft: Boolean(r.draft),
      author: r.author?.login ?? null,
    },
  };
}

export const githubReleases = defineAdapter({
  name: 'github-releases',
  title: 'GitHub releases',
  collection: 'packages',
  description:
    'New releases on the GitHub repositories you list. Works without a token at 60 requests an hour; set GITHUB_TOKEN on the deployment for 5,000.',
  docs: 'https://docs.github.com/en/rest/releases/releases',
  kinds: ['release'],
  cadenceMinutes: 30,
  configFields: [
    {
      key: 'repos',
      label: 'Repositories',
      type: 'list',
      required: true,
      placeholder: 'oven-sh/bun, honojs/hono',
      help: 'owner/name, comma separated.',
    },
  ],
  defaults: { repos: [] },
  defaultSources: [
    {
      slug: 'github-releases-runtimes',
      name: 'GitHub: runtimes and frameworks',
      config: {
        repos: [
          'oven-sh/bun',
          'nodejs/node',
          'denoland/deno',
          'honojs/hono',
          'vitejs/vite',
          'facebook/react',
          'vercel/next.js',
          'sveltejs/svelte',
          'modelcontextprotocol/typescript-sdk',
          'anthropics/claude-code',
          'postgres/postgres',
          'redis/redis',
        ],
      },
    },
  ],
  async pull({ config, env, http, budget, deadline, log }) {
    const repos = (
      Array.isArray(config.repos) ? config.repos : String(config.repos ?? '').split(',')
    )
      .map((s) =>
        String(s)
          .trim()
          .replace(/^https?:\/\/github\.com\//, '')
          .replace(/\/$/, ''),
      )
      .filter((s) => /^[\w.-]+\/[\w.-]+$/.test(s))
      .slice(0, budget);
    const headers = env.githubToken ? { authorization: `Bearer ${env.githubToken}` } : {};
    const items = [];
    let missing = 0;
    for (const repo of repos) {
      if (Date.now() > deadline) break;
      const rel = await http.jsonOrNull(
        `https://api.github.com/repos/${repo}/releases?per_page=15`,
        { headers },
      );
      if (!rel) {
        missing++;
        continue;
      }
      for (const r of rel) if (!r.draft) items.push(toItem(repo, r));
    }
    log(
      `${repos.length} repo(s), ${items.length} release(s)${missing ? `, ${missing} not found` : ''}`,
    );
    return { items, note: `${repos.length} repos` };
  },
});
