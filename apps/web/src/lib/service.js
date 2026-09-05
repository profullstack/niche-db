import { config } from '@nichedb/config';
import { adapterByName, slugify } from '@nichedb/core';
import * as q from '@nichedb/db/queries';
import { enricherByName } from '@nichedb/enrichers';

/**
 * The operations the pages, the API and the MCP tools share, with the rules
 * about who may do them in one place.
 */

export class Denied extends Error {
  constructor(message, status = 403) {
    super(message);
    this.status = status;
  }
}

export const isAdmin = (user) => user?.role === 'admin';

export async function isPro(user) {
  if (!user?.id) return false;
  if (isAdmin(user)) return true;
  return Boolean(await q.activeMembership(user.id));
}

/** Adding a source makes the deployment fetch on a schedule; that is gated. */
export async function canAddSources(user) {
  if (!user) return false;
  if (isAdmin(user) || config.openSources) return true;
  return isPro(user);
}

export function canEditSource(user, source) {
  if (!user) return false;
  return isAdmin(user) || (source.owner_id && source.owner_id === user.id);
}

export function canEditFeed(user, feed) {
  if (!user) return false;
  return isAdmin(user) || (feed.owner_id && feed.owner_id === user.id);
}

/** Coerce a submitted config to what the adapter's fields describe. */
export function coerceConfig(adapter, raw = {}) {
  const out = {};
  for (const f of adapter.configFields ?? []) {
    let v = raw[f.key];
    if (v === undefined || v === null || v === '') {
      if (f.required && adapter.defaults?.[f.key] === undefined)
        throw new Denied(`${f.label} is required`, 400);
      continue;
    }
    if (f.type === 'list') {
      v = (Array.isArray(v) ? v : String(v).split(/[,\n]/))
        .map((s) => String(s).trim())
        .filter(Boolean);
    } else if (f.type === 'number') {
      v = Number(v);
      if (!Number.isFinite(v)) throw new Denied(`${f.label} must be a number`, 400);
    } else if (f.type === 'select') {
      v = String(v);
      if (f.options && !f.options.includes(v))
        throw new Denied(`${f.label} must be one of ${f.options.join(', ')}`, 400);
    } else {
      v = String(v).slice(0, 500);
    }
    out[f.key] = v;
  }
  return out;
}

export async function addSource(
  user,
  { adapter: adapterName, collection, name, config: rawConfig, cadenceMinutes },
) {
  if (!(await canAddSources(user))) {
    throw new Denied('Adding a source needs an admin or Pro account on this deployment.');
  }
  const adapter = adapterByName(adapterName);
  if (!adapter) throw new Denied(`No adapter named ${adapterName}`, 400);
  const col = await q.getCollection(collection || adapter.collection);
  if (!col) throw new Denied(`No collection named ${collection}`, 400);
  const cfg = coerceConfig(adapter, rawConfig ?? {});
  const title = String(name ?? '').trim() || `${adapter.title} (${user.email})`;
  const base = slugify(title) || adapter.name;
  let slug = base;
  for (let n = 2; await q.getSource(slug); n++) slug = `${base}-${n}`;
  const cadence = Math.max(5, Math.min(Number(cadenceMinutes) || adapter.cadenceMinutes, 1440));
  return q.insertSource({
    collectionId: col.id,
    adapter: adapter.name,
    slug,
    name: title.slice(0, 120),
    description: adapter.description,
    config: cfg,
    cadenceMinutes: cadence,
    ownerId: user.id,
  });
}

export async function editSource(user, source, patch) {
  if (!canEditSource(user, source)) throw new Denied('Not your source.');
  const adapter = adapterByName(source.adapter);
  const out = {};
  if (patch.name !== undefined) out.name = String(patch.name).trim().slice(0, 120) || undefined;
  if (patch.description !== undefined) out.description = String(patch.description).slice(0, 1000);
  if (patch.config !== undefined && adapter) out.config = coerceConfig(adapter, patch.config);
  if (patch.cadenceMinutes !== undefined) {
    out.cadenceMinutes = Math.max(5, Math.min(Number(patch.cadenceMinutes) || 60, 1440));
  }
  if (patch.enabled !== undefined) out.enabled = Boolean(patch.enabled);
  return q.updateSource({ id: source.id, ...out });
}

export function normaliseQuery(raw = {}) {
  const arr = (v) =>
    (Array.isArray(v) ? v : String(v ?? '').split(','))
      .map((s) => String(s).trim())
      .filter(Boolean)
      .slice(0, 20);
  const out = {};
  const sources = arr(raw.sources);
  const kinds = arr(raw.kinds);
  const tags = arr(raw.tags).map((t) => t.toLowerCase());
  const text = String(raw.q ?? '')
    .trim()
    .slice(0, 200);
  if (sources.length) out.sources = sources;
  if (kinds.length) out.kinds = kinds;
  if (tags.length) out.tags = tags;
  if (text) out.q = text;
  if (
    raw.upcoming === true ||
    raw.upcoming === 'on' ||
    raw.upcoming === '1' ||
    raw.upcoming === 'true'
  ) {
    out.upcoming = true;
  }
  // Enrichers: absent means the collection's defaults; a list (even empty) is explicit.
  if (raw.enrichers !== undefined && raw.enrichers !== null) {
    out.enrichers = arr(raw.enrichers).filter((n) => enricherByName(n));
  }
  return out;
}

export async function createFeed(user, { collection, name, description, query, isPublic }) {
  if (!user) throw new Denied('Sign in to create a feed.', 401);
  const col = await q.getCollection(collection);
  if (!col) throw new Denied(`No collection named ${collection}`, 400);
  if (!isAdmin(user) && !(await isPro(user))) {
    const n = await q.countUserFeeds(user.id);
    if (n >= config.feeds.freeLimit) {
      throw new Denied(`Free accounts can keep ${config.feeds.freeLimit} feeds. Pro lifts that.`);
    }
  }
  const title = String(name ?? '').trim();
  if (!title) throw new Denied('A feed needs a name', 400);
  const base = slugify(title) || 'feed';
  let slug = base;
  for (let n = 2; await q.getFeed(slug); n++) slug = `${base}-${n}`;
  const feed = await q.insertFeed({
    collectionId: col.id,
    slug,
    name: title.slice(0, 120),
    description: description ? String(description).slice(0, 1000) : null,
    ownerId: user.id,
    query: normaliseQuery(query ?? {}),
    isPublic: isPublic !== false && isPublic !== 'false' && isPublic !== '0',
  });
  // A new feed delivers from now, not from history.
  await q.setFeedScanCursor(feed.id, await q.maxItemId());
  return feed;
}

export async function editFeed(user, feed, patch) {
  if (!canEditFeed(user, feed)) throw new Denied('Not your feed.');
  const out = { id: feed.id };
  if (patch.name !== undefined) out.name = String(patch.name).trim().slice(0, 120) || undefined;
  if (patch.description !== undefined) out.description = String(patch.description).slice(0, 1000);
  if (patch.query !== undefined) out.query = normaliseQuery(patch.query);
  if (patch.isPublic !== undefined) out.isPublic = Boolean(patch.isPublic);
  return q.updateFeed(out);
}
