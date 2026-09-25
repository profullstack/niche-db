/**
 * /tlds and /api/v1/tlds, rendered and routed, over a fake store.
 *
 * What would be embarrassing: the headline price sorted first instead of the
 * renewal, a euro price counted as the cheapest dollar, a 404 from a registry
 * shown as "available", the change log or a detail page missing, a Unicode
 * label that 404s instead of redirecting to its ASCII form.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';

const realTlds = await import('@nichedb/db/tlds');
const realQueries = await import('@nichedb/db/queries');

const p = (registrar, tld, currency, register, renew, transfer = renew) => ({
  registrar,
  registrar_name: registrar[0].toUpperCase() + registrar.slice(1),
  registrar_web: `https://${registrar}.example`,
  tld,
  currency,
  register,
  renew,
  transfer,
  restore: null,
  seen_at: '2026-09-25T08:00:00Z',
});
const TLDS = [
  {
    tld: 'com',
    type: 'generic',
    manager: 'VeriSign',
    status: 'delegated',
    rdap: 'https://rdap.test/com/',
    first_seen: '2026092500',
  },
  {
    tld: 'watches',
    type: 'generic',
    manager: 'Identity Digital Limited',
    status: 'delegated',
    rdap: 'https://rdap.test/w/',
    first_seen: '2026092500',
  },
  {
    tld: 'xn--p1ai',
    unicode: 'рф',
    type: 'country-code',
    manager: 'RU-CENTER',
    status: 'delegated',
    rdap: null,
  },
];
const PRICES = [
  p('porkbun', 'com', 'USD', 11.08, 11.08),
  p('ovh', 'com', 'EUR', 7.99, 13.49),
  p('porkbun', 'watches', 'USD', 52.01, 257.98),
];

mock.module('@nichedb/db/tlds', () => ({
  ...realTlds,
  catalogue: async () => ({ tlds: TLDS, prices: PRICES }),
  tldStats: async () => ({
    delegated: 3,
    removed: 0,
    prices: 3,
    registrars: 2,
    list_version: '2026092500',
  }),
  listRegistrars: async () => [
    {
      slug: 'ovh',
      name: 'OVHcloud',
      currency: 'EUR',
      attribution: 'catalogue',
      tlds: 1,
      web: 'https://ovh.example',
    },
    {
      slug: 'porkbun',
      name: 'Porkbun',
      currency: 'USD',
      attribution: 'API',
      tlds: 2,
      web: 'https://porkbun.example',
    },
  ],
  listChanges: async () => [
    {
      tld: 'watches',
      change: 'added',
      list_version: '2026092600',
      at: '2026-09-26T08:20:00Z',
      manager: 'Identity Digital Limited',
    },
  ],
  listSync: async () => [
    { source: 'iana-list', version: '2026092600', fetched_at: '2026-09-26T08:20:00Z' },
  ],
  getTld: async (tld) => {
    const t = TLDS.find((x) => x.tld === tld);
    return t ? { ...t, prices: PRICES.filter((x) => x.tld === tld), changes: [] } : null;
  },
}));
let used = 0;
mock.module('@nichedb/db/queries', () => ({
  ...realQueries,
  bumpApiUsage: async (_bucket, by = 1) => {
    used += by;
    return used;
  },
}));

const { registerTlds } = await import('./tlds.js');
const { withModules, decideModules } = await import('../lib/modules.js');
const { forgetCatalogue } = await import('../lib/tlds.js');
const { clearRdapCache } = await import('@nichedb/core/tlds');

function app() {
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('user', { id: 'u-reader', email: 'r@example.com', role: 'user', timezone: 'UTC' });
    await withModules(decideModules({ plan: 'free', paid: false }), next);
  });
  registerTlds(a);
  return a;
}

const realFetch = globalThis.fetch;
beforeAll(() => {
  forgetCatalogue();
  clearRdapCache();
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith('https://rdap.test/com/domain/taken.com'))
      return new Response(JSON.stringify({ entities: [], events: [] }), { status: 200 });
    if (u.startsWith('https://rdap.test/')) return new Response('', { status: 404 });
    return realFetch(url);
  };
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

describe('the listing', () => {
  test('renders the table, renewal first, the trap marked, facets and sources', async () => {
    const r = await app().request('/tlds');
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('Every top-level domain');
    expect(html.indexOf('.com')).toBeLessThan(html.indexOf('.watches'));
    expect(html).toContain('5.0×');
    expect(html).toContain('renews at 2× or more');
    expect(html).toContain('Where these numbers come from');
    expect(html).toContain('.рф');
  });

  test('the API: USD cheapest by default, a registrar view in its own currency, CSV', async () => {
    const all = await (await app().request('/api/v1/tlds')).json();
    expect(all.tlds.map((t) => t.tld)).toEqual(['com', 'watches', 'xn--p1ai']);
    expect(all.tlds[0].best.renew).toMatchObject({
      amount: 11.08,
      currency: 'USD',
      registrar: 'porkbun',
    });
    expect(all.facets.registrar).toEqual(
      expect.arrayContaining([
        { value: 'porkbun', count: 2 },
        { value: 'ovh', count: 1 },
      ]),
    );
    const ovh = await (await app().request('/api/v1/tlds?registrar=ovh')).json();
    expect(ovh.tlds[0].best.renew).toMatchObject({ amount: 13.49, currency: 'EUR' });
    const trap = await (await app().request('/api/v1/tlds?trap=1')).json();
    expect(trap.tlds.map((t) => t.tld)).toEqual(['watches']);
    const csv = await app().request('/api/v1/tlds?format=csv');
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect((await csv.text()).split('\n')[1]).toStartWith('com,,generic,VeriSign');
  });
});

describe('one label', () => {
  test('the page lists every registrar; a Unicode label redirects to ASCII', async () => {
    const r = await app().request('/tlds/watches');
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('Identity Digital Limited');
    expect(html).toContain('$257.98');
    const redirect = await app().request(`/tlds/${encodeURIComponent('рф')}`);
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get('location')).toBe('/tlds/xn--p1ai');
    expect((await app().request('/tlds/nope')).status).toBe(404);
  });

  test('the JSON carries best, prices and the page', async () => {
    const t = await (await app().request('/api/v1/tlds/com')).json();
    expect(t.best.register.amount).toBe(11.08);
    expect(t.prices).toHaveLength(2);
    expect(t.page).toEndWith('/tlds/com');
  });

  test('the change log', async () => {
    const html = await (await app().request('/tlds/changes')).text();
    expect(html).toContain('What changed in the root');
    expect(html).toContain('2026092600');
    const json = await (await app().request('/api/v1/tlds/changes')).json();
    expect(json.changes[0].tld).toBe('watches');
  });
});

describe('checking names', () => {
  test('a bare word under each ending: registered, not registered, unknown', async () => {
    const r = await (
      await app().request('/api/v1/tlds/check?name=taken&tlds=com,watches,xn--p1ai')
    ).json();
    const by = Object.fromEntries(r.results.map((x) => [x.name, x.status]));
    expect(by).toEqual({
      'taken.com': 'registered',
      'taken.watches': 'not_registered',
      'taken.xn--p1ai': 'unknown',
    });
    expect(JSON.stringify(r)).not.toContain('"available"');
    expect(r.results.find((x) => x.name === 'taken.watches').cheapest.register.amount).toBe(52.01);
  });

  test('the page renders the answers; no name is a 400 from the API', async () => {
    const html = await (await app().request('/tlds/check?name=free.watches')).text();
    expect(html).toContain('not registered');
    expect((await app().request('/api/v1/tlds/check')).status).toBe(400);
  });

  test('past the free allowance a stranger is told, not silently refused', async () => {
    used = 10_000;
    const r = await app().request('/api/v1/tlds/check?name=x.com');
    expect(r.status).toBe(402);
    expect((await r.json()).error).toMatch(/free/);
    used = 0;
  });
});
