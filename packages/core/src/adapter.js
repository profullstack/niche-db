import { createHash } from 'node:crypto';

/**
 * What an adapter is.
 *
 * An adapter knows one upstream: how to ask it what is new, and how to turn its
 * answer into items. It knows nothing about the database, the queue or the site.
 * The core calls `pull` on a schedule with the source's config and the cursor the
 * adapter itself returned last time, and writes whatever comes back.
 *
 * @typedef {object} AdapterSpec
 * @property {string} name          registry key: 'steam', 'npm', 'edgar'
 * @property {string} title
 * @property {string} collection    default collection slug this adapter belongs in
 * @property {string} description   one paragraph for the add-source page
 * @property {string} [docs]        upstream documentation URL
 * @property {string[]} kinds       item kinds this adapter emits
 * @property {number} [cadenceMinutes=60]
 * @property {ConfigField[]} [configFields]
 * @property {(ctx: PullContext) => Promise<PullResult>} pull
 *
 * @typedef {object} ConfigField
 * @property {string} key
 * @property {string} label
 * @property {string} [help]
 * @property {string} [placeholder]
 * @property {boolean} [required]
 * @property {'text'|'list'|'number'|'select'} [type]
 * @property {string[]} [options]
 *
 * @typedef {object} PullContext
 * @property {object} config        the source's config, merged over the adapter's defaults
 * @property {object} cursor        whatever pull returned as cursor last time, or {}
 * @property {object} env           deployment secrets the adapter may need (tokens)
 * @property {object} http          fetchJson / fetchText helpers with UA and timeout
 * @property {(msg: string) => void} log
 * @property {number} budget        detail lookups this run may spend
 * @property {number} deadline      Date.now() past which the adapter should return
 *
 * @typedef {object} PullResult
 * @property {Item[]} items
 * @property {object} [cursor]      resume state for next time
 * @property {string} [note]        one line for the run log
 * @property {number} [nextInMinutes] override the cadence for the next run only
 */

const KINDS = new Set(['minute', 'day', 'month', 'year']);

/**
 * Validate a spec at registration so a typo fails at boot, not on first run.
 * @param {AdapterSpec} spec
 */
export function defineAdapter(spec) {
  for (const k of ['name', 'title', 'collection', 'description', 'kinds', 'pull']) {
    if (!spec[k]) throw new Error(`adapter ${spec.name ?? '?'} is missing ${k}`);
  }
  if (!/^[a-z0-9-]+$/.test(spec.name)) throw new Error(`adapter name ${spec.name} must be a slug`);
  return {
    cadenceMinutes: 60,
    configFields: [],
    defaults: {},
    ...spec,
  };
}

/**
 * Bring an adapter's item to the shape the table stores, and stamp a content
 * hash so an unchanged row costs no write.
 */
export function normaliseItem(raw) {
  if (!raw?.externalId || !raw?.title) return null;
  const publishedAt = toDate(raw.publishedAt);
  const item = {
    externalId: String(raw.externalId).slice(0, 500),
    kind: String(raw.kind ?? 'item').slice(0, 40),
    title: String(raw.title).trim().slice(0, 500),
    summary: raw.summary ? String(raw.summary).trim().slice(0, 4000) : null,
    url: raw.url ? String(raw.url).slice(0, 2000) : null,
    imageUrl: raw.imageUrl ? String(raw.imageUrl).slice(0, 2000) : null,
    publishedAt,
    timeKnown: raw.timeKnown ?? true,
    precision: KINDS.has(raw.precision) ? raw.precision : 'minute',
    tags: [
      ...new Set((raw.tags ?? []).map((t) => String(t).trim().toLowerCase()).filter(Boolean)),
    ].slice(0, 40),
    data: raw.data ?? {},
  };
  item.contentHash = createHash('sha1')
    .update(
      JSON.stringify([
        item.kind,
        item.title,
        item.summary,
        item.url,
        item.imageUrl,
        item.publishedAt?.toISOString() ?? null,
        item.timeKnown,
        item.precision,
        item.tags,
        item.data,
      ]),
    )
    .digest('hex');
  return item;
}

function toDate(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * A date with no clock, stored at noon UTC so it sorts inside the right calendar
 * day for everyone rather than the previous evening for the Americas.
 */
export function dateOnly(y, m, d) {
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
}

/** Parse "YYYY-MM-DD", "YYYY-MM" or "YYYY" into {publishedAt, timeKnown, precision}. */
export function looseDate(s) {
  const str = String(s ?? '').trim();
  let m = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return { publishedAt: dateOnly(+m[1], +m[2], +m[3]), timeKnown: false, precision: 'day' };
  m = str.match(/^(\d{4})-(\d{2})$/);
  if (m) return { publishedAt: dateOnly(+m[1], +m[2], 15), timeKnown: false, precision: 'month' };
  m = str.match(/^(\d{4})$/);
  if (m) return { publishedAt: dateOnly(+m[1], 7, 1), timeKnown: false, precision: 'year' };
  const d = new Date(str);
  if (!Number.isNaN(d.getTime())) return { publishedAt: d, timeKnown: true, precision: 'minute' };
  return { publishedAt: null, timeKnown: false, precision: 'day' };
}

/** Slug for a source or feed name. */
export function slugify(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);
}

/** Strip tags and collapse whitespace, for summaries that arrive as HTML. */
export function stripHtml(s) {
  return String(s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A tiny XML item reader for RSS and Atom, enough for the feeds adapters read.
 * Returns [{ tag: {text, attrs} }] per <item>/<entry>. Not a general parser.
 */
export function xmlItems(xml, itemTag) {
  const out = [];
  const re = new RegExp(`<${itemTag}(?:\\s[^>]*)?>([\\s\\S]*?)</${itemTag}>`, 'g');
  let m = re.exec(xml);
  while (m) {
    out.push(xmlFields(m[1]));
    m = re.exec(xml);
  }
  return out;
}

function xmlFields(body) {
  const fields = {};
  const re = /<([a-zA-Z][\w:.-]*)((?:\s+[\w:.-]+="[^"]*")*)\s*(?:\/>|>([\s\S]*?)<\/\1>)/g;
  let m = re.exec(body);
  while (m) {
    const [, tag, attrText, inner] = m;
    const attrs = {};
    for (const a of attrText.matchAll(/([\w:.-]+)="([^"]*)"/g)) attrs[a[1]] = decodeEntities(a[2]);
    const text =
      inner === undefined
        ? ''
        : decodeEntities(inner.replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1').trim());
    const entry = { text, attrs };
    if (fields[tag] === undefined) fields[tag] = entry;
    else if (Array.isArray(fields[tag])) fields[tag].push(entry);
    else fields[tag] = [fields[tag], entry];
    m = re.exec(body);
  }
  return fields;
}

export function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

/** First entry of a field that may be one or many. */
export const first = (f) => (Array.isArray(f) ? f[0] : f);
