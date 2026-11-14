import { defineAdapter } from '@nichedb/core/adapter';
import { clean, normaliseGtin, productKey } from '@nichedb/core/products';

/**
 * Prices, from Open Prices (prices.openfoodfacts.org): what people paid, read
 * off receipts and shelf tags they photographed, for a product by its barcode
 * at a shop that is an OpenStreetMap place (or, now and then, a website).
 * Open data under the ODbL; every row and page credits it.
 *
 * Each price becomes an item in /c/prices and, through `data.offer`, an offer
 * in the product graph (core/products.js; ingest's absorbOffers). The graph
 * keeps one offer per (barcode, shop): a newer price at the same shop replaces
 * the older one. Prices with no barcode (loose fruit, by category) are skipped,
 * since they cannot join anything.
 *
 * The API pages by `page` at 100 rows, ordered by `created`. `id__gt` is
 * accepted and ignored (2026-11-14), so the cursor is `created__gte` on the
 * newest row read; the boundary rows come back once more, which the upsert
 * absorbs. The uploader's username is never kept.
 */

const API = 'https://prices.openfoodfacts.org/api/v1/prices';
const SITE = 'https://prices.openfoodfacts.org';
const PAGE = 100;
const DEFAULT_PAGES = 40;
export const CREDIT = 'Open Prices (prices.openfoodfacts.org), ODbL';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const first = (list) => (Array.isArray(list) && list.length ? list[0] : null);
const tagWord = (t) =>
  typeof t === 'string' ? t.replace(/^[a-z]{2}:/, '').replace(/-/g, ' ') : null;

const hostOf = (url) => {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.hostname.replace(/^www\./, '') : null;
  } catch {
    return null;
  }
};

/** One price row as an item with its graph offer, or null when it cannot be one. */
export function toItem(row) {
  const id = num(row?.id);
  const price = num(row?.price);
  const currency =
    typeof row?.currency === 'string' && /^[A-Z]{3}$/.test(row.currency) ? row.currency : null;
  const code = typeof row?.product_code === 'string' ? row.product_code.trim() : '';
  const gtin = normaliseGtin(code);
  if (id === null || price === null || price < 0 || !currency || !gtin) return null;
  if (row.duplicate_of) return null;

  const p = row.product ?? {};
  const loc = row.location ?? {};
  const online = loc.type === 'ONLINE';
  const website = typeof loc.website_url === 'string' ? loc.website_url : null;
  const shopName = clean(loc.osm_brand ?? loc.osm_name ?? (online ? hostOf(website) : null), 120);
  const place = [clean(loc.osm_address_city, 80), loc.osm_address_country_code]
    .filter(Boolean)
    .join(', ');
  const seller = shopName ? (place && !online ? `${shopName}, ${place}` : shopName) : place || null;
  const name = clean(p.product_name ?? row.product_name) ?? `Barcode ${code}`;
  const brand = clean(first(p.brands_tags) ?? p.brands?.split(',')[0], 120);
  const quantity = clean(p.quantity, 40);
  const date =
    typeof row.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.date) ? row.date : null;
  const locationId = num(row.location_id);
  const productPage = `${SITE}/products/${encodeURIComponent(code)}`;
  // One graph row per (barcode, shop): the page key carries the shop, so a newer price replaces it.
  const offerPage = `${productPage}?location=${locationId ?? 'unknown'}`;
  const country =
    typeof loc.osm_address_country_code === 'string'
      ? loc.osm_address_country_code.toLowerCase()
      : null;

  const offer = {
    key: productKey({ gtin, pageUrl: offerPage }),
    gtin,
    mpn: null,
    sku: null,
    brand,
    name,
    variant:
      [
        quantity,
        date ? `${row.proof?.type === 'RECEIPT' ? 'receipt' : 'price tag'} ${date}` : null,
        row.price_is_discounted ? 'discounted' : null,
      ]
        .filter(Boolean)
        .join(' · ') || null,
    category: tagWord(first(p.categories_tags)),
    imageUrl:
      typeof p.image_url === 'string' && p.image_url.startsWith('https://') ? p.image_url : null,
    pageUrl: offerPage,
    offerUrl: online && website ? website : offerPage,
    host: online && hostOf(website) ? hostOf(website) : 'prices.openfoodfacts.org',
    seller,
    price,
    currency,
    availability: online ? 'OnlineOnly' : 'InStoreOnly',
    condition: 'NewCondition',
  };

  return {
    externalId: String(id),
    kind: 'price',
    title: `${name}${seller ? ` at ${seller}` : ''}: ${price} ${currency}`,
    summary: [brand, quantity, offer.category].filter(Boolean).join(' · ') || null,
    url: productPage,
    imageUrl: offer.imageUrl,
    publishedAt: date ? new Date(`${date}T00:00:00Z`) : null,
    timeKnown: false,
    precision: 'day',
    tags: [
      'openprices',
      `gtin-${gtin}`,
      currency.toLowerCase(),
      country ? `country-${country}` : null,
      online ? 'online' : 'in-store',
      row.price_is_discounted ? 'discounted' : null,
    ].filter(Boolean),
    data: {
      price,
      currency,
      discounted: row.price_is_discounted === true,
      priceWithoutDiscount: num(row.price_without_discount),
      date,
      code,
      gtin,
      product: { name, brand, quantity, category: offer.category, image: offer.imageUrl },
      location: {
        id: locationId,
        name: shopName,
        city: clean(loc.osm_address_city, 80),
        country: clean(loc.osm_address_country, 80),
        countryCode: loc.osm_address_country_code ?? null,
        lat: num(loc.osm_lat),
        lon: num(loc.osm_lon),
        osm:
          loc.osm_type && loc.osm_id ? `${String(loc.osm_type).toLowerCase()}/${loc.osm_id}` : null,
        website,
      },
      proof: row.proof?.type ?? null,
      credit: CREDIT,
      offer,
    },
  };
}

export const openprices = defineAdapter({
  name: 'openprices',
  title: 'Open Prices',
  collection: 'prices',
  description:
    'What people paid for products by barcode, read off receipts and price tags they photographed, at shops that are OpenStreetMap places (or websites), from Open Prices (prices.openfoodfacts.org, ODbL). Each price also joins the product graph by its barcode, beside the prices shops state online.',
  docs: 'https://prices.openfoodfacts.org/api/docs',
  kinds: ['price'],
  cadenceMinutes: 60,
  configFields: [
    {
      key: 'pages',
      label: 'Pages per run',
      type: 'number',
      required: false,
      help: 'A hundred prices a page, oldest upload first from where the last run stopped.',
    },
  ],
  defaults: { pages: DEFAULT_PAGES },
  defaultSources: [
    { slug: 'openprices-prices', name: 'Prices: Open Prices', config: { pages: DEFAULT_PAGES } },
  ],
  async *pull({ config, cursor, http, log, deadline }) {
    const pages = Math.min(Math.max(Number(config.pages) || DEFAULT_PAGES, 1), 500);
    const since = typeof cursor?.created === 'string' ? cursor.created : null;
    let newest = since;
    let kept = 0;
    let read = 0;
    let full = false;
    for (let page = 1; page <= pages; page++) {
      if (Date.now() > deadline) break;
      const params = new URLSearchParams({
        size: String(PAGE),
        page: String(page),
        order_by: 'created',
      });
      if (since) params.set('created__gte', since);
      let body;
      try {
        body = await http.json(`${API}?${params}`, { timeoutMs: 30_000 });
      } catch (err) {
        // A failure mid-walk keeps what was read; on the first page it is the run's failure.
        if (page === 1) throw err;
        log(`page ${page} failed (${String(err.message).slice(0, 60)})`);
        break;
      }
      const rows = Array.isArray(body?.items) ? body.items : [];
      if (!rows.length) break;
      read += rows.length;
      const items = rows.map(toItem).filter(Boolean);
      kept += items.length;
      for (const r of rows)
        if (typeof r?.created === 'string' && (!newest || r.created > newest)) newest = r.created;
      yield { items, cursor: { created: newest } };
      if (rows.length < PAGE) break;
      if (page === pages) full = true;
    }
    log(`${kept} prices with a barcode of ${read} read`);
    // Still behind (the first walk is ~3,500 pages): come back soon instead of in an hour.
    return {
      cursor: { created: newest },
      note: `${kept} prices`,
      ...(full ? { nextInMinutes: 2 } : {}),
    };
  },
});
