import { describe, expect, test } from 'bun:test';
import { adapterByName } from '../packages/adapters/src/index.js';
import {
  listingKey,
  parseSearch,
  ruuster,
  SAN_JOSE_SEARCH,
  toItem,
} from '../packages/adapters/src/ruuster.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

const search = parseSearch(SAN_JOSE_SEARCH);
const property = (n = 1, extra = {}) => ({
  id: `uuid-${n}`,
  mlsRecordId: `ML${n}`,
  mlsId: 'mls-a',
  firstAddress: `${n} Example Lane`,
  secondAddress: 'San Jose, CA 95118',
  city: 'San Jose',
  state: 'CA',
  postalCode: '95118',
  bedrooms: 3,
  bathrooms: 2,
  square: 1600,
  lotSizeAcres: 0.25,
  yearBuilt: 2005,
  price: 1500000,
  status: 'Active',
  unifiedSubtype: 'house',
  onMarketTimestamp: '2026-09-10T15:19:04.000Z',
  location: { coordinates: [37.26, -121.88] },
  media: [{ imagePath: 'https://images.example/home.jpg' }],
  mlsComplianceInfo: {
    agentName: 'Example Agent',
    brokerage: 'Example Realty',
    mlsName: 'Example MLS',
  },
  ...extra,
});
function context(rows, overrides = {}) {
  const calls = [];
  return {
    calls,
    config: { ...ruuster.defaults, savedSearchUrl: SAN_JOSE_SEARCH },
    cursor: {},
    budget: 150,
    deadline: Date.now() + 60000,
    http: {
      json: async (url) => {
        calls.push(url);
        const u = new URL(url);
        if (u.pathname === '/api/listings') {
          const page = Number(u.searchParams.get('page'));
          return { records: rows.slice((page - 1) * 10, page * 10), totalCount: rows.length };
        }
        return rows.find((r) => u.pathname.endsWith(`/${r.id}`));
      },
    },
    ...overrides,
  };
}

describe('Ruuster searches and properties', () => {
  test('preserves filters and multiple statuses while removing tracking and CRM actions', () => {
    const parsed = parseSearch(
      `${SAN_JOSE_SEARCH}&status=Active&utm_source=email&timestamp=123&isNeededSendToCRM=true&page=9&view=list`,
    );
    expect(parsed.params.getAll('status')).toEqual(['Active', 'ComingSoon']);
    expect(parsed.params.get('lotSizeAcresMin')).toBe('4500');
    expect(parsed.params.get('yearBuiltMin')).toBe('2000');
    expect(parsed.params.get('priceMax')).toBe('0');
    expect(parsed.params.get('slug')).toBe('talar-davoudi');
    expect(parsed.params.get('isNeededSendToCRM')).toBe('false');
    for (const key of ['utm_source', 'timestamp', 'page', 'view'])
      expect(parsed.params.has(key)).toBe(false);
    expect(parsed.key).toBe(search.key);
  });
  test('rejects unrelated hosts, credentials, ports, protocols and detail URLs', () => {
    for (const value of [
      'nope',
      'http://example.ruuster.com/agent/name/listings',
      'https://ruuster.com.evil.test/agent/name/listings',
      'https://localhost/agent/name/listings',
      'https://user:pass@example.ruuster.com/agent/name/listings',
      'https://example.ruuster.com:8443/agent/name/listings',
      `${SAN_JOSE_SEARCH.split('?')[0]}/uuid`,
    ]) {
      expect(() => parseSearch(value)).toThrow();
    }
  });
  test('maps units, dates, media, location and attribution into housing items', () => {
    const item = normaliseItem(toItem(property(), search));
    expect(item.kind).toBe('property-listing');
    expect(item.data).toMatchObject({
      price: 1500000,
      currency: 'USD',
      squareFeet: 1600,
      lotSizeAcres: 0.25,
      lotSizeSquareFeet: 10890,
      yearBuilt: 2005,
      latitude: 37.26,
      longitude: -121.88,
      attribution: { agent: 'Example Agent', brokerage: 'Example Realty', mls: 'Example MLS' },
    });
    expect(item.imageUrl).toBe('https://images.example/home.jpg');
    expect(item.publishedAt.toISOString()).toBe('2026-09-10T15:19:04.000Z');
    expect(item.tags).toContain('city:san-jose');
  });
  test('syndicated copies share an identity; unrelated properties and relistings do not', () => {
    const row = property();
    expect(listingKey({ ...row, id: 'other-uuid', mlsId: 'other-mls' })).toBe(listingKey(row));
    expect(listingKey({ ...row, firstAddress: '1 Example' })).toBe(listingKey(row));
    expect(listingKey({ ...row, firstAddress: '1 Example Lane Unit 2' })).not.toBe(listingKey(row));
    expect(listingKey({ ...row, firstAddress: '999 Different St' })).not.toBe(listingKey(row));
    expect(listingKey({ ...row, mlsRecordId: 'NEW-LISTING' })).not.toBe(listingKey(row));
  });
  test('does not publish hidden addresses or deleted listings', () => {
    expect(toItem(property(1, { isHideAddress: true }), search)).toBeNull();
    expect(toItem(property(1, { isDeleted: true }), search)).toBeNull();
  });
  test('unknown values stay unknown and label updates do not become publication dates', () => {
    const item = toItem(
      property(1, {
        onMarketTimestamp: null,
        labelUpdatedAt: '2026-09-13',
        lotSizeAcres: null,
        bedrooms: null,
        price: 0,
        location: { coordinates: [] },
        media: ['javascript:bad'],
      }),
      search,
    );
    expect(item.publishedAt).toBeNull();
    expect(item.data.lotSizeSquareFeet).toBeNull();
    expect(item.data.bedrooms).toBeNull();
    expect(item.data.price).toBe(0);
    expect(item.data.latitude).toBeNull();
    expect(item.imageUrl).toBeNull();
  });
  test('refreshing a property changes its price and status without creating a new identity', () => {
    const before = normaliseItem(toItem(property(), search));
    const after = normaliseItem(toItem(property(1, { price: 1400000, status: 'Pending' }), search));
    expect(after.externalId).toBe(before.externalId);
    expect(after.contentHash).not.toBe(before.contentHash);
    expect(after.tags).toContain('status:pending');
  });
});

describe('Ruuster ingestion', () => {
  test('walks pages and fetches each syndicated property once', async () => {
    const first = property();
    const rows = [
      ...Array.from({ length: 10 }, (_, n) => ({ ...first, id: `copy-${n}` })),
      property(2),
    ];
    const ctx = context(rows);
    const result = await ruuster.pull(ctx);
    expect(result.items).toHaveLength(2);
    expect(ctx.calls.filter((u) => new URL(u).pathname === '/api/listings')).toHaveLength(2);
    expect(ctx.calls).toHaveLength(4);
    expect(result.cursor).toEqual({});
    expect(result.nextInMinutes).toBeUndefined();
  });
  test('resumes inside a page when the detail budget runs out, without skipping a property', async () => {
    const rows = [property(1), property(2), property(3)];
    const first = await ruuster.pull(context(rows, { budget: 1 }));
    expect(first.items).toHaveLength(1);
    expect(first.cursor.offset).toBe(1);
    expect(first.nextInMinutes).toBe(1);
    const second = await ruuster.pull(context(rows, { cursor: first.cursor }));
    expect(second.items.map((i) => i.title)).toEqual([
      toItem(rows[1], search).title,
      toItem(rows[2], search).title,
    ]);
    expect(second.cursor).toEqual({});
  });
  test('page limits resume the next page and remember syndicated copies across runs', async () => {
    const row = property();
    const rows = [
      ...Array.from({ length: 10 }, (_, n) => ({ ...row, id: `copy-${n}` })),
      row,
      property(2),
    ];
    const ctx = context(rows);
    ctx.config.pages = 1;
    const first = await ruuster.pull(ctx);
    expect(first.cursor.page).toBe(2);
    const second = await ruuster.pull(context(rows, { cursor: first.cursor }));
    expect(second.items).toHaveLength(1);
    expect(second.items[0].data.mlsRecordId).toBe('ML2');
  });
  test('a changed search restarts the walk', async () => {
    const ctx = context([property()], {
      cursor: { searchKey: 'old-search', page: 99, seen: [listingKey(property())] },
    });
    const result = await ruuster.pull(ctx);
    expect(result.items).toHaveLength(1);
    expect(new URL(ctx.calls[0]).searchParams.get('page')).toBe('1');
  });
  test('deadline and zero budget make no upstream requests', async () => {
    for (const override of [{ budget: 0 }, { deadline: Date.now() - 1 }]) {
      const ctx = context([property()], override);
      const result = await ruuster.pull(ctx);
      expect(ctx.calls).toHaveLength(0);
      expect(result.cursor.page).toBe(1);
    }
  });
  test('invalid pages and failed details fail rather than advancing a successful cursor', async () => {
    await expect(
      ruuster.pull(context([], { http: { json: async () => ({ error: 'login required' }) } })),
    ).rejects.toThrow('invalid listing page');
    await expect(
      ruuster.pull(
        context([property()], {
          http: {
            json: async (url) => {
              if (new URL(url).pathname === '/api/listings')
                return { records: [property()], totalCount: 1 };
              throw new Error('503');
            },
          },
        }),
      ),
    ).rejects.toThrow('503');
  });
  test('empty searches finish and the adapter is registered', async () => {
    const result = await ruuster.pull(context([]));
    expect(result.items).toEqual([]);
    expect(result.cursor).toEqual({});
    expect(adapterByName('ruuster').collection).toBe('housing');
  });
});
