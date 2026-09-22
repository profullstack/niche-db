import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

import {
  BATCH_SIZE,
  CADENCE_MINUTES,
  CATEGORIES,
  isRedirect,
  languagesOf,
  leadUrl,
  listUrl,
  pageUrl,
  parseLead,
  parseMembers,
  RUN_MINUTES,
  resumeFrom,
  rosettaCode,
  sectionsUrl,
  stripWiki,
  taskItem,
  USER_AGENT,
} from '../packages/adapters/src/rosetta-code.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

const fixture = async (name) =>
  JSON.parse(
    await readFile(new URL(`../packages/adapters/test/fixtures/${name}`, import.meta.url), 'utf8'),
  );

const page0 = await fixture('rosetta-tasks-page-0.json');
const sections = await fixture('rosetta-quicksort-sections.json');
const lead = await fixture('rosetta-quicksort-section0.json');

const leadText = lead.parse.wikitext['*'];

describe('rosetta-code parsing', () => {
  test('a category page gives titles and the continue token', () => {
    const { members, cmcontinue } = parseMembers(page0);
    expect(members.length).toBe(500);
    expect(members[0]).toEqual({ pageid: 564, title: '100 doors' });
    expect(cmcontinue).toMatch(/^page\|/);
    expect(parseMembers({ query: { categorymembers: [] } })).toEqual({
      members: [],
      cmcontinue: null,
    });
  });

  test('the level-2 headings are the languages: 169 sections, 168 languages for quicksort', () => {
    // Hobbes heads two sections on the page; a language is listed once.
    expect(sections.parse.sections.filter((s) => s.level === '2').length).toBe(169);
    const langs = languagesOf(sections);
    expect(langs.length).toBe(168);
    expect(langs[0]).toBe('11l');
    expect(langs).toContain('Python');
    expect(langs.filter((l) => l === 'Hobbes').length).toBe(1);
  });

  test('the lead gives group, categories, wikipedia and a readable statement', () => {
    const p = parseLead(leadText);
    expect(p.redirect).toBe(false);
    expect(p.group).toBe('Sorting Algorithms');
    expect(p.categories).toEqual(['Sorting', 'Recursion']);
    expect(p.wikipedia).toBe('Quicksort');
    expect(
      p.statement.startsWith('Sort an array (or list) elements using the quicksort algorithm.'),
    ).toBe(true);
    expect(p.statement).not.toContain('{{');
    expect(p.statement).not.toContain('[[');
    expect(p.statement).not.toContain('&nbsp;');
    expect(p.statement).not.toContain("''");
    expect(p.statement).not.toContain('<big>');
    expect(p.statement.length).toBeLessThanOrEqual(1200);
  });

  test('stripWiki leaves out pseudocode, list markers and nested templates', () => {
    const s = stripWiki(
      "{{task|X}}\n{{a|{{b}}}}\n;Task:\n::# &nbsp; Choose a '''pivot'''.\n 'function' code line\n[https://x.org/y ''label''] and [[O|big O]] and [[Plain]]",
    );
    expect(s).toBe('Choose a pivot. label and big O and Plain');
  });

  test('a redirect is recognised', () => {
    expect(isRedirect('#REDIRECT [[Sorting algorithms/Quicksort]]')).toBe(true);
    expect(isRedirect(leadText)).toBe(false);
    expect(parseLead('#REDIRECT [[X]]').redirect).toBe(true);
  });

  test('urls keep a slash readable and identify the reader', () => {
    expect(pageUrl('Sorting algorithms/Quicksort')).toBe(
      'https://rosettacode.org/wiki/Sorting_algorithms/Quicksort',
    );
    expect(pageUrl('100 doors')).toBe('https://rosettacode.org/wiki/100_doors');
    expect(listUrl(CATEGORIES.tasks)).toContain('cmlimit=500');
    expect(listUrl(CATEGORIES.tasks, 'page|x')).toContain('cmcontinue=page%7Cx');
    expect(sectionsUrl('A/B')).toContain('prop=sections%7Crevid');
    expect(leadUrl('A/B')).toContain('section=0');
    expect(USER_AGENT).toContain('nichedb');
  });

  test('a task item passes normalisation and carries the licence', () => {
    const item = taskItem(
      { pageid: 3576, title: 'Sorting algorithms/Quicksort' },
      parseLead(leadText),
      languagesOf(sections),
      411583,
      false,
    );
    expect(item.externalId).toBe('3576');
    expect(item.kind).toBe('task');
    expect(item.tags).toEqual(['rosetta-code', 'sorting-algorithms', 'sorting', 'recursion']);
    expect(item.data.languageCount).toBe(168);
    expect(item.data.license).toBe('GFDL-1.3');
    expect(item.data.wikipedia).toBe('Quicksort');
    expect(item.data.revid).toBe(411583);
    expect(item.publishedAt).toBeUndefined();
    const n = normaliseItem(item);
    expect(n).not.toBeNull();
    expect(n.publishedAt).toBeNull();
    const draft = taskItem({ pageid: 1, title: 'X' }, parseLead('hello'), [], null, true);
    expect(draft.tags).toContain('draft');
    expect(draft.data.draft).toBe(true);
  });

  test('resumeFrom starts over on a finished or foreign cursor and keeps a live one', () => {
    expect(resumeFrom(null).phase).toBe('tasks');
    expect(resumeFrom({ phase: 'drafts', done: true }).phase).toBe('tasks');
    const live = resumeFrom({
      phase: 'drafts',
      cmcontinue: null,
      pending: [{ pageid: 5, title: 'Five' }],
      passStartedAt: 't',
    });
    expect(live).toMatchObject({ phase: 'drafts', listed: true, passStartedAt: 't' });
    // The last title of the last page was read: no pending, no token, but listed.
    expect(resumeFrom({ phase: 'tasks', cmcontinue: null, pending: [], listed: true }).listed).toBe(
      true,
    );
    expect(resumeFrom({ phase: 'tasks', cmcontinue: null, pending: [] }).listed).toBe(false);
  });
});

/**
 * A fake wiki: the tasks category has `taskTitles` on one page (plus a second,
 * empty page when `twoPages`), the drafts category has `draftTitles`; every
 * page parses like quicksort except the ones in `redirects`.
 */
function wiki({
  taskTitles,
  draftTitles = [],
  redirects = [],
  twoPages = false,
  fail = () => false,
}) {
  const urls = [];
  const members = (titles, from) => titles.map((title, i) => ({ pageid: from + i, ns: 0, title }));
  const http = {
    async json(url, opts) {
      urls.push(url);
      expect(opts.headers['user-agent']).toBe(USER_AGENT);
      const u = new URL(url);
      const p = u.searchParams;
      if (fail(url)) throw new Error('boom');
      if (p.get('list') === 'categorymembers') {
        const cat = p.get('cmtitle');
        const cont = p.get('cmcontinue');
        if (cat === CATEGORIES.tasks) {
          if (cont === 'page|2') return { query: { categorymembers: [] } };
          return {
            ...(twoPages ? { continue: { cmcontinue: 'page|2', continue: '-||' } } : {}),
            query: { categorymembers: members(taskTitles, 100) },
          };
        }
        return { query: { categorymembers: members(draftTitles, 900) } };
      }
      const title = p.get('page');
      if (p.get('prop') === 'sections|revid') return sections;
      if (redirects.includes(title)) {
        return { parse: { title, pageid: 1, revid: 7, wikitext: { '*': '#REDIRECT [[Other]]' } } };
      }
      return lead;
    },
  };
  return { http, urls };
}

async function run(http, cursor, config = {}, deadline = Date.now() + 60_000) {
  const batches = [];
  const gen = rosettaCode.pull({
    config: { tasksPerRun: 100, pauseMs: 0, ...config },
    cursor,
    http,
    log: () => {},
    deadline,
  });
  for (;;) {
    const { value, done } = await gen.next();
    if (done) return { batches, outcome: value };
    batches.push(value);
  }
}

describe('rosetta-code pull', () => {
  afterEach(() => setSystemTime());

  test('a whole pass: tasks then drafts, redirects skipped, batches carry the cursor, then a week', async () => {
    const taskTitles = Array.from({ length: 30 }, (_, i) => `Task ${i}`);
    const { http, urls } = wiki({
      taskTitles,
      draftTitles: ['Draft A', 'Draft B'],
      redirects: ['Task 3'],
      twoPages: true,
    });
    const { batches, outcome } = await run(http, null);
    const items = batches.flatMap((b) => b.items);
    expect(items.length).toBe(31);
    expect(batches[0].items.length).toBe(BATCH_SIZE);
    expect(batches[0].cursor).toMatchObject({ phase: 'tasks', done: false, listed: true });
    // 26 titles were read for the first 25 items: Task 3 is a redirect.
    expect(batches[0].cursor.pending.length).toBe(30 - BATCH_SIZE - 1);
    expect(items.map((i) => i.title)).not.toContain('Task 3');
    const drafts = items.filter((i) => i.data.draft);
    expect(drafts.map((i) => i.title)).toEqual(['Draft A', 'Draft B']);
    expect(drafts[0].tags).toContain('draft');
    expect(items.every((i) => normaliseItem(i) !== null)).toBe(true);
    expect(outcome.nextInMinutes).toBe(CADENCE_MINUTES);
    expect(outcome.cursor).toMatchObject({ phase: 'tasks', done: true, pending: [] });
    expect(outcome.note).toContain('1 redirects skipped');
    // Three list requests (two task pages, one drafts page) and two per title.
    const lists = urls.filter((u) => u.includes('categorymembers'));
    expect(lists.length).toBe(3);
    expect(urls.length).toBe(3 + 2 * 32);
  });

  test('the run cap stops a pass and the cursor resumes it without relisting', async () => {
    const taskTitles = Array.from({ length: 8 }, (_, i) => `Task ${i}`);
    const { http, urls } = wiki({ taskTitles, draftTitles: ['Draft A'] });
    const first = await run(http, null, { tasksPerRun: 5 });
    expect(first.batches.flatMap((b) => b.items).length).toBe(5);
    expect(first.outcome.nextInMinutes).toBe(RUN_MINUTES);
    expect(first.outcome.note).toContain('at the run cap');
    expect(first.outcome.cursor.pending.map((m) => m.title)).toEqual([
      'Task 5',
      'Task 6',
      'Task 7',
    ]);
    const before = urls.length;
    const second = await run(http, first.outcome.cursor, { tasksPerRun: 5 });
    const titles = second.batches.flatMap((b) => b.items).map((i) => i.title);
    expect(titles).toEqual(['Task 5', 'Task 6', 'Task 7', 'Draft A']);
    expect(second.outcome.nextInMinutes).toBe(CADENCE_MINUTES);
    // One list request in the second run: the drafts. The tasks page was not asked again.
    const lists = urls.slice(before).filter((u) => u.includes('categorymembers'));
    expect(lists.length).toBe(1);
    expect(lists[0]).toContain('Draft_Programming_Tasks');
    // A cursor saved between the last task and the drafts list must not relist the tasks.
    const between = {
      phase: 'tasks',
      cmcontinue: null,
      pending: [],
      listed: true,
      passStartedAt: 't',
    };
    const third = await run(wiki({ taskTitles, draftTitles: ['Draft Z'] }).http, between);
    expect(third.batches.flatMap((b) => b.items).map((i) => i.title)).toEqual(['Draft Z']);
  });

  test('repeated failures stop the run and keep the place; total failure throws', async () => {
    const taskTitles = ['Task 0', 'Task 1', 'Task 2'];
    let calls = 0;
    const { http } = wiki({
      taskTitles,
      fail: (u) => u.includes('page=Task+1') && ++calls > 0,
    });
    const { batches, outcome } = await run(http, null);
    expect(batches.flatMap((b) => b.items).map((i) => i.title)).toEqual(['Task 0']);
    expect(outcome.nextInMinutes).toBe(RUN_MINUTES);
    expect(outcome.note).toContain('repeated failures');
    expect(outcome.cursor.pending[0].title).toBe('Task 1');

    const dead = wiki({ taskTitles, fail: () => true });
    await expect(run(dead.http, null)).rejects.toThrow(/every request failed/);
  });

  test('the deadline ends a run with a partial batch and the place kept', async () => {
    const taskTitles = Array.from({ length: 6 }, (_, i) => `Task ${i}`);
    const { http } = wiki({ taskTitles });
    // Each request moves the clock 300 ms; the deadline is a second away, so
    // the list and two tasks fit and the third does not.
    setSystemTime(new Date('2026-09-22T12:00:00Z'));
    const deadline = Date.now() + 1000;
    const { batches, outcome } = await run(
      {
        json: async (...a) => {
          setSystemTime(new Date(Date.now() + 300));
          return http.json(...a);
        },
      },
      null,
      {},
      deadline,
    );
    expect(outcome.nextInMinutes).toBe(RUN_MINUTES);
    expect(outcome.note).toContain('out of time');
    expect(batches.flatMap((b) => b.items).map((i) => i.title)).toEqual(['Task 0', 'Task 1']);
    expect(outcome.cursor.pending.map((m) => m.title)).toEqual([
      'Task 2',
      'Task 3',
      'Task 4',
      'Task 5',
    ]);
  });
});
