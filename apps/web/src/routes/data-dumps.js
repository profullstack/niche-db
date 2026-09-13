import { config } from '@nichedb/config';
import { dumpStorage, findDump, latestDump } from '@nichedb/core/data-dumps';
import { startDataCheckout } from '../lib/data-checkout.js';
import { render, requireUser, wantsJson } from '../lib/http.js';
import { entitlementsOf } from '../lib/premium.js';
import { Denied } from '../lib/service.js';
import { DataDumpsPage } from '../views/data-dumps.jsx';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const canDownload = (c) => entitlementsOf(c).dataDumps || c.get('user')?.role === 'admin';
function requireData(c) {
  requireUser(c);
  if (!canDownload(c))
    throw new Denied('Hourly data dumps come with the Data plan. See /dumps.', 402);
}

export function publicManifest(manifest) {
  return {
    ...manifest,
    parts: manifest.parts.map(({ key: _key, ...part }) => ({
      ...part,
      url: `${config.siteUrl}/api/v1/dumps/${manifest.id}/${part.file}`,
    })),
  };
}

export function registerDataDumps(app, deps = {}) {
  const latest = deps.latest ?? latestDump;
  const find = deps.find ?? findDump;
  const storage = deps.storage ?? dumpStorage;
  const checkout = deps.checkout ?? startDataCheckout;
  app.get('/dumps', async (c) => {
    const manifest = await latest();
    const access = canDownload(c);
    return c.html(
      await render(
        <DataDumpsPage
          user={c.get('user')}
          access={access}
          snapshot={
            manifest
              ? {
                  id: manifest.id,
                  snapshot_at: manifest.snapshot_at,
                  rows: manifest.rows,
                  parts: manifest.parts.length,
                }
              : null
          }
          ready={Boolean(config.dataDumps.enabled && manifest && config.premium.enabled)}
          notice={c.req.query('notice')}
          error={c.req.query('error')}
        />,
      ),
    );
  });
  app.post('/api/dumps/buy', async (c) => {
    const { checkoutUrl } = await checkout(requireUser(c));
    return wantsJson(c) ? c.json({ checkoutUrl }) : c.redirect(checkoutUrl, 303);
  });
  app.use('/api/v1/dumps/*', async (c, next) => {
    c.header('cache-control', 'private, no-store');
    c.header('vary', 'authorization, cookie');
    requireData(c);
    await next();
  });
  app.get('/api/v1/dumps/latest', async (c) => {
    const manifest = await latest();
    if (!manifest) {
      c.header('retry-after', '60');
      throw new Denied('The first hourly dump is being prepared.', 503);
    }
    return c.json(publicManifest(manifest));
  });
  app.get('/api/v1/dumps/:id/:file', async (c) => {
    const id = c.req.param('id');
    if (!UUID.test(id)) throw new Denied('No such dump.', 404);
    const manifest = await find(id);
    const part = manifest?.parts.find((part) => part.file === c.req.param('file'));
    if (!part) throw new Denied('This dump file is unavailable or has expired.', 404);
    // Short-lived signed links allow object storage to serve large files directly.
    return c.redirect(storage().download(part.key, 300), 303);
  });
}
