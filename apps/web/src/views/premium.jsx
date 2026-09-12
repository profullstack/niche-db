/**
 * The Premium pages: the pitch with the comparison on it, and the Lounge.
 *
 * The comparison table is rendered from `@nichedb/premium/comparison`, which
 * is also what the tests assert and what `/api/v1/premium` serves. A claim can
 * therefore only appear on this page by existing as data first.
 */
import { config } from '@nichedb/config';
import { Notice, Num } from './components.jsx';
import { Layout } from './Layout.jsx';

const money = (cents) => `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;

/** The mark beside a member's name. Nothing at all for a free account. */
export const PlanBadge = ({ plan }) =>
  plan === 'premium' || plan === 'pro' ? (
    <span class={`badge plan-${plan}`} title={`${config.siteName} ${plan}`}>
      {plan}
    </span>
  ) : null;

/** What one thing has been awarded, as a line of pills. */
export const AwardPills = ({ counts }) =>
  counts?.length ? (
    <span class="badges awards">
      {counts.map((c) => (
        <span class="badge award" key={c.kind}>
          {c.kind} ×{c.n}
        </span>
      ))}
    </span>
  ) : null;

/** The form that spends credits, or the reason it is not there. */
export const AwardForm = ({ targetType, targetId, awards, plan, balance }) =>
  plan === 'free' ? (
    <p class="small muted">
      <a href="/premium">Premium</a> members can award this.
    </p>
  ) : (
    <form method="post" action="/api/premium/awards" class="row award-form">
      <input type="hidden" name="target_type" value={targetType} />
      <input type="hidden" name="target_id" value={String(targetId)} />
      <select name="kind">
        {awards.map((a) => (
          <option key={a.id} value={a.id}>
            {a.label} — {a.credits} credits
          </option>
        ))}
      </select>
      <button type="submit" class="ghost">
        Award
      </button>
      <span class="small muted">{balance} credits left</span>
    </form>
  );

export const PremiumPage = ({
  user,
  plan,
  terms,
  rows,
  score,
  reddit,
  members,
  snapshot,
  discountCents,
  enabled,
  notice,
  error,
}) => {
  const day = terms.find((t) => t.id === 'day');
  const month = terms.find((t) => t.id === 'month');
  const year = terms.find((t) => t.id === 'year');
  return (
    <Layout
      user={user}
      title="Premium"
      canonical="/premium"
      description={`${config.siteName} Premium: no ads, the Lounge, monthly credits, themes, early access and the whole database, for ${money(day?.cents ?? 100)} a day.`}
    >
      <section class="hero">
        <h1>Premium</h1>
        <p class="lede">
          A dollar a day. No ads, no tracker, the members' Lounge, credits to award with, themes and
          app icons, early access to new collections, and the higher limits on everything
          {config.siteName} holds. The same dollar a day the crawlers pay, because it is the same
          database.
        </p>
        <p class="stats">
          {terms.map((t) => (
            <span class="price" key={t.id}>
              {money(t.cents)} {t.label}
              {t.savedPercent > 0 ? (
                <span class="muted small"> ({t.savedPercent}% off)</span>
              ) : null}
              {' · '}
            </span>
          ))}
          <a href="#compare">Compared with Reddit Premium</a>
        </p>
        {members?.premium || members?.pro ? (
          <p class="small muted">
            <Num n={(members.premium ?? 0) + (members.pro ?? 0)} /> members right now.
          </p>
        ) : null}
      </section>

      <Notice notice={notice} error={error} />

      {plan !== 'free' ? (
        <p class="feedback ok">
          You are {plan}
          {snapshot?.terms?.[0]
            ? ` until ${new Date(snapshot.terms[0].expires_at).toLocaleDateString('en-US')}`
            : ''}
          . <a href="/lounge">The Lounge</a> · {snapshot?.balance ?? 0} credits.
        </p>
      ) : null}

      <section>
        <h2>What it includes</h2>
        <ul class="benefits">
          <li>
            <b>No ads, no tracking.</b> Not on a page, and not at the top of an RSS or JSON feed
            either. The sponsored item free readers get is simply not built for you.
          </li>
          <li>
            <b>The Lounge.</b> A members-only room: the collections that are open to members before
            they are public, what the membership is awarding this week, and who else is in here.
          </li>
          <li>
            <b>{config.premium.monthlyCredits.toLocaleString('en-US')} credits a month.</b> Granted
            on the first of the month and spendable on awards. They are a ledger, not a promise:
            every grant and every spend is a row you can read back.
          </li>
          <li>
            <b>Awards.</b> Mark any item or contribution as useful, verified or a scoop. The counts
            are public, so an award is worth something to the person who gets it.
          </li>
          <li>
            <b>A badge.</b> Beside your name on your profile, on every contribution you make, and in
            the API.
          </li>
          <li>
            <b>Themes and app icons.</b> Six themes and five icons, on the web and in the installed
            app.
          </li>
          <li>
            <b>Early access.</b> New collections open to members first.
          </li>
          <li>
            <b>The higher limits.</b> {config.api.premiumPerHour.toLocaleString('en-US')} API
            requests an hour, unlimited feeds, your own sources, and the metered vehicle lookups
            included rather than counted.
          </li>
        </ul>
      </section>

      <section id="compare">
        <h2>
          {config.siteName} Premium vs {reddit.name}
        </h2>
        <p class="small muted">
          {reddit.name} is {money(reddit.monthlyCents)} a month or {money(reddit.yearlyCents)} a
          year (prices and benefits captured {reddit.capturedOn} from{' '}
          {reddit.sources.map((s, i) => (
            <span key={s.url}>
              {i ? ', ' : ''}
              <a href={s.url} rel="noopener nofollow">
                {new URL(s.url).host}
              </a>
            </span>
          ))}
          ; reddit.com/premium answers anything that is not a logged-in browser with a network
          block). We win {score.ours} of {score.total} rows and say so where we do not.
        </p>
        <div class="table-scroll">
          <table class="table small compare">
            <thead>
              <tr>
                <th>&nbsp;</th>
                <th>{reddit.name}</th>
                <th>{config.siteName} Premium</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.feature} class={r.wins ? 'wins' : ''}>
                  <th scope="row">{r.feature}</th>
                  <td class="muted">{r.reddit}</td>
                  <td>
                    {r.ours}
                    {r.note ? <span class="muted small"> {r.note}</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p class="small muted">
          The honest summary: Reddit Premium turns Reddit's ads off. This turns ours off and hands
          you the database underneath — by web, RSS, JSON Feed, API, CLI and MCP — and sells you a
          single day for {money(day?.cents ?? 100)} if a day is all you want, which is not a thing
          Reddit offers at any price.
        </p>
      </section>

      <section class="cta-block">
        <h2>Take a day, a month or a year</h2>
        <p class="stats">
          {money(day?.cents ?? 100)} a day · {money(month?.cents ?? 3000)} a month ·{' '}
          {money(year?.cents ?? 30000)} a year
          {discountCents ? (
            <span class="muted small"> (referral: {money(discountCents)} off)</span>
          ) : null}
        </p>
        {enabled ? (
          user ? (
            <div class="row buy-row">
              <form method="post" action="/api/premium/buy">
                <input type="hidden" name="term" value="month" />
                <button type="submit" class="cta">
                  A month, {money(month?.cents ?? 3000)}
                </button>
              </form>
              <form method="post" action="/api/premium/buy">
                <input type="hidden" name="term" value="year" />
                <button type="submit" class="ghost">
                  A year, {money(year?.cents ?? 30000)}
                </button>
              </form>
            </div>
          ) : (
            <a class="cta button" href="/login?next=/premium">
              Sign in first
            </a>
          )
        ) : (
          <p class="muted">Payments are not configured on this deployment. Ask its operator.</p>
        )}
        <p class="muted small">
          Paid in crypto through CoinPay. A single day is bought the way the crawlers buy it, over
          x402 at <a href="/crawl">/crawl</a> — no account, no subscription, and the more you have
          paid here the less a day costs.
        </p>
        <p class="muted small">
          Running agents rather than reading? <a href="/pro">Pro</a> is the operator tier:
          everything here plus {config.api.proPerHour.toLocaleString('en-US')} requests an hour and
          a crawl pass for the whole term.
        </p>
      </section>
    </Layout>
  );
};

export const LoungePage = ({
  user,
  plan,
  early,
  members,
  top,
  snapshot,
  themes,
  icons,
  awards,
  notice,
  error,
}) => (
  <Layout user={user} title="The Lounge">
    <section class="hero">
      <h1>The Lounge</h1>
      <p class="lede">
        Members only. What is open to you before it is open to everyone, what the membership is
        awarding, and who else is in here.
      </p>
      <p class="stats">
        <PlanBadge plan={plan} /> {snapshot?.balance ?? 0} credits ·{' '}
        {snapshot?.terms?.[0]
          ? `until ${new Date(snapshot.terms[0].expires_at).toLocaleDateString('en-US')}`
          : 'admin'}
      </p>
    </section>

    <Notice notice={notice} error={error} />

    <section>
      <h2>Early access</h2>
      {early.length === 0 ? (
        <p class="muted empty">
          Nothing is in early access this week. When a collection is being built, it opens here
          first.
        </p>
      ) : (
        <ul class="cards">
          {early.map((c) => (
            <li class="card" key={c.slug}>
              <a class="card-title" href={`/c/${c.slug}`}>
                {c.name}
              </a>
              <p class="card-desc muted">{c.description}</p>
              <p class="small">
                <Num n={c.item_count} /> items · {c.source_count} sources
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>

    <section>
      <h2>Awarded this week</h2>
      {top.length === 0 ? (
        <p class="muted empty">Nothing awarded yet. Yours would be the first.</p>
      ) : (
        <ul class="items">
          {top.map((a) => (
            <li class="item" key={a.target_id}>
              <div class="item-body">
                <a class="item-title" href={`/i/${a.item.id}`}>
                  {a.item.title}
                </a>
                <p class="item-meta">
                  {a.awards} award{a.awards === 1 ? '' : 's'} · {a.credits} credits ·{' '}
                  <a href={`/c/${a.item.collection_slug}`}>{a.item.collection_name}</a>
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p class="small muted">{awards.map((a) => `${a.label} costs ${a.credits}`).join(' · ')}.</p>
    </section>

    <section class="panel">
      <h2>Appearance</h2>
      <form method="post" action="/api/premium/appearance" class="row">
        <label class="visually-hidden" for="theme">
          Theme
        </label>
        <select id="theme" name="theme">
          {themes.map((t) => (
            <option key={t.id} value={t.id} selected={user.premium_theme === t.id}>
              {t.label}
            </option>
          ))}
        </select>
        <label class="visually-hidden" for="icon">
          App icon
        </label>
        <select id="icon" name="icon">
          {icons.map((i) => (
            <option key={i.id} value={i.id} selected={user.premium_icon === i.id}>
              {i.label}
            </option>
          ))}
        </select>
        <button type="submit" class="ghost">
          Save
        </button>
      </form>
      <p class="small muted">
        The icon is what the installed app shows on a home screen, and the theme applies wherever
        you are signed in.
      </p>
    </section>

    <section class="panel">
      <h2>Credits</h2>
      <p class="stats">{snapshot?.balance ?? 0}</p>
      {snapshot?.ledger?.length ? (
        <table class="table small">
          <thead>
            <tr>
              <th>When</th>
              <th>What</th>
              <th>Credits</th>
            </tr>
          </thead>
          <tbody>
            {snapshot.ledger.map((row) => (
              <tr key={row.id}>
                <td>{new Date(row.created_at).toLocaleDateString('en-US')}</td>
                <td>{row.reason}</td>
                <td class="num">{row.delta > 0 ? `+${row.delta}` : row.delta}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p class="muted empty">No credits yet. The month's grant lands the first time you visit.</p>
      )}
    </section>

    <section>
      <h2>Members</h2>
      <ul class="cards">
        {members.map((m) => (
          <li class="card" key={m.handle ?? m.started_at}>
            <span class="card-title">
              {m.handle ? <a href={`/@${m.handle}`}>{m.display_name ?? m.handle}</a> : 'A member'}{' '}
              <PlanBadge plan={m.plan} />
            </span>
            <p class="small muted">since {new Date(m.started_at).toLocaleDateString('en-US')}</p>
          </li>
        ))}
      </ul>
    </section>
  </Layout>
);
