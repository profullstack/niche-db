import { decodeEntities, defineAdapter, slugify, stripHtml } from '@nichedb/core/adapter';

/**
 * NIST's Dictionary of Algorithms and Data Structures, for the `algorithms`
 * collection.
 *
 * DADS (xlinux.nist.gov/dads) is the reference dictionary of algorithms, data
 * structures, algorithmic techniques, classic problems and the definitions
 * they lean on: about 1,120 pages, 1,290 names (a page can carry several, so
 * "three-way radix quicksort" and "multikey Quicksort" are one page), edited
 * by Paul Black at NIST since 1998. It is a work of the United States
 * government and public domain, which makes it the one algorithm dictionary a
 * public directory can carry whole, with the definitions.
 *
 * Every page has the same shape, hand-written HTML from the late nineties: an
 * `<h1>` with the name, a one-line type in parentheses ("(algorithm)", "(data
 * structure)", "(definition)", "(classic problem)", "(algorithmic technique)"),
 * a `Definition:` paragraph, then the relations the dictionary is built on,
 * each a paragraph headed with a `<strong>`: Generalization (I am a kind of),
 * Specialization (is a kind of me), Aggregate parent (I am a part of or used
 * in), Aggregate child (is a part of or used in me), See also, and Also known
 * as. A `Note:` in `<em>` follows, then the author's initials and, on many
 * pages, an `Implementation` heading with links to code. Every relation is a
 * link to another page, so the rows keep the linked page's file name beside
 * its text and the dictionary's graph survives in the data.
 *
 * The index is termsArea.html: the names grouped under area headings
 * (Sorting and Searching, Graphs, ...), each with a letter for its type
 * (A algorithm, D definition, P classic problem, S data structure,
 * T algorithmic technique). The area becomes a tag and the letter is the
 * fallback kind when a page has no type line.
 *
 * There is no API, no bulk file and no dates: the dictionary is undated, so
 * rows carry no publishedAt. A pass reads the index, then every page in
 * order, `pagesPerRun` a run with a pause between, resuming from the cursor's
 * index; the index is re-read each run so a page added upstream joins the
 * walk. After a whole pass the next run waits a month; the dictionary changes
 * a few entries a year.
 */

export const BASE = 'https://xlinux.nist.gov/dads/';
export const TERMS_URL = `${BASE}termsArea.html`;
export const USER_AGENT = 'nichedb nist-dads (https://nichedb.dev; hello@nichedb.dev)';

/** Pages per run; a pass of about 1,120 pages is eight runs. */
export const PAGES_PER_RUN = 150;

/** Pause between page fetches. NIST publishes no rate; four a second is polite for static HTML. */
export const PAUSE_MS = 250;

/** How long the next run waits after a whole pass: a month, the dictionary changes slowly. */
export const CADENCE_MINUTES = 43_200;

/** Items per yielded batch. */
export const BATCH = 25;

/** Consecutive failures after which a run stops, keeping its place. */
const FAILURE_STOP = 3;

export const PROVIDER = 'nist-dads';
export const ATTRIBUTION = 'NIST Dictionary of Algorithms and Data Structures';

/** The index letter to a kind, and the page's own type line to a kind. */
export const KIND_BY_FLAG = {
  A: 'algorithm',
  D: 'definition',
  P: 'problem',
  S: 'data-structure',
  T: 'technique',
};
export const KIND_BY_TYPE = {
  algorithm: 'algorithm',
  'data structure': 'data-structure',
  definition: 'definition',
  'classic problem': 'problem',
  'algorithmic technique': 'technique',
};

/** The relation headings on a page, to the key they are stored under. */
export const RELATIONS = {
  Generalization: 'generalizations',
  Specialization: 'specializations',
  'Aggregate parent': 'partOf',
  'Aggregate child': 'uses',
  'See also': 'seeAlso',
  'Also known as': 'aka',
};

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

const whole = (v, fallback) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const clean = (s) =>
  decodeEntities(stripHtml(String(s ?? '')))
    .replace(/\s+/g, ' ')
    .trim();

/** The page URL for a file name out of the index. */
export const pageUrl = (file) => `${BASE}HTML/${file}`;

/**
 * The index: one entry per page, in index order, with every name that points
 * at it, its area and its type letter. A name is listed once per area it
 * belongs to; the first area wins and the rest are kept as `areas`.
 * @returns {{ file: string, name: string, names: string[], area: string|null, areas: string[], flag: string|null }[]}
 */
export function parseTermsArea(html) {
  const byFile = new Map();
  let area = null;
  const re =
    /<h2>\s*<a name="[^"]*">([^<]*)<\/a>\s*<\/h2>|<li>\s*<a href="HTML\/([^"]+\.html)">([^<]*)<\/a>\s*(?:\[<strong>([A-Z])<\/strong>\])?/g;
  for (const m of String(html ?? '').matchAll(re)) {
    if (m[1] !== undefined) {
      area = clean(m[1]) || null;
      continue;
    }
    const file = m[2];
    const name = clean(m[3]);
    if (!file || !name) continue;
    let entry = byFile.get(file);
    if (!entry) {
      entry = { file, name, names: [], area, areas: [], flag: m[4] ?? null };
      byFile.set(file, entry);
    }
    if (!entry.names.includes(name)) entry.names.push(name);
    if (area && !entry.areas.includes(area)) entry.areas.push(area);
    if (!entry.flag && m[4]) entry.flag = m[4];
  }
  return [...byFile.values()];
}

/** `[{ name, file }]` out of the links in one relation paragraph. */
function links(fragment) {
  const out = [];
  for (const m of String(fragment).matchAll(/<a href="([^"]+?)\.html"[^>]*>(.*?)<\/a>/gs)) {
    const name = clean(m[2]);
    if (!name) continue;
    out.push({ name, file: `${m[1]}.html` });
  }
  return out;
}

/**
 * One page. Returns null when the HTML has no `<h1>`, which is what a 404
 * page or an index page looks like.
 */
export function parseTermPage(html) {
  const src = String(html ?? '');
  const h1 = src.match(/<h1>(.*?)<\/h1>/s);
  if (!h1) return null;
  const title = clean(h1[1]);
  const body = src.slice(h1.index + h1[0].length);
  const type =
    body
      .match(/^\s*<p>\s*\(([^)]*)\)\s*<\/p>/)?.[1]
      ?.trim()
      .toLowerCase() ?? null;
  const out = {
    title,
    type,
    definition: null,
    note: null,
    author: null,
    implementations: [],
    moreInformation: [],
  };
  for (const key of Object.values(RELATIONS)) out[key] = [];

  const main = body.split(/<h2>|<hr>/i)[0];
  for (const m of main.matchAll(/<p>(.*?)<\/p>/gs)) {
    const para = m[1];
    const head = para.match(/^\s*<strong>([^<]*?):?<\/strong>/);
    if (head) {
      const label = clean(head[1]);
      if (label === 'Definition') {
        out.definition = clean(para.slice(head[0].length)) || null;
      } else if (RELATIONS[label]) {
        out[RELATIONS[label]] = links(para.slice(head[0].length));
      }
      continue;
    }
    if (/^\s*Author:/.test(clean(para))) {
      out.author = clean(para).replace(/^Author:\s*/, '') || null;
    }
  }
  /*
   * The note is one <em> that opens after "Note:" and closes paragraphs later,
   * so it is cut from the first "Note:" to the author line rather than read
   * out of one paragraph.
   */
  const note = main.match(/<em>\s*Note:([\s\S]*?)(?=<p>\s*Author:|<h2>|$)/);
  if (note) out.note = clean(note[1]).slice(0, 2000) || null;

  const section = (name) => {
    const m = body.match(new RegExp(`<h2>${name}</h2>([\\s\\S]*?)(?=<h2>|<hr>)`, 'i'));
    if (!m) return [];
    const out = [];
    for (const a of m[1].matchAll(/<a href="([^"]+)"[^>]*>(.*?)<\/a>/gs)) {
      const label = clean(a[2]);
      if (!/^https?:/.test(a[1]) || !label) continue;
      out.push({ label, url: a[1] });
    }
    return out;
  };
  out.implementations = section('Implementation');
  out.moreInformation = section('More information');
  return out;
}

/** The kind for a page: its own type line first, the index letter second. */
export function kindOf(page, entry) {
  return (
    KIND_BY_TYPE[page?.type ?? ''] ??
    KIND_BY_FLAG[entry?.flag ?? ''] ??
    (page?.type ? slugify(page.type) : 'definition')
  );
}

/** An item out of a parsed page and its index entry. */
export function termItem(page, entry) {
  const kind = kindOf(page, entry);
  const title = page.title || entry.name;
  const aliases = entry.names.filter((n) => n.toLowerCase() !== title.toLowerCase());
  const externalId = entry.file.replace(/\.html$/, '');
  return {
    externalId,
    kind,
    title,
    summary: page.definition ?? null,
    url: pageUrl(entry.file),
    publishedAt: null,
    tags: ['nist', 'dads', kind, ...entry.areas.map(slugify)].filter(Boolean),
    data: {
      type: page.type,
      area: entry.area,
      areas: entry.areas,
      aliases,
      generalizations: page.generalizations,
      specializations: page.specializations,
      partOf: page.partOf,
      uses: page.uses,
      seeAlso: page.seeAlso,
      aka: page.aka,
      note: page.note,
      author: page.author,
      implementations: page.implementations,
      moreInformation: page.moreInformation,
      provider: PROVIDER,
      attribution: ATTRIBUTION,
      license: 'public domain (US government work)',
    },
  };
}

/** Where a run starts: the index into the term list, 0 for a fresh pass. */
export function resumeFrom(prev) {
  const index = Math.floor(Number(prev?.index));
  return {
    index: Number.isFinite(index) && index >= 0 ? index : 0,
    startedAt: typeof prev?.startedAt === 'string' ? prev.startedAt : null,
    passes: Math.max(0, Math.floor(Number(prev?.passes)) || 0),
  };
}

export const nistDads = defineAdapter({
  name: 'nist-dads',
  title: 'NIST Dictionary of Algorithms and Data Structures',
  collection: 'algorithms',
  description:
    "Every entry in NIST's Dictionary of Algorithms and Data Structures: about 1,120 algorithms, data structures, techniques, classic problems and definitions, each with its definition, the relations the dictionary is built on (generalizations, specializations, what it is part of, what it uses, see also, other names), the editorial note, and links to implementations. Public domain. Read page by page from the index; a pass takes a few runs and repeats monthly.",
  docs: 'https://xlinux.nist.gov/dads/',
  kinds: ['algorithm', 'data-structure', 'technique', 'problem', 'definition'],
  cadenceMinutes: 10,
  configFields: [
    {
      key: 'pagesPerRun',
      label: 'Pages per run',
      type: 'number',
      placeholder: String(PAGES_PER_RUN),
      help: 'The walk stops here and picks up ten minutes later.',
    },
    {
      key: 'pauseMs',
      label: 'Pause between pages (ms)',
      type: 'number',
      placeholder: String(PAUSE_MS),
    },
  ],
  defaults: { pagesPerRun: PAGES_PER_RUN, pauseMs: PAUSE_MS },
  defaultSources: [
    {
      slug: 'nist-dads',
      name: 'NIST: Dictionary of Algorithms and Data Structures',
      config: { pagesPerRun: PAGES_PER_RUN, pauseMs: PAUSE_MS },
    },
  ],
  async *pull({ config, cursor: prev, http, log, deadline }) {
    const perRun = whole(config?.pagesPerRun, PAGES_PER_RUN);
    const pause =
      config?.pauseMs === 0 ? 0 : Math.max(0, Math.floor(Number(config?.pauseMs))) || PAUSE_MS;
    const stopAt = Number.isFinite(deadline) ? deadline : Number.POSITIVE_INFINITY;
    const headers = { 'user-agent': USER_AGENT, accept: 'text/html' };

    const terms = parseTermsArea(await http.text(TERMS_URL, { headers, timeoutMs: 30_000 }));
    if (terms.length === 0) throw new Error('the DADS index listed no terms');

    const state = resumeFrom(prev);
    let index = state.index < terms.length ? state.index : 0;
    const startedAt = index === 0 || !state.startedAt ? new Date().toISOString() : state.startedAt;
    const cursorAt = (i) => ({ index: i, total: terms.length, startedAt, passes: state.passes });

    let batch = [];
    let fetched = 0;
    let written = 0;
    let failures = 0;
    let streak = 0;
    let stopped = null;
    while (index < terms.length) {
      if (fetched >= perRun) {
        stopped = 'cap';
        break;
      }
      if (Date.now() > stopAt) {
        stopped = 'deadline';
        break;
      }
      const entry = terms[index];
      if (fetched > 0) await sleep(pause);
      fetched += 1;
      try {
        const page = parseTermPage(await http.text(pageUrl(entry.file), { headers }));
        if (!page) throw new Error('no entry on the page');
        batch.push(termItem(page, entry));
        written += 1;
        streak = 0;
      } catch (err) {
        failures += 1;
        streak += 1;
        log(`${entry.file}: ${err?.message ?? err}`);
        if (streak >= FAILURE_STOP) {
          stopped = 'errors';
          break;
        }
      }
      index += 1;
      if (batch.length >= BATCH) {
        yield { items: batch, cursor: cursorAt(index) };
        batch = [];
      }
    }
    const done = index >= terms.length && stopped !== 'errors';
    if (batch.length > 0) yield { items: batch, cursor: cursorAt(index) };

    const place = `${Math.min(index, terms.length)} of ${terms.length}`;
    if (done) {
      log(`pass complete: ${written} entries this run, ${failures} failed`);
      return {
        cursor: { index: 0, passes: state.passes + 1, lastPassAt: new Date().toISOString() },
        note: `pass complete (${terms.length} pages); next in a month`,
        nextInMinutes: CADENCE_MINUTES,
      };
    }
    log(`${written} entries, ${failures} failed, at ${place} (${stopped})`);
    return {
      cursor: cursorAt(index),
      note: `${written} entries, at ${place}${failures ? `, ${failures} failed` : ''}`,
    };
  },
});
