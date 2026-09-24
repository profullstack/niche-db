import { describe, expect, test } from 'bun:test';

import {
  BIG_INDEXES,
  buildBigIndexesOnce,
  ensureIndex,
  extensionAvailable,
  indexState,
} from '../packages/db/src/build-indexes.js';

/**
 * A fake `sql` tag that records every statement and answers the two catalog
 * queries the builder asks. Enough to prove the order of operations, which is
 * the whole point: an invalid index must be dropped before anything is built.
 */
function fakeSql({ state = 'absent', extension = true, buildsTo = 'valid' } = {}) {
  const calls = [];
  let current = state;
  const tag = (strings, ...values) => {
    const text = strings.join('?');
    calls.push(text.trim().replace(/\s+/g, ' '));
    if (text.includes('pg_available_extensions')) return Promise.resolve(extension ? [{}] : []);
    if (text.includes('pg_index')) {
      if (current === 'absent') return Promise.resolve([]);
      return Promise.resolve([{ valid: current === 'valid' }]);
    }
    return Promise.resolve([]);
  };
  tag.unsafe = (text) => {
    calls.push(text.trim().replace(/\s+/g, ' '));
    if (/^drop index/i.test(text)) current = 'absent';
    if (/^create index/i.test(text)) current = buildsTo;
    return Promise.resolve([]);
  };
  return { tag, calls, state: () => current };
}

const SPEC = {
  name: 'items_collection_kind_tags_idx',
  extension: 'btree_gin',
  create: 'create index concurrently items_collection_kind_tags_idx on items using gin (a, b, c)',
};

describe('index state', () => {
  test('absent, invalid and valid are three different answers', async () => {
    expect(await indexState(fakeSql({ state: 'absent' }).tag, 'x')).toBe('absent');
    expect(await indexState(fakeSql({ state: 'invalid' }).tag, 'x')).toBe('invalid');
    expect(await indexState(fakeSql({ state: 'valid' }).tag, 'x')).toBe('valid');
  });

  test('an unavailable extension is reported, not assumed', async () => {
    expect(await extensionAvailable(fakeSql({ extension: false }).tag, 'btree_gin')).toBe(false);
    expect(await extensionAvailable(fakeSql({ extension: true }).tag, 'btree_gin')).toBe(true);
  });
});

describe('ensureIndex', () => {
  test('builds when absent', async () => {
    const f = fakeSql({ state: 'absent' });
    expect(await ensureIndex(f.tag, SPEC, { log: () => {} })).toBe('built');
    expect(f.calls.some((c) => c.startsWith('create index concurrently'))).toBe(true);
    expect(f.calls.some((c) => c.startsWith('drop index'))).toBe(false);
  });

  test('does nothing when already valid', async () => {
    const f = fakeSql({ state: 'valid' });
    expect(await ensureIndex(f.tag, SPEC, { log: () => {} })).toBe('present');
    expect(f.calls.some((c) => c.startsWith('create index'))).toBe(false);
  });

  /*
   * The regression this whole file exists for. An interrupted concurrent build
   * leaves an INVALID index; `create index if not exists` then skips it
   * forever and the fix silently never lands. It must be dropped first.
   */
  test('drops an invalid index BEFORE building, and builds', async () => {
    const f = fakeSql({ state: 'invalid' });
    expect(await ensureIndex(f.tag, SPEC, { log: () => {} })).toBe('built');
    const dropAt = f.calls.findIndex((c) => c.startsWith('drop index'));
    const createAt = f.calls.findIndex((c) => c.startsWith('create index concurrently'));
    expect(dropAt).toBeGreaterThanOrEqual(0);
    expect(createAt).toBeGreaterThan(dropAt);
  });

  test('the drop is bounded by a lock timeout, so writes never queue behind it', async () => {
    const f = fakeSql({ state: 'invalid' });
    await ensureIndex(f.tag, SPEC, { log: () => {} });
    const dropAt = f.calls.findIndex((c) => c.startsWith('drop index'));
    const timeoutAt = f.calls.findIndex((c) => c.includes('lock_timeout'));
    expect(timeoutAt).toBeGreaterThanOrEqual(0);
    expect(timeoutAt).toBeLessThan(dropAt);
  });

  test('a build that ends invalid reports it rather than claiming success', async () => {
    const f = fakeSql({ state: 'absent', buildsTo: 'invalid' });
    expect(await ensureIndex(f.tag, SPEC, { log: () => {} })).toBe('invalid');
  });

  /*
   * Shipped and caught in production: `set lock_timeout = ${n}` through the
   * tagged template reaches Postgres as `set lock_timeout = $1`, which is a
   * syntax error, because SET takes no bind parameters. The builder logged it
   * and left the invalid index exactly where it was.
   */
  test('SET statements carry their value inline, never as a bind parameter', async () => {
    const f = fakeSql({ state: 'invalid' });
    await ensureIndex(f.tag, SPEC, { log: () => {} });
    const sets = f.calls.filter((c) => /^set\s/i.test(c));
    expect(sets.length).toBeGreaterThan(0);
    for (const stmt of sets) expect(stmt).not.toContain('$1');
    expect(sets.some((c) => /lock_timeout = \d+/.test(c))).toBe(true);
  });

  test('a missing extension skips instead of failing', async () => {
    const f = fakeSql({ state: 'absent', extension: false });
    expect(await ensureIndex(f.tag, SPEC, { log: () => {} })).toBe('unavailable');
    expect(f.calls.some((c) => c.startsWith('create index'))).toBe(false);
  });
});

describe('one build at a time', () => {
  /*
   * Boot starts a build and the maintenance tick asks again every couple of
   * minutes, which is what gives a drop that lost a lock race another go. A
   * concurrent build outlives the tick that started it, so two callers must
   * share one run rather than racing against the same index name.
   */
  test('concurrent callers share a single run', () => {
    const a = buildBigIndexesOnce({ log: () => {}, indexes: [] });
    const b = buildBigIndexesOnce({ log: () => {}, indexes: [] });
    expect(a).toBe(b);
    return a;
  });

  test('a later caller starts a new run once the first has finished', async () => {
    const first = buildBigIndexesOnce({ log: () => {}, indexes: [] });
    await first;
    const second = buildBigIndexesOnce({ log: () => {}, indexes: [] });
    expect(second).not.toBe(first);
    await second;
  });
});

describe('the registry', () => {
  test('every entry names an index, builds it concurrently, and matches its own name', () => {
    expect(BIG_INDEXES.length).toBeGreaterThan(0);
    for (const spec of BIG_INDEXES) {
      expect(spec.name).toMatch(/^[a-z0-9_]+$/);
      expect(spec.create).toContain('concurrently');
      expect(spec.create).toContain(spec.name);
    }
  });

  /*
   * Building one of these in a migration is what took the site down on
   * 2026-09-24: a migration runs in a transaction, before the process serves,
   * so it is a plain CREATE INDEX holding a write lock on a 35 million row
   * table while nothing is listening.
   *
   * 0030 is the one that did it and is left alone deliberately. It is recorded
   * as applied on every database that has it, so editing it changes nothing
   * there, and on a fresh database `items` is empty and the build is instant.
   * The rule is for what comes next.
   */
  const HISTORICAL = new Set(['0030_items_tag_kind_gin.sql']);

  test('no new migration builds one of these, which is what caused the outage', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const dir = new URL('../packages/db/migrations/', import.meta.url);
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql') && !HISTORICAL.has(f));
    for (const file of files) {
      const raw = await readFile(new URL(file, dir), 'utf8');
      // Prose explaining the incident names these statements; only SQL counts.
      const body = raw
        .replace(/--[^\n]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/'[^']*'/g, "''");
      for (const spec of BIG_INDEXES) {
        const creates = new RegExp(`create\\s+index[^;]*${spec.name}`, 'i').test(body);
        expect(`${file} creates ${spec.name}: ${creates}`).toBe(
          `${file} creates ${spec.name}: false`,
        );
      }
    }
  });
});
