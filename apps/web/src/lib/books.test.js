import { describe, expect, test } from 'bun:test';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';

const { bookQuery, buyLinks, isbnEdition, normaliseIsbn, storeFinders, storesNear, zipPoint } =
  await import('./books.js');

describe('normaliseIsbn', () => {
  test('a hyphenated ISBN-13 gives both forms', () => {
    expect(normaliseIsbn('978-0-14-312774-1')).toEqual({
      isbn10: '0143127748',
      isbn13: '9780143127741',
    });
  });
  test('an ISBN-10 with an X check digit', () => {
    expect(normaliseIsbn('080442957X')).toEqual({ isbn10: '080442957X', isbn13: '9780804429573' });
    expect(normaliseIsbn('ISBN 0-8044-2957-x')?.isbn13).toBe('9780804429573');
  });
  test('a 979 ISBN has no ten-digit form', () => {
    expect(normaliseIsbn('9791034304066')).toEqual({ isbn10: null, isbn13: '9791034304066' });
  });
  test('a wrong check digit is refused', () => {
    expect(normaliseIsbn('9780143127742')).toBeNull();
    expect(normaliseIsbn('0143127749')).toBeNull();
    expect(normaliseIsbn('hello')).toBeNull();
  });
});

describe('bookQuery', () => {
  test('a search row carries an ISBN and author names', () => {
    const b = bookQuery({
      title: 'Dune — Frank Herbert',
      data: { title: 'Dune', authors: ['Frank Herbert'], isbn: ['bad', '9780441013593'] },
    });
    expect(b.isbn?.isbn13).toBe('9780441013593');
    expect(b.title).toBe('Dune');
    expect(b.author).toBe('Frank Herbert');
  });
  test('a catalogue work has author keys, so the title stands alone', () => {
    const b = bookQuery({ title: 'Dune', data: { title: 'Dune', authors: ['/authors/OL79034A'] } });
    expect(b).toEqual({ isbn: null, title: 'Dune', author: '' });
  });
});

describe('buyLinks', () => {
  const isbn = normaliseIsbn('9780143127741');
  test('ISBN links land on the edition', () => {
    const links = buyLinks({ isbn }, { affiliates: new Map() });
    const by = Object.fromEntries(links.map((l) => [l.key, l.url]));
    expect(by.amazon).toStartWith('https://www.amazon.com/dp/0143127748');
    expect(by.bookshop).toBe('https://bookshop.org/book/9780143127741');
    expect(by.bookfinder).toBe('https://www.bookfinder.com/isbn/9780143127741/');
    expect(links.every((l) => ['new', 'used', 'ebook', 'borrow'].includes(l.kind))).toBe(true);
  });
  test('without an ISBN it searches the title and author, and skips ISBN-only sellers', () => {
    const links = buyLinks({ title: 'Dune', author: 'Frank Herbert' }, { affiliates: new Map() });
    expect(links.find((l) => l.key === 'bookfinder')).toBeUndefined();
    expect(links.find((l) => l.key === 'amazon').url).toContain('k=Dune%20Frank%20Herbert');
  });
  test('nothing to ask is no links', () => {
    expect(buyLinks({})).toEqual([]);
  });
  test('an affiliate template marks the link sponsored', () => {
    const links = buyLinks(
      { isbn },
      { affiliates: new Map([['ebay', 'https://rover.example/?mpre={url}']]) },
    );
    const ebay = links.find((l) => l.key === 'ebay');
    expect(ebay.sponsored).toBe(true);
    expect(ebay.url).toStartWith('https://rover.example/?mpre=https%3A%2F%2Fwww.ebay.com');
    expect(links.find((l) => l.key === 'bookshop').sponsored).toBe(false);
  });
});

describe('in store', () => {
  test('store finders carry the ZIP', () => {
    const f = Object.fromEntries(storeFinders('95030').map((s) => [s.key, s.url]));
    expect(f.target).toBe('https://www.target.com/store-locator/find-stores/95030');
    expect(f.walmart).toContain('location=95030');
  });
  test('a ZIP becomes its Census centre', async () => {
    const areaByKey = async (key) =>
      key === 'us-95030'
        ? { data: { location: { lat: 37.22, long: -121.98 }, cityName: 'Los Gatos', state: 'CA' } }
        : null;
    expect(await zipPoint('95030-1234', { areaByKey })).toEqual({
      zip: '95030',
      point: { lat: 37.22, lon: -121.98 },
      label: 'Los Gatos, CA',
    });
    expect(await zipPoint('00000', { areaByKey })).toEqual({ zip: '00000', point: null });
    expect(await zipPoint('nope', { areaByKey })).toBeNull();
  });
  test('bookshops and libraries are asked separately and fail separately', async () => {
    const near = async ({ kind }) =>
      kind === 'books'
        ? { places: [{ id: 'node/1', name: 'Shop' }] }
        : { places: [], error: 'busy' };
    const s = await storesNear({ lat: 1, lon: 2, near });
    expect(s.bookshops).toHaveLength(1);
    expect(s.libraries).toEqual([]);
    expect(s.error).toBe('busy');
  });
});

describe('isbnEdition', () => {
  test('reads the data view and the work key, then caches', async () => {
    let calls = 0;
    const fetchJson = async (url) => {
      calls++;
      if (url.includes('/api/books'))
        return {
          'ISBN:9780000000002': {
            title: 'T',
            authors: [{ name: 'A' }],
            publishers: [{ name: 'P' }],
            key: '/books/OL1M',
            cover: { medium: 'c.jpg' },
          },
        };
      return { works: [{ key: '/works/OL1W' }] };
    };
    const e = await isbnEdition('9780000000002', { fetchJson });
    expect(e).toMatchObject({
      title: 'T',
      authors: ['A'],
      publishers: ['P'],
      workKey: '/works/OL1W',
    });
    await isbnEdition('9780000000002', { fetchJson });
    expect(calls).toBe(2);
  });
  test('an unknown ISBN is null', async () => {
    expect(await isbnEdition('9780000000019', { fetchJson: async () => ({}) })).toBeNull();
  });
});
