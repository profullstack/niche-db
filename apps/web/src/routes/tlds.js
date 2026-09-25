import { config } from '@nichedb/config';
import {
  buildRows,
  checkNames,
  normaliseName,
  priceOut,
  queryTlds,
  tldOut,
} from '@nichedb/core/tlds';
import * as q from '@nichedb/db/queries';
import * as store from '@nichedb/db/tlds';
import { callerAddress } from '../lib/auth-throttle.js';
import { render } from '../lib/http.js';
import { catalogueRows, namesFrom } from '../lib/tlds.js';
import { TldChangesPage, TldCheckPage, TldPage, TldsPage } from '../views/tlds.jsx';

/**
 * Top-level domains: /tlds, /tlds/<tld>, /tlds/changes, /tlds/check, and the
 * same four under /api/v1/tlds.
 *
 * The listing reads the whole catalogue (fourteen hundred labels, a few
 * thousand prices) and facets it in memory through @nichedb/core/tlds, so the
 * page, the API and the MCP tool share one function. The catalogue is held
 * for a minute per process: it changes once a day.
 *
 * The RDAP check is the one part that costs someone else something, since
 * every name is a request to a registry. It is free up to a number of names
 * an hour per caller, answers are cached ten minutes, and a paid caller is
 * not counted.
 */

async function meterChecks(c, n) {
  if (c.get('modules')?.paid) return null;
  const bucket = `rdap:${c.get('user')?.id ?? callerAddress(c) ?? 'unknown'}`;
  const used = await q.bumpApiUsage(bucket, n).catch(() => 0);
  const limit = config.tlds.freeChecksPerHour;
  c.header('x-rdap-limit', String(limit));
  c.header('x-rdap-remaining', String(Math.max(0, limit - used)));
  if (used <= limit) return null;
  return `${limit} name checks an hour are free, and this hour's are used. A crawl pass or Premium lifts the limit.`;
}

async function runCheck(c) {
  const { names, label, truncated } = namesFrom(c.req.query());
  if (!names.length) return { names, label, results: [] };
  const blocked = await meterChecks(c, names.length);
  if (blocked) return { names, label, error: blocked, status: 402, results: [] };
  const rows = await catalogueRows();
  const byTld = new Map(rows.map((r) => [r.tld, r]));
  const results = await checkNames(names, {
    rdapFor: async (t) => byTld.get(t)?.rdap ?? null,
    userAgent: `niche-db/0.1 (+${config.siteUrl})`,
  });
  return { names, label, results, truncated, byTld };
}

const setCache = (c, seconds = 300) => c.header('cache-control', `public, max-age=${seconds}`);

export function registerTlds(app) {
  /* --------------------------------------------------------------- pages -- */

  app.get('/tlds', async (c) => {
    const [rows, stats, registrars, changes] = await Promise.all([
      catalogueRows(),
      store.tldStats(),
      store.listRegistrars(),
      store.listChanges({ limit: 8 }),
    ]);
    const result = queryTlds(rows, c.req.query());
    return c.html(
      await render(
        <TldsPage
          user={c.get('user')}
          result={result}
          stats={stats}
          registrars={registrars}
          changes={changes}
        />,
      ),
    );
  });

  app.get('/tlds/changes', async (c) => {
    const [changes, sync] = await Promise.all([
      store.listChanges({ limit: 500 }),
      store.listSync(),
    ]);
    return c.html(
      await render(<TldChangesPage user={c.get('user')} changes={changes} sync={sync} />),
    );
  });

  app.get('/tlds/check', async (c) => {
    const out = await runCheck(c);
    const tldRows = Object.fromEntries(
      (out.results ?? []).map((r) => [r.tld, out.byTld?.get(r.tld)]).filter(([, v]) => v),
    );
    return c.html(
      await render(
        <TldCheckPage
          user={c.get('user')}
          name={out.label}
          tlds={c.req.query('tlds') ?? ''}
          results={out.results}
          tldRows={tldRows}
          error={
            out.error ??
            (out.truncated
              ? `Only the first ${config.tlds.maxNamesPerCheck} names were checked.`
              : null)
          }
        />,
      ),
      out.status ?? 200,
    );
  });

  app.get('/tlds/:tld', async (c) => {
    const raw = c.req.param('tld').toLowerCase().replace(/^\./, '');
    const ascii = normaliseName(`x.${raw}`)?.slice(2) ?? raw;
    if (ascii !== raw) return c.redirect(`/tlds/${ascii}`, 301);
    const tld = await store.getTld(ascii);
    if (!tld) return c.notFound();
    return c.html(await render(<TldPage user={c.get('user')} tld={tld} />));
  });

  /* ----------------------------------------------------------------- api -- */

  app.get('/api/v1/tlds', async (c) => {
    const result = queryTlds(await catalogueRows(), c.req.query());
    setCache(c, 300);
    if (c.req.query('format') === 'csv') {
      const head =
        'tld,unicode,type,manager,status,registrars,register,register_registrar,renew,renew_registrar,transfer,currency,renewal_ratio';
      const cell = (v) => {
        const s = v === null || v === undefined ? '' : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const lines = result.rows.map((r) =>
        [
          r.tld,
          r.unicode,
          r.type,
          r.manager,
          r.status,
          r.prices.length,
          r.view.register?.amount,
          r.view.register?.registrar,
          r.view.renew?.amount,
          r.view.renew?.registrar,
          r.view.transfer?.amount,
          r.view.renew?.currency ?? r.view.register?.currency,
          r.ratio,
        ]
          .map(cell)
          .join(','),
      );
      c.header('content-type', 'text/csv; charset=utf-8');
      return c.body(`${head}\n${lines.join('\n')}\n`);
    }
    return c.json({
      total: result.total,
      offset: result.params.offset,
      limit: result.params.limit,
      sort: result.params.sort,
      order: result.params.order,
      compare_currency: result.params.registrar ? null : 'USD',
      facets: result.facets,
      tlds: result.rows.map((r) => tldOut(r, config.siteUrl)),
      license:
        "IANA data is public; prices are each registrar's own published list, read daily. See /tlds for sources.",
    });
  });

  app.get('/api/v1/tlds/changes', async (c) => {
    const changes = await store.listChanges({
      limit: c.req.query('limit'),
      since: c.req.query('since') ?? null,
      change: ['added', 'removed', 'returned'].includes(c.req.query('change'))
        ? c.req.query('change')
        : null,
    });
    setCache(c, 300);
    return c.json({ count: changes.length, changes });
  });

  app.get('/api/v1/tlds/registrars', async (c) => {
    setCache(c, 300);
    return c.json({ registrars: await store.listRegistrars() });
  });

  app.get('/api/v1/tlds/check', async (c) => {
    const out = await runCheck(c);
    if (!out.names.length)
      return c.json(
        {
          error:
            'name is required: ?name=foo.watches, ?name=foo&tlds=com,dev, or ?names=a.com,b.dev',
        },
        400,
      );
    if (out.error)
      return c.json({ error: out.error, pricing: `${config.siteUrl}/premium` }, out.status ?? 402);
    return c.json({
      count: out.results.length,
      truncated: Boolean(out.truncated),
      results: out.results.map((r) => {
        const row = out.byTld.get(r.tld);
        return {
          ...r,
          cheapest: row?.best ?? null,
        };
      }),
      note: 'not_registered means the registry holds no registration; it may still be reserved or premium. unknown is never a yes.',
    });
  });

  app.get('/api/v1/tlds/:tld', async (c) => {
    const raw = c.req.param('tld').toLowerCase().replace(/^\./, '');
    const ascii = normaliseName(`x.${raw}`)?.slice(2) ?? raw;
    const tld = await store.getTld(ascii);
    if (!tld) return c.json({ error: 'not found' }, 404);
    setCache(c, 300);
    const [row] = buildRows({ tlds: [tld], prices: tld.prices.filter((p) => !p.gone_at) });
    return c.json({
      ...tldOut(row, config.siteUrl),
      no_longer_sold_at: tld.prices.filter((p) => p.gone_at).map(priceOut),
      changes: tld.changes,
    });
  });
}
