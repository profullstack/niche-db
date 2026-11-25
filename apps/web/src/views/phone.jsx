import { Layout } from './Layout.jsx';

/**
 * /phone and /phone/<number>: where a number is from, who it was assigned
 * to, and who reported it. See lib/phone.js for what each part rests on.
 */

const day = (iso) => (iso ? String(iso).slice(0, 10) : '');

const Lookup = ({ value = '' }) => (
  <form method="get" action="/phone" class="inline">
    <input
      name="q"
      value={value}
      placeholder="A phone number, e.g. +1 202 555 0143"
      aria-label="Phone number"
      required
    />
    <button type="submit">Look up</button>
  </form>
);

export function PhoneLanding({ user, counts, error, query }) {
  return (
    <Layout
      user={user}
      canonical="/phone"
      title="Phone number lookup"
      description="Where a phone number is from, which carrier it was assigned to, landline or mobile, and whether people reported it as spam. Open data only."
    >
      <section class="hero">
        <h1>Phone numbers</h1>
        {error ? <p class="error">{error}</p> : null}
        <p class="lede">
          Look up any number: where it is from, which carrier its block was assigned to, whether it
          is likely a landline or a mobile, and whether people reported it to the FCC or flagged it
          as a spam texter.
        </p>
        <Lookup value={query ?? ''} />
        <ul>
          <li>
            Every North American area code and exchange from NANPA
            {counts?.exchanges ? ` (${counts.exchanges.toLocaleString('en-US')} rows)` : ''}, with
            the ten blocks of 1,000 inside each pooled exchange
          </li>
          <li>
            Unwanted-call complaints filed with the FCC
            {counts?.complaints ? ` (${counts.complaints.toLocaleString('en-US')})` : ''}, by caller
            ID and call-back number
          </li>
          <li>
            The <a href="/blacklists/sms">SMS blacklist</a> from smshub.dev
          </li>
          <li>
            Outside North America, the country, format and line type from Google's numbering
            metadata
          </li>
        </ul>
        <p>
          No lookup here names the person behind a private line. No open register does, and nothing
          on this site keeps one. API: <code>GET /api/v1/phone/&lt;number&gt;</code> · feeds{' '}
          <a href="/f/fcc-unwanted-calls">fcc-unwanted-calls</a>,{' '}
          <a href="/f/fcc-robocalls">fcc-robocalls</a>.
        </p>
      </section>
    </Layout>
  );
}

/** The caller ID block: the name if we have it, else the button that asks. */
const CallerId = ({ n, callerId, available, error }) => {
  if (!available) return null;
  if (callerId) {
    return (
      <p class="lede">
        Caller ID:{' '}
        <strong>{callerId.name ?? 'no name on file (often a mobile or an unlisted line)'}</strong>
        {callerId.lineType ? ` · ${callerId.lineType}` : ''}
        {callerId.carrier ? ` · ${callerId.carrier}` : ''}
        {callerId.ported ? ' · ported' : ''}
        <br />
        <small>
          The name a phone shows when this number calls (CNAM), looked up {day(callerId.lookedUpAt)}
          . Business lines usually carry the business name; mobiles often carry none.
        </small>
      </p>
    );
  }
  return (
    <form method="post" action={`/phone/${n.digits}/caller-id`} class="inline">
      {error ? <p class="error">{error}</p> : null}
      <button type="submit">Show caller ID name</button>{' '}
      <small>The name a phone displays when this number calls, plus its current carrier.</small>
    </form>
  );
};

export function PhonePage({ user, report, callerIdError }) {
  if (report.error) return <PhoneLanding user={user} error={report.error} />;
  const n = report.number;
  const fcc = report.reports?.fcc;
  const sms = report.reports?.sms;
  const cid = report.callerId;
  return (
    <Layout
      user={user}
      canonical={`/phone/${n.digits}`}
      title={`${n.international}: who called?`}
      description={`Who ${n.international} belongs to, where it is from, its carrier, and whether people reported it.`}
      noindex={Boolean(cid?.name)}
    >
      <section class="hero">
        <h1>
          <code>{n.international}</code>
        </h1>
        <CallerId n={n} callerId={cid} available={report.callerIdAvailable} error={callerIdError} />
        <Lookup value={n.international} />
        <dl>
          <dt>Country</dt>
          <dd>
            {n.country ?? 'unknown'} (+{n.callingCode}) ·{' '}
            {n.valid ? 'a valid number' : 'not a number in use by this plan'}
          </dd>
          <dt>Line type</dt>
          <dd>
            {cid?.lineType
              ? `${cid.lineType} (from the network)`
              : report.carrier?.lineTypeGuess && n.nanp
                ? `${report.carrier.lineTypeGuess} (guessed from the carrier's name)`
                : (n.type ?? 'not published for this country')}
          </dd>
          {report.areaCode ? (
            <>
              <dt>Area code</dt>
              <dd>
                {n.npa}: {report.areaCode.location ?? '?'}
                {report.areaCode.timeZones?.length
                  ? ` · ${report.areaCode.timeZones.join('/')} time`
                  : ''}
                {report.areaCode.overlay ? ` · overlay ${report.areaCode.overlay}` : ''}
              </dd>
            </>
          ) : null}
          {report.exchange ? (
            <>
              <dt>Exchange</dt>
              <dd>
                {report.exchange.npaNxx} · rate centre {report.exchange.rateCenter ?? '?'},{' '}
                {report.exchange.state ?? '?'}
                {report.block ? ` · block ${report.block.range}` : ''}
              </dd>
            </>
          ) : null}
          {report.carrier ? (
            <>
              <dt>Assigned carrier</dt>
              <dd>
                {report.carrier.name}
                {report.carrier.ocn ? ` (OCN ${report.carrier.ocn})` : ''}
                {report.carrier.assignedAt ? `, ${day(report.carrier.assignedAt)}` : ''}.{' '}
                <small>{report.carrier.note}</small>
              </dd>
            </>
          ) : null}
        </dl>

        <h2>Reports</h2>
        {fcc?.count ? (
          <p>
            <strong>
              {fcc.capped ? 'At least ' : ''}
              {fcc.count} FCC complaint{fcc.count === 1 ? '' : 's'}
            </strong>{' '}
            from {day(fcc.first)} to {day(fcc.last)}:{' '}
            {Object.entries(fcc.byType)
              .map(([k, v]) => `${v} ${k.toLowerCase()}`)
              .join(', ')}
            .
          </p>
        ) : (
          <p>No FCC unwanted-call complaints name this number.</p>
        )}
        {fcc?.recent?.length ? (
          <table>
            <thead>
              <tr>
                <th>Filed</th>
                <th>As</th>
                <th>Type</th>
                <th>About</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {fcc.recent.map((c) => (
                <tr>
                  <td>{day(c.filedAt)}</td>
                  <td>{c.role}</td>
                  <td>{c.callType ?? ''}</td>
                  <td>{c.topic ?? ''}</td>
                  <td>{c.state ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        <p>
          {sms?.listed ? (
            <>
              <strong>On the SMS blacklist:</strong> flagged by {sms.reporters}{' '}
              {sms.reporters === 1 ? 'person' : 'people'}, last {day(sms.lastFlaggedAt)}.{' '}
              <a href={sms.page}>Details</a>
            </>
          ) : (
            'Not on the SMS blacklist.'
          )}
        </p>

        {report.businesses?.length ? (
          <>
            <h2>Published by</h2>
            <ul>
              {report.businesses.map((b) => (
                <li>
                  <a href={b.page}>{b.name}</a>
                  {b.summary ? ` · ${b.summary}` : ''}
                </li>
              ))}
            </ul>
          </>
        ) : null}

        <p>
          <small>
            Sources: {report.sources.join('; ')}. JSON:{' '}
            <a href={`/api/v1/phone/${n.digits}`}>/api/v1/phone/{n.digits}</a>
          </small>
        </p>
      </section>
    </Layout>
  );
}
