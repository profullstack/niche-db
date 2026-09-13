import { describe, expect, test } from 'bun:test';
import { run } from '../apps/cli/src/index.js';
import { scannerContextOptions } from '../apps/web/src/lib/scanner-context.js';

process.env.DATABASE_URL ??= 'postgres://localhost/unused';
const { TOOLS } = await import('../apps/web/src/lib/mcp/tools.js');
const { CollectionPage } = await import('../apps/web/src/views/pages.jsx');
const { FeedForm } = await import('../apps/web/src/views/admin.jsx');
const { Pager } = await import('../apps/web/src/views/components.jsx');
const geo = { lat: 0, long: 0, radius: 10, unit: 'km', sort: 'distance' };

describe('geographic public surfaces', () => {
  test('CLI forwards zero coordinates, signed longitude, bbox and offset', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(new URL(url));
      return new Response(JSON.stringify({ items: [] }));
    };
    for (const args of [['recent'], ['search', 'theft'], ['upcoming'], ['items', 'local']]) {
      await run(
        [
          ...args,
          '--api',
          'https://example.test',
          '--lat',
          '0',
          '--long',
          '-87.62',
          '--radius',
          '5',
          '--sort',
          'distance',
          '--offset',
          '2',
        ],
        { fetchImpl },
      );
      const qs = calls.at(-1).searchParams;
      expect(qs.get('lat')).toBe('0');
      expect(qs.get('long')).toBe('-87.62');
      expect(qs.get('offset')).toBe('2');
    }
    await run(['recent', '--api', 'https://example.test', '--bbox', '170,-10,-170,10'], {
      fetchImpl,
    });
    expect(calls.at(-1).searchParams.get('bbox')).toBe('170,-10,-170,10');
  });
  test('MCP advertises GPS fields and returns actionable validation errors', async () => {
    for (const name of [
      'recent_items',
      'feed_items',
      'search_items',
      'match_items',
      'upcoming',
      'create_feed',
    ]) {
      const tool = TOOLS.find((t) => t.name === name);
      for (const key of ['lat', 'long', 'radius', 'unit', 'bbox', 'sort'])
        expect(tool.inputSchema.properties[key]).toBeTruthy();
    }
    await expect(
      TOOLS.find((t) => t.name === 'recent_items').run({ lat: 0 }),
    ).rejects.toMatchObject({ status: 400, toolError: true });
  });
  test('collection facets and distance pagination preserve GPS', async () => {
    const html = await CollectionPage({
      collection: { slug: 'crime', name: 'Crime' },
      stats: { items: 1, sources: 1, feeds: 0 },
      sources: [],
      feeds: [],
      latest: [{ id: 3, title: 'Report', kind: 'crime-report', tags: [], data: {} }],
      upcoming: [],
      kinds: [
        { kind: 'crime-report', n: 1 },
        { kind: 'scanner-stream', n: 1 },
      ],
      tags: [{ tag: 'theft' }],
      geo,
      offset: 50,
    }).toString();
    expect(html).toContain('lat=0&amp;long=0');
    expect(html).toContain('kind=scanner-stream');
    expect(html).toContain('offset=51');
    expect(html).not.toContain('before=');
  });
  test('ordinary pagination still uses item IDs', async () => {
    const html = await Pager({ items: [{ id: 8 }], base: '/c/crime?lat=0&long=0' }).toString();
    expect(html).toContain('before=8');
  });
  test('feed edit form does not erase a saved geographic query', async () => {
    const html = await FeedForm({
      collections: [],
      sources: [],
      kinds: [],
      enrichers: [],
      collection: { slug: 'crime' },
      values: { ...geo, name: 'Local' },
      editing: { slug: 'local' },
      preview: [],
    }).toString();
    expect(html).toContain('name="lat" value="0"');
    expect(html).toContain('name="long" value="0"');
    expect(html).toContain('name="sort" value="distance"');
  });
  test('date context validates order and half-open window; blank form fields are optional', () => {
    expect(scannerContextOptions({ from: '2026-08-01', to: '2026-09-01' })).toEqual({
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-09-01T00:00:00.000Z',
    });
    expect(scannerContextOptions({ from: '', to: '' })).toEqual({ from: null, to: null });
    expect(() => scannerContextOptions({ from: 'bad' })).toThrow('ISO date');
    expect(() => scannerContextOptions({ from: '2026-09-01', to: '2026-08-01' })).toThrow(
      'precede',
    );
  });
});
