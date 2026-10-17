import { CHECKED, DEEPER } from '../lib/reputation.js';
import { Layout } from './Layout.jsx';

/**
 * Reputation: is this IP or domain on a list? One lookup over /traffic,
 * abuse.ch and SURBL. A miss says which lists were checked, never "clean".
 */

const day = (iso) => (iso ? new Date(iso).toISOString().slice(0, 10) : '');

const Lookup = ({ value = '' }) => (
  <form method="get" action="/reputation" class="inline">
    <input
      name="q"
      value={value}
      placeholder="An IP or a domain, e.g. 203.0.113.9 or evil.example"
      aria-label="IP address or domain"
      required
    />
    <button type="submit">Check</button>
  </form>
);

const Checked = ({ type }) => (
  <ul>
    {(type ? CHECKED[type] : [...CHECKED.ip, CHECKED.domain[1]]).map((c) => (
      <li>{c.name}</li>
    ))}
  </ul>
);

const Deeper = () => (
  <section>
    <h2>Need more than a yes or no?</h2>
    <p>
      <a href={DEEPER.url}>{DEEPER.name}</a> adds:
    </p>
    <ul>
      {DEEPER.adds.map((a) => (
        <li>{a}</li>
      ))}
    </ul>
  </section>
);

function Report({ report }) {
  return (
    <>
      {report.listed ? (
        <p class="lede">
          <strong>Listed.</strong> Score {report.score} of 100.
        </p>
      ) : (
        <p class="lede">{report.note}</p>
      )}
      {report.reasons.length ? (
        <ul>
          {report.reasons.map((r) => (
            <li>{r}</li>
          ))}
        </ul>
      ) : null}
      {report.traffic ? (
        <p>
          Banned by {report.traffic.servers} of our servers, first seen{' '}
          {day(report.traffic.first_seen)}, last seen {day(report.traffic.last_seen)}.{' '}
          <a href={`/traffic/ip/${report.query}`}>The /traffic record</a>
        </p>
      ) : null}
      {report.indicators.length ? (
        <table>
          <thead>
            <tr>
              <th>Indicator</th>
              <th>What</th>
              <th>Feeds</th>
              <th>First seen</th>
              <th>Last listed</th>
            </tr>
          </thead>
          <tbody>
            {report.indicators.map((i) => (
              <tr>
                <td>
                  <a href={i.url} rel="nofollow noopener">
                    <code>{i.indicator}</code>
                  </a>
                </td>
                <td>{i.title.split(': ').slice(1).join(': ')}</td>
                <td>{i.feeds.join(', ')}</td>
                <td>{day(i.first_seen)}</td>
                <td>{i.last_listed}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <h2>Checked</h2>
      <Checked type={report.type} />
      <p class="muted">
        abuse.ch data is free to use with credit to abuse.ch. JSON for this answer:{' '}
        <a href={`/api/v1/reputation/${report.query}`}>
          <code>/api/v1/reputation/{report.query}</code>
        </a>
      </p>
    </>
  );
}

export function ReputationPage({ user, query, report, error }) {
  const title = query ? `${query}: reputation` : 'IP and domain reputation';
  return (
    <Layout
      user={user}
      canonical={query ? `/reputation/${query}` : '/reputation'}
      title={title}
      description="Is an IP address or a domain on a blocklist? Free lookups over the human-reviewed /traffic list, abuse.ch malware feeds and SURBL."
      noindex={Boolean(query)}
    >
      <section class="hero">
        <h1>{query ? <code>{query}</code> : 'IP and domain reputation'}</h1>
        {error ? <p class="error">{error}</p> : null}
        {!query ? (
          <p class="lede">
            Is an address or a domain on a list? Free, from data anyone can download: addresses our
            own servers banned and a person approved, malware infrastructure reported to abuse.ch,
            and SURBL.
          </p>
        ) : null}
        {report && !report.error ? <Report report={report} /> : null}
        <Lookup value={query ?? ''} />
        {!query ? (
          <>
            <h2>What it checks</h2>
            <Checked />
            <p>
              From a terminal: <code>nichedb reputation 203.0.113.9</code>. From an agent: the MCP
              tool <code>reputation_lookup</code> at <a href="/docs/mcp">/mcp</a>. The lists:{' '}
              <a href="/traffic">/traffic</a>, <a href="/f/malware-ips">malware IPs</a>,{' '}
              <a href="/f/malware-domains">malware domains</a>.
            </p>
          </>
        ) : null}
      </section>
      <Deeper />
    </Layout>
  );
}
