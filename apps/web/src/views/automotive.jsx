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

/**
 * The grade, and immediately beside it the reason not to over-read it.
 *
 * A single letter is the most quotable thing on this page, so the confidence
 * it was computed at travels with it everywhere it appears. A B computed
 * without a title record is a different claim from a B computed with one, and
 * a reader who only takes the letter away should still have taken that away.
 */
const Grade = ({ score }) => (
  <div class={`grade grade-${score.grade.toLowerCase()}`}>
    <span class="grade-letter">{score.grade}</span>
    <span class="grade-score">{score.score}/100</span>
    <span class="grade-confidence">{score.confidence} confidence</span>
  </div>
);

const Factor = ({ f }) => (
  <li class="factor">
    <p class="factor-head">
      <span class="factor-label">{f.label}</span>
      <span class={f.points < 0 ? 'factor-points down' : 'factor-points'}>
        {f.points === 0 ? 'no deduction' : `${f.points}`}
      </span>
    </p>
    <p class="small">{f.evidence}</p>
    <p class="small muted">
      {f.source}
      {f.scope === 'same-build' ? ' · vehicles built exactly like this one' : null}
      {f.scope === 'same-model-year' ? ' · this model year, all builds' : null}
      {f.unverified ? ' · not verified' : null}
    </p>
    {f.note ? <p class="small">{f.note}</p> : null}
  </li>
);

/**
 * What a report like this cannot see.
 *
 * Given the same prominence as the score, because the gap between "no crash on
 * record" and "no crash" is the whole difference between a useful report and a
 * misleading one, and it is a gap a reader will close on their own if nobody
 * stops them.
 */
const Gaps = ({ score, history }) => (
  <div class="gaps">
    <h4>What this rating could not see</h4>
    <ul class="small">
      {score.unknown.map((u) => (
        <li key={u.key}>
          <strong>{u.label}.</strong> {u.why}
        </li>
      ))}
      {score.notCovered.map((n) => (
        <li key={n}>{n}</li>
      ))}
    </ul>
    {!history?.available && history?.elsewhere ? (
      <>
        <h4>Where to get the rest</h4>
        <ul class="small">
          {history.elsewhere.map((p) => (
            <li key={p.name}>
              <strong>
                {p.url ? (
                  <a href={p.url} rel="noopener nofollow">
                    {p.name}
                  </a>
                ) : (
                  p.name
                )}
              </strong>{' '}
              <span class="muted">({p.cost})</span> {p.covers}
            </li>
          ))}
        </ul>
      </>
    ) : null}
  </div>
);

const TimelineRow = ({ e }) => (
  <li class={`event event-${e.severity}`}>
    <p class="event-head">
      <span class="event-date">{e.date ?? 'undated'}</span>
      <span class="event-title">{e.title}</span>
      <span class={e.scope === 'this-vehicle' ? 'tag ok' : 'tag'}>
        {e.scope === 'this-vehicle'
          ? 'this vehicle'
          : e.scope === 'same-build'
            ? 'this exact build'
            : 'this model year'}
      </span>
    </p>
    {e.detail ? <p class="small">{e.detail}</p> : null}
    <p class="small muted">
      {e.source}
      {e.url ? (
        <>
          {' · '}
          <a href={e.url} rel="noopener">
            source
          </a>
        </>
      ) : null}
    </p>
  </li>
);

/**
 * The history report: the grade, the working behind it, and the timeline.
 *
 * Ordered the way the question is actually asked. Is there anything wrong with
 * this car, why do you say that, when did it happen, and what do you not know.
 */
const HistoryReport = ({ profile }) => {
  const score = profile.score;
  if (!score) return null;
  const acc = profile.accidents;
  const history = profile.history;
  const timeline = profile.timeline ?? [];
  return (
    <section class="report">
      <h3>History and condition rating</h3>
      <div class="report-head">
        <Grade score={score} />
        <div>
          <p class="report-band">{score.band}</p>
          <p class="small muted">{score.disclaimer}</p>
        </div>
      </div>

      {acc ? (
        <div class="report-block">
          <h4>Accidents on record</h4>
          <p class="stats">
            <Num n={acc.build.crashes ?? 0} /> crashes · <Num n={acc.build.fires ?? 0} /> fires ·{' '}
            <Num n={acc.build.injuries ?? 0} /> injuries · <Num n={acc.build.deaths ?? 0} /> deaths
            <span class="muted"> reported on this exact build</span>
          </p>
          <p class="stats muted">
            <Num n={acc.model.crashes ?? 0} /> crashes and <Num n={acc.model.fires ?? 0} /> fires
            across all <Num n={acc.model.complaints ?? 0} /> complaints for this model year
          </p>
          <p class="small muted">{acc.note}</p>
        </div>
      ) : null}

      <div class="report-block">
        <h4>Title record</h4>
        {history?.available ? (
          <>
            <p>
              {history.classified?.severe?.length ? (
                <span class="tag danger">{history.classified.severe.join(', ')}</span>
              ) : (
                'No salvage, junk or flood brand on the federal title record.'
              )}
            </p>
            <p class="small muted">
              {history.source} · checked {history.cached ? 'from our copy' : 'just now'}
            </p>
          </>
        ) : (
          <div class="alert" role="note">
            <p class="alert-title">No title record was checked for this VIN.</p>
            <p class="small">{history?.explanation}</p>
          </div>
        )}
      </div>

      <div class="report-block">
        <h4>How the rating was reached</h4>
        <ul class="factors">
          {score.factors.map((f) => (
            <Factor key={f.key} f={f} />
          ))}
        </ul>
      </div>

      {timeline.length ? (
        <div class="report-block">
          <h4>Timeline ({timeline.length})</h4>
          <ul class="events">
            {timeline.slice(0, 25).map((e, i) => (
              <TimelineRow key={`${e.date}-${e.type}-${i}`} e={e} />
            ))}
          </ul>
        </div>
      ) : null}

      <Gaps score={score} history={history} />
    </section>
  );
};

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
          {h.conditionGrade ? (
            <>
              {' · '}
              <strong>
                grade {h.conditionGrade} ({h.conditionScore}/100)
              </strong>
            </>
          ) : null}
        </p>
      </section>

      <HistoryReport profile={profile} />

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
        <h3>Recall campaigns ({profile.recalls.length})</h3>
        {/* Not "open recalls on this car": NHTSA's free data answers by year,
            make and model, so this is every campaign issued against the model
            year, remedied or not. Only NHTSA's own by-VIN tool can say whether
            this car was in an affected batch and whether the work was done, so
            the page sends people there rather than implying an answer. */}
        <p class="small muted">
          Every campaign NHTSA has issued against this model year, not confirmed open recalls on
          this VIN. Check the VIN itself, free, at{' '}
          <a href="https://www.nhtsa.gov/recalls" rel="noopener">
            nhtsa.gov/recalls
          </a>
          . Recall work is free at a franchised dealer.
        </p>
        {profile.recalls.length ? (
          <ul class="cards">
            {profile.recalls.map((r) => (
              <Recall key={r.campaign} r={r} />
            ))}
          </ul>
        ) : (
          <p class="muted">NHTSA lists no recall campaigns for this vehicle.</p>
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
