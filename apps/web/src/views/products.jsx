import { buyable } from '@nichedb/core/products';
import { Layout } from './Layout.jsx';

/**
 * /products: the product graph. What stores state about what they sell, in
 * their own product page JSON-LD, joined across stores by GTIN or brand + MPN.
 */

const money = (price, currency) =>
  price == null
    ? 'no price'
    : new Intl.NumberFormat('en-US', {
        style: currency ? 'currency' : 'decimal',
        currency: currency ?? undefined,
        minimumFractionDigits: 2,
      }).format(price);

const stock = (a) =>
  a == null ? 'stock not stated' : a.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();

const identity = (p) =>
  p.gtin
    ? `GTIN ${p.gtin.replace(/^0+(?=\d{8,})/, '')}`
    : p.mpn
      ? `MPN ${p.mpn}`
      : 'one store only';

export const productPath = (key) => `/products/${encodeURIComponent(key)}`;

const Search = ({ value = '' }) => (
  <form method="get" action="/products" class="inline">
    <input
      name="q"
      value={value}
      placeholder="A product, brand, part number, UPC, EAN or ISBN"
      aria-label="Product"
      required
    />
    <button type="submit">Find</button>
  </form>
);

const Offers = ({ offers }) => (
  <table>
    <thead>
      <tr>
        <th>Store</th>
        <th>Price</th>
        <th>Stock</th>
        <th>Variant</th>
      </tr>
    </thead>
    <tbody>
      {offers.map((o) => (
        <tr class={buyable(o.availability) ? '' : 'muted'}>
          <td>
            <a href={o.offerUrl} rel="nofollow noopener">
              {o.seller ?? o.host}
            </a>{' '}
            <small>{o.host}</small>
          </td>
          <td>{money(o.price, o.currency)}</td>
          <td>{stock(o.availability)}</td>
          <td>{o.variant ?? ''}</td>
        </tr>
      ))}
    </tbody>
  </table>
);

const Card = ({ p }) => (
  <article class="card">
    <h3>
      <a href={productPath(p.key)}>{p.name}</a>
    </h3>
    <p class="meta">
      {p.brand ? `${p.brand} · ` : ''}
      {identity(p)} · {p.stores} {p.stores === 1 ? 'store' : 'stores'}
      {p.lowPrice != null ? ` · from ${money(p.lowPrice, p.currency)}` : ''}
    </p>
  </article>
);

export function ProductsPage({ user, stats, query, products, error }) {
  return (
    <Layout
      user={user}
      canonical={query ? `/products?q=${encodeURIComponent(query)}` : '/products'}
      title={query ? `${query}: where to buy` : 'Product graph: every store, one product'}
      description="Products and prices as stores state them on their own pages, joined across stores by UPC, EAN, ISBN or part number. Open to people and AI agents."
    >
      <section class="hero">
        <h1>Product graph</h1>
        <p class="lede">
          What stores say they sell, read from the product data they publish on their own pages, and
          joined across stores by barcode (UPC, EAN, ISBN) or the maker's part number. No store pays
          to be here and none is left out for not paying.
        </p>
        <Search value={query ?? ''} />
        {stats ? (
          <p class="meta">
            {stats.offers.toLocaleString('en-US')} offers · {stats.products.toLocaleString('en-US')}{' '}
            products ({stats.identified.toLocaleString('en-US')} with a barcode or part number) ·{' '}
            {stats.stores.toLocaleString('en-US')} stores
          </p>
        ) : null}
        {error ? <p class="error">{error}</p> : null}
      </section>
      {query && products.length === 0 && !error ? <p>Nothing matched.</p> : null}
      {products.map((p) => (
        <Card p={p} />
      ))}
      <section>
        <h2>For agents and code</h2>
        <p>
          <code>GET /api/v1/products?q=…</code> · <code>?gtin=…</code> ·{' '}
          <code>?brand=…&amp;mpn=…</code> · <code>GET /api/v1/products/&lt;key&gt;</code> · MCP tool{' '}
          <code>find_product</code> at <a href="/mcp">/mcp</a>. Free, no key. Prices are what the
          store's page said when it was last read; each offer carries <code>seenAt</code>.
        </p>
      </section>
    </Layout>
  );
}

export function ProductPage({ user, product }) {
  const p = product;
  return (
    <Layout
      user={user}
      canonical={productPath(p.key)}
      title={`${p.name}: compare ${p.stores} ${p.stores === 1 ? 'store' : 'stores'}`}
      description={`${p.name}${p.brand ? ` by ${p.brand}` : ''}: prices and stock at ${p.stores} ${p.stores === 1 ? 'store' : 'stores'}, as each store states them.`}
    >
      <section class="hero">
        <h1>{p.name}</h1>
        <p class="meta">
          {p.brand ? `${p.brand} · ` : ''}
          {identity(p)}
          {p.category ? ` · ${p.category}` : ''}
        </p>
        <Search />
      </section>
      <Offers offers={p.offers} />
      <p class="meta">
        Prices and stock are what each store's page stated when it was last read. API:{' '}
        <code>GET /api/v1/products/{encodeURIComponent(p.key)}</code>
      </p>
    </Layout>
  );
}
