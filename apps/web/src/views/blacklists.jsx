import { Layout } from './Layout.jsx';

/**
 * Blacklists: /blacklists and /blacklists/sms. Numbers smshub.dev users
 * flagged as spam or scam texters, as a page, a lookup and plain downloads.
 */

const day = (iso) => (iso ? new Date(iso).toISOString().slice(0, 10) : '');

const reasonText = (r) =>
  ['scam', 'spam']
    .filter((k) => r?.[k])
    .map((k) => `${r[k]} ${k}`)
    .join(', ');

const Lookup = ({ value = '' }) => (
  <form method="get" action="/blacklists/sms" class="inline">
    <input
      name="q"
      value={value}
      placeholder="A phone number, e.g. +1 888 555 1234"
      aria-label="Phone number"
      required
    />
    <button type="submit">Check</button>
  </form>
);

const Downloads = () => (
  <p>
    Download: <a href="/blacklists/sms.txt">sms.txt</a> (one E.164 number per line) ·{' '}
    <a href="/blacklists/sms.json">sms.json</a> · feed <a href="/f/sms-blacklist">sms-blacklist</a>{' '}
    · API <code>GET /api/v1/blacklists/sms/&lt;number&gt;</code>. Free to use; updated every 15
    minutes from <a href="https://smshub.dev">smshub.dev</a>.
  </p>
);

export function BlacklistsIndexPage({ user, smsCount }) {
  return (
    <Layout
      user={user}
      canonical="/blacklists"
      title="Blacklists"
      description="Public blacklists of spam and scam senders, free to download and block."
    >
      <section class="hero">
        <h1>Blacklists</h1>
        <p class="lede">
          Senders people flagged as spam or scams, published so anyone can block them.
        </p>
        <ul>
          <li>
            <a href="/blacklists/sms">SMS</a>: {smsCount} numbers flagged by smshub.dev users
          </li>
          <li>
            <a href="/reputation">IPs and domains</a>: the reviewed /traffic list, abuse.ch and live
            DNS blocklists
          </li>
        </ul>
      </section>
    </Layout>
  );
}

export function SmsBlacklistPage({ user, rows, error, query }) {
  return (
    <Layout
      user={user}
      canonical="/blacklists/sms"
      title="SMS spam and scam number blacklist"
      description="Phone numbers smshub.dev users flagged as spam or scam texters. Free to look up, download and block."
    >
      <section class="hero">
        <h1>SMS blacklist</h1>
        {error ? <p class="error">{error}</p> : null}
        <p class="lede">
          Numbers that texted smshub.dev users and were flagged as spam or a scam. Each row counts
          the flags and the people who made them; who flagged a number, and which line it texted,
          are never published. A number nobody flags any more leaves the list within a day.
        </p>
        <Lookup value={query ?? ''} />
        <Downloads />
        {rows.length === 0 ? (
          <p>No numbers are listed right now.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Number</th>
                <th>Flags</th>
                <th>People</th>
                <th>First flagged</th>
                <th>Last flagged</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ data }) => (
                <tr>
                  <td>
                    <a href={`/blacklists/sms/${data.number.slice(1)}`}>
                      <code>{data.display ?? data.number}</code>
                    </a>
                  </td>
                  <td>{reasonText(data.reasons)}</td>
                  <td>{data.reporters}</td>
                  <td>{day(data.firstFlaggedAt)}</td>
                  <td>{day(data.lastFlaggedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </Layout>
  );
}

export function SmsNumberPage({ user, number, entry }) {
  const data = entry?.data;
  return (
    <Layout
      user={user}
      canonical={`/blacklists/sms/${number.slice(1)}`}
      title={`${data?.display ?? number}: SMS blacklist`}
      description={`Is ${number} a spam or scam texter? What smshub.dev users reported.`}
    >
      <section class="hero">
        <h1>
          <code>{data?.display ?? number}</code>
        </h1>
        {!entry ? (
          <p>
            Not on the SMS blacklist. That only means no smshub.dev user has flagged it, not that it
            is safe.
          </p>
        ) : entry.listed ? (
          <p>
            <strong>Listed.</strong> Flagged {reasonText(data.reasons)} by {data.reporters}{' '}
            {data.reporters === 1 ? 'person' : 'people'}, first on {day(data.firstFlaggedAt)}, last
            on {day(data.lastFlaggedAt)}.
          </p>
        ) : (
          <p>
            Was listed ({reasonText(data.reasons)}) until {data.lastListed}; nobody flags it any
            more.
          </p>
        )}
        <Lookup />
        <p>
          <a href="/blacklists/sms">The whole list</a>
        </p>
      </section>
    </Layout>
  );
}
