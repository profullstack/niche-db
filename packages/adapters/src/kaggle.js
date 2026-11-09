import { defineAdapter, slugify } from '@nichedb/core/adapter';

/**
 * Public datasets on Kaggle, from Kaggle's own keyless API.
 *
 * `GET /api/v1/datasets/list` is the endpoint the official `kaggle` CLI calls; it
 * answers without a token, twenty rows a page (`pageSize` is ignored), and stops
 * answering somewhere between page 500 and page 1,000, so no single query reaches
 * the whole catalogue. Two walks cover what matters: `updated` (newest change
 * first, walked back to where the last run stopped) and `votes` (the catalogue's
 * best known datasets, re-read daily for their counts).
 *
 * This is a catalogue of listings, not a mirror: a row holds the title, owner,
 * licence, size, counts and tags and links back to the Kaggle page. No data file
 * is fetched or stored.
 *
 * Most new uploads are machine-generated (`xa-sleeve-add-l3-...-20261109`, no
 * subtitle, no description). Kaggle scores each dataset's documentation as
 * `usabilityRating` (0 to 1); those uploads score 0.25, so rows below
 * `minUsability` (default 0.5) are skipped.
 */

const API = 'https://www.kaggle.com/api/v1/datasets/list';
const SORTS = ['updated', 'published', 'votes', 'hottest', 'active'];
// Kaggle stops paging before page 1,000.
const PAGE_CAP = 500;

const clean = (s) => {
  const t = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t || null;
};
const num = (v) => (Number.isFinite(v) ? v : null);
const when = (s) => {
  const d = s ? new Date(s) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
};

/** One dataset as the list API serves it, or null when it is private, unnamed or below the bar. */
export function toItem(d, { minUsability = 0 } = {}) {
  const ref = clean(d?.ref);
  const title = clean(d?.title) ?? ref;
  if (!ref || !ref.includes('/') || d.isPrivate) return null;
  const usability = num(d.usabilityRating);
  if (minUsability > 0 && (usability ?? 0) < minUsability) return null;
  const owner = clean(d.ownerRef) ?? ref.split('/')[0];
  const licence = clean(d.licenseName);
  const tags = (Array.isArray(d.tags) ? d.tags : [])
    .map((t) => slugify(clean(t?.ref) ?? clean(t?.name) ?? ''))
    .filter(Boolean)
    .slice(0, 15);
  const subtitle = clean(d.subtitle);
  const description = clean(d.description);
  return {
    externalId: `dataset:${ref}`,
    kind: 'dataset',
    title,
    summary: subtitle ?? description?.slice(0, 600) ?? null,
    url: `https://www.kaggle.com/datasets/${ref}`,
    imageUrl: /^https:\/\//.test(d.thumbnailImageUrl ?? '') ? d.thumbnailImageUrl : null,
    publishedAt: when(d.lastUpdated),
    tags: [
      'kaggle',
      'dataset',
      ...(licence ? [slugify(licence)] : []),
      ...(d.isFeatured ? ['featured'] : []),
      ...tags,
    ].filter(Boolean),
    data: {
      ref,
      owner,
      ownerName: clean(d.ownerName),
      creator: clean(d.creatorUrl),
      licence,
      bytes: num(d.totalBytes),
      version: num(d.currentVersionNumber),
      usability,
      votes: num(d.voteCount) ?? 0,
      downloads: num(d.downloadCount) ?? 0,
      views: num(d.viewCount) ?? 0,
      notebooks: num(d.kernelCount) ?? 0,
      discussions: num(d.topicCount) ?? 0,
      featured: d.isFeatured === true,
      kaggleId: num(d.id),
      updated: when(d.lastUpdated)?.toISOString() ?? null,
      credit: 'Kaggle public dataset listing',
    },
  };
}

export const kaggle = defineAdapter({
  name: 'kaggle',
  title: 'Kaggle datasets',
  collection: 'packages',
  description:
    'Public datasets on Kaggle: title, owner, licence, size, usability score, votes, downloads, notebooks and tags, from the keyless list API the kaggle CLI uses. Listings only, linking back to Kaggle; no data files are copied.',
  docs: 'https://github.com/Kaggle/kaggle-api',
  kinds: ['dataset'],
  cadenceMinutes: 30,
  budgetMs: 20 * 60_000,
  configFields: [
    {
      key: 'sort',
      label: 'Order',
      type: 'select',
      options: SORTS,
      required: true,
      help: 'updated walks back to the last run; the others re-read the first pages.',
    },
    { key: 'search', label: 'Search', placeholder: 'climate', help: 'Optional search term.' },
    {
      key: 'minUsability',
      label: 'Minimum usability',
      type: 'number',
      help: "Kaggle's 0-1 documentation score. 0.5 drops machine-generated uploads; 0 keeps everything.",
    },
    {
      key: 'maxPages',
      label: 'Pages per run',
      type: 'number',
      help: `Twenty datasets a page; Kaggle stops answering near page ${PAGE_CAP}.`,
    },
  ],
  defaults: { sort: 'updated', minUsability: 0.5, maxPages: 100 },
  defaultSources: [
    {
      slug: 'kaggle-datasets-updated',
      name: 'Kaggle: recently updated datasets',
      config: { sort: 'updated', minUsability: 0.5, maxPages: 100 },
    },
    {
      slug: 'kaggle-datasets-top',
      name: 'Kaggle: most voted datasets',
      config: { sort: 'votes', minUsability: 0, maxPages: PAGE_CAP },
      cadenceMinutes: 1440,
    },
  ],
  async *pull({ config, cursor, http, log, deadline }) {
    const sort = SORTS.includes(config.sort) ? config.sort : 'updated';
    const minUsability = Math.max(0, Math.min(1, Number(config.minUsability) || 0));
    const maxPages = Math.max(1, Math.min(PAGE_CAP, Number(config.maxPages) || 100));
    // Only the `updated` walk has an order a cursor can stop on.
    const since = sort === 'updated' ? when(cursor?.since) : null;
    let newest = since;
    let kept = 0;
    let read = 0;
    let pages = 0;
    let stop = '';
    for (let page = 1; page <= maxPages; page++) {
      if (deadline && Date.now() > deadline) {
        stop = 'deadline';
        break;
      }
      const params = new URLSearchParams({ sortBy: sort, page: String(page) });
      if (config.search) params.set('search', String(config.search));
      let rows;
      try {
        rows = await http.json(`${API}?${params}`, { timeoutMs: 10_000 });
      } catch (err) {
        // After ~60 quick pages Kaggle answers 404 (a throttle, not a missing page).
        // Keep what this run read; the first page failing is still a real failure.
        if (page === 1) throw err;
        stop = `stopped at page ${page}: ${String(err?.message ?? err).slice(0, 80)}`;
        break;
      }
      if (!Array.isArray(rows) || rows.length === 0) {
        stop = 'end';
        break;
      }
      pages++;
      read += rows.length;
      const items = [];
      let reachedCursor = false;
      for (const d of rows) {
        const at = when(d?.lastUpdated);
        if (since && at && at <= since) {
          reachedCursor = true;
          continue;
        }
        if (at && (!newest || at > newest)) newest = at;
        const it = toItem(d, { minUsability });
        if (it) items.push(it);
      }
      kept += items.length;
      // The cursor moves only once the whole walk is done: a run that dies mid-way
      // starts again from the old point, and upserts make the overlap harmless.
      yield { items };
      if (reachedCursor) {
        stop = 'cursor';
        break;
      }
      // A short page is not the end: Kaggle drops rows it hides after paging (19 of 20).
      await Bun.sleep(1500);
    }
    const note = `${kept} of ${read} ${sort} datasets kept, ${pages} pages${stop ? ` (${stop})` : ''}`;
    log(note);
    return {
      cursor: sort === 'updated' ? { since: (newest ?? since)?.toISOString() ?? null } : {},
      note,
    };
  },
});
