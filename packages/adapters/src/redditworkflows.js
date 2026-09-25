import { defineAdapter, slugify } from '@nichedb/core/adapter';

/**
 * r/ClaudeWorkflows, the subreddit that is organised as a library.
 *
 * Most of what people know about working with an agent is written down in a
 * forum post and nowhere else, and it stays there. This subreddit is the one
 * attempt at the opposite: each workflow is its own post, the moderators post
 * category indexes that link them, and the votes on a post are a rating of
 * whether the workflow reproduces. Its own index post — the one this
 * collection was built around — counted 205 workflows in the library on
 * 2026-05-07 and it has been publishing steadily since.
 *
 * Better still, the posts are machine-written to a template:
 *
 *     **Workflow value:** 75/100
 *     **Status:** active · **Freshness:** 70/100 · **Confidence:** 0.90 · **Level:** beginner
 *     **Categories:** Quality Control, Token Saving, Context & Memory
 *     **Original source:** [r/ClaudeCode post/comment](https://reddit.com/...)
 *
 * so `parseWorkflow` lifts those into `data` rather than leaving them as prose
 * in a blob of markdown, which is what makes "beginner workflows about token
 * saving, rated above 70" a query instead of a reading exercise.
 *
 * HOW IT IS READ
 *
 * Not from reddit.com. Every Reddit road — the site, old.reddit, the .json
 * suffix, r.jina.ai, redlib mirrors and a real browser — answers this
 * deployment with "blocked by network security" or a login wall, and there is
 * no Reddit credential. The Arctic Shift archive serves the same posts by id
 * or by subreddit search within minutes of them being posted, anonymously.
 * `sort=asc` with `after` makes that an ordinary incremental walk.
 */

const SEARCH = 'https://arctic-shift.photon-reddit.com/api/posts/search';
const FIELDS =
  'id,title,selftext,created_utc,score,num_comments,author,link_flair_text,url,subreddit';

/** `**Label:** value`, wherever it appears in the body. */
const field = (body, label) => {
  const re = new RegExp(`\\*\\*${label}:?\\*\\*\\s*([^\\n·]+)`, 'i');
  const m = re.exec(body);
  return m
    ? m[1]
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[.·]+$/, '')
    : null;
};

const score100 = (v) => {
  const m = /^(\d+(?:\.\d+)?)\s*(?:\/\s*100)?$/.exec(String(v ?? '').trim());
  return m ? Number(m[1]) : null;
};

/** Markdown down to the prose a summary needs. */
export function plain(md) {
  return String(md ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/[*_`>|]/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The template fields out of a workflow post, and the section that says what
 * the workflow is for.
 *
 * @param {string} selftext
 */
export function parseWorkflow(selftext) {
  const body = String(selftext ?? '');
  const categories = (field(body, 'Categories') ?? '')
    .split(/[,;]/)
    .map((c) => c.trim())
    .filter(Boolean);

  const source = /\*\*Original source:?\*\*\s*\[[^\]]*\]\(([^)\s]+)\)/i.exec(body);
  const problem = /##\s*What problem this solves\s*\n+([\s\S]*?)(?:\n##\s|\n*$)/i.exec(body);

  return {
    value: score100(field(body, 'Workflow value')),
    freshness: score100(field(body, 'Freshness')),
    confidence: (() => {
      const n = Number(field(body, 'Confidence'));
      return Number.isFinite(n) ? n : null;
    })(),
    status: field(body, 'Status'),
    level: field(body, 'Level'),
    categories,
    originalSource: source ? source[1] : null,
    problem: problem ? plain(problem[1]).slice(0, 1200) : null,
  };
}

export function toItem(p) {
  const id = String(p?.id ?? '').trim();
  const rawTitle = String(p?.title ?? '').trim();
  if (!id || !rawTitle) return null;

  const sub = String(p.subreddit ?? 'ClaudeWorkflows');
  const parsed = parseWorkflow(p.selftext);
  // The library's own index posts, which are a map of the collection rather
  // than a workflow in it.
  const isIndex = /workflow library/i.test(rawTitle);
  const title = rawTitle.replace(/^\[Workflow\]\s*/i, '');
  const body = plain(p.selftext);

  return {
    externalId: `reddit:${id}`,
    kind: isIndex ? 'workflow-index' : 'workflow',
    title: title.slice(0, 300),
    summary: (parsed.problem || body).slice(0, 1200) || null,
    url: `https://www.reddit.com/r/${sub}/comments/${id}/`,
    publishedAt: p.created_utc ? new Date(p.created_utc * 1000).toISOString() : null,
    tags: [
      'workflow',
      'reddit',
      'claude',
      sub.toLowerCase(),
      isIndex ? 'index' : null,
      p.link_flair_text ? slugify(p.link_flair_text) : null,
      parsed.level ? slugify(parsed.level) : null,
      parsed.status ? slugify(parsed.status) : null,
      ...parsed.categories.map((c) => slugify(c)).filter(Boolean),
    ].filter(Boolean),
    data: {
      postId: id,
      subreddit: sub,
      author: p.author ?? null,
      flair: p.link_flair_text ?? null,
      // Votes are the library's rating of whether a workflow reproduces.
      score: Number(p.score) || 0,
      comments: Number(p.num_comments) || 0,
      ...parsed,
      body: body.slice(0, 4000) || null,
    },
  };
}

export const redditWorkflows = defineAdapter({
  name: 'reddit-workflows',
  title: 'Claude workflow library (Reddit)',
  collection: 'workflows',
  description:
    'r/ClaudeWorkflows, where each Claude and Claude Code workflow is published as its own post and voted on. The posts follow a template, so the rating, freshness, confidence, level and categories are stored as fields rather than prose. Read through the Arctic Shift archive, because Reddit itself blocks this deployment.',
  docs: 'https://www.reddit.com/r/ClaudeWorkflows/comments/1t5vxvq/claude_workflow_library_start_here/',
  kinds: ['workflow', 'workflow-index'],
  cadenceMinutes: 60,
  configFields: [
    {
      key: 'subreddits',
      label: 'Subreddits',
      type: 'list',
      help: 'Without the r/. Each is walked from where the last run stopped.',
      placeholder: 'ClaudeWorkflows',
    },
    { key: 'pagesPerRun', label: 'Pages per run', type: 'number', placeholder: '6' },
  ],
  defaults: { subreddits: ['ClaudeWorkflows'], pagesPerRun: 6 },
  defaultSources: [{ slug: 'reddit-claude-workflows', name: 'Claude workflow library' }],
  async pull({ config, cursor, http, log }) {
    const subs = (config.subreddits?.length ? config.subreddits : ['ClaudeWorkflows']).map((s) =>
      String(s)
        .replace(/^\/?r\//, '')
        .trim(),
    );
    const budget = Math.min(Math.max(Number(config.pagesPerRun) || 6, 1), 30);
    const after = { ...(cursor?.after ?? {}) };

    const items = [];
    const seen = new Set();

    for (const sub of subs) {
      let from = Number(after[sub]) || 0;
      for (let n = 0; n < budget; n++) {
        const params = new URLSearchParams({
          subreddit: sub,
          limit: '100',
          sort: 'asc',
          fields: FIELDS,
        });
        // `after` is exclusive, so the walk cannot stall on its own high water.
        if (from) params.set('after', String(from));
        const res = await http.json(`${SEARCH}?${params}`, { timeoutMs: 45_000 });
        const rows = Array.isArray(res?.data) ? res.data : [];
        if (!rows.length) break;

        for (const p of rows) {
          const item = toItem(p);
          if (!item || seen.has(item.externalId)) continue;
          seen.add(item.externalId);
          items.push(item);
          if (p.created_utc > from) from = p.created_utc;
        }
        if (rows.length < 100) break;
      }
      after[sub] = from;
    }

    log(`${items.length} posts from ${subs.join(', ')}`);
    return { items, cursor: { after }, note: `${items.length} workflow post(s)` };
  },
});
