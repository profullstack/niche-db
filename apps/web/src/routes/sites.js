import { cached, render, respond } from '../lib/http.js';
import { Denied } from '../lib/service.js';
import { findByPath, listForHost, pathOf, readAndKeep, recordFor, siteOut } from '../lib/sites.js';
import { SiteAddPage, SiteHostPage, SitePage } from '../views/sites.jsx';

/**
 * Sites: /c/sites/<host>/<path>, one page per record; /c/sites/add, where a
 * pasted address is read now and shown as every consumer would draw it; and
 * the same over /api/v1/sites. The record is keyed by its canonical address,
 * so the path is the address without its scheme, query and all.
 *
 * `/c/sites/add` is registered before the catch-all so "add" is never read
 * as a host. `/c/sites` itself is the ordinary collection page.
 */

const LIMIT_MS = 30_000;

async function readNow(c, url) {
  const started = Date.now();
  const out = await readAndKeep(url);
  if (Date.now() - started > LIMIT_MS) c.header('x-slow-read', '1');
  return out;
}

export function registerSites(app) {
  /* ---------------------------------------------------------------- pages -- */

  app.get('/c/sites/add', async (c) => {
    const user = c.get('user');
    const url = (c.req.query('url') ?? '').trim();
    if (url === '') {
      return c.html(
        await render(
          <SiteAddPage user={user} notice={c.req.query('notice')} error={c.req.query('error')} />,
        ),
      );
    }
    try {
      const { record, item, path } = await readNow(c, url);
      c.header('cache-control', 'no-store');
      return c.html(
        await render(<SitePage user={user} record={record} item={item} path={path} justRead />),
      );
    } catch (err) {
      if (!(err instanceof Denied)) throw err;
      return c.html(
        await render(<SiteAddPage user={user} url={url} error={err.message} />),
        err.status,
      );
    }
  });

  app.post('/c/sites/add', async (c) => {
    const body = await c.req.parseBody();
    if (body.website) return c.redirect('/c/sites/add', 303);
    const url = String(body.url ?? '').trim();
    return c.redirect(`/c/sites/add?url=${encodeURIComponent(url)}`, 303);
  });

  app.get('/c/sites/:rest{.+}', async (c) => {
    const rest = c.req.param('rest');
    const search = new URL(c.req.url).search;
    const full = `${rest}${search}`;
    const item = await findByPath(full);
    if (!item) {
      // A host alone lists what is kept for it.
      if (!rest.includes('/') && search === '') {
        const items = await listForHost(rest);
        if (items.length > 0) {
          return cached(
            c,
            `sites:host:${rest}`,
            () => render(<SiteHostPage user={c.get('user')} host={rest} items={items} />),
            300,
          );
        }
      }
      return c.html(
        await render(<SiteAddPage user={c.get('user')} url={`https://${full}`} missing />),
        404,
      );
    }
    const record = item.data.record;
    return cached(
      c,
      `sites:${item.id}:${item.updated_at}`,
      () =>
        render(<SitePage user={c.get('user')} record={record} item={item} path={pathOf(record)} />),
      600,
    );
  });

  /* ------------------------------------------------------------------ api -- */

  app.get('/api/v1/sites', async (c) => {
    const url = (c.req.query('url') ?? '').trim();
    if (url === '') return c.json({ error: 'say which address: ?url=' }, 400);
    const { record, item, fresh } = await recordFor(url);
    c.header('cache-control', 'no-store');
    return c.json({
      record: {
        ...record,
        path: pathOf(record),
        page: `${new URL(c.req.url).origin}${pathOf(record)}`,
        id: item?.id ?? null,
      },
      fresh,
    });
  });

  app.post('/api/v1/sites', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const url = String(body.url ?? '').trim();
    if (url === '') return c.json({ error: 'send { "url": "…" }' }, 400);
    try {
      const { record, item, path } = await readNow(c, url);
      return c.json(
        {
          record: {
            ...record,
            path,
            page: `${new URL(c.req.url).origin}${path}`,
            id: item?.id ?? null,
          },
          fresh: false,
        },
        201,
      );
    } catch (err) {
      if (!(err instanceof Denied)) throw err;
      return respond(c, { error: err.message, status: err.status, redirectTo: '/c/sites/add' });
    }
  });

  app.get('/api/v1/sites/:rest{.+}', async (c) => {
    const rest = c.req.param('rest');
    const search = new URL(c.req.url).search;
    const item = await findByPath(`${rest}${search}`);
    if (!item) {
      if (!rest.includes('/') && search === '') {
        const items = await listForHost(rest);
        if (items.length > 0) {
          c.header('cache-control', 'public, max-age=300');
          return c.json({
            host: rest,
            count: items.length,
            records: items.map(siteOut).filter(Boolean),
          });
        }
      }
      return c.json({ error: 'not found; POST /api/v1/sites { url } to read it' }, 404);
    }
    c.header('cache-control', 'public, max-age=300');
    return c.json({ record: siteOut(item) });
  });
}
