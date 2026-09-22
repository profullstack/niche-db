import { defineAdapter, slugify } from '@nichedb/core/adapter';

/**
 * The Algorithms (github.com/TheAlgorithms): one implementation per row, for
 * the `algorithms` collection.
 *
 * The organisation keeps one repository per language, each MIT licensed, and
 * a bot maintains a `DIRECTORY.md` at the root of each: every implementation
 * as a markdown list under a `## Category` heading, nested one level deeper
 * where the language keeps subdirectories. That file is the whole catalogue,
 * so this source reads it and nothing else: no GitHub API, no token, no
 * clone. One raw fetch per repository per pass, from
 * raw.githubusercontent.com.
 *
 * The file's shape drifts between languages, and the parser accepts every
 * form seen on 2026-09-22:
 *
 *   - Python heads a section `## [Category](dir)`; C++, Java and TypeScript
 *     head it `## Category`; Rust heads everything `## src` and puts the real
 *     category one list level down. A `src`/`Src` heading is therefore not a
 *     category: the first unlinked list item under it is.
 *   - A link is relative (`backtracking/minimax.py`) in Python and absolute
 *     (`https://github.com/TheAlgorithms/C-Plus-Plus/blob/HEAD/backtracking/…`)
 *     elsewhere, with `HEAD` or `master` as the ref. Only the path after the
 *     ref matters; the row's URL is rebuilt on the branch that answered.
 *   - An unlinked list item is a subdirectory heading for the deeper items
 *     that follow it.
 *
 * Skipped on purpose: `Docs` (Sphinx configuration), `Tests` and anything
 * under a `test`/`tests` directory or named `*.test.*` (a test is not an
 * algorithm), and `Project Euler` (puzzle solutions, not algorithms: the
 * entries are `Sol1` under `Problem 001`, which says nothing without the
 * problem). A link that is not a file (no extension) is a directory and is
 * skipped too.
 *
 * The default branch is `master` for most repositories and `main` for
 * TypeScript, Zig and Julia; a repository is probed on master first and main
 * second, and the branch that answered is kept in the cursor so the next
 * pass asks once. Go and Lua publish no DIRECTORY.md at all; a 404 on both
 * branches is logged and the repository skipped, never thrown on, because
 * one missing file should not stop the other seventeen.
 *
 * The walk is one repository per batch, so at most one language's rows
 * (Python is about 1,300) are in memory at once, and the cursor after each
 * batch is the index of the next repository. A pass is every configured
 * repository; when it completes the source rests for a week, and the next
 * pass starts over, which is how a new implementation is picked up. The rows
 * are undated: the catalogue does not say when a file was added.
 */

export const RAW_HOST = 'https://raw.githubusercontent.com';
export const REPO_HOST = 'https://github.com/TheAlgorithms';
export const ORG = 'TheAlgorithms';
export const USER_AGENT = 'nichedb thealgorithms (https://nichedb.dev; hello@nichedb.dev)';

/** The repositories that have a DIRECTORY.md worth reading, in the order they are walked. */
export const DEFAULT_REPOS = [
  'Python',
  'C-Plus-Plus',
  'Java',
  'Rust',
  'JavaScript',
  'TypeScript',
  'C',
  'Zig',
  'Ruby',
  'Kotlin',
  'Swift',
  'Dart',
  'R',
  'Scala',
  'Haskell',
  'Elixir',
  'Julia',
  'PHP',
];

/** The branches tried, in order. The answering one is remembered per repository. */
export const BRANCHES = ['master', 'main'];

/** A pass is all repositories; then rest a week. */
export const CADENCE_MINUTES = 10_080;

/** Between runs of one pass. */
export const RUN_MINUTES = 10;

/** Pause between raw fetches; raw.githubusercontent.com is generous but not to be leaned on. */
export const PAUSE_MS = 500;

/** Section headings that are not categories of algorithms. */
export const SKIP_CATEGORIES = new Set(['docs', 'tests', 'test', 'project euler']);

/** Consecutive failures after which a run stops and keeps its place. */
const FAILURE_STOP = 3;

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/** The language a repository name stands for. */
export function languageOf(repo) {
  const r = String(repo ?? '');
  if (r === 'C-Plus-Plus') return 'C++';
  if (r === 'C-Sharp') return 'C#';
  if (r === 'F-Sharp') return 'F#';
  return r;
}

/** The raw URL of a repository's DIRECTORY.md on a branch. */
export const directoryUrl = (repo, branch) => `${RAW_HOST}/${ORG}/${repo}/${branch}/DIRECTORY.md`;

/** A file's page on GitHub, on the branch that answered. */
export const fileUrl = (repo, branch, path) => `${REPO_HOST}/${repo}/blob/${branch}/${path}`;

/**
 * The repository path a DIRECTORY.md link points at, or null when the link
 * is not a file inside the repository. Absolute links carry
 * `/blob/<ref>/<path>`; relative ones are the path.
 */
export function pathOf(href) {
  const h = String(href ?? '').trim();
  if (!h) return null;
  let path = h;
  if (/^https?:\/\//i.test(h)) {
    const m = h.match(/\/blob\/[^/]+\/(.+)$/);
    if (!m) return null;
    path = m[1];
  } else if (h.startsWith('#') || h.startsWith('/')) {
    return null;
  }
  path = path.replace(/^\.\//, '').replace(/[?#].*$/, '');
  try {
    path = decodeURIComponent(path);
  } catch {
    /* a bad escape stays as it is */
  }
  if (!path || path.endsWith('/')) return null;
  const last = path.split('/').pop();
  if (!/\.[A-Za-z0-9]+$/.test(last)) return null;
  return path;
}

/** Whether a path is a test file rather than an implementation. */
export function isTestPath(path) {
  const p = String(path ?? '').toLowerCase();
  return /(^|\/)(tests?|__tests__|spec)\//.test(p) || /\.(test|spec)\.[a-z0-9]+$/.test(p);
}

/** A heading's text with any markdown link wrapper removed. */
const headingText = (s) => {
  const m = String(s).match(/^\[([^\]]*)\]\([^)]*\)$/);
  return (m ? m[1] : String(s)).trim();
};

/**
 * Every implementation in a DIRECTORY.md.
 *
 * @param {string} markdown
 * @returns {{ name: string, path: string, category: string, subcategory: string|null }[]}
 */
export function parseDirectory(markdown) {
  const out = [];
  let heading = null;
  let headingIsCategory = false;
  const stack = []; // [{ indent, label }] of unlinked items above the current line
  for (const raw of String(markdown ?? '').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line) continue;
    const h = line.match(/^#{1,3}\s+(.+)$/);
    if (h) {
      if (line.startsWith('# ') && !line.startsWith('## ')) continue; // the file's title
      heading = headingText(h[1]);
      headingIsCategory = !/^src$/i.test(heading);
      stack.length = 0;
      continue;
    }
    const li = line.match(/^(\s*)[*+-]\s+(.*)$/);
    if (!li) continue;
    const indent = li[1].length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const link = li[2].match(/^\[([^\]]*)\]\(([^)\s]+)\)\s*$/);
    if (!link) {
      stack.push({ indent, label: li[2].trim() });
      continue;
    }
    const levels = stack.map((s) => s.label);
    const category = headingIsCategory ? heading : (levels.shift() ?? null);
    if (!category) continue;
    const subcategory = levels.length ? levels.join(' / ') : null;
    const path = pathOf(link[2]);
    if (!path) continue;
    out.push({ name: link[1].trim(), path, category, subcategory });
  }
  return out;
}

/** Whether an entry is one to keep. */
export function keep(entry) {
  if (!entry?.name || !entry?.path) return false;
  if (SKIP_CATEGORIES.has(String(entry.category).toLowerCase())) return false;
  if (entry.subcategory && /^tests?$/i.test(entry.subcategory)) return false;
  if (isTestPath(entry.path)) return false;
  return true;
}

/** An entry as an item. */
export function implementationItem(entry, repo, branch) {
  const language = languageOf(repo);
  return {
    externalId: `${repo}:${entry.path}`,
    kind: 'implementation',
    title: `${entry.name} (${language})`,
    summary: null,
    url: fileUrl(repo, branch, entry.path),
    tags: ['thealgorithms', slugify(language), slugify(entry.category)].filter(Boolean),
    data: {
      repo,
      language,
      category: entry.category,
      subcategory: entry.subcategory ?? null,
      path: entry.path,
      name: entry.name,
      license: 'MIT',
    },
  };
}

/** The configured repository list, cleaned. */
export function reposOf(config) {
  const raw = Array.isArray(config?.repos)
    ? config.repos
    : String(config?.repos ?? '')
        .split(',')
        .map((s) => s.trim());
  const seen = new Set();
  const out = [];
  for (const r of raw) {
    const name = String(r ?? '').trim();
    if (!/^[A-Za-z0-9._-]+$/.test(name) || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out.length ? out : DEFAULT_REPOS.slice();
}

/** Where the last run left off; a finished or unknown cursor starts a pass. */
export function resumeFrom(prev) {
  const c = prev && typeof prev === 'object' ? prev : {};
  const branches =
    c.branches && typeof c.branches === 'object' && !Array.isArray(c.branches) ? c.branches : {};
  const index = Number.isInteger(c.index) && c.index >= 0 && !c.done ? c.index : 0;
  return {
    index,
    branches: { ...branches },
    passStartedAt: index > 0 && c.passStartedAt ? c.passStartedAt : null,
  };
}

/**
 * Fetch a repository's DIRECTORY.md, trying the remembered branch first and
 * then the others. Returns { branch, markdown } or null when every branch 404s.
 * Any other failure throws, so the run counts it.
 */
export async function fetchDirectory(http, repo, remembered) {
  const order = [
    ...(remembered && BRANCHES.includes(remembered) ? [remembered] : []),
    ...BRANCHES.filter((b) => b !== remembered),
  ];
  for (const branch of order) {
    const res = await http.request(directoryUrl(repo, branch), {
      headers: { accept: 'text/plain, text/markdown, */*', 'user-agent': USER_AGENT },
      timeoutMs: 60_000,
    });
    if (res.status === 404) {
      await res.body?.cancel?.().catch?.(() => {});
      continue;
    }
    if (!res.ok) throw new Error(`${repo}/${branch}/DIRECTORY.md answered ${res.status}`);
    return { branch, markdown: await res.text() };
  }
  return null;
}

export const theAlgorithms = defineAdapter({
  name: 'thealgorithms',
  title: 'The Algorithms',
  collection: 'algorithms',
  description:
    'Every implementation in the TheAlgorithms repositories on GitHub, one row per file with its language, category and subdirectory, read from the DIRECTORY.md each repository keeps (MIT). One raw fetch per repository per pass, no API and no token; Docs, tests and Project Euler solutions are left out. A pass is all the repositories you list, then a week of rest.',
  docs: 'https://github.com/TheAlgorithms',
  kinds: ['implementation'],
  cadenceMinutes: RUN_MINUTES,
  configFields: [
    {
      key: 'repos',
      label: 'Repositories',
      type: 'list',
      required: true,
      placeholder: DEFAULT_REPOS.slice(0, 4).join(', '),
      help: 'Repository names under github.com/TheAlgorithms, comma separated. Each must have a DIRECTORY.md.',
    },
  ],
  defaults: { repos: DEFAULT_REPOS },
  defaultSources: [
    {
      slug: 'thealgorithms',
      name: 'The Algorithms: implementations by language',
      config: { repos: DEFAULT_REPOS },
    },
  ],
  async *pull({ config, cursor: prev, http, log, deadline }) {
    const repos = reposOf(config);
    const stopAt = Number.isFinite(deadline) ? deadline : Number.POSITIVE_INFINITY;
    const state = resumeFrom(prev);
    const branches = state.branches;
    const passStartedAt = state.passStartedAt ?? new Date().toISOString();
    let index = Math.min(state.index, repos.length);
    let requests = 0;
    let failures = 0;
    let streak = 0;
    let written = 0;
    let missing = 0;
    let batches = 0;

    const cursorAt = (i) => ({ index: i, branches, passStartedAt, done: false });
    const summary = () =>
      `${written} implementations in ${batches} batch${batches === 1 ? '' : 'es'}` +
      (missing ? `, ${missing} repositories without a DIRECTORY.md` : '') +
      (failures ? `, ${failures} requests failed` : '');

    while (index < repos.length) {
      if (Date.now() > stopAt) {
        return {
          cursor: cursorAt(index),
          note: `${summary()}; out of time before ${repos[index]}, resuming in ${RUN_MINUTES} min`,
          nextInMinutes: RUN_MINUTES,
        };
      }
      const repo = repos[index];
      if (requests > 0) await sleep(PAUSE_MS);
      requests += 1;
      let dir = null;
      try {
        dir = await fetchDirectory(http, repo, branches[repo]);
        streak = 0;
      } catch (err) {
        failures += 1;
        streak += 1;
        log(`${repo}: ${err?.message ?? err}`);
        if (streak >= FAILURE_STOP) {
          if (failures === requests) {
            throw new Error(`thealgorithms: every request failed (${requests}); see the log`);
          }
          return {
            cursor: cursorAt(index),
            note: `${summary()}; stopped at ${repo} after repeated failures`,
            nextInMinutes: RUN_MINUTES,
          };
        }
        continue; // the same repository again
      }
      index += 1;
      if (!dir) {
        missing += 1;
        log(`${repo}: no DIRECTORY.md on ${BRANCHES.join(' or ')}; skipped`);
        continue;
      }
      branches[repo] = dir.branch;
      const entries = parseDirectory(dir.markdown).filter(keep);
      const items = entries.map((e) => implementationItem(e, repo, dir.branch));
      written += items.length;
      batches += 1;
      log(`${repo} (${dir.branch}): ${items.length} implementations`);
      yield { items, cursor: cursorAt(index) };
    }

    return {
      cursor: {
        index: 0,
        branches,
        passStartedAt: null,
        done: true,
        walkedAt: new Date().toISOString(),
      },
      note: `${summary()}; pass complete over ${repos.length} repositories, next in a week`,
      nextInMinutes: CADENCE_MINUTES,
    };
  },
});
