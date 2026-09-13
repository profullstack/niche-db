import { defineAdapter, slugify, stripHtml } from '@nichedb/core/adapter';

/**
 * LibriVox: every audiobook in the catalogue, for the `books` collection.
 *
 * LibriVox is volunteers reading public domain books, and the recordings are
 * public domain too: 22,343 finished audiobooks on 2026-09-13, every one
 * free to copy, in any language a volunteer speaks. The API is keyless and
 * documented at librivox.org/api/info. `/api/feed/audiobooks/?format=json`
 * pages by `limit` and `offset` in id order, 50 a page; an offset past the end
 * answers 404 with `{"error":"Audiobooks could not be found"}`. `extended=1`
 * adds the authors, genres, translators, archive.org link and the section
 * list; `coverart=1` adds the cover art links; and `fields={...}` picks the
 * fields, which matters because the section list is a 600 KB page against
 * 60 KB without it. The walk here asks for everything but the sections.
 *
 * The API gives no catalogue date, only `since=<epoch>` as a query, so
 * `publishedAt` is null: `copyright_year` is when the BOOK was published, not
 * when the recording was, and stamping 1844 on a 2007 recording would be wrong
 * in both directions. A run reads `requestCap` pages and stops; the cursor
 * carries the next offset and the pass ends on the 404. The next run starts
 * over from offset 0, so a re-read of the whole catalogue lands about every
 * twelve runs and picks up new recordings at the tail.
 *
 * The origin is slow (ten to thirty seconds a page near the end, a minute
 * for any page when it is under load, and a Cloudflare 522 or 525 in place of
 * an answer now and then), so the timeout is long and a failed page is
 * retried in place rather than skipped.
 */

export const BASE = 'https://librivox.org/api/feed/audiobooks/';

/** Who is asking, on every request. */
export const USER_AGENT = 'nichedb (https://nichedb.dev; hello@nichedb.dev)';

/** Books per page: the API's default and its documented ceiling is unstated, so this stays at the default. */
export const PAGE_SIZE = 50;

/** Pages per run by default: 2,000 books, a full pass in about twelve runs. */
export const REQUEST_CAP = 40;

/** Consecutive failures after which a run stops asking, so an outage costs little. */
const FAILURE_STOP = 3;

/** LibriVox publishes no rate limit; half a second between pages is polite to a slow origin. */
export const PAUSE_MS = 500;

/** Every field but `sections` and `coverart_pdf`; the sections list is ten times the rest of the page. */
export const FIELDS = [
  'id',
  'title',
  'description',
  'url_text_source',
  'language',
  'copyright_year',
  'num_sections',
  'url_rss',
  'url_zip_file',
  'url_project',
  'url_librivox',
  'url_iarchive',
  'url_other',
  'totaltime',
  'totaltimesecs',
  'authors',
  'translators',
  'genres',
  'coverart_jpg',
  'coverart_thumbnail',
];

export const ATTRIBUTION = 'LibriVox, public domain';

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

export const pageUrl = (offset, limit = PAGE_SIZE) =>
  `${BASE}?format=json&extended=1&coverart=1&limit=${encodeURIComponent(String(limit))}` +
  `&offset=${encodeURIComponent(String(offset))}&fields=${encodeURIComponent(`{${FIELDS.join(',')}}`)}`;

const text = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
};

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const url = (v) => {
  const s = text(v);
  return s && /^https?:\/\//i.test(s) ? s : null;
};

/**
 * LibriVox names a language in English ("English", "Ancient Greek", "Church
 * Slavonic"); the tag wants a code so it lines up with `lang:en` elsewhere.
 * ISO 639-1 where one exists, 639-2 or 639-3 where it does not, and the
 * slug of the name for anything not listed so no book loses its tag.
 */
export const LANGUAGES = {
  english: 'en',
  german: 'de',
  french: 'fr',
  spanish: 'es',
  italian: 'it',
  dutch: 'nl',
  portuguese: 'pt',
  russian: 'ru',
  chinese: 'zh',
  japanese: 'ja',
  korean: 'ko',
  latin: 'la',
  greek: 'el',
  'ancient greek': 'grc',
  hebrew: 'he',
  polish: 'pl',
  swedish: 'sv',
  danish: 'da',
  norwegian: 'no',
  finnish: 'fi',
  icelandic: 'is',
  hungarian: 'hu',
  czech: 'cs',
  slovak: 'sk',
  slovenian: 'sl',
  croatian: 'hr',
  serbian: 'sr',
  bulgarian: 'bg',
  romanian: 'ro',
  ukrainian: 'uk',
  lithuanian: 'lt',
  latvian: 'lv',
  estonian: 'et',
  esperanto: 'eo',
  tagalog: 'tl',
  cebuano: 'ceb',
  'bisaya/cebuano': 'ceb',
  indonesian: 'id',
  malay: 'ms',
  thai: 'th',
  vietnamese: 'vi',
  arabic: 'ar',
  persian: 'fa',
  farsi: 'fa',
  urdu: 'ur',
  hindi: 'hi',
  bengali: 'bn',
  tamil: 'ta',
  telugu: 'te',
  marathi: 'mr',
  gujarati: 'gu',
  sanskrit: 'sa',
  turkish: 'tr',
  yiddish: 'yi',
  welsh: 'cy',
  irish: 'ga',
  'scottish gaelic': 'gd',
  scots: 'sco',
  catalan: 'ca',
  galician: 'gl',
  basque: 'eu',
  afrikaans: 'af',
  swahili: 'sw',
  luxembourgish: 'lb',
  frisian: 'fy',
  faroese: 'fo',
  occitan: 'oc',
  breton: 'br',
  cornish: 'kw',
  georgian: 'ka',
  armenian: 'hy',
  albanian: 'sq',
  macedonian: 'mk',
  belarusian: 'be',
  cantonese: 'yue',
  'old english': 'ang',
  'middle english': 'enm',
  'old french': 'fro',
  'middle french': 'frm',
  'old norse': 'non',
  'church slavonic': 'cu',
  'old church slavonic': 'cu',
  multilingual: 'mul',
};

/** The tag code for a LibriVox language name, or null when there is no name. */
export function languageCode(name) {
  const s = text(name);
  if (!s) return null;
  const key = s.toLowerCase().replace(/\s+/g, ' ');
  return LANGUAGES[key] ?? slugify(key.replace(/[/&+]+/g, ' ')) ?? null;
}

/** "Science Fiction/Fantasy" -> "science-fiction-fantasy", not "science-fictionfantasy". */
export const genreSlug = (name) => slugify(String(name ?? '').replace(/[/&+]+/g, ' '));

/** "1844" -> 1844; "0", "" and prose are null. */
export function copyrightYear(v) {
  const s = text(v);
  if (!s) return null;
  const m = s.match(/^(\d{4})/);
  return m ? Number(m[1]) : null;
}

const person = (p) => {
  if (!p || typeof p !== 'object') return null;
  const firstName = text(p.first_name);
  const lastName = text(p.last_name);
  const name = [firstName, lastName].filter(Boolean).join(' ') || null;
  if (!name) return null;
  return {
    id: text(p.id),
    name,
    firstName,
    lastName,
    dob: text(p.dob),
    dod: text(p.dod),
  };
};

const people = (list) => (Array.isArray(list) ? list.map(person).filter(Boolean) : []);

/**
 * What a page answer means: the books on it, or that the walk is past the end.
 * A 404 is the documented past-the-end answer, and so is an `error` body or an
 * empty list on a 200. Anything else that is not ok is a failure to retry.
 */
export function parsePage(status, body) {
  if (status === 404) return { books: [], end: true };
  if (status < 200 || status >= 300) throw new Error(`librivox answered ${status}`);
  if (!body || typeof body !== 'object' || body.error) return { books: [], end: true };
  const books = Array.isArray(body.books) ? body.books : [];
  return { books, end: books.length === 0 };
}

/** One audiobook row -> one item, or null for a row with no id or title. */
export function bookItem(b) {
  const id = text(b?.id);
  const title = text(b?.title);
  if (!id || !title) return null;
  const description = stripHtml(text(b.description) ?? '') || null;
  const language = text(b.language);
  const lang = languageCode(language);
  const genres = (Array.isArray(b.genres) ? b.genres : [])
    .map((g) => ({ id: text(g?.id), name: text(g?.name) }))
    .filter((g) => g.name);
  const authors = people(b.authors);
  const translators = people(b.translators);
  const coverJpg = url(b.coverart_jpg);
  const coverThumb = url(b.coverart_thumbnail);
  const pageLink = url(b.url_librivox);
  const archive = url(b.url_iarchive);
  const year = copyrightYear(b.copyright_year);
  return {
    externalId: `librivox:${id}`,
    kind: 'audiobook',
    title,
    summary: description
      ? description.slice(0, 600)
      : [authors.map((a) => a.name).join(', ') || null, language, text(b.totaltime)]
          .filter(Boolean)
          .join(' · ') || null,
    url: pageLink ?? archive ?? url(b.url_rss),
    imageUrl: coverJpg ?? coverThumb,
    publishedAt: null,
    tags: [
      'audiobook',
      'librivox',
      lang ? `lang:${lang}` : null,
      ...genres.map((g) => `genre:${genreSlug(g.name)}`),
    ].filter(Boolean),
    data: {
      provider: 'librivox',
      librivoxId: id,
      title,
      authors,
      translators,
      language,
      languageCode: lang,
      totaltime: text(b.totaltime),
      totaltimesecs: num(b.totaltimesecs),
      numSections: num(b.num_sections),
      urlLibrivox: pageLink,
      urlRss: url(b.url_rss),
      urlZip: url(b.url_zip_file),
      urlProject: url(b.url_project),
      urlText: url(b.url_text_source),
      urlIarchive: archive,
      urlOther: url(b.url_other),
      genres,
      copyrightYear: year,
      coverArt: coverJpg ?? coverThumb,
      coverThumbnail: coverThumb,
      description,
      attribution: ATTRIBUTION,
    },
  };
}

/** The books on a page as items; a row with no id or title is skipped. */
export function pageItems(books) {
  if (!Array.isArray(books)) return [];
  return books.map(bookItem).filter(Boolean);
}

/** Where a run starts: the cursor's next offset, else the top of the catalogue. */
export function resumeOffset(prev) {
  const offset = Math.floor(Number(prev?.offset));
  return Number.isFinite(offset) && offset > 0 ? offset : 0;
}

export const librivoxCatalog = defineAdapter({
  name: 'librivox-catalog',
  title: 'LibriVox: every audiobook',
  collection: 'books',
  description:
    'Every finished audiobook on LibriVox, about 22,300, one row each with the readers’ description, authors and translators with their dates, language, genres, running time, section count, cover art, the RSS and zip download links, the archive.org page and the source text. Every recording is public domain and so is the catalogue, keyless, credited to LibriVox on each row. Walks /api/feed/audiobooks 50 a page in id order; a run reads a fixed number of pages and resumes, the pass ends past the last book, and the next run starts over.',
  docs: 'https://librivox.org/api/info',
  kinds: ['audiobook'],
  cadenceMinutes: 1440,
  configFields: [
    {
      key: 'requestCap',
      label: 'Pages per run',
      type: 'number',
      placeholder: String(REQUEST_CAP),
      help: '50 books a page. The walk stops here and picks up ten minutes later; 40 pages is a full pass in about twelve runs.',
    },
    {
      key: 'pauseMs',
      label: 'Pause between pages (ms)',
      type: 'number',
      placeholder: String(PAUSE_MS),
      help: 'LibriVox publishes no rate limit; the origin is slow and a short gap is polite.',
    },
  ],
  defaults: { requestCap: REQUEST_CAP, pauseMs: PAUSE_MS },
  defaultSources: [
    {
      slug: 'librivox-catalog',
      name: 'Books: every LibriVox audiobook',
      config: { requestCap: REQUEST_CAP, pauseMs: PAUSE_MS },
    },
  ],
  async pull({ config, cursor: prev, http, log, deadline }) {
    const cap = Math.max(1, Math.floor(Number(config?.requestCap)) || REQUEST_CAP);
    const pause =
      config?.pauseMs === 0 ? 0 : Math.max(0, Math.floor(Number(config?.pauseMs))) || PAUSE_MS;
    const stopAt = Number.isFinite(deadline) ? deadline : Number.POSITIVE_INFINITY;
    const startedAt = resumeOffset(prev);
    let offset = startedAt;
    let seen = Math.max(0, Math.floor(Number(prev?.seen)) || 0);
    let requests = 0;
    let pages = 0;
    let failures = 0;
    let streak = 0;
    let stopped = null;
    let done = false;
    const items = [];

    for (;;) {
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
      let page = null;
      try {
        const res = await http.request(pageUrl(offset), {
          headers: { accept: 'application/json', 'user-agent': USER_AGENT },
          timeoutMs: 90_000,
        });
        const body = res.status === 404 ? null : await res.json().catch(() => null);
        page = parsePage(res.status, body);
        streak = 0;
      } catch (err) {
        failures += 1;
        streak += 1;
        log(`page at offset ${offset} unavailable (${err?.message ?? err})`);
        if (streak >= FAILURE_STOP) {
          stopped = 'errors';
          break;
        }
        continue;
      }
      if (page.end) {
        done = true;
        break;
      }
      pages += 1;
      const got = pageItems(page.books);
      items.push(...got);
      seen += got.length;
      offset += page.books.length;
    }

    if (requests > 0 && failures === requests) {
      throw new Error(`librivox: every request failed (${requests} of ${requests}); see the log`);
    }

    const reason =
      stopped === 'cap'
        ? 'at the page cap'
        : stopped === 'deadline'
          ? 'on the run deadline'
          : stopped === 'errors'
            ? 'after repeated failures'
            : null;

    return {
      items,
      cursor: {
        offset: done ? null : offset,
        seen: done ? 0 : seen,
        total: done ? seen : (prev?.total ?? null),
        walkedAt: done ? new Date().toISOString() : (prev?.walkedAt ?? null),
      },
      nextInMinutes: done ? undefined : 10,
      note:
        `${items.length} audiobooks from ${pages} pages (offsets ${startedAt} to ${offset}` +
        `${seen ? `, ${seen} this pass` : ''})` +
        (failures ? `, ${failures} failed` : '') +
        (done
          ? '; past the last book, next run starts over at 0'
          : `; stopped ${reason} at offset ${offset}, resuming in 10 min`),
    };
  },
});
