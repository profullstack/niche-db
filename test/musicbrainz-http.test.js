import { describe, expect, test } from 'bun:test';
import { musicbrainz } from '../packages/adapters/src/musicbrainz.js';
import { createMusicBrainzRequest, retryDelay } from '../packages/core/src/musicbrainz-http.js';

function clock() {
  let time = 0;
  const sleeps = [];
  return {
    now: () => time,
    sleeps,
    sleep: async (ms) => {
      sleeps.push(ms);
      time += ms;
    },
  };
}

describe('MusicBrainz pacing and retries', () => {
  test('zero, missing, malformed and past Retry-After values still back off', () => {
    for (const header of ['0', '', null, 'invalid', '-2', 'Thu, 01 Jan 1970 00:00:00 GMT']) {
      expect(retryDelay(header, 0, 1000)).toBe(5000);
    }
    expect(retryDelay('0', 1)).toBe(15000);
    expect(retryDelay('0', 2)).toBe(45000);
    expect(retryDelay('30')).toBe(30000);
    expect(retryDelay('Thu, 01 Jan 1970 00:01:00 GMT', 0, 1000)).toBe(59000);
  });
  test('concurrent clients share one request pace', async () => {
    const time = clock();
    const request = createMusicBrainzRequest(time);
    const starts = [];
    const fetch = async () => {
      starts.push(time.now());
      return new Response('{}');
    };
    await Promise.all([request(fetch), request(fetch), request(fetch)]);
    expect(starts).toEqual([0, 1100, 2200]);
  });
  test('retries 503s with increasing waits and returns the successful response', async () => {
    const time = clock();
    const request = createMusicBrainzRequest(time);
    let calls = 0;
    const result = await request(
      async () =>
        new Response('{}', {
          status: ++calls < 4 ? 503 : 200,
          headers: { 'Retry-After': '0' },
        }),
    );
    expect(calls).toBe(4);
    expect(result.status).toBe(200);
    expect(time.sleeps).toEqual([5000, 15000, 45000]);
  });
  test('a second caller waits through the first caller’s cooldown', async () => {
    const time = clock();
    const request = createMusicBrainzRequest(time);
    const starts = [];
    let calls = 0;
    const first = request(async () => {
      starts.push(['first', time.now()]);
      return new Response('{}', { status: ++calls === 1 ? 429 : 200 });
    });
    const second = request(async () => {
      starts.push(['second', time.now()]);
      return new Response('{}');
    });
    await Promise.all([first, second]);
    expect(starts).toEqual([
      ['first', 0],
      ['first', 5000],
      ['second', 6100],
    ]);
  });
  test('does not retry permanent errors and a network failure does not poison the queue', async () => {
    const request = createMusicBrainzRequest(clock());
    let calls = 0;
    expect(
      (
        await request(async () => {
          calls++;
          return new Response('', { status: 400 });
        })
      ).status,
    ).toBe(400);
    expect(calls).toBe(1);
    await expect(
      request(async () => {
        throw new Error('network');
      }),
    ).rejects.toThrow('network');
    expect((await request(async () => new Response('{}'))).ok).toBe(true);
  });
  test('long Retry-After values stop the retry instead of retrying early', async () => {
    const time = clock();
    const request = createMusicBrainzRequest(time);
    let calls = 0;
    const fetch = async () => {
      calls++;
      return new Response('', { status: 503, headers: { 'Retry-After': '600' } });
    };
    expect((await request(fetch)).status).toBe(503);
    await expect(request(fetch)).rejects.toThrow('cooldown');
    expect(calls).toBe(1);
    expect(time.sleeps).toEqual([]);
  });
});

test('temporary cover-art failures are not cached as permanently missing', async () => {
  const ctx = {
    config: { days: 90, pages: 1 },
    cursor: {},
    budget: 2,
    deadline: Date.now() + 60000,
    log: () => {},
    http: {
      json: async () => ({
        releases: [
          { id: 'transient', title: 'Example' },
          { id: 'missing', title: 'Another' },
        ],
      }),
      request: async (url) => new Response('', { status: url.includes('transient') ? 503 : 404 }),
    },
  };
  const result = await musicbrainz.pull(ctx);
  expect(result.items).toHaveLength(2);
  expect(result.cursor.covers).toEqual({ missing: false });
});
