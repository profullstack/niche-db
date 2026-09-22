import { describe, expect, test } from 'bun:test';
import { normaliseItem, storable, storableDeep } from '../packages/core/src/adapter.js';

/*
 * Postgres refuses a jsonb document holding a lone surrogate half ("invalid
 * input syntax for type json") or a NUL ("unsupported Unicode escape
 * sequence"), and `upsertItems` writes a whole batch as one document, so one
 * such title failed the Podcast Index catalogue on every run. Every string an
 * item carries goes through `storable` on the way in.
 */
describe('storable', () => {
  test('removes a lone high half, a lone low half and a NUL', () => {
    expect(storable('cut \ud83d here')).toBe('cut  here');
    expect(storable('\ude00 low first')).toBe(' low first');
    expect(storable('a\u0000b')).toBe('ab');
  });

  test('keeps a paired surrogate, so emoji and CJK extension B survive', () => {
    expect(storable('ok 😀 𠀀')).toBe('ok 😀 𠀀');
    expect(storable('😀')).toBe('😀');
  });

  test('a half beside a whole pair: only the half goes', () => {
    // high, then a full pair: the first high is lone.
    expect(storable('\ud83d😀')).toBe('😀');
    // a full pair, then a stray low.
    expect(storable('😀\ude00')).toBe('😀');
  });

  test('the cleaned string is what JSON.stringify can hand to Postgres', () => {
    expect(JSON.stringify(storable('x\ud83dy'))).toBe('"xy"');
    expect(JSON.stringify('x\ud83dy')).toBe('"x\\ud83dy"');
  });
});

describe('storableDeep', () => {
  test('walks arrays and plain objects, keys included, and leaves other values alone', () => {
    const when = new Date('2026-09-22T00:00:00Z');
    const out = storableDeep({
      'k\u0000ey': 'v\ud83d',
      list: ['a\ude00', 1, null, { deep: 'z\u0000' }],
      when,
      n: 3,
    });
    expect(out).toEqual({ key: 'v', list: ['a', 1, null, { deep: 'z' }], when, n: 3 });
    expect(out.when).toBe(when);
  });
});

describe('normaliseItem', () => {
  test('cleans every text field and the data tree', () => {
    const item = normaliseItem({
      externalId: 'podcastindex:feed:1\u0000',
      title: 'Truncated \ud83d',
      summary: 'sum\ude00mary',
      url: 'https://ex.test/\u0000',
      imageUrl: 'https://ex.test/i\ud83d.png',
      tags: ['t\u0000ag'],
      data: { author: 'A\ud83d', hosts: ['B\ude00'] },
    });
    expect(item.externalId).toBe('podcastindex:feed:1');
    expect(item.title).toBe('Truncated');
    expect(item.summary).toBe('summary');
    expect(item.url).toBe('https://ex.test/');
    expect(item.imageUrl).toBe('https://ex.test/i.png');
    expect(item.tags).toEqual(['tag']);
    expect(item.data).toEqual({ author: 'A', hosts: ['B'] });
  });

  test('the content hash is over the cleaned text, so a re-read matches the stored row', () => {
    const a = normaliseItem({ externalId: 'x', title: 'T\ud83d', data: {} });
    const b = normaliseItem({ externalId: 'x', title: 'T', data: {} });
    expect(a.contentHash).toBe(b.contentHash);
  });
});
