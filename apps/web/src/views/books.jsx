import { bookQuery, buyLinks, SELLER_KINDS, storeFinders } from '../lib/books.js';
import { Notice } from './components.jsx';
import { Layout } from './Layout.jsx';

/**
 * Where to buy a book: the block on every book's item page, and the page
 * behind /isbn/<isbn> and /books/buy that adds the shops near a ZIP.
 */

const SellerLinks = ({ links }) => (
  <>
    {Object.entries(SELLER_KINDS).map(([kind, label]) => {
      const here = links.filter((l) => l.kind === kind);
      if (here.length === 0) return null;
      return (
        <div key={kind}>
          <h3>{label}</h3>
          <ul class="tags">
            {here.map((l) => (
              <li key={l.key}>
                {/* `sponsored` only once a programme has actually approved us. */}
                <a
                  class="tag"
                  href={l.url}
                  rel={l.sponsored ? 'sponsored nofollow noopener' : 'nofollow noopener'}
                  title={l.note ?? l.vendor}
                >
                  {l.vendor}
                </a>
              </li>
            ))}
          </ul>
        </div>
      );
    })}
    {links.some((l) => l.sponsored) ? (
      <p class="small muted">
        Some of these links pay us a commission if you buy through them. It costs you nothing and it
        does not change which sellers are listed or their order.
        {links.some((l) => l.sponsored && l.key === 'amazon')
          ? ' As an Amazon Associate I earn from qualifying purchases.'
          : ''}
      </p>
    ) : null}
  </>
);

const ZipForm = ({ book, zip = '', itemId = null }) => (
  <form class="row" method="get" action="/books/buy">
    {book.isbn ? <input type="hidden" name="isbn" value={book.isbn.isbn13} /> : null}
    {!book.isbn && book.title ? <input type="hidden" name="title" value={book.title} /> : null}
    {!book.isbn && book.author ? <input type="hidden" name="author" value={book.author} /> : null}
    {itemId ? <input type="hidden" name="item" value={String(itemId)} /> : null}
    <div class="field">
      <label class="label" for="zip">
        ZIP code
      </label>
      <input
        id="zip"
        name="zip"
        type="text"
        value={zip}
        placeholder="95030"
        maxlength="10"
        inputmode="numeric"
        autocomplete="postal-code"
      />
    </div>
    <button class="cta" type="submit">
      Find shops near me
    </button>
  </form>
);

/** The block on a book's item page: every seller online, and the ZIP box for in store. */
export const WhereToBuy = ({ item }) => {
  const book = bookQuery(item);
  const links = buyLinks(book);
  if (links.length === 0) return null;
  return (
    <section class="enrich" id="where-to-buy">
      <h2>Where to buy</h2>
      <SellerLinks links={links} />
      <h3>In a shop near you</h3>
      <ZipForm book={book} itemId={item.id} />
      <p class="help">
        Bookshops and libraries near that ZIP, and the store finders of Barnes &amp; Noble,
        Books-A-Million, Half Price Books, Target and Walmart.
      </p>
    </section>
  );
};

const Place = ({ p }) => (
  <li>
    <strong>{p.name}</strong>
    {p.miles !== null && p.miles !== undefined ? <span class="muted"> · {p.miles} mi</span> : null}
    {p.brand && p.brand !== p.name ? <span class="muted"> · {p.brand}</span> : null}
    {p.address ? <div class="small">{p.address}</div> : null}
    <div class="small">
      {p.phone ? (
        <>
          <a href={`tel:${p.phone.replace(/[^\d+]/g, '')}`}>{p.phone}</a>
          {' · '}
        </>
      ) : null}
      {p.website ? (
        <>
          <a href={p.website} rel="nofollow noopener">
            Website
          </a>
          {' · '}
        </>
      ) : null}
      <a href={p.osmUrl} rel="nofollow noopener">
        Map
      </a>
      {p.openingHours ? <span class="muted"> · {p.openingHours}</span> : null}
    </div>
  </li>
);

/** /isbn/<isbn> and /books/buy. */
export const BuyPage = ({
  user,
  canonical,
  book,
  edition = null,
  item = null,
  zip = '',
  near = null,
  stores = null,
  error = null,
}) => {
  const title = edition?.title ?? book.title ?? (book.isbn ? `ISBN ${book.isbn.isbn13}` : 'A book');
  const links = buyLinks(book);
  return (
    <Layout
      user={user}
      canonical={canonical}
      title={`Where to buy ${title}`}
      description={`Where to buy ${title}: new, used and ebook sellers online, and the bookshops and libraries near you.`}
    >
      <p class="crumb">
        <a href="/c/books">Books</a> › <a href="/isbn">ISBN lookup</a>
      </p>
      <article class="detail">
        {edition?.cover ? <img class="hero-img" src={edition.cover} alt="" /> : null}
        <h1>{title}</h1>
        {edition ? (
          <p class="item-meta">
            {[
              edition.authors.join(', '),
              edition.publishers[0],
              edition.publishDate,
              edition.pages ? `${edition.pages} pages` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        ) : book.author ? (
          <p class="item-meta">{book.author}</p>
        ) : null}
        {book.isbn ? (
          <p class="small muted">
            ISBN-13 <code>{book.isbn.isbn13}</code>
            {book.isbn.isbn10 ? (
              <>
                {' '}
                · ISBN-10 <code>{book.isbn.isbn10}</code>
              </>
            ) : null}
            {edition?.openLibrary ? (
              <>
                {' · '}
                <a href={edition.openLibrary} rel="noopener nofollow">
                  Open Library ↗
                </a>
              </>
            ) : null}
            {item ? (
              <>
                {' · '}
                <a href={`/i/${item.id}`}>In the books collection</a>
              </>
            ) : null}
          </p>
        ) : null}
        <Notice error={error} />

        <section>
          <h2>Online</h2>
          {links.length ? <SellerLinks links={links} /> : <p>Give an ISBN or a title.</p>}
        </section>

        <section id="in-store">
          <h2>In a shop near you</h2>
          <ZipForm book={book} zip={zip} itemId={item?.id ?? null} />
          {zip ? (
            <>
              <h3>Store finders{near?.label ? ` near ${near.label}` : ''}</h3>
              <ul class="tags">
                {storeFinders(zip).map((s) => (
                  <li key={s.key}>
                    <a class="tag" href={s.url} rel="nofollow noopener">
                      {s.vendor}
                    </a>
                  </li>
                ))}
              </ul>
              <p class="small muted">
                None of the chains publish what is on a shelf, so call ahead
                {book.isbn ? ` with the ISBN, ${book.isbn.isbn13}` : ''}.
              </p>
            </>
          ) : null}
          {stores ? (
            <>
              <h3>Bookshops</h3>
              {stores.bookshops.length ? (
                <ul>
                  {stores.bookshops.map((p) => (
                    <Place key={p.id} p={p} />
                  ))}
                </ul>
              ) : (
                <p class="muted">None mapped within 10 miles.</p>
              )}
              <h3>Libraries</h3>
              {stores.libraries.length ? (
                <ul>
                  {stores.libraries.map((p) => (
                    <Place key={p.id} p={p} />
                  ))}
                </ul>
              ) : (
                <p class="muted">None mapped within 10 miles.</p>
              )}
              {stores.error ? <p class="small muted">{stores.error}</p> : null}
              <p class="small muted">Shops and libraries: {stores.attribution}.</p>
            </>
          ) : null}
        </section>

        <p class="small muted">
          Edition data from Open Library (CC0). The same answer as JSON:{' '}
          <code>GET /api/v1/books/buy?isbn=&amp;title=&amp;author=&amp;zip=</code>
        </p>
      </article>
    </Layout>
  );
};

/** /isbn with no ISBN yet. */
export const IsbnPage = ({ user, error = null, value = '' }) => (
  <Layout
    user={user}
    canonical="/isbn"
    title="ISBN lookup"
    description="Look up any ISBN: the edition, and where to buy it online, used, as an ebook, at a library or in a shop near you."
  >
    <section class="hero">
      <h1>ISBN lookup</h1>
      <p class="lede">
        Any ISBN, ten or thirteen digits: the edition, every major seller new and used, ebooks,
        libraries, and the bookshops near your ZIP.
      </p>
      <form class="row" method="get" action="/isbn">
        <div class="field">
          <label class="label" for="isbn">
            ISBN
          </label>
          <input
            id="isbn"
            name="isbn"
            type="text"
            value={value}
            placeholder="978-0-14-312774-1"
            maxlength="24"
            autocomplete="off"
            spellcheck="false"
            aria-invalid={error ? 'true' : undefined}
          />
        </div>
        <button class="cta" type="submit">
          Look it up
        </button>
      </form>
      <Notice error={error} />
    </section>
  </Layout>
);
