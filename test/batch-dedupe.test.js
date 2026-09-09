import { describe, expect, test } from 'bun:test';
import { canonicalUrl } from '../packages/core/src/canonical.js';

/**
 * The fold the cross-source filter cannot do.
 *
 * `claimedDedupeKeys` deliberately ignores the source being run -- a source must
 * be free to re-state its own items, or its second run would discard everything
 * the first one wrote. That leaves one case uncovered: a publisher exposing the
 * same article through two of its own feeds, inside a single pull.
 *
 * An adapter cannot see it either, because the keys genuinely differ: rssamplifier
 * keys an item on (feed slug, url), and two feeds are two slugs. Found live on the
 * news collection -- aiornot.vote publishes `latest-media` and `photorealistic`
 * carrying the same posts, 5 duplicate URLs in 1,195.
 *
 * This is the batch fold that ingest applies for a collection that has opted in,
 * reproduced here against the same key function the writer uses.
 */
const fold = (items, claimed = new Set()) => {
  const seen = new Set();
  return items.filter((it) => {
    if (!it.dedupeKey) return true;
    if (claimed.has(it.dedupeKey) || seen.has(it.dedupeKey)) return false;
    seen.add(it.dedupeKey);
    return true;
  });
};

const item = (url, outlet) => ({ url, outlet, dedupeKey: canonicalUrl(url) });

describe('folding one pull', () => {
  test('one article through two of a publisher own feeds is one story', () => {
    const url = 'https://aiornot.vote/m/ai-or-not-event-mtt0l711';
    const kept = fold([
      item(url, 'aiornot-vote-latest-media'),
      item(url, 'aiornot-vote-photorealistic'),
    ]);
    expect(kept).toHaveLength(1);
    // First one wins, so the winner is a property of order rather than luck.
    expect(kept[0].outlet).toBe('aiornot-vote-latest-media');
  });

  test('the same article decorated differently is still one story', () => {
    const kept = fold([
      item('https://bbc.co.uk/news/articles/abc', 'a'),
      item('https://www.bbc.co.uk/news/articles/abc/?utm_source=rss', 'b'),
    ]);
    expect(kept).toHaveLength(1);
  });

  test('two different articles both survive', () => {
    const kept = fold([item('https://example.com/one', 'a'), item('https://example.com/two', 'a')]);
    expect(kept).toHaveLength(2);
  });

  /*
   * An item with no URL has no key and collides with nothing. Dropping those
   * would silently discard every item from a source that publishes no links.
   */
  test('items with no key are all kept, however many there are', () => {
    const none = [{ dedupeKey: null }, { dedupeKey: null }, { dedupeKey: null }];
    expect(fold(none)).toHaveLength(3);
  });

  test('what another source already carries is dropped as well', () => {
    const url = 'https://example.com/shared';
    const claimed = new Set([canonicalUrl(url)]);
    expect(fold([item(url, 'a')], claimed)).toHaveLength(0);
    expect(fold([item('https://example.com/mine', 'a')], claimed)).toHaveLength(1);
  });
});
