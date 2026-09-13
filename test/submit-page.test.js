/**
 * The submit form and the admin queue, rendered.
 *
 * What would be embarrassing: a page that throws at request time, a form
 * that posts somewhere else, a submitted note or title rendered as markup,
 * the admin queue reachable from the nav for someone who is not an admin.
 */
import { describe, expect, test } from 'bun:test';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';

// Imported by path, not by package name: this directory is outside every
// workspace, so the linked names only resolve from inside apps/web.
const { SubmitPage, SubmissionsAdmin } = await import('../apps/web/src/views/submit.jsx');
const { withModules, decideModules } = await import('../apps/web/src/lib/modules.js');

const modules = decideModules({ plan: 'free', paid: false });
const renderIn = (fn) => withModules(modules, () => fn().toString());

const collections = [
  { slug: 'news', name: 'News' },
  { slug: 'podcasts', name: 'Podcasts' },
];

describe('the submit page', () => {
  test('renders for a stranger, with the email field and the honeypot', async () => {
    const html = await renderIn(() => SubmitPage({ user: null, collections, collection: null }));
    expect(html).toContain('<form method="post" action="/submit"');
    expect(html).toContain('name="url"');
    expect(html).toContain('name="email"');
    expect(html).toContain('name="website"');
    expect(html).toContain('href="/submit"'); // the nav link every page carries
  });

  test('preselects the collection it was opened from and drops the email field when signed in', async () => {
    const html = await renderIn(() =>
      SubmitPage({
        user: { id: 'u1', email: 'a@b.c', role: 'user' },
        collections,
        collection: 'podcasts',
      }),
    );
    expect(html).toMatch(/<option value="podcasts" selected/);
    expect(html).not.toContain('name="email"');
  });

  test('echoes a rejected value back as text, not markup', async () => {
    const html = await renderIn(() =>
      SubmitPage({
        user: null,
        collections,
        collection: null,
        values: { url: 'x', note: '<img src=x onerror=alert(1)>' },
        error: 'That is not a URL',
      }),
    );
    expect(html).toContain('That is not a URL');
    expect(html).toContain('&lt;img src=x');
    expect(html).not.toContain('<img src=x');
  });

  test('shows the admin queue link only to an admin', async () => {
    const asUser = await renderIn(() =>
      SubmitPage({ user: { id: 'u', email: 'u@x', role: 'user' }, collections }),
    );
    const asAdmin = await renderIn(() =>
      SubmitPage({ user: { id: 'a', email: 'a@x', role: 'admin' }, collections }),
    );
    expect(asUser).not.toContain('href="/admin/submissions"');
    expect(asAdmin).toContain('href="/admin/submissions"');
  });
});

describe('the admin queue', () => {
  const admin = { id: 'a', email: 'a@x', role: 'admin' };
  const pending = [
    {
      id: 7,
      feed_url: 'https://example.com/feed.xml',
      collection_slug: 'podcasts',
      note: '<script>alert(1)</script> a good show',
      user_handle: null,
      user_email: null,
      email: 'who@example.com',
      created_at: new Date().toISOString(),
      probe: {
        status: 200,
        looksLikeFeed: true,
        contentType: 'application/rss+xml',
        title: 'A <b>Show</b>',
      },
      status: 'pending',
    },
  ];

  test('renders a waiting row with approve and reject, and the collection preselected', async () => {
    const html = await renderIn(() =>
      SubmissionsAdmin({ user: admin, pending, decided: [], collections }),
    );
    expect(html).toContain('action="/admin/submissions/7"');
    expect(html).toContain('value="approve"');
    expect(html).toContain('value="reject"');
    expect(html).toMatch(/<option value="podcasts" selected/);
    expect(html).toContain('HTTP 200');
    expect(html).toContain('parses as a feed');
  });

  test('renders submitted text and probed titles as text, never markup', async () => {
    const html = await renderIn(() =>
      SubmissionsAdmin({ user: admin, pending, decided: [], collections }),
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('A <b>Show</b>');
    expect(html).toContain('A &lt;b&gt;Show&lt;/b&gt;');
  });

  test('says where an approved one went', async () => {
    const decided = [
      {
        id: 3,
        feed_url: 'https://example.org/rss',
        status: 'approved',
        source_slug: 'example-org',
        forwarded_to: null,
        decided_by_email: 'a@x',
        decided_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        probe: {},
      },
      {
        id: 4,
        feed_url: 'https://pod.example/feed',
        status: 'approved',
        source_slug: null,
        forwarded_to: 'rssamplifier.com',
        decided_by_email: 'a@x',
        decided_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        probe: {},
      },
    ];
    const html = await renderIn(() =>
      SubmissionsAdmin({ user: admin, pending: [], decided, collections }),
    );
    expect(html).toContain('href="/s/example-org"');
    expect(html).toContain('rssamplifier.com');
    expect(html).toContain('Nothing waiting.');
  });
});
