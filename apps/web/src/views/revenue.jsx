import { formatBps, formatMinor } from '@nichedb/knowledge';
import { Notice, Num, Relative } from './components.jsx';
import { Layout } from './Layout.jsx';

/**
 * The money pages.
 *
 * Every amount on them is a stored integer of minor units, divided by a
 * hundred at the last possible moment by `formatMinor`. Nothing here does
 * arithmetic; if a number looks wrong the ledger is wrong, not the page.
 */

const Money = ({ minor, currency = 'USD' }) => (
  <span class="num">{formatMinor(minor, currency)}</span>
);

const StatusPill = ({ status }) => (
  <span
    class={`status ${status === 'paid' ? 'ok' : status === 'failed' || status === 'reversed' ? 'err' : 'idle'}`}
  >
    <i /> {status}
  </span>
);

/** What one person is owed, where it goes, and what has already gone. */
export const PayoutsPage = ({ user, balance, allocations, payouts, account, notice, error }) => (
  <Layout user={user} title="Payouts">
    <Notice notice={notice} error={error} />
    <h1>Payouts</h1>

    <section>
      <p class="stats">
        Owed <Money minor={balance.owedMinor} /> · scheduled <Money minor={balance.inFlightMinor} />{' '}
        · paid <Money minor={balance.paidMinor} />
        {balance.reversedMinor > 0 ? (
          <>
            {' '}
            · reversed <Money minor={balance.reversedMinor} />
          </>
        ) : null}
      </p>
    </section>

    <section>
      <h2>Where it goes</h2>
      <form method="post" action="/dashboard/payouts/address" class="stack">
        <label class="field">
          <span class="label">Payout address</span>
          <input
            type="text"
            name="address"
            value={account?.address ?? ''}
            maxlength="200"
            placeholder="The address your share is sent to"
          />
          <span class="help">
            {account?.address
              ? account.verified_at
                ? 'Confirmed. Payouts can be scheduled against it.'
                : 'Waiting on an admin to confirm it. Nothing is sent until then.'
              : 'Without an address there is nowhere to send your money.'}
          </span>
        </label>
        <p>
          <button type="submit" class="btn-primary">
            Save
          </button>
        </p>
        <p class="help muted small">
          Changing the address clears its confirmation, on purpose: whoever confirmed the old one
          did not confirm this one.
        </p>
      </form>
    </section>

    <section>
      <h2>Your share, event by event</h2>
      {allocations.length === 0 ? (
        <p class="muted empty">Nothing yet. A niche earns, and your share of it appears here.</p>
      ) : (
        <table class="table small">
          <thead>
            <tr>
              <th>When</th>
              <th>Niche</th>
              <th>Source</th>
              <th>Your share</th>
              <th>Amount</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {allocations.map((a) => (
              <tr key={a.id}>
                <td>
                  <Relative at={a.occurred_at} />
                </td>
                <td>{a.niche_name ?? '—'}</td>
                <td>{a.source_type.replace(/_/g, ' ')}</td>
                {/* The share as it stood when this settled, not today's. */}
                <td>{formatBps(a.share_bps)}</td>
                <td>
                  <Money minor={a.amount_minor} currency={a.currency} />
                </td>
                <td>
                  <StatusPill status={a.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>

    <section>
      <h2>Payments</h2>
      {payouts.length === 0 ? (
        <p class="muted empty">None yet.</p>
      ) : (
        <table class="table small">
          <thead>
            <tr>
              <th>When</th>
              <th>Amount</th>
              <th>Status</th>
              <th>Reference</th>
            </tr>
          </thead>
          <tbody>
            {payouts.map((p) => (
              <tr key={p.id}>
                <td>
                  <Relative at={p.paid_at ?? p.created_at} />
                </td>
                <td>
                  <Money minor={p.amount_minor} currency={p.currency} />
                </td>
                <td>
                  <StatusPill status={p.status} />
                </td>
                <td class="small muted">{p.external_ref ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  </Layout>
);

/** A niche's books, for the people who operate it. */
export const NicheRevenue = ({ user, niche, totals, events, members, mine }) => (
  <Layout user={user} title={`${niche.name} revenue`}>
    <h1>{niche.name}: revenue</h1>
    <p class="muted">
      <a href={`/${niche.slug}`}>The niche</a> ·{' '}
      <a href={`/dashboard/niches/${niche.slug}/questions`}>Questions</a> ·{' '}
      <a href="/dashboard/payouts">Your payouts</a>
    </p>

    <section>
      <p class="stats">
        Gross <Money minor={totals.grossMinor} /> · shared <Money minor={totals.netMinor} /> · of
        which machine <Money minor={totals.machineMinor} /> · <Num n={totals.events} /> events
      </p>
      <p class="muted small">
        Shared is gross less what it cost to take the money: payment fees, network fees and the
        infrastructure a request actually used. Nothing else comes off.
      </p>
    </section>

    <section>
      <h2>Who it splits between</h2>
      <table class="table small">
        <thead>
          <tr>
            <th>Operator</th>
            <th>Tier</th>
            <th>Share now</th>
          </tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.user_id}>
              <td>{m.display_name ?? m.handle}</td>
              <td>{m.tier_slug.replace(/-/g, ' ')}</td>
              <td>{formatBps(m.share_bps)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p class="muted small">
        This is today's split. An earning already settled keeps the share that was in force when it
        settled, which is why the table below can disagree with this one.
      </p>
    </section>

    <section>
      <h2>Your share here</h2>
      {mine.length === 0 ? (
        <p class="muted empty">Nothing allocated to you from this niche yet.</p>
      ) : (
        <table class="table small">
          <thead>
            <tr>
              <th>When</th>
              <th>Share then</th>
              <th>Amount</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {mine.map((a) => (
              <tr key={a.id}>
                <td>
                  <Relative at={a.occurred_at} />
                </td>
                <td>{formatBps(a.share_bps)}</td>
                <td>
                  <Money minor={a.amount_minor} currency={a.currency} />
                </td>
                <td>
                  <StatusPill status={a.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>

    <section>
      <h2>Earnings</h2>
      {events.length === 0 ? (
        <p class="muted empty">Nothing recorded yet.</p>
      ) : (
        <table class="table small">
          <thead>
            <tr>
              <th>When</th>
              <th>Source</th>
              <th>Gross</th>
              <th>Cost</th>
              <th>Shared</th>
              <th>Settled</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id}>
                <td>
                  <Relative at={e.occurred_at} />
                </td>
                <td>{e.source_type.replace(/_/g, ' ')}</td>
                <td>
                  <Money minor={e.gross_amount_minor} currency={e.currency} />
                </td>
                <td>
                  <Money minor={e.direct_cost_minor} currency={e.currency} />
                </td>
                <td>
                  <Money minor={e.net_amount_minor} currency={e.currency} />
                </td>
                <td>{e.finalized_at ? <Relative at={e.finalized_at} /> : <em>pending</em>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  </Layout>
);

/** The admin's payout run. Every button here writes an audit row. */
export const PayoutsAdmin = ({ user, owed, payouts, events, notice, error }) => (
  <Layout user={user} title="Payouts" wide>
    <Notice notice={notice} error={error} />
    <h1>Payouts</h1>

    <section>
      <h2>Owed</h2>
      {owed.length === 0 ? (
        <p class="muted empty">Nobody is owed anything.</p>
      ) : (
        <table class="table small">
          <thead>
            <tr>
              <th>Who</th>
              <th>Owed</th>
              <th>Address</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {owed.map((o) => (
              <tr key={o.influencer_id}>
                <td>{o.display_name ?? o.handle ?? o.email}</td>
                <td>
                  <Money minor={o.owed} />
                </td>
                <td>
                  {!o.has_address ? (
                    <span class="muted">none on file</span>
                  ) : o.verified ? (
                    <span class="status ok">
                      <i /> confirmed
                    </span>
                  ) : (
                    <form
                      method="post"
                      action={`/admin/payouts/verify/${o.influencer_id}`}
                      class="inline"
                    >
                      <button type="submit" class="btn-sm">
                        Confirm address
                      </button>
                    </form>
                  )}
                </td>
                <td>
                  {o.verified ? (
                    <form
                      method="post"
                      action={`/admin/payouts/schedule/${o.influencer_id}`}
                      class="inline"
                    >
                      <button type="submit" class="btn-primary btn-sm">
                        Schedule
                      </button>
                    </form>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p class="muted small">
        Scheduling gathers what somebody is owed into one payout and marks those allocations spoken
        for. Nothing is sent from here: the money moves out of band and the reference is recorded
        below.
      </p>
    </section>

    <section>
      <h2>Payouts</h2>
      {payouts.length === 0 ? (
        <p class="muted empty">None yet.</p>
      ) : (
        <table class="table small">
          <thead>
            <tr>
              <th>Who</th>
              <th>Amount</th>
              <th>Status</th>
              <th>Settle</th>
            </tr>
          </thead>
          <tbody>
            {payouts.map((p) => (
              <tr key={p.id}>
                <td>{p.display_name ?? p.handle ?? p.email}</td>
                <td>
                  <Money minor={p.amount_minor} currency={p.currency} />
                </td>
                <td>
                  <StatusPill status={p.status} />
                  {p.failure_reason ? <span class="muted small"> {p.failure_reason}</span> : null}
                </td>
                <td>
                  {p.status === 'scheduled' || p.status === 'processing' ? (
                    <>
                      <form method="post" action={`/admin/payouts/${p.id}/paid`} class="inline">
                        <input
                          type="text"
                          name="ref"
                          placeholder="reference"
                          size="14"
                          maxlength="200"
                        />
                        <button type="submit" class="btn-sm">
                          Paid
                        </button>
                      </form>
                      <form method="post" action={`/admin/payouts/${p.id}/failed`} class="inline">
                        <button type="submit" class="btn-ghost btn-sm">
                          Failed
                        </button>
                      </form>
                    </>
                  ) : (
                    <span class="muted small">{p.external_ref ?? ''}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>

    <section>
      <h2>Earnings</h2>
      {events.length === 0 ? (
        <p class="muted empty">Nothing recorded yet.</p>
      ) : (
        <table class="table small">
          <thead>
            <tr>
              <th>When</th>
              <th>Niche</th>
              <th>Source</th>
              <th>Gross</th>
              <th>Shared</th>
              <th>Split</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id}>
                <td>
                  <Relative at={e.occurred_at} />
                </td>
                <td>{e.niche_name ?? <span class="muted">unattributed</span>}</td>
                <td>{e.source_type.replace(/_/g, ' ')}</td>
                <td>
                  <Money minor={e.gross_amount_minor} currency={e.currency} />
                </td>
                <td>
                  <Money minor={e.net_amount_minor} currency={e.currency} />
                </td>
                <td>{e.finalized_at ? `${e.allocations} ways` : <em>pending</em>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  </Layout>
);
