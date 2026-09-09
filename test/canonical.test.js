import { describe, expect, test } from 'bun:test';
import { canonicalUrl } from '../packages/core/src/canonical.js';

/**
 * The key that decides whether two sources are carrying one story.
 *
 * The same article reaches this database by several roads and each decorates
 * the link differently, so a raw string comparison matches almost nothing.
 */
describe('canonicalUrl', () => {
  const CANON = 'bbc.co.uk/news/articles/abc123';

  test('the same article by four roads is one key', () => {
    const roads = [
      'https://www.bbc.co.uk/news/articles/abc123',
      'http://bbc.co.uk/news/articles/abc123/',
      'https://www.bbc.co.uk/news/articles/abc123?utm_source=rss&utm_medium=feed',
      'https://www.bbc.co.uk/news/articles/abc123#comments',
    ];
    for (const url of roads) expect(canonicalUrl(url)).toBe(CANON);
  });

  test('per-network click ids are the road, not the destination', () => {
    for (const p of ['fbclid=xy', 'gclid=xy', 'at_medium=RSS', 'ocid=socialflow', 'mc_cid=1']) {
      expect(canonicalUrl(`https://bbc.co.uk/news/articles/abc123?${p}`)).toBe(CANON);
    }
  });

  /*
   * The other half of the job. A great many sites address an article entirely
   * through a query parameter, and stripping those would fuse a publisher's
   * whole archive into one key -- which is a far worse failure than missing a
   * duplicate, because it silently discards real stories.
   */
  test('a parameter that identifies the article is kept', () => {
    expect(canonicalUrl('https://example.com/?p=8891')).toBe('example.com/?p=8891');
    expect(canonicalUrl('https://example.com/story?id=42')).toBe('example.com/story?id=42');
    expect(canonicalUrl('https://example.com/?p=1')).not.toBe(
      canonicalUrl('https://example.com/?p=2'),
    );
  });

  test('the surviving parameters sort, so either order is one key', () => {
    const a = canonicalUrl('https://example.com/x?b=2&a=1');
    const b = canonicalUrl('https://example.com/x?a=1&b=2');
    expect(a).toBe(b);
  });

  test('two different articles never share a key', () => {
    expect(canonicalUrl('https://bbc.co.uk/news/articles/aaa')).not.toBe(
      canonicalUrl('https://bbc.co.uk/news/articles/bbb'),
    );
    // Different publishers, same path.
    expect(canonicalUrl('https://a.com/news/1')).not.toBe(canonicalUrl('https://b.com/news/1'));
  });

  test('the root keeps a path to key on', () => {
    expect(canonicalUrl('https://example.com')).toBe('example.com/');
    expect(canonicalUrl('https://example.com/')).toBe('example.com/');
  });

  test('a default port is not part of the identity, a real one is', () => {
    expect(canonicalUrl('https://example.com:443/x')).toBe('example.com/x');
    expect(canonicalUrl('http://example.com:80/x')).toBe('example.com/x');
    expect(canonicalUrl('http://example.com:8080/x')).toBe('example.com:8080/x');
  });

  test('anything that is not a fetchable article URL has no key', () => {
    for (const bad of ['', null, undefined, 'not a url', 'javascript:alert(1)', 'mailto:a@b.c']) {
      expect(canonicalUrl(bad)).toBeNull();
    }
  });

  test('a trailing dot on the host is the same host', () => {
    expect(canonicalUrl('https://bbc.co.uk./news/articles/abc123')).toBe(CANON);
  });
});
