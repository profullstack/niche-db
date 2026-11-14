import * as products from '@nichedb/db/products';

/**
 * Product graph questions, shared by /products, /api/v1/products and the
 * find_product MCP tool. Rows come from keepProductOffers in sites.js.
 */

/** A bare barcode in a search box is a GTIN question, not a text one. */
export const looksLikeGtin = (q) =>
  /^[\d\s-]{8,17}$/.test(q) && [8, 12, 13, 14].includes(q.replace(/\D/g, '').length);

/** Search from loose params: q, gtin, brand + mpn, host, limit. */
export async function searchProducts(params) {
  const q = String(params.q ?? '').trim();
  const gtin = params.gtin || (looksLikeGtin(q) ? q : undefined);
  return products.findProducts({
    q: gtin ? undefined : q,
    gtin,
    brand: params.brand,
    mpn: params.mpn,
    host: params.host,
    limit: params.limit,
  });
}
