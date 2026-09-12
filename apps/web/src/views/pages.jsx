import { config } from '@nichedb/config';
import {
  FeedCard,
  ItemList,
  Notice,
  Num,
  Pager,
  Relative,
  Status,
  Tags,
  When,
} from './components.jsx';
import { EnrichmentBlocks } from './enrichment.jsx';
import { Layout } from './Layout.jsx';
import { AwardForm, AwardPills, PlanBadge } from './premium.jsx';

export const Landing = ({ user, stats, collections, latest, feeds }) => (
  <Layout user={user} canonical="/">
    <section class="hero">
      <h1>Sources in. Feeds out.</h1>
      <p class="lede">
        {config.siteName} watches public data that only ever grows — game releases, package
        registries, government filings — and turns it into feeds you can follow, subscribe to, query
        and script. Open source, one Postgres, and every row reachable by web, RSS, JSON, API, CLI
        and MCP.
      </p>
      <p class="stats">
        <Num n={stats.items} /> items · <Num n={stats.items_today} /> today ·{' '}
        <Num n={stats.sources} /> sources · <Num n={stats.feeds} /> feeds
      </p>
    </section>

    <section>
      <h2>Collections</h2>
      <ul class="cards">
        {collections.map((c) => (
          <li class="card" key={c.slug}>
            <a class="card-title" href={`/c/${c.slug}`}>
              {c.name}
            </a>
            <p class="card-desc muted">{c.description}</p>
            <p class="small">
              <Num n={c.item_count} /> items · {c.source_count} sources · {c.feed_count} feeds
            </p>
          </li>
        ))}
      </ul>
    </section>

    <section>
      <h2>Feeds worth following</h2>
      <ul class="cards">
        {feeds.slice(0, 9).map((f) => (
          <FeedCard key={f.slug} feed={f} />
        ))}
      </ul>
    </section>

    <section>
      <h2>Just in</h2>
      <ItemList items={latest} />
    </section>
  </Layout>
);

export const CollectionPage = ({
  user,
  collection,
  stats,
  sources,
  feeds,
  latest,
  upcoming,
  kinds,
  tags,
  tag,
  kind,
}) => (
  <Layout
    user={user}
    title={collection.name}
    description={collection.description}
    canonical={`/c/${collection.slug}`}
  >
    <h1>{collection.name}</h1>
    <p class="lede">{collection.description}</p>
    <p class="stats">
      <Num n={stats.items} /> items · <Num n={stats.items_today} /> today · {stats.sources} sources
      · {stats.feeds} feeds
      {' · '}
      <a href={`/feeds/new?collection=${collection.slug}`}>make a feed</a>
      {' · '}
      <a href={`/submit?collection=${collection.slug}`}>suggest a feed</a>
    </p>

    <div class="cols">
      <section>
        <h2>Sources</h2>
        <ul class="plain">
          {sources.map((s) => (
            <li key={s.slug}>
              <Status source={s} /> <a href={`/s/${s.slug}`}>{s.name}</a>{' '}
              <span class="muted small">
                <Num n={s.item_count} /> items
              </span>
            </li>
          ))}
        </ul>
        <h2>Feeds</h2>
        <ul class="plain">
          {feeds.map((f) => (
            <li key={f.slug}>
              <a href={`/f/${f.slug}`}>{f.name}</a>{' '}
              <span class="muted small">
                <a href={`/f/${f.slug}.rss`}>rss</a>
              </span>
            </li>
          ))}
        </ul>
        {kinds.length > 1 ? (
          <>
            <h2>Kinds</h2>
            <p class="tags">
              {kinds.map((k) => (
                <a
                  key={k.kind}
                  class={`tag ${kind === k.kind ? 'on' : ''}`}
                  href={`/c/${collection.slug}?kind=${k.kind}`}
                >
                  {k.kind} <span class="muted">{k.n}</span>
                </a>
              ))}
            </p>
          </>
        ) : null}
        <h2>Tags</h2>
        <p class="tags">
          {tags.map((t) => (
            <a
              key={t.tag}
              class={`tag ${tag === t.tag ? 'on' : ''}`}
              href={`/c/${collection.slug}?tag=${encodeURIComponent(t.tag)}`}
            >
              {t.tag}
            </a>
          ))}
        </p>
      </section>
      <section>
        {upcoming.length ? (
          <>
            <h2>Coming up</h2>
            <ItemList items={upcoming} />
          </>
        ) : null}
        <h2>{tag ? `Tagged “${tag}”` : kind ? `Kind: ${kind}` : 'Just in'}</h2>
        <ItemList items={latest} />
        <Pager
          items={latest}
          base={`/c/${collection.slug}${tag ? `?tag=${encodeURIComponent(tag)}` : kind ? `?kind=${kind}` : ''}`}
        />
      </section>
    </div>
  </Layout>
);

export const FeedPage = ({
  user,
  feed,
  items,
  following,
  canEdit,
  query,
  notice,
  error,
  follow,
  enrichers,
}) => (
  <Layout
    user={user}
    title={feed.name}
    description={
      feed.description ?? `${feed.name} — a ${feed.collection_name} feed on ${config.siteName}`
    }
    canonical={`/f/${feed.slug}`}
    feedUrl={`/f/${feed.slug}.rss`}
    feedTitle={feed.name}
  >
    <div class="page-head">
      <div>
        <p class="crumb">
          <a href={`/c/${feed.collection_slug}`}>{feed.collection_name}</a>
        </p>
        <h1>{feed.name}</h1>
        {feed.description ? <p class="lede">{feed.description}</p> : null}
        <p class="small muted">
          {describeQuery(query)} · {feed.follower_count} following ·{' '}
          <a href={`/f/${feed.slug}.rss`}>RSS</a> · <a href={`/f/${feed.slug}.json`}>JSON</a> ·{' '}
          <a href={`/api/v1/feeds/${feed.slug}/items`}>API</a>
          {canEdit ? (
            <>
              {' · '}
              <a href={`/f/${feed.slug}/edit`}>edit</a>
            </>
          ) : null}
        </p>
      </div>
      <div class="actions">
        {user ? (
          following ? (
            <form method="post" action={`/f/${feed.slug}/unfollow`}>
              <button type="submit" class="ghost">
                Following ✓
              </button>
            </form>
          ) : (
            <form method="post" action={`/f/${feed.slug}/follow`}>
              <button type="submit" class="cta">
                Follow
              </button>
            </form>
          )
        ) : (
          <a class="cta button" href={`/login?next=/f/${feed.slug}`}>
            Sign in to follow
          </a>
        )}
      </div>
    </div>
    <Notice notice={notice} error={error} />
    {following && follow ? (
      <details class="panel">
        <summary>How you are told</summary>
        <form method="post" action={`/f/${feed.slug}/follow`} class="stack">
          <label>
            <input
              type="checkbox"
              name="channels"
              value="webpush"
              checked={follow.channels?.includes('webpush')}
            />{' '}
            Push notification
          </label>
          <label>
            <input
              type="checkbox"
              name="channels"
              value="email"
              checked={follow.channels?.includes('email')}
            />{' '}
            Email digest
          </label>
          <label>
            <input
              type="checkbox"
              name="channels"
              value="webhook"
              checked={follow.channels?.includes('webhook')}
            />{' '}
            Signed webhook (CloudEvents + Standard Webhooks, one POST per item)
          </label>
          <label>
            Webhook URL
            <input
              type="url"
              name="webhook_url"
              value={follow.webhook_url ?? ''}
              placeholder="https://example.com/hooks/nichedb"
            />
          </label>
          <label>
            Webhook secret
            <input
              type="text"
              name="webhook_secret"
              value={follow.webhook_secret ?? ''}
              placeholder="whsec_…"
            />
          </label>
          <button type="submit" class="ghost">
            Save
          </button>
        </form>
      </details>
    ) : null}
    <ItemList items={items} enrichers={enrichers} />
    <Pager items={items} base={`/f/${feed.slug}`} />
  </Layout>
);

export function describeQuery(q) {
  const parts = [];
  if (q.sources?.length) parts.push(`sources: ${q.sources.join(', ')}`);
  if (q.kinds?.length) parts.push(`kinds: ${q.kinds.join(', ')}`);
  if (q.tags?.length) parts.push(`tags: ${q.tags.join(', ')}`);
  if (q.q) parts.push(`matching “${q.q}”`);
  if (q.upcoming) parts.push('upcoming only');
  if (Array.isArray(q.enrichers))
    parts.push(q.enrichers.length ? `enriched with ${q.enrichers.join(', ')}` : 'no enrichment');
  return parts.length ? parts.join(' · ') : 'the whole collection';
}

export const ItemPage = ({
  user,
  item,
  enrichers,
  plan = 'free',
  awardCounts = [],
  awards = [],
  balance = 0,
}) => (
  <Layout
    user={user}
    title={item.title}
    description={item.summary ?? item.title}
    canonical={`/i/${item.id}`}
  >
    <p class="crumb">
      <a href={`/c/${item.collection_slug}`}>{item.collection_name}</a> ›{' '}
      <a href={`/s/${item.source_slug}`}>{item.source_name}</a>
    </p>
    <article class="detail">
      {item.image_url ? <img class="hero-img" src={item.image_url} alt="" /> : null}
      <h1>{item.title}</h1>
      <p class="item-meta">
        <When item={item} /> · <span class="kind">{item.kind}</span>
        {item.url ? (
          <>
            {' · '}
            <a href={item.url} rel="noopener nofollow">
              {safeHost(item.url)} ↗
            </a>
          </>
        ) : null}
      </p>
      {item.summary ? <p class="lede">{item.summary}</p> : null}
      <AwardPills counts={awardCounts} />
      <AwardForm
        targetType="item"
        targetId={item.id}
        awards={awards}
        plan={plan}
        balance={balance}
      />
      <Tags tags={item.tags} collection={item.collection_slug} limit={40} />
      <EnrichmentBlocks
        enrichment={Object.fromEntries(
          Object.entries(item.enrichment ?? {}).filter(([k]) => !enrichers || enrichers.has(k)),
        )}
      />
      <h2>Data</h2>
      <pre class="data">{JSON.stringify(item.data, null, 2)}</pre>
      <p class="small muted">
        <a href={`/api/v1/items/${item.id}`}>JSON</a> · first seen{' '}
        <Relative at={item.first_seen_at} /> · id {item.id}
      </p>
    </article>
  </Layout>
);

function safeHost(u) {
  try {
    return new URL(u).host;
  } catch {
    return 'open';
  }
}

export const SearchPage = ({ user, q, results, collections, collection }) => (
  <Layout user={user} title={q ? `“${q}”` : 'Search'} q={q}>
    <h1>{q ? `Results for “${q}”` : 'Search'}</h1>
    <form method="get" action="/search" class="row">
      <input type="search" name="q" value={q} placeholder="Anything" autofocus />
      <select name="collection">
        <option value="">Everywhere</option>
        {collections.map((c) => (
          <option key={c.slug} value={c.slug} selected={collection === c.slug}>
            {c.name}
          </option>
        ))}
      </select>
      <button type="submit" class="cta">
        Search
      </button>
    </form>
    {q ? (
      <>
        <p class="small muted">
          {results.length} result{results.length === 1 ? '' : 's'} ·{' '}
          <a
            href={`/feeds/new?q=${encodeURIComponent(q)}${collection ? `&collection=${collection}` : ''}`}
          >
            turn this into a feed
          </a>
        </p>
        <ItemList items={results} empty="Nothing matched." />
      </>
    ) : null}
  </Layout>
);

export const Following = ({ user, follows, items }) => (
  <Layout user={user} title="Following">
    <h1>Following</h1>
    {follows.length === 0 ? (
      <p class="muted">
        You follow nothing yet. Pick a <a href="/feeds">feed</a> or{' '}
        <a href="/feeds/new">make one</a>.
      </p>
    ) : (
      <ul class="cards">
        {follows.map((f) => (
          <FeedCard key={f.slug} feed={f} />
        ))}
      </ul>
    )}
    <h2>Latest across your feeds</h2>
    <ItemList items={items} />
  </Layout>
);

export const SignIn = ({ mode, sent, next, error, referral }) => (
  <Layout title={mode === 'signup' ? 'Create your account' : 'Sign in'}>
    <section class="auth">
      <h1>{mode === 'signup' ? 'Create your account' : 'Sign in'}</h1>
      {sent ? (
        <p class="feedback ok">
          If that address can receive mail, a sign-in link is on its way. It works once and expires
          in 20 minutes.
        </p>
      ) : (
        <>
          <p class="muted">
            We email you a link. No password to remember. Add a passkey afterwards if you like.
          </p>
          {referral ? (
            <p class="feedback ok">
              Referred with code {referral}: 20% off Pro on your first purchase.
            </p>
          ) : null}
          {error ? <p class="feedback error">{error}</p> : null}
          <form method="post" action="/api/auth/magic" class="stack">
            <input type="hidden" name="next" value={next ?? '/following'} />
            <label>
              Email
              <input
                type="email"
                name="email"
                required
                autocomplete="email"
                placeholder="you@example.com"
              />
            </label>
            <button class="cta" type="submit">
              Email me a link
            </button>
          </form>
          <div class="or">or</div>
          <button type="button" id="passkey-signin" class="ghost">
            Use a passkey
          </button>
          <p id="passkey-signin-msg" class="feedback" hidden />
          <p class="muted small">
            {mode === 'signup' ? (
              <>
                Already have an account? <a href="/login">Sign in</a> — same link either way.
              </>
            ) : (
              <>
                No account yet? <a href="/signup">Create one</a> — the link makes it for you.
              </>
            )}
          </p>
        </>
      )}
    </section>
  </Layout>
);

export const Settings = ({
  user,
  passkeys,
  apiKeys,
  newKey,
  plan = 'free',
  balance = 0,
  notice,
  error,
  pro,
  terms,
  referral,
  vapidKey,
}) => (
  <Layout user={user} title="Settings" vapidKey={vapidKey}>
    <h1>Settings</h1>
    <Notice notice={notice} error={error} />

    <section class="panel">
      <h2>API keys</h2>
      <p class="muted small">
        For the CLI, MCP clients and scripts. A key is shown once. Pass it as{' '}
        <code>Authorization: Bearer ndb_…</code>.
      </p>
      {newKey ? (
        <p class="feedback ok">
          New key (copy it now): <code class="mono">{newKey}</code>
        </p>
      ) : null}
      {apiKeys.length ? (
        <table class="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Prefix</th>
              <th>Last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {apiKeys.map((k) => (
              <tr key={k.id}>
                <td>{k.name}</td>
                <td class="mono">{k.prefix}…</td>
                <td>
                  <Relative at={k.lastUsedAt} />
                </td>
                <td>
                  <form method="post" action={`/api/keys/${k.id}/revoke`}>
                    <button type="submit" class="ghost small">
                      Revoke
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <form method="post" action="/api/keys" class="row">
        <input type="text" name="name" placeholder="Key name (laptop, CI, agent)" maxlength="60" />
        <button type="submit" class="cta">
          Create key
        </button>
      </form>
      <p class="small muted">
        Then: <code>nichedb login --api {config.siteUrl}</code>
      </p>
    </section>

    <section class="panel">
      <h2>Passkeys</h2>
      <p class="muted small">
        Sign in with a fingerprint, face or security key instead of waiting for an email.
      </p>
      {passkeys.length ? (
        <ul class="plain">
          {passkeys.map((p) => (
            <li key={p.credential_id}>
              <span class="mono">{p.credential_id.slice(0, 12)}…</span> · added{' '}
              <Relative at={p.created_at} />
              <form method="post" action="/api/auth/passkey/remove" class="inline">
                <input type="hidden" name="credential_id" value={p.credential_id} />
                <button type="submit" class="ghost small">
                  Remove
                </button>
              </form>
            </li>
          ))}
        </ul>
      ) : (
        <p class="muted small">No passkeys yet.</p>
      )}
      <button type="button" id="add-passkey" class="ghost">
        Add a passkey
      </button>
      <p id="add-passkey-msg" class="feedback" hidden />
    </section>

    <section class="panel">
      <h2>Notifications</h2>
      <p class="muted small">
        Push works on this device once you allow it. Email digests go to {user.email}.
      </p>
      <button type="button" id="push-enable" class="ghost">
        Enable push on this device
      </button>
      <p id="push-msg" class="feedback" hidden />
      <form method="post" action="/api/profile" class="row">
        <input
          type="text"
          name="display_name"
          value={user.display_name ?? ''}
          placeholder="Display name"
          maxlength="60"
        />
        <select name="timezone">
          {ZONES.map((z) => (
            <option key={z} value={z} selected={user.timezone === z}>
              {z}
            </option>
          ))}
        </select>
        <button type="submit" class="ghost">
          Save
        </button>
      </form>
    </section>

    {/* The profile is the second place the upsell belongs: somebody looking at
        their own account is the person deciding what it should be. */}
    <section class="panel">
      <h2>Your plan</h2>
      <p class="stats">
        {plan === 'free' ? 'Free' : plan} <PlanBadge plan={plan} />
        {plan !== 'free' ? <span class="muted small"> · {balance} credits</span> : null}
      </p>
      {plan === 'free' ? (
        <p class="small">
          Free pages and feeds carry an ad and a tracker. <a href="/premium">Premium</a> turns both
          off and opens the Lounge, the credits, the themes and early access for $
          {(config.premium.dayCents / 100).toFixed(2)} a day.
        </p>
      ) : (
        <p class="small">
          <a href="/lounge">The Lounge</a> · <a href="/premium">manage or extend</a>
        </p>
      )}
    </section>

    <section class="panel">
      <h2>Pro</h2>
      {pro ? (
        <p class="feedback ok">
          You are Pro
          {terms?.[0] ? ` until ${new Date(terms[0].expires_at).toLocaleDateString('en-US')}` : ''}.
        </p>
      ) : (
        <p class="muted small">
          Free accounts keep {config.feeds.freeLimit} feeds and cannot add sources.{' '}
          <a href="/pro">Pro</a> lifts both.
        </p>
      )}
      {referral ? (
        <p class="small">
          Your referral link: <code class="mono">{referral.url}</code>
          <br />
          <span class="muted">
            Anyone who signs up through it gets 20% off Pro; you earn 60% of what they pay.
          </span>
          {referral.stats?.totalUsages ? (
            <>
              <br />
              {referral.stats.totalUsages} referral{referral.stats.totalUsages === 1 ? '' : 's'} · $
              {(referral.stats.totalCommissionCents / 100).toFixed(2)} earned
            </>
          ) : null}
        </p>
      ) : null}
    </section>

    <form method="post" action="/api/auth/logout">
      <button type="submit" class="ghost">
        Sign out
      </button>
    </form>
  </Layout>
);

const ZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Madrid',
  'Europe/Moscow',
  'Africa/Lagos',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Australia/Sydney',
];

export const ProPage = ({ user, pro, enabled, price, notice, error }) => (
  <Layout user={user} title="Pro">
    <h1>Pro</h1>
    <Notice notice={notice} error={error} />
    <p class="lede">
      {config.siteName} is free to read, follow and query, and free pages and feeds carry an ad and
      a tracker. Pro is the tier without them, for people and agents that run it harder.
    </p>
    <ul>
      <li>No ads and no tracking, on every page and in every feed.</li>
      <li>
        A crawl pass for the whole term: your own crawlers and agents walk through the paywall on
        your key, with nothing to pay per day. When the term ends they can keep going a day at a
        time over x402, paid as they go.
      </li>
      <li>
        The high API rate limit: {config.api.proPerHour.toLocaleString('en-US')} requests an hour,
        and the whole archive, enrichment included.
      </li>
      <li>Unlimited feeds (free accounts keep {config.feeds.freeLimit}).</li>
      <li>Add your own sources: any adapter, your own config, on your own cadence.</li>
    </ul>
    <p class="stats">
      ${(price.amountCents / 100).toFixed(2)} {config.membership.currency}{' '}
      {config.membership.termDays === 30
        ? 'a month'
        : config.membership.termDays === 365
          ? 'a year'
          : `for ${config.membership.termDays} days`}
      {price.discountCents ? (
        <span class="muted small"> (referral: ${(price.discountCents / 100).toFixed(2)} off)</span>
      ) : null}
    </p>
    {pro ? (
      <p class="feedback ok">
        You are Pro. Buying again extends the term. Your crawl pass is at{' '}
        <a href="/api/v1/crawl-pass">/api/v1/crawl-pass</a>.
      </p>
    ) : null}
    <p class="muted small">
      Just an agent? No account needed: a crawl pass is ${(config.x402.priceCents / 100).toFixed(2)}{' '}
      a day for everything at <a href="/crawl">/crawl</a>, paid over x402, and the more you have
      paid here the less a day costs.
    </p>
    <p class="muted small">
      Reading rather than crawling? <a href="/premium">Premium</a> is $
      {(config.premium.dayCents / 100).toFixed(2)} a day or $
      {(config.premium.monthCents / 100).toFixed(0)} a month: everything above except the operator
      limits and the term-long crawl pass, plus the Lounge, the credits, the themes and early
      access.
    </p>
    {enabled ? (
      user ? (
        <form method="post" action="/api/membership/buy">
          <button type="submit" class="cta">
            Pay with crypto via CoinPay
          </button>
        </form>
      ) : (
        <a class="cta button" href="/login?next=/pro">
          Sign in first
        </a>
      )
    ) : (
      <p class="muted">Payments are not configured on this deployment. Ask its operator.</p>
    )}
  </Layout>
);

export const About = ({ user, stats }) => (
  <Layout user={user} title="About">
    <h1>About</h1>
    <p class="lede">
      {config.siteName} is a platform for databases that only ever grow. A <b>collection</b> is a
      niche. A <b>source</b> is one adapter pointed at one upstream, run on a schedule. Every row it
      produces is an <b>item</b>. A <b>feed</b> is a saved query over a collection, with a page, an
      RSS and JSON rendering, and followers who are told when it changes.
    </p>
    <p>
      This deployment holds <Num n={stats.items} /> items from <Num n={stats.sources} /> sources in{' '}
      {stats.collections} collections, and added <Num n={stats.items_today} /> in the last day.
    </p>
    <p>
      The code is MIT-licensed at{' '}
      <a href="https://github.com/profullstack/niche-db">github.com/profullstack/niche-db</a>. Run
      your own on any Postgres and Redis. Adapters are one file each.
    </p>
    <p>
      Search engines and retrieval crawlers are welcome. Training crawlers pay by the day at{' '}
      <a href="/crawl">/crawl</a>.
    </p>
  </Layout>
);

export const NotFound = ({ user }) => (
  <Layout user={user} title="Not found">
    <h1>Not found</h1>
    <p class="muted">
      Nothing lives at this address. Try <a href="/">the front page</a> or{' '}
      <a href="/search">search</a>.
    </p>
  </Layout>
);
