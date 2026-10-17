import { config } from '@nichedb/config';
import { CATEGORIES, normaliseIp } from '@nichedb/core/traffic';
import * as q from '@nichedb/db/queries';
import * as store from '@nichedb/db/traffic';
import { callerAddress } from '../lib/auth-throttle.js';
import { render, wantsJson } from '../lib/http.js';
import { canReview, Denied } from '../lib/service.js';
import { TrafficIpPage, TrafficPage, TrafficReviewPage } from '../views/traffic.jsx';

/**
 * Bad traffic: /traffic, /traffic/ip/<ip>, /traffic/blocklist.txt,
 * /traffic/review, and /api/v1/traffic.
 *
 * A free service. Anyone can look up an address and read the newest approved
 * ones; a free account reads the whole list and the plain-text blocklist.
 * Every published address was approved by a person (admins and the moderators
 * of the threats collection) after reading the evidence; pending and rejected
 * addresses are never shown to the public, not even as "pending".
 */

const REVIEW_COLLECTION = 'threats';
const MAX_PAGE = 1000;

/** Signed in, an API key, or a paying crawler: the whole list. */
const fullAccess = (c) => Boolean(c.get('user') || c.get('modules')?.paid);

async function meterLookup(c) {
  if (c.get('modules')?.paid) return null;
  const user = c.get('user');
  const limit = user ? config.traffic.accountLookupsPerHour : config.traffic.freeLookupsPerHour;
  const bucket = `traffic:${user?.id ?? callerAddress(c) ?? 'unknown'}`;
  const used = await q.bumpApiUsage(bucket).catch(() => 0);
  c.header('x-traffic-limit', String(limit));
  c.header('x-traffic-remaining', String(Math.max(0, limit - used)));
  if (used <= limit) return null;
  return user
    ? `${limit} lookups an hour are included with an account, and this hour's are used.`
    : `${limit} lookups an hour are free without an account, and this hour's are used. A free account raises it to ${config.traffic.accountLookupsPerHour}.`;
}

function listParams(c) {
  const full = fullAccess(c);
  const limit = full
    ? Math.min(MAX_PAGE, Math.max(1, Number(c.req.query('limit')) || 100))
    : config.traffic.anonymousListLimit;
  const offset = full ? Math.max(0, Number(c.req.query('offset')) || 0) : 0;
  const days = Number(c.req.query('days'));
  const category = Object.hasOwn(CATEGORIES, c.req.query('category') ?? '')
    ? c.req.query('category')
    : null;
  return {
    full,
    limit,
    offset,
    maxAgeDays: Number.isFinite(days) && days > 0 ? Math.min(days, 3650) : null,
    category,
  };
}

async function requireReviewer(c) {
  const user = c.get('user');
  if (!user)
    throw Object.assign(new Error('sign in'), {
      redirect: `/login?next=${encodeURIComponent('/traffic/review')}`,
    });
  if (!(await canReview(user, REVIEW_COLLECTION))) {
    throw new Denied('Reviewing bad traffic is for admins and threats moderators.', 403);
  }
  return user;
}

export function registerTraffic(app) {
  app.get('/traffic', async (c) => {
    const params = listParams(c);
    const [stats, rows, sync] = await Promise.all([
      store.trafficStats(),
      store.listPublished(params),
      store.getSync('threatcrush'),
    ]);
    const reviewer = c.get('user') ? await canReview(c.get('user'), REVIEW_COLLECTION) : false;
    return c.html(
      await render(
        <TrafficPage
          user={c.get('user')}
          stats={stats}
          rows={rows}
          params={params}
          sync={sync}
          reviewer={reviewer}
        />,
      ),
    );
  });

  app.get('/traffic/ip/:ip', async (c) => {
    const ip = normaliseIp(c.req.param('ip'));
    if (!ip)
      return c.html(
        await render(
          <TrafficIpPage
            user={c.get('user')}
            query={c.req.param('ip')}
            error="That is not a public IP address."
          />,
        ),
        400,
      );
    const blocked = await meterLookup(c);
    if (blocked)
      return c.html(
        await render(<TrafficIpPage user={c.get('user')} query={ip} error={blocked} />),
        402,
      );
    const result = await store.lookupIp(ip);
    return c.html(await render(<TrafficIpPage user={c.get('user')} query={ip} result={result} />));
  });

  /** The lookup form submits ?ip=; send it to the address's own URL. */
  app.get('/traffic/lookup', (c) =>
    c.redirect(`/traffic/ip/${encodeURIComponent((c.req.query('ip') ?? '').trim())}`, 303),
  );

  app.get('/traffic/blocklist.txt', async (c) => {
    const params = listParams(c);
    const ips = params.full
      ? await store.listPublishedIps({ maxAgeDays: params.maxAgeDays })
      : (await store.listPublished({ limit: config.traffic.anonymousListLimit })).map((r) => r.ip);
    const header = [
      `# nichedb.dev bad traffic blocklist, ${new Date().toISOString()}`,
      '# Addresses our servers banned for attacks, each one reviewed and approved by a person.',
      `# ${ips.length} addresses. Free to use. ${config.siteUrl}/traffic`,
      params.full
        ? null
        : `# This is the newest ${config.traffic.anonymousListLimit}. Sign in (free) for the full list.`,
    ].filter(Boolean);
    c.header('cache-control', 'public, max-age=600');
    return c.text(`${header.join('\n')}\n${ips.join('\n')}\n`);
  });

  /* ----------------------------------------------------------------- API -- */

  app.get('/api/v1/traffic', async (c) => {
    const params = listParams(c);
    const [stats, rows] = await Promise.all([store.trafficStats(), store.listPublished(params)]);
    return c.json({
      about:
        'IP addresses our servers banned for attacks, published only after a person reviewed the evidence and approved them.',
      access: params.full
        ? 'full'
        : `newest ${config.traffic.anonymousListLimit}; sign in (free) or use an API key for all`,
      stats: {
        approved: stats.approved,
        pending_review: stats.pending,
        rejected: stats.rejected,
        reviewers: stats.reviewers,
      },
      limit: params.limit,
      offset: params.offset,
      addresses: rows,
      blocklist: `${config.siteUrl}/traffic/blocklist.txt`,
    });
  });

  app.get('/api/v1/traffic/ip/:ip', async (c) => {
    const ip = normaliseIp(c.req.param('ip'));
    if (!ip) return c.json({ error: 'not a public IP address' }, 400);
    const blocked = await meterLookup(c);
    if (blocked) return c.json({ error: blocked, signup: `${config.siteUrl}/login` }, 402);
    return c.json(await store.lookupIp(ip));
  });

  /* -------------------------------------------------------------- review -- */

  app.get('/traffic/review', async (c) => {
    await requireReviewer(c);
    const status = ['pending', 'approved', 'rejected'].includes(c.req.query('status'))
      ? c.req.query('status')
      : 'pending';
    const offset = Math.max(0, Number(c.req.query('offset')) || 0);
    const [rows, stats] = await Promise.all([
      store.listQueue({ status, limit: 50, offset }),
      store.trafficStats(),
    ]);
    return c.html(
      await render(
        <TrafficReviewPage
          user={c.get('user')}
          rows={rows}
          stats={stats}
          status={status}
          offset={offset}
          notice={c.req.query('notice')}
        />,
      ),
    );
  });

  app.post('/traffic/review', async (c) => {
    const user = await requireReviewer(c);
    const form = await c.req.parseBody({ all: true });
    const ips = []
      .concat(form.ip ?? [])
      .map(normaliseIp)
      .filter(Boolean)
      .slice(0, 200);
    const action =
      form.action === 'approve'
        ? 'approved'
        : form.action === 'reject'
          ? 'rejected'
          : form.action === 'reopen'
            ? 'pending'
            : null;
    const note =
      String(form.note ?? '')
        .trim()
        .slice(0, 1000) || null;
    const back = (msg) =>
      c.redirect(
        `/traffic/review?status=${encodeURIComponent(String(form.status ?? 'pending'))}&notice=${encodeURIComponent(msg)}`,
        303,
      );
    if (!action) return back('Choose approve or reject.');
    if (!ips.length) return back('Tick at least one address.');
    if (action === 'rejected' && !note)
      return back('Say why when rejecting, so the next reviewer knows.');
    const changed = await store.reviewIps({ ips, status: action, userId: user.id, note });
    if (wantsJson(c)) return c.json({ changed });
    return back(
      `${changed} address${changed === 1 ? '' : 'es'} ${action === 'pending' ? 'returned to the queue' : action}.`,
    );
  });
}
