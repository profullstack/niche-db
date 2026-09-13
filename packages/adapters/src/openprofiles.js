import { defineAdapter } from '@nichedb/core/adapter';
import { parseOpenProfile } from '@profullstack/openprofile';

/**
 * People, read off the apps that serve their OpenProfile.md.
 *
 * An app that hosts profiles (p0dcasters for podcasters, OutreachGraph for
 * the public part of a CRM, rssamplifier for authors) lists them at one
 * endpoint and serves each document at a stable URL next to the page. This
 * adapter pages the listing, fetches every document that changed since the
 * last run, and hands each one on as an item whose `data.doc` is the file
 * as served. The core's ingest recognises this adapter and absorbs those
 * documents into the `profiles` tables (matching by account URL, never by
 * name, and never over an owner's edits) before writing one row per person
 * to the collection.
 *
 * ORIGIN IS THE PROOF
 *
 * A document is believed only when its URL shares a host with the listing
 * that named it. A listing that points at a document on another host is
 * pointing at somebody else's claim and is dropped with a note in the log.
 *
 * THE LISTING
 *
 *   GET <url>?since=<ISO>&limit=<n>&cursor=<opaque>
 *   { "openprofiles": [ { "id", "name", "url", "page", "updatedAt", "accounts", "web" } ],
 *     "next": "<cursor>" | null }
 *
 * A listing that is not there yet (404) is an empty page, not a failure:
 * the apps and this directory ship independently.
 */

const hostOf = (url) => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
};

/** The app's name for attribution: the listing's host without its suffix, `p0dcasters`. */
export function appOf(listingUrl) {
  const host = hostOf(listingUrl);
  if (!host) return 'unknown';
  const parts = host.split('.');
  return parts.length > 2 ? parts.slice(-2, -1)[0] : parts[0];
}

/** True when the document is served from the host that listed it, or a subdomain either way. */
export function sameOrigin(listingUrl, docUrl) {
  const a = hostOf(listingUrl);
  const b = hostOf(docUrl);
  return Boolean(a && b && (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`)));
}

/** One listing page's entries as the shape the adapter walks; tolerant of a bare array. */
export function parseListing(body) {
  const list = Array.isArray(body)
    ? body
    : Array.isArray(body?.openprofiles)
      ? body.openprofiles
      : [];
  const entries = list
    .filter((e) => e && typeof e.url === 'string' && /^https?:\/\//.test(e.url))
    .map((e) => ({
      id: e.id == null ? null : String(e.id),
      name: typeof e.name === 'string' ? e.name : null,
      url: e.url,
      page: typeof e.page === 'string' ? e.page : null,
      updatedAt: typeof e.updatedAt === 'string' ? e.updatedAt : null,
    }));
  const next = typeof body?.next === 'string' && body.next ? body.next : null;
  return { entries, next };
}

/** A fetched document as the item the core absorbs. Null when it is not a profile. */
export function docItem({ listingUrl, entry, doc, fetchedAt }) {
  const parsed = parseOpenProfile(doc);
  const name = parsed.name ?? entry.name;
  if (!name) return null;
  return {
    externalId: entry.url.slice(0, 500),
    kind: 'openprofile',
    title: name,
    summary: parsed.headline ?? null,
    url: entry.page ?? entry.url,
    publishedAt: entry.updatedAt ?? fetchedAt,
    timeKnown: true,
    precision: 'minute',
    tags: ['openprofile', `from:${appOf(listingUrl)}`],
    data: {
      app: appOf(listingUrl),
      listing: listingUrl,
      source_url: entry.url,
      page_url: entry.page ?? null,
      updated_at: entry.updatedAt ?? null,
      fetched_at: fetchedAt,
      doc,
    },
  };
}

function pageUrl(listingUrl, { since, cursor, limit }) {
  const u = new URL(listingUrl);
  if (cursor) u.searchParams.set('cursor', cursor);
  else if (since) u.searchParams.set('since', since);
  u.searchParams.set('limit', String(limit));
  return u.href;
}

export const openprofiles = defineAdapter({
  name: 'openprofiles',
  title: 'OpenProfile listings',
  collection: 'profiles',
  description:
    'People, read off the apps that serve their OpenProfile.md (logicsrc.com/openprofile): each listing endpoint is paged for what changed, every document is fetched from the same host that listed it, and the documents are merged into one profile per person by account URL, never by name. What an owner has edited here is never overwritten by a pull. Keyless.',
  docs: 'https://logicsrc.com/docs/openprofile',
  kinds: ['person'],
  cadenceMinutes: 60,
  configFields: [
    {
      key: 'urls',
      label: 'Listings',
      type: 'list',
      help: 'Listing endpoints, one per app: https://p0dcasters.com/api/openprofiles',
      placeholder: 'https://p0dcasters.com/api/openprofiles',
    },
  ],
  defaults: { urls: [] },
  defaultSources: [
    {
      slug: 'openprofiles',
      name: 'People: OpenProfiles served by p0dcasters and OutreachGraph',
      description:
        'Podcasters from p0dcasters.com and the public profiles from outreachgraph.com, each read from the OpenProfile.md the app serves next to the page, merged into one entry per person.',
      config: {
        urls: [
          'https://p0dcasters.com/api/openprofiles',
          'https://outreachgraph.com/api/v1/openprofiles',
        ],
      },
      enabled: true,
    },
  ],
  async pull({ config, cursor, http, log, deadline }) {
    const listings = (
      Array.isArray(config.urls) ? config.urls : String(config.urls ?? '').split(',')
    )
      .map((s) => String(s).trim())
      .filter((s) => /^https?:\/\//.test(s))
      .slice(0, 50);
    if (listings.length === 0) {
      log('no listings configured');
      return { items: [], note: 'no listings configured' };
    }
    const since = { ...(cursor?.since ?? {}) };
    const items = [];
    const notes = [];
    for (const listing of listings) {
      if (Date.now() > deadline) break;
      const app = appOf(listing);
      let next = null;
      let pages = 0;
      let fetched = 0;
      let rejected = 0;
      let newest = since[listing] ?? null;
      const startedFrom = since[listing] ?? null;
      try {
        do {
          const body = await http.jsonOrNull(
            pageUrl(listing, { since: startedFrom, cursor: next, limit: 200 }),
            {
              timeoutMs: 20_000,
            },
          );
          if (body === null) {
            notes.push(`${app}: listing not there yet (404)`);
            break;
          }
          const page = parseListing(body);
          pages += 1;
          for (const entry of page.entries) {
            if (Date.now() > deadline) break;
            if (!sameOrigin(listing, entry.url)) {
              rejected += 1;
              continue;
            }
            try {
              const doc = await http.text(entry.url, {
                timeoutMs: 15_000,
                headers: { accept: 'text/markdown, text/plain, */*' },
              });
              const fetchedAt = new Date().toISOString();
              const item = docItem({ listingUrl: listing, entry, doc, fetchedAt });
              if (item) {
                items.push(item);
                fetched += 1;
                if (entry.updatedAt && (!newest || entry.updatedAt > newest))
                  newest = entry.updatedAt;
              }
            } catch (err) {
              log(`${app}: ${entry.url} ${String(err.message).slice(0, 60)}`);
            }
          }
          next = page.next;
        } while (next && pages < 50 && Date.now() < deadline);
        if (newest) since[listing] = newest;
        notes.push(
          `${app}: ${fetched} documents${rejected ? `, ${rejected} off-origin dropped` : ''}`,
        );
      } catch (err) {
        notes.push(`${app}: ${String(err.message).slice(0, 60)}`);
      }
    }
    log(notes.join('; '));
    return { items, cursor: { since }, note: notes.join('; ') };
  },
});
