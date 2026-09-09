import { describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';

// queries.js reaches @nichedb/config, which reads the environment at import.
// It needs to be set, not to connect.
process.env.DATABASE_URL ??= 'postgres://localhost:5432/unused';
const { pgArray } = await import('../packages/db/src/queries.js');

/**
 * Every multi-value `any()` has to go through pgArray.
 *
 * Bun's Postgres driver serialises a JS array by joining it with commas, so an
 * interpolated `= any(${list})` reaches Postgres as the single string
 * `a,b,c` and the statement dies with `malformed array literal`, quoting the
 * first element. Nothing about that message says "array parameter", and the
 * element it names is always perfectly valid.
 *
 * The reason this is worth a test rather than a comment is the blast radius:
 * the error propagates out of the write and aborts the whole source run, so one
 * bad query stops ingestion for an entire collection while the logs complain
 * about a URL. That is exactly how it shipped -- both new news sources sat at
 * `item_count: 0` with `last_ok_at: null`, and the only clue was a healthy
 * looking japantimes.co.jp link in the error string.
 */
const DIR = new URL('../packages/db/src/', import.meta.url).pathname;

describe('array parameters', () => {
  test('pgArray produces a Postgres array literal, not a comma join', () => {
    expect(pgArray(['a', 'b'])).toBe('{"a","b"}');
    // The join Bun would have done, which is what Postgres rejects.
    expect(pgArray(['a', 'b'])).not.toBe(['a', 'b'].toString());
    expect(pgArray([])).toBe('{}');
  });

  test('it escapes what would otherwise end the literal early', () => {
    expect(pgArray(['a"b'])).toBe('{"a\\"b"}');
    expect(pgArray(['a\\b'])).toBe('{"a\\\\b"}');
    // A URL with a comma in it must stay one element.
    expect(pgArray(['example.com/a,b'])).toBe('{"example.com/a,b"}');
    expect(pgArray([null, undefined])).toBe('{NULL,NULL}');
  });

  test('no query interpolates a bare value into any()', async () => {
    const files = (await readdir(DIR)).filter((f) => f.endsWith('.js'));
    const offenders = [];

    for (const file of files) {
      const src = await readFile(DIR + file, 'utf8');
      const lines = src.split('\n');
      lines.forEach((line, i) => {
        // Only real SQL, not the prose explaining why this rule exists.
        const code = line.trim();
        if (code.startsWith('*') || code.startsWith('//')) return;
        for (const m of line.matchAll(/any\(\$\{([^}]*)\}/g)) {
          if (!m[1].includes('pgArray')) offenders.push(`${file}:${i + 1} ${code.slice(0, 70)}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });
});
