import { describe, expect, test } from 'bun:test';

/**
 * A niche page is served from the site root (/events, /music) and is the page
 * people are sent to. It used to show the title, the pitch and the share table
 * and none of the collection's rows, so /events read as empty while /c/events
 * held 132,000 items. NicheData puts the rows first.
 */
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';

const { NicheData } = await import('../apps/web/src/views/knowledge.jsx');

const item = (id, title, published_at = '2026-09-26T12:00:00.000Z') => ({
  id,
  image_url: null,
  title,
  summary: null,
  kind: 'event',
  source_slug: 'musicbrainz-events',
  source_name: 'MusicBrainz events',
  url: `https://musicbrainz.org/event/${id}`,
  tags: [],
  enrichment: {},
  collection_slug: 'events',
  published_at,
});

const data = {
  collection: { id: 1, slug: 'events', name: 'Concerts & festivals' },
  stats: { items: 132777, items_today: 12, sources: 2, feeds: 5 },
  feeds: [{ slug: 'upcoming-events', name: 'Coming up' }],
  upcoming: [item(1, 'Metallica at Allegiant Stadium')],
  latest: [item(2, 'Up in Smoke Festival 2026')],
};

const html = (d) => String(NicheData({ data: d }) ?? '');

describe('niche page data', () => {
  test('shows the counts, the feeds, what is coming up and the newest rows', () => {
    const out = html(data);
    expect(out).toContain('132,777');
    expect(out).toContain('href="/f/upcoming-events"');
    expect(out).toContain('Coming up');
    expect(out).toContain('Metallica at Allegiant Stadium');
    expect(out).toContain('Just in');
    expect(out).toContain('Up in Smoke Festival 2026');
    expect(out).toContain('href="/c/events"');
  });

  test('no upcoming rows means no Coming up heading', () => {
    expect(html({ ...data, upcoming: [] })).not.toContain('Coming up</h2>');
  });

  test('nothing to show renders nothing', () => {
    expect(html(null)).toBe('');
    expect(html({ ...data, upcoming: [], latest: [] })).toBe('');
  });

  test('missing stats still render the rows', () => {
    const out = html({ ...data, stats: null });
    expect(out).toContain('Up in Smoke Festival 2026');
    expect(out).not.toContain('items ·');
  });
});
