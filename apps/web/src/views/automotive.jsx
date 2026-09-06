import { config } from '@nichedb/config';
import { Notice, Num } from './components.jsx';
import { Layout } from './Layout.jsx';

/**
 * One page, one question: what is this car and what is wrong with it.
 *
 * A VIN in, everything out. The page is deliberately not a dashboard — the
 * thing a person standing next to a used car needs to see first is whether
 * there is an open recall telling them not to drive it, and that is the first
 * thing on the page when there is one.
 */

const money = (cents) => `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;

const Stars = ({ n }) =>
  n ? (
    <span title={`${n} out of 5`}>
      {'★'.repeat(Number(n))}
      <span class="muted">{'☆'.repeat(Math.max(0, 5 - Number(n)))}</span>
    </span>
  ) : (
    <span class="muted">not rated</span>
  );

const Recall = ({ r }) => (
  <li class="card">
    <p class="card-title">
      {r.component}
      {r.doNotDrive ? <span class="tag danger"> do not drive</span> : null}
      {r.parkOutside ? <span class="tag danger"> park outside</span> : null}
      {r.overTheAir ? <span class="tag"> over-the-air fix</span> : null}
    </p>
    <p class="small muted">
      {r.campaign} · reported {r.reportReceived}
    </p>
    <p class="card-desc">{r.summary}</p>
    {r.consequence ? (
      <p class="small">
        <strong>Consequence.</strong> {r.consequence}
      </p>
    ) : null}
    {r.remedy ? (
      <p class="small">
        <strong>Remedy.</strong> {r.remedy}
      </p>
    ) : null}
    <p class="small">
      <a href={r.url} rel="noopener">
        NHTSA campaign page
      </a>
    </p>
  </li>
);

const Profile = ({ profile }) => {
  const v = profile.vehicle;
  const h = profile.headline;
  return (
    <>
      <section>
        <h2>
          {v.year} {v.make} {v.model}
        </h2>
        {v.vin ? <p class="small muted">VIN {v.vin}</p> : null}
        {h.doNotDrive ? (
          <div class="alert alert-destructive" role="alert">
            <p class="alert-title">Do not drive this vehicle.</p>
            <p>NHTSA has an open recall on it that says so. The details are below.</p>
          </div>
        ) : null}
        <p class="stats">
          <Num n={h.openRecalls} /> recalls · <Num n={h.complaints} /> owner complaints ·{' '}
          {h.overallSafetyRating ? `${h.overallSafetyRating}/5 overall` : 'no crash rating'} ·{' '}
          {h.mpgCombined ? `${h.mpgCombined} mpg combined` : 'no mpg on file'}
        </p>
      </section>

      {profile.identity?.decoded ? (
        <section>
          <h3>What the VIN says</h3>
          <table class="kv">
            <tbody>
              {[
                ['Manufacturer', profile.identity.manufacturer],
                ['Body class', profile.identity.bodyClass],
                ['Vehicle type', profile.identity.vehicleType],
                [
                  'Engine',
                  [
                    profile.identity.engine?.displacementL
                      ? `${Number(profile.identity.engine.displacementL).toFixed(1)}L`
                      : null,
                    profile.identity.engine?.cylinders
                      ? `${profile.identity.engine.cylinders}-cylinder`
                      : null,
                    profile.identity.engine?.fuel,
                    profile.identity.engine?.horsepower
                      ? `${profile.identity.engine.horsepower} hp`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(', '),
                ],
                ['Built at', profile.identity.plant],
                [
                  'Check digit',
                  profile.identity.checkDigitOk === null
                    ? 'not applicable'
                    : profile.identity.checkDigitOk
                      ? 'valid'
                      : 'does not match — check the VIN',
                ],
              ]
                .filter(([, val]) => val)
                .map(([k, val]) => (
                  <tr key={k}>
                    <th>{k}</th>
                    <td>{val}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </section>
      ) : null}

      <section>
        <h3>Open recalls ({profile.recalls.length})</h3>
        {profile.recalls.length ? (
          <ul class="cards">
            {profile.recalls.map((r) => (
              <Recall key={r.campaign} r={r} />
            ))}
          </ul>
        ) : (
          <p class="muted">NHTSA lists no recalls for this vehicle.</p>
        )}
      </section>

      <section>
        <h3>What owners report</h3>
        <p class="stats">
          <Num n={profile.complaints.total} /> complaints ·{' '}
          <Num n={profile.complaints.crashes ?? 0} /> involving a crash ·{' '}
          <Num n={profile.complaints.fires ?? 0} /> involving a fire
        </p>
        {profile.complaints.byComponent?.length ? (
          <ul class="tags">
            {profile.complaints.byComponent.map((row) => (
              <li key={row.component} class="tag">
                {row.component.toLowerCase()} · {row.complaints}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      {profile.rating ? (
        <section>
          <h3>Crash tests</h3>
          <table class="kv">
            <tbody>
              <tr>
                <th>Overall</th>
                <td>
                  <Stars n={profile.rating.overall} />
                </td>
              </tr>
              <tr>
                <th>Frontal</th>
                <td>
                  <Stars n={profile.rating.frontal} />
                </td>
              </tr>
              <tr>
                <th>Side</th>
                <td>
                  <Stars n={profile.rating.side} />
                </td>
              </tr>
              <tr>
                <th>Rollover</th>
                <td>
                  <Stars n={profile.rating.rollover} />
                </td>
              </tr>
            </tbody>
          </table>
        </section>
      ) : null}

      <section>
        <h3>Service</h3>
        <p class="small muted">{profile.maintenance.disclaimer}</p>
        <table class="kv">
          <tbody>
            {profile.maintenance.items.slice(0, 8).map((s) => (
              <tr key={s.service}>
                <th>{s.service}</th>
                <td>
                  every {s.everyMiles.toLocaleString('en-US')} miles or {s.everyMonths} months
                  {s.milesUntilDue !== null ? (
                    <span class="muted"> · next at {s.nextDueAtMiles.toLocaleString('en-US')}</span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h3>Parts</h3>
        <ul class="tags">
          {profile.parts.searches.map((p) => (
            <li key={p.vendor}>
              {/* The tag IS the link, as everywhere else on the site. A `.tag`
                  wrapping a link instead gives a pill with link-coloured text
                  inside it, which is a second look for the same component. */}
              {/* `sponsored` is required by Google and by the FTC on a link
                  that pays us, and it is only true once somebody has actually
                  been approved for that vendor's programme. */}
              <a
                class="tag"
                href={p.url}
                rel={p.sponsored ? 'sponsored nofollow noopener' : 'nofollow noopener'}
                title={p.note ?? p.kind}
              >
                {p.vendor}
              </a>
            </li>
          ))}
        </ul>
        <p class="small muted">{profile.parts.note}</p>
        {profile.parts.searches.some((p) => p.sponsored) ? (
          <p class="small muted">
            Some of these links pay us a commission if you buy through them. It costs you nothing
            and it does not change which vendors are listed or their order.
            {/* Amazon's Operating Agreement requires this sentence, in these
                words, wherever an Associates link appears. */}
            {profile.parts.searches.some((p) => p.sponsored && p.key === 'amazon')
              ? ' As an Amazon Associate I earn from qualifying purchases.'
              : ''}
          </p>
        ) : null}
      </section>

      <section>
        <h3>Where the data comes from</h3>
        <ul class="small">
          {profile.sources.map((s) => (
            <li key={s.name}>
              {s.name} — {s.licence}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
};

export const AutomotivePage = ({ user, vin, miles, profile, error, stats, vins }) => (
  <Layout
    user={user}
    canonical="/vin"
    title="Automotive"
    description="Decode a VIN and get everything known about that car: recalls, owner complaints, crash-test ratings, mpg, service intervals, parts and mechanics near you."
  >
    <section class="hero">
      <h1>Every car, and what is wrong with it</h1>
      <p class="lede">
        Every make, model and year sold in the US since 1984, the safety recalls and owner
        complaints filed against each one, and the crash tests they were put through. Give it a VIN
        and it decodes the car and answers all of that for the one in front of you.
      </p>
      <p class="stats">
        <Num n={stats.models ?? 0} /> model years · <Num n={stats.makes ?? 0} /> makes ·{' '}
        <Num n={stats.recalls ?? 0} /> recalls · <Num n={stats.complaints ?? 0} /> complaints ·{' '}
        <Num n={vins.vins ?? 0} /> VINs decoded
      </p>
    </section>

    <section>
      <form class="row" method="get" action="/vin">
        <div class="field">
          <label class="label" for="vin">
            VIN
          </label>
          <input
            id="vin"
            name="vin"
            type="text"
            value={vin ?? ''}
            placeholder="1HGCM82633A004352"
            maxlength="17"
            autocomplete="off"
            autocapitalize="characters"
            spellcheck="false"
            aria-describedby="vin-help"
            aria-invalid={error ? 'true' : undefined}
          />
        </div>
        <div class="field">
          <label class="label" for="miles">
            Miles
          </label>
          {/* Kept across a submit: retyping the odometer to change one
              character of the VIN is the kind of small rudeness that makes a
              form feel broken. */}
          <input
            id="miles"
            name="miles"
            type="number"
            value={miles ?? ''}
            placeholder="84000"
            min="0"
            step="1000"
            inputmode="numeric"
          />
        </div>
        <button class="cta" type="submit">
          Look it up
        </button>
      </form>
      <p class="help" id="vin-help">
        Seventeen characters, from the corner of the windscreen or the driver's door jamb. A VIN
        never contains I, O or Q. Miles is optional and only used to work out what the car is due
        for.
      </p>
      <Notice error={error} />
    </section>

    {profile ? <Profile profile={profile} /> : null}

    <section>
      <h2>Follow it instead</h2>
      <p>
        The feeds are free and unmetered: <a href="/f/do-not-drive">do-not-drive recalls</a>,{' '}
        <a href="/f/vehicle-recalls">every recall</a>,{' '}
        <a href="/f/owner-complaints">owner complaints</a>,{' '}
        <a href="/f/crashes-and-fires">complaints involving a crash or fire</a>,{' '}
        <a href="/f/crash-test-ratings">crash-test ratings</a> and the{' '}
        <a href="/f/vehicle-catalog">catalogue of makes, models and years</a>. Each one has a page,
        RSS, JSON Feed and a webhook.
      </p>
      <h3>For agents</h3>
      <p class="small">
        <code>GET /api/v1/automotive/vin/{'{vin}'}</code> ·{' '}
        <code>
          GET /api/v1/automotive/vehicle/{'{year}'}/{'{make}'}/{'{model}'}
        </code>{' '}
        · <code>GET /api/v1/automotive/mechanics?lat=&amp;lon=</code> ·{' '}
        <code>GET /api/v1/automotive/parts?year=&amp;make=&amp;model=&amp;part=</code>
      </p>
      <p class="small muted">
        The catalogue and the feeds are free. Assembled vehicle lookups are{' '}
        {config.automotive.freeLookupsPerHour} an hour free, then{' '}
        {money(config.automotive.dayCents)} a day on a crawl pass or{' '}
        {money(config.automotive.monthlyCents)} a month. Pro includes them.
      </p>
    </section>
  </Layout>
);
