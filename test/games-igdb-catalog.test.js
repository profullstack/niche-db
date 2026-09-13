import { describe, expect, test } from 'bun:test';

import {
  catalogItem,
  deltaQuery,
  igdbCatalog,
  REQUESTS_PER_RUN,
  resumeFrom,
  walkQuery,
} from '../packages/adapters/src/igdb-catalog.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

const game = (id, name, extra = {}) => ({
  id,
  name,
  slug: `g-${id}`,
  summary: 'A game.',
  first_release_date: 1_600_000_000,
  updated_at: 1_700_000_000 + id,
  cover: { url: '//images.igdb.com/igdb/image/upload/t_thumb/co1.jpg' },
  genres: [{ name: 'Role-playing (RPG)' }],
  platforms: [{ abbreviation: 'PC', name: 'PC (Microsoft Windows)' }],
  url: `https://www.igdb.com/games/g-${id}`,
  total_rating: 88.5,
  total_rating_count: 120,
  category: 0,
  status: 0,
  themes: [{ name: 'Fantasy' }],
  game_modes: [{ name: 'Single player' }],
  involved_companies: [
    { company: { name: 'Larian Studios' }, developer: true, publisher: true },
    { company: { name: 'Nobody' }, developer: false, publisher: false },
  ],
  external_games: [
    { category: 1, uid: '1086940' },
    { category: 26, uid: 'epic-1' },
  ],
  websites: [
    { category: 1, url: 'https://baldursgate3.game' },
    { category: 5, url: 'https://twitter.com/larianstudios' },
  ],
  collection: { name: "Baldur's Gate" },
  ...extra,
});

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** IGDB with ids 1..N; a walk query answers the next 500 after `id > X`; a delta answers those updated after `since`. */
function provider(total = 1200, updatedAfter = new Set([7, 900])) {
  const bodies = [];
  const http = {
    async json() {
      return { access_token: 'tok', expires_in: 3600 };
    },
    async request(_url, opts) {
      bodies.push(opts.body);
      const after = Number(opts.body.match(/id > (\d+)/)[1]);
      const since = opts.body.match(/updated_at > (\d+)/);
      const limit = Number(opts.body.match(/limit (\d+)/)[1]);
      const out = [];
      for (let id = after + 1; id <= total && out.length < limit; id++) {
        if (since && !updatedAfter.has(id)) continue;
        out.push(game(id, `Game ${id}`));
      }
      return json(out);
    },
  };
  return { http, bodies };
}

const run = (config, cursor, p) =>
  igdbCatalog.pull({
    config: { requestsPerRun: REQUESTS_PER_RUN, pauseMs: 0, ...config },
    cursor,
    env: { igdbClientId: 'id', igdbClientSecret: 'secret' },
    http: p.http,
    log: () => {},
    deadline: Number.POSITIVE_INFINITY,
  });

describe('catalogItem', () => {
  test('a game row with type, status, companies, stores and websites', () => {
    const item = normaliseItem(catalogItem(game(5, "Baldur's Gate 3")));
    expect(item.externalId).toBe('igdb:game:5');
    expect(item.kind).toBe('game');
    expect(item.imageUrl).toBe('https://images.igdb.com/igdb/image/upload/t_cover_big/co1.jpg');
    expect(item.tags).toEqual(
      expect.arrayContaining([
        'game',
        'igdb',
        'type:main_game',
        'status:released',
        'genre:role-playing-rpg',
        'platform:pc',
      ]),
    );
    expect(item.data.developers).toEqual(['Larian Studios']);
    expect(item.data.publishers).toEqual(['Larian Studios']);
    expect(item.data.external).toEqual({ steam: '1086940', epic: 'epic-1' });
    expect(item.data.steamAppId).toBe('1086940');
    expect(item.data.websites).toEqual({
      official: 'https://baldursgate3.game',
      twitter: 'https://twitter.com/larianstudios',
    });
    expect(item.data.collection).toBe("Baldur's Gate");
    expect(item.data.updatedAt).toMatch(/^2023-/);
    expect(item.data.attribution).toContain('IGDB');
  });

  test('unknown enum values degrade to a labelled number', () => {
    const item = catalogItem(
      game(6, 'X', { category: 99, status: 42, external_games: [{ category: 77, uid: 'u' }] }),
    );
    expect(item.tags).toContain('type:category_99');
    expect(item.data.status).toBeNull();
    expect(item.data.external).toEqual({ category_77: 'u' });
  });

  test('queries', () => {
    expect(walkQuery(10)).toContain('where id > 10; sort id asc; limit 500;');
    expect(deltaQuery(1_700_000_000, 0)).toContain(
      'where updated_at > 1700000000 & id > 0; sort id asc; limit 500;',
    );
    expect(resumeFrom({})).toEqual({
      afterId: 0,
      walkedAt: null,
      refreshedAt: null,
      deltaAfterId: 0,
    });
  });
});

describe('the walk', () => {
  test('pages by id to the short page, then marks the pass done', async () => {
    const p = provider(1200);
    const out = await run({}, {}, p);
    expect(out.items).toHaveLength(1200);
    expect(out.items.at(-1).externalId).toBe('igdb:game:1200');
    expect(out.cursor.walkedAt).toMatch(/^\d{4}-/);
    expect(out.cursor.afterId).toBeNull();
    expect(out.cursor.token).toBe('tok');
    expect(out.nextInMinutes).toBeUndefined();
    expect(p.bodies).toHaveLength(3);
  });

  test('stops at the request cap and resumes after the last id', async () => {
    const p = provider(1200);
    const first = await run({ requestsPerRun: 1 }, {}, p);
    expect(first.items).toHaveLength(500);
    expect(first.cursor).toMatchObject({ afterId: 500, walkedAt: null });
    expect(first.nextInMinutes).toBe(10);
    const second = await run({ requestsPerRun: 5 }, first.cursor, p);
    expect(second.items[0].externalId).toBe('igdb:game:501');
    expect(second.items).toHaveLength(700);
    expect(second.cursor.walkedAt).toMatch(/^\d{4}-/);
  });

  test('after the pass, only games changed since the last refresh are fetched', async () => {
    const p = provider(1200, new Set([7, 900]));
    const walked = {
      afterId: null,
      walkedAt: '2026-09-13T00:00:00.000Z',
      refreshedAt: '2026-09-13T00:00:00.000Z',
      deltaAfterId: 0,
      token: 'tok',
      tokenExpires: Date.now() + 3_600_000,
    };
    const out = await run({}, walked, p);
    expect(out.items.map((i) => i.externalId)).toEqual(['igdb:game:7', 'igdb:game:900']);
    expect(p.bodies[0]).toContain('updated_at >');
    expect(out.cursor.refreshedAt > walked.refreshedAt).toBe(true);
    expect(out.cursor.walkedAt).toBe(walked.walkedAt);
    expect(out.nextInMinutes).toBeUndefined();
  });

  test('refuses to run without credentials', async () => {
    await expect(
      igdbCatalog.pull({
        config: {},
        cursor: {},
        env: {},
        http: provider().http,
        log: () => {},
        deadline: Number.POSITIVE_INFINITY,
      }),
    ).rejects.toThrow(/IGDB_CLIENT_ID/);
  });
});
