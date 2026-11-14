import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  buyable,
  clean,
  groupOffers,
  normaliseGtin,
  offersFromRecord,
  parsePrice,
  productKey,
} from '../packages/core/src/products.js';
import { migratedPglite, pgliteSql } from './helpers/pglite.js';

process.env.DATABASE_URL ??= 'postgres://localhost/unused';
process.env.SITE_URL ??= 'https://nichedb.test';
const { findProducts, keepOffers, productByKey, productStats, stalePages } = await import(
  '../packages/db/src/products.js'
);
const { keepProductOffers } = await import('../apps/web/src/lib/sites.js');

/** The shape the crawler pushed for a real Shopify product page, trimmed. */
const shopify = () => ({
  url: 'https://www.karwansaraypublishers.com/en-us/products/mw-issue-ix-4',
  canonical: 'https://www.karwansaraypublishers.com/en-us/products/mw-issue-ix-4',
  kind: 'product',
  site: { name: 'Karwansaray Publishers' },
  jsonld: [
    { '@type': 'BreadcrumbList', itemListElement: [] },
    {
      '@type': 'Product',
      name: 'Medieval Warfare IX.4',
      brand: { '@type': 'Brand', name: 'Karwansaray Publishers' },
      image: ['https://www.karwansaraypublishers.com/cdn/a.jpg'],
      category: 'Medieval Warfare single issue',
      offers: [
        {
          '@type': 'Offer',
          sku: '89100495',
          url: 'https://www.karwansaraypublishers.com/en-us/products/mw-issue-ix-4?variant=1',
          name: 'Print edition',
          price: '11.0',
          gtin14: '07447080639400',
          availability: 'https://schema.org/OutOfStock',
          itemCondition: 'https://schema.org/NewCondition',
          priceCurrency: 'USD',
        },
        {
          '@type': 'Offer',
          sku: '89100496',
          url: 'https://www.karwansaraypublishers.com/en-us/products/mw-issue-ix-4?variant=2',
          name: 'Digital (PDF) edition',
          price: '6.0',
          availability: 'https://schema.org/InStock',
          priceCurrency: 'USD',
          seller: { '@type': 'Organization', name: 'Karwansaray Publishers' },
        },
      ],
    },
  ],
});

describe('GTIN', () => {
  test('valid UPC, EAN, ISBN-13 and GTIN-14 pad to 14 digits', () => {
    expect(normaliseGtin('036000291452')).toBe('00036000291452'); // UPC-A
    expect(normaliseGtin('4006381333931')).toBe('04006381333931'); // EAN-13
    expect(normaliseGtin('978-0-14-143951-8')).toBe('09780141439518'); // ISBN-13
    expect(normaliseGtin('07447080639400')).toBe('07447080639400');
    // Published on a real Shopify page with a wrong check digit: refused, so it joins nothing.
    expect(normaliseGtin('07447080639404')).toBeNull();
    expect(normaliseGtin('96385074')).toBe('00000096385074'); // EAN-8
  });
  test('a wrong check digit, a SKU, zeros and objects are not GTINs', () => {
    expect(normaliseGtin('036000291453')).toBeNull();
    expect(normaliseGtin('89100495')).toBeNull();
    expect(normaliseGtin('00000000000000')).toBeNull();
    expect(normaliseGtin('12345')).toBeNull();
    expect(normaliseGtin({ value: '036000291452' })).toBeNull();
  });
});

describe('reading offers from a crawled record', () => {
  test('each Offer becomes one row, the GTIN one keyed by GTIN', () => {
    const offers = offersFromRecord(shopify());
    expect(offers).toHaveLength(2);
    const [print, pdf] = offers;
    expect(print.key).toBe('gtin:07447080639400');
    expect(print).toMatchObject({
      name: 'Medieval Warfare IX.4',
      brand: 'Karwansaray Publishers',
      variant: 'Print edition',
      price: 11,
      currency: 'USD',
      availability: 'OutOfStock',
      condition: 'NewCondition',
      host: 'karwansaraypublishers.com',
      sku: '89100495',
      seller: 'Karwansaray Publishers',
      imageUrl: 'https://www.karwansaraypublishers.com/cdn/a.jpg',
    });
    // No GTIN and no MPN: the offer only describes its own page.
    expect(pdf.key).toBe(`url:${shopify().canonical}`);
    expect(pdf.availability).toBe('InStock');
  });

  test('a ProductGroup gives one product per variant, inheriting brand and image', () => {
    const offers = offersFromRecord({
      url: 'https://shop.example/p/drill',
      jsonld: [
        {
          '@context': 'https://schema.org',
          '@graph': [
            {
              '@type': 'ProductGroup',
              name: 'Cordless drill',
              brand: 'Bosch',
              image: 'https://shop.example/drill.jpg',
              hasVariant: [
                {
                  '@type': 'Product',
                  name: 'Cordless drill 12V',
                  mpn: 'GSR12V-300',
                  offers: { price: 99, priceCurrency: 'usd' },
                },
                {
                  '@type': 'Product',
                  name: 'Cordless drill 18V',
                  mpn: 'GSR18V-400',
                  offers: { price: '149.00', priceCurrency: 'USD' },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(offers.map((o) => o.key)).toEqual(['mpn:bosch:gsr12v-300', 'mpn:bosch:gsr18v-400']);
    expect(offers[0]).toMatchObject({
      brand: 'Bosch',
      price: 99,
      currency: 'USD',
      imageUrl: 'https://shop.example/drill.jpg',
    });
  });

  test('an AggregateOffer with its own offers is opened up; without them its lowPrice stands', () => {
    const base = { url: 'https://m.example/x', jsonld: [] };
    const open = offersFromRecord({
      ...base,
      jsonld: [
        {
          '@type': 'Product',
          name: 'Widget',
          gtin13: '4006381333931',
          offers: {
            '@type': 'AggregateOffer',
            priceCurrency: 'EUR',
            offers: [
              { '@type': 'Offer', price: '1.299,00', url: '/a', seller: 'A' },
              { '@type': 'Offer', price: 1250, url: '/b', seller: 'B' },
            ],
          },
        },
      ],
    });
    expect(open.map((o) => [o.offerUrl, o.price, o.currency, o.seller])).toEqual([
      ['https://m.example/a', 1299, 'EUR', 'A'],
      ['https://m.example/b', 1250, 'EUR', 'B'],
    ]);
    const closed = offersFromRecord({
      ...base,
      jsonld: [
        {
          '@type': 'Product',
          name: 'Widget',
          offers: { '@type': 'AggregateOffer', lowPrice: '9.5', priceCurrency: 'GBP' },
        },
      ],
    });
    expect(closed[0]).toMatchObject({ price: 9.5, currency: 'GBP' });
  });

  test('Open Graph prices stand in on a product page with no JSON-LD product', () => {
    const offers = offersFromRecord({
      url: 'https://og.example/item',
      kind: 'product',
      title: 'Fallback',
      cards: {
        og: { 'og:title': 'OG Thing', 'og:price:amount': '6.00', 'og:price:currency': 'USD' },
      },
      jsonld: [],
    });
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      name: 'OG Thing',
      price: 6,
      currency: 'USD',
      key: 'url:https://og.example/item',
    });
  });

  test('pages without products, and products without offers, give nothing', () => {
    expect(
      offersFromRecord({
        url: 'https://a.example/',
        kind: 'article',
        jsonld: [{ '@type': 'Article', name: 'x' }],
      }),
    ).toEqual([]);
    expect(
      offersFromRecord({ url: 'https://a.example/p', jsonld: [{ '@type': 'Product', name: 'x' }] }),
    ).toEqual([]);
    expect(offersFromRecord({ url: 'javascript:alert(1)', jsonld: [] })).toEqual([]);
  });

  test('text is cleaned: entities, tags, lone surrogates', () => {
    expect(clean('Tom &amp; Jerry&#39;s <b>box</b>')).toBe("Tom & Jerry's box");
    expect(clean('bad \uD800 half')).toBe('bad half');
    expect(clean({ '@type': 'Brand', name: 'Acme' })).toBe('Acme');
  });

  test('prices read as stores write them', () => {
    expect(parsePrice('$1,299.99')).toBe(1299.99);
    expect(parsePrice('1.299,99')).toBe(1299.99);
    expect(parsePrice('12,5')).toBe(12.5);
    expect(parsePrice('free')).toBeNull();
    expect(parsePrice(-1)).toBeNull();
  });
});

describe('grouping', () => {
  test('buyable offers first, then cheapest; lowPrice only in one currency', () => {
    const row = (host, price, availability, currency = 'USD') => ({
      key: 'gtin:00036000291452',
      host,
      price,
      currency,
      availability,
      name: 'Thing',
      brand: host === 'b.example' ? 'Brand' : null,
      offerUrl: `https://${host}/x`,
    });
    const [p] = groupOffers([
      row('a.example', 5, 'OutOfStock'),
      row('b.example', 9, 'InStock'),
      row('c.example', 7, null),
    ]);
    expect(p.offers.map((o) => o.host)).toEqual(['c.example', 'b.example', 'a.example']);
    expect(p).toMatchObject({
      stores: 3,
      lowPrice: 7,
      currency: 'USD',
      brand: 'Brand',
      identity: 'gtin',
    });
    const [mixed] = groupOffers([
      row('a.example', 5, 'InStock'),
      row('b.example', 4, 'InStock', 'EUR'),
    ]);
    expect(mixed.lowPrice).toBeNull();
    expect(buyable('PreOrder')).toBe(true);
    expect(buyable('SoldOut')).toBe(false);
  });

  test('productKey falls back from GTIN to brand + MPN to the page', () => {
    expect(productKey({ gtin: '00036000291452', brand: 'X', mpn: 'Y' })).toBe(
      'gtin:00036000291452',
    );
    expect(productKey({ brand: 'Café Co', mpn: 'AB 12' })).toBe('mpn:cafe-co:ab-12');
    expect(productKey({ brand: 'X', pageUrl: 'https://p/' })).toBe('url:https://p/');
  });
});

describe('the graph in Postgres', () => {
  let pg;
  let db;
  beforeAll(async () => {
    pg = await migratedPglite();
    db = pgliteSql(pg);
  });
  afterAll(async () => pg?.close());

  test('two stores meet on a GTIN; text search finds the product', async () => {
    const page = shopify();
    const first = offersFromRecord(page);
    const other = offersFromRecord({
      url: 'https://bookstore.example/mw-ix-4',
      jsonld: [
        {
          '@type': 'Product',
          name: 'Medieval Warfare magazine IX.4',
          gtin: '7447080639400',
          offers: { price: '10.50', priceCurrency: 'USD', availability: 'InStock' },
        },
      ],
    });
    await keepOffers({ pages: [page.canonical], offers: first }, { db });
    await keepOffers({ pages: ['https://bookstore.example/mw-ix-4'], offers: other }, { db });

    const { products } = await findProducts({ gtin: '7447080639400' }, { db });
    expect(products).toHaveLength(1);
    expect(products[0].stores).toBe(2);
    // The in-stock bookstore copy beats the out-of-stock publisher copy.
    expect(products[0].offers.map((o) => [o.host, o.price])).toEqual([
      ['bookstore.example', 10.5],
      ['karwansaraypublishers.com', 11],
    ]);
    expect(products[0].lowPrice).toBe(10.5);

    const words = await findProducts({ q: 'medieval warfare' }, { db });
    expect(words.products[0].key).toBe('gtin:07447080639400');
    expect(words.products.map((p) => p.key)).toContain(`url:${page.canonical}`);

    expect((await productByKey('gtin:07447080639400', { db })).offers).toHaveLength(2);
    expect(await productStats({ db })).toMatchObject({
      offers: 3,
      products: 2,
      identified: 1,
      stores: 2,
    });
  });

  test('re-reading a page replaces its offers as a set', async () => {
    const page = shopify();
    page.jsonld[1].offers = [page.jsonld[1].offers[1]]; // the print edition is gone
    await keepOffers({ pages: [page.canonical], offers: offersFromRecord(page) }, { db });
    const p = await productByKey('gtin:07447080639400', { db });
    expect(p.offers.map((o) => o.host)).toEqual(['bookstore.example']);

    // A product page that now states nothing loses everything it had.
    await keepOffers({ pages: [page.canonical], offers: [] }, { db });
    expect(await productByKey(`url:${page.canonical}`, { db })).toBeNull();
  });

  test('a re-read with a new price keeps the old one and when it changed', async () => {
    const offer = (price) =>
      offersFromRecord({
        url: 'https://drop.example/kettle',
        jsonld: [
          {
            '@type': 'Product',
            name: 'Kettle',
            gtin13: '4006381333931',
            offers: { price, priceCurrency: 'USD' },
          },
        ],
      });
    await keepOffers({ pages: ['https://drop.example/kettle'], offers: offer('30.00') }, { db });
    await keepOffers({ pages: ['https://drop.example/kettle'], offers: offer('30.00') }, { db });
    let [o] = (await productByKey('gtin:04006381333931', { db })).offers;
    expect(o).toMatchObject({ price: 30, previousPrice: null, priceChangedAt: null });
    await keepOffers({ pages: ['https://drop.example/kettle'], offers: offer('24.99') }, { db });
    [o] = (await productByKey('gtin:04006381333931', { db })).offers;
    expect(o).toMatchObject({ price: 24.99, previousPrice: 30 });
    expect(o.priceChangedAt).toBe(o.seenAt);
  });

  test('stale pages: shop pages past the age, Open Prices left to its adapter, keyset paged', async () => {
    await keepOffers(
      {
        pages: ['https://prices.openfoodfacts.org/products/4006381333931?location=1'],
        offers: [
          {
            key: 'gtin:04006381333931',
            name: 'Kettle',
            pageUrl: 'https://prices.openfoodfacts.org/products/4006381333931?location=1',
            offerUrl: 'https://prices.openfoodfacts.org/products/4006381333931?location=1',
            host: 'prices.openfoodfacts.org',
            price: 20,
            currency: 'EUR',
          },
        ],
      },
      { db },
    );
    expect((await stalePages({ olderThanHours: 20 }, { db })).pages).toEqual([]);
    const all = await stalePages({ olderThanHours: 0, limit: 1 }, { db });
    expect(all.pages).toHaveLength(1);
    expect(all.next).not.toBeNull();
    const pages = new Set(all.pages);
    let next = all.next;
    while (next !== null) {
      const page = await stalePages({ olderThanHours: 0, limit: 1, after: next }, { db });
      for (const p of page.pages) pages.add(p);
      next = page.next;
    }
    expect([...pages].some((p) => p.includes('openfoodfacts'))).toBe(false);
    expect(pages.has('https://drop.example/kettle')).toBe(true);
  });

  test('a bad GTIN is an answer, not a query', async () => {
    expect((await findProducts({ gtin: '123' }, { db })).error).toMatch(/GTIN/);
    expect((await findProducts({}, { db })).error).toMatch(/ask with/);
  });
});

describe('keepProductOffers (the crawler push)', () => {
  test('reads accepted pages, skips non-product pages, never throws', async () => {
    const calls = [];
    const out = await keepProductOffers(
      [shopify(), { url: 'https://blog.example/post', kind: 'article', jsonld: [] }],
      { keep: async (args) => (calls.push(args), { kept: args.offers.length, removed: 0 }) },
    );
    expect(out).toEqual({ offers: 2, removed: 0 });
    expect(calls[0].pages).toEqual([shopify().canonical]);

    const failed = await keepProductOffers([shopify()], {
      keep: async () => {
        throw new Error('db down');
      },
    });
    expect(failed.error).toBe('product graph write failed');
  });
});

describe('product keys in paths', () => {
  test('Hono hands a {.+} param back decoded, so routes must not decode it again', async () => {
    // hono is apps/web's dependency; CI's isolated install does not hoist it to the root.
    const { Hono } = await import(Bun.resolveSync('hono', `${import.meta.dir}/../apps/web`));
    const app = new Hono();
    app.get('/products/:key{.+}', (c) => c.text(c.req.param('key')));
    const key = 'url:https://a.example/p?x=1&y=100%';
    const r = await app.request(`/products/${encodeURIComponent(key)}`);
    expect(await r.text()).toBe(key);
  });
});
