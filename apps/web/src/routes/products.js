import { config } from '@nichedb/config';
import * as products from '@nichedb/db/products';
import { render } from '../lib/http.js';
import { searchProducts as search } from '../lib/products.js';
import { isAdmin } from '../lib/service.js';
import { ProductPage, ProductsPage, productPath } from '../views/products.jsx';

/**
 * The product graph: /products (search page), /products/<key> (one product,
 * every store), and the same as JSON at /api/v1/products[/<key>]. Read-only,
 * no key. Rows come from keepProductOffers in lib/sites.js.
 */

const STATS_MS = 10 * 60 * 1000;
let statsCache = { at: 0, value: null };

async function stats() {
  if (Date.now() - statsCache.at < STATS_MS) return statsCache.value;
  try {
    statsCache = { at: Date.now(), value: await products.productStats() };
  } catch {
    statsCache = { at: Date.now(), value: statsCache.value };
  }
  return statsCache.value;
}

const withLinks = (p) => ({ ...p, page: `${config.siteUrl}${productPath(p.key)}` });

export function registerProducts(app) {
  app.get('/products', async (c) => {
    const q = (c.req.query('q') ?? '').trim();
    const out = q
      ? await search({ q }).catch(() => ({
          products: [],
          error: 'Search timed out; try fewer words.',
        }))
      : { products: [] };
    return c.html(
      await render(
        <ProductsPage
          user={c.get('user')}
          stats={await stats()}
          query={q || null}
          products={out.products}
          error={out.error ?? null}
        />,
      ),
    );
  });

  app.get('/products/:key{.+}', async (c) => {
    const product = await products.productByKey(c.req.param('key'));
    if (!product) return c.notFound();
    c.header('cache-control', 'public, max-age=300');
    return c.html(await render(<ProductPage user={c.get('user')} product={product} />));
  });

  app.get('/api/v1/products', async (c) => {
    const params = Object.fromEntries(
      ['q', 'gtin', 'brand', 'mpn', 'host', 'limit'].map((k) => [k, c.req.query(k)]),
    );
    if (!params.q && !params.gtin && !(params.brand && params.mpn) && !params.host) {
      return c.json(
        {
          stats: await stats(),
          ask: '?q=<words> | ?gtin=<UPC/EAN/ISBN-13> | ?brand=<brand>&mpn=<part number> [&host=<store>] [&limit=1..50]',
        },
        200,
      );
    }
    const out = await search(params).catch(() => ({ products: [], error: 'search timed out' }));
    if (out.error)
      return c.json(
        { error: out.error, products: [] },
        out.error.includes('timed out') ? 503 : 400,
      );
    c.header('cache-control', 'public, max-age=300');
    return c.json({ count: out.products.length, products: out.products.map(withLinks) });
  });

  /**
   * Shop product pages due for a re-read (pit.world's daily reprice). The
   * crawler's admin key only: it is a work list, not a public read.
   */
  app.get('/api/v1/products/pages', async (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'Sign in with an API key.' }, 401);
    if (!isAdmin(user))
      return c.json({ error: 'The re-read list is for the index operators.' }, 403);
    const out = await products.stalePages({
      after: c.req.query('after'),
      limit: c.req.query('limit'),
      olderThanHours: c.req.query('olderThanHours'),
    });
    c.header('cache-control', 'no-store');
    return c.json(out);
  });

  app.get('/api/v1/products/:key{.+}', async (c) => {
    const product = await products.productByKey(c.req.param('key'));
    if (!product) return c.json({ error: 'no such product' }, 404);
    c.header('cache-control', 'public, max-age=300');
    return c.json({ product: withLinks(product) });
  });
}
