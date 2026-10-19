import { timingSafeEqual } from 'node:crypto';
import { config } from '@nichedb/config';
import {
  CATEGORIES,
  normaliseIp,
  rbldnsdIp4set,
  rpzForDomains,
  rpzForIps,
} from '@nichedb/core/traffic';
import { OWNERS_FETCHED_AT, ownerOf, ownersList } from '@nichedb/core/traffic/owners';
import { rdapLookup } from '@nichedb/core/traffic/rdap';
import * as q from '@nichedb/db/queries';
import * as reputation from '@nichedb/db/reputation';
import * as store from '@nichedb/db/traffic';
import { callerAddress } from '../lib/auth-throttle.js';
import { render, wantsJson } from '../lib/http.js';
import { canReview, Denied } from '../lib/service.js';
import {
  TrafficIpPage,
  TrafficOwnersPage,
  TrafficPage,
  TrafficReviewPage,
} from '../views/traffic.jsx';

/**
 * Bad traffic: /traffic, /traffic/ip/<ip>, /traffic/blocklist.txt,
 * /traffic/review, and /api/v1/traffic.
 *
 * A free service. Anyone can look up an address and read the newest approved
 * ones; a free account reads the whole list and the plain-text blocklist.
 * Every published address was approved by a reviewer (riotcoder, applying the
 * published rules, or a person: admins and the moderators
 * of the threats collection) after reading the evidence; pending and rejected
 * addresses are never shown to the public, not even as "pending".
 */

const REVIEW_COLLECTION = 'threats';
const MAX_PAGE = 1000;

/**
 * ThreatCrush, calling with the TRAFFIC_FEED_TOKEN both sides share: the
 * feed partner, never metered, and the only caller of /decisions.
 */
export function isFeedPartner(c, token = config.traffic.feedToken) {
  const got = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!token || !got || got.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(token));
}

/** Signed in, an API key, a paying crawler or the feed partner: the whole list. */
const fullAccess = (c) => Boolean(c.get('user') || c.get('modules')?.paid || isFeedPartner(c));

const DELIST_PER_HOUR = 5;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[a-z]{2,}$/i;

export async function meterLookup(c) {
  if (c.get('modules')?.paid || isFeedPartner(c)) return null;
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

/** Who owns an address: a known owner from the registry, else RDAP. */
export async function ownerFor(ip, { rdap = rdapLookup } = {}) {
  const known = ownerOf(ip);
  if (known) return { known, rdap: null };
  return { known: null, rdap: await rdap(ip) };
}

/**
 * The owner registry with how many addresses ThreatCrush banned in each
 * network and none of them listed. Counted over every address we hold, so it
 * is cached for ten minutes.
 */
let ownerCounts = { at: 0, value: null };
async function ownersWithCounts() {
  if (!ownerCounts.value || ownerCounts.at < Date.now() - 600_000) {
    const counts = {};
    for (const { ip } of await store.allStatuses()) {
      const o = ownerOf(ip);
      if (o) counts[o.slug] = (counts[o.slug] ?? 0) + 1;
    }
    ownerCounts = { at: Date.now(), value: counts };
  }
  return ownersList().map((o) => ({ ...o, banned: ownerCounts.value[o.slug] ?? 0 }));
}

export function registerTraffic(app) {
  /** Networks we know by name and never list, and why. */
  app.get('/traffic/owners', async (c) => {
    const owners = await ownersWithCounts();
    return c.html(
      await render(
        <TrafficOwnersPage user={c.get('user')} owners={owners} fetchedAt={OWNERS_FETCHED_AT} />,
      ),
    );
  });

  app.get('/api/v1/traffic/owners', async (c) => {
    c.header('cache-control', 'public, max-age=600');
    return c.json({
      about:
        'Networks we know by name (search crawlers, CDNs, public resolvers, company blocks). None is ever listed on /traffic. `banned` counts addresses in each that ThreatCrush banned on our servers.',
      ranges_fetched_at: OWNERS_FETCHED_AT,
      owners: await ownersWithCounts(),
    });
  });

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
    const [result, owner] = await Promise.all([store.lookupIp(ip), ownerFor(ip)]);
    return c.html(
      await render(
        <TrafficIpPage
          user={c.get('user')}
          query={ip}
          result={result}
          owner={owner}
          notice={c.req.query('notice')}
        />,
      ),
    );
  });

  /** The lookup form submits ?ip=; send it to the address's own URL. */
  app.get('/traffic/lookup', (c) =>
    c.redirect(`/traffic/ip/${encodeURIComponent((c.req.query('ip') ?? '').trim())}`, 303),
  );

  /** The addresses a list download carries: all of them with full access, else the newest. */
  async function listIps(c) {
    const params = listParams(c);
    const ips = params.full
      ? await store.listPublishedIps({ maxAgeDays: params.maxAgeDays, category: params.category })
      : (
          await store.listPublished({
            limit: config.traffic.anonymousListLimit,
            category: params.category,
          })
        ).map((r) => r.ip);
    return { params, ips };
  }

  /** The same list as a DNS Response Policy Zone (BIND, Unbound, PowerDNS, Knot). */
  app.get('/traffic/blocklist.rpz', async (c) => {
    const { ips } = await listIps(c);
    c.header('cache-control', 'public, max-age=600');
    c.header('content-type', 'text/dns; charset=utf-8');
    return c.body(rpzForIps(ips));
  });

  /** The same list as an rbldnsd ip4set: run it as your own DNSBL. */
  app.get('/traffic/blocklist.rbldnsd', async (c) => {
    const { ips } = await listIps(c);
    c.header('cache-control', 'public, max-age=600');
    return c.text(rbldnsdIp4set(ips));
  });

  /** abuse.ch malware domains listed in the last week, as an RPZ. Free: the data is free. */
  app.get('/reputation/malware-domains.rpz', async (c) => {
    const days = Math.min(30, Math.max(1, Number(c.req.query('days')) || 7));
    const domains = await reputation.listedIndicators({ type: 'domain', days });
    c.header('cache-control', 'public, max-age=1800');
    c.header('content-type', 'text/dns; charset=utf-8');
    return c.body(
      rpzForDomains(domains, {
        title: `nichedb.dev malware domains (abuse.ch, last ${days} days)`,
      }),
    );
  });

  /** abuse.ch malware IPs listed in the last week, one per line. */
  app.get('/reputation/malware-ips.txt', async (c) => {
    const days = Math.min(30, Math.max(1, Number(c.req.query('days')) || 7));
    const ips = await reputation.listedIndicators({ type: 'ip', days });
    c.header('cache-control', 'public, max-age=1800');
    return c.text(
      `# nichedb.dev malware IPs from abuse.ch (ThreatFox, URLhaus, Feodo), last ${days} days, ${new Date().toISOString()}\n# ${ips.length} addresses. Free to use with credit to abuse.ch.\n${ips.join('\n')}\n`,
    );
  });

  /* ----------------------------------------------------------- delisting -- */

  /** The owner of a listed address asks for it to come off. A reviewer decides. */
  app.post('/traffic/ip/:ip/delist', async (c) => {
    const ip = normaliseIp(c.req.param('ip'));
    const form = await c.req.parseBody();
    const email = String(form.email ?? '').trim();
    const reason = String(form.reason ?? '').trim();
    const back = (notice, status = 303) =>
      wantsJson(c)
        ? c.json({ notice }, status === 303 ? 200 : status)
        : c.redirect(`/traffic/ip/${ip ?? ''}?notice=${encodeURIComponent(notice)}`, 303);
    if (!ip) return c.json({ error: 'not a public IP address' }, 400);
    if (!EMAIL_RE.test(email) || email.length > 320)
      return back('Give an email we can reply to.', 400);
    if (reason.length < 10 || reason.length > 2000)
      return back(
        'Say in a sentence or two why the address should come off (10 to 2,000 characters).',
        400,
      );
    const used = await q.bumpApiUsage(`delist:${callerAddress(c) ?? 'unknown'}`).catch(() => 0);
    if (used > DELIST_PER_HOUR)
      return back('Too many requests from here this hour. Try later.', 429);
    const row = await store.addDelistRequest({ ip, email, reason });
    if (!row) return back('That address is not on the list, so there is nothing to take off.', 404);
    return back(
      'Request received. A reviewer will read it beside the evidence and reply by email.',
    );
  });

  /** ThreatCrush reads every review decision, so a rejection here keeps an address off its feed too. */
  app.get('/api/v1/traffic/decisions', async (c) => {
    if (!isFeedPartner(c)) return c.json({ error: 'not authorized' }, 401);
    c.header('cache-control', 'private, no-store');
    return c.json(await store.listDecisions());
  });

  app.get('/traffic/blocklist.txt', async (c) => {
    const { params, ips } = await listIps(c);
    const header = [
      `# nichedb.dev bad traffic blocklist, ${new Date().toISOString()}`,
      '# Addresses our servers banned for attacks, each one reviewed against its evidence and approved.',
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
        'IP addresses our servers banned for attacks, published only after a reviewer (a person, or riotcoder applying the published rules) read the evidence and approved them. Each decision keeps its reason.',
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
    const [result, owner] = await Promise.all([store.lookupIp(ip), ownerFor(ip)]);
    return c.json({ ...result, owner });
  });

  /* -------------------------------------------------------------- review -- */

  app.get('/traffic/review', async (c) => {
    await requireReviewer(c);
    const status = ['pending', 'approved', 'rejected'].includes(c.req.query('status'))
      ? c.req.query('status')
      : 'pending';
    const offset = Math.max(0, Number(c.req.query('offset')) || 0);
    const [rows, stats, delists] = await Promise.all([
      store.listQueue({ status, limit: 50, offset }),
      store.trafficStats(),
      store.listDelistRequests({ status: 'open' }),
    ]);
    return c.html(
      await render(
        <TrafficReviewPage
          user={c.get('user')}
          rows={rows}
          stats={stats}
          status={status}
          offset={offset}
          delists={delists}
          notice={c.req.query('notice')}
        />,
      ),
    );
  });

  app.post('/traffic/review/delist', async (c) => {
    const user = await requireReviewer(c);
    const form = await c.req.parseBody();
    const id = Number(form.id);
    const action =
      form.action === 'delist' ? 'delist' : form.action === 'decline' ? 'decline' : null;
    const note =
      String(form.note ?? '')
        .trim()
        .slice(0, 1000) || null;
    const back = (msg) => c.redirect(`/traffic/review?notice=${encodeURIComponent(msg)}`, 303);
    if (!Number.isInteger(id) || !action) return back('Choose delist or decline.');
    if (action === 'decline' && !note)
      return back('Say why when declining, so the reply can say why.');
    const done = await store.decideDelistRequest({ id, action, userId: user.id, note });
    if (wantsJson(c)) return c.json({ done });
    return back(
      done
        ? action === 'delist'
          ? 'Taken off the list.'
          : 'Request declined.'
        : 'Already decided.',
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
