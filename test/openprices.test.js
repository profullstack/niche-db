import { describe, expect, test } from 'bun:test';
import { CREDIT, openprices, toItem } from '../packages/adapters/src/openprices.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

process.env.DATABASE_URL ??= 'postgres://localhost/unused';
process.env.SITE_URL ??= 'https://nichedb.test';
const { adapterByName } = await import('../packages/adapters/src/index.js');
const { COLLECTIONS, DEFAULT_FEEDS } = await import('../packages/core/src/seed.js');
const { absorbOffers } = await import('../packages/core/src/ingest.js');
const { isReservedNicheSlug } = await import('../packages/knowledge/src/index.js');

/** A row as /api/v1/prices returned it on 2026-11-14, trimmed. */
const ROW = () => ({
  id: 362883,
  location_id: 7930,
  type: 'PRODUCT',
  product_code: '2030500294911',
  price: 4.49,
  price_is_discounted: false,
  price_without_discount: null,
  currency: 'EUR',
  date: '2026-11-13',
  owner: 'krispie',
  created: '2026-11-14T15:25:29.353037Z',
  duplicate_of: null,
  product: {
    code: '2030500294911',
    product_name: 'Pain hyperprotéiné energus10',
    image_url:
      'https://images.openfoodfacts.org/images/products/203/050/029/4911/front_fr.44.400.jpg',
    quantity: '400g',
    categories_tags: ['en:plant-based-foods-and-beverages'],
    brands: 'Energus, Energus 10',
    brands_tags: ['Energus', 'Energus 10'],
  },
  location: {
    type: 'OSM',
    osm_id: 7623372585,
    osm_type: 'NODE',
    osm_name: 'Auchan Supermarché',
    osm_brand: 'Auchan Supermarché',
    osm_address_city: 'Porto-Vecchio',
    osm_address_country: 'France',
    osm_address_country_code: 'FR',
    osm_lat: 41.5860253,
    osm_lon: 9.28161,
    website_url: null,
  },
  proof: { type: 'RECEIPT', date: '2026-11-13' },
});

describe('openprices', () => {
  test('is registered under prices, which exists with its feeds and a reserved slug', () => {
    expect(adapterByName('openprices').collection).toBe('prices');
    expect(COLLECTIONS.some((c) => c.slug === 'prices')).toBe(true);
    expect(DEFAULT_FEEDS.filter((f) => f.collection === 'prices').map((f) => f.slug)).toEqual([
      'prices-latest',
      'prices-discounted',
    ]);
    expect(isReservedNicheSlug('prices')).toBe(true);
  });

  test('a receipt price becomes an item and a graph offer keyed by its barcode', () => {
    const it = toItem(ROW());
    expect(it.externalId).toBe('362883');
    expect(it.title).toBe(
      'Pain hyperprotéiné energus10 at Auchan Supermarché, Porto-Vecchio, FR: 4.49 EUR',
    );
    expect(it.tags).toEqual(['openprices', 'gtin-02030500294911', 'eur', 'country-fr', 'in-store']);
    expect(it.data.credit).toBe(CREDIT);
    expect(it.data.location.osm).toBe('node/7623372585');
    expect(JSON.stringify(it)).not.toContain('krispie');
    expect(it.data.offer).toMatchObject({
      key: 'gtin:02030500294911',
      brand: 'Energus',
      variant: '400g · receipt 2026-11-13',
      host: 'prices.openfoodfacts.org',
      seller: 'Auchan Supermarché, Porto-Vecchio, FR',
      price: 4.49,
      currency: 'EUR',
      availability: 'InStoreOnly',
      pageUrl: 'https://prices.openfoodfacts.org/products/2030500294911?location=7930',
    });
    expect(normaliseItem(it).externalId).toBe('362883');
  });

  test('an online shop keeps its own address as the host', () => {
    const row = ROW();
    row.location = { type: 'ONLINE', website_url: 'https://www.example-shop.fr/', osm_name: null };
    const { offer } = toItem(row).data;
    expect(offer).toMatchObject({
      host: 'example-shop.fr',
      offerUrl: 'https://www.example-shop.fr/',
      availability: 'OnlineOnly',
      seller: 'example-shop.fr',
    });
  });

  test('no barcode, a bad barcode, a duplicate or no currency is no item', () => {
    for (const patch of [
      { product_code: null, type: 'CATEGORY' },
      { product_code: '2030500294912' },
      { duplicate_of: 5 },
      { currency: null },
      { price: null },
    ]) {
      expect(toItem({ ...ROW(), ...patch })).toBeNull();
    }
  });

  test('the walk pages from the cursor and saves the newest upload time per batch', async () => {
    const asked = [];
    const pageOf = (n) =>
      Array.from({ length: n }, (_, i) => ({
        ...ROW(),
        id: 1000 + i,
        created: `2026-11-14T15:${String(10 + i).padStart(2, '0')}:00Z`,
      }));
    const http = {
      json: async (url) => {
        asked.push(url);
        const page = Number(new URL(url).searchParams.get('page'));
        return { items: page === 1 ? pageOf(100) : pageOf(3) };
      },
    };
    const gen = openprices.pull({
      config: { pages: 5 },
      cursor: { created: '2026-11-01T00:00:00Z' },
      http,
      log: () => {},
      deadline: Date.now() + 60_000,
    });
    const batches = [];
    let step = await gen.next();
    while (!step.done) {
      batches.push(step.value);
      step = await gen.next();
    }
    expect(batches.map((b) => b.items.length)).toEqual([100, 3]);
    expect(asked[0]).toContain('created__gte=2026-11-01T00%3A00%3A00Z');
    expect(asked[0]).toContain('order_by=created');
    expect(step.value.cursor.created > '2026-11-14T15:00:00Z').toBe(true);
    expect(step.value.nextInMinutes).toBeUndefined();
  });
});

describe('absorbOffers', () => {
  test('items with data.offer go to the graph; a failure is logged, not thrown', async () => {
    const calls = [];
    const logs = [];
    const items = [toItem(ROW()), { externalId: 'x', data: {} }];
    await absorbOffers({
      items,
      log: (m) => logs.push(m),
      keep: async (a) => (calls.push(a), { kept: a.offers.length }),
    });
    expect(calls[0].pages).toEqual([
      'https://prices.openfoodfacts.org/products/2030500294911?location=7930',
    ]);
    expect(logs).toEqual(['1 offers into the product graph']);
    await absorbOffers({
      items,
      log: (m) => logs.push(m),
      keep: async () => {
        throw new Error('down');
      },
    });
    expect(logs.at(-1)).toContain('product graph write failed');
  });
});
