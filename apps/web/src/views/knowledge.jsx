import { asJson, asJsonArray, formatBps, nextTierFor } from '@nichedb/knowledge';
import { Notice, Num, Relative } from './components.jsx';
import { Layout } from './Layout.jsx';
import { PlanBadge } from './premium.jsx';

/**
 * The Knowledge Influencer surfaces.
 *
 * Four public pages and one dashboard. The public ones exist to be found: a
 * niche page is the thing someone searching for their own industry lands on,
 * and it has to be worth landing on before it asks anybody for anything.
 */

/** The ladder, as a table. Same numbers the engine pays on, read from the database. */
export const TierTable = ({ tiers, current = null }) => (
  <table class="table small tiers">
    <thead>
      <tr>
        <th>Tier</th>
        <th>Verified score</th>
        <th>Revenue share</th>
      </tr>
    </thead>
    <tbody>
      {tiers.map((t) => (
        <tr key={t.slug} class={t.slug === current ? 'here' : ''}>
          <td>{t.name}</td>
          <td>{t.minScore}+</td>
          <td>{formatBps(t.shareBps)}</td>
        </tr>
      ))}
    </tbody>
  </table>
);

const OperatorCard = ({ member, plan = 'free' }) => (
  <li class="card" key={member.user_id}>
    <a class="card-title" href={`/@${member.handle ?? ''}`}>
      {member.display_name ?? member.handle ?? 'A Knowledge Influencer'}
    </a>{' '}
    <PlanBadge plan={plan} />
    <p class="card-desc muted">
      {member.role === 'operator' ? 'Knowledge Influencer' : member.role}
    </p>
    <p class="small">
      {member.tier_slug.replace(/-/g, ' ')} · share {formatBps(member.share_bps)} ·{' '}
      <Num n={member.verified_count} /> verified contributions
    </p>
  </li>
);

/**
 * A niche's public page: what the industry is, who runs it, what has been
 * built for it, and — when nobody runs it — the offer to.
 */
export const NichePage = ({ user, niche, members, tiers, contributions, plans = {} }) => (
  <Layout
    user={user}
    title={niche.name}
    canonical={`/${niche.slug}`}
    description={
      niche.description ?? `Structured knowledge, software, data and tools for ${niche.name}.`
    }
  >
    <section class="hero">
      <h1>The {niche.name} Database</h1>
      <p class="lede">
        {niche.description ??
          `Structured knowledge, software, data, feeds and tools for the ${niche.name.toLowerCase()} industry.`}
      </p>
      <p class="stats">
        {niche.collection_slug ? (
          <>
            <a href={`/c/${niche.collection_slug}`}>Explore the data</a> ·{' '}
            <a href={`/f/${niche.collection_slug}.rss`}>RSS</a> ·{' '}
          </>
        ) : null}
        <a href="/docs/api">API</a> · <a href={`/${niche.slug}/skill.md`}>skill.md</a> ·{' '}
        <a href={`/${niche.slug}/manifest.json`}>manifest</a>
      </p>
    </section>

    {members.length ? (
      <section>
        <h2>
          {members.length === 1
            ? 'Expert on this niche'
            : `Experts on this niche (${members.length})`}
        </h2>
        <ul class="cards">
          {members.map((m) => (
            <OperatorCard key={m.user_id} member={m} plan={plans[m.user_id] ?? 'free'} />
          ))}
        </ul>
      </section>
    ) : null}

    {/* Always offered, however many people are already here. A niche is a
        subject you can be expert in, not a plot somebody has taken: the
        second person who actually knows the trade is worth as much as the
        first, and their share follows what they contribute. */}
    <section class="cta-block">
      <h2>{members.length ? 'Know this industry too?' : 'Know this industry?'}</h2>
      <p>
        Help supervise the agents building software, data and promotion for {niche.name}. You bring
        what you know about how the business actually works; they do the engineering.
        {members.length
          ? ' Several people can be expert on one niche, and each earns from what they themselves contribute.'
          : ''}
      </p>
      <p class="lede">
        <strong>Start at 20%. Earn up to 80%.</strong>
      </p>
      <p>
        <a class="cta button" href={`/opportunities/${niche.slug}`}>
          {members.length ? 'Add your expertise' : 'Claim this niche'}
        </a>
      </p>
    </section>

    {contributions?.length ? (
      <section>
        <h2>Latest knowledge</h2>
        <ul class="items">
          {/* A member's contribution is lifted rather than decorated: the
              highlight is a class on the row, so it reads as the list
              treating their work differently, which is what was sold. */}
          {contributions.map((e) => (
            <li class={`item${plans[e.influencer_id] ? ' highlighted' : ''}`} key={e.id}>
              <div class="item-body">
                <p class="item-title">{e.event_type.replace(/_/g, ' ')}</p>
                <p class="item-meta">
                  <a href={`/@${e.handle ?? ''}`}>{e.display_name ?? e.handle ?? 'operator'}</a>{' '}
                  <PlanBadge plan={plans[e.influencer_id] ?? 'free'} /> ·{' '}
                  <Relative at={e.verified_at ?? e.created_at} />
                </p>
              </div>
            </li>
          ))}
        </ul>
      </section>
    ) : null}

    <section>
      <h2>How the share works</h2>
      <TierTable tiers={tiers} />
    </section>
  </Layout>
);

/** Every niche looking for someone who knows it. */
export const OpportunitiesPage = ({ user, opportunities, tiers }) => (
  <Layout
    user={user}
    title="Opportunities"
    canonical="/opportunities"
    description="Niches looking for someone who knows the industry. Start at 20% of the revenue you help create, earn up to 80%."
  >
    <section class="hero">
      <h1>Know the niche. Run the AI.</h1>
      <p class="lede">
        Turn what you know about an industry into software, data and a business. You supply the
        judgement; the agents do the building, the research and the promotion. A niche takes as many
        experts as know it: you are not competing for a seat, you are paid for what you contribute.
      </p>
      <p class="stats">
        <strong>Start at 20% of the revenue you help create. Earn up to 80%.</strong>
      </p>
    </section>

    <section>
      <h2>Niches looking for experts</h2>
      {opportunities.length === 0 ? (
        <p class="muted empty">No open niches right now.</p>
      ) : (
        <ul class="cards">
          {opportunities.map((o) => (
            <li class="card" key={o.slug}>
              <a class="card-title" href={`/opportunities/${o.slug}`}>
                {o.name}
              </a>
              <p class="card-desc muted">{o.description}</p>
              <p class="small">
                {o.score === null || o.score === undefined ? (
                  // A score nobody has measured is not a zero, and printing one
                  // would be inventing precision this page does not have.
                  <span class="muted">not scored yet</span>
                ) : (
                  <>Opportunity {o.score}/100</>
                )}
                {' · '}
                {o.member_count > 0
                  ? `${o.member_count} expert${o.member_count === 1 ? '' : 's'} · room for more`
                  : 'no experts yet'}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>

    <section>
      <h2>The more value you contribute, the more you own</h2>
      <TierTable tiers={tiers} />
      <p class="muted small">
        Score comes from contributions somebody verified. Volume alone does not move it: repeated
        small submissions are worth less each time, and anything claiming a customer or a payment
        needs an outside reference before it counts.
      </p>
    </section>
  </Layout>
);

/** The ten questions, and the page that decides whether someone bothers. */
const CLAIM_QUESTIONS = [
  ['experience', 'What is your experience in this niche?'],
  ['best', 'Which parts do you know best?'],
  ['tools', 'What software or tools do people in the niche use now?'],
  ['problems', 'What is bad about those tools?'],
  ['build', 'What would you build or change?'],
  ['where', 'Where do customers in this niche spend time?'],
  ['trusted', 'What sources do you trust?'],
  ['avoid', 'What sources should the agents avoid?'],
  ['review', 'Can you review agent questions periodically?'],
  ['audience', 'What audience, relationships or distribution do you have, if any?'],
];

export const OpportunityPage = ({
  user,
  opportunity,
  tiers,
  claim,
  members = [],
  notice,
  error,
}) => (
  <Layout
    user={user}
    title={opportunity.name}
    canonical={`/opportunities/${opportunity.slug}`}
    description={opportunity.description}
  >
    <Notice notice={notice} error={error} />

    <section class="hero">
      <h1>{opportunity.name}</h1>
      <p class="lede">{opportunity.description}</p>
      <p class="stats">
        {opportunity.score === null || opportunity.score === undefined
          ? 'Not scored yet'
          : `Opportunity score ${opportunity.score}/100`}{' '}
        · Starting share 20% · Maximum 80%
      </p>
    </section>

    {opportunity.rationale ? (
      <section>
        <h2>Why it matters</h2>
        <p>{opportunity.rationale}</p>
      </section>
    ) : null}

    {Object.keys(asJson(opportunity.dimensions)).length ? (
      <section>
        <h2>How that score is made</h2>
        <ul class="dimensions">
          {Object.entries(asJson(opportunity.dimensions)).map(([k, v]) => (
            <li key={k}>
              <span class="dim-name">{k.replace(/_/g, ' ')}</span> <span class="num">{v}</span>
            </li>
          ))}
        </ul>
      </section>
    ) : null}

    <section>
      <h2>{members.length ? 'Add your expertise' : 'Claim this niche'}</h2>
      {members.length ? (
        <p class="muted">
          {members.length === 1
            ? `${members[0].display_name ?? members[0].handle} already covers this niche.`
            : `${members.length} people already cover this niche.`}{' '}
          More than one person can be expert here. Everyone's share follows their own verified
          contribution, so joining does not take anything from anybody who is not contributing.
        </p>
      ) : null}
      {claim ? (
        <p class="feedback ok" role="status">
          Your application is {claim.status}. {claim.decision_note ?? ''}
        </p>
      ) : !user ? (
        <p>
          <a
            class="cta button"
            rel="nofollow"
            href={`/login?next=/opportunities/${opportunity.slug}`}
          >
            Sign in to apply
          </a>
        </p>
      ) : (
        <form method="post" action={`/opportunities/${opportunity.slug}/claim`} class="stack">
          {CLAIM_QUESTIONS.map(([key, label]) => (
            <p key={key}>
              <label for={`q-${key}`}>{label}</label>
              <textarea id={`q-${key}`} name={`answers.${key}`} rows="2" maxlength="2000" />
            </p>
          ))}
          <p>
            <button type="submit" class="cta">
              Apply to operate this niche
            </button>
          </p>
        </form>
      )}
    </section>

    <section>
      <h2>What you would earn</h2>
      <TierTable tiers={tiers} />
    </section>
  </Layout>
);

/**
 * A public profile. The tier is public because it is a credential; what
 * somebody earns is not, unless they say so.
 */
export const InfluencerPage = ({ user, influencer, plan = 'free' }) => (
  <Layout
    user={user}
    title={influencer.display_name ?? influencer.handle}
    canonical={`/@${influencer.handle}`}
    description={`${influencer.display_name ?? influencer.handle} operates ${influencer.niches.length} niche(s) on this site.`}
  >
    <section class="hero">
      <h1>
        {influencer.display_name ?? influencer.handle} <PlanBadge plan={plan} />
      </h1>
      <p class="lede">Knowledge Influencer</p>
      <p class="stats">
        <Num n={influencer.totals.verified} /> verified contributions ·{' '}
        <Num n={influencer.totals.corrections} /> material corrections · joined{' '}
        <Relative at={influencer.created_at} />
      </p>
    </section>

    <section>
      <h2>Niches</h2>
      {influencer.niches.length === 0 ? (
        <p class="muted empty">Not operating a niche yet.</p>
      ) : (
        <ul class="cards">
          {influencer.niches.map((n) => (
            <li class="card" key={n.slug}>
              <a class="card-title" href={`/${n.slug}`}>
                {n.name}
              </a>
              <p class="card-desc muted">{n.tier_slug.replace(/-/g, ' ')}</p>
              <p class="small">
                Revenue share {formatBps(n.share_bps)} · <Num n={n.verified_count} /> verified
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  </Layout>
);

/** The operator's own view: what needs them, and where they stand. */
export const InfluencerDashboard = ({
  user,
  niches,
  contributions,
  tiers,
  questions = [],
  questionCounts = {},
  notice,
  error,
}) => (
  <Layout user={user} title="Your niches">
    <Notice notice={notice} error={error} />

    {/* First on the page, because this is the thing that actually wants a
        human today. Everything below it is a record of what already happened. */}
    <QuestionsPanel questions={questions} next="/dashboard/niches" />

    <h1>Your niches</h1>
    <p class="muted">
      <a href="/dashboard/payouts">Your payouts</a> · <a href="/opportunities">Find a niche</a>
    </p>
    {niches.length === 0 ? (
      <p class="muted empty">
        You are not operating a niche yet. <a href="/opportunities">Find one</a>.
      </p>
    ) : (
      <ul class="cards">
        {niches.map((n) => {
          const next = nextTierFor(Number(n.score), tiers);
          return (
            <li class="card" key={n.slug}>
              <a class="card-title" href={`/${n.slug}`}>
                {n.name}
              </a>
              <p class="card-desc muted">
                {n.tier_slug.replace(/-/g, ' ')} · revenue share {formatBps(n.share_bps)}
              </p>
              <p class="small">
                Score <Num n={n.score} /> · <Num n={n.verified_count} /> verified ·{' '}
                <Num n={n.pending_count} /> awaiting review
              </p>
              <p class="small">
                {next ? (
                  <>
                    {next.remaining} more to {next.name} ({formatBps(next.shareBps)})
                  </>
                ) : (
                  <>At the top of the ladder.</>
                )}
              </p>
              <p class="card-links small">
                <a href={`/dashboard/niches/${n.slug}/questions`}>
                  Questions
                  {questionCounts[String(n.id)] ? ` (${questionCounts[String(n.id)]})` : ''}
                </a>{' '}
                · <a href={`/dashboard/niches/${n.slug}/revenue`}>Revenue</a>
              </p>
            </li>
          );
        })}
      </ul>
    )}

    <section>
      <h2>Your contributions</h2>
      {contributions.length === 0 ? (
        <p class="muted empty">Nothing recorded yet.</p>
      ) : (
        <table class="table small">
          <thead>
            <tr>
              <th>When</th>
              <th>Niche</th>
              <th>What</th>
              <th>Points</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {contributions.map((e) => (
              <tr key={e.id}>
                <td>
                  <Relative at={e.created_at} />
                </td>
                <td>
                  <a href={`/${e.niche_slug}`}>{e.niche_name}</a>
                </td>
                <td>{e.event_type.replace(/_/g, ' ')}</td>
                <td class="num">{e.points}</td>
                <td>
                  <span class={`status ${e.status === 'verified' ? 'ok' : 'idle'}`}>
                    <i /> {e.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>

    <section>
      <h2>The ladder</h2>
      <TierTable tiers={tiers} current={niches[0]?.tier_slug ?? null} />
    </section>
  </Layout>
);

/**
 * The admin's queue. Verifying is what moves money, so every button here
 * writes an audit row.
 */
export const KnowledgeAdmin = ({ user, claims, pending, audit, notice, error }) => (
  <Layout user={user} title="Knowledge admin" wide>
    <Notice notice={notice} error={error} />
    <h1>Knowledge Influencers</h1>

    <section>
      <h2>Claims awaiting a decision</h2>
      {claims.length === 0 ? (
        <p class="muted empty">Nothing waiting.</p>
      ) : (
        <table class="table small">
          <thead>
            <tr>
              <th>Niche</th>
              <th>Who</th>
              <th>Applied</th>
              <th>Decide</th>
            </tr>
          </thead>
          <tbody>
            {claims.map((c) => (
              <tr key={c.id}>
                <td>
                  <a href={`/${c.niche_slug}`}>{c.niche_name}</a>
                </td>
                <td>{c.display_name ?? c.handle ?? c.email}</td>
                <td>
                  <Relative at={c.created_at} />
                </td>
                <td>
                  <form method="post" action={`/admin/knowledge/claims/${c.id}`} class="inline">
                    <input type="hidden" name="decision" value="approve" />
                    <button type="submit">Approve</button>
                  </form>
                  <form method="post" action={`/admin/knowledge/claims/${c.id}`} class="inline">
                    <input type="hidden" name="decision" value="reject" />
                    <button type="submit" class="ghost">
                      Reject
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>

    <section>
      <h2>Contributions awaiting verification</h2>
      {pending.length === 0 ? (
        <p class="muted empty">Nothing waiting.</p>
      ) : (
        <table class="table small">
          <thead>
            <tr>
              <th>Niche</th>
              <th>Who</th>
              <th>What</th>
              <th>Points</th>
              <th>Evidence</th>
              <th>Decide</th>
            </tr>
          </thead>
          <tbody>
            {pending.map((e) => (
              <tr key={e.id}>
                <td>
                  <a href={`/${e.niche_slug}`}>{e.niche_name}</a>
                </td>
                <td>
                  <a href={`/@${e.handle ?? ''}`}>{e.display_name ?? e.handle}</a>
                </td>
                <td>{e.event_type.replace(/_/g, ' ')}</td>
                <td class="num">{e.points}</td>
                {/* Crawled and submitted text, rendered as text. Never as markup. */}
                <td class="evidence">{JSON.stringify(e.evidence).slice(0, 240)}</td>
                <td>
                  <form
                    method="post"
                    action={`/admin/knowledge/contributions/${e.id}`}
                    class="inline"
                  >
                    <input type="hidden" name="decision" value="verify" />
                    <button type="submit">Verify</button>
                  </form>
                  <form
                    method="post"
                    action={`/admin/knowledge/contributions/${e.id}`}
                    class="inline"
                  >
                    <input type="hidden" name="decision" value="reject" />
                    <button type="submit" class="ghost">
                      Reject
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>

    <section>
      <h2>Audit</h2>
      {audit.length === 0 ? (
        <p class="muted empty">Nothing yet.</p>
      ) : (
        <table class="table small">
          <thead>
            <tr>
              <th>When</th>
              <th>Who</th>
              <th>Action</th>
              <th>Subject</th>
            </tr>
          </thead>
          <tbody>
            {audit.map((a) => (
              <tr key={a.id}>
                <td>
                  <Relative at={a.created_at} />
                </td>
                <td>{a.actor_handle ?? a.actor_email ?? 'system'}</td>
                <td>{a.action}</td>
                <td>
                  {a.subject_type} {a.subject_id}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  </Layout>
);

/**
 * One question, with the three things a person can say about it.
 *
 * Everything from the agent is rendered as text. `context` in particular is
 * whatever it scraped on the way to being stuck, so it is untrusted input on
 * its way to a human and then back to a model: it goes in a quoted block that
 * says where it came from, and nothing on either side of the loop treats it as
 * an instruction.
 */
export const QuestionCard = ({ question, next }) => (
  <li class="card question" key={question.id}>
    <p class="card-title">
      {question.urgency === 'high' ? <span class="badge urgent">urgent</span> : null}{' '}
      {question.title}
    </p>
    {question.niche_slug ? (
      <p class="card-desc muted small">
        <a href={`/${question.niche_slug}`}>{question.niche_name}</a>
        {question.status === 'researching' ? ' · sent back for research' : ''}
      </p>
    ) : null}

    <p>{question.question}</p>

    {question.context ? (
      <details class="agent-context">
        <summary class="agent-summary">What the agent found</summary>
        {/* Quoted, not obeyed. This is crawled text. */}
        <blockquote class="agent-quote">{question.context}</blockquote>
      </details>
    ) : null}

    <form method="post" action={`/dashboard/questions/${question.id}/answer`} class="stack">
      <input type="hidden" name="next" value={next ?? '/dashboard/niches'} />
      {asJsonArray(question.options).length ? (
        <fieldset class="field">
          <legend class="label">Which is it?</legend>
          {asJsonArray(question.options).map((o) => (
            <label class="check" key={o.id}>
              <input type="radio" name="optionId" value={o.id} />
              <span>{o.label}</span>
            </label>
          ))}
        </fieldset>
      ) : null}

      <label class="field">
        <span class="label">Your answer</span>
        <textarea name="answer" rows="3" maxlength="8000" placeholder="How it actually works." />
        <span class="help">
          What you know, in your own words. This becomes niche knowledge and a scored contribution.
        </span>
      </label>

      <p class="row">
        <button type="submit" name="kind" value="answered" class="btn-primary">
          Answer
        </button>
        <button type="submit" name="kind" value="insufficient_context" class="btn-ghost">
          Not enough context
        </button>
        <button type="submit" name="kind" value="needs_research" class="btn-ghost">
          Ask the agent to research more
        </button>
      </p>
      <p class="help muted small">
        Saying you cannot answer costs you nothing. A guess that gets verified becomes wrong
        knowledge, which is worse for the niche than an unanswered question.
      </p>
    </form>
  </li>
);

/** The dashboard panel: what is waiting on this person, across every niche. */
export const QuestionsPanel = ({ questions, next }) => (
  <section>
    <h2>Your agent needs you</h2>
    {questions.length === 0 ? (
      <p class="muted empty">Nothing waiting. The agents will ask when they get stuck.</p>
    ) : (
      <>
        <p class="muted small">
          {questions.length} {questions.length === 1 ? 'question needs' : 'questions need'} expert
          judgement. Each should take a minute or two.
        </p>
        <ul class="cards">
          {questions.map((q) => (
            <QuestionCard key={q.id} question={q} next={next} />
          ))}
        </ul>
      </>
    )}
  </section>
);

/** One niche's queue, open and recently settled. */
export const NicheQuestions = ({ user, niche, questions, settled, configured, notice, error }) => (
  <Layout user={user} title={`${niche.name} questions`}>
    <Notice notice={notice} error={error} />
    <h1>{niche.name}: agent questions</h1>
    <p class="muted">
      <a href={`/${niche.slug}`}>The niche</a> · <a href="/dashboard/niches">Your niches</a>
    </p>

    {configured ? null : (
      <p class="alert info">
        No agent is wired to this deployment yet (<code>CHOVY_SIGNING_SECRET</code> is unset), so
        nothing can ask a question.
      </p>
    )}

    <QuestionsPanel questions={questions} next={`/dashboard/niches/${niche.slug}/questions`} />

    <section>
      <h2>Settled</h2>
      {settled.length === 0 ? (
        <p class="muted empty">Nothing answered yet.</p>
      ) : (
        <ul class="items">
          {settled.map((q) => (
            <li class="item" key={q.id}>
              <div class="item-body">
                <p class="item-title">{q.title}</p>
                <p class="item-meta">
                  answered <Relative at={q.answered_at ?? q.created_at} />
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  </Layout>
);
