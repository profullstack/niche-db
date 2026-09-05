import { defineEnricher } from './enricher.js';

/** Stars, topics, licence and last push for anything that points at a GitHub repo. */
export function repoOf(item) {
  const cands = [
    item.data?.repository,
    item.data?.repo,
    item.data?.homepage,
    item.data?.path,
    item.url,
  ];
  for (const c of cands) {
    const m = String(c ?? '').match(/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git|\/|#|@|$)/);
    if (m && !['orgs', 'topics', 'sponsors'].includes(m[1])) return `${m[1]}/${m[2]}`;
  }
  return null;
}

export const githubRepo = defineEnricher({
  name: 'github-repo',
  title: 'GitHub repository',
  description: 'Stars, topics, licence, language and last push of the linked repository.',
  collections: ['packages', 'extensions'],
  appliesTo: (item) => Boolean(repoOf(item)),
  perRun: 25,
  async enrich(item, { env, http }) {
    const repo = repoOf(item);
    const headers = env.githubToken ? { authorization: `Bearer ${env.githubToken}` } : {};
    const r = await http.jsonOrNull(`https://api.github.com/repos/${repo}`, { headers });
    if (!r) return null;
    return {
      repo: r.full_name,
      url: r.html_url,
      stars: r.stargazers_count,
      forks: r.forks_count,
      openIssues: r.open_issues_count,
      language: r.language,
      license: r.license?.spdx_id ?? null,
      topics: (r.topics ?? []).slice(0, 10),
      pushedAt: r.pushed_at,
      archived: Boolean(r.archived),
      description: r.description,
      summary: r.description ?? null,
      imageUrl: r.owner?.avatar_url ?? null,
      tags: (r.topics ?? []).slice(0, 5),
    };
  },
});
