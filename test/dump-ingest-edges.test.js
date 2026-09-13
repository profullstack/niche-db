import { describe, expect, mock, test } from 'bun:test';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';

const calls = [];
const state = { source: null, dedupes: false, failUpsertOn: null };
const realQueries = await import('../packages/db/src/queries.js');
mock.module('../packages/db/src/queries.js', () => ({
  ...realQueries,
  getSourceById: async () => state.source,
  startRun: async () => 7,
  finishRun: async (args) => {
    calls.push(['finishRun', args]);
  },
  saveCursor: async (sourceId, cursor) => {
    calls.push(['saveCursor', { sourceId, cursor }]);
  },
  collectionDedupesUrls: async () => state.dedupes,
  claimedDedupeKeys: async () => new Set(),
  upsertItems: async ({ items }) => {
    const ids = items.map((i) => i.externalId);
    if (state.failUpsertOn && ids.includes(state.failUpsertOn)) throw new Error('pg went away');
    calls.push(['upsert', ids]);
    return { added: items.length, updated: 0 };
  },
  previousItemData: async () => new Map(),
}));

const { runSource: run } = await import('../packages/core/src/ingest.js');
const fakes = new Map();
const runSource = (id, opts) => run(id, { ...opts, resolveAdapter: (name) => fakes.get(name) });
const item = (n) => ({ externalId: `x${n}`, title: `Item ${n}`, url: `https://ex.test/${n}` });
const batch = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => item(from + i));

function useAdapter(spec) {
  fakes.set('fake-dump', { name: 'fake-dump', kinds: ['thing'], defaults: {}, ...spec });
  state.source = {
    id: 42,
    slug: 'fake',
    adapter: 'fake-dump',
    enabled: true,
    collection_id: 1,
    config: '{}',
    cursor: '{"version":"v1","skip":0}',
  };
  state.failUpsertOn = null;
  calls.length = 0;
}
const only = (kind) => calls.filter((c) => c[0] === kind).map((c) => c[1]);

describe('streaming ingest', () => {
  test('a batch is pulled only after the previous one is upserted and its cursor saved', async () => {
    useAdapter({
      async *pull() {
        for (let i = 0; i < 50; i += 1) {
          calls.push(['pull', i]);
          yield { items: batch(i * 2 + 1, i * 2 + 2), cursor: { skip: (i + 1) * 2 } };
        }
        return { cursor: { skip: 100, done: true } };
      },
    });
    await runSource(42, { log: () => {} });
    const seq = calls.map((c) => c[0]).filter((k) => k !== 'finishRun');
    const expected = [];
    for (let i = 0; i < 50; i += 1) expected.push('pull', 'upsert', 'saveCursor');
    expect(seq).toEqual(expected);
    const [finish] = only('finishRun');
    expect(finish.cursor).toEqual({ skip: 100, done: true });
    expect(finish.seen).toBe(100);
  });

  test('an upsert that throws on batch 2 errors the run with the cursor at batch 1 and closes the generator', async () => {
    let closed = false;
    let pulled = 0;
    useAdapter({
      async *pull() {
        try {
          pulled += 1;
          yield { items: batch(1, 2), cursor: { skip: 2 } };
          pulled += 1;
          yield { items: batch(3, 4), cursor: { skip: 4 } };
          pulled += 1;
          yield { items: batch(5, 6), cursor: { skip: 6 } };
          return { cursor: { skip: 6, done: true } };
        } finally {
          closed = true;
        }
      },
    });
    state.failUpsertOn = 'x3';
    const out = await runSource(42, { log: () => {} });
    expect(out).toEqual({ error: 'pg went away' });
    expect(closed).toBe(true);
    expect(pulled).toBe(2);
    expect(only('upsert')).toEqual([['x1', 'x2']]);
    expect(only('saveCursor')).toEqual([{ sourceId: 42, cursor: { skip: 2 } }]);
    const [finish] = only('finishRun');
    expect(finish.status).toBe('error');
    expect(finish.cursor).toBeUndefined();
    expect(finish.error).toBe('pg went away');
  });

  test('a return value with no cursor leaves finishRun with none, so coalesce keeps the last saved', async () => {
    useAdapter({
      async *pull() {
        yield { items: batch(1, 2), cursor: { skip: 2 } };
        return { note: 'complete' };
      },
    });
    await runSource(42, { log: () => {} });
    const [finish] = only('finishRun');
    expect(finish.note).toBe('complete');
    expect(finish.cursor).toBeUndefined();
  });

  test('a generator with no return value ends with the last batch cursor', async () => {
    useAdapter({
      async *pull() {
        yield { items: batch(1, 2), cursor: { skip: 2 } };
        yield { items: batch(3, 3), cursor: { skip: 3 } };
      },
    });
    await runSource(42, { log: () => {} });
    const [finish] = only('finishRun');
    expect(finish.cursor).toEqual({ skip: 3 });
    expect(finish.status).toBe('ok');
  });

  test('totals sum updated and added across batches and dedupe applies per batch', async () => {
    state.dedupes = true;
    useAdapter({
      async *pull() {
        yield {
          items: [
            { ...item(1), url: 'https://ex.test/same' },
            { ...item(2), url: 'https://ex.test/same' },
          ],
          cursor: { skip: 2 },
        };
        yield { items: [{ ...item(3), url: 'https://ex.test/same' }], cursor: { skip: 3 } };
        return { cursor: { skip: 3, done: true } };
      },
    });
    const out = await runSource(42, { log: () => {} });
    state.dedupes = false;
    // Within-batch fold drops x2; batch 2 cannot see batch 1 (claimed is
    // re-queried per batch against the table, which the mock says is empty).
    expect(only('upsert')).toEqual([['x1'], ['x3']]);
    expect(out).toEqual({ seen: 2, added: 2, updated: 0 });
  });

  test('the array path: a pull that returns a plain array of items still works', async () => {
    useAdapter({ pull: async () => ({ items: batch(1, 3) }) });
    const out = await runSource(42, { log: () => {} });
    expect(only('upsert')).toEqual([['x1', 'x2', 'x3']]);
    expect(only('saveCursor')).toEqual([]);
    const [finish] = only('finishRun');
    expect(finish.cursor).toBeUndefined();
    expect(finish.nextRunAt).toBeNull();
    expect(out).toEqual({ seen: 3, added: 3, updated: 0 });
  });

  test('a pull that returns nothing at all', async () => {
    useAdapter({ pull: async () => undefined });
    const out = await runSource(42, { log: () => {} });
    expect(out).toEqual({ seen: 0, added: 0, updated: 0 });
    expect(only('finishRun')[0].status).toBe('ok');
  });

  test('a pull whose next() rejects (reader error) errors the run and keeps the saved cursor', async () => {
    useAdapter({
      pull: async () => ({
        items: {
          [Symbol.asyncIterator]() {
            let n = 0;
            return {
              async next() {
                n += 1;
                if (n === 1)
                  return { value: { items: batch(1, 2), cursor: { skip: 2 } }, done: false };
                throw new Error('xz exited 1: corrupt');
              },
              // no return(): the core must cope with an iterator that has none
            };
          },
        },
      }),
    });
    const out = await runSource(42, { log: () => {} });
    expect(out).toEqual({ error: 'xz exited 1: corrupt' });
    expect(only('saveCursor')).toEqual([{ sourceId: 42, cursor: { skip: 2 } }]);
    expect(only('finishRun')[0].status).toBe('error');
  });
});
