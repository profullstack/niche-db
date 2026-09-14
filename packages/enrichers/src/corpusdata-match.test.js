import { describe, expect, test } from 'bun:test';
import { matchCorpusArticles } from './corpusdata-match.js';

describe('CorpusData article matching', () => {
  test('accepts a matching title and date', () => {
    const result = matchCorpusArticles(
      { title: 'Aurora launches open model', published_at: '2026-09-14T10:00:00Z' },
      [
        {
          title: 'Aurora launches open model for developers',
          date: '2026-09-14T12:00:00Z',
          url: 'https://example.test/a',
        },
      ],
    );
    expect(result?.article.url).toBe('https://example.test/a');
    expect(result?.reasons).toContain('same-day');
  });

  test('rejects an ambiguous or weak candidate', () => {
    const result = matchCorpusArticles(
      { title: 'Aurora launches open model', published_at: '2026-09-14' },
      [
        { title: 'Aurora model launches', date: '2026-09-14' },
        { title: 'Aurora model launches', date: '2026-09-14' },
      ],
    );
    expect(result).toBeNull();
  });
});
