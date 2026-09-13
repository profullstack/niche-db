import { describe, expect, mock, test } from 'bun:test';

/**
 * A dump adapter hands the core its items a batch at a time.
 *
 * The array form of `pull` holds every item in memory until the run ends and
 * writes the cursor once, at the finish. A file of gigabytes cannot do either,
 * so `pull` may yield `{ items, cursor }` batches and the core drains them one
 * by one: each batch through the same normalise/dedupe/upsert path, each
 * batch's cursor saved before the next is read, the generator's return value
 * taken as the run's outcome. These tests run `runSource` for real against a
 * recording stand-in for the queries module, because the property under test
 * is the ORDER of writes and saves, which nothing short of the real loop shows.
 */
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';

const calls = [];
const state = { source: null, dedupes: false };
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
    calls.push(['upsert', items.map((i) => i.externalId)]);
    return { added: items.length, updated: 0 };
  },
  previousItemData: async () => new Map(),
}));

const { runSource: run } = await import('../packages/core/src/ingest.js');

// The fake adapter goes in through `resolveAdapter`, not a mock of the registry:
// `@nichedb/adapters` and `@nichedb/core` import each other, and mocking one
// end of that cycle hangs Bun's loader for every file that loads after this one.
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
  calls.length = 0;
}

const only = (kind) => calls.filter((c) => c[0] === kind).map((c) => c[1]);

describe('a pull that yields batches', () => {
  test('three batches are three upserts, three cursor saves, and the return value ends the run', async () => {
    const seenCursor = [];
    useAdapter({
      async *pull({ cursor }) {
        seenCursor.push(cursor);
        yield { items: batch(1, 3), cursor: { version: 'v1', skip: 3 } };
        yield { items: batch(4, 6), cursor: { version: 'v1', skip: 6 } };
        yield { items: batch(7, 8), cursor: { version: 'v1', skip: 8 } };
        return {
          cursor: { version: 'v1', skip: 8, done: true },
          note: 'complete',
          nextInMinutes: 30,
        };
      },
    });

    const out = await runSource(42, { log: () => {} });

    expect(seenCursor).toEqual([{ version: 'v1', skip: 0 }]);
    expect(only('upsert')).toEqual([
      ['x1', 'x2', 'x3'],
      ['x4', 'x5', 'x6'],
      ['x7', 'x8'],
    ]);
    expect(only('saveCursor')).toEqual([
      { sourceId: 42, cursor: { version: 'v1', skip: 3 } },
      { sourceId: 42, cursor: { version: 'v1', skip: 6 } },
      { sourceId: 42, cursor: { version: 'v1', skip: 8 } },
    ]);

    // Each save lands AFTER its batch is in the table, never before.
    const order = calls.map((c) => c[0]).filter((k) => k !== 'finishRun');
    expect(order).toEqual(['upsert', 'saveCursor', 'upsert', 'saveCursor', 'upsert', 'saveCursor']);

    const [finish] = only('finishRun');
    expect(finish.status).toBe('ok');
    expect(finish.cursor).toEqual({ version: 'v1', skip: 8, done: true });
    expect(finish.note).toBe('complete');
    expect(finish.seen).toBe(8);
    expect(finish.added).toBe(8);
    expect(finish.nextRunAt).toBeInstanceOf(Date);
    expect(out).toEqual({ seen: 8, added: 8, updated: 0 });
  });

  test('`{ items: <async iterable> }` is the same contract', async () => {
    async function* walk() {
      yield { items: batch(1, 2), cursor: { skip: 2 } };
      yield { items: batch(3, 3) };
      return { cursor: { skip: 3, done: true } };
    }
    useAdapter({ pull: async () => ({ items: walk(), note: 'from the wrapper' }) });

    await runSource(42, { log: () => {} });

    expect(only('upsert')).toEqual([['x1', 'x2'], ['x3']]);
    // A batch with no cursor saves nothing; only the ones that carry one do.
    expect(only('saveCursor')).toEqual([{ sourceId: 42, cursor: { skip: 2 } }]);
    const [finish] = only('finishRun');
    expect(finish.cursor).toEqual({ skip: 3, done: true });
    expect(finish.note).toBe('from the wrapper');
    expect(finish.seen).toBe(3);
  });

  test('a batch that lands past the deadline ends the run at the last saved cursor', async () => {
    let closed = false;
    useAdapter({
      budgetMs: 1,
      async *pull() {
        try {
          yield { items: batch(1, 2), cursor: { skip: 2 } };
          await Bun.sleep(5);
          yield { items: batch(3, 4), cursor: { skip: 4 } };
          yield { items: batch(5, 6), cursor: { skip: 6 } };
          return { note: 'never reached' };
        } finally {
          closed = true;
        }
      },
    });

    await runSource(42, { log: () => {} });

    // The first batch is inside the budget; the second crosses it, is still
    // written (it was already read), and then the generator is closed so its
    // files and processes go with it. The third is never asked for.
    expect(only('upsert').length).toBeLessThanOrEqual(2);
    expect(closed).toBe(true);
    const [finish] = only('finishRun');
    expect(finish.status).toBe('ok');
    expect(finish.nextRunAt).toBeInstanceOf(Date);
    expect(finish.note).toMatch(/out of time/);
    expect(finish.cursor).toEqual(only('saveCursor').at(-1).cursor);
  });

  test('a failure mid-walk keeps the cursors already saved and closes the generator', async () => {
    let closed = false;
    useAdapter({
      async *pull() {
        try {
          yield { items: batch(1, 2), cursor: { skip: 2 } };
          throw new Error('disk fell off');
        } finally {
          closed = true;
        }
      },
    });

    const out = await runSource(42, { log: () => {} });

    expect(out).toEqual({ error: 'disk fell off' });
    expect(closed).toBe(true);
    expect(only('saveCursor')).toEqual([{ sourceId: 42, cursor: { skip: 2 } }]);
    const [finish] = only('finishRun');
    expect(finish.status).toBe('error');
    // No cursor on the error finish: `coalesce` keeps what saveCursor wrote.
    expect(finish.cursor).toBeUndefined();
  });

  test('a batch of three hundred is two upserts, and the totals add up across batches', async () => {
    useAdapter({
      async *pull() {
        yield { items: batch(1, 300), cursor: { skip: 300 } };
        yield { items: batch(301, 350), cursor: { skip: 350 } };
        return { cursor: { skip: 350, done: true } };
      },
    });

    const out = await runSource(42, { log: () => {} });

    expect(only('upsert').map((ids) => ids.length)).toEqual([200, 100, 50]);
    expect(only('saveCursor').length).toBe(2);
    expect(out).toEqual({ seen: 350, added: 350, updated: 0 });
  });
});

describe('the array form', () => {
  test('is written in one go with no interim cursor save', async () => {
    useAdapter({
      pull: async () => ({ items: batch(1, 5), cursor: { since: 'abc' }, note: '5 things' }),
    });

    const out = await runSource(42, { log: () => {} });

    expect(only('upsert')).toEqual([['x1', 'x2', 'x3', 'x4', 'x5']]);
    expect(only('saveCursor')).toEqual([]);
    const [finish] = only('finishRun');
    expect(finish.cursor).toEqual({ since: 'abc' });
    expect(finish.note).toBe('5 things');
    expect(finish.seen).toBe(5);
    expect(out).toEqual({ seen: 5, added: 5, updated: 0 });
  });
});
