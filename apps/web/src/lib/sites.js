import { config } from '@nichedb/config';
import { normaliseItem } from '@nichedb/core/adapter';
import { makeHttp } from '@nichedb/core/http';
import {
  AGENT,
  fit,
  KINDS,
  LIST_MAX,
  parseUrlList,
  publicWebUrl,
  readUrl,
  recordItem,
  recordPath,
  urlsForPath,
  webUrl,
} from '@nichedb/core/opensite';
import { offersFromRecord } from '@nichedb/core/products';
import { keepOffers } from '@nichedb/db/products';
import * as q from '@nichedb/db/queries';
import { canAddSources, Denied, isAdmin } from './service.js';

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
/** Where records a crawler read itself land: POST /api/v1/sites/records. */
export const CRAWLER_SOURCE = 'pit-crawler';
/** Records per push. A crawler sends batches; a bigger body is refused, not cut. */
export const RECORDS_MAX = 200;
const STATUSES = new Set(['live', 'gone', 'moved', 'blocked']);

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
  await q.upsertItems({
    collectionId: collection.id,
    sourceId: source.id,
    items: [item],
  });
  const kept = await q.itemByUrls({
    collectionId: collection.id,
    urls: [record.canonical],
  });
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

const clip = (value, max) => {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
const words = (list, max, len = 40) =>
  (Array.isArray(list) ? list : [])
    .map((t) => clip(String(t ?? ''), len).toLowerCase())
    .filter(Boolean)
    .slice(0, max);

const positive = (v) => (Number.isInteger(v) && v > 0 && v < 100_000 ? v : null);
/** A list of media references, each with a public address, at most `max`. */
const mediaRefs = (list, max, shape) =>
  (Array.isArray(list) ? list : [])
    .filter((m) => m && typeof m === 'object')
    .map(shape)
    .filter((m) => m.url)
    .slice(0, max);

/**
 * One pushed record as the row it becomes, or the reason it is refused.
 *
 * The crawler read the page, so nothing is fetched here; what is checked is
 * that the record is one this index would have drawn itself: a public web
 * address, a known kind and status, within the spec's size. What the crawler
 * learned on top (language, keywords, an excerpt of the text, links counted)
 * rides along under `data.enrichment`, and the keywords become `topic:` tags
 * and the excerpt the summary when the page has no description, because the
 * search column is made of title, summary and tags.
 */
export function crawledItem(entry, { now = new Date() } = {}) {
  const record = entry?.record ?? entry;
  if (!record || typeof record !== 'object') return { error: 'not a record' };
  const canonical = publicWebUrl(record.canonical ?? record.url);
  if (!canonical) return { error: 'canonical is not a public web address' };
  const url = publicWebUrl(record.url) ?? canonical;
  const enrichment =
    entry?.enrichment && typeof entry.enrichment === 'object' ? entry.enrichment : {};
  const kept = fit({
    ...record,
    opensite: String(record.opensite ?? '0.1'),
    url,
    canonical,
    kind: KINDS.includes(record.kind) ? record.kind : 'page',
    title: clip(record.title, 300),
    description: clip(record.description, 1000) || null,
    status: STATUSES.has(record.status) ? record.status : 'live',
    source: 'read',
    tags: words(record.tags, 20),
    fetched_at: Number.isNaN(Date.parse(record.fetched_at)) ? now.toISOString() : record.fetched_at,
  });
  const item = recordItem(kept);
  if (!item) return { error: 'no canonical address' };
  const keywords = words(enrichment.keywords, 20);
  const language = clip(enrichment.language, 12).toLowerCase();
  const excerpt = clip(enrichment.excerpt, 1000);
  const extra = {
    language: language || null,
    keywords,
    excerpt: excerpt || null,
    words: Number.isFinite(enrichment.words) ? enrichment.words : null,
    links: Number.isFinite(enrichment.links) ? enrichment.links : null,
    rendered: enrichment.rendered === true,
    depth: Number.isFinite(enrichment.depth) ? enrichment.depth : null,
    crawler: clip(enrichment.crawler, 80) || null,
    // What the page shows, by reference (the crawler never stores the files).
    images: mediaRefs(enrichment.images, 20, (m) => ({
      url: publicWebUrl(m.url),
      alt: clip(m.alt, 300),
      width: positive(m.width),
      height: positive(m.height),
    })),
    videos: mediaRefs(enrichment.videos, 10, (m) => ({
      url: publicWebUrl(m.url),
      title: clip(m.title, 300),
      thumbnail: m.thumbnail ? publicWebUrl(m.thumbnail) : null,
      provider: clip(m.provider, 40) || null,
    })),
  };
  const row = normaliseItem({
    ...item,
    summary: item.summary || excerpt || null,
    tags: [
      ...item.tags,
      language ? `lang:${language}` : null,
      extra.rendered ? 'rendered' : null,
      'crawled',
      ...keywords.map((k) => `topic:${k}`),
    ].filter((t, i, all) => t && all.indexOf(t) === i),
    data: { ...item.data, enrichment: extra },
  });
  if (!row) return { error: 'no title or address' };
  // The crawler's hash is of the page text, so a re-crawl of an unchanged page writes nothing
  // (the upsert skips a row whose hash is the same); fetched_at alone is not a change.
  const hash = clip(enrichment.hash, 128);
  if (hash) row.contentHash = `crawl:${hash}`;
  return { item: row };
}

/**
 * Keep records a crawler already read: admins only (an admin API key is how a
 * crawler signs in), at most RECORDS_MAX a call, each validated on its own so
 * one bad record never sinks the batch. Upserted by canonical address into
 * the crawler source, so a re-crawl updates the row and an unchanged page
 * (same hash) writes nothing.
 */
export async function keepCrawled({ user, records }) {
  if (!user) throw new Denied('Sign in with an API key to push records.', 401);
  if (!isAdmin(user)) throw new Denied('Pushing crawled records is for the index operators.', 403);
  if (!Array.isArray(records) || records.length === 0)
    throw new Denied('send { "records": [ { "record": {…}, "enrichment": {…} } ] }', 400);
  if (records.length > RECORDS_MAX)
    throw new Denied(
      `At most ${RECORDS_MAX} records a call; send ${records.length} as batches.`,
      413,
    );
  const [collection, source] = await Promise.all([
    q.getCollection(COLLECTION),
    q.getSource(CRAWLER_SOURCE),
  ]);
  if (!collection || !source)
    throw new Denied('The crawler source is not set up on this deployment yet.', 503);
  const items = [];
  const rejected = [];
  const pages = [];
  records.forEach((entry, index) => {
    const out = crawledItem(entry);
    if (out.item) {
      items.push(out.item);
      pages.push(entry?.record ?? entry);
    } else rejected.push({ index, error: out.error });
  });
  const { added, updated } = items.length
    ? await q.upsertItems({
        collectionId: collection.id,
        sourceId: source.id,
        items,
      })
    : { added: 0, updated: 0 };
  const products = await keepProductOffers(pages);
  return {
    accepted: items.length,
    added,
    updated,
    unchanged: items.length - added - updated,
    rejected,
    products,
  };
}

/**
 * The product graph's share of a push: the offers each accepted page states in
 * its Product JSON-LD (core/products.js). Pages are replaced as sets, so a page
 * that stopped stating an offer loses it. Never fails the push: the sites rows
 * are the contract with the crawler, the graph is derived from them and the
 * backfill script can rebuild it.
 */
export async function keepProductOffers(pages, { keep = keepOffers } = {}) {
  const read = [];
  const offers = [];
  for (const record of pages) {
    const canonical = publicWebUrl(record?.canonical ?? record?.url);
    if (!canonical) continue;
    const found = offersFromRecord({ ...record, canonical });
    // A page with no product JSON-LD and no kind 'product' never held offers; skip its delete.
    if (found.length === 0 && record?.kind !== 'product') continue;
    read.push(canonical);
    offers.push(...found);
  }
  if (read.length === 0) return { offers: 0, removed: 0 };
  try {
    const { kept, removed } = await keep({ pages: read, offers });
    return { offers: kept, removed };
  } catch (err) {
    console.error(`product graph: ${err?.message ?? err}`);
    return { offers: 0, removed: 0, error: 'product graph write failed' };
  }
}
