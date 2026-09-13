/**
 * A source's config on its page: read as the adapter declared it, whether
 * the driver handed a string or an object, with a long list counted and
 * folded rather than printed as one line of JSON. What would be
 * embarrassing: a config printed escaped twice, two hundred addresses on
 * one line, progress that says "0 of 200" when the walk is done.
 */
import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';

const { describeConfig, parseJson, progressOf, LIST_SHOWN } = await import('./source-config.js');
const { SourcePage } = await import('../views/admin.jsx');
const { render } = await import('./http.js');
const { withModules, decideModules } = await import('./modules.js');
const { opensite } = await import('../../../../packages/adapters/src/opensite.js');

const urls = Array.from({ length: 167 }, (_, i) => `https://site${i}.example/`);

describe('reading a config', () => {
  test('a jsonb string and an object read the same; junk is empty', () => {
    expect(parseJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseJson({ a: 1 })).toEqual({ a: 1 });
    expect(parseJson('not json')).toEqual({});
    expect(parseJson(null)).toEqual({});
    expect(parseJson('null', { x: 1 })).toEqual({ x: 1 });
  });

  test('declared fields in order, a list counted and folded, an undeclared key as JSON', () => {
    const fields = describeConfig(
      opensite,
      JSON.stringify({ urls, sitemaps: [], pages: 250, extra: { a: 1 } }),
    );
    expect(fields.map((f) => [f.key, f.kind])).toEqual([
      ['urls', 'list'],
      ['pages', 'value'],
      ['extra', 'json'],
    ]);
    const list = fields[0];
    expect(list.count).toBe(167);
    expect(list.entries).toHaveLength(LIST_SHOWN);
    expect(list.more).toBe(67);
    expect(fields[1].value).toBe('250');
    expect(fields[2].value).toBe('{\n  "a": 1\n}');
    // A list given as a comma string counts the same.
    expect(
      describeConfig(opensite, { urls: 'https://a.example/, https://b.example/' })[0].count,
    ).toBe(2);
  });

  test('progress in words: walking, done, not started, paused, or nothing to say', () => {
    expect(progressOf({ offset: 250, total: 1000 }, { runCount: 1 })).toBe(
      '250 of 1,000 pages read, the rest a few hundred a minute',
    );
    expect(progressOf('{"offset":250,"total":1000}', { runCount: 1, enabled: false })).toBe(
      '250 of 1,000 pages read, paused',
    );
    expect(progressOf({ offset: 0, total: 167 }, { runCount: 3 })).toBe('all 167 pages read');
    expect(progressOf({ offset: 0, total: 167 }, { runCount: 0 })).toBe(
      '167 pages to read, not started',
    );
    expect(progressOf({}, { runCount: 5 })).toBeNull();
    expect(progressOf(null)).toBeNull();
  });
});

describe('the source page', () => {
  const source = {
    id: 9,
    slug: 'sites-bulk-test',
    name: '167 addresses pasted',
    description: 'A list.',
    adapter: 'opensite',
    collection_slug: 'sites',
    collection_name: 'Sites',
    enabled: true,
    cadence_minutes: 43200,
    item_count: 12,
    run_count: 1,
    next_run_at: new Date().toISOString(),
    last_run_at: new Date().toISOString(),
    last_error: null,
    config: JSON.stringify({ urls, sitemaps: [], pages: 250 }),
    cursor: JSON.stringify({ offset: 100, total: 167 }),
    owner_id: 'u-admin',
  };

  async function page(src) {
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('user', { id: 'u-admin', email: 'a@example.com', role: 'admin', timezone: 'UTC' });
      await withModules(decideModules({ plan: 'free', paid: false }), next);
    });
    app.get('/s/x', async (c) =>
      c.html(
        await render(
          <SourcePage
            user={c.get('user')}
            source={src}
            adapter={opensite}
            runs={[]}
            items={[]}
            canEdit
            notice="167 addresses queued."
          />,
        ),
      ),
    );
    return (await app.request('/s/x')).text();
  }

  test('a string config is not printed as escaped JSON; the list is a count with the entries folded', async () => {
    const html = await page(source);
    expect(html).not.toContain('\\&quot;');
    expect(html).not.toContain('{\\"urls\\"');
    expect(html).toContain('Addresses: 167 entries');
    expect(html).toContain('and 67 more');
    expect(html).toContain('<summary>');
    expect(html).toContain('https://site0.example/');
    // The folded list stops at a hundred; the edit form below still holds every address.
    expect(html.split('config-list')[1].split('</ul>')[0]).not.toContain(
      'https://site166.example/',
    );
    expect(html).toContain('Pages per run:');
    expect(html).toContain('100 of 167 pages read');
    expect(html).toContain('167 addresses queued.');
    // The edit form's list is one address per line, not one comma-joined line.
    expect(html).toContain('https://site0.example/\nhttps://site1.example/');
  });

  test('an object config renders the same way', async () => {
    const html = await page({
      ...source,
      config: { urls: urls.slice(0, 3), pages: 250 },
      cursor: { offset: 0, total: 3 },
    });
    expect(html).toContain('Addresses: 3 entries');
    expect(html).toContain('all 3 pages read');
    expect(html).not.toContain('and 0 more');
  });
});
