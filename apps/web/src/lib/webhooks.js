import { config } from '@nichedb/config';
import * as q from '@nichedb/db/queries';
import { emitSafely, feedRef, hooks, syncFollowEndpoint } from '@nichedb/notify/webhooks';
import { WebhookError, webhooksApi } from '@profullstack/webhooks';
import { Denied } from './service.js';

/**
 * The web half of webhooks: following a feed (which keeps a follow's own
 * webhook in step with the hub), the /api/v1/webhooks API, and the events the
 * web process emits. The worker emits feed.item.published itself.
 */

export { hooks };

/** A WebhookError (bad URL, unknown event, not yours) as the app's own Denied. */
export async function hookCall(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof WebhookError) throw new Denied(err.message, err.status);
    throw err;
  }
}

/**
 * Follow a feed (or change how), from the page, the API or MCP. A follow's
 * webhook URL must be https and public, checked here when it is saved and
 * again by the hub before every delivery.
 */
export async function follow(user, feed, { channels, webhookUrl = null, webhookSecret = null }) {
  if (webhookUrl) {
    if (!/^https:\/\//.test(webhookUrl)) throw new Denied('Webhook URLs must be https.', 400);
    await hookCall(() => hooks.validUrl(webhookUrl));
  }
  const before = await q.getFollow({ userId: user.id, feedId: feed.id });
  await q.followFeed({
    userId: user.id,
    feedId: feed.id,
    channels: channels?.length ? channels : undefined,
    webhookUrl,
    webhookSecret,
  });
  const row = await q.getFollow({ userId: user.id, feedId: feed.id });
  await syncFollowEndpoint(hooks, {
    userId: user.id,
    feedId: feed.id,
    feedSlug: feed.slug,
    follow: row,
  });
  if (!before)
    await emitSafely(
      user.id,
      'feed.followed',
      { feed: feedRef(feed, config.siteUrl), channels: row?.channels ?? [] },
      { subject: `feed:${feed.slug}` },
    );
  return row;
}

export async function unfollow(user, feed) {
  const before = await q.getFollow({ userId: user.id, feedId: feed.id });
  await q.unfollowFeed({ userId: user.id, feedId: feed.id });
  await syncFollowEndpoint(hooks, { userId: user.id, feedId: feed.id, follow: null });
  if (before)
    await emitSafely(
      user.id,
      'feed.unfollowed',
      { feed: feedRef(feed, config.siteUrl) },
      { subject: `feed:${feed.slug}` },
    );
}

export const feedCreated = (feed) =>
  emitSafely(
    feed.owner_id,
    'feed.created',
    { feed: { ...feedRef(feed, config.siteUrl), public: feed.public ?? null } },
    { subject: `feed:${feed.slug}` },
  );

export const feedDeleted = (feed) =>
  emitSafely(
    feed.owner_id,
    'feed.deleted',
    { feed: feedRef(feed, config.siteUrl) },
    { subject: `feed:${feed.slug}` },
  );

/** The person who suggested a feed hears how it went, if they have an endpoint. */
export const submissionDecided = (sub, { approved, resultUrl = null, note = null }) =>
  emitSafely(
    sub.user_id,
    approved ? 'submission.approved' : 'submission.rejected',
    { submission: { id: sub.id, feed_url: sub.feed_url, note, result_url: resultUrl } },
    { subject: `submission:${sub.id}` },
  );

/**
 * /api/v1/webhooks, the package's own routes, scoped to the API key's account.
 * Keys only: a browser session manages webhooks at /settings#webhooks, so a
 * cross-site page can never drive this API with someone's cookie.
 */
export function mountWebhooksApi(app, { hub = hooks } = {}) {
  const ownerOf = new WeakMap();
  const api = webhooksApi(hub, {
    basePath: '/api/v1/webhooks',
    owner: (req) => ownerOf.get(req) ?? null,
  });
  const route = async (c) => {
    const user = c.get('viaKey') ? c.get('user') : null;
    if (user) ownerOf.set(c.req.raw, String(user.id));
    return (await api(c.req.raw)) ?? c.json({ error: 'not found' }, 404);
  };
  app.all('/api/v1/webhooks', route);
  app.all('/api/v1/webhooks/*', route);
}
