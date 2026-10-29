import { Layout } from './Layout.jsx';

/**
 * Vulnerabilities: /vulns (look one up), /c/vulns/<id> (the deep dive). The
 * deep dive is the OpenVuln record drawn for a person: the five facts first
 * (severity, fix, exploited, EPSS, AI agents), each with where it came from,
 * then the write-up, what is affected, the campaign it belongs to and the
 * references. The same record is one click away as JSON.
 */

const day = (iso) => (iso ? new Date(iso).toISOString().slice(0, 10) : '');
const pct = (n) => (Number.isFinite(n) ? `${(n * 100).toFixed(n < 0.01 ? 2 : 1)}%` : '');

const Lookup = ({ value = '' }) => (
  <form method="get" action="/vulns" class="inline">
    <input
      name="q"
      value={value}
      placeholder="CVE-2026-12537, GHSA-..., MAL-..., OSV-..., NDB-..."
      aria-label="Vulnerability id"
      required
    />
    <button type="submit">Look up</button>
  </form>
);

/** Inline `code` inside a line of the write-up, without trusting it as HTML. */
const Inline = ({ text }) =>
  String(text)
    .split(/(`[^`]+`)/)
    .map((part) =>
      part.startsWith('`') && part.endsWith('`') ? <code>{part.slice(1, -1)}</code> : part,
    );

/** The small Markdown the write-ups use: ## headings, - lists, paragraphs. Text only, never HTML. */
export const Prose = ({ text }) => {
  const blocks = String(text ?? '')
    .replace(/\r/g, '')
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);
  return blocks.map((b) => {
    if (/^#{1,6}\s/.test(b)) return <h3>{b.replace(/^#{1,6}\s+/, '')}</h3>;
    const lines = b.split('\n');
    if (lines.every((l) => /^\s*[-*]\s/.test(l)))
      return (
        <ul>
          {lines.map((l) => (
            <li>
              <Inline text={l.replace(/^\s*[-*]\s+/, '')} />
            </li>
          ))}
        </ul>
      );
    return (
      <p>
        <Inline text={b.replace(/\n/g, ' ')} />
      </p>
    );
  });
};

const STATUS = {
  'exploited-ransomware': 'Exploited, by ransomware crews',
  exploited: 'Exploited in the wild',
  'poc-public': 'Working exploit public or demonstrated',
  'none-known': 'No known exploitation',
};

const FIX = {
  fixed: 'Fixed',
  partial: 'Fixed in some ranges',
  mitigated: 'Mitigated',
  unfixed: 'No fix',
  wontfix: "Won't fix",
  unknown: 'Unknown',
};

function Facts({ record, parts }) {
  const ov = record.database_specific.openvuln;
  const ex = ov.exploitation ?? {};
  const kev = ex.kev;
  return (
    <table>
      <tbody>
        <tr>
          <th>Severity</th>
          <td>
            {ov.label ? <strong>{ov.label}</strong> : 'unstated'}
            {record.severity?.[0] ? (
              <>
                {' '}
                <code>{record.severity[0].score}</code>
              </>
            ) : null}
          </td>
        </tr>
        <tr>
          <th>Fix</th>
          <td>
            {ov.fix ? (FIX[ov.fix.status] ?? ov.fix.status) : 'unknown'}
            {ov.fix?.versions?.length ? `: ${ov.fix.versions.join(', ')}` : ''}
            {ov.fix?.workaround ? <div class="muted">{ov.fix.workaround}</div> : null}
          </td>
        </tr>
        <tr>
          <th>Exploited</th>
          <td>
            {ex.status ? <strong>{STATUS[ex.status] ?? ex.status}</strong> : 'unstated'}
            {kev ? (
              <div>
                CISA KEV since {kev.added}
                {kev.due ? `, federal due date ${kev.due}` : ''}
                {kev.ransomware ? ', known ransomware use' : ''}
              </div>
            ) : kev === null ? (
              <div class="muted">Not in CISA's Known Exploited Vulnerabilities catalog.</div>
            ) : null}
          </td>
        </tr>
        <tr>
          <th>EPSS</th>
          <td>
            {ex.epss ? (
              <>
                {pct(ex.epss.score)} chance of exploitation in the next 30 days (higher than{' '}
                {pct(ex.epss.percentile)} of CVEs), {ex.epss.date}
              </>
            ) : parts.cves.length ? (
              'not scored yet'
            ) : (
              'no CVE to score'
            )}
          </td>
        </tr>
        <tr>
          <th>AI agents</th>
          <td>
            {ex.ai?.length ? (
              <ul>
                {ex.ai.map((a) => (
                  <li>
                    <a href={a.url}>
                      {a.benchmark} {a.task}
                    </a>{' '}
                    (
                    {a.result === 'unstated'
                      ? 'in the benchmark; no per-task result published'
                      : a.result}
                    )
                  </li>
                ))}
              </ul>
            ) : (
              'not in any AI exploit benchmark we read'
            )}
          </td>
        </tr>
        {ov.subject ? (
          <tr>
            <th>Subject</th>
            <td>
              {ov.subject.kind}:{' '}
              {ov.subject.url ? <a href={ov.subject.url}>{ov.subject.name}</a> : ov.subject.name}
              {ov.subject.vendor ? ` (${ov.subject.vendor})` : ''}
              {ov.subject.ecosystem ? ` (${ov.subject.ecosystem})` : ''}
            </td>
          </tr>
        ) : null}
        {ov.class?.length || record.database_specific.cwe_ids?.length ? (
          <tr>
            <th>Kind of flaw</th>
            <td>{[...(ov.class ?? []), ...(record.database_specific.cwe_ids ?? [])].join(', ')}</td>
          </tr>
        ) : null}
      </tbody>
    </table>
  );
}

function Affected({ affected }) {
  if (!affected?.length) return null;
  return (
    <>
      <h2>Affected</h2>
      <table>
        <thead>
          <tr>
            <th>Package</th>
            <th>Ecosystem</th>
            <th>Introduced</th>
            <th>Fixed</th>
          </tr>
        </thead>
        <tbody>
          {affected.slice(0, 40).map((a) =>
            (a.ranges ?? [{ events: [] }])
              .filter((r) => r.type !== 'GIT')
              .map((r) => (
                <tr>
                  <td>
                    <code>{a.package?.name ?? '?'}</code>
                  </td>
                  <td>{a.package?.ecosystem ?? ''}</td>
                  <td>
                    {(r.events ?? [])
                      .filter((e) => e.introduced)
                      .map((e) => e.introduced)
                      .join(', ')}
                  </td>
                  <td>
                    {(r.events ?? [])
                      .filter((e) => e.fixed || e.last_affected)
                      .map((e) => e.fixed ?? `last affected ${e.last_affected}`)
                      .join(', ') || <strong>none</strong>}
                  </td>
                </tr>
              )),
          )}
        </tbody>
      </table>
    </>
  );
}

const idLink = (x) => <a href={`/c/vulns/${encodeURIComponent(x)}`}>{x}</a>;

export function VulnPage({ user, query, report, error }) {
  if (!report) {
    return (
      <Layout user={user} title={query ?? 'Vulnerability'} noindex>
        <section class="hero">
          <h1>{query ? <code>{query}</code> : 'Vulnerability'}</h1>
          <p class="error">{error}</p>
          <Lookup value={query ?? ''} />
          {query ? (
            <p class="muted">
              Try <a href={`https://osv.dev/vulnerability/${encodeURIComponent(query)}`}>osv.dev</a>{' '}
              or{' '}
              <a href={`https://nvd.nist.gov/vuln/detail/${encodeURIComponent(query)}`}>the NVD</a>.
            </p>
          ) : null}
        </section>
      </Layout>
    );
  }
  const { record, parts } = report;
  const ov = record.database_specific.openvuln;
  const dd = ov.deep_dive ?? {};
  return (
    <Layout
      user={user}
      canonical={`/c/vulns/${record.id}`}
      title={`${record.id}: ${record.summary ?? 'vulnerability'}`.slice(0, 120)}
      description={`${record.id}${record.aliases?.length ? ` (${record.aliases.slice(0, 3).join(', ')})` : ''}: ${record.summary ?? ''}. Affected versions, fix, CISA KEV, EPSS and AI exploit evidence, each with its source.`.slice(
        0,
        300,
      )}
    >
      <section class="hero">
        <p class="muted">
          <a href="/vulns">Vulnerabilities</a> › <a href="/c/vulns">collection</a>
        </p>
        <h1>
          <code>{record.id}</code>
        </h1>
        {record.summary ? <p class="lede">{record.summary}</p> : null}
        {record.aliases?.length ? (
          <p>Also: {record.aliases.map((a, i) => [i ? ', ' : '', idLink(a)])}</p>
        ) : null}
        {record.withdrawn ? <p class="error">Withdrawn {day(record.withdrawn)}.</p> : null}
        <p class="muted">
          Published {day(record.published)}, updated {day(record.modified)} ·{' '}
          <a href={`/c/vulns/${encodeURIComponent(record.id)}.json`}>OpenVuln JSON</a> ·{' '}
          <a href={`/api/v1/vulns/${encodeURIComponent(record.id)}`}>API</a>
        </p>
      </section>

      <section>
        <Facts record={record} parts={parts} />
      </section>

      {parts.campaigns.length ? (
        <section>
          <h2>Part of</h2>
          <ul>
            {parts.campaigns.map((c) => (
              <li>
                {idLink(c.data.record.id)}: {c.data.record.summary}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {record.details ? (
        <section>
          <h2>Deep dive</h2>
          <Prose text={record.details} />
          {dd.made_by ? (
            <p class="muted">
              Written by{' '}
              {dd.made_by === 'ai'
                ? `an AI agent (${dd.ai_model ?? 'model unstated'})`
                : dd.made_by === 'both'
                  ? 'a person with an AI agent'
                  : 'a person'}
              {dd.made_by !== 'human' ? ' from the sources below' : ''}.
            </p>
          ) : (
            <p class="muted">In the words of the source the record came from (see Sources).</p>
          )}
        </section>
      ) : null}

      <section>
        <Affected affected={record.affected} />
      </section>

      {record.related?.length ? (
        <section>
          <h2>Related</h2>
          <p>{record.related.map((a, i) => [i ? ', ' : '', idLink(a)])}</p>
        </section>
      ) : null}

      {record.database_specific.iocs?.length ? (
        <section>
          <h2>Indicators (defanged)</h2>
          <table>
            <tbody>
              {record.database_specific.iocs.map((i) => (
                <tr>
                  <td>{i.type}</td>
                  <td>
                    <code>{i.value}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {record.references?.length ? (
        <section>
          <h2>References</h2>
          <ul>
            {record.references.map((r) => (
              <li>
                <span class="muted">{String(r.type ?? 'WEB').toLowerCase()}</span>{' '}
                <a href={r.url} rel="nofollow noopener">
                  {r.url}
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <h2>Sources</h2>
        <table>
          <thead>
            <tr>
              <th>Source</th>
              <th>Supplied</th>
              <th>Read</th>
            </tr>
          </thead>
          <tbody>
            {ov.sources.map((s) => (
              <tr>
                <td>
                  {s.url ? <a href={s.url}>{s.name}</a> : s.name}
                  {s.id ? (
                    <>
                      {' '}
                      <code>{s.id}</code>
                    </>
                  ) : null}
                  {s.note ? <div class="muted">{s.note}</div> : null}
                </td>
                <td>{(s.fields ?? []).join(', ')}</td>
                <td>{day(s.retrieved)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p class="muted">
          This record is <a href="https://logicsrc.com/openvuln">OpenVuln 0.1</a>: a valid OSV
          record with exploitation, fix and sources under <code>database_specific.openvuln</code>.
          Exploit code is never published here.
        </p>
      </section>
    </Layout>
  );
}

export function VulnsLanding({ user, counts = [], house = [] }) {
  return (
    <Layout
      user={user}
      canonical="/vulns"
      title="Vulnerabilities: one page per CVE, GHSA and campaign"
      description="Look up any CVE, GHSA, OSV or malicious package id: affected versions and fix from OSV.dev, CISA KEV exploitation and ransomware use, live EPSS, and whether AI agents have been set to exploit it (ExploitGym). Every record is OpenVuln, a valid OSV record."
    >
      <section class="hero">
        <h1>Vulnerabilities</h1>
        <p class="lede">
          One page per vulnerability with the five facts a defender needs, each with its source:
          what is affected and fixed (OSV.dev), how bad (NVD), whether it is exploited and by
          ransomware crews (CISA KEV), how likely exploitation is this month (FIRST EPSS), and
          whether AI agents have been set to exploit it (ExploitGym).
        </p>
        <Lookup />
      </section>

      {house.length ? (
        <section>
          <h2>Deep dives</h2>
          <ul>
            {house.map((r) => (
              <li>
                {idLink(r.id)}: {r.summary}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <h2>Follow</h2>
        <ul>
          <li>
            <a href="/f/kev">Exploited in the wild (CISA KEV)</a>, and{' '}
            <a href="/f/kev-ransomware">by ransomware crews</a>
          </li>
          <li>
            <a href="/f/critical-advisories">Critical open source advisories</a> and{' '}
            <a href="/f/open-source-advisories">every advisory</a>
          </li>
          <li>
            <a href="/f/malicious-packages">Malicious packages</a>
          </li>
          <li>
            <a href="/f/ai-exploit-benchmark">Vulnerabilities AI agents are set to exploit</a>
          </li>
          <li>
            <a href="/f/openvuln-records">Deep dives: campaigns and agent vulnerabilities</a>
          </li>
          <li>
            <a href="/c/vulns">The whole collection</a>, with RSS, JSON, the API and MCP
          </li>
        </ul>
      </section>

      {counts.length ? (
        <section>
          <h2>What is in it</h2>
          <table>
            <tbody>
              {counts.map((c) => (
                <tr>
                  <td>{c.name}</td>
                  <td class="num">{Number(c.items).toLocaleString('en-US')}</td>
                  <td>{day(c.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      <section>
        <h2>The format</h2>
        <p>
          Every page is also an <a href="https://logicsrc.com/openvuln">OpenVuln</a> record at{' '}
          <code>/c/vulns/&lt;id&gt;.json</code>: a valid OSV record that osv-scanner reads, with
          KEV, EPSS, AI exploit evidence, the fix and the source of each fact under{' '}
          <code>database_specific.openvuln</code>. Our own records are listed at{' '}
          <a href="/.well-known/openvuln.json">/.well-known/openvuln.json</a>.
        </p>
      </section>
    </Layout>
  );
}
