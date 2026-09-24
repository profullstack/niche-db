import { describe, expect, test } from 'bun:test';

import {
  CLEAN_TIMEOUT_MS,
  cleanIndex,
  ginIndexes,
  MAINTAINED_TABLES,
} from '../packages/db/src/gin-maintenance.js';

/** A fake `sql` tag recording statements, with a begin() that runs its callback. */
function fakeSql({ indexes = [], failOn = null } = {}) {
  const calls = [];
  const tag = (strings, ...values) => {
    calls.push({ text: strings.join('?').replace(/\s+/g, ' ').trim(), values });
    return Promise.resolve(indexes);
  };
  tag.unsafe = (text) => {
    calls.push({ text: text.trim(), values: [] });
    if (failOn && text.includes(failOn)) {
      const err = new Error('canceling statement due to statement timeout');
      err.code = '57014';
      return Promise.reject(err);
    }
    return Promise.resolve([]);
  };
  tag.begin = async (fn) => fn(tag);
  return { tag, calls };
}

describe('finding the indexes', () => {
  test('asks only for valid GIN indexes on the maintained tables, largest first', async () => {
    const f = fakeSql({ indexes: [{ index: 'items_search_idx' }] });
    await ginIndexes(f.tag);
    const q = f.calls[0].text;
    expect(q).toContain("amname = 'gin'");
    expect(q).toContain('indisvalid');
    expect(q).toContain('order by pg_relation_size');
    expect(MAINTAINED_TABLES).toContain('items');
  });

  /*
   * Bun's Postgres client serialises a JS array as `a,b`, which reaches
   * Postgres as one string and fails the whole statement. Every any() in this
   * repo goes through pgArray, and this is the local proof for this one.
   */
  test('passes the table list as a Postgres array, not a bare JS array', async () => {
    const f = fakeSql();
    await ginIndexes(f.tag, ['items', 'other']);
    const [bound] = f.calls[0].values;
    expect(Array.isArray(bound)).toBe(false);
    // A literal Postgres array, elements quoted, not the `a,b` Bun would send.
    expect(String(bound)).toBe('{"items","other"}');
  });
});

describe('cleaning one index', () => {
  test('merges the pending list inside a bounded transaction', async () => {
    const f = fakeSql();
    const r = await cleanIndex(f.tag, 'items_search_idx');
    expect(r.ok).toBe(true);
    const texts = f.calls.map((c) => c.text);
    expect(texts.some((t) => t.includes('statement_timeout'))).toBe(true);
    expect(texts.some((t) => t.includes("gin_clean_pending_list('items_search_idx')"))).toBe(true);
    // The timeout is set before the work it bounds.
    expect(texts.findIndex((t) => t.includes('statement_timeout'))).toBeLessThan(
      texts.findIndex((t) => t.includes('gin_clean_pending_list')),
    );
  });

  /*
   * A clean that runs out of time is not a failure worth propagating: the
   * entries stay in the pending list and the next tick continues. What must
   * never happen is the worker dying over it.
   */
  test('a timed-out clean is reported, not thrown', async () => {
    const f = fakeSql({ failOn: 'gin_clean_pending_list' });
    const r = await cleanIndex(f.tag, 'items_search_idx');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('statement timeout');
  });

  test('the default bound is generous but finite', () => {
    expect(CLEAN_TIMEOUT_MS).toBeGreaterThan(60_000);
    expect(Number.isFinite(CLEAN_TIMEOUT_MS)).toBe(true);
  });
});
