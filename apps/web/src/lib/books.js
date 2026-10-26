import { config } from '@nichedb/config';
import { normaliseZip, zipKey } from '@nichedb/core/population';
import * as pop from '@nichedb/db/population';
import * as queries from '@nichedb/db/queries';
import {
  amazonTagged,
  applyAffiliate,
  OSM_ATTRIBUTION,
  parseAffiliateTemplates,
  placesNear,
} from './automotive.js';

/**
 * Where to buy a book: online, in a shop near you, or to borrow.
 *
 * No bookseller publishes stock or prices to anyone without a contract, so
 * this does what the VIN page does for parts. It builds the link a person
 * would have typed, at the places that actually sell books, with the ISBN in
 * it when there is one (an ISBN lands on the exact edition at every seller
 * here) and the title and author when there is not. In-store is the same
 * idea plus OpenStreetMap: the chains' own store finders with the ZIP in them,
 * and the bookshops and libraries that are actually near that ZIP.
 */

const q = (s) => encodeURIComponent(String(s).trim());

/* ------------------------------------------------------------------ ISBN -- */

/** Digits and an X only; ISBNs are printed with hyphens and spaces. */
const bare = (raw) =>
  String(raw ?? '')
    .toUpperCase()
    .replace(/^ISBN(?:-1[03])?:?/, '')
    .replace(/[\s-]/g, '');

const isbn10Valid = (s) => {
  if (!/^\d{9}[\dX]$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += (s[i] === 'X' ? 10 : Number(s[i])) * (10 - i);
  return sum % 11 === 0;
};

const isbn13Check = (twelve) => {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(twelve[i]) * (i % 2 ? 3 : 1);
  return String((10 - (sum % 10)) % 10);
};

const isbn13Valid = (s) => /^97[89]\d{10}$/.test(s) && isbn13Check(s) === s[12];

/**
 * Both forms of one ISBN, or null for anything whose check digit is wrong.
 * A 979 ISBN has no ten-digit form, so `isbn10` is null for those.
 */
export function normaliseIsbn(raw) {
  const s = bare(raw);
  if (isbn10Valid(s)) {
    const twelve = `978${s.slice(0, 9)}`;
    return { isbn10: s, isbn13: twelve + isbn13Check(twelve) };
  }
  if (isbn13Valid(s)) {
    if (!s.startsWith('978')) return { isbn10: null, isbn13: s };
    const nine = s.slice(3, 12);
    let sum = 0;
    for (let i = 0; i < 9; i++) sum += Number(nine[i]) * (10 - i);
    const c = (11 - (sum % 11)) % 11;
    return { isbn10: nine + (c === 10 ? 'X' : String(c)), isbn13: s };
  }
  return null;
}

/** The first valid ISBN in a list, preferring one with a ten-digit form for Amazon. */
export function firstIsbn(list) {
  const valid = (Array.isArray(list) ? list : [list]).map(normaliseIsbn).filter(Boolean);
  return valid.find((v) => v.isbn10) ?? valid[0] ?? null;
}

/* ------------------------------------------------------------- the book -- */

/**
 * What a seller can be asked about one book item: its ISBN if any row we hold
 * carries one, otherwise its title and first author. Catalogue works carry
 * author keys rather than names, so for those the title stands alone.
 */
export function bookQuery(item) {
  const d = item?.data ?? {};
  const isbn = firstIsbn(d.isbn ?? d.isbn13 ?? d.isbn10 ?? []);
  const title = String(d.title ?? item?.title ?? '')
    .replace(/\s—\s.*$/, '')
    .trim();
  const authors = Array.isArray(d.authors) ? d.authors : [];
  const author = authors.find((a) => typeof a === 'string' && !a.startsWith('/authors/')) ?? '';
  return { isbn, title, author: d.author ?? author ?? '' };
}

/* --------------------------------------------------------------- sellers -- */

/**
 * The sellers, in the order a reader would try them, and which of them pay
 * for a referral (checked 2026-10-26). `kind` groups them on the page:
 * new, used, ebook, borrow.
 */
export const BOOK_SELLERS = [
  {
    key: 'amazon',
    vendor: 'Amazon',
    kind: 'new',
    program: { network: 'Amazon Associates', signup: 'https://affiliate-program.amazon.com/' },
    // /dp/<ISBN-10> is the edition's own page; a 979 ISBN has no ten-digit form.
    url: ({ isbn, text }) =>
      isbn?.isbn10
        ? `https://www.amazon.com/dp/${isbn.isbn10}`
        : `https://www.amazon.com/s?k=${q(isbn?.isbn13 ?? text)}&i=stripbooks`,
    affiliate: amazonTagged,
  },
  {
    key: 'bookshop',
    vendor: 'Bookshop.org',
    kind: 'new',
    note: 'Online, with a share of every sale going to independent bookshops.',
    program: { network: 'Bookshop.org affiliates', signup: 'https://bookshop.org/affiliates' },
    url: ({ isbn, text }) =>
      isbn
        ? `https://bookshop.org/book/${isbn.isbn13}`
        : `https://bookshop.org/search?keywords=${q(text)}`,
  },
  {
    key: 'barnesandnoble',
    vendor: 'Barnes & Noble',
    kind: 'new',
    note: 'An ISBN search lands on the product page, where in-store pickup is offered.',
    program: {
      network: 'Rakuten Advertising',
      signup: 'https://www.barnesandnoble.com/h/affiliate-program',
    },
    url: ({ isbn, text }) => `https://www.barnesandnoble.com/s/${q(isbn?.isbn13 ?? text)}`,
  },
  {
    key: 'booksamillion',
    vendor: 'Books-A-Million',
    kind: 'new',
    program: null,
    url: ({ isbn, text }) =>
      `https://www.booksamillion.com/search2?query=${q(isbn?.isbn13 ?? text)}`,
  },
  {
    key: 'target',
    vendor: 'Target',
    kind: 'new',
    program: { network: 'Target Partners (Impact)', signup: 'https://partners.target.com/' },
    url: ({ isbn, text }) => `https://www.target.com/s?searchTerm=${q(isbn?.isbn13 ?? text)}`,
  },
  {
    key: 'walmart',
    vendor: 'Walmart',
    kind: 'new',
    program: { network: 'Walmart Creator (Impact)', signup: 'https://affiliates.walmart.com/' },
    url: ({ isbn, text }) => `https://www.walmart.com/search?q=${q(isbn?.isbn13 ?? text)}`,
  },
  {
    key: 'powells',
    vendor: "Powell's",
    kind: 'new',
    note: 'Independent, new and used on the same shelf.',
    program: { network: "Powell's Partners", signup: 'https://www.powells.com/partners' },
    url: ({ isbn, text }) =>
      `https://www.powells.com/books/search?query=${q(isbn?.isbn13 ?? text)}`,
  },
  {
    key: 'thriftbooks',
    vendor: 'ThriftBooks',
    kind: 'used',
    program: null,
    url: ({ isbn, text }) =>
      `https://www.thriftbooks.com/browse/?b.search=${q(isbn?.isbn13 ?? text)}`,
  },
  {
    key: 'betterworldbooks',
    vendor: 'Better World Books',
    kind: 'used',
    program: null,
    url: ({ isbn, text }) =>
      `https://www.betterworldbooks.com/search/results?q=${q(isbn?.isbn13 ?? text)}`,
  },
  {
    key: 'abebooks',
    vendor: 'AbeBooks',
    kind: 'used',
    note: 'Used, rare and first editions from thousands of shops.',
    program: null,
    url: ({ isbn, text }) =>
      isbn
        ? `https://www.abebooks.com/servlet/SearchResults?isbn=${isbn.isbn13}`
        : `https://www.abebooks.com/servlet/SearchResults?kn=${q(text)}`,
  },
  {
    key: 'ebay',
    vendor: 'eBay',
    kind: 'used',
    program: { network: 'eBay Partner Network', signup: 'https://partnernetwork.ebay.com/' },
    // 267 is Books & Magazines.
    url: ({ isbn, text }) => `https://www.ebay.com/sch/267/i.html?_nkw=${q(isbn?.isbn13 ?? text)}`,
  },
  {
    key: 'bookfinder',
    vendor: 'BookFinder',
    kind: 'used',
    note: 'Compares prices across most of the sellers above, new and used.',
    program: null,
    isbnOnly: true,
    url: ({ isbn }) => `https://www.bookfinder.com/isbn/${isbn.isbn13}/`,
  },
  {
    key: 'googleplay',
    vendor: 'Google Play Books',
    kind: 'ebook',
    program: null,
    url: ({ isbn, text }) =>
      `https://play.google.com/store/search?q=${q(isbn?.isbn13 ?? text)}&c=books`,
  },
  {
    key: 'kobo',
    vendor: 'Kobo',
    kind: 'ebook',
    program: { network: 'Rakuten Advertising', signup: 'https://www.kobo.com/affiliates' },
    url: ({ isbn, text }) => `https://www.kobo.com/us/en/search?query=${q(isbn?.isbn13 ?? text)}`,
  },
  {
    key: 'libby',
    vendor: 'Libby (your library)',
    kind: 'borrow',
    note: 'Ebooks and audiobooks on your library card.',
    program: null,
    url: ({ text }) => `https://libbyapp.com/search/query-${q(text)}/page-1`,
  },
  {
    key: 'worldcat',
    vendor: 'WorldCat',
    kind: 'borrow',
    note: 'Which libraries hold a copy, nearest first.',
    program: null,
    url: ({ isbn, text }) =>
      `https://search.worldcat.org/search?q=${isbn ? `bn:${isbn.isbn13}` : q(text)}`,
  },
];

export const SELLER_KINDS = {
  new: 'New',
  used: 'Used and compare',
  ebook: 'Ebook',
  borrow: 'Borrow',
};

/**
 * Every seller's link for one book. `{ isbn, title, author }` is what
 * `bookQuery` returns; an ISBN wins over the title wherever a seller can
 * search by it.
 */
export function buyLinks({ isbn = null, title = '', author = '' }, { affiliates = null } = {}) {
  const text = [title, author].filter(Boolean).join(' ').slice(0, 160);
  if (!isbn && !text) return [];
  const templates = affiliates ?? parseAffiliateTemplates(config.automotive.affiliateLinks);
  return BOOK_SELLERS.filter((v) => isbn || !v.isbnOnly).map((v) => {
    const plain = v.url({ isbn, text });
    const wrapped = applyAffiliate(v.key, plain, templates);
    const { url, sponsored } =
      wrapped.sponsored || !v.affiliate
        ? wrapped
        : v.affiliate(plain, { tag: config.automotive.amazonTag, subtag: 'nichedb-books' });
    return {
      key: v.key,
      vendor: v.vendor,
      kind: v.kind,
      ...(v.note ? { note: v.note } : {}),
      url,
      sponsored,
    };
  });
}

/* -------------------------------------------------------------- in store -- */

/**
 * The chains' own store finders. None of them will say what is on the shelf
 * without a partnership, but every one takes a ZIP and lists its stores with
 * their phone numbers, and B&N's product page offers pickup once a store is
 * picked.
 */
export const STORE_CHAINS = [
  {
    key: 'barnesandnoble',
    vendor: 'Barnes & Noble',
    url: (zip) => `https://stores.barnesandnoble.com/?searchText=${q(zip)}`,
  },
  {
    key: 'booksamillion',
    vendor: 'Books-A-Million',
    url: (zip) => `https://www.booksamillion.com/storefinder?zip=${q(zip)}`,
  },
  // Half Price Books' finder takes no ZIP in its address; it asks once there.
  { key: 'halfpricebooks', vendor: 'Half Price Books', url: () => 'https://hpb.com/stores' },
  {
    key: 'target',
    vendor: 'Target',
    url: (zip) => `https://www.target.com/store-locator/find-stores/${q(zip)}`,
  },
  {
    key: 'walmart',
    vendor: 'Walmart',
    url: (zip) => `https://www.walmart.com/store-finder?location=${q(zip)}`,
  },
];

export const storeFinders = (zip) =>
  STORE_CHAINS.map((s) => ({ key: s.key, vendor: s.vendor, url: s.url(zip ?? '') }));

/** A US ZIP's centre, from the Census rows the population collection holds. */
export async function zipPoint(raw, { areaByKey = pop.areaByKey } = {}) {
  const zip = normaliseZip(raw);
  if (!zip) return null;
  const row = await areaByKey(zipKey(zip)).catch(() => null);
  const loc = row?.data?.location;
  if (typeof loc?.lat !== 'number' || typeof loc?.long !== 'number') return { zip, point: null };
  return {
    zip,
    point: { lat: loc.lat, lon: loc.long },
    label: row.data?.cityName ? `${row.data.cityName}, ${row.data.state}` : `ZIP ${zip}`,
  };
}

/**
 * Patient, like /mechanics rather than a VIN profile's short wait: the shops
 * are what this page was asked for, and a cold Overpass answer for a 10-mile
 * radius took 30s when measured (2026-10-26). The tile is then cached a week.
 */
const STORE_BUDGET = { timeoutMs: 25_000, maxMirrors: 2 };
/** How long a page waits for that before rendering without the shops. */
const STORE_WAIT_MS = 15_000;

/**
 * Bookshops and libraries near a point. Each list fails on its own; a tile is
 * cached for a week by placesNear, so a slow mirror is one caller's problem.
 */
export async function storesNear({ lat, lon, radiusMiles = 10, limit = 20, near = placesNear }) {
  const [shops, libraries] = await Promise.all([
    near({ lat, lon, radiusMiles, kind: 'books', limit, ...STORE_BUDGET }),
    near({ lat, lon, radiusMiles, kind: 'library', limit, ...STORE_BUDGET }),
  ]);
  return {
    bookshops: shops.places ?? [],
    libraries: libraries.places ?? [],
    error: shops.error ?? libraries.error ?? null,
    attribution: OSM_ATTRIBUTION,
  };
}

/* --------------------------------------------------------------- edition -- */

const UA = 'nichedb.dev books (+https://nichedb.dev)';
const editionCache = new Map();
const EDITION_TTL_MS = 24 * 3600 * 1000;

/**
 * One edition from Open Library, by ISBN: title, authors, publisher, pages,
 * cover and the work it belongs to. Keyless and CC0. Null when Open Library
 * has never heard of it, which still leaves every seller's ISBN link working.
 */
export async function isbnEdition(isbn13, { fetchJson = null } = {}) {
  const hit = editionCache.get(isbn13);
  if (hit && Date.now() - hit.at < EDITION_TTL_MS) return hit.value;
  const get =
    fetchJson ??
    (async (url) => {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      return res.ok ? res.json() : null;
    });
  const key = `ISBN:${isbn13}`;
  const json = await get(
    `https://openlibrary.org/api/books?bibkeys=${key}&format=json&jscmd=data`,
  ).catch(() => null);
  const d = json?.[key];
  const value = d
    ? {
        title: d.title ?? null,
        subtitle: d.subtitle ?? null,
        authors: (d.authors ?? []).map((a) => a.name).filter(Boolean),
        publishers: (d.publishers ?? []).map((p) => p.name).filter(Boolean),
        publishDate: d.publish_date ?? null,
        pages: d.number_of_pages ?? null,
        cover: d.cover?.medium ?? null,
        subjects: (d.subjects ?? []).map((s) => s.name).slice(0, 10),
        openLibrary: d.url ?? null,
        editionKey: d.key ?? null,
        workKey: null,
      }
    : null;
  // The data view leaves the work out; the edition's own record has it.
  if (value?.editionKey) {
    const ed = await get(`https://openlibrary.org${value.editionKey}.json`).catch(() => null);
    value.workKey = ed?.works?.[0]?.key ?? null;
  }
  if (editionCache.size > 5000) editionCache.delete(editionCache.keys().next().value);
  editionCache.set(isbn13, { at: Date.now(), value });
  return value;
}

/* ---------------------------------------------------------------- answer -- */

/**
 * The book being asked about, from `isbn` or `title`/`author`, or from `item`,
 * an id in the books collection. An ISBN that fails its check digit is an
 * error, not a silent fall back to the title.
 */
export async function bookFrom({ isbn, title, author, item }) {
  let row = null;
  if (item && /^\d+$/.test(String(item))) {
    row = await queries.getItem(item).catch(() => null);
    if (row?.collection_slug !== 'books') row = null;
  }
  if (isbn) {
    const parsed = normaliseIsbn(isbn);
    if (!parsed) return { error: 'That is not a valid ISBN: its check digit does not match.' };
    return { book: { isbn: parsed, title: title ?? '', author: author ?? '' }, row };
  }
  if (row) return { book: bookQuery(row), row };
  if (title?.trim())
    return {
      book: {
        isbn: null,
        title: title.trim().slice(0, 200),
        author: (author ?? '').trim().slice(0, 120),
      },
      row,
    };
  return { error: 'Give an ISBN, or a title and an author.' };
}

/** The whole answer: edition, sellers, and the shops near the ZIP when one was given. */
export async function answer({ book, row, zip }) {
  const edition = book.isbn ? await isbnEdition(book.isbn.isbn13) : null;
  if (edition && !book.title) book.title = edition.title ?? '';
  if (edition && !book.author) book.author = edition.authors[0] ?? '';
  const item =
    row ??
    (edition?.workKey
      ? await queries.itemByExternalId('books', edition.workKey).catch(() => null)
      : null);
  let near = null;
  let stores = null;
  let zipError = null;
  if (zip) {
    near = await zipPoint(zip);
    if (!near) zipError = 'That is not a US ZIP code.';
    else if (!near.point) zipError = `We have no map point for ZIP ${near.zip}.`;
    else {
      // The page does not wait out a slow map server. The lookup keeps running
      // and caches its tile, so a reload a minute later has the shops.
      const lookup = storesNear(near.point).catch(() => null);
      const pending = new Promise((r) => setTimeout(() => r(null), STORE_WAIT_MS));
      stores = (await Promise.race([lookup, pending])) ?? {
        bookshops: [],
        libraries: [],
        error:
          'OpenStreetMap is slow right now; the shops near you will be here if you reload in a minute.',
        attribution: OSM_ATTRIBUTION,
      };
    }
  }
  return { book, edition, item, zip: near?.zip ?? '', near, stores, zipError };
}

export const buyAnswer = (a) => ({
  isbn: a.book.isbn,
  title: a.edition?.title ?? a.book.title ?? null,
  author: a.book.author || null,
  edition: a.edition,
  item: a.item ? { id: a.item.id, title: a.item.title, url: `/i/${a.item.id}` } : null,
  online: buyLinks(a.book),
  inStore: a.zip
    ? {
        zip: a.zip,
        near: a.near?.label ?? null,
        storeFinders: storeFinders(a.zip),
        bookshops: a.stores?.bookshops ?? [],
        libraries: a.stores?.libraries ?? [],
        error: a.zipError ?? a.stores?.error ?? null,
        attribution: a.stores?.attribution ?? null,
      }
    : null,
  note: 'Sellers do not publish stock or prices; these links carry the ISBN (or title) to each one. Edition data: Open Library, CC0.',
});

/** For the MCP tool: the same answer without a request. */
export async function whereToBuy({ isbn, title, author, item, zip }) {
  const found = await bookFrom({ isbn, title, author, item });
  if (found.error) return found;
  return buyAnswer(await answer({ ...found, zip: zip?.trim() ?? '' }));
}
