import { defineAdapter, slugify } from '@nichedb/core/adapter';

/**
 * Rosetta Code: every programming task, for the `algorithms` collection.
 *
 * Rosetta Code (rosettacode.org) is a MediaWiki whose pages are tasks:
 * "sort an array with quicksort", "compute the Mandelbrot set", each stated
 * once and then solved in as many languages as people have contributed,
 * one `== Language ==` section per solution. There are about 1,355 tasks in
 * Category:Programming_Tasks and 424 more in Category:Draft_Programming_Tasks
 * (a draft is a task not yet promoted; it is read too and tagged `draft`).
 * The wiki's content is under the GNU Free Documentation License 1.3, which
 * a directory that links back and credits it can carry; each row says so.
 *
 * The API is the standard MediaWiki one at /w/api.php, keyless. A pass is:
 *
 *   1. `list=categorymembers` over each category, 500 titles a page with
 *      `cmcontinue` paging (three pages for the tasks, one for the drafts);
 *   2. per task, `action=parse&prop=sections|revid` for the section list,
 *      whose level-2 headings are the languages (the quicksort page has 226
 *      sections, 169 of them level 2, which is 168 distinct languages: a
 *      language heading can appear twice on a page, Hobbes does there, and
 *      the row keeps each language once), and `action=parse&prop=wikitext&
 *      section=0` for the lead, which holds the task statement and the
 *      page's templates: `{{task|Group}}` says which task group it belongs
 *      to, `[[Category:X]]` its categories and `{{Wikipedia|X}}` the article
 *      it was written from.
 *
 * Two small requests per task rather than the whole page: the quicksort
 * page's wikitext is 169 solutions long and asking for it 1,800 times a pass
 * would be most of a gigabyte for a heading list. A page whose lead is
 * `#REDIRECT [[X]]` is an alias and skipped.
 *
 * The walk is capped at `tasksPerRun` tasks a run (100, four hundred
 * milliseconds between requests: MediaWiki asks for serial, polite readers)
 * and resumes every ten minutes from a cursor that holds the phase (tasks
 * or drafts), the category page's continue token and the titles of that
 * page not yet read, so a pass takes about eighteen runs and three hours.
 * Batches of 25 items carry the cursor after them. When both categories are
 * exhausted the source rests a week and the next pass starts over, which is
 * how a new task or a new solution is picked up: the rows are undated
 * because the wiki dates revisions, not tasks.
 */

export const API = 'https://rosettacode.org/w/api.php';
export const WIKI = 'https://rosettacode.org/wiki/';
export const USER_AGENT = 'nichedb rosetta-code (https://nichedb.dev; hello@nichedb.dev)';
export const LICENSE = 'GFDL-1.3';

/** The two categories, in the order they are walked. */
export const CATEGORIES = {
  tasks: 'Category:Programming_Tasks',
  drafts: 'Category:Draft_Programming_Tasks',
};
export const PHASES = ['tasks', 'drafts'];

/** Titles per category page; 500 is the most the API gives a reader without a bot flag. */
export const PAGE_SIZE = 500;

/** Tasks per run, two requests each. */
export const TASKS_PER_RUN = 100;

/** Pause between requests. */
export const PAUSE_MS = 400;

/** Items per yielded batch. */
export const BATCH_SIZE = 25;

/** After a complete pass. */
export const CADENCE_MINUTES = 10_080;

/** Between runs of one pass. */
export const RUN_MINUTES = 10;

/** Languages kept on the row; the count is kept whole. */
export const LANGUAGES_KEPT = 300;

/** Consecutive failures after which a run stops and keeps its place. */
const FAILURE_STOP = 3;

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

// ── URLs ─────────────────────────────────────────────────────────────────────

const params = (o) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== null && v !== undefined) p.set(k, String(v));
  return p.toString();
};

/** A category page of titles. */
export const listUrl = (category, cmcontinue = null) =>
  `${API}?${params({
    action: 'query',
    list: 'categorymembers',
    cmtitle: category,
    cmnamespace: 0,
    cmlimit: PAGE_SIZE,
    cmcontinue,
    format: 'json',
  })}`;

/** A page's section list. */
export const sectionsUrl = (title) =>
  `${API}?${params({ action: 'parse', page: title, prop: 'sections|revid', format: 'json' })}`;

/** A page's lead wikitext. */
export const leadUrl = (title) =>
  `${API}?${params({
    action: 'parse',
    page: title,
    prop: 'wikitext|revid',
    section: 0,
    format: 'json',
  })}`;

/** The page on the wiki. Spaces are underscores; a slash or colon in a title stays readable. */
export const pageUrl = (title) =>
  WIKI +
  encodeURIComponent(String(title).replace(/ /g, '_')).replace(/%2F/g, '/').replace(/%3A/g, ':');

// ── Parsing ──────────────────────────────────────────────────────────────────

/** The titles on a category page and the token for the next one. */
export function parseMembers(body) {
  const members = (body?.query?.categorymembers ?? [])
    .map((m) => ({ pageid: Number(m?.pageid), title: String(m?.title ?? '').trim() }))
    .filter((m) => Number.isInteger(m.pageid) && m.pageid > 0 && m.title);
  const cmcontinue = body?.continue?.cmcontinue ?? null;
  return { members, cmcontinue: cmcontinue ? String(cmcontinue) : null };
}

const entities = (s) =>
  String(s)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));

/** The level-2 headings of a section list: one language each. */
export function languagesOf(body) {
  const out = [];
  const seen = new Set();
  for (const s of body?.parse?.sections ?? []) {
    if (String(s?.level) !== '2') continue;
    const name = entities(String(s?.line ?? '').replace(/<[^>]*>/g, '')).trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** Whether a lead says the page is an alias of another. */
export const isRedirect = (wikitext) => /^\s*#REDIRECT\b/i.test(String(wikitext ?? ''));

/** Templates removed, innermost first, so `{{a|{{b}}}}` goes whole. */
function dropTemplates(s) {
  let out = String(s);
  for (let i = 0; i < 10 && /\{\{[^{}]*\}\}/.test(out); i++) {
    out = out.replace(/\{\{[^{}]*\}\}/g, '');
  }
  return out;
}

/**
 * Wiki markup reduced to its text: templates gone, links to their label,
 * quotes and tags off, list markers off, pseudocode (indented lines) left
 * out, whitespace folded.
 */
export function stripWiki(wikitext) {
  let s = String(wikitext ?? '').replace(/\r/g, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(pre|syntaxhighlight|lang|code|math)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  s = dropTemplates(s);
  s = s.replace(/\[\[(?:Category|File|Image):[^\]]*\]\]/gi, '');
  s = s.replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1');
  s = s.replace(/\[\[([^\]]*)\]\]/g, '$1');
  s = s.replace(/\[https?:\/\/\S+\s+([^\]]*)\]/g, '$1');
  s = s.replace(/\[https?:\/\/\S+\]/g, '');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = entities(s);
  s = s.replace(/'{2,5}/g, '');
  const lines = [];
  for (const raw of s.split('\n')) {
    if (/^ /.test(raw)) continue; // pseudocode block
    let line = raw.replace(/^[:;*#]+\s*/, '').trim();
    if (/^task\s*:?$/i.test(line)) continue;
    line = line.replace(/^task\s*:\s*/i, '');
    if (line) lines.push(line);
  }
  return lines.join(' ').replace(/\s+/g, ' ').trim();
}

/** What the lead of a task page says about it. */
export function parseLead(wikitext) {
  const text = String(wikitext ?? '');
  const group = text.match(/\{\{\s*task\s*\|\s*([^}|]+?)\s*(?:\||\}\})/i)?.[1]?.trim() ?? null;
  const categories = [];
  for (const m of text.matchAll(/\[\[\s*Category\s*:\s*([^\]|]+?)\s*(?:\|[^\]]*)?\]\]/gi)) {
    const c = m[1].trim();
    if (c && !categories.includes(c)) categories.push(c);
  }
  const wikipedia =
    text.match(/\{\{\s*wikipedia\s*\|\s*([^}|]+?)\s*(?:\||\}\})/i)?.[1]?.trim() ?? null;
  return {
    redirect: isRedirect(text),
    group,
    categories,
    wikipedia,
    statement: stripWiki(text).slice(0, 1200) || null,
  };
}

/** A task as an item. */
export function taskItem({ pageid, title }, lead, languages, revid, draft) {
  const tags = ['rosetta-code'];
  if (lead.group) tags.push(slugify(lead.group));
  for (const c of lead.categories) tags.push(slugify(c));
  if (draft) tags.push('draft');
  return {
    externalId: String(pageid),
    kind: 'task',
    title: String(title),
    summary: lead.statement,
    url: pageUrl(title),
    tags: [...new Set(tags.filter(Boolean))],
    data: {
      pageId: pageid,
      revid: Number.isInteger(revid) ? revid : null,
      languages: languages.slice(0, LANGUAGES_KEPT),
      languageCount: languages.length,
      group: lead.group,
      categories: lead.categories,
      wikipedia: lead.wikipedia,
      draft: Boolean(draft),
      license: LICENSE,
    },
  };
}

// ── The walk ─────────────────────────────────────────────────────────────────

/** Where the last run left off; a finished or unknown cursor starts a pass. */
export function resumeFrom(prev) {
  const c = prev && typeof prev === 'object' ? prev : {};
  if (c.done || !PHASES.includes(c.phase)) {
    return { phase: 'tasks', cmcontinue: null, pending: [], passStartedAt: null };
  }
  const pending = Array.isArray(c.pending)
    ? c.pending
        .map((m) => ({ pageid: Number(m?.pageid), title: String(m?.title ?? '') }))
        .filter((m) => Number.isInteger(m.pageid) && m.title)
    : [];
  const cmcontinue = c.cmcontinue ? String(c.cmcontinue) : null;
  return {
    phase: c.phase,
    cmcontinue,
    pending,
    // Whether the category page in hand has been asked for. A cursor saved
    // after the last title of a category's last page has no pending and no
    // token, exactly like one saved before its first page; this says which.
    listed: typeof c.listed === 'boolean' ? c.listed : pending.length > 0 || cmcontinue !== null,
    passStartedAt: c.passStartedAt ?? null,
  };
}

export const rosettaCode = defineAdapter({
  name: 'rosetta-code',
  title: 'Rosetta Code',
  collection: 'algorithms',
  description:
    'Every programming task on Rosetta Code, one row each with the task statement, its group and categories, the Wikipedia article it came from and the list of languages it has been solved in (168 for quicksort). Drafts are included and tagged. Keyless MediaWiki API, two small requests per task; the content is GNU FDL 1.3 and every row says so. A pass is about three hours in ten-minute runs, then a week of rest.',
  docs: 'https://rosettacode.org/wiki/Rosetta_Code:API',
  kinds: ['task'],
  cadenceMinutes: RUN_MINUTES,
  configFields: [
    {
      key: 'tasksPerRun',
      label: 'Tasks per run',
      type: 'number',
      placeholder: String(TASKS_PER_RUN),
      help: 'Two requests each. The cursor keeps the place between runs.',
    },
    {
      key: 'pauseMs',
      label: 'Pause between requests (ms)',
      type: 'number',
      placeholder: String(PAUSE_MS),
    },
  ],
  defaults: { tasksPerRun: TASKS_PER_RUN, pauseMs: PAUSE_MS },
  defaultSources: [
    {
      slug: 'rosetta-code',
      name: 'Rosetta Code: programming tasks',
      config: { tasksPerRun: TASKS_PER_RUN, pauseMs: PAUSE_MS },
    },
  ],
  async *pull({ config, cursor: prev, http, log, deadline }) {
    const cap = Math.max(1, Math.floor(Number(config?.tasksPerRun)) || TASKS_PER_RUN);
    const pause =
      config?.pauseMs === 0 ? 0 : Math.max(0, Math.floor(Number(config?.pauseMs))) || PAUSE_MS;
    const stopAt = Number.isFinite(deadline) ? deadline : Number.POSITIVE_INFINITY;
    const state = resumeFrom(prev);
    const passStartedAt = state.passStartedAt ?? new Date().toISOString();
    let phase = state.phase;
    let cmcontinue = state.cmcontinue;
    let pending = state.pending;
    let listed = state.listed;
    let requests = 0;
    let failures = 0;
    let streak = 0;
    let read = 0;
    let written = 0;
    let skipped = 0;
    let batches = 0;
    let items = [];

    const headers = { accept: 'application/json', 'user-agent': USER_AGENT };
    const get = async (url) => {
      if (requests > 0) await sleep(pause);
      requests += 1;
      return http.json(url, { headers, timeoutMs: 60_000 });
    };
    const cursorAt = () => ({ phase, cmcontinue, pending, listed, passStartedAt, done: false });
    const summary = () =>
      `${written} tasks in ${batches} batch${batches === 1 ? '' : 'es'}` +
      (skipped ? `, ${skipped} redirects skipped` : '') +
      (failures ? `, ${failures} requests failed` : '');
    const failed = (what, err) => {
      failures += 1;
      streak += 1;
      log(`${what} failed (${err?.message ?? err})`);
      if (streak < FAILURE_STOP) return false;
      if (failures === requests) {
        throw new Error(`rosetta-code: every request failed (${requests}); see the log`);
      }
      return true;
    };

    while (phase !== 'done') {
      if (read >= cap || Date.now() > stopAt) {
        if (items.length) {
          batches += 1;
          yield { items, cursor: cursorAt() };
          items = [];
        }
        return {
          cursor: cursorAt(),
          note: `${summary()}; ${read >= cap ? 'at the run cap' : 'out of time'} in ${phase}, resuming in ${RUN_MINUTES} min`,
          nextInMinutes: RUN_MINUTES,
        };
      }

      // ── The next category page ─────────────────────────────────────────
      if (pending.length === 0) {
        if (listed && cmcontinue === null) {
          // This category is exhausted: on to the next, or the pass is over.
          const next = PHASES[PHASES.indexOf(phase) + 1];
          phase = next ?? 'done';
          cmcontinue = null;
          listed = false;
          continue;
        }
        let page;
        try {
          page = parseMembers(await get(listUrl(CATEGORIES[phase], cmcontinue)));
          streak = 0;
        } catch (err) {
          if (failed(`listing ${CATEGORIES[phase]}`, err)) break;
          continue;
        }
        pending = page.members;
        cmcontinue = page.cmcontinue;
        listed = true;
        log(`${phase}: ${pending.length} titles${cmcontinue ? ', more to come' : ''}`);
        continue;
      }

      // ── One task ───────────────────────────────────────────────────────
      const task = pending[0];
      let sections;
      let lead;
      try {
        sections = await get(sectionsUrl(task.title));
        lead = await get(leadUrl(task.title));
        streak = 0;
      } catch (err) {
        if (failed(`reading ${task.title}`, err)) break;
        continue; // the same task again
      }
      pending = pending.slice(1);
      read += 1;
      const parsed = parseLead(lead?.parse?.wikitext?.['*']);
      if (parsed.redirect) {
        skipped += 1;
        continue;
      }
      const revid = Number(lead?.parse?.revid ?? sections?.parse?.revid);
      items.push(taskItem(task, parsed, languagesOf(sections), revid, phase === 'drafts'));
      written += 1;
      if (items.length >= BATCH_SIZE) {
        batches += 1;
        yield { items, cursor: cursorAt() };
        items = [];
      }
    }

    if (items.length) {
      batches += 1;
      yield { items, cursor: cursorAt() };
      items = [];
    }

    if (phase !== 'done') {
      return {
        cursor: cursorAt(),
        note: `${summary()}; stopped in ${phase} after repeated failures`,
        nextInMinutes: RUN_MINUTES,
      };
    }
    return {
      cursor: {
        phase: 'tasks',
        cmcontinue: null,
        pending: [],
        passStartedAt: null,
        done: true,
        walkedAt: new Date().toISOString(),
      },
      note: `${summary()}; pass complete, next in a week`,
      nextInMinutes: CADENCE_MINUTES,
    };
  },
});
