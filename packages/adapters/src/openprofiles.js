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
  cadenceMinutes: 15,
  /** A run may take this long: a walk of a hundred thousand documents needs more than the four minutes a run usually gets. */
  budgetMs: 20 * 60_000,
  configFields: [
    {
      key: 'urls',
      label: 'Listings',
      type: 'list',
      help: 'Listing endpoints, one per app: https://p0dcasters.com/api/openprofiles',
      placeholder: 'https://p0dcasters.com/api/openprofiles',
    },
  ],
  // Documents are fetched `concurrency` at a time, each with its own short
  // timeout, until `budgetMs` runs out; the apps that meter callers by the
  // minute (p0dcasters answers 402 past its allowance) are the reason for
  // `paceMs`, a pause per worker between fetches, off by default.
  defaults: { urls: [], concurrency: 8, timeoutMs: 5_000, budgetMs: 20 * 60_000, paceMs: 0 },
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
          'https://rssamplifier.com/api/openprofiles',
        ],
      },
      cadenceMinutes: 15,
      enabled: true,
      // The listings are house apps and this seed is their source of truth:
      // a new listing or cadence here reaches the row on the next boot.
      refresh: true,
    },
  ],
  async pull({ config, cursor, http, log }) {
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
    const concurrency = Math.max(1, Math.min(Number(config.concurrency) || 8, 32));
    const timeoutMs = Math.max(1_000, Number(config.timeoutMs) || 5_000);
    const budgetMs = Math.max(500, Number(config.budgetMs) || 20 * 60_000);
    const paceMs = Math.max(0, Number(config.paceMs) || 0);
    const stop = Date.now() + budgetMs;

    /*
     * What the cursor remembers per listing. `resume` is where a cut walk
     * stopped: the page it was on and when the pass began. `since` is the
     * start time of the last pass that FINISHED, and is what the next pass
     * asks the listing for; `complete` says one ever finished. Paging is by
     * the listing's own cursor, never by `updatedAt`, so a listing whose
     * entries all carry one timestamp (p0dcasters stamps every show with the
     * weekly reload) is walked once, page by page, and never re-read in a
     * loop. A since left behind by an unfinished walk is not trusted: that
     * listing is walked in full once.
     */
    const since = { ...(cursor?.since ?? {}) };
    const complete = { ...(cursor?.complete ?? {}) };
    const resume = { ...(cursor?.resume ?? {}) };
    const items = [];
    const notes = [];
    const stats = { fetched: 0, skipped: 0, throttled: 0, pages: 0 };

    for (const listing of listings) {
      if (Date.now() > stop) break;
      const app = appOf(listing);
      const resuming = resume[listing] && typeof resume[listing] === 'object';
      const incremental = !resuming && complete[listing] === true && Boolean(since[listing]);
      let pageCursor = resuming ? resume[listing].at || null : null;
      const startedAt = resuming ? resume[listing].startedAt : new Date().toISOString();
      let pages = 0;
      let fetched = 0;
      let skipped = 0;
      let throttled = 0;
      let cut = false;
      let stopped = null;

      try {
        do {
          let body;
          try {
            body = await http.jsonOrNull(
              pageUrl(listing, {
                since: incremental ? since[listing] : null,
                cursor: pageCursor,
                limit: 500,
              }),
              { timeoutMs: 20_000 },
            );
          } catch (err) {
            // A listing that stops answering mid-walk (a 402 past its
            // allowance, a 5xx) is a cut, not a failure: the walk keeps its
            // place and asks again soon. One that never answered is an error.
            if (pages === 0 && fetched === 0) throw err;
            stopped = String(err.message).slice(0, 60);
            cut = true;
            break;
          }
          if (body === null) {
            notes.push(`${app}: listing not there yet (404)`);
            stopped = 'missing';
            break;
          }
          const page = parseListing(body);
          const entries = page.entries.filter((e) => {
            if (sameOrigin(listing, e.url)) return true;
            skipped += 1;
            return false;
          });

          // The page's documents, `concurrency` at a time, until the budget is spent.
          let next = 0;
          let pageThrottled = 0;
          const worker = async () => {
            while (next < entries.length) {
              if (Date.now() > stop) return;
              const entry = entries[next++];
              try {
                if (paceMs) await new Promise((r) => setTimeout(r, paceMs));
                const doc = await http.text(entry.url, {
                  timeoutMs,
                  headers: { accept: 'text/markdown, text/plain, */*' },
                });
                const item = docItem({
                  listingUrl: listing,
                  entry,
                  doc,
                  fetchedAt: new Date().toISOString(),
                });
                if (item) {
                  items.push(item);
                  fetched += 1;
                } else skipped += 1;
              } catch (err) {
                const msg = String(err?.message ?? err);
                if (/^(402|429) /.test(msg)) {
                  throttled += 1;
                  pageThrottled += 1;
                } else {
                  skipped += 1;
                  log(`${app}: ${entry.url} ${msg.slice(0, 60)}`);
                }
              }
            }
          };
          await Promise.all(
            Array.from({ length: Math.min(concurrency, entries.length || 1) }, worker),
          );

          if (next < entries.length) {
            // The budget ran out inside this page: resume from this page, so the
            // documents after the cut are fetched next time (twice is a no-op).
            cut = true;
            stopped = 'budget';
            break;
          }
          if (pageThrottled > 0 && pageThrottled * 4 >= Math.max(1, entries.length)) {
            // A quarter of a page refused: the app is metering us. Keep the
            // page, come back in two minutes rather than burn the allowance.
            cut = true;
            stopped = `throttled (${pageThrottled} of ${entries.length})`;
            break;
          }
          pages += 1;
          pageCursor = page.next;
        } while (pageCursor && Date.now() < stop);

        if (stopped === 'missing') continue;
        if (!cut && pageCursor) {
          cut = true;
          stopped = 'budget';
        }
        stats.fetched += fetched;
        stats.skipped += skipped;
        stats.throttled += throttled;
        stats.pages += pages;
        if (cut) {
          resume[listing] = { at: pageCursor ?? '', startedAt };
          notes.push(
            `${app}: ${fetched} fetched, ${skipped} skipped, ${throttled} throttled, ${pages} pages, cut by ${stopped}, cursor at ${pageCursor ? pageCursor.slice(0, 24) : 'first page'}, resuming in 2 minutes`,
          );
        } else {
          delete resume[listing];
          complete[listing] = true;
          since[listing] = startedAt;
          notes.push(
            `${app}: ${fetched} fetched, ${skipped} skipped, ${throttled} throttled, ${pages} pages, pass complete, since ${startedAt}`,
          );
        }
      } catch (err) {
        notes.push(`${app}: ${String(err.message).slice(0, 60)}`);
      }
    }
    const pending = Object.keys(resume).length > 0;
    const note = notes.join('; ');
    log(
      `${stats.fetched} fetched, ${stats.skipped} skipped, ${stats.throttled} throttled over ${stats.pages} pages; ${note}`,
    );
    return {
      items,
      cursor: { since, complete, resume },
      note,
      ...(pending ? { nextInMinutes: 2 } : {}),
    };
  },
});
