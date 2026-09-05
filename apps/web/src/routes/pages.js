import { config } from '@nichedb/config';
import * as q from '@nichedb/db/queries';
import { feedAd } from '../lib/ads.js';
import { cached, isProUser, render, requireUser } from '../lib/http.js';
import { currentModules } from '../lib/modules.js';
import { buildJsonFeed, buildRss } from '../lib/rss.js';
import { allowedEnrichers } from '../lib/serialize.js';
import { canEditFeed } from '../lib/service.js';
import {
  About,
  CollectionPage,
  FeedPage,
  Following,
  ItemPage,
  Landing,
  SearchPage,
} from '../views/pages.jsx';

export function registerPages(app) {
  app.get('/', async (c) =>
    cached(c, 'home', async () => {
      const [stats, collections, latest, feeds] = await Promise.all([
        q.siteStats(),
        q.listCollections(),
        q.recentItems({ limit: 30 }),
        q.listFeeds(),
      ]);
      return render(
        <Landing
          user={c.get('user')}
          stats={stats}
          collections={collections}
          latest={latest}
          feeds={feeds}
        />,
      );
    }),
  );

  app.get('/c/:slug', async (c) => {
    const collection = await q.getCollection(c.req.param('slug'));
    if (!collection) return c.notFound();
    const tag = c.req.query('tag') ?? null;
    const kind = c.req.query('kind') ?? null;
    const before = Number(c.req.query('before')) || null;
    const key = `c:${collection.slug}:${tag ?? ''}:${kind ?? ''}:${before ?? ''}`;
    return cached(c, key, async () => {
      const pseudo = {
        collection_id: collection.id,
        query: { tags: tag ? [tag] : [], kinds: kind ? [kind] : [] },
      };
      const [stats, sources, feeds, latest, upcoming, kinds, tags] = await Promise.all([
        q.collectionStats(collection.id),
        q.listSources({ collectionId: collection.id }),
        q.listFeeds({ collectionId: collection.id }),
        q.feedItems(pseudo, { limit: 50, beforeId: before }),
        before || tag || kind
          ? []
          : q.upcomingItems({ collectionId: collection.id, days: 14, limit: 8 }),
        q.kindsForCollection(collection.id),
        q.topTags(collection.id),
      ]);
      return render(
        <CollectionPage
          user={c.get('user')}
          collection={collection}
          stats={stats}
          sources={sources}
          feeds={feeds}
          latest={latest}
          upcoming={upcoming}
          kinds={kinds}
          tags={tags}
          tag={tag}
          kind={kind}
        />,
      );
    });
  });

  /** A feed page, or its RSS / JSON Feed rendering by extension. */
  app.get('/f/:slug', async (c) => {
    const raw = c.req.param('slug');
    const m = raw.match(/^(.+)\.(rss|xml|json)$/);
    const slug = m ? m[1] : raw;
    const feed =
      slug === 'everything'
        ? {
            id: 0,
            slug: 'everything',
            name: `${config.siteName}: everything`,
            collection_slug: null,
            query: {},
            public: true,
            follower_count: 0,
          }
        : await q.getFeed(slug);
    if (!feed) return c.notFound();
    const user = c.get('user');
    if (!feed.public && !canEditFeed(user, feed)) return c.notFound();
    const before = Number(c.req.query('before')) || null;
    const items =
      feed.id === 0
        ? await q.recentItems({ limit: 100, beforeId: before })
        : await q.feedItems(feed, { limit: m ? 100 : 50, beforeId: before });

    if (m) {
      // A free feed carries one sponsored item at the top; Pro and paid
      // readers that switched ads off get the items alone.
      const ad = currentModules().ads ? await feedAd() : null;
      const args = {
        title: feed.name,
        link: `${config.siteUrl}/f/${feed.slug}`,
        description: feed.description,
        selfUrl: `${config.siteUrl}/f/${feed.slug}.${m[2]}`,
        items: ad ? [ad, ...items] : items,
        siteUrl: config.siteUrl,
      };
      c.header('cache-control', 'public, max-age=300');
      if (m[2] === 'json') {
        c.header('content-type', 'application/feed+json; charset=utf-8');
        return c.body(JSON.stringify(buildJsonFeed(args), null, 2));
      }
      c.header('content-type', 'application/rss+xml; charset=utf-8');
      return c.body(buildRss(args));
    }
    if (feed.id === 0) return c.redirect('/', 303);

    const key = `f:${feed.slug}:${before ?? ''}`;
    return cached(c, key, async () => {
      const following = user ? await q.isFollowing({ userId: user.id, feedId: feed.id }) : false;
      const follow = following ? await q.getFollow({ userId: user.id, feedId: feed.id }) : null;
      return render(
        <FeedPage
          user={user}
          feed={feed}
          items={items}
          following={following}
          follow={follow}
          canEdit={canEditFeed(user, feed)}
          query={q.feedQuery(feed)}
          enrichers={allowedEnrichers(feed)}
          notice={c.req.query('notice')}
          error={c.req.query('error')}
        />,
      );
    });
  });

  app.get('/i/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.notFound();
    const item = await q.getItem(id);
    if (!item) return c.notFound();
    return cached(
      c,
      `i:${id}`,
      () =>
        render(
          <ItemPage
            user={c.get('user')}
            item={item}
            enrichers={allowedEnrichers({ collection_slug: item.collection_slug })}
          />,
        ),
      600,
    );
  });

  app.get('/search', async (c) => {
    const term = (c.req.query('q') ?? '').trim().slice(0, 200);
    const collectionSlug = c.req.query('collection') || null;
    const collections = await q.listCollections();
    const col = collectionSlug ? collections.find((x) => x.slug === collectionSlug) : null;
    const results = term
      ? await q.searchItems(term, { collectionId: col?.id ?? null, limit: 50 })
      : [];
    return c.html(
      await render(
        <SearchPage
          user={c.get('user')}
          q={term}
          results={results}
          collections={collections}
          collection={collectionSlug}
        />,
      ),
    );
  });

  app.get('/following', async (c) => {
    const user = requireUser(c);
    const [follows, items] = await Promise.all([q.listFollows(user.id), q.followedItems(user.id)]);
    return c.html(await render(<Following user={user} follows={follows} items={items} />));
  });

  app.get('/about', async (c) =>
    c.html(await render(<About user={c.get('user')} stats={await q.siteStats()} />)),
  );

  app.get('/pro', async (c) => {
    const { ProPage } = await import('../views/pages.jsx');
    const { priceFor } = await import('@nichedb/payments/referrals');
    const { sql } = await import('@nichedb/db');
    const user = c.get('user');
    const price = user
      ? await priceFor(sql, {
          userId: user.id,
          referredBy: user.referred_by,
          amountCents: config.membership.priceCents,
        })
      : { amountCents: config.membership.priceCents, discountCents: 0 };
    return c.html(
      await render(
        <ProPage
          user={user}
          pro={await isProUser(user)}
          enabled={config.membership.enabled}
          price={price}
          notice={c.req.query('notice')}
          error={c.req.query('error')}
        />,
      ),
    );
  });
}
