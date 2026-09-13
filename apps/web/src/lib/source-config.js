/**
 * What a source's page says about its config and its progress.
 *
 * A source's config and cursor are jsonb, which arrives from the driver as
 * a string in production and as an object in tests, and the page used to
 * print `JSON.stringify` of whatever it got: an object became one line of
 * JSON, a string became that JSON escaped a second time, and a bulk list of
 * two hundred addresses became a blob nobody could read. This reads each
 * field the way the adapter declared it, counts a list instead of
 * printing it, and turns the walk cursor into a sentence.
 */

/** A jsonb value as the object it is, whichever shape the driver handed over. */
export function parseJson(value, fallback = {}) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

/** How many entries of a list the page shows before folding the rest. */
export const LIST_SHOWN = 100;

const asList = (v) =>
  (Array.isArray(v) ? v : String(v ?? '').split(/[\s,]+/)).map(String).filter(Boolean);

/**
 * The config, field by field: declared fields in the adapter's order, each
 * as a value, a list (with its count and the first entries), or, for a key
 * the adapter did not declare, the JSON of it. Empty values are left out.
 */
export function describeConfig(adapter, config) {
  const cfg = parseJson(config);
  const out = [];
  const seen = new Set();
  for (const f of adapter?.configFields ?? []) {
    seen.add(f.key);
    const v = cfg?.[f.key];
    if (v === undefined || v === null || v === '') continue;
    if (f.type === 'list') {
      const entries = asList(v);
      if (entries.length === 0) continue;
      out.push({
        key: f.key,
        label: f.label ?? f.key,
        kind: 'list',
        count: entries.length,
        entries: entries.slice(0, LIST_SHOWN),
        more: Math.max(0, entries.length - LIST_SHOWN),
      });
    } else {
      out.push({ key: f.key, label: f.label ?? f.key, kind: 'value', value: String(v) });
    }
  }
  for (const [key, v] of Object.entries(cfg ?? {})) {
    if (seen.has(key) || v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) {
      const entries = v.map(String);
      out.push({
        key,
        label: key,
        kind: 'list',
        count: entries.length,
        entries: entries.slice(0, LIST_SHOWN),
        more: Math.max(0, entries.length - LIST_SHOWN),
      });
    } else if (typeof v === 'object') {
      out.push({ key, label: key, kind: 'json', value: JSON.stringify(v, null, 2) });
    } else {
      out.push({ key, label: key, kind: 'value', value: String(v) });
    }
  }
  return out;
}

/**
 * Where a walk has got to, in words, from the cursor the adapter keeps:
 * `{offset, total}` for one that walks a pool a few pages a run. Null for
 * a source that keeps no such cursor.
 */
export function progressOf(cursor, { runCount = 0, enabled = true } = {}) {
  const c = parseJson(cursor, {});
  const total = Number(c?.total);
  if (!Number.isFinite(total) || total <= 0) return null;
  const offset = Number(c?.offset) || 0;
  if (offset > 0) {
    return `${offset.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} pages read${enabled ? ', the rest a few hundred a minute' : ', paused'}`;
  }
  if (runCount > 0) return `all ${total.toLocaleString('en-US')} pages read`;
  return `${total.toLocaleString('en-US')} pages to read, not started`;
}
