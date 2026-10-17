import { config } from '@nichedb/config';
import { Notice } from './components.jsx';
import { Layout } from './Layout.jsx';

/**
 * One page, one question: is this business on anybody's list?
 *
 * The standing comes first, then the findings that made it, then each list
 * with what it said. A list that was not checked says so in the same place a
 * clean one would, so silence is never mistaken for a pass.
 */

const money = (cents) => `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;

const STANDING = {
  flagged: {
    label: 'On a list',
    tone: 'danger',
    say: 'At least one authority lists this business.',
  },
  incomplete: {
    label: 'Nothing found, not everything checked',
    tone: '',
    say: 'Nothing found in the lists that were checked; some could not be checked here, listed below.',
  },
  clear: {
    label: 'Clear',
    tone: 'ok',
    say: 'Every list was checked and none of them lists this business.',
  },
};

const STATUS = {
  checked: 'checked',
  unconfigured: 'not checked here',
  unknown: 'could not be checked',
  skipped: 'not asked',
};

const Status = ({ s }) => (
  <span class={`tag${s === 'checked' ? '' : ' muted'}`}>{STATUS[s] ?? s}</span>
);

const Section = ({ title, s, children }) => (
  <section class="card">
    <p class="card-title">
      {title} <Status s={s.status} />
    </p>
    <p class="small muted">
      {s.source}
      {s.licence ? ` · ${s.licence}` : ''}
    </p>
    {s.note ? <p class="small">{s.note}</p> : null}
    {s.error ? <p class="small muted">Error: {s.error}</p> : null}
    {children}
  </section>
);

const Sanctions = ({ s }) => (
  <Section title="Sanctions (OFAC)" s={s}>
    {s.status === 'checked' ? (
      s.hits.length ? (
        <ul>
          {s.hits.map((h) => (
            <li>
              <strong>{h.name}</strong>{' '}
              <span class={`tag${h.match === 'exact' ? ' danger' : ''}`}>{h.match} match</span>
              <span class="small muted">
                {' '}
                · {h.list === 'sdn' ? 'SDN' : 'consolidated'} · {h.type} · {h.programs.join(', ')}
                {h.matchedName !== h.name ? ` · matched alias “${h.matchedName}”` : ''}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p>
          Not on the SDN or consolidated lists ({s.listedEntries.toLocaleString('en-US')} entries,
          fetched {s.fetchedAt.slice(0, 10)}).
        </p>
      )
    ) : null}
    <p class="small">
      <a href={s.selfCheck} rel="noopener">
        Search OFAC yourself
      </a>
    </p>
  </Section>
);

const Registry = ({ gleif, edgar, opencorporates, sam }) => (
  <>
    <Section title="Legal entity identifier (GLEIF)" s={gleif}>
      {gleif.status === 'checked' ? (
        gleif.records.length ? (
          <ul>
            {gleif.records.map((r) => (
              <li>
                <a href={r.url} rel="noopener">
                  {r.name}
                </a>{' '}
                <span class="small muted">
                  {r.jurisdiction} · entity {r.entityStatus} · LEI {r.registrationStatus}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p>
            No LEI. Most small private companies never get one; it is needed to trade securities.
          </p>
        )
      ) : null}
    </Section>
    <Section title="SEC filer (EDGAR)" s={edgar}>
      {edgar.status === 'checked' ? (
        edgar.filers.length ? (
          <ul>
            {edgar.filers.map((f) => (
              <li>
                <a href={f.url} rel="noopener">
                  {f.name}
                </a>{' '}
                <span class="small muted">CIK {f.cik}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p>Has never filed with the SEC under this name.</p>
        )
      ) : null}
    </Section>
    <Section title="State registry (OpenCorporates)" s={opencorporates}>
      {opencorporates.status === 'checked' ? (
        opencorporates.companies.length ? (
          <ul>
            {opencorporates.companies.map((co) => (
              <li>
                <a href={co.url} rel="noopener">
                  {co.name}
                </a>{' '}
                <span class={`tag${co.inactive ? ' danger' : ''}`}>
                  {co.status ?? 'status unknown'}
                </span>
                <span class="small muted">
                  {' '}
                  · {co.jurisdiction} {co.number}
                  {co.incorporated ? ` · since ${co.incorporated}` : ''}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p>No matching registry record.</p>
        )
      ) : null}
    </Section>
    <Section title="Federal exclusions (SAM.gov)" s={sam}>
      {sam.status === 'checked' ? (
        sam.exclusions.length ? (
          <ul>
            {sam.exclusions.map((x) => (
              <li>
                <strong>{x.name}</strong>{' '}
                <span class="small muted">
                  {x.type} · {x.agency}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p>Not excluded from federal contracts.</p>
        )
      ) : null}
    </Section>
  </>
);

const Domain = ({ d }) => (
  <Section title={`Domain${d.domain ? `: ${d.domain}` : ''}`} s={d}>
    {d.registration ? (
      <p class="small">
        Registration: {d.registration.status?.replace('_', ' ')}
        {d.registration.registrar ? ` at ${d.registration.registrar}` : ''}
        {d.registration.expires ? `, expires ${String(d.registration.expires).slice(0, 10)}` : ''}
      </p>
    ) : null}
    {d.addresses?.length ? <p class="small muted">Serves from {d.addresses.join(', ')}</p> : null}
    {d.lists?.length ? (
      <ul>
        {d.lists.map((l) => (
          <li>
            {l.list} <span class="small muted">({l.subject})</span>:{' '}
            <span class={`tag${l.status === 'listed' ? ' danger' : ''}`}>{l.status}</span>
            {l.reasons?.length ? (
              <span class="small"> {l.reasons.map((r) => r.label).join(', ')}</span>
            ) : null}
          </li>
        ))}
      </ul>
    ) : null}
    {d.selfChecks?.length ? (
      <p class="small">
        Check yourself:{' '}
        {d.selfChecks.map((s, i) => (
          <>
            {i ? ' · ' : ''}
            <a href={s.url} rel="noopener">
              {s.name}
            </a>
          </>
        ))}
      </p>
    ) : null}
  </Section>
);

const Report = ({ report }) => {
  const st = STANDING[report.standing];
  const s = report.sections;
  return (
    <>
      <section>
        <h2>
          <span class={`tag ${st.tone}`}>{st.label}</span>
        </h2>
        <p>{st.say}</p>
        {report.findings.length ? (
          <ul>
            {report.findings.map((f) => (
              <li>
                <span class={`tag${f.severity === 'serious' ? ' danger' : ''}`}>{f.severity}</span>{' '}
                {f.text}
              </li>
            ))}
          </ul>
        ) : null}
        {report.notChecked.length ? (
          <p class="small muted">Not checked: {report.notChecked.join('; ')}.</p>
        ) : null}
      </section>
      <Sanctions s={s.sanctions} />
      <Registry gleif={s.gleif} edgar={s.edgar} opencorporates={s.opencorporates} sam={s.sam} />
      {s.domain.status !== 'skipped' ? <Domain d={s.domain} /> : null}
      {report.ein ? (
        <p class="small">
          EIN {report.ein.ein}: {report.ein.note}
        </p>
      ) : null}
      <section>
        <h3>Look it up yourself</h3>
        <ul>
          {report.lookUpYourself.map((l) => (
            <li>
              <a href={l.url} rel="noopener">
                {l.name}
              </a>{' '}
              <span class="small muted">{l.what}</span>
            </li>
          ))}
        </ul>
        <p class="small muted">
          Checked {report.checkedAt.slice(0, 16).replace('T', ' ')} UTC. {report.disclaimer}
        </p>
      </section>
    </>
  );
};

const Field = ({ id, label, value, placeholder, ...rest }) => (
  <div class="field">
    <label class="label" for={id}>
      {label}
    </label>
    <input
      id={id}
      name={id}
      type="text"
      value={value ?? ''}
      placeholder={placeholder}
      autocomplete="off"
      spellcheck="false"
      {...rest}
    />
  </div>
);

export const BusinessPage = ({ user, input, report, error }) => (
  <Layout
    user={user}
    canonical="/business"
    title="Business standing"
    description="Is a business on anybody's list? OFAC sanctions, LEI and SEC registrations, state registry status, federal exclusions and its domain's mail reputation, in one report."
  >
    <section class="hero">
      <h1>Is this business on anybody's list?</h1>
      <p class="lede">
        A company name, its domain, or its state entity number in; out comes where it stands with US
        sanctions, the global and SEC registries, its state, federal contracting, and the reputation
        lists mail servers check its domain against. A list that could not be checked says so;
        nothing is reported clean that was not looked at.
      </p>
    </section>

    <section>
      <form class="row" method="get" action="/business">
        <Field
          id="name"
          label="Business name"
          value={input.name}
          placeholder="Profullstack, Inc."
        />
        <Field id="domain" label="Domain" value={input.domain} placeholder="profullstack.com" />
        <Field
          id="state"
          label="State"
          value={input.state?.toUpperCase()}
          placeholder="CA"
          maxlength="2"
        />
        <Field id="number" label="Entity number" value={input.number} placeholder="4218574" />
        <Field id="ein" label="EIN" value={input.ein} placeholder="83-2874338" />
        <button class="cta" type="submit">
          Check it
        </button>
      </form>
      <p class="help">
        Any one field is enough; the name drives the sanctions and registry matches, the domain the
        reputation checks. Try{' '}
        <a href="/business?name=Profullstack%2C+Inc.&domain=profullstack.com&state=ca&number=4218574">
          Profullstack, Inc.
        </a>
      </p>
      <Notice error={error} />
    </section>

    {report ? <Report report={report} /> : null}

    <section>
      <h3>For agents</h3>
      <p class="small">
        <code>GET /api/v1/business?name=&amp;domain=&amp;state=&amp;number=&amp;ein=</code> · MCP
        tool <code>business_standing</code> · CLI{' '}
        <code>nichedb business &lt;name&gt; --domain …</code>
      </p>
      <p class="small muted">
        {config.business.freeLookupsPerHour} reports an hour are free, then{' '}
        {money(config.premium.dayCents)} a day on a crawl pass or {money(config.premium.monthCents)}{' '}
        a month. Premium and Pro include them.
      </p>
    </section>
  </Layout>
);
