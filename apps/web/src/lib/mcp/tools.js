import { config } from '@nichedb/config';
import { describeAdapters, describeEnrichers } from '@nichedb/core';
import * as q from '@nichedb/db/queries';
import { enqueueRun } from '@nichedb/queue';
import { allowedEnrichers, collectionOut, feedOut, itemOut, sourceOut } from '../serialize.js';
import { addSource, createFeed, Denied, editSource } from '../service.js';

/**
 * Every MCP tool, in the order they are worth learning. This array is the
 * single source of truth: tools/list is rendered from it and so is /docs/mcp.
 *
 * `run(args, ctx)` returns a JSON-serialisable value. Throw `toolError(msg)`
 * for "asked for something that is not there" -- that comes back as an
 * isError result the model can act on, not a transport failure.
 */
const toolError = (message) => Object.assign(new Error(message), { toolError: true });
const site = () => config.siteUrl;

function needUser(ctx) {
  if (!ctx.user)
    throw toolError(
      'This tool needs an API key: send Authorization: Bearer ndb_… (make one at /settings).',
    );
  return ctx.user;
}

const str = (d) => ({ type: 'string', description: d });
const int = (d) => ({ type: 'integer', description: d });
const list = (d) => ({ type: 'array', items: { type: 'string' }, description: d });

export const TOOLS = [
  {
    name: 'stats',
    description:
      'What this deployment holds: collections, sources, items, items added today, feeds.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => q.siteStats(),
  },
  {
    name: 'list_collections',
    description: 'The collections (niches) with their source, feed and item counts.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => (await q.listCollections()).map((c) => collectionOut(c, site())),
  },
  {
    name: 'list_adapters',
    description:
      'Every adapter this deployment can run, with the config fields each takes. Use before add_source.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => describeAdapters(),
  },
  {
    name: 'list_enrichers',
    description:
      'Every enricher (YouTube videos, Wikipedia, repo stats, downloads, company profiles, TL;DRs) and which collections turn it on by default. Items carry their results under `enrichment`.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => describeEnrichers(),
  },
  {
    name: 'list_sources',
    description: 'Sources with status, last run and item counts. Optionally one collection.',
    inputSchema: { type: 'object', properties: { collection: str('Collection slug, e.g. games') } },
    run: async ({ collection }) => {
      const col = collection ? await q.getCollection(collection) : null;
      if (collection && !col) throw toolError(`No collection named ${collection}`);
      return (await q.listSources({ collectionId: col?.id ?? null })).map(sourceOut);
    },
  },
  {
    name: 'list_feeds',
    description: 'Public feeds, most followed first. Optionally one collection.',
    inputSchema: { type: 'object', properties: { collection: str('Collection slug') } },
    run: async ({ collection }) => {
      const col = collection ? await q.getCollection(collection) : null;
      if (collection && !col) throw toolError(`No collection named ${collection}`);
      return (await q.listFeeds({ collectionId: col?.id ?? null })).map((f) => feedOut(f, site()));
    },
  },
  {
    name: 'feed_items',
    description: 'What a feed selects, newest first. Page with before_id.',
    inputSchema: {
      type: 'object',
      properties: {
        feed: str('Feed slug'),
        limit: int('Default 30, max 200'),
        before_id: int('Keyset cursor'),
      },
      required: ['feed'],
    },
    run: async ({ feed, limit, before_id }) => {
      const f = await q.getFeed(String(feed));
      if (!f) throw toolError(`No feed named ${feed}`);
      const items = await q.feedItems(f, {
        limit: Math.min(Number(limit) || 30, 200),
        beforeId: before_id ?? null,
      });
      return {
        feed: feedOut(f, site()),
        items: items.map((i) => itemOut(i, site(), { enrichers: allowedEnrichers(f) })),
      };
    },
  },
  {
    name: 'recent_items',
    description: 'Newest items, optionally narrowed to a collection, source or kind.',
    inputSchema: {
      type: 'object',
      properties: {
        collection: str('Collection slug'),
        source: str('Source slug'),
        kind: str('Item kind'),
        limit: int('Default 30, max 200'),
        before_id: int('Keyset cursor'),
      },
    },
    run: async ({ collection, source, kind, limit, before_id }) => {
      const col = collection ? await q.getCollection(collection) : null;
      if (collection && !col) throw toolError(`No collection named ${collection}`);
      const src = source ? await q.getSource(source) : null;
      if (source && !src) throw toolError(`No source named ${source}`);
      const items = await q.recentItems({
        collectionId: col?.id ?? null,
        sourceId: src?.id ?? null,
        kind: kind ?? null,
        limit: Math.min(Number(limit) || 30, 200),
        beforeId: before_id ?? null,
      });
      return items.map((i) => itemOut(i, site()));
    },
  },
  {
    name: 'upcoming',
    description: 'Items dated in the future (releases, launches, deadlines), soonest first.',
    inputSchema: {
      type: 'object',
      properties: {
        collection: str('Collection slug'),
        days: int('Horizon, default 30'),
        limit: int('Default 50'),
      },
    },
    run: async ({ collection, days, limit }) => {
      const col = collection ? await q.getCollection(collection) : null;
      if (collection && !col) throw toolError(`No collection named ${collection}`);
      const items = await q.upcomingItems({
        collectionId: col?.id ?? null,
        days: Number(days) || 30,
        limit: Math.min(Number(limit) || 50, 200),
      });
      return items.map((i) => itemOut(i, site()));
    },
  },
  {
    name: 'search_items',
    description:
      'Full-text search over titles, summaries and tags. Use this first when you know a name.',
    inputSchema: {
      type: 'object',
      properties: {
        q: str('Query'),
        collection: str('Collection slug'),
        kind: str('Item kind'),
        limit: int('Default 20, max 100'),
      },
      required: ['q'],
    },
    run: async ({ q: term, collection, kind, limit }) => {
      const col = collection ? await q.getCollection(collection) : null;
      if (collection && !col) throw toolError(`No collection named ${collection}`);
      const items = await q.searchItems(String(term), {
        collectionId: col?.id ?? null,
        kind: kind ?? null,
        limit: Math.min(Number(limit) || 20, 100),
      });
      return items.map((i) => itemOut(i, site()));
    },
  },
  {
    name: 'get_item',
    description: 'One item with its full adapter payload.',
    inputSchema: { type: 'object', properties: { id: int('Item id') }, required: ['id'] },
    run: async ({ id }) => {
      const item = await q.getItem(Number(id));
      if (!item) throw toolError(`No item ${id}`);
      return itemOut(item, site());
    },
  },
  {
    name: 'create_feed',
    description:
      'Save a query as a feed (needs a key). Sources, kinds and tags narrow; q is a text match; upcoming keeps only future-dated items.',
    inputSchema: {
      type: 'object',
      properties: {
        collection: str('Collection slug'),
        name: str('Feed name'),
        description: str('Optional'),
        sources: list('Source slugs'),
        kinds: list('Item kinds'),
        tags: list('Tags, any match'),
        q: str('Text match'),
        upcoming: { type: 'boolean' },
        enrichers: list('Enrichers to show; omit for the collection defaults'),
        public: { type: 'boolean', description: 'Default true' },
      },
      required: ['collection', 'name'],
    },
    run: async (args, ctx) => {
      const user = needUser(ctx);
      const feed = await createFeed(user, {
        collection: args.collection,
        name: args.name,
        description: args.description,
        query: {
          sources: args.sources,
          kinds: args.kinds,
          tags: args.tags,
          q: args.q,
          upcoming: args.upcoming,
          enrichers: args.enrichers,
        },
        isPublic: args.public,
      });
      return feedOut(await q.getFeed(feed.slug), site());
    },
  },
  {
    name: 'follow_feed',
    description: 'Follow a feed as the key owner (needs a key). Channels: webpush, email, webhook.',
    inputSchema: {
      type: 'object',
      properties: {
        feed: str('Feed slug'),
        channels: list('Default webpush,email'),
        webhook_url: str('For the webhook channel'),
        webhook_secret: str('Shared secret the receiver verifies with'),
      },
      required: ['feed'],
    },
    run: async ({ feed, channels, webhook_url, webhook_secret }, ctx) => {
      const user = needUser(ctx);
      const f = await q.getFeed(String(feed));
      if (!f) throw toolError(`No feed named ${feed}`);
      await q.followFeed({
        userId: user.id,
        feedId: f.id,
        channels,
        webhookUrl: webhook_url ?? null,
        webhookSecret: webhook_secret ?? null,
      });
      return { ok: true, feed: feedOut(await q.getFeed(f.slug), site()) };
    },
  },
  {
    name: 'add_source',
    description:
      'Add a source: an adapter with a config, fetched on a schedule (needs a key; admins and Pro). Call list_adapters first for the fields.',
    inputSchema: {
      type: 'object',
      properties: {
        adapter: str('Adapter name, e.g. github-releases'),
        collection: str("Collection slug; defaults to the adapter's"),
        name: str('Display name'),
        config: { type: 'object', description: 'Adapter config fields' },
        cadence_minutes: int('5 to 1440'),
      },
      required: ['adapter'],
    },
    run: async (args, ctx) => {
      const user = needUser(ctx);
      const s = await addSource(user, {
        adapter: args.adapter,
        collection: args.collection,
        name: args.name,
        config: args.config ?? {},
        cadenceMinutes: args.cadence_minutes,
      });
      await enqueueRun(s.id).catch(() => {});
      return sourceOut(await q.getSource(s.slug));
    },
  },
  {
    name: 'run_source',
    description:
      'Fetch a source now instead of waiting for its schedule (needs a key; owner or admin).',
    inputSchema: {
      type: 'object',
      properties: { source: str('Source slug') },
      required: ['source'],
    },
    run: async ({ source }, ctx) => {
      const user = needUser(ctx);
      const s = await q.getSource(String(source));
      if (!s) throw toolError(`No source named ${source}`);
      await editSource(user, s, {}); // permission check
      await q.requestRun(s.id);
      await enqueueRun(s.id, { force: true }).catch(() => {});
      return { ok: true, source: s.slug };
    },
  },
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export const describe = (t) => ({
  name: t.name,
  description: t.description,
  inputSchema: t.inputSchema,
});

/** Turn a Denied into a tool error so the model sees why. */
export async function runTool(tool, args, ctx) {
  try {
    return await tool.run(args ?? {}, ctx);
  } catch (err) {
    if (err instanceof Denied) throw toolError(err.message);
    throw err;
  }
}
