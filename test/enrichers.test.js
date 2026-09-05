import { describe, expect, test } from 'bun:test';
import { repoOf } from '../packages/enrichers/src/github.js';
import {
  defaultEnrichers,
  ENRICHERS,
  enrichersFor,
  searchTitle,
} from '../packages/enrichers/src/index.js';
import { parseMeta } from '../packages/enrichers/src/opengraph.js';
import { mentions, parseResultsPage } from '../packages/enrichers/src/youtube.js';

describe('registry', () => {
  test('every enricher is well formed and names real collections', () => {
    const seen = new Set();
    for (const e of ENRICHERS) {
      expect(e.name).toMatch(/^[a-z0-9-]+$/);
      expect(seen.has(e.name)).toBe(false);
      seen.add(e.name);
      expect(typeof e.enrich).toBe('function');
      expect(e.collections.length).toBeGreaterThan(0);
    }
    expect(defaultEnrichers('games')).toContain('youtube');
    expect(defaultEnrichers('filings')).toEqual(['sec-company']);
    expect(defaultEnrichers('alerts')).toEqual([]);
    expect(enrichersFor('packages').map((e) => e.name)).toContain('github-repo');
  });
});

describe('youtube results page', () => {
  test('reads videoRenderers out of ytInitialData', () => {
    const data = {
      contents: [
        {
          videoRenderer: {
            videoId: 'abc123',
            title: { runs: [{ text: 'Game ' }, { text: 'Trailer' }] },
            ownerText: { runs: [{ text: 'Studio' }] },
            lengthText: { simpleText: '1:30' },
          },
        },
        { other: { videoRenderer: { videoId: 'def456', title: { runs: [{ text: 'Review' }] } } } },
      ],
    };
    const html = `<html><script>var ytInitialData = ${JSON.stringify(data)};</script></html>`;
    const v = parseResultsPage(html);
    expect(v.length).toBe(2);
    expect(v[0]).toMatchObject({
      id: 'abc123',
      title: 'Game Trailer',
      channel: 'Studio',
      length: '1:30',
      url: 'https://www.youtube.com/watch?v=abc123',
    });
    expect(parseResultsPage('<html></html>')).toEqual([]);
  });
});

describe('youtube relevance', () => {
  test('a video must share a distinctive word with the item', () => {
    expect(mentions('My Fair Lady | Official Trailer', 'Cinnabar Nights')).toBe(false);
    expect(mentions('CINNABAR NIGHTS - launch trailer', 'Cinnabar Nights')).toBe(true);
    expect(mentions('Dota 2 Gameplay', 'Dota 2')).toBe(true);
  });
});

describe('helpers', () => {
  test('searchTitle drops set codes and years', () => {
    expect(searchTitle({ kind: 'game', title: 'Hollow Knight: Silksong' })).toBe(
      'Hollow Knight: Silksong',
    );
    expect(searchTitle({ kind: 'card', title: 'Final Showdown (TRK 12)' })).toBe('Final Showdown');
    expect(searchTitle({ kind: 'release', title: 'Artist — Album' })).toBe('Artist — Album');
  });
  test('repoOf finds a GitHub repo in the data or url', () => {
    expect(repoOf({ data: { repository: 'git+https://github.com/honojs/hono.git' } })).toBe(
      'honojs/hono',
    );
    expect(repoOf({ url: 'https://github.com/oven-sh/bun/releases/tag/v1' })).toBe('oven-sh/bun');
    expect(repoOf({ url: 'https://example.com' })).toBeNull();
  });
  test('parseMeta reads OpenGraph in either attribute order', () => {
    const html = `<head><meta property="og:image" content="https://x/i.jpg"><meta content="Hello &amp; bye" name="description"></head>`;
    expect(parseMeta(html)).toMatchObject({ image: 'https://x/i.jpg', description: 'Hello & bye' });
  });
});
