import * as auth from '@nichedb/auth';
import { config } from '@nichedb/config';
import { adapterByName, describeAdapters } from '@nichedb/core';
import { sql } from '@nichedb/db';
import * as q from '@nichedb/db/queries';
import * as pay from '@nichedb/payments';
import { grantMembership, MEMBERSHIP_KIND } from '@nichedb/payments/membership';
import {
  buildReferralUrl,
  codeFor,
  priceFor,
  recordReferral,
  statsFor,
} from '@nichedb/payments/referrals';
import { enqueueRun } from '@nichedb/queue';
import {
  configFromForm,
  isProUser,
  many,
  render,
  requireUser,
  respond,
  setFlash,
  takeFlash,
} from '../lib/http.js';
import {
  addSource,
  canAddSources,
  canEditFeed,
  canEditSource,
  createFeed,
  Denied,
  editFeed,
  editSource,
  normaliseQuery,
} from '../lib/service.js';
import { FeedForm, FeedsPage, SourceForm, SourcePage, SourcesPage } from '../views/admin.jsx';
import { Settings } from '../views/pages.jsx';

/** Managing sources, feeds, follows, keys and the Pro purchase: the forms. */
export function registerManage(app) {
  /* ------------------------------------------------------------- sources -- */

  app.get('/sources', async (c) => {
    const user = c.get('user');
    const [sources, canAdd] = await Promise.all([q.listSources(), canAddSources(user)]);
    return c.html(
      await render(
        <SourcesPage
          user={user}
          sources={sources}
          adapters={describeAdapters()}
          canAdd={canAdd}
          notice={c.req.query('notice')}
          error={c.req.query('error')}
        />,
      ),
    );
  });

  app.get('/sources/new', async (c) => {
    const user = requireUser(c);
    if (!(await canAddSources(user)))
      throw new Denied('Adding a source needs an admin or Pro account here.');
    const adapter = c.req.query('adapter') ? adapterByName(c.req.query('adapter')) : null;
    return c.html(
      await render(
        <SourceForm
          user={user}
          adapters={describeAdapters()}
          adapter={adapter}
          collections={await q.listCollections()}
          error={c.req.query('error')}
        />,
      ),
    );
  });

  app.post('/sources/new', async (c) => {
    const user = requireUser(c);
    const body = await c.req.parseBody({ all: true });
    const adapter = adapterByName(String(body.adapter ?? ''));
    try {
      const s = await addSource(user, {
        adapter: body.adapter,
        collection: body.collection,
        name: body.name,
        config: configFromForm(body),
        cadenceMinutes: body.cadence_minutes,
      });
      await enqueueRun(s.id).catch(() => {});
      return respond(c, {
        json: { ok: true, slug: s.slug },
        redirectTo: `/s/${s.slug}`,
        notice: 'Source added. First fetch is queued.',
      });
    } catch (err) {
      if (!(err instanceof Denied)) throw err;
      return c.html(
        await render(
          <SourceForm
            user={user}
            adapters={describeAdapters()}
            adapter={adapter}
            collections={await q.listCollections()}
            values={{ ...body, config: configFromForm(body) }}
            error={err.message}
          />,
        ),
        400,
      );
    }
  });

  app.get('/s/:slug', async (c) => {
    const source = await q.getSource(c.req.param('slug'));
    if (!source) return c.notFound();
    const user = c.get('user');
    const [runs, items] = await Promise.all([
      q.listRuns(source.id, { limit: 15 }),
      q.recentItems({ sourceId: source.id, limit: 30 }),
    ]);
    return c.html(
      await render(
        <SourcePage
          user={user}
          source={source}
          adapter={adapterByName(source.adapter)}
          runs={runs}
          items={items}
          canEdit={canEditSource(user, source)}
          notice={c.req.query('notice')}
          error={c.req.query('error')}
        />,
      ),
    );
  });

  const withSource = (fn) => async (c) => {
    const user = requireUser(c);
    const source = await q.getSource(c.req.param('slug'));
    if (!source) return c.notFound();
    if (!canEditSource(user, source)) throw new Denied('Not your source.');
    return fn(c, user, source);
  };

  app.post(
    '/s/:slug/run',
    withSource(async (c, _user, source) => {
      await q.requestRun(source.id);
      await enqueueRun(source.id, { force: true }).catch(() => {});
      return respond(c, {
        redirectTo: `/s/${source.slug}`,
        notice: 'Fetch queued. Refresh in a moment.',
      });
    }),
  );
  app.post(
    '/s/:slug/toggle',
    withSource(async (c, user, source) => {
      await editSource(user, source, { enabled: !source.enabled });
      return respond(c, {
        redirectTo: `/s/${source.slug}`,
        notice: source.enabled ? 'Paused.' : 'Resumed; it will run on the next tick.',
      });
    }),
  );
  app.post(
    '/s/:slug/edit',
    withSource(async (c, user, source) => {
      const body = await c.req.parseBody({ all: true });
      await editSource(user, source, {
        name: body.name,
        config: configFromForm(body),
        cadenceMinutes: body.cadence_minutes,
      });
      return respond(c, { redirectTo: `/s/${source.slug}`, notice: 'Saved.' });
    }),
  );
  app.post(
    '/s/:slug/delete',
    withSource(async (c, _user, source) => {
      await q.deleteSource(source.id);
      return respond(c, { redirectTo: '/sources', notice: `Deleted ${source.name}.` });
    }),
  );

  /* --------------------------------------------------------------- feeds -- */

  app.get('/feeds', async (c) => {
    const user = c.get('user');
    const [feeds, mine] = await Promise.all([
      q.listFeeds(),
      user ? q.listFeeds({ ownerId: user.id, publicOnly: false }) : [],
    ]);
    return c.html(
      await render(
        <FeedsPage
          user={user}
          feeds={feeds}
          mine={mine}
          notice={c.req.query('notice')}
          error={c.req.query('error')}
        />,
      ),
    );
  });

  async function feedFormData(collectionSlug) {
    const collections = await q.listCollections();
    const collection = collections.find((x) => x.slug === collectionSlug) ?? collections[0];
    if (!collection) return { collections, collection: null, sources: [], kinds: [] };
    const [sources, kinds] = await Promise.all([
      q.listSources({ collectionId: collection.id }),
      q.kindsForCollection(collection.id),
    ]);
    return { collections, collection, sources, kinds };
  }

  app.get('/feeds/new', async (c) => {
    const user = requireUser(c);
    const qs = c.req.query();
    const values = {
      ...qs,
      sources: many(c.req.queries('sources')),
      kinds: many(c.req.queries('kinds')),
      tags: qs.tags,
      q: qs.q,
      upcoming: qs.upcoming === '1',
      public: qs.public ?? '1',
    };
    const data = await feedFormData(qs.collection);
    const preview = data.collection
      ? await q.feedItems(
          { collection_id: data.collection.id, query: normaliseQuery(values) },
          { limit: 15 },
        )
      : [];
    return c.html(
      await render(
        <FeedForm user={user} {...data} values={values} preview={preview} error={qs.error} />,
      ),
    );
  });

  app.post('/feeds/new', async (c) => {
    const user = requireUser(c);
    const body = await c.req.parseBody({ all: true });
    const values = {
      ...body,
      sources: many(body.sources),
      kinds: many(body.kinds),
      upcoming: body.upcoming === '1',
      public: body.public,
    };
    try {
      const feed = await createFeed(user, {
        collection: body.collection,
        name: body.name,
        description: body.description,
        query: values,
        isPublic: body.public === '1',
      });
      return respond(c, {
        json: { ok: true, slug: feed.slug },
        redirectTo: `/f/${feed.slug}`,
        notice: 'Feed created. Follow it to be told when it changes.',
      });
    } catch (err) {
      if (!(err instanceof Denied)) throw err;
      const data = await feedFormData(body.collection);
      return c.html(
        await render(<FeedForm user={user} {...data} values={values} error={err.message} />),
        400,
      );
    }
  });

  const withFeed = (fn) => async (c) => {
    const user = requireUser(c);
    const feed = await q.getFeed(c.req.param('slug'));
    if (!feed) return c.notFound();
    return fn(c, user, feed);
  };

  app.get(
    '/f/:slug/edit',
    withFeed(async (c, user, feed) => {
      if (!canEditFeed(user, feed)) throw new Denied('Not your feed.');
      const data = await feedFormData(feed.collection_slug);
      const fq = q.feedQuery(feed);
      const values = {
        name: feed.name,
        description: feed.description,
        ...fq,
        public: feed.public ? '1' : '0',
      };
      const preview = await q.feedItems(feed, { limit: 15 });
      return c.html(
        await render(
          <FeedForm
            user={user}
            {...data}
            values={values}
            editing={feed}
            preview={preview}
            error={c.req.query('error')}
          />,
        ),
      );
    }),
  );
  app.post(
    '/f/:slug/edit',
    withFeed(async (c, user, feed) => {
      const body = await c.req.parseBody({ all: true });
      await editFeed(user, feed, {
        name: body.name,
        description: body.description,
        query: {
          ...body,
          sources: many(body.sources),
          kinds: many(body.kinds),
          upcoming: body.upcoming === '1',
        },
        isPublic: body.public === '1',
      });
      return respond(c, { redirectTo: `/f/${feed.slug}`, notice: 'Saved.' });
    }),
  );
  app.post(
    '/f/:slug/delete',
    withFeed(async (c, user, feed) => {
      if (!canEditFeed(user, feed)) throw new Denied('Not your feed.');
      await q.deleteFeed(feed.id);
      return respond(c, { redirectTo: '/feeds', notice: `Deleted ${feed.name}.` });
    }),
  );
  app.post(
    '/f/:slug/follow',
    withFeed(async (c, user, feed) => {
      const body = await c.req.parseBody({ all: true }).catch(() => ({}));
      const channels = many(body.channels).filter((x) =>
        ['webpush', 'email', 'webhook'].includes(x),
      );
      const webhookUrl = body.webhook_url ? String(body.webhook_url).trim() : null;
      if (webhookUrl && !/^https:\/\//.test(webhookUrl))
        throw new Denied('Webhook URLs must be https.', 400);
      await q.followFeed({
        userId: user.id,
        feedId: feed.id,
        channels: channels.length ? channels : undefined,
        webhookUrl,
        webhookSecret: body.webhook_secret ? String(body.webhook_secret) : null,
      });
      return respond(c, { redirectTo: `/f/${feed.slug}`, notice: 'Following.' });
    }),
  );
  app.post(
    '/f/:slug/unfollow',
    withFeed(async (c, user, feed) => {
      await q.unfollowFeed({ userId: user.id, feedId: feed.id });
      return respond(c, { redirectTo: `/f/${feed.slug}`, notice: 'Unfollowed.' });
    }),
  );

  /* ------------------------------------------------------------ settings -- */

  app.get('/settings', async (c) => {
    const user = requireUser(c);
    const [passkeys, apiKeys, pro, terms, newKey] = await Promise.all([
      q.listPasskeys(user.id),
      auth.listApiKeys(user.id),
      isProUser(user),
      q.membershipTerms(user.id, { limit: 3 }),
      takeFlash(c),
    ]);
    let referral = null;
    try {
      const code = await codeFor(sql, user.id);
      referral = {
        code,
        url: buildReferralUrl(`${config.siteUrl}/signup`, code),
        stats: await statsFor(sql, user.id),
      };
    } catch (err) {
      console.error('[referral]', err.message);
    }
    return c.html(
      await render(
        <Settings
          user={user}
          passkeys={passkeys}
          apiKeys={apiKeys}
          newKey={newKey}
          pro={pro}
          terms={terms}
          referral={referral}
          vapidKey={config.push.publicKey || null}
          notice={c.req.query('notice')}
          error={c.req.query('error')}
        />,
      ),
    );
  });

  app.post('/api/keys', async (c) => {
    const user = requireUser(c);
    const body = await c.req.parseBody();
    const made = await auth.createApiKey({
      userId: user.id,
      name: String(body.name ?? '')
        .trim()
        .slice(0, 60),
    });
    await setFlash(c, made.key);
    return respond(c, { json: { ok: true, key: made.key, id: made.id }, redirectTo: '/settings' });
  });
  app.post('/api/keys/:id/revoke', async (c) => {
    const user = requireUser(c);
    await auth.revokeApiKey({ userId: user.id, id: c.req.param('id') });
    return respond(c, { redirectTo: '/settings', notice: 'Key revoked.' });
  });
  app.post('/api/profile', async (c) => {
    const user = requireUser(c);
    const body = await c.req.parseBody();
    await q.updateProfile({
      userId: user.id,
      displayName: String(body.display_name ?? '')
        .trim()
        .slice(0, 60),
    });
    if (body.timezone) {
      try {
        Intl.DateTimeFormat(undefined, { timeZone: String(body.timezone) });
        await q.setUserTimezone(user.id, String(body.timezone));
      } catch {}
    }
    return respond(c, { redirectTo: '/settings', notice: 'Saved.' });
  });

  /* ----------------------------------------------------------------- pro -- */

  app.post('/api/membership/buy', async (c) => {
    const user = requireUser(c);
    if (!config.membership.enabled)
      throw new Denied('Payments are not configured on this deployment.', 400);
    const price = await priceFor(sql, {
      userId: user.id,
      referredBy: user.referred_by,
      amountCents: config.membership.priceCents,
    });
    const { checkoutUrl } = await pay.createCheckout({
      user,
      amountCents: price.amountCents,
      currency: config.membership.currency,
      description: `${config.siteName} Pro, ${config.membership.termDays} days`,
      metadata: {
        kind: MEMBERSHIP_KIND,
        referral_code: price.code ?? '',
        list_price_cents: String(config.membership.priceCents),
      },
      blockchain: config.payments.blockchain,
    });
    return respond(c, { json: { checkoutUrl }, redirectTo: checkoutUrl });
  });

  app.post('/api/webhooks/coinpay', async (c) => {
    const rawBody = await c.req.text();
    const ok = pay.verifyWebhook({ rawBody, signatureHeader: c.req.header('x-coinpay-signature') });
    if (!ok) return c.json({ error: 'bad signature' }, 401);
    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return c.json({ error: 'bad json' }, 400);
    }
    const result = await pay.settleWebhook(payload, {
      grant: async (tx, { meta, payment }) => {
        if (meta.kind !== MEMBERSHIP_KIND) return null;
        const term = await grantMembership(tx, {
          userId: meta.user_id,
          paymentId: payment.id,
          priceCents: payment.amount_cents,
          currency: payment.currency,
          termDays: config.membership.termDays,
        });
        if (meta.referral_code) {
          await recordReferral(tx, {
            code: meta.referral_code,
            newUserId: meta.user_id,
            amountCents: payment.amount_cents,
          });
        }
        return term;
      },
    });
    return c.json(result);
  });
}
