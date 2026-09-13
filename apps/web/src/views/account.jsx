/**
 * The way out, as pages: end a plan, take the data, delete the account. Each
 * page is one form posting to the endpoint the OpenSaaS descriptor names, so
 * the page and the API are the same door.
 */
import { config } from '@nichedb/config';
import { Notice } from './components.jsx';
import { Layout } from './Layout.jsx';

const when = (d) => new Date(d).toLocaleDateString('en-US');

export const BillingPage = ({ user, plans = [], notice, error }) => (
  <Layout user={user} title="Billing">
    <h1>Billing</h1>
    <Notice notice={notice} error={error} />
    <section class="panel">
      <h2>Running plans</h2>
      {plans.length === 0 ? (
        <p class="muted small">
          Nothing is running. <a href="/premium">Premium</a> and <a href="/pro">Pro</a> are prepaid
          terms: they end on their own and never renew by themselves.
        </p>
      ) : (
        <ul>
          {plans.map((p) => (
            <li>
              <strong>{p.plan}</strong> until {when(p.expires_at)}
              {p.terms > 1 ? ` (${p.terms} terms)` : ''}
            </li>
          ))}
        </ul>
      )}
    </section>
    {plans.length > 0 ? (
      <section class="panel">
        <h2>End a plan</h2>
        <p class="small muted">
          One click. The plan stops today and nothing is refunded; a prepaid term you end is a term
          you gave up. A term that runs out on its own costs nothing to leave alone.
        </p>
        {plans.map((p) => (
          <form method="post" action="/api/v1/billing/cancel" style="display:inline">
            <input type="hidden" name="plan" value={p.plan} />
            <button type="submit" class="ghost">
              End {p.plan} now
            </button>
          </form>
        ))}
      </section>
    ) : null}
    <p class="small muted">
      What this page does is also written down for machines at{' '}
      <a href="/.well-known/opensaas.json">/.well-known/opensaas.json</a> (
      <a href="https://logicsrc.com/opensaas">OpenSaaS</a>). <a href="/account/export">Export</a> ·{' '}
      <a href="/account/delete">Delete the account</a>
    </p>
  </Layout>
);

export const ExportPage = ({ user }) => (
  <Layout user={user} title="Export your data">
    <h1>Export your data</h1>
    <section class="panel">
      <p class="small">
        One JSON file with everything this account holds: the account row, API keys by name and
        prefix (never the key), passkeys by id, follows, plans and payments, submissions, the
        profiles you claimed, the sources and feeds you made. It is built when you ask and arrives
        at once.
      </p>
      <form method="post" action="/api/v1/account/export">
        <button type="submit">Download {config.siteName.toLowerCase()}-account.json</button>
      </form>
    </section>
    <p class="small muted">
      <a href="/account/billing">Billing</a> · <a href="/account/delete">Delete the account</a>
    </p>
  </Layout>
);

export const DeletePage = ({ user, notice, error }) => (
  <Layout user={user} title="Delete the account">
    <h1>Delete the account</h1>
    <Notice notice={notice} error={error} />
    <section class="panel">
      <p class="small">
        Two steps: ask here, then follow the link sent to <strong>{user.email}</strong>. The link
        works once and for {30} minutes. Deletion is immediate and keeps nothing: sessions,
        passkeys, keys, follows, plans and payments go with the account. A running plan is not
        refunded. A profile you claimed stays in the directory, unclaimed; a source or feed you made
        stays for the people who follow it, with no owner.
      </p>
      <p class="small">
        Want your data first? <a href="/account/export">Export it</a>.
      </p>
      <form method="post" action="/api/v1/account/delete">
        <button type="submit" class="danger">
          Send me the deletion link
        </button>
      </form>
    </section>
  </Layout>
);

export const DeletedPage = ({ email = null, error = null }) => (
  <Layout title={error ? 'Not deleted' : 'Deleted'}>
    <h1>{error ? 'Not deleted' : 'Deleted'}</h1>
    {error ? (
      <p class="feedback err">
        {error} <a href="/account/delete">Ask again</a>.
      </p>
    ) : (
      <p class="feedback ok">
        {email ? `${email} is gone.` : 'The account is gone.'} Nothing of it is kept. Thank you for
        having been here.
      </p>
    )}
  </Layout>
);
