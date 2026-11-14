/**
 * The product graph: one row per offer a store states on its own product page,
 * joined across stores by what the product is.
 *
 * Stores already say what they sell, in schema.org Product / Offer JSON-LD that
 * they publish for search engines: name, brand, GTIN or MPN, price, currency,
 * stock, condition, seller. The pit.world crawler keeps that JSON-LD on every
 * page it reads (OpenSite `record.jsonld`), so nothing here fetches anything:
 * this reads records the crawler already pushed.
 *
 * Identity, strongest first:
 *   gtin:<14 digits>        a GS1 number (UPC, EAN, ISBN-13, ITF-14) whose
 *                           check digit is right, padded to GTIN-14
 *   mpn:<brand>:<mpn>       the maker's part number under the maker's name
 *   url:<page>              neither: the offer only describes itself
 * Two stores meet only on gtin or mpn. A url key never joins anything, which is
 * the honest answer for a page that names no identifier.
 */

const OFFERS_MAX = 50;
const TEXT = 300;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Plain text: entities decoded, tags and runs of space removed, clipped. */
export function clean(value, max = TEXT) {
  if (value == null) return null;
  const raw = typeof value === 'object' ? (value.name ?? value['@value'] ?? null) : value;
  if (raw == null || typeof raw === 'object') return null;
  const text = String(raw)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => safeChar(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => safeChar(Number.parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    // Lone surrogates break a whole jsonb batch (PR #110).
    .replace(/[\uD800-\uDFFF]/g, (ch, i, s) => {
      const code = ch.charCodeAt(0);
      if (code < 0xdc00) return /[\uDC00-\uDFFF]/.test(s[i + 1] ?? '') ? ch : '';
      return /[\uD800-\uDBFF]/.test(s[i - 1] ?? '') ? ch : '';
    })
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const safeChar = (n) =>
  Number.isInteger(n) && n > 0 && n <= 0x10ffff && (n < 0xd800 || n > 0xdfff)
    ? String.fromCodePoint(n)
    : '';

/** GS1 mod-10: the last digit checks the rest. */
function gs1Valid(digits) {
  let sum = 0;
  const body = digits.slice(0, -1);
  for (let i = 0; i < body.length; i++) {
    const fromRight = body.length - i;
    sum += Number(body[i]) * (fromRight % 2 === 1 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10 === Number(digits.at(-1));
}

/**
 * A GTIN-8/12/13/14 as 14 digits, or null when it is not one. All zeros and a
 * wrong check digit are refused: stores fill these fields with SKUs often
 * enough that an unchecked number would join unrelated products.
 */
export function normaliseGtin(raw) {
  if (raw == null || typeof raw === 'object') return null;
  const digits = String(raw).replace(/[\s-]/g, '');
  if (!/^\d+$/.test(digits) || ![8, 12, 13, 14].includes(digits.length)) return null;
  if (/^0+$/.test(digits) || !gs1Valid(digits)) return null;
  return digits.padStart(14, '0');
}

const slug = (s) =>
  String(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** The identity key for one offer; see the module comment. */
export function productKey({ gtin, brand, mpn, pageUrl }) {
  if (gtin) return `gtin:${gtin}`;
  if (brand && mpn && slug(brand) && slug(mpn)) return `mpn:${slug(brand)}:${slug(mpn)}`;
  return `url:${pageUrl}`;
}

const PRODUCT_TYPES = new Set([
  'product',
  'productgroup',
  'book',
  'individualproduct',
  'productmodel',
  'vehicle',
  'car',
]);

const types = (node) =>
  [node?.['@type']]
    .flat()
    .filter((t) => typeof t === 'string')
    .map((t) => t.replace(/^https?:\/\/schema\.org\//, '').toLowerCase());

const isProduct = (node) => types(node).some((t) => PRODUCT_TYPES.has(t));

/** Every node in a JSON-LD list, @graph flattened, nested once for mainEntity. */
function nodesOf(jsonld) {
  const out = [];
  const visit = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 3) return;
    if (Array.isArray(node)) {
      for (const n of node) visit(n, depth);
      return;
    }
    out.push(node);
    if (Array.isArray(node['@graph'])) visit(node['@graph'], depth + 1);
    if (node.mainEntity) visit(node.mainEntity, depth + 1);
  };
  visit(jsonld, 0);
  return out;
}

const firstString = (v) => {
  for (const x of [v].flat()) {
    if (typeof x === 'string' && x.trim()) return x.trim();
    if (x && typeof x === 'object' && typeof x.url === 'string') return x.url.trim();
    if (x && typeof x === 'object' && typeof x.contentUrl === 'string') return x.contentUrl.trim();
  }
  return null;
};

const absolute = (value, base) => {
  if (!value) return null;
  try {
    const u = new URL(value, base);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
};

/** A price as a number, or null; "1.299,00" and "$12" read as stores mean them. */
export function parsePrice(raw) {
  if (typeof raw === 'number')
    return Number.isFinite(raw) && raw >= 0 && raw < 1e9 ? Math.round(raw * 100) / 100 : null;
  if (raw == null || typeof raw === 'object') return null;
  let s = String(raw).replace(/[^\d.,]/g, '');
  if (!s || !/\d/.test(s)) return null;
  if (/,\d{1,2}$/.test(s) && !/\.\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 && n < 1e9 ? Math.round(n * 100) / 100 : null;
}

const currencyOf = (raw) => {
  const code = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  return /^[A-Z]{3}$/.test(code) ? code : null;
};

/** schema.org enum URLs to their last word: https://schema.org/InStock -> InStock. */
const enumOf = (raw) => {
  const s = firstString(raw);
  if (!s) return null;
  const word = s
    .replace(/^https?:\/\/schema\.org\//i, '')
    .replace(/^schema:/i, '')
    .trim();
  return /^[A-Za-z]{2,40}$/.test(word) ? word : null;
};

const gtinOf = (node) =>
  normaliseGtin(node?.gtin14) ??
  normaliseGtin(node?.gtin13) ??
  normaliseGtin(node?.gtin12) ??
  normaliseGtin(node?.gtin8) ??
  normaliseGtin(node?.gtin) ??
  normaliseGtin(node?.isbn);

/** Offers listed on a node, AggregateOffer opened up into its own offers when it has them. */
function offerNodes(node) {
  const out = [];
  for (const o of [node?.offers].flat().filter((x) => x && typeof x === 'object')) {
    const inner = [o.offers].flat().filter((x) => x && typeof x === 'object');
    if (types(o).includes('aggregateoffer') && inner.length)
      out.push(...inner.map((i) => ({ ...i, priceCurrency: i.priceCurrency ?? o.priceCurrency })));
    else out.push(o);
  }
  return out;
}

/**
 * Every offer one crawled OpenSite record states, normalised. Empty when the
 * page states none. A product page with Open Graph prices but no JSON-LD
 * product gives one offer from those.
 */
export function offersFromRecord(record) {
  const pageUrl = absolute(record?.canonical ?? record?.url, record?.url);
  if (!pageUrl) return [];
  const host = new URL(pageUrl).hostname.replace(/^www\./, '');
  const siteName = clean(record?.site?.name, 120);
  const out = [];

  const products = nodesOf(record?.jsonld ?? []).filter(isProduct);
  for (const product of products) {
    // A ProductGroup lists its variants; each is a product with its own offers.
    const variants = [product.hasVariant].flat().filter((v) => v && typeof v === 'object');
    for (const p of variants.length ? variants : [product]) {
      const base = variants.length ? product : {};
      const name = clean(p.name ?? base.name);
      if (!name) continue;
      const brand = clean(p.brand ?? base.brand ?? p.manufacturer ?? base.manufacturer, 120);
      const mpn = clean(p.mpn ?? base.mpn, 80);
      const productGtin = gtinOf(p) ?? gtinOf(base);
      const image = absolute(firstString(p.image ?? base.image), pageUrl);
      const category = clean(p.category ?? base.category, 160);
      const offers = offerNodes(p);
      for (const o of offers) {
        const price = parsePrice(o.price ?? o.lowPrice ?? o.priceSpecification?.price);
        const gtin = gtinOf(o) ?? productGtin;
        const offerMpn = clean(o.mpn, 80) ?? mpn;
        const variant = clean(o.name, 160);
        out.push({
          key: productKey({ gtin, brand, mpn: offerMpn, pageUrl }),
          gtin,
          mpn: offerMpn,
          sku: clean(o.sku ?? p.sku, 80),
          brand,
          name,
          variant: variant && variant !== name ? variant : null,
          category,
          imageUrl: absolute(firstString(o.image), pageUrl) ?? image,
          pageUrl,
          offerUrl: absolute(firstString(o.url), pageUrl) ?? pageUrl,
          host,
          seller: clean(o.seller, 120) ?? siteName,
          price,
          currency: currencyOf(o.priceCurrency ?? o.priceSpecification?.priceCurrency),
          availability: enumOf(o.availability),
          condition: enumOf(o.itemCondition),
        });
        if (out.length >= OFFERS_MAX) return dedupe(out);
      }
    }
  }

  if (out.length === 0 && record?.kind === 'product') {
    const og = record?.cards?.og ?? {};
    const price = parsePrice(og['product:price:amount'] ?? og['og:price:amount']);
    const name = clean(og['og:title'] ?? record?.title);
    if (price != null && name) {
      out.push({
        key: productKey({ pageUrl }),
        gtin: null,
        mpn: null,
        sku: null,
        brand: clean(og['product:brand'], 120),
        name,
        variant: null,
        category: null,
        imageUrl: absolute(
          og['og:image:secure_url'] ?? og['og:image'] ?? record?.image?.url,
          pageUrl,
        ),
        pageUrl,
        offerUrl: pageUrl,
        host,
        seller: siteName,
        price,
        currency: currencyOf(og['product:price:currency'] ?? og['og:price:currency']),
        availability: enumOf(og['product:availability'] ?? og['og:availability']),
        condition: enumOf(og['product:condition']),
      });
    }
  }
  return dedupe(out);
}

/** One row per (offer URL, product): a page that repeats an offer in two blocks keeps the first. */
function dedupe(offers) {
  const seen = new Set();
  return offers.filter((o) => {
    const k = `${o.offerUrl}\n${o.key}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const BUYABLE = new Set([
  'InStock',
  'InStoreOnly',
  'OnlineOnly',
  'LimitedAvailability',
  'PreOrder',
  'BackOrder',
  'PreSale',
]);

/** True when a store says you can buy or order it now (or says nothing). */
export const buyable = (availability) => availability == null || BUYABLE.has(availability);

const describes = (o) =>
  (o.brand ? 2 : 0) + (o.imageUrl ? 1 : 0) + (o.category ? 1 : 0) + (o.gtin ? 1 : 0);

/**
 * Offer rows grouped into products, in the order the products first appear;
 * within one, buyable before not, then cheapest first. A product's lowPrice is
 * only stated when every buyable priced offer shares one currency.
 */
export function groupOffers(rows) {
  const byKey = new Map();
  for (const r of rows) {
    if (!byKey.has(r.key)) byKey.set(r.key, []);
    byKey.get(r.key).push(r);
  }
  return [...byKey.entries()].map(([key, offers]) => {
    offers.sort(
      (a, b) =>
        Number(buyable(b.availability)) - Number(buyable(a.availability)) ||
        (a.price ?? Number.POSITIVE_INFINITY) - (b.price ?? Number.POSITIVE_INFINITY),
    );
    const best = offers.reduce((a, b) => (describes(b) > describes(a) ? b : a));
    const priced = offers.filter((o) => o.price != null && buyable(o.availability));
    const currencies = new Set(priced.map((o) => o.currency));
    return {
      key,
      identity: key.slice(0, key.indexOf(':')),
      name: best.name,
      brand: best.brand,
      gtin: offers.find((o) => o.gtin)?.gtin ?? null,
      mpn: offers.find((o) => o.mpn)?.mpn ?? null,
      category: best.category,
      imageUrl: offers.find((o) => o.imageUrl)?.imageUrl ?? null,
      stores: new Set(offers.map((o) => o.host)).size,
      lowPrice: priced.length && currencies.size === 1 ? priced[0].price : null,
      currency: currencies.size === 1 ? [...currencies][0] : null,
      offers,
    };
  });
}
