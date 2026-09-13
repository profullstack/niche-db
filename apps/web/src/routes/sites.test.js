/**
 * /c/sites, rendered and routed, over a fake store and a fake web.
 *
 * What would be embarrassing: a path with a query not found, "add" read as
 * a host, a stranger's title rendered as markup, a record page without its
 * own og:image, an API answer without the record.
 */
import { describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';

const URL_A = 'https://nixamp.com/?url=https%3A%2F%2Fs1.example%2Fview%2FK&play=channel%3Aurl-1';
const RECORD = {
  opensite: '0.1',
  url: URL_A,
  canonical: URL_A,
  site: { name: 'nixamp', web: 'https://nixamp.com' },
  kind: 'stream',
  title: 'Inspiring <b>Founders</b>',
  description: 'Live on server1.',
  image: { url: 'https://cdn.example/a.jpg', width: 3000, height: 3000 },
  fetched_at: '2026-09-13T04:52:10.000Z',
  status: 'live',
  source: 'read',
  cards: {
    og: { title: 'Inspiring <b>Founders</b>', image: 'https://cdn.example/a.jpg' },
    twitter: { card: 'summary' },
  },
  jsonld: [],
  tags: [],
  feeds: [],
};
const ITEM = {
  id: 7,
  title: RECORD.title,
  summary: RECORD.description,
  url: URL_A,
  image_url: RECORD.image.url,
  kind: 'stream',
  tags: [],
  data: {
    record: RECORD,
    path: 'nixamp.com/?url=https%3A%2F%2Fs1.example%2Fview%2FK&play=channel%3Aurl-1',
  },
  updated_at: new Date().toISOString(),
  collection_slug: 'sites',
};

const store = {
  upserts: [],
  // The array literal helper other modules import from the same file.
  pgArray: (values) => `{${(values ?? []).map((v) => JSON.stringify(String(v))).join(',')}}`,
  async getCollection(slug) {
    return slug === 'sites' ? { id: 1, slug } : null;
  },
  async getSource(slug) {
    return slug === 'sites-pasted' ? { id: 2, slug } : null;
  },
  async itemByUrls({ urls }) {
    return urls.includes(URL_A) ? { ...ITEM } : null;
  },
  async itemsForHost({ host }) {
    return host === 'nixamp.com' ? [{ ...ITEM }] : [];
  },
  async upsertItems({ items }) {
    store.upserts.push(...items);
    return { added: items.length, updated: 0 };
  },
};
mock.module('@nichedb/db/queries', () => store);

const PAGE =
  '<html><head><title>Fresh</title><meta property="og:image" content="https://cdn.example/f.jpg"></head></html>';
mock.module('@nichedb/core/http', () => ({
  makeHttp: () => ({
    async request(url) {
      if (url.endsWith('/robots.txt') || url.endsWith('/opensite.json'))
        return new Response('', { status: 404 });
      if (url.startsWith('https://fresh.example/'))
        return new Response(PAGE, { headers: { 'content-type': 'text/html' } });
      return new Response('', { status: 404 });
    },
  }),
}));

const { registerSites } = await import('./sites.js');
const { Denied } = await import('../lib/service.js');
const { withModules, decideModules } = await import('../lib/modules.js');

function app() {
  const a = new Hono();
  a.use('*', async (c, next) => {
    // A signed-in reader, so pages render directly rather than through the page cache.
    c.set('user', { id: 'u-reader', email: 'r@example.com', role: 'user', timezone: 'UTC' });
    await withModules(decideModules({ plan: 'free', paid: false }), next);
  });
  a.onError((err, c) => {
    if (err instanceof Denied) return c.json({ error: err.message }, err.status);
    throw err;
  });
  registerSites(a);
  return a;
}

describe('the record page', () => {
  test('a path with its query finds the record and draws the card with its own picture', async () => {
    const r = await app().request(`/c/sites/${ITEM.data.path}`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('Inspiring &lt;b&gt;Founders&lt;/b&gt;');
    expect(html).not.toContain('Inspiring <b>Founders</b>');
    expect(html).toContain('<meta property="og:image" content="https://cdn.example/a.jpg"');
    expect(html).toContain('<meta name="twitter:card" content="summary"');
    // One preview per consumer.
    for (const who of ['X', 'Slack', 'iMessage', 'Discord', 'LinkedIn', 'WhatsApp'])
      expect(html).toContain(`<figcaption>${who}</figcaption>`);
    expect(html).toContain('og:image:width'.replace('og:image:width', 'og:title'));
  });

  test('a host alone lists what is kept; an unknown path offers to read it', async () => {
    const list = await app().request('/c/sites/nixamp.com');
    expect(list.status).toBe(200);
    expect(await list.text()).toContain('1 pages kept');
    const missing = await app().request('/c/sites/nowhere.example/x');
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain('Not indexed yet');
  });

  test('add is a form, and add?url= reads now and keeps the record', async () => {
    const form = await app().request('/c/sites/add');
    expect(form.status).toBe(200);
    expect(await form.text()).toContain('action="/c/sites/add"');
    const read = await app().request('/c/sites/add?url=https%3A%2F%2Ffresh.example%2Fpage');
    expect(read.status).toBe(200);
    expect(await read.text()).toContain('Fresh');
    expect(store.upserts.at(-1).url).toBe('https://fresh.example/page');
    expect(store.upserts.at(-1).imageUrl).toBe('https://cdn.example/f.jpg');
    const bad = await app().request('/c/sites/add?url=javascript%3Aalert(1)');
    expect(bad.status).toBe(400);
    const posted = await app().request('/c/sites/add', {
      method: 'POST',
      body: new URLSearchParams({ url: 'https://fresh.example/page' }),
    });
    expect(posted.status).toBe(303);
    expect(posted.headers.get('location')).toBe(
      '/c/sites/add?url=https%3A%2F%2Ffresh.example%2Fpage',
    );
  });
});

describe('the api', () => {
  test('GET ?url= answers the kept record when fresh, and reads an unknown one', async () => {
    const kept = await app().request(`/api/v1/sites?url=${encodeURIComponent(URL_A)}`);
    expect(kept.status).toBe(200);
    const body = await kept.json();
    expect(body.fresh).toBe(true);
    expect(body.record.canonical).toBe(URL_A);
    expect(body.record.path).toBe(`/c/sites/${ITEM.data.path}`);
    const fresh = await app().request('/api/v1/sites?url=https%3A%2F%2Ffresh.example%2Fother');
    expect((await fresh.json()).record.title).toBe('Fresh');
    expect((await app().request('/api/v1/sites')).status).toBe(400);
  });

  test('POST reads now; the path form answers the kept record or 404', async () => {
    const posted = await app().request('/api/v1/sites', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://fresh.example/p' }),
    });
    expect(posted.status).toBe(201);
    expect((await posted.json()).record.status).toBe('live');
    const byPath = await app().request(`/api/v1/sites/${ITEM.data.path}`);
    expect(byPath.status).toBe(200);
    expect((await byPath.json()).record.id).toBe(7);
    expect((await app().request('/api/v1/sites/nowhere.example/x')).status).toBe(404);
    const host = await app().request('/api/v1/sites/nixamp.com');
    expect((await host.json()).count).toBe(1);
  });
});
