import { expect, test } from 'bun:test';
import { pageCache } from '../apps/web/src/lib/page-cache.js';

function fixture() {
  const data = new Map();
  const errors = [];
  const redis = {
    get: async (key) => data.get(key),
    set: async (key, value) => data.set(key, value),
  };
  return { data, errors, cached: pageCache(redis, { onError: (e) => errors.push(e) }) };
}

test('concurrent cold requests share one render', async () => {
  const { cached } = fixture();
  let calls = 0;
  const produce = async () => {
    calls++;
    await Bun.sleep(10);
    return 'fresh';
  };
  const results = await Promise.all(Array.from({ length: 10 }, () => cached('home', produce, 60)));
  expect(calls).toBe(1);
  expect(results.every((r) => r.body === 'fresh')).toBe(true);
});

test('stale page returns while refresh is pending, then fresh page is served', async () => {
  const { data, cached } = fixture();
  data.set('page:home:stale', 'previous');
  let finish;
  const produced = new Promise((resolve) => {
    finish = resolve;
  });
  expect(await cached('home', () => produced, 60)).toEqual({ body: 'previous', status: 'stale' });
  finish('new');
  await Bun.sleep(0);
  expect(
    await cached(
      'home',
      () => {
        throw Error('unexpected');
      },
      60,
    ),
  ).toEqual({ body: 'new', status: 'hit' });
});

test('failed refresh preserves stale page and permits retry', async () => {
  const { data, errors, cached } = fixture();
  data.set('page:home:stale', 'previous');
  await cached(
    'home',
    async () => {
      throw Error('database unavailable');
    },
    60,
  );
  await Bun.sleep(0);
  expect(errors).toHaveLength(1);
  expect((await cached('home', async () => 'recovered', 60)).body).toBe('previous');
  await Bun.sleep(0);
  expect(data.get('page:home')).toBe('recovered');
});
