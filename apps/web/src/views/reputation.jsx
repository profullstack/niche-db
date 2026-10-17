import { liveReputationDeps } from '../lib/dnsbl.js';
import { checkedFor, DEEPER } from '../lib/reputation.js';
import { Layout } from './Layout.jsx';

/**
 * Reputation: is this IP or domain on a list? One lookup over /traffic,
 * abuse.ch, SURBL and the live DNS blocklists; a domain's A/AAAA addresses
 * are checked too. A miss says which lists were checked, never "clean".
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

// The landing page lists what an address lookup asks, then what a domain adds.
const landingChecks = () => [
  ...checkedFor('ip', liveReputationDeps.dnsbl),
  ...checkedFor('domain', liveReputationDeps.dnsbl).filter(
    (c) => c.list !== 'abusech' && c.list !== 'addresses',
  ),
  { name: 'for a domain, every address check again on its A/AAAA addresses' },
];

const Checked = ({ checked }) => (
  <ul>
    {(checked ?? landingChecks()).map((c) => (
      <li>{c.name}</li>
    ))}
  </ul>
);

const STATUS = { listed: 'Listed', clear: 'Not listed', unknown: 'Could not ask' };

/** One row per live list answer: list, subject, what it said. */
const DnsblRows = ({ rows, ip }) =>
  rows.map((d) => (
    <tr>
      {ip !== undefined ? <td>{ip ? <code>{ip}</code> : null}</td> : null}
      <td>{d.list}</td>
      <td>
        <code>{d.subject}</code>
      </td>
      <td>{d.status === 'listed' ? <strong>{STATUS.listed}</strong> : STATUS[d.status]}</td>
      <td>
        {(d.reasons ?? []).map((r) => `${r.label} (${r.code})`).join(', ') ||
          d.note ||
          d.error ||
          ''}
      </td>
    </tr>
  ));

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
      {report.dnsbl?.length ? (
        <>
          <h2>Live DNS blocklists</h2>
          <table>
            <thead>
              <tr>
                <th>List</th>
                <th>Asked about</th>
                <th>Answer</th>
                <th>What it says</th>
              </tr>
            </thead>
            <tbody>
              <DnsblRows rows={report.dnsbl} />
            </tbody>
          </table>
        </>
      ) : null}
      {report.addresses?.length ? (
        <>
          <h2>The addresses it resolves to</h2>
          <p>
            Every address check, run again on each A/AAAA record:{' '}
            {report.addresses
              .map((a) => `${a.ip} ${a.listed ? '(listed)' : '(not listed)'}`)
              .join(', ')}
            .
          </p>
          <table>
            <thead>
              <tr>
                <th>Address</th>
                <th>List</th>
                <th>Asked about</th>
                <th>Answer</th>
                <th>What it says</th>
              </tr>
            </thead>
            <tbody>
              {report.addresses.map((a) => (
                <>
                  {a.traffic ? (
                    <tr>
                      <td>
                        <code>{a.ip}</code>
                      </td>
                      <td>nichedb /traffic</td>
                      <td>
                        <code>{a.ip}</code>
                      </td>
                      <td>
                        <strong>{STATUS.listed}</strong>
                      </td>
                      <td>
                        <a href={`/traffic/ip/${a.ip}`}>
                          banned by {a.traffic.servers} of our servers
                        </a>
                      </td>
                    </tr>
                  ) : null}
                  {a.indicators.map((i) => (
                    <tr>
                      <td>
                        <code>{a.ip}</code>
                      </td>
                      <td>abuse.ch {i.feeds.join(', ')}</td>
                      <td>
                        <code>{i.indicator}</code>
                      </td>
                      <td>
                        <strong>{STATUS.listed}</strong>
                      </td>
                      <td>{i.title}</td>
                    </tr>
                  ))}
                  <DnsblRows rows={a.dnsbl} ip={a.ip} />
                </>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
      {report.unknown?.length ? (
        <p class="muted">
          Could not ask {report.unknown.join(', ')}: the list did not answer its own test entry (or
          refused), so its silence is not counted as a miss.
        </p>
      ) : null}
      <h2>Checked</h2>
      <Checked checked={report.checked} />
      <p class="muted">
        abuse.ch data is free to use with credit to abuse.ch. Live DNS lists are asked of each
        list's own nameservers, proven with its test entry, and held an hour. JSON for this answer:{' '}
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
      description="Is an IP address or a domain on a blocklist? Free lookups over the human-reviewed /traffic list, abuse.ch malware feeds, SURBL and live DNS blocklists such as Spamhaus, SpamCop and URIBL."
      noindex={Boolean(query)}
    >
      <section class="hero">
        <h1>{query ? <code>{query}</code> : 'IP and domain reputation'}</h1>
        {error ? <p class="error">{error}</p> : null}
        {!query ? (
          <p class="lede">
            Is an address or a domain on a list? Free, from data anyone can download: addresses our
            own servers banned and a person approved, malware infrastructure reported to abuse.ch,
            and the DNS blocklists mail servers ask. A domain is checked by name and on every
            address it resolves to.
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
