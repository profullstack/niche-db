/**
 * Credit codes and invites, as pages. Each form posts to the same endpoint an
 * API caller uses (/credits/redeem, /invites); the API answers the same
 * handlers under /api/v1.
 */
import { config } from '@nichedb/config';
import { Notice } from './components.jsx';
import { Layout } from './Layout.jsx';

const when = (d) => (d ? new Date(d).toLocaleDateString('en-US') : '');

/** "Have a code?": on /settings and /account/billing. */
export const RedeemPanel = ({ back = '/settings' }) => (
  <section class="panel" id="code">
    <h2>Have a code?</h2>
    <p class="muted small">
      A code from us is worth days of Premium. It is added to any term you already hold. Each code
      works once per account.
    </p>
    <form method="post" action="/credits/redeem" class="row">
      <input type="hidden" name="back" value={back} />
      <input
        type="text"
        name="code"
        required
        maxlength="64"
        autocomplete="off"
        spellcheck="false"
        placeholder="CR-XXXX-XXXX-XXXX-XXXX"
        class="mono"
      />
      <button type="submit" class="cta">
        Redeem
      </button>
    </form>
  </section>
);

export const InvitesPage = ({ user, quota, invites = [], made = null, notice, error }) => (
  <Layout user={user} title="Invites">
    <h1>Invites</h1>
    <Notice notice={notice} error={error} />
    <p class="muted">
      You get {quota.total} invites, and that is the point: an invite says somebody wanted you here.
      When the person you invite creates an account through the emailed link, you each get{' '}
      {config.invites.bonusDays} days of Premium.
    </p>
    {made ? (
      <section class="panel">
        <p class="feedback ok">
          New invite (it is shown once; copy it now):{' '}
          <a class="mono" href={made.url}>
            {made.url}
          </a>
        </p>
      </section>
    ) : null}
    <section class="panel">
      <h2>
        {quota.left} of {quota.total} left
      </h2>
      {quota.left > 0 ? (
        <form method="post" action="/invites" class="row">
          <input
            type="text"
            name="note"
            maxlength="80"
            placeholder="Who is it for? (only you see this)"
          />
          <button type="submit" class="cta">
            Make an invite
          </button>
        </form>
      ) : (
        <p class="muted small">All used. An unused invite you withdraw comes back.</p>
      )}
      {invites.length ? (
        <table class="table">
          <thead>
            <tr>
              <th>For</th>
              <th>Status</th>
              <th>Made</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {invites.map((i) => (
              <tr key={i.id}>
                <td>{i.note || '—'}</td>
                <td>
                  {i.status}
                  {i.used_at ? ` ${when(i.used_at)}` : ''}
                  {i.status === 'open' && i.expires_at ? ` until ${when(i.expires_at)}` : ''}
                </td>
                <td>{when(i.created_at)}</td>
                <td>
                  {i.status === 'open' ? (
                    <form method="post" action={`/invites/${i.id}/revoke`}>
                      <button type="submit" class="ghost small">
                        Withdraw
                      </button>
                    </form>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
    <p class="small muted">
      Want to share more widely? Your referral link on <a href="/settings">Settings</a> has no limit
      and pays you a share of what the people it brings spend. Invites are also at{' '}
      <code>/api/v1/invites</code>, <code>nichedb invites</code> and the MCP tools.
    </p>
  </Layout>
);

const LANDING = {
  ok: null,
  invalid: 'That invite is not one we issued.',
  used: 'That invite has already been used.',
  expired: 'That invite has expired.',
  revoked: 'That invite was withdrawn.',
};

export const InviteLanding = ({ user, code, status }) => (
  <Layout user={user} title="You were invited">
    <section class="auth">
      <h1>{status === 'ok' ? 'You were invited' : 'Invite'}</h1>
      {status === 'ok' ? (
        user ? (
          <p class="feedback">
            You already have an account, so this invite is for somebody else: pass it on. Invites
            only count for a new account.
          </p>
        ) : (
          <>
            <p>
              Somebody on {config.siteName} wanted you here. Create your account and you both get{' '}
              {config.invites.bonusDays} days of Premium as soon as you follow the link we email
              you.
            </p>
            <p>
              <a class="cta button" href="/signup">
                Create your account
              </a>
            </p>
            <p class="muted small">
              Invite <span class="mono">{code}</span> is kept with your sign-up, so the emailed link
              works in any browser.
            </p>
          </>
        )
      ) : (
        <p class="feedback error">
          {LANDING[status] ?? LANDING.invalid} You can still <a href="/signup">create an account</a>
          .
        </p>
      )}
    </section>
  </Layout>
);

export const AdminCreditsPage = ({ user, codes = [], made = null, notice, error }) => (
  <Layout user={user} title="Credit codes">
    <h1>Credit codes</h1>
    <Notice notice={notice} error={error} />
    {made ? (
      <section class="panel">
        <p class="feedback ok">
          New code, worth {made.days} days of Premium (shown once; only its hash is stored):{' '}
          <code class="mono">{made.code}</code>
        </p>
      </section>
    ) : null}
    <section class="panel">
      <h2>Mint</h2>
      <form method="post" action="/admin/credits" class="row">
        <input type="number" name="days" min="1" max="3650" value="30" required />
        <input type="text" name="label" maxlength="120" placeholder="Who it is for" />
        <input type="number" name="max" min="1" max="100000" value="1" title="Redemptions" />
        <input type="number" name="expires_days" min="1" max="3650" placeholder="Expires in days" />
        <button type="submit" class="cta">
          Mint
        </button>
      </form>
      <p class="small muted">
        Also <code>nichedb credits mint --days 30 --label "…"</code> with an admin key.
      </p>
    </section>
    <section class="panel">
      <h2>Codes</h2>
      {codes.length ? (
        <table class="table">
          <thead>
            <tr>
              <th>Label</th>
              <th>Days</th>
              <th>Used</th>
              <th>Expires</th>
              <th>Made</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {codes.map((c) => (
              <tr key={c.id}>
                <td>
                  {c.label || '—'} <span class="muted small mono">{c.id}</span>
                </td>
                <td>{c.days}</td>
                <td>
                  {c.redemptions}/{c.max_redemptions}
                </td>
                <td>{c.revoked_at ? 'revoked' : c.expires_at ? when(c.expires_at) : 'never'}</td>
                <td>{when(c.created_at)}</td>
                <td>
                  {c.revoked_at ? null : (
                    <form method="post" action={`/admin/credits/${c.id}/revoke`}>
                      <button type="submit" class="ghost small">
                        Revoke
                      </button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p class="muted small">None yet.</p>
      )}
    </section>
  </Layout>
);
