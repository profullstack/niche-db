/**
 * Shared cleaning for the catalogue adapters: MCP servers and agent workflows.
 *
 * Both collections are assembled from lists other people maintain — awesome
 * lists, plugin marketplaces, registries, a subreddit — and the same server or
 * the same subagent is in five of them. That is the whole problem these
 * helpers exist for. Two of them:
 *
 *   * A URL is written a dozen ways. `https://github.com/Owner/Repo`,
 *     `.../owner/repo/`, `.../owner/repo.git`, `.../owner/repo/blob/main/src/x`
 *     and `.../owner/repo/tree/9f8c1ab/src/x` are between one and two distinct
 *     things, and telling which is the difference between one row and five.
 *     `repoUrl` decides: GitHub owner and repo are case insensitive so they are
 *     lowercased, `blob` and `tree` are the same page so both become `tree`,
 *     and any ref becomes `HEAD` so a pinned sha and `main` agree. What it will
 *     NOT do is drop the subpath, because `modelcontextprotocol/servers` holds
 *     seven different servers under `src/` and collapsing those to the repo
 *     root would fuse seven rows into one.
 *
 *   * A list entry is written for a human. Badge images, shields, a row of
 *     platform emoji and a bold title are all noise in a database, and a
 *     description that is half markdown links reads as punctuation soup in a
 *     feed. `cleanText` takes the prose out.
 *
 * The cross-source half of deduplication is not here: the core already drops an
 * item whose canonical URL another source in the collection has claimed, for
 * any collection with `dedupe_urls` set. These helpers exist so that the URLs
 * reaching it are comparable in the first place.
 */

/** Markdown images, including the shields and badges every awesome list wears. */
const IMAGE = /!\[[^\]]*\]\([^)\s]*(?:\s+"[^"]*")?\)/g;
/** A link whose text is now empty, which is what a badge leaves behind. */
const EMPTY_LINK = /\[\s*\]\([^)]*\)/g;
/** `[text](url)` -> `text`. */
const LINK = /\[([^\]]*)\]\([^)\s]*(?:\s+"[^"]*")?\)/g;
/*
 * Pictographs, dingbats, flags and the variation selectors that follow them.
 * Awesome-MCP-servers legends a server's language and platform in emoji
 * (🐍 ☁️ 🍎 🪟 🐧), which carries no meaning once the row has tags.
 */
const EMOJI =
  /(?:[\u{1F300}-\u{1FAFF}\u{2190}-\u{21FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{E0020}-\u{E007F}]|\u{FE0F}|\u{200D})/gu;

/**
 * The prose inside a markdown fragment.
 *
 * @param {string} md
 * @returns {string}
 */
export function cleanText(md) {
  return String(md ?? '')
    .replace(IMAGE, ' ')
    .replace(EMPTY_LINK, ' ')
    .replace(LINK, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[*_`]{1,3}/g, '')
    .replace(EMOJI, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Strip the separator an awesome list puts between an entry and its blurb. */
export function stripLeadIn(s) {
  return String(s ?? '')
    .replace(/^[\s:—–-]+/, '')
    .trim();
}

/**
 * One comparable URL for a thing that lives in a repository.
 *
 * Relative links are resolved against `base` (the official servers README
 * links its own reference servers as `src/git`), everything that is not http
 * is dropped, and GitHub URLs are folded as described at the top of this file.
 *
 * @param {string} raw
 * @param {{ base?: string }} [opts]
 * @returns {string|null}
 */
export function repoUrl(raw, { base } = {}) {
  const s = String(raw ?? '').trim();
  if (!s || s.startsWith('#')) return null;

  let u;
  try {
    u = new URL(s, base);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

  u.hash = '';
  const host = u.hostname.toLowerCase().replace(/^www\./, '');

  if (host !== 'github.com') {
    u.protocol = 'https:';
    const path = u.pathname.replace(/\/+$/, '');
    return `https://${host}${path}${u.search}`;
  }

  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0].toLowerCase();
  const repo = parts[1].toLowerCase().replace(/\.git$/, '');
  if (!owner || !repo) return null;

  // `/tree/<ref>/<subpath>` and `/blob/<ref>/<subpath>` address the same page.
  // The ref is where a pinned sha and `main` disagree about nothing, so it goes.
  const kind = parts[2];
  if ((kind === 'tree' || kind === 'blob') && parts.length > 4) {
    const subpath = parts.slice(4).join('/');
    return `https://github.com/${owner}/${repo}/tree/HEAD/${subpath}`;
  }
  return `https://github.com/${owner}/${repo}`;
}

/** `owner/repo` for a github.com URL, or null. */
export function repoSlug(url) {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)/.exec(String(url ?? ''));
  return m ? `${m[1]}/${m[2]}` : null;
}

const isSkipped = (section, patterns) => {
  const s = section.toLowerCase();
  return patterns.some((p) => s.includes(p));
};

/**
 * The entries of a markdown list, whichever dialect the list is written in.
 *
 * The four MCP lists this reads write the same row four ways:
 *
 *   - [owner/repo](url) [![badge](img)](url) 🐍 ☁️ - what it does
 *   - **[Title](url)** - what it does
 *   - [Title](url) - what it does
 *   - **[Git](src/git)** - what it does          (relative, official repo)
 *
 * so the parse is deliberately loose: the first non-image link on the line is
 * the thing, whatever is left after it is the blurb, and the nearest headings
 * above it are what it is about. A line whose first link is an anchor is a
 * table of contents entry and is skipped, as is anything under a heading the
 * caller says is not what this collection collects (clients, frameworks,
 * tutorials — a list of MCP servers is half not servers).
 *
 * @param {string} md
 * @param {{ base?: string, skipSections?: string[] }} [opts]
 * @returns {{ title: string, url: string, description: string, section: string,
 *             subsection: string|null }[]}
 */
export function parseMarkdownList(md, { base, skipSections = [] } = {}) {
  const out = [];
  let section = '';
  let subsection = null;
  let inFence = false;

  for (const line of String(md ?? '').split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const text = cleanText(heading[2]);
      if (heading[1].length <= 2) {
        section = text;
        subsection = null;
      } else {
        subsection = text || null;
      }
      continue;
    }

    const bullet = /^\s{0,4}[-*+]\s+(.*)$/.exec(line);
    if (!bullet) continue;
    if (section && isSkipped(section, skipSections)) continue;

    const body = bullet[1].replace(IMAGE, ' ');
    const link = /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(body);
    if (!link) continue;

    const url = repoUrl(link[2], { base });
    if (!url) continue;
    const title = cleanText(link[1]);
    if (!title || title.length > 200) continue;

    const rest = body.slice(link.index + link[0].length);
    out.push({
      title,
      url,
      description: cleanText(stripLeadIn(cleanText(rest))),
      section,
      subsection,
    });
  }
  return out;
}
