import { groupOffers, normaliseGtin, productKey } from '@nichedb/core/products';
import { sql } from './index.js';
import { bounded, pgArray } from './queries.js';

/**
 * Reads and writes for the product graph (migration 0045, core/products.js).
 * Every call takes an optional `db` so a test can run it on a migrated PGlite.
 */

const READ_MS = 8_000;
const WRITE_MS = 30_000;
const LIMIT_MAX = 50;
const OFFERS_PER_PRODUCT = 40;

const COLUMNS = [
  'key',
  'gtin',
  'mpn',
  'sku',
  'brand',
  'name',
  'variant',
  'category',
  'imageUrl',
  'pageUrl',
  'offerUrl',
  'host',
  'seller',
  'price',
  'currency',
  'availability',
  'condition',
];

const row = (o) => Object.fromEntries(COLUMNS.map((k) => [k, o[k] ?? null]));

/**
 * Keep the offers just read from some pages. A page's offers are replaced as a
 * set: an offer the page no longer states is removed, so a variant a store
 * dropped stops showing. `pages` names every page read, including the ones that
 * now state no offers at all.
 */
export async function keepOffers({ pages, offers }, { db = sql } = {}) {
  const unique = new Map();
  for (const o of offers) unique.set(`${o.offerUrl}\n${o.key}`, row(o));
  const rows = [...unique.values()];
  const pageList = [...new Set(pages)];
  if (pageList.length === 0) return { kept: 0, removed: 0 };
  // One stamp for the batch: the delete below removes what this write did not touch,
  // and now() would differ between the two statements outside a transaction.
  const stamp = new Date().toISOString();
  const run = async (tx, inTransaction) => {
    if (inTransaction) await tx.unsafe(`set local statement_timeout = ${WRITE_MS}`);
    let kept = 0;
    if (rows.length) {
      const out = await tx`
        insert into product_offers (product_key, gtin, mpn, sku, brand, name, variant, category,
          image_url, page_url, offer_url, host, seller, price, currency, availability, condition,
          seen_at)
        select r.key, r.gtin, r.mpn, r.sku, r.brand, r.name, r.variant, r.category,
          r."imageUrl", r."pageUrl", r."offerUrl", r.host, r.seller, r.price, r.currency,
          r.availability, r.condition, ${stamp}::timestamptz
        from jsonb_to_recordset(${JSON.stringify(rows)}::text::jsonb) as r(
          key text, gtin text, mpn text, sku text, brand text, name text, variant text,
          category text, "imageUrl" text, "pageUrl" text, "offerUrl" text, host text, seller text,
          price numeric, currency text, availability text, condition text)
        on conflict (offer_url, product_key) do update set
          gtin = excluded.gtin, mpn = excluded.mpn, sku = excluded.sku, brand = excluded.brand,
          name = excluded.name, variant = excluded.variant, category = excluded.category,
          image_url = excluded.image_url, page_url = excluded.page_url, host = excluded.host,
          seller = excluded.seller, price = excluded.price, currency = excluded.currency,
          availability = excluded.availability, condition = excluded.condition, seen_at = excluded.seen_at,
          -- A re-read that finds a new price keeps the old one and when it changed.
          previous_price = case when excluded.price is distinct from product_offers.price
                                 and product_offers.price is not null
                                then product_offers.price else product_offers.previous_price end,
          price_changed_at = case when excluded.price is distinct from product_offers.price
                                   and product_offers.price is not null
                                  then excluded.seen_at else product_offers.price_changed_at end
        returning id
      `;
      kept = out.length;
    }
    // Rows written above carry the stamp; anything older on these pages is gone.
    const removed = await tx`
      delete from product_offers
      where page_url = any(${pgArray(pageList)}::text[]) and seen_at < ${stamp}::timestamptz
      returning id
    `;
    return { kept, removed: removed.length };
  };
  return typeof db.begin === 'function' ? db.begin((tx) => run(tx, true)) : run(db, false);
}

const camel = (r) => ({
  key: r.product_key,
  gtin: r.gtin,
  mpn: r.mpn,
  sku: r.sku,
  brand: r.brand,
  name: r.name,
  variant: r.variant,
  category: r.category,
  imageUrl: r.image_url,
  pageUrl: r.page_url,
  offerUrl: r.offer_url,
  host: r.host,
  seller: r.seller,
  price: r.price == null ? null : Number(r.price),
  currency: r.currency,
  availability: r.availability,
  condition: r.condition,
  seenAt: iso(r.seen_at),
  previousPrice: r.previous_price == null ? null : Number(r.previous_price),
  priceChangedAt: iso(r.price_changed_at),
});

const iso = (v) => (v instanceof Date ? v.toISOString() : (v ?? null));

/** Every offer for these product keys, at most OFFERS_PER_PRODUCT each, grouped in key order. */
async function productsFor(keys, db) {
  if (keys.length === 0) return [];
  const rows = await bounded(
    db,
    READ_MS,
    (d) => d`
      select * from (
        select o.*, row_number() over (partition by o.product_key order by o.price asc nulls last, o.id) as n
        from product_offers o
        where o.product_key = any(${pgArray(keys)}::text[])
      ) t
      where t.n <= ${OFFERS_PER_PRODUCT}
    `,
  );
  const grouped = new Map(groupOffers(rows.map(camel)).map((p) => [p.key, p]));
  return keys.map((k) => grouped.get(k)).filter(Boolean);
}

/**
 * Products matching a question. `gtin` (any GTIN, UPC, EAN or ISBN-13) and
 * `brand` + `mpn` are exact; `q` is a text match over name, brand, variant,
 * category, MPN and SKU, products sold by more stores first among equals.
 * `host` keeps one store's products.
 */
export async function findProducts(
  { q, gtin, brand, mpn, host, limit = 20 } = {},
  { db = sql } = {},
) {
  const n = Math.max(1, Math.min(LIMIT_MAX, Number(limit) || 20));
  const keys = [];
  const g = gtin ? normaliseGtin(gtin) : null;
  if (gtin && !g)
    return { products: [], error: 'not a GTIN, UPC, EAN or ISBN-13 (check digit wrong?)' };
  if (g) keys.push(`gtin:${g}`);
  if (brand && mpn) keys.push(productKey({ brand, mpn }));
  if (keys.length) return { products: await productsFor(keys, db) };

  const text = String(q ?? '')
    .trim()
    .slice(0, 200);
  if (!text && !host) return { products: [], error: 'ask with q, gtin, or brand and mpn' };
  const h = host
    ? String(host)
        .toLowerCase()
        .replace(/^www\./, '')
    : null;
  const found = await bounded(db, READ_MS, (d) =>
    text
      ? d`
        with hits as (
          select product_key, host, ts_rank(search, query) as rank
          from product_offers, websearch_to_tsquery('simple', ${text}) query
          where search @@ query ${h ? d`and host = ${h}` : d``}
          limit 5000
        )
        select product_key, max(rank) as rank, count(distinct host) as stores
        from hits group by product_key
        order by rank desc, stores desc, product_key
        limit ${n}
      `
      : d`
        select product_key from product_offers where host = ${h}
        group by product_key order by max(seen_at) desc limit ${n}
      `,
  );
  return {
    products: await productsFor(
      found.map((r) => r.product_key),
      db,
    ),
  };
}

/** One product by its key, or null. */
export async function productByKey(key, { db = sql } = {}) {
  const [p] = await productsFor([String(key)], db);
  return p ?? null;
}

/** Totals for the index page and the API root. */
export async function productStats({ db = sql } = {}) {
  const [r] = await bounded(
    db,
    20_000,
    (d) => d`
      select count(*)::bigint as offers,
             count(distinct product_key)::bigint as products,
             count(distinct product_key) filter (where product_key like 'gtin:%' or product_key like 'mpn:%')::bigint as identified,
             count(distinct host)::bigint as stores,
             max(seen_at) as last_seen
      from product_offers
    `,
  );
  return {
    offers: Number(r.offers),
    products: Number(r.products),
    identified: Number(r.identified),
    stores: Number(r.stores),
    lastSeen: r.last_seen instanceof Date ? r.last_seen.toISOString() : (r.last_seen ?? null),
  };
}

/** Open Prices rows refresh through their own adapter; only shop pages are re-read. */
const SELF_REFRESHING = ['prices.openfoodfacts.org'];

/**
 * Shop product pages whose offers were last read more than `olderThanHours`
 * ago, for the crawler's daily re-read (pit.world reprice). Keyset by offer id:
 * pass back `next` as `after`. A page with several offers (variants) can appear
 * once per offer across calls; the crawler dedupes.
 */
export async function stalePages(
  { after = 0, limit = 5000, olderThanHours = 20 } = {},
  { db = sql } = {},
) {
  const n = Math.max(1, Math.min(10_000, Number(limit) || 5000));
  const hours =
    Number.isFinite(Number(olderThanHours)) && olderThanHours !== null && olderThanHours !== ''
      ? Number(olderThanHours)
      : 20;
  const rows = await bounded(
    db,
    READ_MS,
    (d) => d`
      select id, page_url from product_offers
      where id > ${Number(after) || 0}
        and seen_at < now() - make_interval(hours => ${hours})
        and host <> all(${pgArray(SELF_REFRESHING)}::text[])
      order by id
      limit ${n}
    `,
  );
  return {
    pages: [...new Set(rows.map((r) => r.page_url))],
    next: rows.length === n ? Number(rows.at(-1).id) : null,
  };
}
