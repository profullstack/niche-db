import { describe, expect, test } from 'bun:test';
import {
  c0mputeFetch,
  c0mputeFetchJob,
  desktopFetch,
  fetchRoutesFromEnv,
  reroute,
  shouldReroute,
} from '../packages/core/src/fetch-routes.js';
import { makeHttp } from '../packages/core/src/http.js';

const C0 = { name: 'c0mpute', url: 'http://bridge', token: 't0', peers: ['12D3KooWpeer'] };
const DESK = { name: 'desktop', url: 'http://desk', token: 'd0' };

/** A fake jobs bridge: one container.run, then the two blobs it names. */
function fakeBridge({ status = '200 text/csv', body = 'a,b\n1,2\n', fail = false } = {}) {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    seen.push({ url, init });
    if (url === 'http://bridge/v1/jobs') {
      if (fail) return new Response('{"error":"no_bids"}', { status: 503 });
      return Response.json({
        job_id: 'j1',
        worker: '12D3KooWpeer',
        outputs: [
          { path: '/tmp/out/body', url: '/v1/blobs/b1' },
          { path: '/tmp/out/status', url: '/v1/blobs/s1' },
        ],
      });
    }
    if (url === 'http://bridge/v1/blobs/b1') return new Response(body);
    if (url === 'http://bridge/v1/blobs/s1') return new Response(status);
    return new Response('?', { status: 404 });
  };
  return { fetchImpl, seen };
}

describe('fetch routes', () => {
  test('routes come from the environment, c0mpute first, and need every part', () => {
    expect(fetchRoutesFromEnv({})).toEqual([]);
    expect(
      fetchRoutesFromEnv({ FETCH_ROUTE_C0MPUTE_URL: 'http://b', FETCH_ROUTE_C0MPUTE_TOKEN: 't' }),
    ).toEqual([]);
    const r = fetchRoutesFromEnv({
      FETCH_ROUTE_DESKTOP_URL: 'http://127.0.0.1:9/',
      FETCH_ROUTE_DESKTOP_TOKEN: 'd',
      FETCH_ROUTE_C0MPUTE_URL: 'http://127.0.0.1:8788/',
      FETCH_ROUTE_C0MPUTE_TOKEN: 't',
      FETCH_ROUTE_C0MPUTE_PEERS: 'p1, p2',
    });
    expect(r.map((x) => x.name)).toEqual(['c0mpute', 'desktop']);
    expect(r[0]).toMatchObject({ url: 'http://127.0.0.1:8788', peers: ['p1', 'p2'] });
    expect(r[1].url).toBe('http://127.0.0.1:9');
  });

  test('only refusals are rerouted, and a 503 only when it is a challenge', async () => {
    expect(await shouldReroute(new Response('', { status: 403 }))).toBe(true);
    expect(await shouldReroute(new Response('', { status: 429 }))).toBe(true);
    expect(await shouldReroute(new Response('', { status: 404 }))).toBe(false);
    expect(await shouldReroute(new Response('', { status: 200 }))).toBe(false);
    expect(await shouldReroute(new Response('down for maintenance', { status: 503 }))).toBe(false);
    expect(
      await shouldReroute(new Response('<div id="challenge-platform">', { status: 503 })),
    ).toBe(true);
    expect(await shouldReroute(new Response('', { status: 403 }), { method: 'POST' })).toBe(false);
  });

  test('the curl job carries the URL as data, never in the shell line', () => {
    const evil = 'https://x.test/a"; rm -rf / #';
    const job = c0mputeFetchJob(evil, { userAgent: 'ua', timeoutMs: 30_000 });
    expect(job.workload).toBe('container.run');
    expect(job.spec.cmd.join(' ')).not.toContain('x.test');
    expect(job.spec.env.FETCH_URL).toBe(evil);
    expect(job.spec.env.FETCH_T).toBe('30');
    expect(job.spec.outputs).toEqual(['/tmp/out/body', '/tmp/out/status']);
    expect(job.spec.network).toBe(true);
  });

  test('a c0mpute fetch returns the node’s answer as a Response', async () => {
    const { fetchImpl, seen } = fakeBridge();
    const res = await c0mputeFetch(C0, 'https://x.test/f.csv', { userAgent: 'ua' }, { fetchImpl });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv');
    expect(res.headers.get('x-fetch-route')).toBe('c0mpute');
    expect(await res.text()).toBe('a,b\n1,2\n');
    const sent = JSON.parse(seen[0].init.body);
    expect(sent.allow_peers).toEqual(['12D3KooWpeer']);
    expect(seen[0].init.headers.authorization).toBe('Bearer t0');
  });

  test('a node that could not connect is an error, not a 000 response', async () => {
    const { fetchImpl } = fakeBridge({ status: '000 ' });
    await expect(c0mputeFetch(C0, 'https://x.test/', {}, { fetchImpl })).rejects.toThrow(
      'could not reach x.test',
    );
  });

  test('the desktop answers with the upstream status in a header', async () => {
    const fetchImpl = async (url, init) => {
      expect(url).toBe('http://desk/v1/fetch');
      expect(JSON.parse(init.body).url).toBe('https://x.test/p');
      return new Response('hello', {
        headers: { 'x-upstream-status': '200', 'content-type': 'text/plain' },
      });
    };
    const res = await desktopFetch(DESK, 'https://x.test/p', {}, { fetchImpl });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-fetch-route')).toBe('desktop');
    expect(await res.text()).toBe('hello');
  });

  test('a failed route falls through to the next, and all failing returns the direct answer', async () => {
    const direct = new Response('blocked', { status: 403 });
    const logs = [];
    const fetchImpl = async (url) => {
      if (url.startsWith('http://bridge')) return new Response('', { status: 503 });
      return new Response('ok', { headers: { 'x-upstream-status': '200' } });
    };
    const res = await reroute(
      direct,
      'https://x.test/',
      {},
      {
        routes: [C0, DESK],
        fetchImpl,
        log: (m) => logs.push(m),
      },
    );
    expect(await res.text()).toBe('ok');
    expect(logs.join('\n')).toContain('c0mpute route failed');
    expect(logs.join('\n')).toContain('fetched via desktop');

    const direct2 = new Response('blocked', { status: 403 });
    const none = await reroute(
      direct2,
      'https://x.test/',
      {},
      {
        routes: [C0],
        fetchImpl: async () => new Response('', { status: 503 }),
      },
    );
    expect(none).toBe(direct2);
  });

  test('makeHttp reroutes a refused GET and leaves good answers alone', async () => {
    const realFetch = globalThis.fetch;
    const { fetchImpl } = fakeBridge({ body: 'via node' });
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith('http://bridge')) return fetchImpl(String(url), init);
      if (String(url) === 'https://blocked.test/') return new Response('no', { status: 403 });
      return new Response('direct');
    };
    try {
      const http = makeHttp({ userAgent: 'ua', routes: [C0] });
      expect(await http.text('https://blocked.test/')).toBe('via node');
      expect(await http.text('https://open.test/')).toBe('direct');
      const raw = await http.request('https://blocked.test/', { reroute: false });
      expect(raw.status).toBe(403);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
