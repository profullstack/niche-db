import { matchesEvent, Webhooks } from '@profullstack/webhooks';

/**
 * Webhooks through @profullstack/webhooks: the pure half, with no database
 * import, so a test can build a hub on PGlite or memoryStore().
 *
 * Two kinds of endpoint share one store:
 *
 *  - Account endpoints, owned by users.id, made at /settings or
 *    /api/v1/webhooks with a generated whsec_ secret. They get the events in
 *    EVENT_TYPES as plain Standard Webhooks + CloudEvents.
 *
 *  - Follow webhooks: the webhook_url + webhook_secret a person set on one
 *    follow. Each is mirrored into an endpoint of its own (owner
 *    `follow:<user>:<feed>`), so it only ever receives that feed's items, and
 *    it keeps the exact wire format @profullstack/autoblog sent before: the
 *    `<reverse host>.post.published.v1` envelope with `data.post`,
 *    `Authorization: Bearer <secret>`, and an HMAC keyed with the whole secret
 *    string. Receivers on autoblog's verifyAndParse keep working untouched.
 */

/** What an account endpoint can subscribe to. */
export const EVENT_TYPES = [
  'feed.item.published',
  'feed.followed',
  'feed.unfollowed',
  'feed.created',
  'feed.deleted',
  'submission.approved',
  'submission.rejected',
];

const FOLLOW_ID_PREFIX = 'whf_';

export const followEndpointId = (userId, feedId) =>
  `${FOLLOW_ID_PREFIX}${feedId}_${String(userId).replace(/-/g, '')}`;
export const followOwner = (userId, feedId) => `follow:${userId}:${feedId}`;
export const isFollowEndpoint = (endpoint) =>
  String(endpoint?.id ?? '').startsWith(FOLLOW_ID_PREFIX);

/**
 * A follow's secret as the hub stores it: whsec_ + base64 of the string. The
 * package decodes that back to the same bytes autoblog keyed its HMAC with, so
 * a secret that itself starts "whsec_" signs exactly as it always did instead
 * of being base64-decoded into a different key.
 */
export const encodeFollowSecret = (secret) =>
  `whsec_${Buffer.from(String(secret), 'utf8').toString('base64')}`;
export const decodeFollowSecret = (stored) =>
  Buffer.from(String(stored).slice('whsec_'.length), 'base64').toString('utf8');

/** autoblog's event type for this site: nichedb.dev -> dev.nichedb.post.published.v1. */
export function legacyEventType(siteUrl) {
  let host = 'unknown';
  try {
    host = new URL(siteUrl).hostname
      .replace(/^www\./, '')
      .split('.')
      .reverse()
      .join('.');
  } catch {}
  return `${host}.post.published.v1`;
}

const iso = (d) => (d ? new Date(d).toISOString() : null);

/** The `post` a follow webhook has always carried for one item. */
export function legacyPost(feed, it, siteUrl) {
  return {
    id: `item_${it.id}`,
    url: it.url ?? `${siteUrl}/i/${it.id}`,
    title: it.title,
    slug: `${feed.slug}/${it.id}`,
    html: it.summary ? `<p>${String(it.summary).replace(/</g, '&lt;')}</p>` : '',
    status: 'published',
    published_at: iso(it.published_at ?? it.first_seen_at),
    updated_at: iso(it.updated_at ?? it.first_seen_at),
    tags: it.tags ?? [],
    categories: [feed.collection_slug, it.kind].filter(Boolean),
    _nichedb: { feed: feed.slug, source: it.source_slug, kind: it.kind, data: it.data },
  };
}

export const feedRef = (feed, siteUrl) => ({
  slug: feed.slug,
  name: feed.name,
  collection: feed.collection_slug ?? null,
  url: `${siteUrl}/f/${feed.slug}`,
});

/** One item as an account endpoint's feed.item.published carries it. */
export const itemRef = (it, siteUrl) => ({
  id: Number(it.id),
  title: it.title,
  url: it.url ?? null,
  page: `${siteUrl}/i/${it.id}`,
  summary: it.summary ?? null,
  kind: it.kind ?? null,
  source: it.source_slug ?? null,
  tags: it.tags ?? [],
  published_at: iso(it.published_at ?? it.first_seen_at),
  updated_at: iso(it.updated_at ?? it.first_seen_at),
  data: it.data ?? null,
});

/**
 * The hub. Follow endpoints get autoblog's Bearer header and user agent next
 * to the Standard Webhooks headers; account endpoints get only the standard
 * ones.
 */
export function createHub({ store, siteUrl, ...options }) {
  const hub = new Webhooks({
    store,
    source: siteUrl,
    eventTypes: EVENT_TYPES,
    extraHeaders: ({ secret, endpoint }) =>
      isFollowEndpoint(endpoint)
        ? {
            authorization: `Bearer ${decodeFollowSecret(secret)}`,
            'user-agent': `niche-db/0.1 (+${siteUrl})`,
          }
        : {},
    ...options,
  });
  hub.siteUrl = siteUrl;
  return hub;
}

/**
 * Make a follow's endpoint match the follow: there when the follow has the
 * webhook channel, a URL and a secret; gone otherwise. Saving a follow turns
 * its endpoint back on and clears its failure count, like re-enabling one.
 */
export async function syncFollowEndpoint(hub, { userId, feedId, feedSlug, follow }) {
  const id = followEndpointId(userId, feedId);
  const existing = await hub.store.getEndpoint(id);
  const wanted =
    follow?.channels?.includes('webhook') && follow.webhook_url && follow.webhook_secret;
  if (!wanted) {
    if (existing) await hub.store.deleteEndpoint(id);
    return null;
  }
  const at = hub.now();
  const fields = {
    url: follow.webhook_url,
    secret: await hub.seal(encodeFollowSecret(follow.webhook_secret)),
    events: ['*'],
    description: `follow of ${feedSlug ?? feedId}`.slice(0, 200),
    enabled: true,
    failures: 0,
    disabledReason: null,
    updatedAt: at,
  };
  if (existing) await hub.store.updateEndpoint(id, fields);
  else
    await hub.store.insertEndpoint({
      id,
      owner: followOwner(userId, feedId),
      ...fields,
      createdAt: at,
    });
  return id;
}

/**
 * One follow's new items, one event each, to that follow's endpoint. The
 * endpoint is recreated from the follow when it is missing (a follow saved by
 * an older build), so nothing is dropped. Returns how many were queued.
 */
export async function emitFollowItems(hub, { target, feed, items }) {
  const owner = followOwner(target.user_id, feed.id);
  if (!(await hub.store.getEndpoint(followEndpointId(target.user_id, feed.id))))
    await syncFollowEndpoint(hub, {
      userId: target.user_id,
      feedId: feed.id,
      feedSlug: feed.slug,
      follow: target,
    });
  const type = legacyEventType(hub.siteUrl);
  let queued = 0;
  for (const it of items) {
    const post = legacyPost(feed, it, hub.siteUrl);
    queued += (await hub.emit(owner, type, { post }, { subject: `post:${post.id}` })).queued;
  }
  return queued;
}

/** Whether an account has an enabled endpoint that wants `type`. */
export async function wants(hub, owner, type) {
  return (await hub.store.listEndpoints(String(owner))).some(
    (e) => e.enabled && matchesEvent(e.events, type),
  );
}

/** feed.item.published to an account's own endpoints, one event per item. */
export async function emitFeedItems(hub, { userId, feed, items }) {
  let queued = 0;
  for (const it of items)
    queued += (
      await hub.emit(
        String(userId),
        'feed.item.published',
        { feed: feedRef(feed, hub.siteUrl), item: itemRef(it, hub.siteUrl) },
        { subject: `item:${it.id}` },
      )
    ).queued;
  return queued;
}
