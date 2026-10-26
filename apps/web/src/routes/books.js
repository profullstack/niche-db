import { answer, bookFrom, buyAnswer, normaliseIsbn } from '../lib/books.js';
import { render } from '../lib/http.js';
import { BuyPage, IsbnPage } from '../views/books.jsx';

/**
 * Where to buy a book: /isbn, /isbn/<isbn>, /books/buy, and the same answer
 * as JSON at /api/v1/books/buy and /api/v1/isbn/<isbn>.
 *
 * Free, unlike the VIN lookups: the seller links cost nothing to build, the
 * edition is one cached Open Library call, and the shops near a ZIP are
 * cached per map tile for a week.
 */

export function registerBooks(app) {
  app.get('/isbn', async (c) => {
    const raw = c.req.query('isbn');
    if (raw) {
      const parsed = normaliseIsbn(raw);
      if (parsed) return c.redirect(`/isbn/${parsed.isbn13}`, 302);
      return c.html(
        await render(
          <IsbnPage
            user={c.get('user')}
            value={raw}
            error="That is not a valid ISBN: its check digit does not match."
          />,
        ),
        400,
      );
    }
    return c.html(await render(<IsbnPage user={c.get('user')} />));
  });

  const page = async (c, args) => {
    const found = await bookFrom(args);
    if (found.error)
      return c.html(await render(<IsbnPage user={c.get('user')} error={found.error} />), 400);
    const a = await answer({ ...found, zip: c.req.query('zip')?.trim() ?? '' });
    return c.html(
      await render(
        <BuyPage
          user={c.get('user')}
          canonical={a.book.isbn ? `/isbn/${a.book.isbn.isbn13}` : '/books/buy'}
          book={a.book}
          edition={a.edition}
          item={a.item}
          zip={a.zip || (c.req.query('zip') ?? '')}
          near={a.near}
          stores={a.stores}
          error={a.zipError}
        />,
      ),
    );
  };

  app.get('/isbn/:isbn', (c) => page(c, { isbn: c.req.param('isbn') }));

  app.get('/books/buy', (c) =>
    page(c, {
      isbn: c.req.query('isbn'),
      title: c.req.query('title'),
      author: c.req.query('author'),
      item: c.req.query('item'),
    }),
  );

  const api = async (c, args) => {
    const found = await bookFrom(args);
    if (found.error) return c.json({ error: found.error }, 400);
    return c.json(buyAnswer(await answer({ ...found, zip: c.req.query('zip')?.trim() ?? '' })));
  };

  app.get('/api/v1/isbn/:isbn', (c) => api(c, { isbn: c.req.param('isbn') }));

  app.get('/api/v1/books/buy', (c) =>
    api(c, {
      isbn: c.req.query('isbn'),
      title: c.req.query('title'),
      author: c.req.query('author'),
      item: c.req.query('item'),
    }),
  );
}
