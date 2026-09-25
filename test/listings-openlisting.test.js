import { describe, expect, test } from 'bun:test';
import { ADAPTERS, adapterByName } from '../packages/adapters/src/index.js';
import {
  descriptorUrl,
  hostOf,
  indexEntries,
  locationOf,
  OFFER_TYPES,
  priceOf,
  STATUSES,
  servedFromOwnOrigin,
  summarise,
  tagsFor,
  toItem,
  WELL_KNOWN,
} from '../packages/adapters/src/openlisting.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';
const { COLLECTIONS, DEFAULT_FEEDS } = await import('../packages/core/src/seed.js');

const ORIGIN = 'https://northwind.example';
const ID = `${ORIGIN}/listings/14-elm`;

const listing = (over = {}) => ({
  type: 'logicsrc.openlisting',
  version: '0.1',
  id: ID,
  updated_at: '2026-09-25T10:00:00Z',
  seller: { name: 'Northwind Property', web: ORIGIN, kind: 'agent' },
  offer: {
    type: 'rent',
    status: 'available',
    price: { amount: '2450.00', currency: 'usd', per: 'month' },
  },
  subject: {
    type: 'property',
    title: 'Two-bedroom flat on Elm Street',
    property: { kind: 'apartment', bedrooms: 2 },
  },
  location: {
    locality: 'Kearney',
    region: 'NE',
    country: 'us',
    postal_code: '68847',
    precision: 'postal_code',
  },
  ...over,
});

describe('descriptorUrl', () => {
  test('a bare origin means the well-known index', () => {
    expect(descriptorUrl('northwind.example')).toBe(`${ORIGIN}${WELL_KNOWN}`);
    expect(descriptorUrl(ORIGIN)).toBe(`${ORIGIN}${WELL_KNOWN}`);
  });

  test('a full URL is taken as given', () => {
    expect(descriptorUrl(ID)).toBe(ID);
  });

  test('rubbish is dropped rather than fetched', () => {
    expect(descriptorUrl('')).toBeNull();
    expect(descriptorUrl(null)).toBeNull();
  });
});

describe('origin is the proof', () => {
  test('a listing served from the origin its id claims is believed', () => {
    expect(servedFromOwnOrigin(ID, ID)).toBe(true);
    expect(servedFromOwnOrigin(ID, `${ORIGIN}${WELL_KNOWN}`)).toBe(true);
  });

  test('www does not make it a different origin', () => {
    expect(servedFromOwnOrigin(ID, 'https://www.northwind.example/x')).toBe(true);
  });

  test('a document claiming somebody else’s id is refused', () => {
    const out = toItem(listing(), 'https://scraper.example/copy.json');
    expect(out.item).toBeUndefined();
    expect(out.rejected).toMatch(/does not match the origin/);
  });

  test("a seller's index may only point at its own listings", () => {
    const idx = indexEntries(
      {
        type: 'logicsrc.openlisting.index',
        listings: [{ id: ID }, { id: 'https://elsewhere.example/listings/1' }],
      },
      `${ORIGIN}${WELL_KNOWN}`,
    );
    expect(idx.entries.map((e) => e.id)).toEqual([ID]);
  });
});

describe('prices stay strings', () => {
  test('the published amount is carried through verbatim', () => {
    const p = priceOf({ amount: '2450.10', currency: 'usd', per: 'month' });
    expect(p.amount).toBe('2450.10');
    expect(typeof p.amount).toBe('string');
  });

  test('currency is normalised, amount is not', () => {
    expect(priceOf({ amount: '10.00', currency: 'usd' }).currency).toBe('USD');
  });

  test('a price missing a currency is not a price', () => {
    expect(priceOf({ amount: '10' })).toBeNull();
    expect(priceOf(null)).toBeNull();
  });

  test('a built item never turns the price into a number', () => {
    const { item } = toItem(listing(), ID);
    expect(typeof item.data.offer.price.amount).toBe('string');
  });
});

describe('location precision', () => {
  test('a street is dropped unless the seller said the location is that exact', () => {
    const loc = locationOf({ street: '14 Elm St', locality: 'Kearney', precision: 'postal_code' });
    expect(loc.street).toBeUndefined();
    expect(loc.locality).toBe('Kearney');
  });

  test('a street is kept when the precision says exact', () => {
    expect(locationOf({ street: '14 Elm St', precision: 'exact' }).street).toBe('14 Elm St');
  });

  test('an unknown precision is recorded as unstated rather than invented', () => {
    expect(locationOf({ precision: 'nonsense' }).precision).toBeNull();
  });
});

describe('toItem', () => {
  test('a listing becomes a storable item', () => {
    const { item } = toItem(listing(), ID);
    const stored = normaliseItem(item);
    expect(stored.externalId).toBe(`openlisting:${ID}`);
    expect(stored.kind).toBe('listing');
    expect(stored.title).toBe('Two-bedroom flat on Elm Street');
    expect(stored.url).toBe(ID);
    expect(stored.tags).toContain('offer:rent');
    expect(stored.tags).toContain('subject:property');
    expect(stored.tags).toContain('apartment');
  });

  test('the summary reads as a person would say it', () => {
    const { item } = toItem(listing(), ID);
    expect(item.summary).toContain('apartment');
    expect(item.summary).toContain('USD 2450.00/month');
    expect(item.summary).toContain('Kearney, NE');
  });

  test('a closed listing is ingested and tagged, not discarded', () => {
    // The outcome is the part every listing site loses.
    const { item } = toItem(
      listing({ offer: { type: 'sale', status: 'closed', closed_at: '2026-09-01' } }),
      ID,
    );
    expect(item.tags).toContain('closed');
    expect(item.data.offer.closedAt).toBeTruthy();
  });

  test('the profile block is carried through whole', () => {
    const { item } = toItem(listing(), ID);
    expect(item.data.subject.property.bedrooms).toBe(2);
  });

  test('bedrooms: 0 survives, because a studio is not an unstated bedroom count', () => {
    const doc = listing();
    doc.subject.property.bedrooms = 0;
    const { item } = toItem(doc, ID);
    expect(item.data.subject.property.bedrooms).toBe(0);
  });

  test('an unknown subject profile still yields a usable listing', () => {
    // The whole point of the two-axis design: a reader that does not know
    // OpenBoat still gets the price, the offer and the location.
    const doc = listing({ subject: { type: 'boat', title: 'A small boat' } });
    const { item } = toItem(doc, ID);
    expect(item.title).toBe('A small boat');
    expect(item.tags).toContain('subject:boat');
    expect(item.data.offer.price.amount).toBe('2450.00');
  });

  test('provenance names where it came from', () => {
    const { item } = toItem(listing(), ID);
    expect(item.data.source.id).toBe(ID);
    expect(item.data.spec).toBe('https://logicsrc.com/docs/openlisting');
  });

  test.each([
    ['not an openlisting document', { type: 'something.else' }],
    ['no id', { id: undefined }],
    ['offer.type', { offer: { type: 'barter', status: 'available' } }],
    ['offer.status', { offer: { type: 'sale', status: 'maybe' } }],
    ['subject needs a type and a title', { subject: { type: 'property' } }],
  ])('rejects a document with a bad %s', (reason, over) => {
    const out = toItem(listing(over), ID);
    expect(out.item).toBeUndefined();
    expect(out.rejected).toBeTruthy();
  });
});

describe('vocabularies match the spec', () => {
  test('offer types', () => {
    expect(OFFER_TYPES).toEqual(['sale', 'rent', 'lease', 'auction', 'free', 'wanted']);
  });

  test('statuses', () => {
    expect(STATUSES).toEqual(['available', 'pending', 'closed', 'withdrawn']);
  });
});

describe('registration', () => {
  test('the adapter is registered in the listings collection', () => {
    const a = adapterByName('openlisting');
    expect(a.collection).toBe('listings');
    expect(a.kinds).toEqual(['listing']);
    expect(ADAPTERS).toContain(a);
  });

  test('it ships no default source, because nobody serves a descriptor yet', () => {
    // A seeded source pointing at an invented origin would fail every run and
    // read as the adapter being broken.
    expect(adapterByName('openlisting').defaultSources).toEqual([]);
  });

  test('the listings collection exists', () => {
    expect(COLLECTIONS.some((c) => c.slug === 'listings')).toBe(true);
  });

  test('its feeds cover both axes', () => {
    const slugs = DEFAULT_FEEDS.filter((f) => f.collection === 'listings').map((f) => f.slug);
    for (const s of [
      'for-sale',
      'to-rent',
      'property-listings',
      'car-listings',
      'sold-and-closed',
    ]) {
      expect(slugs).toContain(s);
    }
  });
});

describe('hostOf', () => {
  test('strips www and lowercases', () => {
    expect(hostOf('https://WWW.Example.com/x')).toBe('example.com');
  });

  test('is null for rubbish', () => {
    expect(hostOf('not a url')).toBeNull();
  });
});

describe('summarise and tagsFor', () => {
  test('a summary with nothing to say is empty rather than misleading', () => {
    expect(summarise({}, { type: 'property' }, null)).toBe('property');
  });

  test('tags never invent a value that was not published', () => {
    const tags = tagsFor(
      { seller: {} },
      { type: 'sale', status: 'available' },
      { type: 'property' },
      null,
    );
    expect(tags).not.toContain('seller:');
    expect(tags.some((t) => t.startsWith('seller:'))).toBe(false);
  });
});
