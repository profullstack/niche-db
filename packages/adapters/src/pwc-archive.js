import { defineAdapter, looseDate, slugify } from '@nichedb/core/adapter';

/**
 * The Papers With Code archive, for the `algorithms` collection: the methods
 * catalogue and the datasets catalogue.
 *
 * Papers With Code was the reference index of machine-learning methods
 * (about 8,700 named techniques, each with a description, the paper that
 * introduced it, the year, a code link and the area and collection it was
 * filed under) and of the datasets papers evaluate on (about 15,000, with
 * modalities, tasks, languages, licence and loaders). Meta shut the site down
 * on 2025-07-24 without notice and paperswithcode.com now redirects to
 * Hugging Face's papers pages. The data survived: the last export is on the
 * Hugging Face Hub under the `pwc-archive` organisation, CC BY-SA 4.0, one
 * parquet file per catalogue, frozen at 2025-09-10.
 *
 * Read through the Hub's datasets-server rows API, which serves any public
 * parquet as JSON pages of at most 100 rows (a longer `length` is refused),
 * so a pass over the methods is 88 requests and over the datasets 151;
 * `requestsPerRun` a run, then a month's rest, since the archive does not
 * change.
 *
 * The trap is spam. In its last months the site's submission form was
 * abused, and about three rows in four of the methods archive are call-centre
 * spam ("How do I contact Carnival about booking?", "Call +1-844-...") filed
 * as methods with a phone number for a description, a `paper` that is
 * whatever sorted first, `introduced_year` 2000 and one paper. Measured on
 * 2026-09-22: 74 of a page of 100. `isSpam` drops a row whose name asks a
 * question, carries a phone number, brackets, arrows or the call-centre
 * vocabulary, and the same test runs over the datasets, which were hit
 * lighter. What is left is the catalogue the site had before that.
 *
 * `introduced_year` is 2000 on rows that never had a year (GPipe, 2018, says
 * 2000), so 2000 is read as unknown rather than as a date. The site's own
 * URLs are dead; the row links to the paper that introduced the method when
 * the archive has it, else to the archived catalogue on the Hub.
 */

export const ROWS_API = 'https://datasets-server.huggingface.co/rows';
export const USER_AGENT = 'nichedb pwc-archive (https://nichedb.dev; hello@nichedb.dev)';

/** The catalogues, by the config value that picks one. */
export const CATALOGUES = {
  methods: { dataset: 'pwc-archive/methods', kind: 'method' },
  datasets: { dataset: 'pwc-archive/datasets', kind: 'dataset' },
};

/** Rows per request; the rows API refuses more. */
export const PAGE_ROWS = 100;

/** Requests per run; 30 is 3,000 rows and a pass over the methods in three runs. */
export const REQUESTS_PER_RUN = 30;

/** Pause between requests. The Hub publishes no limit for the rows API; a few a second is polite. */
export const PAUSE_MS = 300;

/** How long the next run waits after a whole pass: the archive is frozen, so a month. */
export const CADENCE_MINUTES = 43_200;

const FAILURE_STOP = 3;

export const PROVIDER = 'papers-with-code';
export const ATTRIBUTION = 'Papers With Code archive (pwc-archive on Hugging Face), CC BY-SA 4.0';
export const LICENSE = 'CC-BY-SA-4.0';

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

const whole = (v, fallback) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const text = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s && s !== 'None' ? s : null;
};

const list = (v) => (Array.isArray(v) ? v : []);

/** The rows API url for one page of a catalogue. */
export const pageUrl = (dataset, offset, length = PAGE_ROWS) =>
  `${ROWS_API}?${new URLSearchParams({ dataset, config: 'default', split: 'train', offset: String(offset), length: String(length) })}`;

/** A US phone number in any of the spellings the spam uses as separators. */
const PHONE = /(?:\+?1[\s.\-➤➡→]*)?\(?\d{3}\)?[\s.\-➤➡→]+\d{3}[\s.\-➤➡→]+\d{4}\b/;
/** Decoration no method name carries. */
const DECORATION = /[【】{}[\]➤➡→☎✈☏]/;
/** The call-centre vocabulary, on the name only; a real description may say "number". */
const CALL_CENTRE =
  /\b(?:call|phone|helpline|hotline|contact|support|refund|booking|cancel(?:lation)?|policy|customer|faq|24\/7|talk to|speak (?:to|with)|airline|airlines|cruise|toll[- ]free|how (?:do|can) i|what is the|live (?:agent|person|chat))\b/i;

/** True for a spam row: a question, a phone number, brackets, arrows, or the call-centre words in the name. */
export function isSpam(row) {
  const name = String(row?.name ?? '');
  const description = String(row?.description ?? '');
  if (!name.trim()) return true;
  if (name.length > 100) return true;
  if (name.includes('?')) return true;
  if (DECORATION.test(name)) return true;
  if (CALL_CENTRE.test(name)) return true;
  if (PHONE.test(name) || PHONE.test(description)) return true;
  return false;
}

/** The catalogue slug out of a paperswithcode.com URL: the last path segment. */
export const slugOf = (url) => {
  const m = String(url ?? '').match(/\/([^/?#]+)\/?(?:[?#].*)?$/);
  return m ? m[1] : null;
};

/** The archive page on the Hub for a catalogue, the fallback link now the site is gone. */
export const archiveUrl = (dataset) => `https://huggingface.co/datasets/${dataset}`;

/** A method row to an item, or null. */
export function methodItem(row) {
  const slug = slugOf(row?.url);
  const title = text(row?.name);
  if (!slug || !title) return null;
  const year = Math.floor(Number(row.introduced_year));
  const known = Number.isFinite(year) && year > 1900 && year !== 2000 ? year : null;
  const collections = list(row.collections)
    .map((c) => ({
      area: text(c?.area),
      areaId: text(c?.area_id),
      collection: text(c?.collection),
    }))
    .filter((c) => c.area || c.collection);
  const areas = [...new Set(collections.map((c) => c.area).filter(Boolean))];
  const groups = [...new Set(collections.map((c) => c.collection).filter(Boolean))];
  const paper = text(row.source_url);
  return {
    externalId: `method:${slug}`,
    kind: 'method',
    title,
    summary: text(row.description)?.slice(0, 1200) ?? null,
    url:
      paper && /^https?:\/\//.test(paper)
        ? paper
        : `${archiveUrl(CATALOGUES.methods.dataset)}?q=${encodeURIComponent(title)}`,
    ...(known ? looseDate(String(known)) : {}),
    tags: [
      'papers-with-code',
      'method',
      ...areas.map(slugify),
      ...groups.slice(0, 6).map(slugify),
    ].filter(Boolean),
    data: {
      slug,
      fullName: text(row.full_name),
      paper: row.paper?.title ? { title: text(row.paper.title), url: text(row.paper.url) } : null,
      introducedYear: known,
      sourceUrl: paper,
      sourceTitle: text(row.source_title),
      codeSnippetUrl: text(row.code_snippet_url),
      numPapers: Math.max(0, Math.floor(Number(row.num_papers)) || 0),
      areas,
      collections: groups,
      archived: row.url ?? null,
      provider: PROVIDER,
      attribution: ATTRIBUTION,
      license: LICENSE,
    },
  };
}

/** A dataset row to an item, or null. */
export function datasetItem(row) {
  const slug = slugOf(row?.url);
  const title = text(row?.name);
  if (!slug || !title) return null;
  const homepage = text(row.homepage);
  const tasks = list(row.tasks)
    .map((t) => text(t?.task))
    .filter(Boolean);
  const modalities = list(row.modalities).map(text).filter(Boolean);
  const languages = list(row.languages).map(text).filter(Boolean);
  const loaders = list(row.data_loaders)
    .map((l) => ({ repo: text(l?.repo), url: text(l?.url), frameworks: list(l?.frameworks) }))
    .filter((l) => l.url || l.repo)
    .slice(0, 8);
  const image = text(row.verified_image) ?? text(row.image) ?? text(row.thumbnail);
  const when = text(row.introduced_date);
  return {
    externalId: `dataset:${slug}`,
    kind: 'dataset',
    title,
    summary: (text(row.short_description) ?? text(row.description))?.slice(0, 1200) ?? null,
    url:
      homepage && /^https?:\/\//.test(homepage)
        ? homepage
        : `${archiveUrl(CATALOGUES.datasets.dataset)}?q=${encodeURIComponent(title)}`,
    imageUrl: image && /^https?:\/\//.test(image) ? image : null,
    ...(when ? looseDate(when) : {}),
    tags: [
      'papers-with-code',
      'dataset',
      ...modalities.map(slugify),
      ...tasks.slice(0, 5).map(slugify),
      ...languages.slice(0, 3).map(slugify),
    ].filter(Boolean),
    data: {
      slug,
      fullName: text(row.full_name),
      homepage,
      paper: row.paper?.title ? { title: text(row.paper.title), url: text(row.paper.url) } : null,
      introducedDate: when,
      licenseName: text(row.license_name),
      licenseUrl: text(row.license_url),
      modalities,
      tasks,
      languages,
      variants: list(row.variants).length,
      numPapers: Math.max(0, Math.floor(Number(row.num_papers)) || 0),
      parentDataset: text(row.parent_dataset),
      dataLoaders: loaders,
      archived: row.url ?? null,
      provider: PROVIDER,
      attribution: ATTRIBUTION,
      license: LICENSE,
    },
  };
}

/** The items out of one rows-API page, spam dropped; `{ items, spam, total }`. */
export function parsePage(body, kind) {
  const rows = Array.isArray(body?.rows) ? body.rows : [];
  const total = Math.floor(Number(body?.num_rows_total));
  const items = [];
  let spam = 0;
  for (const r of rows) {
    const row = r?.row ?? r;
    if (isSpam(row)) {
      spam += 1;
      continue;
    }
    const item = kind === 'dataset' ? datasetItem(row) : methodItem(row);
    if (item) items.push(item);
  }
  return { items, spam, rows: rows.length, total: Number.isFinite(total) ? total : null };
}

/** Where a run starts: the row offset for the catalogue; 0 for a fresh pass or another catalogue. */
export function resumeFrom(prev, catalogue) {
  const offset = Math.floor(Number(prev?.offset));
  return {
    offset: prev?.catalogue === catalogue && Number.isFinite(offset) && offset >= 0 ? offset : 0,
    passes: Math.max(0, Math.floor(Number(prev?.passes)) || 0),
  };
}

export const pwcArchive = defineAdapter({
  name: 'pwc-archive',
  title: 'Papers With Code archive',
  collection: 'algorithms',
  description:
    'The Papers With Code catalogues as they stood when Meta shut the site down in July 2025, read from the pwc-archive datasets on the Hugging Face Hub (CC BY-SA 4.0): about 8,700 machine-learning methods with their description, introducing paper, year, code link, area and collection, or about 15,000 datasets with modalities, tasks, languages, licence and loaders. The call-centre spam the site took in its last months is dropped. Keyless; a pass is a few runs and repeats monthly.',
  docs: 'https://huggingface.co/pwc-archive',
  kinds: ['method', 'dataset'],
  cadenceMinutes: 10,
  configFields: [
    {
      key: 'catalogue',
      label: 'Catalogue',
      type: 'select',
      options: Object.keys(CATALOGUES),
      required: true,
    },
    {
      key: 'requestsPerRun',
      label: 'Requests per run',
      type: 'number',
      placeholder: String(REQUESTS_PER_RUN),
      help: 'Each is one page of 100 rows. The walk stops here and picks up ten minutes later.',
    },
    {
      key: 'pauseMs',
      label: 'Pause between requests (ms)',
      type: 'number',
      placeholder: String(PAUSE_MS),
    },
  ],
  defaults: { catalogue: 'methods', requestsPerRun: REQUESTS_PER_RUN, pauseMs: PAUSE_MS },
  defaultSources: [
    {
      slug: 'pwc-methods',
      name: 'Papers With Code: methods',
      config: { catalogue: 'methods', requestsPerRun: REQUESTS_PER_RUN, pauseMs: PAUSE_MS },
    },
    {
      slug: 'pwc-datasets',
      name: 'Papers With Code: datasets',
      config: { catalogue: 'datasets', requestsPerRun: REQUESTS_PER_RUN, pauseMs: PAUSE_MS },
    },
  ],
  async *pull({ config, cursor: prev, http, log, deadline }) {
    const key = CATALOGUES[config?.catalogue] ? config.catalogue : 'methods';
    const catalogue = CATALOGUES[key];
    const cap = whole(config?.requestsPerRun, REQUESTS_PER_RUN);
    const pause =
      config?.pauseMs === 0 ? 0 : Math.max(0, Math.floor(Number(config?.pauseMs))) || PAUSE_MS;
    const stopAt = Number.isFinite(deadline) ? deadline : Number.POSITIVE_INFINITY;
    const state = resumeFrom(prev, key);
    let offset = state.offset;
    let total = null;
    let requests = 0;
    let failures = 0;
    let streak = 0;
    let written = 0;
    let spam = 0;
    let stopped = null;
    let done = false;

    const cursorAt = () => ({ catalogue: key, offset, total, passes: state.passes });

    for (;;) {
      if (total !== null && offset >= total) {
        done = true;
        break;
      }
      if (requests >= cap) {
        stopped = 'cap';
        break;
      }
      if (Date.now() > stopAt) {
        stopped = 'deadline';
        break;
      }
      if (requests > 0) await sleep(pause);
      requests += 1;
      let page;
      try {
        page = parsePage(
          await http.json(pageUrl(catalogue.dataset, offset), {
            headers: { 'user-agent': USER_AGENT },
            timeoutMs: 60_000,
          }),
          catalogue.kind,
        );
        streak = 0;
      } catch (err) {
        failures += 1;
        streak += 1;
        log(`${key} at ${offset}: ${err?.message ?? err}`);
        if (streak >= FAILURE_STOP) {
          stopped = 'errors';
          break;
        }
        continue;
      }
      if (page.total !== null) total = page.total;
      spam += page.spam;
      written += page.items.length;
      offset += page.rows;
      if (page.rows === 0) {
        done = true;
        break;
      }
      const finished = page.rows < PAGE_ROWS || (total !== null && offset >= total);
      if (page.items.length > 0) {
        yield {
          items: page.items,
          cursor: finished ? { catalogue: key, offset: 0, passes: state.passes } : cursorAt(),
        };
      }
      if (finished) {
        done = true;
        break;
      }
    }

    if (done) {
      log(
        `pass complete: ${written} ${catalogue.kind}s kept, ${spam} spam rows dropped, ${failures} failed`,
      );
      return {
        cursor: {
          catalogue: key,
          offset: 0,
          passes: state.passes + 1,
          lastPassAt: new Date().toISOString(),
        },
        note: `pass complete: ${written} kept, ${spam} spam dropped; next in a month`,
        nextInMinutes: CADENCE_MINUTES,
      };
    }
    log(
      `${written} kept, ${spam} spam dropped, at ${offset}${total !== null ? ` of ${total}` : ''} (${stopped})`,
    );
    return {
      cursor: cursorAt(),
      note: `${written} kept, ${spam} spam dropped, at ${offset}${total !== null ? ` of ${total}` : ''}${failures ? `, ${failures} failed` : ''}`,
    };
  },
});
