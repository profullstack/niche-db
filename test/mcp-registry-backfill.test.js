import { describe, expect, test } from 'bun:test';

import { FULL_WALK_EVERY_MS, mcpRegistry, plan } from '../packages/adapters/src/mcpregistry.js';

const entry = (name, status = 'active', extra = {}) => ({
  server: {
    name,
    description: `${name} server`,
    version: '1.0.0',
    websiteUrl: `https://${name.replace(/[^a-z0-9]+/g, '-')}.example`,
    ...extra,
  },
  _meta: {
    'io.modelcontextprotocol.registry/official': {
      status,
      publishedAt: '2026-11-01T00:00:00Z',
      updatedAt: '2026-11-02T00:00:00Z',
    },
  },
});

/** A fake registry: pages keyed by cursor ('' = first), recording every request's params. */
function registry(pages, changed = []) {
  const calls = [];
  const http = {
    async json(url) {
      const u = new URL(url);
      const p = Object.fromEntries(u.searchParams);
      calls.push(p);
      if (p.updated_since) return { servers: changed, metadata: {} };
      const keys = Object.keys(pages);
      const i = keys.indexOf(p.cursor ?? '');
      return {
        servers: pages[keys[i]],
        metadata: i + 1 < keys.length ? { nextCursor: keys[i + 1] } : {},
      };
    },
  };
  return { http, calls };
}

async function run(gen) {
  const batches = [];
  let r = await gen.next();
  while (!r.done) {
    batches.push(r.value);
    r = await gen.next();
  }
  return { batches, result: r.value };
}

const ctx = (http, cursor = {}, deadline = Infinity) => ({
  config: {},
  cursor,
  http,
  log: () => {},
  deadline,
});

describe('mcp-registry backfill', () => {
  const pages = {
    '': [entry('ac.one/a'), entry('ac.two/b', 'deleted')],
    'ac.two/b:1.0.0': [
      entry('com.profullstack/board-saas', 'active', {
        websiteUrl: 'https://board.saas.pit.world',
        remotes: [{ type: 'streamable-http', url: 'https://board.saas.pit.world/mcp' }],
      }),
    ],
    'com.profullstack/board-saas:1.0.0': [entry('io.github.x/z')],
  };

  test('a fresh source walks every page at version=latest, saving the cursor per page', async () => {
    const { http, calls } = registry(pages);
    const { batches, result } = await run(mcpRegistry.pull(ctx(http)));
    expect(calls.every((c) => c.version === 'latest' && c.limit === '100')).toBe(true);
    expect(calls.map((c) => c.cursor ?? '')).toEqual(Object.keys(pages));
    const names = batches.flatMap((b) => b.items.map((i) => i.externalId));
    expect(names).toEqual(['ac.one/a', 'com.profullstack/board-saas', 'io.github.x/z']); // deleted dropped
    expect(batches[0].cursor).toMatchObject({ v: 2, walking: true, next: 'ac.two/b:1.0.0' });
    expect(result.cursor.walking).toBe(false);
    expect(result.cursor.since).toBe(result.cursor.fullAt);
    const board = batches[1].items[0];
    expect(board.url).toBe('https://board.saas.pit.world');
  });

  test('a run that hits its deadline pauses with the next cursor, and the next run resumes there', async () => {
    const { http } = registry(pages);
    let ticks = 0;
    const realNow = Date.now;
    // Two pages inside the deadline, then out of time.
    Date.now = () => realNow() + (ticks++ >= 2 ? 10 ** 9 : 0);
    let first;
    try {
      first = await run(mcpRegistry.pull(ctx(http, {}, realNow() + 60_000)));
    } finally {
      Date.now = realNow;
    }
    expect(first.result.nextInMinutes).toBe(1);
    expect(first.result.cursor.walking).toBe(true);
    const resumeAt = first.result.cursor.next;
    expect(resumeAt).toBeTruthy();

    const again = registry(pages);
    const second = await run(mcpRegistry.pull(ctx(again.http, first.result.cursor)));
    expect(again.calls[0].cursor).toBe(resumeAt);
    expect(second.result.cursor.walking).toBe(false);
  });

  test('after a complete walk, runs ask only for what changed since the previous run', async () => {
    const since = new Date(Date.now() - 3_600_000).toISOString();
    const { http, calls } = registry(pages, [entry('ai.new/thing'), entry('ai.gone/x', 'deleted')]);
    const { batches, result } = await run(
      mcpRegistry.pull(ctx(http, { v: 2, walking: false, fullAt: since, since })),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].updated_since).toBe(since);
    expect(batches.flatMap((b) => b.items.map((i) => i.externalId))).toEqual(['ai.new/thing']);
    expect(result.cursor.since > since).toBe(true);
    expect(result.cursor.fullAt).toBe(since);
  });

  test('a full walk comes due again after a week, and an old v1 cursor starts one', () => {
    const old = new Date(Date.now() - FULL_WALK_EVERY_MS - 1000).toISOString();
    expect(plan({ v: 2, walking: false, fullAt: old, since: old }).mode).toBe('walk');
    expect(plan({}).mode).toBe('walk');
    expect(plan({ something: 'legacy' }).mode).toBe('walk');
    const fresh = new Date().toISOString();
    expect(plan({ v: 2, walking: false, fullAt: fresh, since: fresh }).mode).toBe('since');
  });
});
