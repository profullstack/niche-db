# The product graph

An open index of what stores sell, read from the product data stores already
publish on their own pages, and joined across stores by what the product is.
Open to people at `/products` and to agents over the API and MCP. No store pays
to be listed.

## Where the rows come from

The pit.world crawler (pitbot) pushes every page it reads to
`POST /api/v1/sites/records`. Each record keeps the page's JSON-LD.
`keepProductOffers` (apps/web/src/lib/sites.js) reads every schema.org
`Product` / `ProductGroup` variant / `Offer` / `AggregateOffer` in it
(packages/core/src/products.js) and writes one row per offer to
`product_offers` (migration 0045). A product page with Open Graph prices and no
JSON-LD product gives one offer from those.

A page's offers are replaced as a set each time it is read, so an offer a store
stops stating disappears. A graph write never fails the crawler's push.

## Other sources

- **Open Prices** (prices.openfoodfacts.org, ODbL): what people paid, from
  receipts and price tags, by barcode, at OpenStreetMap shops. The `openprices`
  adapter writes each price to `/c/prices` and its `data.offer` to the graph
  (ingest's `absorbOffers`; any adapter can do the same). One offer per
  (barcode, shop); a newer price at that shop replaces the older. The variant
  text carries the receipt date, since `seenAt` is when we read the row.
- **Stores to crawl**: pitbot seeds shops from c0upons.com (`seed --from
  c0upons`) and from Wikidata's online shops and retail chains with an official
  website (`seed --from wikidata-shops`), and reads product sitemaps and
  product-looking pages first, so a shop's 1,000 pages are mostly products.

## Identity

| key | when | joins stores? |
| --- | --- | --- |
| `gtin:<14 digits>` | a GTIN-8/12/13/14, UPC, EAN or ISBN-13 with a correct GS1 check digit | yes |
| `mpn:<brand>:<mpn>` | brand and maker part number, slugged | yes |
| `url:<page>` | neither | no |

Wrong check digits are common in store data (Shopify barcode fields hold SKUs
and typos), so an unchecked number is never trusted to join two products.

## Reading it

- `GET /api/v1/products?q=…`: words over name, brand, variant, category, MPN, SKU
- `GET /api/v1/products?gtin=…`: exact; a bare barcode in `q` works too
- `GET /api/v1/products?brand=…&mpn=…`: exact
- `&host=<store>` keeps one store; `&limit=1..50`
- `GET /api/v1/products/<key>`: one product, every store
- MCP `find_product`; `where_to_buy_book` adds `statedOffers` for its ISBN
- `/products`, `/products/<key>`: the same for people

Offers sort buyable first (InStock, PreOrder, BackOrder... or unstated), then
cheapest. `lowPrice` is given only when every buyable priced offer shares one
currency. Prices are what the page said when last read: each offer has `seenAt`.

## Backfill

Pages crawled before the graph existed:

    bun scripts/backfill-product-graph.js [--before <item id>] [--batch 500]

It walks `/c/sites` items of kind `product` newest first on `items_kind_idx`
and prints a resumable cursor.

## What makes it useful

Joins need two stores carrying the same item. pitbot's seeds so far are blogs,
podcasts and indie sites (a 5,000-page sample on 2026-11-14 gave 4,476
products, 319 with a GTIN or MPN, and no product at two stores), so the graph
grows denser as stores that overlap are seeded.
