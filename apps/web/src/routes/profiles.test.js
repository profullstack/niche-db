/**
 * /c/profiles, rendered and routed, over a fake store.
 *
 * What would be embarrassing: a wrong name part that 404s instead of
 * redirecting, a handle that resolves to the wrong person, a file served as
 * HTML, a stranger allowed to edit, a page that throws at request time, an
 * owner's value rendered as markup.
 */
import { describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';

const ADA = {
  id: 12,
  slug: 'ada-lovelace',
  handle: null,
  name: 'Ada Lovelace',
  kind: 'person',
  headline: 'Host of The Analytical Engine.',
  doc: '# Ada Lovelace\n\n- **Kind**: person\n- **Web**: https://ada.example\n\nHost of The Analytical Engine.\n\n## Accounts\n\n- https://bsky.app/profile/ada.example\n\n## Broadcast\n\n- **Show**: The Analytical Engine\n- **Feed**: https://ada.example/feed.xml\n',
  data: {
    identity: { kind: 'person', web: 'https://ada.example' },
    accounts: [{ url: 'https://bsky.app/profile/ada.example', label: null, network: 'bluesky' }],
    topics: [],
    broadcasts: [{ Show: 'The Analytical Engine', Feed: 'https://ada.example/feed.xml' }],
    guest: null,
    kind: 'person',
  },
  owner_user_id: 'u-owner',
  claimed_at: '2026-09-13T05:00:00.000Z',
  claim_method: 'email',
  overrides: {},
  public: true,
  source_id: 1,
  sources: [
    {
      app: 'p0dcasters',
      source_url: 'https://p0dcasters.com/podcast/x/openprofile.md',
      page_url: 'https://p0dcasters.com/podcast/x',
      fetched_at: '2026-09-13T04:00:00.000Z',
    },
  ],
  created_at: '2026-09-13T04:00:00.000Z',
  updated_at: '2026-09-13T05:00:00.000Z',
};
const BOB = {
  ...ADA,
  id: 13,
  slug: 'bob',
  handle: 'bob',
  name: 'Bob <script>',
  owner_user_id: null,
  claimed_at: null,
  claim_method: null,
  headline: '<b>not bold</b>',
};

const store = {
  overrides: {},
  async getProfile(id) {
    return Number(id) === 12 ? { ...ADA } : Number(id) === 13 ? { ...BOB } : null;
  },
  async getProfileByHandle(h) {
    return h === 'bob' ? { ...BOB } : null;
  },
  async listProfiles() {
    return [{ ...ADA }, { ...BOB }];
  },
  async profilesOf() {
    return [{ ...ADA }];
  },
  async keysFor(id) {
    return Number(id) === 13 ? ['email:bob@example.com'] : [];
  },
  async setOverrides(_id, o) {
    store.overrides = o;
  },
  async setPublic() {},
  async setHandle() {
    return true;
  },
  async claim() {
    return true;
  },
  async rebuild(id) {
    return { profile: await store.getProfile(id), built: null };
  },
  profileIdOfItem() {
    return null;
  },
};
mock.module('@nichedb/db/profiles', () => store);

const { registerProfiles } = await import('./profiles.js');
const { Denied } = await import('../lib/service.js');
const { withModules, decideModules } = await import('../lib/modules.js');

function appAs(user) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', user);
    // Every page renders inside the modules scope the real app sets up.
    await withModules(decideModules({ plan: 'free', paid: false }), next);
  });
  app.onError((err, c) => {
    if (err instanceof Denied) return c.json({ error: err.message }, err.status);
    throw err;
  });
  registerProfiles(app);
  return app;
}

const owner = { id: 'u-owner', email: 'ada@example.com', role: 'user', timezone: 'UTC' };
const stranger = { id: 'u-other', email: 'x@example.com', role: 'user', timezone: 'UTC' };

describe('the profile URLs', () => {
  test('a wrong name part redirects to the right one; a bare id too', async () => {
    const app = appAs(owner);
    const r = await app.request('/c/profiles/wrong-name-12');
    expect(r.status).toBe(301);
    expect(r.headers.get('location')).toBe('/c/profiles/ada-lovelace-12');
    const bare = await app.request('/c/profiles/12');
    expect(bare.headers.get('location')).toBe('/c/profiles/ada-lovelace-12');
  });

  test('a handle resolves, and the slug-id form of a handled profile redirects to the handle', async () => {
    const app = appAs(owner);
    expect((await app.request('/c/profiles/bob')).status).toBe(200);
    const r = await app.request('/c/profiles/bob-13');
    expect(r.status).toBe(301);
    expect(r.headers.get('location')).toBe('/c/profiles/bob');
  });

  test('nobody is a 404', async () => {
    expect((await appAs(owner).request('/c/profiles/nobody-99')).status).toBe(404);
    expect((await appAs(owner).request('/c/profiles/nobody')).status).toBe(404);
  });

  test('the file is served as text/markdown with CORS open and the link relation, to anyone', async () => {
    const r = await appAs(null).request('/c/profiles/ada-lovelace-12/openprofile.md');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    expect(r.headers.get('link')).toContain('rel="openprofile"');
    expect(await r.text()).toStartWith('# Ada Lovelace');
    const api = await appAs(null).request('/api/v1/profiles/12.md');
    expect(api.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
  });
});

describe('the page', () => {
  test('renders the person, points at the file, and shows Edit to the owner', async () => {
    const r = await appAs(owner).request('/c/profiles/ada-lovelace-12');
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('<h1>Ada Lovelace</h1>');
    expect(html).toContain(
      '<link rel="openprofile" href="https://nichedb.test/c/profiles/ada-lovelace-12/openprofile.md"',
    );
    expect(html).toContain('href="/c/profiles/ada-lovelace-12/edit"');
    expect(html).toContain('The Analytical Engine');
    expect(html).toContain('bluesky');
    expect(html).toContain('p0dcasters');
  });

  test('shows a stranger the claim button on an unclaimed profile, and escapes what the sources wrote', async () => {
    const html = await (await appAs(stranger).request('/c/profiles/bob')).text();
    expect(html).toContain('action="/c/profiles/bob/claim"');
    expect(html).toContain('This is me');
    expect(html).toContain('Bob &lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;b&gt;not bold&lt;/b&gt;');
  });

  test('the editor is the owner’s only', async () => {
    expect((await appAs(owner).request('/c/profiles/ada-lovelace-12/edit')).status).toBe(200);
    expect((await appAs(stranger).request('/c/profiles/ada-lovelace-12/edit')).status).toBe(403);
    const anon = await appAs(null).request('/c/profiles/ada-lovelace-12/edit');
    expect(anon.status).toBe(303);
    expect(anon.headers.get('location')).toContain('/login?next=');
  });
});

describe('the API', () => {
  test('lists people in both shapes: the parsed view and the listing another directory pulls', async () => {
    const body = await (await appAs(null).request('/api/v1/profiles')).json();
    expect(body.profiles[0].ref).toBe('ada-lovelace-12');
    expect(body.profiles[0].broadcasts[0].Show).toBe('The Analytical Engine');
    expect(body.openprofiles[0].url).toBe(
      'https://nichedb.test/c/profiles/ada-lovelace-12/openprofile.md',
    );
    expect(body.openprofiles[1].page).toBe('https://nichedb.test/c/profiles/bob');
  });

  test('a stranger cannot edit; the owner can, as JSON or as a whole file', async () => {
    const put = (app, ref, init) =>
      app.request(`/api/v1/profiles/${ref}`, { method: 'PUT', ...init });
    const denied = await put(appAs(stranger), 'ada-lovelace-12', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ headline: 'mine now' }),
    });
    expect(denied.status).toBe(403);
    const anon = await put(appAs(null), 'ada-lovelace-12', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ headline: 'mine now' }),
    });
    expect(anon.status).toBe(401);

    const ok = await put(appAs(owner), 'ada-lovelace-12', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ headline: 'Countess.', sections: { guest: '- **Available**: yes' } }),
    });
    expect(ok.status).toBe(200);
    expect(store.overrides.headline).toBe('Countess.');
    expect(store.overrides.sections.guest).toBe('- **Available**: yes');

    const file = await put(appAs(owner), '12', {
      headers: { 'content-type': 'text/markdown' },
      body: '# Ada Lovelace\n\n- **Kind**: person\n\nJust Ada.\n\n## Guest\n\n- **Rate**: free\n',
    });
    expect(file.status).toBe(200);
    expect(store.overrides.headline).toBe('Just Ada.');
    expect(store.overrides.sections.guest).toBe('- **Rate**: free');
    // Sections the file left out are removed from the merge, not kept.
    expect(store.overrides.sections.broadcast).toBe('none');
    expect(store.overrides.sections.accounts).toBe('none');
  });

  test('a claim is proven by the email the profile lists', async () => {
    const bob = { id: 'u-bob', email: 'bob@example.com', role: 'user', timezone: 'UTC' };
    const r = await appAs(bob).request('/api/v1/profiles/bob/claim', { method: 'POST' });
    expect(r.status).toBe(200);
    expect((await r.json()).method).toBe('email');
    const nope = await appAs(stranger).request('/api/v1/profiles/bob/claim', {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    });
    expect(nope.status).toBe(403);
    expect((await nope.json()).error).toContain('Nothing proves');
  });
});
