import { decodeEntities, defineAdapter, slugify } from '@nichedb/core/adapter';

/**
 * Software products, from the saasrow.com directory.
 *
 * saasrow is a house directory of SaaS and software: a product page each with
 * a category, tags, pricing model, use cases, audiences and platforms, and the
 * votes and views readers give it. `/api/v1/products` is the public read of
 * the whole directory, keyless, CORS-open, paged by offset with a ceiling of
 * 100 a page, and sorted `recent` so a walk from offset zero meets the newest
 * product first.
 *
 * `/api/v1/listings` is NOT read. It exists for the CLI and answers only with
 * an API key, because a listing there is the caller's own submission rather
 * than the directory (checked live 2026-09-12: 401 with a "create a key"
 * message). The public directory is the products endpoint.
 */

const BASE = 'https://saasrow.com/api/v1/products';

/** The documented ceiling per page. */
const PAGE = 100;

/** Pages per run. Five covers the directory as of 2026-09-12 (467 products). */
const DEFAULT_PAGES = 5;

/**
 * Decoded, whitespace-collapsed, and null when nothing is left.
 *
 * `decodeEntities` always returns a string because the XML parser needs it to.
 * A name that was only an entity decodes to nothing, and a product with no
 * name is not a product, so the emptiness has to become null somewhere.
 */
const clean = (s) => {
  const t = decodeEntities(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t || null;
};

const strings = (v) =>
  (Array.isArray(v) ? v : [])
    .map((s) => clean(s))
    .filter(Boolean)
    .slice(0, 20);

const HTTP = /^https?:\/\//i;
const urlOrNull = (v) => (typeof v === 'string' && HTTP.test(v.trim()) ? v.trim() : null);

/** One product, or null if it has no id or name. */
export function toItem(p) {
  const id = clean(p?.id);
  if (!id) return null;
  const title = clean(p.name);
  if (!title) return null;

  const category = clean(p.category);
  const pricing = clean(p.pricing_model);
  const tags = strings(p.tags);
  const platforms = strings(p.platforms);
  const website = urlOrNull(p.website);
  const page = urlOrNull(p.saasrow_url);

  const created = p.created_at ? new Date(p.created_at) : null;

  return {
    externalId: id.slice(0, 500),
    kind: 'product',
    title,
    summary: clean(p.description)?.slice(0, 600) ?? null,
    /*
     * The directory page rather than the vendor's site. A product here is the
     * listing -- votes, alternatives, use cases -- and the vendor's own URL is
     * in `data.website` for whoever wants to skip the directory.
     */
    url: page ?? website,
    imageUrl: urlOrNull(p.image_url) ?? urlOrNull(p.logo_url),
    publishedAt: created && !Number.isNaN(created.getTime()) ? created : null,
    tags: [
      'saasrow',
      category ? slugify(category) : null,
      pricing ? `pricing:${slugify(pricing)}` : null,
      p.featured ? 'featured' : null,
      ...tags.map(slugify),
      ...platforms.map((s) => `platform:${slugify(s)}`),
    ].filter(Boolean),
    data: {
      directory: page,
      website,
      category,
      pricingModel: pricing,
      tags,
      useCases: strings(p.use_cases),
      audiences: strings(p.audiences),
      platforms,
      alternatives: strings(p.alternatives),
      upvotes: Number.isFinite(p.upvotes) ? p.upvotes : null,
      downvotes: Number.isFinite(p.downvotes) ? p.downvotes : null,
      views: Number.isFinite(p.views) ? p.views : null,
      featured: p.featured === true,
      logoUrl: urlOrNull(p.logo_url),
      updatedAt: p.updated_at ?? null,
    },
  };
}

export const saasrow = defineAdapter({
  name: 'saasrow',
  title: 'saasrow products',
  collection: 'saas',
  description:
    'Every product in the saasrow.com software directory with its category, tags, pricing model, platforms, alternatives, votes and views, walked newest first through the keyless public API. The listings endpoint is per-account and needs a key, so it is not read.',
  docs: 'https://saasrow.com/api/v1/products',
  kinds: ['product'],
  cadenceMinutes: 60,
  configFields: [
    {
      key: 'pages',
      label: 'Pages per run',
      type: 'number',
      required: false,
      help: 'A hundred products a page, newest first. Five pages covers the whole directory today.',
    },
  ],
  defaults: { pages: DEFAULT_PAGES },
  defaultSources: [
    {
      slug: 'saasrow-products',
      name: 'SaaS: the saasrow directory',
      config: { pages: DEFAULT_PAGES },
    },
  ],
  async pull({ config, http, log, deadline }) {
    const pages = Math.min(Math.max(Number(config.pages) || DEFAULT_PAGES, 1), 50);
    const items = [];
    const seen = new Set();
    let offset = 0;
    let total = null;

    for (let page = 0; page < pages; page++) {
      if (Date.now() > deadline) break;
      let doc;
      try {
        doc = await http.json(`${BASE}?sort=recent&limit=${PAGE}&offset=${offset}`, {
          timeoutMs: 20_000,
        });
      } catch (err) {
        log(`offset ${offset} failed (${err.message.slice(0, 60)})`);
        break;
      }
      const rows = Array.isArray(doc?.data) ? doc.data : [];
      for (const row of rows) {
        const item = toItem(row);
        // Offset paging over a directory that grows underneath the walk can
        // repeat a product across a page boundary; one row wins.
        if (item && !seen.has(item.externalId)) {
          seen.add(item.externalId);
          items.push(item);
        }
      }
      total = Number.isFinite(doc?.pagination?.total) ? doc.pagination.total : total;
      const next = doc?.pagination?.next;
      if (rows.length === 0 || next === null || next === undefined) break;
      offset = Number(next);
      if (!Number.isFinite(offset) || offset <= 0) break;
    }

    log(`${items.length} products${total !== null ? ` of ${total}` : ''}`);
    return { items, note: `${items.length} products` };
  },
});
