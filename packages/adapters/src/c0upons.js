import { decodeEntities, defineAdapter } from '@nichedb/core/adapter';

/**
 * Coupons, from c0upons.com.
 *
 * c0upons is the house coupon site. Most of what it lists it copied from this
 * database's `deals` collection, so those rows are NOT read back: they are
 * already here under their original sources, and a copy of a copy would only
 * double them. What c0upons has that nichedb does not is everything it took
 * in on its own: codes people submitted on the site, and the listings it reads
 * from r/couponcodes every five minutes. Those rows carry `source` of null
 * (submitted) or `reddit`, and they are what this adapter brings home.
 *
 * `/api/coupons` is the public read of every coupon with its store joined in,
 * keyless, paged by `limit` and `offset`, most voted first. The walk reads
 * whole pages and keeps only the rows that did not come from here, so a
 * run's page count is the site's size, not the count it brings back.
 */

const BASE = 'https://c0upons.com/api/coupons';
const SITE = 'https://c0upons.com';

/** Rows per page. The route caps nothing; this is one request's worth. */
const PAGE = 200;

/** Pages per run. Ten covers the site five times over as of 2026-09-13 (815 coupons). */
const DEFAULT_PAGES = 10;

/** Where c0upons copied the row from when it is one of ours. */
const OURS = 'nichedb';

const clean = (s) => {
  const t = decodeEntities(String(s ?? ''))
    .replace(/\s+/g, ' ')
    .trim();
  return t || null;
};

const HTTP = /^https?:\/\//i;
const urlOrNull = (v) => (typeof v === 'string' && HTTP.test(v.trim()) ? v.trim() : null);

const number = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The store's domain, which c0upons only knows through the favicon URL it built from it. */
export function domainFromLogo(logoUrl) {
  const url = urlOrNull(logoUrl);
  if (!url) return null;
  try {
    const u = new URL(url);
    const d = u.searchParams.get('domain');
    return d && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(d) ? d.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * One coupon, or null if it has no id or title, or came from this database
 * in the first place.
 */
export function toItem(row) {
  const id = number(row?.id);
  if (id === null) return null;
  if (row.source === OURS) return null;
  const title = clean(row.title);
  if (!title) return null;

  const storeKey = clean(row.store_slug);
  const store = clean(row.store_name) ?? storeKey;
  const code = clean(row.code);
  const discountType =
    row.discount_type === 'percent' || row.discount_type === 'fixed' ? row.discount_type : null;
  const source = clean(row.source) ?? 'submitted';
  const created = row.created_at ? new Date(row.created_at) : null;
  const domain = domainFromLogo(row.store_logo);

  return {
    externalId: String(id),
    kind: 'coupon',
    title,
    summary: clean(row.description)?.slice(0, 600) ?? null,
    /*
     * The coupon page rather than the deal it points at. The page carries the
     * code, the votes and the store; the deal's own address is in
     * `data.dealUrl` for whoever wants to skip the site.
     */
    url: `${SITE}/coupons/${id}`,
    imageUrl: urlOrNull(row.image_url) ?? urlOrNull(row.store_logo),
    publishedAt: created && !Number.isNaN(created.getTime()) ? created : null,
    tags: [
      'c0upons',
      storeKey,
      `source:${source}`,
      code ? 'coupon-code' : null,
      discountType ? `discount:${discountType}` : null,
    ].filter(Boolean),
    data: {
      store,
      storeKey,
      storeDomain: domain,
      code,
      discountType,
      discountValue: number(row.discount_value),
      discount: clean(row.discount),
      expires: clean(row.expiry_date),
      dealUrl: urlOrNull(row.url),
      votes: number(row.votes) ?? 0,
      verified: row.verified === 1 || row.verified === true,
      source,
      sourceId: clean(row.source_id),
      codeSource: clean(row.code_source),
    },
  };
}

export const c0upons = defineAdapter({
  name: 'c0upons',
  title: 'c0upons coupons',
  collection: 'coupons',
  description:
    "Every coupon c0upons.com took in on its own: codes people submitted on the site and the listings it reads from r/couponcodes, each under its store with the code, discount and expiry as fields and a link to the coupon page. Rows c0upons copied from this database's deals collection are left where they already are.",
  docs: 'https://c0upons.com/docs',
  kinds: ['coupon'],
  cadenceMinutes: 15,
  configFields: [
    {
      key: 'pages',
      label: 'Pages per run',
      type: 'number',
      required: false,
      help: 'Two hundred coupons a page, most voted first. Ten pages is far more than the site holds today.',
    },
  ],
  defaults: { pages: DEFAULT_PAGES },
  defaultSources: [
    {
      slug: 'c0upons-coupons',
      name: 'Coupons: c0upons.com',
      config: { pages: DEFAULT_PAGES },
    },
  ],
  async pull({ config, http, log, deadline }) {
    const pages = Math.min(Math.max(Number(config.pages) || DEFAULT_PAGES, 1), 50);
    const items = [];
    const seen = new Set();
    let read = 0;
    let ours = 0;

    for (let page = 0; page < pages; page++) {
      if (Date.now() > deadline) break;
      const offset = page * PAGE;
      let rows;
      try {
        rows = await http.json(`${BASE}?limit=${PAGE}&offset=${offset}`, { timeoutMs: 20_000 });
      } catch (err) {
        log(`offset ${offset} failed (${err.message.slice(0, 60)})`);
        break;
      }
      if (!Array.isArray(rows) || rows.length === 0) break;
      read += rows.length;
      for (const row of rows) {
        if (row?.source === OURS) {
          ours++;
          continue;
        }
        const item = toItem(row);
        // Offset paging over a list ordered by votes can repeat a row across a
        // page boundary when a vote lands mid-walk; one row wins.
        if (item && !seen.has(item.externalId)) {
          seen.add(item.externalId);
          items.push(item);
        }
      }
      if (rows.length < PAGE) break;
    }

    log(`${items.length} coupons of ${read} read, ${ours} already ours`);
    return { items, note: `${items.length} coupons` };
  },
});
