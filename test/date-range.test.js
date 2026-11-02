import { describe, expect, test } from 'bun:test';
import { normaliseItem, toDate } from '../packages/core/src/adapter.js';

describe('dates Postgres cannot read are dropped', () => {
  test('year 10555 (a crawled page in the wild) is null, not "+010555-…"', () => {
    expect(toDate('+010555-01-01T00:00:00.000Z')).toBeNull();
    expect(toDate(new Date(Date.UTC(10555, 0, 1)))).toBeNull();
  });
  test('ordinary dates pass through', () => {
    expect(toDate('2026-11-02T12:00:00Z')?.toISOString()).toBe('2026-11-02T12:00:00.000Z');
    expect(toDate('9999-12-31T00:00:00Z')).not.toBeNull();
  });
  test('an item with a far-future date keeps its other fields', () => {
    const item = normaliseItem({
      externalId: 'x',
      title: 'A page',
      url: 'https://example.com/',
      publishedAt: '+010555-01-01T00:00:00.000Z',
    });
    expect(item?.title).toBe('A page');
    expect(item?.publishedAt).toBeNull();
  });
});
