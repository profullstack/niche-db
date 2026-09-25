import { Num, Relative } from './components.jsx';
import { Layout } from './Layout.jsx';

/**
 * Top-level domains: every label in IANA's list, what it costs to keep one at
 * each registrar, and whether a name under it is taken.
 *
 * The table leads with the renewal, not the first year. That is the whole
 * point of the page: `.watches` is $52 to register and $258 a year after, and
 * a list sorted by the headline price puts it among the bargains.
 */

const SYMBOL = { USD: '$', EUR: '€', GBP: '£' };
export const fmtMoney = (amount, currency = 'USD') => {
  if (amount === null || amount === undefined) return null;
  const n = Number(amount);
  const s = n >= 1000 ? n.toLocaleString('en-US', { maximumFractionDigits: 0 }) : n.toFixed(2);
  return SYMBOL[currency] ? `${SYMBOL[currency]}${s}` : `${s} ${currency}`;
};

const Money = ({ p, showWho = false }) => {
  if (!p) return <span class="muted">—</span>;
  return (
    <span>
      <span class="num">{fmtMoney(p.amount, p.currency)}</span>
      {showWho && p.registrar_name ? <span class="muted small"> {p.registrar_name}</span> : null}
    </span>
  );
};

const Label = ({ row }) => (
  <a href={`/tlds/${row.tld}`}>
    <strong>.{row.unicode ?? row.tld}</strong>
    {row.unicode ? <span class="muted small"> {row.tld}</span> : null}
  </a>
);

/** The current filters as a URL, with some changed. Paging resets on any change but paging. */
export function tldsHref(params, change = {}) {
  const p = { ...params, ...change };
  if (!('offset' in change)) p.offset = 0;
  const q = new URLSearchParams();
  if (p.q) q.set('q', p.q);
  if (p.type?.length) q.set('type', [].concat(p.type).join(','));
  if (p.manager) q.set('manager', p.manager);
  if (p.registrar) q.set('registrar', p.registrar);
  if (p.status && p.status !== 'delegated') q.set('status', p.status);
  if (p.idn === 'yes') q.set('idn', '1');
  if (p.idn === 'no') q.set('idn', '0');
  if (p.priced) q.set('priced', '1');
  if (p.band) q.set('band', p.band);
  if (p.maxRenew !== null && p.maxRenew !== undefined) q.set('max_renew', String(p.maxRenew));
  if (p.maxRegister !== null && p.maxRegister !== undefined)
    q.set('max_register', String(p.maxRegister));
  if (p.trap) q.set('trap', '1');
  if (p.sort && p.sort !== 'renew') q.set('sort', p.sort);
  const defaultOrder = (p.sort ?? 'renew') === 'registrars' ? 'desc' : 'asc';
  if (p.order && p.order !== defaultOrder) q.set('order', p.order);
  if (p.offset) q.set('offset', String(p.offset));
  if (p.limit && p.limit !== 100) q.set('limit', String(p.limit));
  const s = q.toString();
  return s ? `/tlds?${s}` : '/tlds';
}

const Sort = ({ params, col, children }) => {
  const on = params.sort === col;
  const next = on
    ? params.order === 'asc'
      ? 'desc'
      : 'asc'
    : col === 'registrars'
      ? 'desc'
      : 'asc';
  return (
    <a href={tldsHref(params, { sort: col, order: next })} class={on ? 'sort on' : 'sort'}>
      {children}
      {on ? (params.order === 'asc' ? ' ↑' : ' ↓') : ''}
    </a>
  );
};

const Facet = ({ title, items, params, keyName, labelOf = (v) => v, multi = false }) =>
  items.length ? (
    <div class="facet">
      <h3>{title}</h3>
      <p class="tags">
        {items.map((f) => {
          const cur = [].concat(params[keyName] ?? []);
          const on = multi ? cur.includes(f.value) : params[keyName] === f.value;
          const value = multi
            ? on
              ? cur.filter((x) => x !== f.value)
              : [...cur, f.value]
            : on
              ? ''
              : f.value;
          return (
            <a
              key={f.value}
              class={`tag ${on ? 'on' : ''}`}
              href={tldsHref(params, { [keyName]: value })}
            >
              {f.label ?? labelOf(f.value)} <span class="muted">{f.count}</span>
            </a>
          );
        })}
      </p>
    </div>
  ) : null;

const TYPE_LABEL = {
  generic: 'generic',
  'country-code': 'country code',
  sponsored: 'sponsored',
  'generic-restricted': 'generic, restricted',
  infrastructure: 'infrastructure',
  test: 'test',
  unknown: 'not yet typed',
};

export const TldsPage = ({ user, result, stats, registrars, changes }) => {
  const { params, rows, total, facets } = result;
  const regName = Object.fromEntries(registrars.map((r) => [r.slug, r.name]));
  const chosen = params.registrar ? registrars.find((r) => r.slug === params.registrar) : null;
  const filtered =
    params.q ||
    params.type.length ||
    params.manager ||
    params.registrar ||
    params.idn ||
    params.priced ||
    params.band ||
    params.trap ||
    params.maxRenew !== null ||
    params.maxRegister !== null ||
    params.status !== 'delegated';
  return (
    <Layout
      user={user}
      wide
      canonical="/tlds"
      title="Top-level domains"
      description="Every top-level domain in IANA's root, diffed daily, with register, renewal and transfer prices compared across registrars, and an RDAP lookup for any name."
      noindex={filtered && params.offset > 0}
    >
      <section class="hero">
        <h1>Every top-level domain, and what it costs to keep</h1>
        <p class="lede">
          IANA's list of top-level domains, read every day and diffed, with each registrar's price
          to register, renew and transfer beside it. Sorted by the renewal, because the first year
          is a promotion and the second is the price.
        </p>
        <p class="stats">
          <Num n={stats.delegated} /> delegated · <Num n={stats.removed} /> retired ·{' '}
          <Num n={stats.prices} /> prices from {stats.registrars} registrars
          {stats.list_version ? <> · IANA list {stats.list_version}</> : null} ·{' '}
          <a href="/tlds/changes">changes</a> · <a href="/tlds/check">check a name</a> ·{' '}
          <a href={`/api/v1${tldsHref(params)}`}>JSON</a> ·{' '}
          <a href="https://logicsrc.com/docs/opentld">OpenTLD</a>
        </p>
      </section>

      <form class="row" method="get" action="/tlds">
        <div class="field">
          <label class="label" for="tq">
            Search
          </label>
          <input
            id="tq"
            name="q"
            type="search"
            value={params.q}
            placeholder=".watches, рф, Identity Digital"
          />
        </div>
        <div class="field">
          <label class="label" for="treg">
            Registrar
          </label>
          <select id="treg" name="registrar">
            <option value="">cheapest in USD</option>
            {registrars.map((r) => (
              <option key={r.slug} value={r.slug} selected={params.registrar === r.slug}>
                {r.name} ({r.currency ?? '?'})
              </option>
            ))}
          </select>
        </div>
        <div class="field">
          <label class="label" for="tmax">
            Max renewal
          </label>
          <input
            id="tmax"
            name="max_renew"
            type="number"
            min="0"
            step="1"
            inputmode="decimal"
            value={params.maxRenew ?? ''}
            placeholder="20"
          />
        </div>
        {params.type.length ? (
          <input type="hidden" name="type" value={params.type.join(',')} />
        ) : null}
        {params.band ? <input type="hidden" name="band" value={params.band} /> : null}
        {params.idn ? (
          <input type="hidden" name="idn" value={params.idn === 'yes' ? '1' : '0'} />
        ) : null}
        {params.trap ? <input type="hidden" name="trap" value="1" /> : null}
        {params.status !== 'delegated' ? (
          <input type="hidden" name="status" value={params.status} />
        ) : null}
        {params.sort !== 'renew' ? <input type="hidden" name="sort" value={params.sort} /> : null}
        <button class="cta" type="submit">
          Filter
        </button>
        {filtered ? (
          <a class="muted small" href="/tlds">
            clear
          </a>
        ) : null}
      </form>

      <div class="tld-grid">
        <aside>
          <Facet
            title="Type"
            items={facets.type}
            params={params}
            keyName="type"
            multi
            labelOf={(v) => TYPE_LABEL[v] ?? v}
          />
          <Facet
            title="Renewal"
            items={facets.band.filter((b) => b.count)}
            params={params}
            keyName="band"
          />
          <div class="facet">
            <h3>Renewal trap</h3>
            <p class="tags">
              <a
                class={`tag ${params.trap ? 'on danger' : ''}`}
                href={tldsHref(params, { trap: !params.trap })}
              >
                renews at 2× or more <span class="muted">{facets.trap}</span>
              </a>
            </p>
          </div>
          <Facet
            title="Sold at"
            items={facets.registrar}
            params={params}
            keyName="registrar"
            labelOf={(v) => regName[v] ?? v}
          />
          <Facet
            title="Script"
            items={facets.idn}
            params={params}
            keyName="idn"
            labelOf={(v) => (v === 'yes' ? 'internationalised' : 'ASCII')}
          />
          <Facet
            title="Status"
            items={facets.status}
            params={params}
            keyName="status"
            labelOf={(v) => (v === 'removed' ? 'retired' : v)}
          />
          <Facet
            title="Registry"
            items={facets.manager.slice(0, 25)}
            params={params}
            keyName="manager"
          />
          <p class="muted small">
            Registries in IANA's words: most of Identity Digital's are under Binky Moon, LLC.
          </p>
          {changes.length ? (
            <div class="facet">
              <h3>
                <a href="/tlds/changes">Latest changes</a>
              </h3>
              <ul class="plain small">
                {changes.map((c) => (
                  <li key={`${c.tld}-${c.at}`}>
                    <span class={`tag ${c.change === 'removed' ? 'danger' : 'ok'}`}>
                      {c.change}
                    </span>{' '}
                    <a href={`/tlds/${c.tld}`}>.{c.unicode ?? c.tld}</a> <Relative at={c.at} />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </aside>

        <section>
          <p class="muted small">
            <Num n={total} /> {total === 1 ? 'domain' : 'domains'}
            {chosen
              ? ` · prices are ${chosen.name}'s, in ${chosen.currency}`
              : ' · prices are the cheapest in USD across registrars; other currencies are never converted'}
          </p>
          <div class="table-scroll">
            <table class="table tlds">
              <thead>
                <tr>
                  <th>
                    <Sort params={params} col="tld">
                      TLD
                    </Sort>
                  </th>
                  <th>
                    <Sort params={params} col="type">
                      Type
                    </Sort>
                  </th>
                  <th class="money">
                    <Sort params={params} col="register">
                      Register
                    </Sort>
                  </th>
                  <th class="money">
                    <Sort params={params} col="renew">
                      Renew
                    </Sort>
                  </th>
                  <th class="money">
                    <Sort params={params} col="ratio">
                      ×
                    </Sort>
                  </th>
                  <th class="money">
                    <Sort params={params} col="transfer">
                      Transfer
                    </Sort>
                  </th>
                  <th class="money">
                    <Sort params={params} col="registrars">
                      Registrars
                    </Sort>
                  </th>
                  <th>
                    <Sort params={params} col="manager">
                      Registry
                    </Sort>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.tld} class={r.status === 'removed' ? 'muted' : ''}>
                    <td>
                      <Label row={r} />
                    </td>
                    <td class="small">{TYPE_LABEL[r.type] ?? r.type ?? ''}</td>
                    <td class="money">
                      <Money p={r.view.register} showWho={!chosen} />
                    </td>
                    <td class="money">
                      <Money p={r.view.renew} showWho={!chosen} />
                    </td>
                    <td class={`money small ${r.trap ? 'trap' : 'muted'}`}>
                      {r.ratio ? `${r.ratio.toFixed(1)}×` : ''}
                    </td>
                    <td class="money">
                      <Money p={r.view.transfer} />
                    </td>
                    <td class="money">{r.prices.length || <span class="muted">0</span>}</td>
                    <td class="small registry" title={r.manager ?? ''}>
                      {r.manager}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p class="actions">
            {params.offset > 0 ? (
              <a href={tldsHref(params, { offset: Math.max(0, params.offset - params.limit) })}>
                ← previous
              </a>
            ) : null}
            {params.offset + params.limit < total ? (
              <a href={tldsHref(params, { offset: params.offset + params.limit })}>
                next {Math.min(params.limit, total - params.offset - params.limit)} →
              </a>
            ) : null}
            <a href={tldsHref(params, { limit: 2000 })}>show all</a>
          </p>
          <Sources registrars={registrars} />
        </section>
      </div>
    </Layout>
  );
};

const Sources = ({ registrars }) => (
  <details class="panel small">
    <summary>Where these numbers come from</summary>
    <p>
      The list of top-level domains is{' '}
      <a href="https://data.iana.org/TLD/tlds-alpha-by-domain.txt">IANA's</a>, read daily and
      diffed; type and registry come from the{' '}
      <a href="https://www.iana.org/domains/root/db">root zone database</a>, the RDAP server from
      IANA's <a href="https://data.iana.org/rdap/dns.json">bootstrap file</a>. Prices are one year,
      before tax, in the registrar's currency, and are read daily from:
    </p>
    <ul>
      {registrars.map((r) => (
        <li key={r.slug}>
          <a href={r.web}>{r.name}</a>: {r.attribution}, <Num n={r.tlds} /> TLDs
          {r.last_read_at ? (
            <>
              , read <Relative at={r.last_read_at} />
            </>
          ) : null}
          {r.last_error ? <span class="muted"> (last read failed: {r.last_error})</span> : null}
        </li>
      ))}
    </ul>
    <p>
      A registrar can publish its own prices as an{' '}
      <a href="https://logicsrc.com/docs/opentld">OpenTLD</a> file at{' '}
      <code>/.well-known/opentld.json</code>, and this page will read it instead.
    </p>
  </details>
);

/* ------------------------------------------------------------------ one -- */

const RDAP_WORD = {
  registered: { tag: 'danger', text: 'registered' },
  not_registered: { tag: 'ok', text: 'not registered' },
  unknown: { tag: '', text: 'unknown' },
  invalid: { tag: '', text: 'not a name' },
};

export const CheckResult = ({ r, tldRows = {} }) => {
  const w = RDAP_WORD[r.status] ?? RDAP_WORD.unknown;
  const row = tldRows[r.tld];
  return (
    <tr>
      <td>
        <strong>{r.name}</strong>
      </td>
      <td>
        <span class={`tag ${w.tag}`}>{w.text}</span>
        {r.cached ? <span class="muted small"> cached</span> : null}
      </td>
      <td class="small">
        {r.status === 'registered' ? (
          <>
            {r.registrar ?? 'registrar not stated'}
            {r.expires ? (
              <span class="muted"> · expires {String(r.expires).slice(0, 10)}</span>
            ) : null}
          </>
        ) : r.status === 'not_registered' ? (
          <span class="muted">
            No registration at the registry. It may still be reserved or premium.
          </span>
        ) : (
          <span class="muted">{r.reason}</span>
        )}
      </td>
      <td class="money small">
        {row?.best?.register ? (
          <>
            <Money p={row.best.register} showWho /> <span class="muted">then</span>{' '}
            <Money p={row.best.renew} />
          </>
        ) : null}
      </td>
    </tr>
  );
};

export const CheckForm = ({ value = '', tlds = '' }) => (
  <form class="row" method="get" action="/tlds/check">
    <div class="field">
      <label class="label" for="cname">
        Name
      </label>
      <input
        id="cname"
        name="name"
        type="text"
        value={value}
        placeholder="myproject or myproject.watches"
        autocomplete="off"
        spellcheck="false"
      />
    </div>
    <div class="field">
      <label class="label" for="ctlds">
        Endings
      </label>
      <input id="ctlds" name="tlds" type="text" value={tlds} placeholder="com,dev,io,watches" />
    </div>
    <button class="cta" type="submit">
      Check
    </button>
  </form>
);

export const TldPage = ({ user, tld }) => {
  const live = tld.prices.filter((p) => !p.gone_at);
  const gone = tld.prices.filter((p) => p.gone_at);
  return (
    <Layout
      user={user}
      canonical={`/tlds/${tld.tld}`}
      title={`.${tld.unicode ?? tld.tld}`}
      description={`.${tld.unicode ?? tld.tld}: ${tld.type ?? 'top-level domain'} run by ${tld.manager ?? 'an unknown registry'}. Register, renewal and transfer prices at ${live.length} registrars, and an RDAP lookup.`}
    >
      <p class="crumb">
        <a href="/tlds">Top-level domains</a>
      </p>
      <h1>
        .{tld.unicode ?? tld.tld}
        {tld.unicode ? <span class="muted"> {tld.tld}</span> : null}
      </h1>
      <table class="kv">
        <tbody>
          <tr>
            <th>Status</th>
            <td>
              {tld.status === 'removed' ? (
                <span class="tag danger">
                  retired{tld.removed ? ` in list ${tld.removed}` : ''}
                </span>
              ) : (
                <span class="tag ok">delegated</span>
              )}
            </td>
          </tr>
          <tr>
            <th>Type</th>
            <td>{TYPE_LABEL[tld.type] ?? tld.type ?? 'unknown'}</td>
          </tr>
          <tr>
            <th>Registry</th>
            <td>
              <a href={`/tlds?manager=${encodeURIComponent(tld.manager ?? '')}`}>
                {tld.manager ?? 'unknown'}
              </a>{' '}
              <a class="muted small" href={`https://www.iana.org/domains/root/db/${tld.tld}.html`}>
                IANA
              </a>
            </td>
          </tr>
          <tr>
            <th>RDAP</th>
            <td>
              {tld.rdap ? <code>{tld.rdap}</code> : <span class="muted">none published</span>}
            </td>
          </tr>
          <tr>
            <th>First seen</th>
            <td>{tld.first_seen ? `IANA list ${tld.first_seen}` : 'before tracking began'}</td>
          </tr>
        </tbody>
      </table>

      <h2>Prices</h2>
      {live.length ? (
        <div class="table-scroll">
          <table class="table tlds">
            <thead>
              <tr>
                <th>Registrar</th>
                <th class="money">Register</th>
                <th class="money">Renew</th>
                <th class="money">Transfer</th>
                <th class="money">Restore</th>
                <th>Privacy</th>
                <th>Read</th>
              </tr>
            </thead>
            <tbody>
              {live.map((p) => (
                <tr key={p.registrar}>
                  <td>
                    <a href={p.url ?? p.registrar_web}>{p.registrar_name}</a>
                  </td>
                  <td class="money">
                    {fmtMoney(p.register, p.currency) ?? '—'}
                    {p.promo?.register ? (
                      <span class="small ok"> {fmtMoney(p.promo.register, p.currency)} now</span>
                    ) : null}
                  </td>
                  <td class={`money ${p.register && p.renew >= 2 * p.register ? 'trap' : ''}`}>
                    {fmtMoney(p.renew, p.currency) ?? <span class="muted">unknown</span>}
                  </td>
                  <td class="money">{fmtMoney(p.transfer, p.currency) ?? '—'}</td>
                  <td class="money">{fmtMoney(p.restore, p.currency) ?? '—'}</td>
                  <td class="small">{p.privacy ?? ''}</td>
                  <td class="small muted">
                    <Relative at={p.seen_at} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p class="muted">None of the registrars read here sells .{tld.unicode ?? tld.tld}.</p>
      )}
      {live.some((p) => p.restrictions) ? (
        <p class="small">
          <strong>Restrictions.</strong> {live.find((p) => p.restrictions).restrictions}
        </p>
      ) : null}
      {gone.length ? (
        <p class="small muted">
          No longer sold at: {gone.map((p) => p.registrar_name).join(', ')}.
        </p>
      ) : null}

      <h2>Is a name taken?</h2>
      <CheckForm tlds={tld.tld} />

      {tld.changes.length ? (
        <>
          <h2>History</h2>
          <ul class="plain">
            {tld.changes.map((c) => (
              <li key={`${c.change}-${c.at}`}>
                {c.change} in IANA list {c.list_version} <Relative at={c.at} />
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <p class="small muted">
        <a href={`/api/v1/tlds/${tld.tld}`}>JSON</a>
      </p>
    </Layout>
  );
};

/* -------------------------------------------------------------- changes -- */

export const TldChangesPage = ({ user, changes, sync }) => (
  <Layout
    user={user}
    canonical="/tlds/changes"
    title="Top-level domain changes"
    description="Every top-level domain added to or removed from IANA's root, as the daily list changes."
  >
    <p class="crumb">
      <a href="/tlds">Top-level domains</a>
    </p>
    <h1>What changed in the root</h1>
    <p class="lede">
      Every label added to or removed from IANA's list since this site began reading it, one row per
      change, with the list version it happened in. No registrar or registry publishes this.
    </p>
    <p class="stats small">
      {sync
        .filter((s) => s.source.startsWith('iana'))
        .map((s) => (
          <span key={s.source}>
            {s.source}: {s.version ?? '—'} <Relative at={s.fetched_at} />
            {s.error ? <span class="muted"> ({s.error})</span> : null} ·{' '}
          </span>
        ))}
      <a href="/api/v1/tlds/changes">JSON</a>
    </p>
    {changes.length ? (
      <table class="table">
        <thead>
          <tr>
            <th>When</th>
            <th>Change</th>
            <th>TLD</th>
            <th>List</th>
            <th>Registry</th>
          </tr>
        </thead>
        <tbody>
          {changes.map((c) => (
            <tr key={`${c.tld}-${c.at}-${c.change}`}>
              <td class="small">{String(new Date(c.at).toISOString()).slice(0, 10)}</td>
              <td>
                <span class={`tag ${c.change === 'removed' ? 'danger' : 'ok'}`}>{c.change}</span>
              </td>
              <td>
                <a href={`/tlds/${c.tld}`}>.{c.unicode ?? c.tld}</a>
              </td>
              <td class="small">{c.list_version}</td>
              <td class="small">{c.manager}</td>
            </tr>
          ))}
        </tbody>
      </table>
    ) : (
      <p class="muted">
        Nothing has changed since tracking began. The first read of the list is the baseline;
        changes are written from the next version on.
      </p>
    )}
  </Layout>
);

/* ---------------------------------------------------------------- check -- */

export const TldCheckPage = ({ user, name, tlds, results, tldRows, error }) => (
  <Layout
    user={user}
    canonical="/tlds/check"
    title="Is a domain name taken?"
    description="Ask the registry, over RDAP, whether a domain name is registered, across as many endings as you like, with each ending's cheapest price."
    noindex={Boolean(name)}
  >
    <p class="crumb">
      <a href="/tlds">Top-level domains</a>
    </p>
    <h1>Is a name taken?</h1>
    <p class="lede">
      Asked of each registry over RDAP. "Not registered" means the registry holds no registration,
      which is not the same as for sale: a name can be reserved or premium, and only a registrar's
      cart says which. Where a registry publishes no RDAP server (.io and .de among them) the answer
      is unknown, never guessed.
    </p>
    <CheckForm value={name} tlds={tlds} />
    {error ? <p class="notice error">{error}</p> : null}
    {results?.length ? (
      <table class="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Registry says</th>
            <th />
            <th class="money">Cheapest</th>
          </tr>
        </thead>
        <tbody>
          {results.map((r) => (
            <CheckResult key={r.name} r={r} tldRows={tldRows} />
          ))}
        </tbody>
      </table>
    ) : null}
  </Layout>
);
