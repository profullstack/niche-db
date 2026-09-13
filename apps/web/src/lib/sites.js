import { config } from '@nichedb/config';
import { normaliseItem } from '@nichedb/core/adapter';
import { makeHttp } from '@nichedb/core/http';
import {
  AGENT,
  readUrl,
  recordItem,
  recordPath,
  urlsForPath,
  webUrl,
} from '@nichedb/core/opensite';
import * as q from '@nichedb/db/queries';
import { Denied } from './service.js';

/**
 * The operations behind /c/sites, shared by the page, the API and the MCP
 * tool: read one address now and keep the record, and find the record a
 * path stands for. The reading is core's; this is where it meets the table.
 *
 * A record read here lands in the `sites-pasted` source, the one the
 * `opensite` adapter seeds with nothing to pull, so the index knows which
 * pages people asked about by hand and which it walked on its own.
 */

export const COLLECTION = 'sites';
export const PASTED_SOURCE = 'sites-pasted';

/** How stale a kept record may be before an ask reads the page again. */
export const FRESH_MS = 60 * 60 * 1000;

const http = () => makeHttp({ userAgent: `${AGENT} ${config.siteUrl}` });

export const pathOf = (record) => `/c/sites/${recordPath(record.canonical)}`;

/** The record an item row carries, with where it lives on this index. */
export function siteOut(item) {
  const record = item?.data?.record ?? null;
  if (!record) return null;
  return {
    ...record,
    path: pathOf(record),
    page: `${config.siteUrl}${pathOf(record)}`,
    id: item.id,
  };
}

/** The kept record for an address, or null. Tries the canonical and the asked form. */
export async function findByUrl(url) {
  const asked = webUrl(url);
  if (!asked) return null;
  const collection = await q.getCollection(COLLECTION);
  if (!collection) return null;
  const withoutHash = asked;
  const candidates = [...new Set([withoutHash, withoutHash.replace(/\/$/, ''), `${withoutHash}/`])];
  return q.itemByUrls({ collectionId: collection.id, urls: candidates });
}

/** The kept record a /c/sites/<host>/<path> stands for, or null. */
export async function findByPath(rest) {
  const urls = urlsForPath(rest);
  if (urls.length === 0) return null;
  const collection = await q.getCollection(COLLECTION);
  if (!collection) return null;
  return q.itemByUrls({ collectionId: collection.id, urls });
}

/** Everything kept for one host, newest first. */
export async function listForHost(host, { limit = 50 } = {}) {
  const collection = await q.getCollection(COLLECTION);
  if (!collection) return [];
  return q.itemsForHost({ collectionId: collection.id, host, limit });
}

/**
 * Read an address now, as the spec says, and keep the record. The read is
 * bounded by the reader's own limits; a page that cannot be read is a
 * record that says so, and is kept too, so a dead link stays known.
 */
export async function readAndKeep(url, { fetcher = null } = {}) {
  const asked = webUrl(url);
  if (!asked) throw new Denied('That is not a web address this can read.', 400);
  const [collection, source] = await Promise.all([
    q.getCollection(COLLECTION),
    q.getSource(PASTED_SOURCE),
  ]);
  if (!collection || !source)
    throw new Denied('The sites index is not set up on this deployment.', 503);
  const record = await readUrl(asked, { http: fetcher ?? http() });
  if (!record) throw new Denied('That address could not be read.', 422);
  const item = normaliseItem(recordItem(record));
  await q.upsertItems({ collectionId: collection.id, sourceId: source.id, items: [item] });
  const kept = await q.itemByUrls({ collectionId: collection.id, urls: [record.canonical] });
  return { record, item: kept, path: pathOf(record) };
}

/**
 * The record for an address: what is kept when it is fresh, else read now.
 * `force` reads regardless, which is what the paste page and POST do.
 */
export async function recordFor(url, { force = false, fetcher = null } = {}) {
  const kept = force ? null : await findByUrl(url);
  if (kept && Date.now() - new Date(kept.updated_at).getTime() < FRESH_MS) {
    const record = kept.data?.record;
    if (record) return { record, item: kept, path: pathOf(record), fresh: true };
  }
  return { ...(await readAndKeep(url, { fetcher })), fresh: false };
}
