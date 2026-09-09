import { describe, expect, test } from 'bun:test';
import { ItemList } from '../apps/web/src/views/components.jsx';

/**
 * Most collections are government and data-API rows that carry no picture, so a
 * per-item placeholder turned those lists into a column of grey boxes. The slot is
 * worth reserving only when some sibling in the list actually has an image.
 */

const item = (id, image_url) => ({
  id,
  image_url,
  title: `Item ${id}`,
  summary: null,
  kind: 'building-permit',
  source_slug: 'permits-san-francisco',
  source_name: 'SF permits',
  url: 'https://example.com/permit',
  tags: [],
  enrichment: {},
  collection_slug: 'public-money',
  published_at: '2026-09-08T00:00:00.000Z',
});

const render = (items) => ItemList({ items }).toString();

describe('ItemList thumbnails', () => {
  test('a list where nothing has an image renders no thumbnail slot at all', () => {
    const html = render([item(1, null), item(2, null)]);
    expect(html).not.toContain('thumb');
    expect(html).toContain('Item 1');
    expect(html).toContain('Item 2');
  });

  test('a mixed list keeps the slot so the titles stay aligned', () => {
    const html = render([item(1, 'https://example.com/a.png'), item(2, null)]);
    expect(html).toContain('<img class="thumb"');
    expect(html).toContain('<span class="thumb blank">');
  });

  test('an image that fails to load falls back to a pixel, not a broken-image icon', () => {
    expect(render([item(1, 'https://example.com/a.png')])).toContain('data:image/gif;base64,');
  });

  test('an empty list is still the empty notice, not a list', () => {
    expect(render([])).toContain('Nothing here yet.');
  });
});
