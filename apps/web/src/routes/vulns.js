import { OPENVULN_HOUSE } from '@nichedb/adapters';
import * as store from '@nichedb/db/vulns';
import { render } from '../lib/http.js';
import { vulnReport, wellKnown } from '../lib/vulns.js';
import { VulnPage, VulnsLanding } from '../views/vulns.jsx';

/**
 * Vulnerabilities: /vulns, /c/vulns/<id>, /c/vulns/<id>.json,
 * /api/v1/vulns/<id> and /.well-known/openvuln.json. /c/vulns itself is the
 * ordinary collection page; the deep dive is one segment below it.
 *
 * A page is two index scans and two cached live reads (EPSS, and OSV for an
 * id not ingested yet), so it is not metered.
 */

let countsCache = { at: 0, rows: [] };
async function counts() {
  if (Date.now() - countsCache.at < 10 * 60_000) return countsCache.rows;
  const rows = await store.vulnCounts().catch(() => countsCache.rows);
  countsCache = { at: Date.now(), rows };
  return rows;
}

const setCache = (c, seconds) => c.header('cache-control', `public, max-age=${seconds}`);

export function registerVulns(app, { report = vulnReport } = {}) {
  app.get('/vulns', async (c) => {
    const q = (c.req.query('q') ?? '').trim();
    if (q) return c.redirect(`/c/vulns/${encodeURIComponent(q)}`, 303);
    return c.html(
      await render(
        <VulnsLanding
          user={c.get('user')}
          counts={await counts()}
          house={OPENVULN_HOUSE.records}
        />,
      ),
    );
  });

  app.get('/.well-known/openvuln.json', (c) => {
    setCache(c, 3600);
    return c.json(wellKnown());
  });

  app.get('/c/vulns/:id', async (c) => {
    const raw = c.req.param('id');
    const json = /\.json$/i.test(raw);
    const r = await report(raw);
    if (json) {
      if (r.error) return c.json({ error: r.error }, r.status ?? 404);
      setCache(c, 900);
      return c.json(r.record);
    }
    if (r.error)
      return c.html(
        await render(
          <VulnPage user={c.get('user')} query={raw.replace(/\.json$/i, '')} error={r.error} />,
        ),
        r.status ?? 404,
      );
    setCache(c, 900);
    return c.html(await render(<VulnPage user={c.get('user')} report={r} />));
  });

  app.get('/api/v1/vulns/:id', async (c) => {
    const r = await report(c.req.param('id'));
    if (r.error) return c.json({ error: r.error }, r.status ?? 404);
    setCache(c, 900);
    return c.json(r.record);
  });
}
