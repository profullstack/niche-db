import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { defineAdapter, looseDate, slugify } from '@nichedb/core/adapter';
import { dumpDir } from '@nichedb/core/dump';

/**
 * Every artist and every master release on Discogs, from the monthly XML dumps.
 *
 * Discogs publishes its whole database on the first of each month as a handful
 * of gzipped XML files under data.discogs.com, released to the public domain
 * (CC0). This adapter reads two of them: `_artists.xml.gz` (about 474 MB, some
 * nine million artists) and `_masters.xml.gz` (about 597 MB, the master
 * releases that group an album's pressings). Releases and labels are left out:
 * releases alone are 11 GB compressed and the music collection wants the
 * catalogue of who and what, not every pressing.
 *
 * WHAT THE SERVER DOES, AND WHAT THAT DICTATES
 *
 * data.discogs.com answers every request with a 200 and the whole file. It
 * ignores `Range`, so a download that drops is a download that starts over.
 * It also rate-limits hard: a handful of requests in an hour bought a 429 with
 * `retry-after: 3359`, and asking again inside that window re-arms it. So a
 * run makes at most ONE request (a file, or the checksum list), never asks for
 * a file whose complete copy is already on disk, and when it is told to wait
 * it schedules the next run past the wait rather than sleeping into it. A
 * month costs three requests spread over three runs ten minutes apart.
 * The core's `http.request` retries a 429 after a minute, which is exactly the
 * wrong move here, so the two requests go through `fetch` directly with the
 * deployment's contact address in a descriptive user agent.
 *
 * A finished download is checked against `discogs_<date>_CHECKSUM.txt`
 * (sha256) before it is walked; a mismatch discards the file.
 *
 * HOW THE FILE IS READ
 *
 * Records are not one per line: a profile carries literal newlines. The
 * reader gunzips the file chunk by chunk and scans the text for the record
 * tag (`<artist>` with `<id>` as a child element; `<master id="...">` with
 * the id as an attribute), holding one record at a time. Each record goes
 * through a small tolerant element parser, no regex and no dependency, and a
 * record that cannot become an item is counted and skipped, never thrown.
 *
 * The cursor is `{ month, entity, recordIndex }`: which dump, which of the two
 * files, and how many records of it are already written. The core saves it
 * after every batch of 500, so a crash costs one re-written batch. A new
 * month resets the walk; skipping back into a file re-inflates from the top,
 * which is well under a minute for either file.
 */

export const BASE = 'https://data.discogs.com';
export const ENTITIES = ['artists', 'masters'];
export const RECORD_TAG = { artists: 'artist', masters: 'master' };
export const BATCH_SIZE = 500;
export const SUMMARY_MAX = 600;
export const BUDGET_MS = 55 * 60_000;
export const ATTRIBUTION = 'Discogs, CC0';

/** Minutes a run waits after stopping short of the end of a pass. */
export const RESUME_MINUTES = 10;

/** A month's file that is not there yet: look again in six hours. */
export const NOT_PUBLISHED_MINUTES = 6 * 60;

/** Below this much of the budget a run does not start a download. */
export const MIN_DOWNLOAD_MS = 15 * 60_000;

/** Wait when a 429 comes without a retry-after; the observed window was 3359 s. */
export const DEFAULT_RETRY_AFTER_S = 3600;

const PROJECT_URL = 'https://github.com/profullstack/niche-db';

/** `YYYYMM01` for the dump that covers the month `now` is in. */
export function dumpMonth(now = new Date()) {
  const d = new Date(now);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}01`;
}

export const fileName = (month, entity) => `discogs_${month}_${entity}.xml.gz`;
export const checksumName = (month) => `discogs_${month}_CHECKSUM.txt`;

/** `https://data.discogs.com/?download=data%2F2026%2Fdiscogs_20260901_artists.xml.gz` */
export function dumpUrl(month, name) {
  const year = String(month).slice(0, 4);
  return `${BASE}/?download=${encodeURIComponent(`data/${year}/${name}`)}`;
}

/** Minutes until the next dump is due: the first of next month, six hours in. */
export function nextDumpMinutes(now = new Date()) {
  const d = new Date(now);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 6, 0, 0);
  return Math.max(60, Math.ceil((next - d.getTime()) / 60_000));
}

/** A `retry-after` header (seconds or an HTTP date) as seconds from `now`. */
export function retryAfterSeconds(header, now = Date.now()) {
  const s = String(header ?? '').trim();
  if (!s) return DEFAULT_RETRY_AFTER_S;
  if (/^\d+$/.test(s)) return Math.max(0, Number(s));
  const at = Date.parse(s);
  if (Number.isFinite(at)) return Math.max(0, Math.ceil((at - now) / 1000));
  return DEFAULT_RETRY_AFTER_S;
}

/** Minutes to schedule past a retry-after, with a little slack so the window has closed. */
export const retryAfterMinutes = (header, now) =>
  Math.ceil(retryAfterSeconds(header, now) / 60) + 2;

/** Who is asking, for the two requests a run makes. */
export function userAgent(env = {}) {
  const contact = env?.contactEmail ? `; ${env.contactEmail}` : '';
  return `niche-db discogs-catalog (+${PROJECT_URL}${contact})`;
}

/**
 * `discogs_<date>_CHECKSUM.txt`: sha256sum's format, one `<hex>  <file>` per
 * line. Read tolerantly: whichever token is 64 hex characters is the hash and
 * the other is the file name, so a swapped or tab-separated line still reads.
 */
export function parseChecksums(text) {
  const out = {};
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const parts = raw.trim().split(/\s+/).filter(Boolean);
    if (parts.length < 2) continue;
    const hash = parts.find((p) => /^[0-9a-f]{64}$/i.test(p));
    const name = parts.find((p) => p !== hash && /\.\w+$/.test(p));
    if (hash && name) out[name.replace(/^\*/, '')] = hash.toLowerCase();
  }
  return out;
}

/** sha256 of a file on disk, streamed. */
export async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

// ── XML ───────────────────────────────────────────────────────────────────────

const CODE_POINT = (n, original) => {
  if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff))
    return original;
  return String.fromCodePoint(n);
};

/**
 * The five XML entities and numeric references, in one pass, so `&amp;#13;`
 * comes out as the literal `&#13;` its author wrote and never as a carriage
 * return. Anything else is left as written.
 */
export function decodeXml(s) {
  return String(s ?? '').replace(
    /&(?:(amp)|(lt)|(gt)|(quot)|(apos)|#(\d{1,7})|#x([0-9a-fA-F]{1,6}));/g,
    (m, amp, lt, gt, quot, apos, dec, hex) => {
      if (amp) return '&';
      if (lt) return '<';
      if (gt) return '>';
      if (quot) return '"';
      if (apos) return "'";
      if (dec) return CODE_POINT(Number.parseInt(dec, 10), m);
      return CODE_POINT(Number.parseInt(hex, 16), m);
    },
  );
}

const isSpace = (c) => c === ' ' || c === '\n' || c === '\r' || c === '\t';

/**
 * Where an opening `<name` starts at or after `from`, or -1. The character
 * after the name must end it (`>`, `/` or whitespace), so `<artist` does not
 * match `<artists>`. With `opening` set, a self-closing `<name .../>` does not
 * count; that is what the depth counter needs.
 */
export function findOpenTag(xml, name, from = 0, { opening = false } = {}) {
  const needle = `<${name}`;
  let i = xml.indexOf(needle, from);
  while (i !== -1) {
    const c = xml[i + needle.length];
    if (c === '>' || c === '/' || isSpace(c)) {
      if (!opening) return i;
      const gt = xml.indexOf('>', i);
      if (gt === -1 || xml[gt - 1] !== '/') return i;
    }
    i = xml.indexOf(needle, i + 1);
  }
  return -1;
}

/** `a="1" b='two'` into `{ a: '1', b: 'two' }`, entities decoded; a bare attribute is `''`. */
export function parseAttrs(s) {
  const attrs = {};
  let i = 0;
  const n = s.length;
  while (i < n) {
    while (i < n && isSpace(s[i])) i += 1;
    if (i >= n) break;
    let j = i;
    while (j < n && !isSpace(s[j]) && s[j] !== '=' && s[j] !== '/') j += 1;
    const key = s.slice(i, j);
    if (!key) {
      i = j + 1;
      continue;
    }
    i = j;
    while (i < n && isSpace(s[i])) i += 1;
    if (s[i] !== '=') {
      attrs[key] = '';
      continue;
    }
    i += 1;
    while (i < n && isSpace(s[i])) i += 1;
    const q = s[i];
    if (q === '"' || q === "'") {
      const end = s.indexOf(q, i + 1);
      const stop = end === -1 ? n : end;
      attrs[key] = decodeXml(s.slice(i + 1, stop));
      i = stop + 1;
    } else {
      let k = i;
      while (k < n && !isSpace(s[k])) k += 1;
      attrs[key] = decodeXml(s.slice(i, k));
      i = k;
    }
  }
  return attrs;
}

/**
 * The first element at or after `from`: `{ name, attrs, inner, start, end }`,
 * or null when there is none. Comments, processing instructions, CDATA at the
 * top level and stray close tags are stepped over. A nested element of the
 * same name is counted so its close tag is not mistaken for the outer one; an
 * element that never closes takes the rest of the text, so a truncated record
 * still yields what it has rather than nothing.
 */
export function parseElement(xml, from = 0) {
  const n = xml.length;
  let i = xml.indexOf('<', from);
  for (;;) {
    if (i === -1 || i + 1 >= n) return null;
    if (xml.startsWith('<!--', i)) {
      const e = xml.indexOf('-->', i + 4);
      if (e === -1) return null;
      i = xml.indexOf('<', e + 3);
      continue;
    }
    const c = xml[i + 1];
    if (c === '?' || c === '!' || c === '/' || isSpace(c) || c === '>') {
      i = xml.indexOf('<', i + 1);
      continue;
    }
    break;
  }
  let j = i + 1;
  while (j < n && !isSpace(xml[j]) && xml[j] !== '>' && xml[j] !== '/') j += 1;
  const name = xml.slice(i + 1, j);
  const gt = xml.indexOf('>', j);
  if (gt === -1) return { name, attrs: parseAttrs(xml.slice(j)), inner: '', start: i, end: n };
  const selfClosing = xml[gt - 1] === '/';
  const attrs = parseAttrs(xml.slice(j, selfClosing ? gt - 1 : gt));
  if (selfClosing) return { name, attrs, inner: '', start: i, end: gt + 1 };

  const closeTag = `</${name}>`;
  let depth = 1;
  let pos = gt + 1;
  for (;;) {
    const close = xml.indexOf(closeTag, pos);
    if (close === -1) return { name, attrs, inner: xml.slice(gt + 1), start: i, end: n };
    const nested = findOpenTag(xml, name, pos, { opening: true });
    if (nested !== -1 && nested < close) {
      depth += 1;
      pos = nested + 1;
      continue;
    }
    depth -= 1;
    pos = close + closeTag.length;
    if (depth === 0) return { name, attrs, inner: xml.slice(gt + 1, close), start: i, end: pos };
  }
}

/** Every top-level element of a fragment, in order. */
export function children(xml) {
  const out = [];
  let el = parseElement(xml, 0);
  while (el) {
    out.push(el);
    el = parseElement(xml, el.end);
  }
  return out;
}

/** An element's text: CDATA unwrapped, entities decoded, trimmed. */
export function elementText(el) {
  if (!el) return '';
  const inner = el.inner.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  return decodeXml(inner).trim();
}

const child = (els, name) => els.find((e) => e.name === name);
const childTexts = (els, name, childName) => {
  const parent = child(els, name);
  if (!parent) return [];
  return children(parent.inner)
    .filter((e) => e.name === childName)
    .map(elementText)
    .filter(Boolean);
};

/**
 * Records of one tag out of a stream of text chunks, one at a time.
 *
 * Holds the text from the start of the record being assembled to the end of
 * the chunk that completed it, never more, and counts every record so that
 * `skip` plus records yielded is always the file position. A record is the
 * text from `<tag` (followed by a delimiter, so `<artist` is not `<artists>`)
 * to the next `</tag>`; nothing in either file nests its own record tag.
 */
export async function* scanRecords(chunks, tag, { skip = 0 } = {}) {
  const decoder = new TextDecoder('utf-8');
  const closeTag = `</${tag}>`;
  let buf = '';
  let seen = 0;
  for await (const chunk of chunks) {
    buf += decoder.decode(chunk, { stream: true });
    let from = 0;
    for (;;) {
      const start = findOpenTag(buf, tag, from);
      if (start === -1) break;
      const close = buf.indexOf(closeTag, start);
      if (close === -1) break;
      const stop = close + closeTag.length;
      seen += 1;
      if (seen > skip) yield buf.slice(start, stop);
      from = stop;
    }
    const pending = findOpenTag(buf, tag, from);
    if (pending !== -1) buf = buf.slice(pending);
    else buf = buf.slice(Math.max(from, buf.length - tag.length - 2));
  }
  buf += decoder.decode();
  const start = findOpenTag(buf, tag, 0);
  if (start !== -1) {
    const close = buf.indexOf(closeTag, start);
    if (close !== -1) {
      seen += 1;
      if (seen > skip) yield buf.slice(start, close + closeTag.length);
    }
  }
}

/** `scanRecords` over a gzip file; the file is released when the reader stops early. */
export async function* gzipRecords(path, tag, opts = {}) {
  const rs = createReadStream(path);
  const gz = createGunzip();
  pipeline(rs, gz, () => {});
  try {
    yield* scanRecords(gz, tag, opts);
  } finally {
    rs.destroy();
    gz.destroy();
  }
}

// ── Items ─────────────────────────────────────────────────────────────────────

/**
 * Discogs profile markup into plain text: `[a=Name]` and `[l=Label]` become
 * the name, `[url=...]text[/url]` the text, `[b]`/`[i]`/`[u]` go away, and
 * `&#13;` line breaks become spaces.
 */
export function plainProfile(s) {
  return String(s ?? '')
    .replace(/\[url=[^\]]*\]([\s\S]*?)\[\/url\]/gi, '$1')
    .replace(/\[[almr]=([^\]]*)\]/gi, '$1')
    .replace(/\[\/?[biu]\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** At most `max` characters, cut at a word when it has to be cut. */
export function trimTo(s, max = SUMMARY_MAX) {
  const str = String(s ?? '');
  if (str.length <= max) return str;
  const cut = str.lastIndexOf(' ', max - 3);
  return `${str.slice(0, cut > max / 2 ? cut : max - 3).trimEnd()}...`;
}

const discogsId = (s) => {
  const n = Number(String(s ?? '').trim());
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** One `<artist>` record as an item, or null when it has no id or no name. */
export function artistItem(record) {
  const el = typeof record === 'string' ? parseElement(record) : record;
  if (el?.name !== 'artist') return null;
  const els = children(el.inner);
  const id = discogsId(elementText(child(els, 'id')));
  const name = elementText(child(els, 'name'));
  if (!id || !name) return null;
  const realName = elementText(child(els, 'realname')) || null;
  const profile = plainProfile(elementText(child(els, 'profile')));
  const nameVariations = childTexts(els, 'namevariations', 'name');
  const aliases = childTexts(els, 'aliases', 'name');
  const members = childTexts(els, 'members', 'name');
  const groups = childTexts(els, 'groups', 'name');
  const urls = childTexts(els, 'urls', 'url');
  const dataQuality = elementText(child(els, 'data_quality')) || null;
  return {
    externalId: `discogs:artist:${id}`,
    kind: 'artist',
    title: name,
    summary: profile ? trimTo(profile, SUMMARY_MAX) : null,
    url: `https://www.discogs.com/artist/${id}`,
    imageUrl: null,
    publishedAt: null,
    timeKnown: false,
    tags: ['artist', 'discogs'],
    data: {
      discogsId: id,
      name,
      realName,
      nameVariations,
      aliases,
      members,
      groups,
      urls,
      dataQuality,
      attribution: ATTRIBUTION,
    },
  };
}

/** One `<master id="...">` record as an item, or null when it has no id or no title. */
export function masterItem(record) {
  const el = typeof record === 'string' ? parseElement(record) : record;
  if (el?.name !== 'master') return null;
  const id = discogsId(el.attrs.id);
  const els = children(el.inner);
  const title = elementText(child(els, 'title'));
  if (!id || !title) return null;
  const artists = [];
  const artistsEl = child(els, 'artists');
  if (artistsEl) {
    for (const a of children(artistsEl.inner)) {
      if (a.name !== 'artist') continue;
      const parts = children(a.inner);
      const name = elementText(child(parts, 'name'));
      if (!name) continue;
      artists.push({ name, id: discogsId(elementText(child(parts, 'id'))) });
    }
  }
  const genres = childTexts(els, 'genres', 'genre');
  const styles = childTexts(els, 'styles', 'style');
  const yearNum = Number(elementText(child(els, 'year')));
  const year = Number.isInteger(yearNum) && yearNum > 0 ? yearNum : null;
  const mainRelease = discogsId(elementText(child(els, 'main_release')));
  const dataQuality = elementText(child(els, 'data_quality')) || null;
  const videosEl = child(els, 'videos');
  const videos = videosEl
    ? children(videosEl.inner)
        .filter((v) => v.name === 'video' && v.attrs.src)
        .map((v) => v.attrs.src)
    : [];
  const names = artists.map((a) => a.name);
  const when = year ? looseDate(String(year)) : null;
  return {
    externalId: `discogs:master:${id}`,
    kind: 'master',
    title: names.length ? `${names.join(', ')} - ${title}` : title,
    summary: [year ? String(year) : null, ...genres, ...styles].filter(Boolean).join(' · ') || null,
    url: `https://www.discogs.com/master/${id}`,
    imageUrl: null,
    publishedAt: when?.publishedAt ?? null,
    timeKnown: false,
    precision: when?.precision ?? 'day',
    tags: [
      'master',
      'discogs',
      ...genres.map((g) => `genre:${slugify(g)}`),
      ...styles.map((s) => `style:${slugify(s)}`),
    ].filter((t) => !t.endsWith(':')),
    data: {
      discogsId: id,
      title,
      mainRelease,
      year,
      artists,
      genres,
      styles,
      videos,
      dataQuality,
      attribution: ATTRIBUTION,
    },
  };
}

/** A record of either file as an item; null (never a throw) for one that cannot be. */
export function recordItem(entity, record) {
  try {
    return entity === 'masters' ? masterItem(record) : artistItem(record);
  } catch {
    return null;
  }
}

// ── Cursor ────────────────────────────────────────────────────────────────────

/**
 * Where a run starts. A cursor from another month is a finished or abandoned
 * walk of a file that no longer matters, so it resets to the first record of
 * the first file; the checksum list and the verified files go with it.
 */
export function resumeFrom(prev, month) {
  const same = prev?.month === month;
  const entity = same && ENTITIES.includes(prev?.entity) ? prev.entity : ENTITIES[0];
  const idx = Math.floor(Number(prev?.recordIndex));
  return {
    month,
    entity,
    recordIndex: same && idx > 0 ? idx : 0,
    done: same && prev?.done === true,
    verified: same && Array.isArray(prev?.verified) ? prev.verified.filter(Boolean) : [],
    checksums:
      same && prev?.checksums && typeof prev.checksums === 'object' ? prev.checksums : null,
  };
}

// ── Download ──────────────────────────────────────────────────────────────────

/**
 * One request for a dump file, streamed to `<path>.part` and renamed into
 * place only when every byte the server announced has arrived. The server
 * ignores `Range`, so nothing is resumed: a short body is deleted and the
 * result says `complete: false`. A non-2xx status returns without a body
 * (`status`, and `retryAfter` for a 429); a connection that drops throws.
 */
export async function fetchDump(fetchImpl, url, path, { userAgent: ua, signal, onProgress } = {}) {
  const res = await fetchImpl(url, {
    headers: { 'user-agent': ua, accept: '*/*' },
    signal,
    redirect: 'follow',
  });
  const out = {
    status: res.status,
    ok: res.ok,
    bytes: 0,
    total: null,
    complete: false,
    retryAfter: res.headers.get('retry-after'),
  };
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return out;
  }
  const len = Number(res.headers.get('content-length'));
  out.total = res.headers.has('content-length') && Number.isFinite(len) && len >= 0 ? len : null;
  const part = `${path}.part`;
  const fh = await open(part, 'w');
  try {
    for await (const chunk of res.body) {
      await fh.write(chunk);
      out.bytes += chunk.byteLength;
      onProgress?.({ bytes: out.bytes, total: out.total });
    }
  } catch (err) {
    await fh.close();
    await unlink(part).catch(() => {});
    throw err;
  }
  await fh.close();
  out.complete = out.total === null ? true : out.bytes === out.total;
  if (out.complete) await rename(part, path);
  else await unlink(part).catch(() => {});
  return out;
}

/** A small text file (the checksum list) with the same request discipline. */
export async function fetchText(fetchImpl, url, { userAgent: ua, signal } = {}) {
  const res = await fetchImpl(url, {
    headers: { 'user-agent': ua, accept: 'text/plain, */*' },
    signal,
    redirect: 'follow',
  });
  const out = {
    status: res.status,
    ok: res.ok,
    text: '',
    retryAfter: res.headers.get('retry-after'),
  };
  if (res.ok) out.text = await res.text();
  else await res.body?.cancel().catch(() => {});
  return out;
}

const exists = async (path) => (await stat(path).catch(() => null))?.isFile() === true;

/** Files of other months, and leftover partials, out of the cache directory. */
export async function pruneDir(dir, month) {
  const names = await readdir(dir).catch(() => []);
  for (const name of names) {
    if (!name.startsWith('discogs_')) continue;
    if (name.includes(`_${month}_`) && !name.endsWith('.part')) continue;
    await unlink(join(dir, name)).catch(() => {});
  }
}

/** The configured directory, created, or the deployment's dump directory. */
export async function cacheDir(configured) {
  const dir = String(configured ?? '').trim();
  if (!dir) return dumpDir('discogs');
  await mkdir(dir, { recursive: true });
  return dir;
}

const isAbort = (err) => err?.name === 'AbortError' || err?.name === 'TimeoutError';

// ── Adapter ───────────────────────────────────────────────────────────────────

export const discogsCatalog = defineAdapter({
  name: 'discogs-catalog',
  title: 'Discogs: every artist and master release',
  collection: 'music',
  description:
    'Every artist and every master release on Discogs, from the monthly XML dumps: an artist row with real name, name variations, aliases, members, groups, links and data quality; a master row with its artists, year, genres, styles, main release and videos. Discogs releases the dumps under CC0, so the data is public domain and every row still credits Discogs. Two files a month, downloaded once each and walked in batches of 500 across runs; no images, which Discogs serves only with a key.',
  docs: 'https://data.discogs.com/',
  kinds: ['artist', 'master'],
  cadenceMinutes: 30 * 24 * 60,
  budgetMs: BUDGET_MS,
  configFields: [
    {
      key: 'cacheDir',
      label: 'Dump directory',
      help: 'Where the two monthly files are kept between runs. Empty means the deployment dump directory (INGEST_DATA_DIR, else the OS temp dir).',
      placeholder: '/data/discogs',
    },
  ],
  defaults: { cacheDir: '' },
  defaultSources: [
    { slug: 'discogs-catalog', name: 'Music: every artist and master release on Discogs' },
  ],
  async *pull({ config, cursor: prev, env, http, log, deadline }) {
    const now = new Date();
    const month = dumpMonth(now);
    const state = resumeFrom(prev, month);
    const stopAt = Number.isFinite(deadline) ? deadline : Number.POSITIVE_INFINITY;
    const fetchImpl = typeof http?.fetch === 'function' ? http.fetch : globalThis.fetch;
    const ua = userAgent(env);
    const cursorAt = (entity, recordIndex, extra = {}) => ({
      month,
      entity,
      recordIndex,
      verified: state.verified,
      checksums: state.checksums,
      ...extra,
    });

    if (state.done) {
      return {
        cursor: cursorAt(state.entity, state.recordIndex, { done: true }),
        note: `${month} already walked; unchanged`,
        nextInMinutes: nextDumpMinutes(now),
      };
    }

    const dir = await cacheDir(config?.cacheDir);
    if (prev?.month !== month) await pruneDir(dir, month);

    let requests = 0;
    let failures = 0;
    let written = 0;
    let bad = 0;
    let batches = 0;

    const signalFor = () =>
      AbortSignal.timeout(Math.max(1000, Math.min(stopAt - Date.now(), 60 * 60_000)));

    for (let ei = ENTITIES.indexOf(state.entity); ei < ENTITIES.length; ei += 1) {
      const entity = ENTITIES[ei];
      const name = fileName(month, entity);
      const file = join(dir, name);
      const at = ei === ENTITIES.indexOf(state.entity) ? state.recordIndex : 0;
      const tally = () =>
        `${written} items written${bad ? `, ${bad} records skipped` : ''} this run`;

      // ── The file: on disk and whole, or one attempt to make it so ──────────
      if (!(await exists(file))) {
        if (requests >= 1) {
          return {
            cursor: cursorAt(entity, at),
            note: `${name} needed next; one request a run, resuming in ${RESUME_MINUTES} min (${tally()})`,
            nextInMinutes: RESUME_MINUTES,
          };
        }
        if (stopAt - Date.now() < MIN_DOWNLOAD_MS) {
          return {
            cursor: cursorAt(entity, at),
            note: `not enough of the budget left to download ${name}; resuming in ${RESUME_MINUTES} min (${tally()})`,
            nextInMinutes: RESUME_MINUTES,
          };
        }
        requests += 1;
        let dl;
        try {
          log(`downloading ${name}`);
          dl = await fetchDump(fetchImpl, dumpUrl(month, name), file, {
            userAgent: ua,
            signal: signalFor(),
          });
        } catch (err) {
          failures += 1;
          if (isAbort(err)) {
            return {
              cursor: cursorAt(entity, at),
              note: `download of ${name} cut at the deadline; trying again in ${RESUME_MINUTES} min`,
              nextInMinutes: RESUME_MINUTES,
            };
          }
          throw new Error(`discogs: every request failed (${requests}): ${err?.message ?? err}`);
        }
        if (dl.status === 429) {
          const wait = retryAfterMinutes(dl.retryAfter, now.getTime());
          log(`429 for ${name}; retry-after ${dl.retryAfter ?? 'unset'}, next run in ${wait} min`);
          return {
            cursor: cursorAt(entity, at),
            note: `rate limited on ${name}; retry after ${wait} min`,
            nextInMinutes: wait,
          };
        }
        if (dl.status === 404) {
          // The place, not `prev`: batches of an earlier file in this run are
          // already saved and the cursor must never step back behind them.
          return {
            cursor: cursorAt(entity, at),
            note: `${name} is not published yet; looking again in ${NOT_PUBLISHED_MINUTES / 60} h`,
            nextInMinutes: NOT_PUBLISHED_MINUTES,
          };
        }
        if (!dl.ok) {
          failures += 1;
          throw new Error(`discogs: every request failed (${requests}): ${dl.status} for ${name}`);
        }
        if (!dl.complete) {
          log(`${name}: ${dl.bytes} of ${dl.total} bytes arrived; the server ignores Range`);
          return {
            cursor: cursorAt(entity, at),
            note: `download of ${name} incomplete (${dl.bytes} of ${dl.total} bytes); trying again in ${RESUME_MINUTES} min`,
            nextInMinutes: RESUME_MINUTES,
          };
        }
        log(`${name}: ${dl.bytes} bytes on disk`);
      }

      // ── Verify once against the month's checksum list ────────────────────
      if (!state.verified.includes(entity)) {
        if (!state.checksums) {
          if (requests >= 1) {
            return {
              cursor: cursorAt(entity, at),
              note: `${name} on disk; checksum list is the next run's one request, in ${RESUME_MINUTES} min (${tally()})`,
              nextInMinutes: RESUME_MINUTES,
            };
          }
          requests += 1;
          let got;
          try {
            got = await fetchText(fetchImpl, dumpUrl(month, checksumName(month)), {
              userAgent: ua,
              signal: signalFor(),
            });
          } catch (err) {
            failures += 1;
            if (failures === requests)
              throw new Error(
                `discogs: every request failed (${requests}): ${err?.message ?? err}`,
              );
            log(`checksum list unavailable (${err?.message ?? err}); trying next run`);
            return {
              cursor: cursorAt(entity, at),
              note: `checksum list unavailable; trying again in ${RESUME_MINUTES} min`,
              nextInMinutes: RESUME_MINUTES,
            };
          }
          if (got.status === 429) {
            const wait = retryAfterMinutes(got.retryAfter, now.getTime());
            return {
              cursor: cursorAt(entity, at),
              note: `rate limited on the checksum list; retry after ${wait} min`,
              nextInMinutes: wait,
            };
          }
          if (got.ok) state.checksums = parseChecksums(got.text);
          else {
            log(`${checksumName(month)} answered ${got.status}; walking unverified`);
            state.checksums = {};
          }
        }
        const want = state.checksums[name];
        if (want) {
          const have = await sha256File(file);
          if (have !== want) {
            await unlink(file).catch(() => {});
            log(`${name}: sha256 ${have} does not match ${want}; file discarded`);
            return {
              cursor: cursorAt(entity, at),
              note: `${name} failed its checksum and was discarded; downloading again in ${RESUME_MINUTES} min`,
              nextInMinutes: RESUME_MINUTES,
            };
          }
          log(`${name}: sha256 verified`);
        } else log(`${name}: no checksum listed; walking unverified`);
        state.verified = [...state.verified, entity];
      }

      // ── The walk ─────────────────────────────────────────────────────────
      if (Date.now() > stopAt) {
        return {
          cursor: cursorAt(entity, at),
          note: `deadline reached before walking ${name} (${tally()}); resuming in ${RESUME_MINUTES} min`,
          nextInMinutes: RESUME_MINUTES,
        };
      }
      let n = at;
      let batch = [];
      const tag = RECORD_TAG[entity];
      try {
        for await (const record of gzipRecords(file, tag, { skip: at })) {
          n += 1;
          const item = recordItem(entity, record);
          if (item) batch.push(item);
          else bad += 1;
          if (batch.length >= BATCH_SIZE) {
            written += batch.length;
            batches += 1;
            yield { items: batch, cursor: cursorAt(entity, n) };
            batch = [];
            if (Date.now() > stopAt) {
              return {
                cursor: cursorAt(entity, n),
                note: `stopped on the run deadline at ${entity} record ${n} after ${batches} batches (${tally()}); resuming in ${RESUME_MINUTES} min`,
                nextInMinutes: RESUME_MINUTES,
              };
            }
          }
        }
      } catch (err) {
        // A file that will not inflate is a bad copy: drop it so the next run
        // fetches a fresh one; the cursor stays at the last batch written.
        await unlink(file).catch(() => {});
        throw new Error(
          `discogs: ${name} unreadable at record ${n} (${err?.message ?? err}); file discarded`,
        );
      }
      if (batch.length) {
        written += batch.length;
        batches += 1;
        yield { items: batch, cursor: cursorAt(entity, n) };
      }
      log(`${name}: walked to the end, ${n} records`);
      state.recordIndex = 0;
      if (ei + 1 < ENTITIES.length) {
        state.entity = ENTITIES[ei + 1];
        if (Date.now() > stopAt) {
          return {
            cursor: cursorAt(state.entity, 0),
            note: `${name} complete; stopped on the run deadline before ${ENTITIES[ei + 1]} (${tally()}); resuming in ${RESUME_MINUTES} min`,
            nextInMinutes: RESUME_MINUTES,
          };
        }
      } else {
        return {
          cursor: cursorAt(entity, n, { done: true }),
          note: `complete: ${month} walked (${tally()})`,
          nextInMinutes: nextDumpMinutes(now),
        };
      }
    }
    return { cursor: cursorAt(state.entity, state.recordIndex), note: 'nothing to do' };
  },
});
