/**
 * The Premium pages: the pitch with the comparison on it, and the Lounge.
 *
 * The comparison table is rendered from `@nichedb/premium/comparison`, which
 * is also what the tests assert and what `/api/v1/premium` serves. A claim can
 * therefore only appear on this page by existing as data first.
 */
import { config } from '@nichedb/config';
import { entitlements } from '@nichedb/premium';
import { Notice, Num } from './components.jsx';
import { DataDumpsOffer } from './data-dumps.jsx';
import { Layout } from './Layout.jsx';

const money = (cents) => `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;

/** The mark beside a member's name. Nothing at all for a free account. */
export const PlanBadge = ({ plan }) =>
  plan === 'premium' || plan === 'pro' || plan === 'data' ? (
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

const TermCard = ({ term, user, enabled, selected }) => {
  const titles = { day: 'Try a day', month: 'Make it your daily', year: 'Stay for the year' };
  const durations = { day: '24 hours', month: '30 days', year: '365 days' };
  return (
    <article class={`premium-term${selected ? ' selected' : ''}`}>
      <p class="premium-eyebrow">
        {term.savedPercent > 0
          ? `Save ${term.savedPercent}% vs daily`
          : term.id === 'month'
            ? 'Standard price'
            : 'Start small'}
      </p>
      <h3>{titles[term.id]}</h3>
      <p class="premium-term-price">
        {money(term.cents)} <span>{term.label}</span>
      </p>
      <p class="small muted">
        ${(term.perDayCents / 100).toFixed(2)}/day · {durations[term.id]} of Premium
      </p>
      <p class="small">
        {term.savedCents > 0
          ? `Keep ${money(term.savedCents)} compared with buying ${term.days} individual days.`
          : 'Every Premium perk. One upfront payment.'}
      </p>
      {term.discountCents > 0 ? (
        <p class="small premium-referral">
          Your referral saves {money(term.discountCents)} on this term.
        </p>
      ) : null}
      {enabled ? (
        user ? (
          <form method="post" action="/api/premium/buy">
            <input type="hidden" name="term" value={term.id} />
            <button type="submit" class={selected ? 'cta' : 'ghost'}>
              Get {durations[term.id]} · {money(term.checkoutCents ?? term.cents)}
            </button>
          </form>
        ) : (
          <a
            class={`button ${selected ? 'cta' : 'ghost'}`}
            href={`/login?next=${encodeURIComponent(`/premium?term=${term.id}#plans`)}`}
          >
            Sign in for {durations[term.id]}
          </a>
        )
      ) : (
        <p class="small muted">Checkout unavailable</p>
      )}
    </article>
  );
};

export const PremiumPage = ({
  user,
  plan,
  terms,
  rows,
  reddit,
  members,
  snapshot,
  enabled,
  selectedTerm = 'month',
  notice,
  error,
}) => {
  const day = terms.find((t) => t.id === 'day');
  const member = plan !== 'free';
  const api = config.api.premiumPerHour.toLocaleString('en-US');
  const credits = config.premium.monthlyCredits.toLocaleString('en-US');
  const perks = [
    [
      '01',
      'No ads. No tracking.',
      'Your pages and authenticated feeds stay clear of our ads and analytics scripts. Just the data you came for.',
    ],
    [
      '02',
      'The Lounge',
      'Meet the members, explore member collections and see the items the community is awarding this week.',
    ],
    [
      '03',
      `${credits} monthly credits`,
      'Recognize a useful find with credits included in your membership. Granted on your first visit each calendar month.',
    ],
    [
      '04',
      'Awards that give credit',
      'Give Useful, Verified or Scoop awards to items and contributions. Let good work stand out.',
    ],
    [
      '05',
      'Your Premium badge',
      'Put a badge beside your contributions, with a visual highlight that makes your work easier to spot.',
    ],
    [
      '06',
      'Themes and app icons',
      'Make it feel like yours: six themes and five app icons for the web and installed app.',
    ],
    [
      '07',
      'Early access',
      'Explore collections opened to members before their public release. Find what is new in the Lounge.',
    ],
    [
      '08',
      'Room to build',
      `${api} API requests an hour, unlimited feeds, your own sources and vehicle lookups included.`,
    ],
  ];
  const plans = ['free', 'premium', 'pro'].map((plan) =>
    entitlements(plan, { monthlyCredits: config.premium.monthlyCredits }),
  );
  const planRows = [
    ['Browse, search and read public data', () => 'Included'],
    ['Ads and analytics scripts', (p) => (p.ads ? 'On' : 'Off')],
    [
      'API requests / hour',
      (p) =>
        (p.apiTier === 'pro'
          ? config.api.proPerHour
          : p.apiTier === 'premium'
            ? config.api.premiumPerHour
            : config.api.freePerHour
        ).toLocaleString('en-US'),
    ],
    [
      'Unlimited feeds and own sources',
      (p) => (p.unlimitedFeeds && p.ownSources ? 'Included' : 'Limited feeds'),
    ],
    ['Lounge and early access', (p) => (p.lounge && p.earlyAccess ? 'Included' : '—')],
    [
      'Award credits / calendar month',
      (p) => (p.monthlyCredits ? p.monthlyCredits.toLocaleString('en-US') : '—'),
    ],
    [
      'Badge, themes and app icons',
      (p) => (p.badge && p.appearance ? 'Included' : 'Default appearance'),
    ],
    ['Automated crawl pass for the term', (p) => (p.crawlPass ? 'Included' : 'Sold separately')],
  ];
  return (
    <Layout
      user={user}
      title={`Premium · ${money(day?.cents ?? config.premium.dayCents)} a day`}
      canonical="/premium"
      description={`${config.siteName} Premium: no ads, no tracking, the Lounge, award credits, themes and higher data limits. ${money(day?.cents ?? config.premium.dayCents)} a day. No automatic renewal.`}
    >
      <div class="premium-page">
        <section class="premium-hero">
          <div>
            <p class="premium-eyebrow">{config.siteName} Premium</p>
            <h1>
              Your niche.
              <br />
              <span>All the extras.</span>
            </h1>
            <p class="lede">
              A quieter place to explore. More room to build. Get the member perks and the data
              tools, at our standard daily price.
            </p>
            <div class="row buy-row">
              <a class="cta button" href="#plans">
                {member ? 'Extend your Premium' : 'Get Premium'}
              </a>
              <a href="#benefits">Explore the perks ↓</a>
            </div>
            <p class="small muted">Pay for the time you want. No automatic renewal.</p>
          </div>
          <div class="premium-hero-price">
            <p class="premium-eyebrow">The standard</p>
            <p>
              <strong>{money(day?.cents ?? config.premium.dayCents)}</strong>
              <span> / day</span>
            </p>
            <p>
              Every Premium perk.
              <br />
              Even for just one day.
            </p>
            <a class="small" href="#compare">
              Compare with Reddit Premium ↗
            </a>
          </div>
        </section>

        <Notice notice={notice} error={error} />
        {member ? (
          <p class="feedback ok">
            You are {plan}. <a href="/lounge">Open the Lounge</a> · {snapshot?.balance ?? 0} credits
            · <a href="/account/billing">Manage your membership</a>
          </p>
        ) : null}

        <div class="premium-stats">
          <p>
            <strong>{api}</strong>
            <span>API requests / hour</span>
          </p>
          <p>
            <strong>{credits}</strong>
            <span>award credits / month</span>
          </p>
          <p>
            <strong>0</strong>
            <span>ads or tracking scripts</span>
          </p>
          {members?.premium || members?.pro || members?.data ? (
            <p>
              <strong>
                <Num n={(members.premium ?? 0) + (members.pro ?? 0) + (members.data ?? 0)} />
              </strong>
              <span>current members</span>
            </p>
          ) : null}
        </div>

        <section id="plans" class="premium-section">
          <p class="premium-eyebrow">One membership. Your choice of time.</p>
          <h2>Start with a day. Stay as long as you like.</h2>
          <p class="muted">
            The same Premium benefits in every term. Prices in {config.premium.currency}; paid
            upfront through CoinPay in crypto.
          </p>
          <div class="premium-terms">
            {terms.map((term) => (
              <TermCard
                key={term.id}
                term={term}
                user={user}
                enabled={enabled}
                selected={term.id === selectedTerm}
              />
            ))}
          </div>
          {!enabled ? (
            <p class="feedback">Payments are not configured on this deployment.</p>
          ) : null}
          <p class="small muted">
            Access begins after payment confirmation. Extending adds time to your current Premium
            term.
          </p>
        </section>

        <section id="benefits" class="premium-section">
          <p class="premium-eyebrow">The good stuff, included</p>
          <h2>Make more of every visit.</h2>
          <div class="premium-perks">
            {perks.map(([number, title, description]) => (
              <article key={number} class="premium-perk">
                <span class="premium-perk-number" aria-hidden="true">
                  {number}
                </span>
                <h3>{title}</h3>
                <p>{description}</p>
              </article>
            ))}
          </div>
        </section>

        <section class="premium-section" id="plan-compare">
          <p class="premium-eyebrow">From curious to all in</p>
          <h2>A plan for how you use the data.</h2>
          <section class="table-scroll" aria-label="Compare nichedb plans" tabindex="0">
            <table class="table compare premium-plan-table">
              <thead>
                <tr>
                  <th scope="col">Included</th>
                  <th scope="col">
                    Free
                    <br />
                    <span class="small muted">$0</span>
                  </th>
                  <th scope="col">
                    Premium
                    <br />
                    <span class="small">{money(day?.cents ?? config.premium.dayCents)}/day</span>
                  </th>
                  <th scope="col">
                    Pro
                    <br />
                    <span class="small muted">
                      {money(config.membership.priceCents)} / {config.membership.termDays} days
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {planRows.map(([feature, value]) => (
                  <tr key={feature}>
                    <th scope="row">{feature}</th>
                    {plans.map((p) => (
                      <td key={p.plan}>{value(p)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <p class="small muted">
            Automating at scale? <a href="/pro">Get Pro</a> for every Premium perk, the highest API
            allowance and a crawl pass for your entire term.
          </p>
        </section>

        <DataDumpsOffer access={plan === 'data'} />

        <section id="compare" class="premium-section">
          <p class="premium-eyebrow">The comparison you came for</p>
          <h2>
            {config.siteName} Premium vs {reddit.name}
          </h2>
          <p class="muted">
            Reddit costs {money(reddit.monthlyCents)} a month or {money(reddit.yearlyCents)} a year
            on the web. Our {money(day?.cents ?? config.premium.dayCents)} day is a smaller first
            purchase, with data tools alongside the member perks.
          </p>
          <section class="table-scroll" aria-label="Compare Reddit Premium" tabindex="0">
            <table class="table small compare">
              <thead>
                <tr>
                  <th scope="col">Feature</th>
                  <th scope="col">{reddit.name}</th>
                  <th scope="col">{config.siteName} Premium</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.feature}>
                    <th scope="row">{r.feature}</th>
                    <td class="muted">{r.reddit}</td>
                    <td>
                      {r.ours}
                      {r.note ? <p class="small muted">{r.note}</p> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <p class="small muted">
            Checked {reddit.capturedOn} against{' '}
            {reddit.sources.map((s, i) => (
              <span key={s.url}>
                {i ? ' and ' : ''}
                <a href={s.url} rel="noopener nofollow">
                  {s.title}
                </a>
              </span>
            ))}
            . Reddit prices may vary by location and purchase platform.
          </p>
        </section>

        <section class="premium-section premium-faq">
          <p class="premium-eyebrow">A few useful details</p>
          <h2>Before you make it Premium.</h2>
          <details>
            <summary>Does the one-day plan really include all the perks?</summary>
            <p>
              Yes. It gives your signed-in account 24 hours of Premium after payment confirmation:
              no ads or tracking, the Lounge, themes, awards, early access and higher limits.
              Credits are granted once per calendar month while your membership is active.
            </p>
          </details>
          <details>
            <summary>Will I be charged again automatically?</summary>
            <p>
              No. Each purchase pays for a fixed term. When it ends, your account returns to Free
              unless you extend it. You can view your access in{' '}
              <a href="/account/billing">billing settings</a>.
            </p>
          </details>
          <details>
            <summary>Is the daily crawl pass the same as Premium?</summary>
            <p>
              A <a href="/crawl">crawl pass</a> lets an agent buy automated access without an
              account. Premium belongs to your account and includes the member perks. Pro includes
              both membership benefits and a crawl pass.
            </p>
          </details>
          <details>
            <summary>How do credits and awards work?</summary>
            <p>
              On your first member visit each calendar month, you receive {credits} credits. Spend
              them on Useful, Verified and Scoop awards for items and contributions. Buying more
              terms in the same month does not grant extra monthly credits. Your balance and history
              are in the Lounge.
            </p>
          </details>
          <details>
            <summary>Can I keep using nichedb for free?</summary>
            <p>
              Yes. Browse and search public collections, read feeds and use the free API allowance.
              Upgrade when you want the member extras and higher limits.
            </p>
          </details>
        </section>

        <section class="premium-close">
          <div>
            <p class="premium-eyebrow">Make yourself at home</p>
            <h2>One day is all it takes.</h2>
            <p class="muted">
              {money(day?.cents ?? config.premium.dayCents)} for a day of Premium. Pick your term
              and explore.
            </p>
          </div>
          <a class="cta button" href="#plans">
            {member ? 'Extend Premium' : 'Choose your Premium'}
          </a>
        </section>
      </div>
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
