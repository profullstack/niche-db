import { config } from '@nichedb/config';
import { normaliseItem } from '@nichedb/core/adapter';
import { makeHttp } from '@nichedb/core/http';
import {
  AGENT,
  LIST_MAX,
  parseUrlList,
  readUrl,
  recordItem,
  recordPath,
  urlsForPath,
  webUrl,
} from '@nichedb/core/opensite';
import * as q from '@nichedb/db/queries';
import { canAddSources, Denied } from './service.js';

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

/** Pages a bulk source reads per run; the worker runs it again a minute later until done. */
export const BULK_PAGES_PER_RUN = 250;
/** A list is read again this often once it has been walked: a month. */
export const BULK_CADENCE_MINUTES = 30 * 24 * 60;

/**
 * A pasted list of addresses, up to ten thousand, as a source of its own.
 *
 * Reading ten thousand pages is hours of work, not a request, so the list
 * becomes a source of the `opensite` adapter: the worker walks it a few
 * hundred pages a run, a minute apart, and the source's own page shows how
 * far it has got. It is the submitter's source, so they can pause it, and
 * it is read again a month later so the records stay current. Making the
 * deployment fetch on a schedule is gated the way every source is.
 */
export async function submitBulk({ user, text, name = '' }) {
  if (!user)
    throw new Denied('Sign in to submit a list; one address at a time needs no account.', 401);
  if (!(await canAddSources(user)))
    throw new Denied('Your plan does not include sources of your own.', 403);
  const { urls, rejected, dropped } = parseUrlList(text, LIST_MAX);
  if (urls.length === 0) throw new Denied('No web address in that list.', 400);
  const collection = await q.getCollection(COLLECTION);
  if (!collection) throw new Denied('The sites index is not set up on this deployment.', 503);
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const slug = `sites-bulk-${Math.random().toString(36).slice(2, 10)}`;
  const label = String(name ?? '')
    .trim()
    .slice(0, 80);
  const source = await q.insertSource({
    collectionId: collection.id,
    adapter: 'opensite',
    slug,
    name: label
      ? `${label} (${urls.length} addresses)`
      : `${urls.length} addresses pasted ${stamp}`,
    description: `A list of ${urls.length} addresses pasted at /c/sites/add on ${stamp}, read ${BULK_PAGES_PER_RUN} pages a run until done, then once a month.`,
    config: { urls, sitemaps: [], pages: BULK_PAGES_PER_RUN },
    cadenceMinutes: BULK_CADENCE_MINUTES,
    ownerId: user.id,
    enabled: true,
  });
  await q.requestRun(source.id);
  return { source, queued: urls.length, rejected, dropped, page: `/s/${slug}` };
}

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
