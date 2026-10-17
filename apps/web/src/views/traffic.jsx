import { CATEGORIES } from '@nichedb/core/traffic';
import { Num, Relative } from './components.jsx';
import { Layout } from './Layout.jsx';

/**
 * Bad traffic: addresses our servers banned, each one approved by a person.
 *
 * The page leads with how an address gets here, because that is what makes
 * the list worth using: a blocklist built by a machine alone blocks Googlebot
 * the day a crawl looks like a scrape.
 */

const day = (iso) => (iso ? new Date(iso).toISOString().slice(0, 10) : '');
const categoryName = (c) => (c ? (CATEGORIES[c]?.split(' (')[0] ?? c) : 'Other');

const Lookup = ({ value = '' }) => (
  <form method="get" action="/traffic/lookup" class="inline">
    <input
      name="ip"
      value={value}
      placeholder="Check an IP, e.g. 203.0.113.9"
      aria-label="IP address"
      required
    />
    <button type="submit">Check</button>
  </form>
);

const Vetting = () => (
  <section>
    <h2>How an address gets on this list</h2>
    <ol>
      <li>
        Our own servers run <a href="https://threatcrush.com">ThreatCrush</a>, which bans an address
        when it probes for exploits, scans for admin panels, tries SQL injection or path traversal,
        or brute-forces SSH.
      </li>
      <li>
        <strong>Those bans are not published.</strong> Machines get it wrong: a misread port scan
        once banned our own upstream servers, and the busiest "scraper" in one sweep was real
        Googlebot. So every ban arrives here as a candidate, with its evidence: which rules fired,
        on how many of our servers, how often, and what it asked for.
      </li>
      <li>
        <strong>A person reads the evidence and decides.</strong> Approved addresses are published.
        Rejected ones are never published, and a later ban of the same address does not overturn the
        decision.
      </li>
      <li>
        Private ranges, our own servers, verified search crawlers and visitors whose only offence
        was hitting a paywall are filtered out before review.
      </li>
    </ol>
  </section>
);

const Row = ({ r }) => (
  <tr>
    <td>
      <a href={`/traffic/ip/${r.ip}`}>
        <code>{r.ip}</code>
      </a>
    </td>
    <td>{categoryName(r.category)}</td>
    <td class="num">{r.servers}</td>
    <td class="num">{r.blocks}</td>
    <td>{day(r.last_seen)}</td>
    <td>{day(r.reviewed_at)}</td>
  </tr>
);

export function TrafficPage({ user, stats, rows, params, sync, reviewer }) {
  return (
    <Layout
      user={user}
      wide
      canonical="/traffic"
      title="Bad traffic: a human-reviewed IP blocklist"
      description="IP addresses that attacked our servers, each one reviewed and approved by a person before it is published. Free lookups, a free blocklist and a JSON API."
    >
      <section class="hero">
        <h1>Bad traffic, checked by a person</h1>
        <p class="lede">
          IP addresses that attacked our servers: exploit probes, vulnerability scanners, SQL
          injection, SSH brute force. Every address here was reviewed and approved by a human before
          it was published. Free to look up, free to block.
        </p>
        <p class="stats">
          <Num n={stats.approved} /> approved by {stats.reviewers} reviewer
          {stats.reviewers === 1 ? '' : 's'} · <Num n={stats.pending} /> awaiting review ·{' '}
          <Num n={stats.rejected} /> rejected
          {stats.last_review ? (
            <>
              {' '}
              · last review <Relative at={stats.last_review} />
            </>
          ) : null}
          {sync?.fetched_at ? (
            <>
              {' '}
              · evidence updated <Relative at={sync.fetched_at} />
            </>
          ) : null}
          {reviewer ? (
            <>
              {' '}
              · <a href="/traffic/review">review queue</a>
            </>
          ) : null}
        </p>
        <Lookup />
      </section>

      <Vetting />

      <section>
        <h2>Use it</h2>
        <ul>
          <li>
            <a href="/traffic/blocklist.txt">blocklist.txt</a>: one address per line, for nginx,
            ipset or a firewall.
            {params.full
              ? ' You are signed in, so it is the full list.'
              : ` Without an account it is the newest ${params.limit}; a free account gets all of them.`}
          </li>
          <li>
            <a href="/api/v1/traffic">/api/v1/traffic</a> (JSON, with evidence) and{' '}
            <code>/api/v1/traffic/ip/&lt;address&gt;</code> for one address.
          </li>
          <li>
            <a href="/traffic/blocklist.rpz">blocklist.rpz</a>: a DNS Response Policy Zone for BIND,
            Unbound, PowerDNS or Knot, and{' '}
            <a href="/traffic/blocklist.rbldnsd">blocklist.rbldnsd</a>: an rbldnsd ip4set, to run
            the list as your own DNSBL for mail servers.
          </li>
          <li>
            Add <code>?days=90</code> to leave out addresses that have been quiet for 90 days
            (addresses get reassigned), and <code>?category=exploit</code> (or brute-force, scanner,
            spam) for one kind of attack. Both work on every list.
          </li>
          <li>
            Malware infrastructure from abuse.ch, free:{' '}
            <a href="/reputation/malware-ips.txt">malware-ips.txt</a> and{' '}
            <a href="/reputation/malware-domains.rpz">malware-domains.rpz</a>.
          </li>
          <li>
            Your address is listed and should not be? Open it at{' '}
            <code>/traffic/ip/&lt;address&gt;</code> and ask for it to come off; a reviewer reads
            the request beside the evidence.
          </li>
        </ul>
        <pre>
          {`# nginx: deny everything on the list
curl -s ${'https://nichedb.dev'}/traffic/blocklist.txt | grep -v '^#' | sed 's/.*/deny &;/' > /etc/nginx/bad-traffic.conf`}
        </pre>
      </section>

      <section>
        <h2>
          {params.full ? 'Approved addresses' : `The newest ${params.limit} approved addresses`}
        </h2>
        {rows.length === 0 ? (
          <p class="muted">
            Nothing is published yet.{' '}
            {stats.pending ? (
              <>
                <Num n={stats.pending} /> addresses are waiting for a person to look at them;{' '}
              </>
            ) : null}
            an address appears here only once it has been reviewed and approved.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Address</th>
                <th>What it did</th>
                <th class="num">Our servers</th>
                <th class="num">Bans</th>
                <th>Last seen</th>
                <th>Approved</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Row r={r} />
              ))}
            </tbody>
          </table>
        )}
        {params.full && rows.length === params.limit ? (
          <p>
            <a href={`/traffic?offset=${params.offset + params.limit}&limit=${params.limit}`}>
              Next page
            </a>
          </p>
        ) : null}
        {!params.full ? (
          <p class="muted">
            <a href="/login?next=/traffic">Sign in</a> (free) to see every approved address.
          </p>
        ) : null}
      </section>

      {stats.categories?.length ? (
        <section>
          <h2>By kind</h2>
          <ul>
            {stats.categories.map((k) => (
              <li>
                {categoryName(k.category)}: <Num n={k.n} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </Layout>
  );
}

const DelistForm = ({ ip }) => (
  <details>
    <summary>This is my address: ask for it to come off</summary>
    <form method="post" action={`/traffic/ip/${ip}/delist`} class="stack">
      <p class="small">
        A reviewer reads your request beside the evidence above and replies by email. If the address
        is yours and the traffic has stopped (a cleaned-up server, a reassigned IP), say so.
      </p>
      <input name="email" type="email" placeholder="you@example.com" aria-label="Email" required />
      <textarea
        name="reason"
        rows={4}
        minLength={10}
        maxLength={2000}
        placeholder="Why it should come off"
        aria-label="Reason"
        required
      />
      <button type="submit">Send request</button>
    </form>
  </details>
);

export function TrafficIpPage({ user, query, result, error, notice }) {
  return (
    <Layout
      user={user}
      canonical={`/traffic/ip/${query}`}
      title={`${query}: bad traffic check`}
      noindex
    >
      <section class="hero">
        <h1>
          <code>{query}</code>
        </h1>
        {error ? <p class="error">{error}</p> : null}
        {notice ? <p class="notice">{notice}</p> : null}
        {result && !result.listed ? (
          <p class="lede">
            Not on the list. Either our servers never banned it, or a person reviewed the evidence
            and it has not been approved. We only publish addresses a human has approved.
          </p>
        ) : null}
        {result?.listed ? (
          <>
            <p class="lede">
              <strong>Listed.</strong> {CATEGORIES[result.category] ?? 'Abuse'}. A person reviewed
              the evidence and approved it on {day(result.reviewed_at)}.
            </p>
            <table>
              <tbody>
                <tr>
                  <th>First seen</th>
                  <td>{day(result.first_seen)}</td>
                </tr>
                <tr>
                  <th>Last seen</th>
                  <td>{day(result.last_seen)}</td>
                </tr>
                <tr>
                  <th>Banned by</th>
                  <td>
                    {result.servers} of our servers, {result.blocks} times
                  </td>
                </tr>
                <tr>
                  <th>Rules</th>
                  <td>{(result.rules ?? []).join(', ')}</td>
                </tr>
                {result.evidence?.titles?.length ? (
                  <tr>
                    <th>What it did</th>
                    <td>{result.evidence.titles.join('; ')}</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
            <DelistForm ip={query} />
          </>
        ) : null}
        <Lookup value={query} />
        <p>
          <a href="/traffic">About this list and how it is reviewed</a>
        </p>
      </section>
    </Layout>
  );
}

const DelistRequests = ({ delists }) =>
  delists?.length ? (
    <section>
      <h2>Delisting requests ({delists.length})</h2>
      <table>
        <thead>
          <tr>
            <th>Address</th>
            <th>From</th>
            <th>Reason</th>
            <th>Evidence</th>
            <th>Decide</th>
          </tr>
        </thead>
        <tbody>
          {delists.map((d) => (
            <tr>
              <td>
                <a href={`/traffic/ip/${d.ip}`}>
                  <code>{d.ip}</code>
                </a>
                <div class="small muted">{day(d.created_at)}</div>
              </td>
              <td class="small">
                <a
                  href={`mailto:${d.email}?subject=${encodeURIComponent(`nichedb.dev/traffic: ${d.ip}`)}`}
                >
                  {d.email}
                </a>
              </td>
              <td class="small">{d.reason}</td>
              <td class="small">
                {categoryName(d.category)}, {d.servers} servers, {d.blocks} bans, last{' '}
                {day(d.last_seen)}
              </td>
              <td>
                <form method="post" action="/traffic/review/delist" class="stack">
                  <input type="hidden" name="id" value={String(d.id)} />
                  <input
                    name="note"
                    placeholder="Note (required to decline)"
                    aria-label="Decision note"
                    maxLength={1000}
                  />
                  <span>
                    <button name="action" value="delist" type="submit">
                      Take off the list
                    </button>{' '}
                    <button name="action" value="decline" type="submit">
                      Decline
                    </button>
                  </span>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  ) : null;

export function TrafficReviewPage({ user, rows, stats, status, offset, notice, delists = [] }) {
  return (
    <Layout user={user} wide title="Review bad traffic" noindex>
      <section>
        <h1>Review bad traffic</h1>
        <p class="lede">
          Each address was banned by our servers. Approve it only if the evidence shows an attack,
          not a crawler, a monitor, a customer or one of ours. Approved addresses are published at{' '}
          <a href="/traffic">/traffic</a>; rejected ones never are.
        </p>
        <p class="stats">
          <a href="/traffic/review?status=pending">
            Pending (<Num n={stats.pending} />)
          </a>{' '}
          ·{' '}
          <a href="/traffic/review?status=approved">
            Approved (<Num n={stats.approved} />)
          </a>{' '}
          ·{' '}
          <a href="/traffic/review?status=rejected">
            Rejected (<Num n={stats.rejected} />)
          </a>
        </p>
        {notice ? <p class="notice">{notice}</p> : null}
      </section>
      <DelistRequests delists={delists} />
      <form method="post" action="/traffic/review">
        <input type="hidden" name="status" value={status} />
        <table>
          <thead>
            <tr>
              <th></th>
              <th>Address</th>
              <th>Score</th>
              <th>Kind</th>
              <th class="num">Servers</th>
              <th class="num">Bans</th>
              <th>Seen</th>
              <th>Evidence</th>
              {status !== 'pending' ? <th>Decision</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr>
                <td>
                  <input type="checkbox" name="ip" value={r.ip} aria-label={`Select ${r.ip}`} />
                </td>
                <td>
                  <code>{r.ip}</code>
                  <br />
                  <a
                    class="small"
                    href={`https://www.abuseipdb.com/check/${r.ip}`}
                    rel="noopener"
                    target="_blank"
                  >
                    AbuseIPDB
                  </a>{' '}
                  <a
                    class="small"
                    href={`https://ipinfo.io/${r.ip}`}
                    rel="noopener"
                    target="_blank"
                  >
                    ipinfo
                  </a>
                </td>
                <td class="num">{r.score}</td>
                <td>{categoryName(r.category)}</td>
                <td class="num">{r.servers}</td>
                <td class="num">{r.blocks}</td>
                <td class="small">
                  {day(r.first_seen)} → {day(r.last_seen)}
                </td>
                <td class="small">
                  {(r.rules ?? []).join(', ')}
                  {r.evidence?.titles?.length ? (
                    <div class="muted">{r.evidence.titles.slice(0, 3).join('; ')}</div>
                  ) : null}
                  {r.evidence?.paths?.length ? (
                    <div class="muted">
                      <code>{r.evidence.paths.slice(0, 3).join('  ')}</code>
                    </div>
                  ) : null}
                </td>
                {status !== 'pending' ? (
                  <td class="small">
                    {r.reviewer ?? ''} {day(r.reviewed_at)}
                    {r.review_note ? <div class="muted">{r.review_note}</div> : null}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 ? <p class="muted">Nothing here.</p> : null}
        <p class="stack">
          <input
            name="note"
            placeholder="Note (required to reject): why"
            aria-label="Review note"
            maxLength={1000}
          />
          <span>
            {status !== 'approved' ? (
              <button name="action" value="approve" type="submit">
                Approve selected
              </button>
            ) : null}{' '}
            {status !== 'rejected' ? (
              <button name="action" value="reject" type="submit">
                Reject selected
              </button>
            ) : null}{' '}
            {status !== 'pending' ? (
              <button name="action" value="reopen" type="submit">
                Back to the queue
              </button>
            ) : null}
          </span>
        </p>
        {rows.length === 50 ? (
          <p>
            <a href={`/traffic/review?status=${status}&offset=${offset + 50}`}>Next 50</a>
          </p>
        ) : null}
      </form>
    </Layout>
  );
}
