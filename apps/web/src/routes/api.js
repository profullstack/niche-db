import { config } from '@nichedb/config';
import { describeAdapters, describeEnrichers } from '@nichedb/core';
import { parseName } from '@nichedb/core/names';
import * as q from '@nichedb/db/queries';
import { enqueueRun } from '@nichedb/queue';
import { COMMANDS } from '@profullstack/nichedb';
import { mintPass } from '@profullstack/x402-gateway';
import { callerAddress } from '../lib/auth-throttle.js';
import { isProUser, render, requireUser } from '../lib/http.js';
import { allowedEnrichers, collectionOut, feedOut, itemOut, sourceOut } from '../lib/serialize.js';
import {
  addSource,
  canEditSource,
  createFeed,
  Denied,
  editFeed,
  editSource,
} from '../lib/service.js';
import { ApiDocs, CliDocs } from '../views/admin.jsx';

const lim = (v, d, max) => Math.min(Math.max(1, Number(v) || d), max);
const site = () => config.siteUrl;

/** Per-hour metering: by key when there is one, by address otherwise. Pro keys get more. */
async function rateLimit(c, next) {
  const user = c.get('user');
  const viaKey = c.get('viaKey');
  const bucket = viaKey ? `key:${user.api_key_id}` : `ip:${callerAddress(c) ?? 'unknown'}`;
  const limit = viaKey
    ? (await isProUser(user))
      ? config.api.proPerHour
      : config.api.freePerHour
    : config.api.anonPerHour;
  const used = await q.bumpApiUsage(bucket);
  c.header('x-ratelimit-limit', String(limit));
  c.header('x-ratelimit-remaining', String(Math.max(0, limit - used)));
  if (used > limit) {
    c.header('retry-after', '3600');
    return c.json(
      { error: `Rate limit of ${limit}/hour reached for this ${viaKey ? 'key' : 'address'}.` },
      429,
    );
  }
  await next();
}

async function collectionOrNull(slug) {
  if (!slug) return null;
  const col = await q.getCollection(slug);
  if (!col) throw new Denied(`No collection named ${slug}`, 404);
  return col;
}

export function registerApi(app) {
  app.get('/docs/api', async (c) =>
    c.html(await render(<ApiDocs user={c.get('user')} stats={await q.siteStats()} />)),
  );
  app.get('/docs/cli', async (c) =>
    c.html(await render(<CliDocs user={c.get('user')} commands={COMMANDS} />)),
  );

  app.use('/api/v1/*', rateLimit);
  app.use('/api/v1/*', async (c, next) => {
    c.header('access-control-allow-origin', '*');
    c.header('access-control-allow-headers', 'content-type, authorization');
    c.header('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    if (c.req.method === 'OPTIONS') return c.body(null, 204);
    await next();
  });

  app.get('/api/v1', async (c) => {
    const user = c.get('user');
    return c.json({
      name: `${config.siteName} API`,
      version: 1,
      documentation: `${site()}/docs/api`,
      mcp: `${site()}/mcp`,
      llms: `${site()}/llms.txt`,
      stats: await q.siteStats(),
      you: user
        ? {
            email: user.email,
            role: user.role,
            pro: await isProUser(user),
            via: c.get('viaKey') ? 'key' : 'session',
          }
        : null,
      limits: {
        anonymous: config.api.anonPerHour,
        key: config.api.freePerHour,
        pro: config.api.proPerHour,
      },
      note: 'Every item carries time_known and precision. A false time_known means the date is real and the clock is not.',
    });
  });

  app.get('/api/v1/me', async (c) => {
    const user = requireUser(c);
    return c.json({
      id: user.id,
      email: user.email,
      role: user.role,
      pro: await isProUser(user),
      feeds: await q.countUserFeeds(user.id),
    });
  });

  /**
   * A member's crawl pass: the same signed token a crawler buys at /crawl,
   * good until the membership ends. Present it as `x-crawl-pass` (or a bearer)
   * and the paywall opens; add `?disable=ads,tracking` to drop those too.
   */
  app.get('/api/v1/crawl-pass', async (c) => {
    const user = requireUser(c);
    const term = await q.activeMembership(user.id);
    if (!term) throw new Denied('A crawl pass comes with Pro.', 402);
    if (!config.x402.coinpayKey)
      throw new Denied('Crawl passes are not configured on this deployment.', 400);
    const expiresAt = Math.floor(new Date(term.expires_at).getTime() / 1000);
    const pass = await mintPass({
      secret: config.x402.coinpayKey,
      ref: `membership:${term.id}`,
      expiresAt,
    });
    return c.json({
      pass: pass.token,
      expires_at: new Date(pass.expiresAt * 1000).toISOString(),
      header: 'x-crawl-pass',
      use: `curl -H "x-crawl-pass: ${pass.token}" "${config.siteUrl}/f/everything.rss?disable=ads,tracking"`,
    });
  });

  app.get('/api/v1/collections', async (c) => {
    c.header('cache-control', 'public, max-age=120');
    return c.json({
      collections: (await q.listCollections()).map((x) => collectionOut(x, site())),
    });
  });
  app.get('/api/v1/adapters', (c) => c.json({ adapters: describeAdapters() }));
  app.get('/api/v1/enrichers', (c) => c.json({ enrichers: describeEnrichers() }));

  app.get('/api/v1/sources', async (c) => {
    const col = await collectionOrNull(c.req.query('collection'));
    return c.json({
      sources: (await q.listSources({ collectionId: col?.id ?? null })).map(sourceOut),
    });
  });
  app.get('/api/v1/sources/:slug', async (c) => {
    const s = await q.getSource(c.req.param('slug'));
    if (!s) return c.json({ error: 'not found' }, 404);
    return c.json({ source: sourceOut(s), runs: await q.listRuns(s.id, { limit: 10 }) });
  });
  app.post('/api/v1/sources', async (c) => {
    const user = requireUser(c);
    const body = await c.req.json();
    const s = await addSource(user, {
      adapter: body.adapter,
      collection: body.collection,
      name: body.name,
      config: body.config ?? {},
      cadenceMinutes: body.cadence_minutes,
    });
    await enqueueRun(s.id).catch(() => {});
    return c.json({ source: sourceOut(await q.getSource(s.slug)) }, 201);
  });
  app.patch('/api/v1/sources/:slug', async (c) => {
    const user = requireUser(c);
    const s = await q.getSource(c.req.param('slug'));
    if (!s) return c.json({ error: 'not found' }, 404);
    const body = await c.req.json();
    await editSource(user, s, {
      name: body.name,
      description: body.description,
      config: body.config,
      cadenceMinutes: body.cadence_minutes,
      enabled: body.enabled,
    });
    return c.json({ source: sourceOut(await q.getSource(s.slug)) });
  });
  app.delete('/api/v1/sources/:slug', async (c) => {
    const user = requireUser(c);
    const s = await q.getSource(c.req.param('slug'));
    if (!s) return c.json({ error: 'not found' }, 404);
    if (!canEditSource(user, s)) throw new Denied('Not your source.');
    await q.deleteSource(s.id);
    return c.json({ ok: true });
  });
  app.post('/api/v1/sources/:slug/run', async (c) => {
    const user = requireUser(c);
    const s = await q.getSource(c.req.param('slug'));
    if (!s) return c.json({ error: 'not found' }, 404);
    if (!canEditSource(user, s)) throw new Denied('Not your source.');
    await q.requestRun(s.id);
    await enqueueRun(s.id, { force: true }).catch(() => {});
    return c.json({ ok: true, queued: s.slug });
  });

  app.get('/api/v1/feeds', async (c) => {
    const col = await collectionOrNull(c.req.query('collection'));
    return c.json({
      feeds: (await q.listFeeds({ collectionId: col?.id ?? null })).map((f) => feedOut(f, site())),
    });
  });
  app.get('/api/v1/feeds/:slug', async (c) => {
    const f = await q.getFeed(c.req.param('slug'));
    if (!f || (!f.public && f.owner_id !== c.get('user')?.id))
      return c.json({ error: 'not found' }, 404);
    return c.json({ feed: feedOut(f, site()) });
  });
  app.get('/api/v1/feeds/:slug/items', async (c) => {
    const f = await q.getFeed(c.req.param('slug'));
    if (!f || (!f.public && f.owner_id !== c.get('user')?.id))
      return c.json({ error: 'not found' }, 404);
    const items = await q.feedItems(f, {
      limit: lim(c.req.query('limit'), 50, 200),
      beforeId: Number(c.req.query('before')) || null,
    });
    c.header('cache-control', 'public, max-age=60');
    return c.json({
      feed: feedOut(f, site()),
      count: items.length,
      items: items.map((i) => itemOut(i, site(), { enrichers: allowedEnrichers(f) })),
    });
  });
  app.post('/api/v1/feeds', async (c) => {
    const user = requireUser(c);
    const body = await c.req.json();
    const feed = await createFeed(user, {
      collection: body.collection,
      name: body.name,
      description: body.description,
      query: body,
      isPublic: body.public,
    });
    return c.json({ feed: feedOut(await q.getFeed(feed.slug), site()) }, 201);
  });
  app.patch('/api/v1/feeds/:slug', async (c) => {
    const user = requireUser(c);
    const f = await q.getFeed(c.req.param('slug'));
    if (!f) return c.json({ error: 'not found' }, 404);
    const body = await c.req.json();
    await editFeed(user, f, {
      name: body.name,
      description: body.description,
      query:
        body.query ??
        (body.sources ||
        body.kinds ||
        body.tags ||
        body.q !== undefined ||
        body.upcoming !== undefined
          ? body
          : undefined),
      isPublic: body.public,
    });
    return c.json({ feed: feedOut(await q.getFeed(f.slug), site()) });
  });
  app.delete('/api/v1/feeds/:slug', async (c) => {
    const user = requireUser(c);
    const f = await q.getFeed(c.req.param('slug'));
    if (!f) return c.json({ error: 'not found' }, 404);
    if (!(user.role === 'admin' || f.owner_id === user.id)) throw new Denied('Not your feed.');
    await q.deleteFeed(f.id);
    return c.json({ ok: true });
  });
  app.post('/api/v1/feeds/:slug/follow', async (c) => {
    const user = requireUser(c);
    const f = await q.getFeed(c.req.param('slug'));
    if (!f) return c.json({ error: 'not found' }, 404);
    const body = await c.req.json().catch(() => ({}));
    const channels = (body.channels ?? []).filter((x) =>
      ['webpush', 'email', 'webhook'].includes(x),
    );
    if (body.webhook_url && !/^https:\/\//.test(body.webhook_url))
      throw new Denied('Webhook URLs must be https.', 400);
    await q.followFeed({
      userId: user.id,
      feedId: f.id,
      channels: channels.length ? channels : undefined,
      webhookUrl: body.webhook_url ?? null,
      webhookSecret: body.webhook_secret ?? null,
    });
    return c.json({ ok: true });
  });
  app.delete('/api/v1/feeds/:slug/follow', async (c) => {
    const user = requireUser(c);
    const f = await q.getFeed(c.req.param('slug'));
    if (!f) return c.json({ error: 'not found' }, 404);
    await q.unfollowFeed({ userId: user.id, feedId: f.id });
    return c.json({ ok: true });
  });
  app.get('/api/v1/following', async (c) => {
    const user = requireUser(c);
    return c.json({ feeds: (await q.listFollows(user.id)).map((f) => feedOut(f, site())) });
  });

  app.get('/api/v1/items', async (c) => {
    const col = await collectionOrNull(c.req.query('collection'));
    const src = c.req.query('source') ? await q.getSource(c.req.query('source')) : null;
    if (c.req.query('source') && !src) return c.json({ error: 'no such source' }, 404);
    const when = (v) => {
      if (!v) return null;
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    };
    const sort = ['id', 'published', 'updated'].includes(c.req.query('sort'))
      ? c.req.query('sort')
      : 'id';
    const items = await q.recentItems({
      collectionId: col?.id ?? null,
      sourceId: src?.id ?? null,
      kind: c.req.query('kind') ?? null,
      // Facets a site's pages are made of: every tag named must be on the item.
      tags: (c.req.query('tags') ?? '').split(',').filter(Boolean),
      // When the thing happens, and when the row last changed.
      from: when(c.req.query('from')),
      to: when(c.req.query('to')),
      since: when(c.req.query('since')),
      sort,
      order: c.req.query('order') === 'asc' ? 'asc' : 'desc',
      limit: lim(c.req.query('limit'), 50, 200),
      beforeId: Number(c.req.query('before')) || null,
      afterId: Number(c.req.query('after')) || null,
    });
    // A mirror asking "what changed since" must not be handed a stale page.
    c.header('cache-control', c.req.query('since') ? 'no-store' : 'public, max-age=60');
    return c.json({ count: items.length, items: items.map((i) => itemOut(i, site())) });
  });
  app.get('/api/v1/match', async (c) => {
    // The enrichment question: which title, channel or fixture is this name?
    // A player asks it with a file name or a playlist entry; the name is
    // cleaned here so every caller matches the same way.
    const raw = (c.req.query('q') ?? '').trim();
    if (!raw) return c.json({ error: 'q is required' }, 400);
    const col = await collectionOrNull(c.req.query('collection'));
    const parsed = parseName(raw);
    const year = Number(c.req.query('year')) || parsed.year || null;
    const items = await q.matchItems(parsed.name, {
      collectionId: col?.id ?? null,
      kind: c.req.query('kind') ?? null,
      tags: (c.req.query('tags') ?? '').split(',').filter(Boolean),
      year,
      limit: lim(c.req.query('limit'), 5, 50),
    });
    c.header('cache-control', 'public, max-age=300');
    return c.json({
      q: raw,
      parsed: { ...parsed, year },
      count: items.length,
      items: items.map((i) => ({ ...itemOut(i, site()), score: Number(i.score) })),
    });
  });
  app.get('/api/v1/items/upcoming', async (c) => {
    const col = await collectionOrNull(c.req.query('collection'));
    const items = await q.upcomingItems({
      collectionId: col?.id ?? null,
      days: lim(c.req.query('days'), 30, 365),
      limit: lim(c.req.query('limit'), 100, 200),
    });
    c.header('cache-control', 'public, max-age=300');
    return c.json({ count: items.length, items: items.map((i) => itemOut(i, site())) });
  });
  app.get('/api/v1/items/:id', async (c) => {
    const item = await q.getItem(Number(c.req.param('id')));
    if (!item) return c.json({ error: 'not found' }, 404);
    c.header('cache-control', 'public, max-age=300');
    return c.json({ item: itemOut(item, site()) });
  });
  app.get('/api/v1/search', async (c) => {
    const term = (c.req.query('q') ?? '').trim();
    if (!term) return c.json({ error: 'q is required' }, 400);
    const col = await collectionOrNull(c.req.query('collection'));
    const items = await q.searchItems(term, {
      collectionId: col?.id ?? null,
      kind: c.req.query('kind') ?? null,
      limit: lim(c.req.query('limit'), 30, 100),
    });
    return c.json({ q: term, count: items.length, items: items.map((i) => itemOut(i, site())) });
  });
}
