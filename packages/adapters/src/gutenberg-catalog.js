import { defineAdapter, looseDate, slugify } from '@nichedb/core/adapter';

/**
 * Project Gutenberg: the whole catalogue, for the `books` collection.
 *
 * Gutenberg publishes its entire catalogue as one CSV feed,
 * cache/epub/feeds/pg_catalog.csv: 21 MB, some 90,000 lines, one row per
 * ebook with the title, authors, subjects, Library of Congress class, language,
 * bookshelves and the date it was released. The books are public domain in the
 * United States and the catalogue data is granted to the public domain (the
 * robot access policy says so in those words), so this is one of the few book
 * sources a public directory can carry whole. There is no key, no
 * paging and no per-book API to ask: the feed IS the API, and Gutenberg's robot
 * policy asks that automated readers use the feeds rather than crawl the site,
 * which is exactly what this source does.
 *
 * ONE request per pass. The response is streamed through an RFC 4180 parser
 * written here, because the feed has everything the format allows: quoted
 * fields with embedded commas, doubled quotes, and newlines inside titles
 * (about one row in seven carries a subtitle on a second line). Nothing bigger
 * than one network chunk is held while parsing; the items themselves are the
 * only thing that grows.
 *
 * Only `Type = Text` rows become items; the feed also lists audio recordings,
 * datasets and images, which are not books. A pass emits everything in one run
 * by default and rests for a week. The cursor still carries the record offset
 * so that a run cut short by the ingest deadline, or capped by `rowsPerRun`,
 * resumes where it stopped ten minutes later rather than starting over; offsets
 * only mean something inside one file, so the cursor also carries the feed's
 * Last-Modified and a changed stamp restarts the walk. Once a pass is complete
 * the next weekly run asks with If-Modified-Since and a 304 costs nothing.
 *
 * One request means one failure is a failed run, so a broken download is
 * retried from the current offset up to three times with a pause between; a
 * run in which every attempt failed throws, and a run that got some rows out
 * before giving up keeps them and the place.
 */

export const CATALOG_URL = 'https://www.gutenberg.org/cache/epub/feeds/pg_catalog.csv';

/** Who is asking. Gutenberg's robot policy wants readers to be identifiable. */
export const USER_AGENT = 'nichedb (https://nichedb.dev; hello@nichedb.dev)';

export const PROVIDER = 'gutenberg';
export const ATTRIBUTION = 'Project Gutenberg';

/** The feed is rebuilt about weekly, so a week is the honest cadence. */
export const CADENCE_MINUTES = 10_080;

/** Rows per run; 0 means the whole catalogue in one run, which is the default. */
export const ROWS_PER_RUN = 15000;

/** Attempts per run; the second and third only happen after a failed download. */
const FAILURE_STOP = 3;

/**
 * Pause before a retry. Gutenberg publishes no request rate for the feeds but
 * blocks readers that hammer the site, and a 21 MB file asked for three times
 * in a second looks like hammering.
 */
export const PAUSE_MS = 2000;

/** How many subjects and bookshelves become tags; the data keeps them all. */
export const SUBJECT_TAGS = 5;
export const SHELF_TAGS = 10;

/** How often the streaming loop looks at the clock, in records. */
const CLOCK_EVERY = 256;

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/** The feed's column names to the keys used here. */
export const COLUMNS = {
  'Text#': 'id',
  Type: 'type',
  Issued: 'issued',
  Title: 'title',
  Language: 'language',
  Authors: 'authors',
  Subjects: 'subjects',
  LoCC: 'locc',
  Bookshelves: 'bookshelves',
};

// ── CSV ──────────────────────────────────────────────────────────────────────

/**
 * An incremental RFC 4180 reader: feed it text in any size of chunk and it
 * hands back the records completed so far. A quote at the end of one chunk is
 * held until the next chunk says whether it closed the field or doubled.
 *
 * Outside quotes a carriage return is line-ending noise and dropped; inside
 * quotes it is data and kept, as the standard says. Empty lines are skipped.
 */
export class CsvParser {
  constructor() {
    this.fields = [];
    this.field = '';
    this.quoted = false;
    this.quotePending = false;
    this.wasQuoted = false;
  }

  /** @param {string} text the next chunk @returns {string[][]} completed records */
  push(text) {
    const out = [];
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (this.quotePending) {
        this.quotePending = false;
        if (ch === '"') {
          this.field += '"';
          continue;
        }
        this.quoted = false;
      }
      if (this.quoted) {
        if (ch === '"') this.quotePending = true;
        else this.field += ch;
        continue;
      }
      if (ch === '"') {
        this.quoted = true;
        this.wasQuoted = true;
      } else if (ch === ',') {
        this.endField();
      } else if (ch === '\n') {
        this.endRecord(out);
      } else if (ch !== '\r') {
        this.field += ch;
      }
    }
    return out;
  }

  /** The last record, if the file did not end on a newline. */
  end() {
    const out = [];
    if (this.quotePending) {
      this.quotePending = false;
      this.quoted = false;
    }
    if (this.quoted) this.quoted = false;
    this.endRecord(out);
    return out;
  }

  endField() {
    this.fields.push(this.field);
    this.field = '';
    this.wasQuoted = false;
  }

  endRecord(out) {
    // A bare newline between records is not a record of one empty field.
    if (this.fields.length === 0 && this.field === '' && !this.wasQuoted) return;
    this.endField();
    out.push(this.fields);
    this.fields = [];
  }
}

/** A whole CSV text as records. */
export function parseCsv(text) {
  const p = new CsvParser();
  return [...p.push(String(text ?? '')), ...p.end()];
}

/**
 * Records from a stream of bytes or strings, one at a time, decoded as UTF-8
 * across chunk boundaries.
 *
 * @param {AsyncIterable<Uint8Array|string>|Iterable<Uint8Array|string>} chunks
 */
export async function* csvRecords(chunks) {
  const decoder = new TextDecoder('utf-8');
  const parser = new CsvParser();
  for await (const chunk of chunks) {
    const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    if (text) yield* parser.push(text);
  }
  const tail = decoder.decode();
  if (tail) yield* parser.push(tail);
  yield* parser.end();
}

/**
 * A Response's body as chunks. The body stream is the point: breaking out of
 * the consumer cancels the download underneath. A body-less Response (a test
 * double, or a runtime without streams) falls back to its text.
 */
export async function* bodyChunks(res) {
  if (res?.body && typeof res.body[Symbol.asyncIterator] === 'function') {
    yield* res.body;
    return;
  }
  if (res?.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
    return;
  }
  yield await res.text();
}

// ── Rows ─────────────────────────────────────────────────────────────────────

/** A header record to the keys in COLUMNS, or null when this is not the catalogue. */
export function headerKeys(record) {
  if (!Array.isArray(record)) return null;
  const keys = record.map((name) => COLUMNS[String(name).replace(/^﻿/, '').trim()] ?? null);
  if (!keys.includes('id') || !keys.includes('title') || !keys.includes('type')) return null;
  return keys;
}

/** One record as an object keyed by COLUMNS; a missing cell is an empty string. */
export function catalogRow(keys, record) {
  const row = {};
  for (let i = 0; i < keys.length; i++) {
    if (keys[i]) row[keys[i]] = String(record[i] ?? '').replace(/\r\n?/g, '\n');
  }
  return row;
}

/** "a; b; c" as ['a', 'b', 'c']. */
export function splitList(s) {
  return String(s ?? '')
    .split(';')
    .map((x) => x.trim())
    .filter(Boolean);
}

/** A word that belongs to a date, not a name. */
const DATE_WORD =
  /^(?:\d+(?:st|nd|rd|th)?\??|BCE?|B\.C\.|CE|A\.D\.|active|approximately|ca\.|fl\.|b\.|d\.|century|or)$/i;

/**
 * Whether a comma part of an author string is a date, not a name: "1809-1892",
 * "1951-", "-1934", "621? BCE-565? BCE", "active 1600-1650", "active 9th
 * century B.C.". Word by word rather than one regex over the part, so a long
 * run of digits cannot make the test backtrack.
 */
export function isDatePart(s) {
  const str = String(s ?? '');
  const words = str.split(/[\s-]+/).filter(Boolean);
  return words.length > 0 && /\d/.test(str) && words.every((w) => DATE_WORD.test(w));
}

/**
 * One author as the feed writes it, "Last, First, 1809-1892 [Editor]", into a
 * display name, the role, the years, and the original untouched.
 *
 * Library headings put the surname first and everything else after; the first
 * two parts swap and anything left ("Baroness", "Sir", "(Vsevolod
 * Vladimirovich)") trails the name as the heading had it.
 */
export function parseAuthor(s) {
  const original = String(s ?? '').trim();
  if (!original) return null;
  let rest = original;
  let role = null;
  const roleMatch = rest.match(/\s*\[([^\]]+)\]\s*$/);
  if (roleMatch) {
    role = roleMatch[1].trim();
    rest = rest.slice(0, roleMatch.index).trim();
  }
  const parts = rest
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  const years = [];
  while (parts.length > 1 && isDatePart(parts[parts.length - 1])) years.unshift(parts.pop());
  let name;
  if (parts.length >= 2) {
    name = `${parts[1]} ${parts[0]}`;
    if (parts.length > 2) name += `, ${parts.slice(2).join(', ')}`;
  } else {
    name = parts[0] ?? rest;
  }
  return { name, original, role, years: years.length ? years.join(', ') : null };
}

/** The feed's "a; b; c" of authors as parsed authors. */
export function parseAuthors(s) {
  return splitList(s).map(parseAuthor).filter(Boolean);
}

/** The stable download links Gutenberg publishes for an ebook id. */
export function formatUrls(id) {
  const base = `https://www.gutenberg.org/ebooks/${encodeURIComponent(String(id))}`;
  return {
    epub: `${base}.epub3.images`,
    kindle: `${base}.kf8.images`,
    txt: `${base}.txt.utf-8`,
    html: `${base}.html.images`,
  };
}

export const bookUrl = (id) => `https://www.gutenberg.org/ebooks/${encodeURIComponent(String(id))}`;
export const coverUrl = (id) => {
  const n = encodeURIComponent(String(id));
  return `https://www.gutenberg.org/cache/epub/${n}/pg${n}.cover.medium.jpg`;
};

/** A bookshelf as a tag slug; the "Category: " prefix is the feed's, not the shelf's. */
export const shelfSlug = (shelf) => slugify(String(shelf).replace(/^category:\s*/i, ''));

/**
 * One catalogue row as a `book` item, or null for a row that is not a book
 * (a recording, a dataset, an image) or has no id or title.
 */
export function bookItem(row) {
  if (!row) return null;
  const id = String(row.id ?? '').trim();
  if (!/^\d+$/.test(id)) return null;
  if (String(row.type ?? '').trim() !== 'Text') return null;
  const fullTitle = String(row.title ?? '').trim();
  if (!fullTitle) return null;
  const [title, ...subtitleLines] = fullTitle.split('\n').map((l) => l.trim());
  const subtitle = subtitleLines.filter(Boolean).join(' ') || null;
  const contributors = parseAuthors(row.authors);
  const authors = contributors.filter((c) => !c.role).map((c) => c.name);
  const languages = splitList(row.language).map((l) => l.toLowerCase());
  const subjects = splitList(row.subjects);
  const bookshelves = splitList(row.bookshelves);
  const locc = splitList(row.locc);
  const issued = String(row.issued ?? '').trim() || null;
  const when = looseDate(issued ?? '');
  return {
    externalId: `${PROVIDER}:${id}`,
    kind: 'book',
    title,
    summary:
      [subtitle, authors.length ? `by ${authors.slice(0, 3).join(', ')}` : null]
        .filter(Boolean)
        .join(' · ') || null,
    url: bookUrl(id),
    imageUrl: coverUrl(id),
    publishedAt: when.publishedAt,
    timeKnown: false,
    precision: when.publishedAt ? when.precision : 'day',
    tags: [
      'book',
      PROVIDER,
      ...languages.map((l) => `lang:${slugify(l)}`),
      ...subjects.slice(0, SUBJECT_TAGS).map((s) => `subject:${slugify(s)}`),
      ...bookshelves.slice(0, SHELF_TAGS).map((s) => `shelf:${shelfSlug(s)}`),
    ].filter((t) => t && !t.endsWith(':')),
    data: {
      provider: PROVIDER,
      id,
      title,
      subtitle,
      fullTitle,
      authors,
      contributors,
      subjects,
      bookshelves,
      locc,
      language: languages[0] ?? null,
      languages,
      issued,
      type: 'Text',
      formats: formatUrls(id),
      cover: coverUrl(id),
      attribution: ATTRIBUTION,
    },
  };
}

// ── The walk ─────────────────────────────────────────────────────────────────

/** Where a run starts. `offset` set means a pass is in progress at that record. */
export function resumeFrom(prev) {
  const offset = Math.floor(Number(prev?.offset));
  const lastModified = typeof prev?.lastModified === 'string' ? prev.lastModified : null;
  const walkedAt = typeof prev?.walkedAt === 'string' ? prev.walkedAt : null;
  const checkedAt = typeof prev?.checkedAt === 'string' ? prev.checkedAt : null;
  const rows = Math.floor(Number(prev?.rows));
  const books = Math.floor(Number(prev?.books));
  return {
    offset: Number.isFinite(offset) && offset > 0 ? offset : 0,
    lastModified,
    walkedAt,
    checkedAt,
    rows: Number.isFinite(rows) && rows > 0 ? rows : null,
    books: Number.isFinite(books) && books > 0 ? books : null,
  };
}

export const gutenbergCatalog = defineAdapter({
  name: 'gutenberg-catalog',
  title: 'Project Gutenberg: every ebook',
  collection: 'books',
  description:
    "Every ebook in Project Gutenberg's catalogue, close to 80,000, one row each with its title, authors, subjects, bookshelves, Library of Congress class, language, release date, cover and the download links per format. The books are public domain in the United States and Project Gutenberg grants the catalogue data itself to the public domain, no key and no terms; every row still credits it. One request per pass: the 21 MB pg_catalog.csv feed, streamed through a CSV parser as it arrives, re-read weekly and skipped when unchanged.",
  docs: 'https://www.gutenberg.org/ebooks/offline_catalogs.html',
  kinds: ['book'],
  cadenceMinutes: CADENCE_MINUTES,
  configFields: [
    {
      key: 'rowsPerRun',
      label: 'Rows per run',
      type: 'number',
      placeholder: '0',
      help: '0 reads the whole catalogue in one run. Set a number to spread a pass over several runs ten minutes apart; the cursor keeps the place.',
    },
    {
      key: 'pauseMs',
      label: 'Pause before a retry (ms)',
      type: 'number',
      placeholder: String(PAUSE_MS),
      help: 'Only a failed download is retried, up to three times a run.',
    },
  ],
  defaults: { rowsPerRun: ROWS_PER_RUN, pauseMs: PAUSE_MS },
  defaultSources: [
    {
      slug: 'gutenberg-catalog',
      name: 'Books: every ebook on Project Gutenberg',
      config: { rowsPerRun: ROWS_PER_RUN, pauseMs: PAUSE_MS },
    },
  ],
  async pull({ config, cursor: prev, http, log, deadline }) {
    const cap = Math.max(0, Math.floor(Number(config?.rowsPerRun)) || 0);
    const pause =
      config?.pauseMs === 0 ? 0 : Math.max(0, Math.floor(Number(config?.pauseMs))) || PAUSE_MS;
    const stopAt = Number.isFinite(deadline) ? deadline : Number.POSITIVE_INFINITY;
    const state = resumeFrom(prev);
    const startedAt = state.offset;
    let offset = state.offset;
    let lastModified = state.lastModified;
    let booksBefore = startedAt ? (state.books ?? 0) : 0;
    const items = [];
    let requests = 0;
    let failures = 0;
    let streak = 0;
    let seen = 0;
    let skipped = 0;
    let progressed = false;
    let done = false;
    let unchanged = false;
    let stopped = null;

    while (!done && !stopped) {
      if (requests > 0) await sleep(pause);
      requests += 1;
      try {
        const headers = { accept: 'text/csv, */*', 'user-agent': USER_AGENT };
        // A finished pass asks whether the feed moved; a pass in progress needs
        // the bytes. Only the first request of a run asks: a retry follows an
        // attempt that answered 200 with a new stamp and then broke, and asking
        // again with that stamp would get a 304 for a catalogue never read.
        if (requests === 1 && offset === 0 && state.walkedAt && state.lastModified)
          headers['if-modified-since'] = state.lastModified;
        const res = await http.request(CATALOG_URL, { headers, timeoutMs: 180_000 });
        if (res.status === 304) {
          unchanged = true;
          break;
        }
        if (!res.ok) throw new Error(`gutenberg answered ${res.status}`);
        const modified = res.headers?.get?.('last-modified') ?? null;
        if (offset > 0 && modified && lastModified && modified !== lastModified) {
          log(
            `the catalogue changed under the walk (${lastModified} to ${modified}); starting over`,
          );
          offset = 0;
          booksBefore = 0;
          items.length = 0;
          seen = 0;
          skipped = 0;
        }
        if (modified) lastModified = modified;

        let keys = null;
        let index = 0;
        let cut = null;
        for await (const record of csvRecords(bodyChunks(res))) {
          if (!keys) {
            keys = headerKeys(record);
            if (!keys) throw new Error('gutenberg answered something that is not the catalogue');
            continue;
          }
          index += 1;
          if (index <= offset) continue;
          const item = bookItem(catalogRow(keys, record));
          if (item) items.push(item);
          else skipped += 1;
          offset = index;
          seen += 1;
          progressed = true;
          if (cap && seen >= cap) {
            cut = 'cap';
            break;
          }
          if (index % CLOCK_EVERY === 0 && Date.now() > stopAt) {
            cut = 'deadline';
            break;
          }
        }
        if (!keys) throw new Error('gutenberg answered an empty body');
        streak = 0;
        if (cut) stopped = cut;
        else done = true;
      } catch (err) {
        failures += 1;
        streak += 1;
        log(`catalogue download failed at record ${offset} (${err?.message ?? err})`);
        if (streak >= FAILURE_STOP) stopped = 'errors';
      }
    }

    // A download that broke after handing over rows is a failure to retry, not a
    // dead feed; only a run that got nothing out of any attempt is that.
    if (requests > 0 && failures === requests && !progressed) {
      throw new Error(`gutenberg: every request failed (${failures} of ${requests}); see the log`);
    }

    const now = new Date().toISOString();
    const reason =
      stopped === 'cap'
        ? 'at the row cap'
        : stopped === 'deadline'
          ? 'on the run deadline'
          : stopped === 'errors'
            ? 'after repeated failures'
            : null;

    if (unchanged) {
      return {
        items: [],
        cursor: { ...state, offset: null, lastModified, checkedAt: now },
        note: `the catalogue is unchanged since ${lastModified}; nothing to read`,
      };
    }

    return {
      items,
      cursor: done
        ? {
            offset: null,
            lastModified,
            walkedAt: now,
            checkedAt: now,
            rows: offset,
            books: booksBefore + items.length,
          }
        : {
            offset,
            lastModified,
            walkedAt: state.walkedAt,
            checkedAt: state.checkedAt,
            rows: state.rows,
            books: booksBefore + items.length,
          },
      nextInMinutes: done ? undefined : 10,
      note:
        `${items.length} books from ${seen} rows (records ${startedAt + 1} to ${offset}` +
        `${skipped ? `, ${skipped} not text` : ''})` +
        (failures ? `, ${failures} download${failures === 1 ? '' : 's'} failed` : '') +
        (done
          ? `; the catalogue is read${lastModified ? `, feed dated ${lastModified}` : ''}, next look in a week`
          : `; stopped ${reason} at record ${offset}, resuming in 10 min`),
    };
  },
});
