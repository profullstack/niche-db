import { Layout } from './Layout.jsx';

/**
 * Airplanes, satellites and ships. Each landing is a lookup box, a few counts
 * from the stored collection and one live list; each thing's page is the
 * register row as facts (with where each fact came from) and, beside it, where
 * the thing is right now.
 */

const fmt = (n, digits = 0) =>
  Number.isFinite(Number(n)) && n !== null
    ? Number(n).toLocaleString('en-US', { maximumFractionDigits: digits })
    : null;
const day = (iso) => (iso ? String(iso).slice(0, 10) : null);
const when = (iso) => (iso ? `${String(iso).slice(0, 16).replace('T', ' ')} UTC` : null);
const osm = (lat, lon, zoom = 7) =>
  lat === null || lon === null || lat === undefined || lon === undefined
    ? null
    : `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=${zoom}/${lat}/${lon}`;

const Lookup = ({ action, value = '', placeholder, label }) => (
  <form method="get" action={action} class="inline">
    <input name="q" value={value} placeholder={placeholder} aria-label={label} required />
    <button type="submit">Look up</button>
  </form>
);

/** Rows of label/value, skipping the empty ones. */
const Facts = ({ rows }) => {
  const shown = rows.filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (!shown.length) return null;
  return (
    <table>
      <tbody>
        {shown.map(([k, v]) => (
          <tr>
            <th scope="row">{k}</th>
            <td>{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

const Counts = ({ counts, labels }) => {
  const rows = labels
    .map(([tag, label]) => [label, counts.tags?.[tag]])
    .filter(([, n]) => Number.isFinite(n));
  return (
    <section>
      <h2>What is in it</h2>
      <p>
        {fmt(counts.items) ?? 0} rows in{' '}
        <a href={`/c/${counts.collection?.slug ?? ''}`}>the collection</a>
        {counts.computedAt ? `, counted ${day(counts.computedAt)}` : ''}.
      </p>
      {rows.length ? (
        <table>
          <tbody>
            {rows.map(([label, n]) => (
              <tr>
                <td>{label}</td>
                <td class="num">{fmt(n)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
};

const RowList = ({ rows, href = (r) => r.page }) =>
  rows.length ? (
    <ul>
      {rows.map((r) => (
        <li>
          <a href={href(r)}>{r.title}</a>
          {r.summary ? <span class="muted"> — {r.summary}</span> : null}
        </li>
      ))}
    </ul>
  ) : (
    <p class="muted">Nothing right now.</p>
  );

const Matches = ({ report, base }) => (
  <section>
    <h2>Matches for “{report.query}”</h2>
    {report.matches.length ? (
      <RowList
        rows={report.matches}
        href={(r) =>
          `${base}/${encodeURIComponent(base === '/airplanes' ? r.data.nNumber : base === '/satellites' ? (r.data.norad ?? r.externalId) : r.data.mmsi)}`
        }
      />
    ) : (
      <p>No stored row matches. Try the exact number.</p>
    )}
  </section>
);

const ErrorBox = ({ report }) => (
  <section>
    <p class="error">{report.error}</p>
  </section>
);

const Json = ({ href }) => (
  <p class="muted">
    The same as JSON: <a href={href}>{href}</a>
  </p>
);

/* ------------------------------------------------------------ airplanes -- */

export function AirplanesLanding({ user, counts, emergencies = [] }) {
  return (
    <Layout
      user={user}
      canonical="/airplanes"
      title="Airplanes: every US-registered aircraft, and where it is now"
      description="Look up any aircraft by N-number, Mode S hex or callsign: the FAA register (maker, model, year, seats, engines, airworthiness, registration status) joined to its live ADS-B position from adsb.lol. 319,000 aircraft, public domain."
    >
      <section class="hero">
        <h1>Airplanes</h1>
        <p class="lede">
          Every aircraft on the US civil register, from the FAA’s nightly database, joined to where
          it is flying right now on the adsb.lol receiver network. Type a tail number, the
          six-character hex its transponder sends, or a flight’s callsign.
        </p>
        <Lookup
          action="/airplanes"
          placeholder="N172SP, A2D8E1, UAL1, Cessna 172"
          label="N-number, hex or callsign"
        />
      </section>

      <section>
        <h2>Squawking an emergency right now</h2>
        <RowList rows={emergencies} />
        <p>
          <a href="/f/aircraft-emergency">7700 emergencies</a>,{' '}
          <a href="/f/aircraft-radio-failure">7600 lost radio</a>,{' '}
          <a href="/f/aircraft-military">military traffic</a>, and the rest of{' '}
          <a href="/c/aviation">aviation</a>: FAA ground stops and delays, SIGMETs, METARs and every
          NTSB accident.
        </p>
      </section>

      <Counts
        counts={counts}
        labels={[
          ['registered', 'Currently registered'],
          ['fixed-wing-single-engine', 'Single-engine airplanes'],
          ['fixed-wing-multi-engine', 'Multi-engine airplanes'],
          ['rotorcraft', 'Helicopters'],
          ['cert-experimental', 'Experimental'],
          ['kit-built', 'Kit-built'],
          ['owner-individual', 'Owned by individuals'],
          ['owner-corporation', 'Owned by corporations'],
          ['owner-llc', 'Owned by LLCs'],
        ]}
      />

      <section>
        <h2>Follow</h2>
        <ul>
          <li>
            <a href="/f/faa-aircraft-register">The register</a> (new rows are newly registered
            aircraft), <a href="/f/faa-rotorcraft">helicopters</a>,{' '}
            <a href="/f/faa-experimental-aircraft">experimental and kit-built</a>
          </li>
          <li>
            API: <code>/api/v1/airplanes/N172SP</code>, and the collection at{' '}
            <a href="/c/aircraft">/c/aircraft</a> with RSS, JSON and MCP
          </li>
        </ul>
        <p class="muted">
          Private owners’ names and street addresses are left out; the FAA’s own lookup, linked from
          every aircraft, has the public record. Live positions: adsb.lol, a community ADS-B
          network.
        </p>
      </section>
    </Layout>
  );
}

export function AirplanePage({ user, report }) {
  const r = report ?? {};
  const d = r.record?.data ?? {};
  const live = r.live ?? [];
  const id = d.nNumber ?? live[0]?.hex ?? r.query;
  return (
    <Layout
      user={user}
      canonical={`/airplanes/${encodeURIComponent(id ?? '')}`}
      title={r.record ? `${r.record.title}` : `Aircraft ${r.query ?? ''}`}
      description={r.record?.summary ?? `Live ADS-B and FAA register lookup for ${r.query ?? ''}.`}
    >
      <section class="hero">
        <h1>
          {r.record?.title ??
            (live[0]
              ? `${live[0].callsign ?? live[0].hex}${live[0].type ? ` (${live[0].type})` : ''}`
              : r.query)}
        </h1>
        <Lookup
          action="/airplanes"
          value={r.query ?? ''}
          placeholder="N-number, hex or callsign"
          label="N-number, hex or callsign"
        />
      </section>
      {r.error ? <ErrorBox report={r} /> : null}
      {r.matches ? <Matches report={r} base="/airplanes" /> : null}

      {!r.error && !r.matches ? (
        <>
          <section>
            <h2>Right now</h2>
            {live.length ? (
              live.map((a) => (
                <Facts
                  rows={[
                    ['Callsign', a.callsign],
                    [
                      'Altitude',
                      a.onGround
                        ? 'on the ground'
                        : a.altitudeFt !== null
                          ? `${fmt(a.altitudeFt)} ft`
                          : null,
                    ],
                    [
                      'Ground speed',
                      a.groundSpeedKt !== null ? `${fmt(a.groundSpeedKt)} kt` : null,
                    ],
                    ['Track', a.trackDeg !== null ? `${fmt(a.trackDeg)}°` : null],
                    ['Squawk', a.squawk],
                    [
                      'Position',
                      a.lat !== null ? (
                        <a href={osm(a.lat, a.lon)}>
                          {a.lat.toFixed(3)}, {a.lon.toFixed(3)}
                        </a>
                      ) : null,
                    ],
                    [
                      'Seen',
                      a.seenSecondsAgo !== null ? `${fmt(a.seenSecondsAgo, 1)} s ago` : null,
                    ],
                    ['Map', a.map ? <a href={a.map}>adsb.lol globe</a> : null],
                  ]}
                />
              ))
            ) : (
              <p class="muted">
                Not heard by the adsb.lol network right now (parked, out of coverage, or not
                transmitting).
              </p>
            )}
          </section>

          {r.record ? (
            <section>
              <h2>FAA register</h2>
              <p>{r.record.summary}</p>
              <Facts
                rows={[
                  ['N-number', d.nNumber],
                  ['Mode S hex', d.icaoHex?.toUpperCase()],
                  ['Maker', d.manufacturer ?? d.kitManufacturer],
                  ['Model', d.model ?? d.kitModel],
                  ['Year built', d.year],
                  ['Serial number', d.serialNumber],
                  ['Type', d.aircraftType],
                  [
                    'Engine',
                    [
                      d.engines ? `${d.engines} ×` : null,
                      d.engine?.manufacturer,
                      d.engine?.model,
                      d.engineType ? `(${d.engineType})` : null,
                    ]
                      .filter(Boolean)
                      .join(' ') || null,
                  ],
                  ['Horsepower', d.engine?.horsepower ? fmt(d.engine.horsepower) : null],
                  ['Seats', d.seats],
                  ['Cruise speed', d.cruiseMph ? `${d.cruiseMph} mph` : null],
                  ['Weight class', d.weightClass],
                  ['Airworthiness', d.certification],
                  ['Registrant', d.owner ?? d.registrantType],
                  ['Based in', [d.city, d.state, d.country].filter(Boolean).join(', ') || null],
                  ['Registration', d.status],
                  ['Registered', d.registeredAt],
                  ['Expires', d.expiresAt],
                  ['Airworthiness date', d.airworthinessAt],
                  ['FAA record', <a href={r.record.url}>registry.faa.gov</a>],
                ]}
              />
              {d.note ? <p class="muted">{d.note}</p> : null}
            </section>
          ) : (
            <section>
              <p class="muted">
                Not on the US register: likely a foreign aircraft, which the FAA does not list.
              </p>
            </section>
          )}
          <Json href={`/api/v1/airplanes/${encodeURIComponent(id ?? '')}`} />
        </>
      ) : null}
    </Layout>
  );
}

/* ----------------------------------------------------------- satellites -- */

export function SatellitesLanding({ user, counts, launches = [], iss }) {
  return (
    <Layout
      user={user}
      canonical="/satellites"
      title="Satellites: every object in orbit, and where it is now"
      description="Look up any satellite, rocket stage or piece of debris by NORAD number, designator or name: owner, country, maker, launch and reentry, mass and orbit from GCAT, and its position over the Earth right now from the latest orbital elements."
    >
      <section class="hero">
        <h1>Satellites</h1>
        <p class="lede">
          Every object catalogued in Earth orbit since Sputnik, from Jonathan McDowell’s GCAT, with
          where it is right now computed from the latest orbital elements (SatNOGS). Type a NORAD
          number, an international designator or a name.
        </p>
        <Lookup
          action="/satellites"
          placeholder="25544, 1998-067A, Hubble, Starlink"
          label="NORAD number, designator or name"
        />
      </section>

      {iss ? (
        <section>
          <h2>The ISS right now</h2>
          <p>
            Over{' '}
            <a href={osm(iss.lat, iss.lon, 4)}>
              {iss.lat.toFixed(2)}, {iss.lon.toFixed(2)}
            </a>{' '}
            at {fmt(iss.altitudeKm)} km, {fmt(iss.speedKmS, 2)} km/s, once round every{' '}
            {fmt(iss.periodMin, 1)} minutes. <a href="/satellites/25544">More</a>
          </p>
        </section>
      ) : null}

      <section>
        <h2>Latest launches</h2>
        <RowList
          rows={launches}
          href={(r) => `/satellites/${r.data.norad ?? encodeURIComponent(r.externalId)}`}
        />
      </section>

      <Counts
        counts={counts}
        labels={[
          ['in-orbit', 'Still in orbit'],
          ['down', 'Reentered, landed or gone'],
          ['payload', 'Satellites (payloads)'],
          ['debris', 'Debris'],
          ['rocket-stage', 'Rocket stages'],
          ['family-starlink', 'Starlink'],
          ['orbit-leo', 'Low Earth orbit'],
          ['orbit-geo', 'Geosynchronous'],
          ['state-us', 'United States'],
          ['state-cn', 'China'],
          ['state-su', 'Soviet Union'],
          ['state-ru', 'Russia'],
        ]}
      />

      <section>
        <h2>Follow</h2>
        <ul>
          <li>
            <a href="/f/satellites-payloads">Satellites</a>,{' '}
            <a href="/f/starlink-satellites">Starlink</a>,{' '}
            <a href="/f/geostationary-satellites">geosynchronous</a>,{' '}
            <a href="/f/space-debris">debris</a>, <a href="/f/space-objects">everything</a>
          </li>
          <li>
            Launches and space weather: <a href="/c/space">upcoming rocket launches</a> and NOAA
            space weather in <a href="/c/weather">weather</a>
          </li>
          <li>
            API: <code>/api/v1/satellites/25544</code>, and{' '}
            <a href="/c/satellites">/c/satellites</a> with RSS, JSON and MCP
          </li>
        </ul>
        <p class="muted">
          Catalogue: McDowell, Jonathan C., General Catalog of Artificial Space Objects,
          planet4589.org/space/gcat (CC-BY). Orbital elements: SatNOGS DB (CC BY-SA).
        </p>
      </section>
    </Layout>
  );
}

export function SatellitePage({ user, report }) {
  const r = report ?? {};
  const d = r.record?.data ?? {};
  const p = r.position;
  const id = d.norad ?? r.parsed?.value ?? r.query;
  return (
    <Layout
      user={user}
      canonical={`/satellites/${encodeURIComponent(id ?? '')}`}
      title={r.record?.title ?? r.tle?.name ?? `Satellite ${r.query ?? ''}`}
      description={r.record?.summary ?? `Where NORAD ${id} is right now.`}
    >
      <section class="hero">
        <h1>{r.record?.title ?? r.tle?.name ?? r.query}</h1>
        <Lookup
          action="/satellites"
          value={r.query ?? ''}
          placeholder="NORAD number, designator or name"
          label="NORAD number, designator or name"
        />
      </section>
      {r.error ? <ErrorBox report={r} /> : null}
      {r.matches ? <Matches report={r} base="/satellites" /> : null}
      {!r.error && !r.matches ? (
        <>
          <section>
            <h2>Right now</h2>
            {p ? (
              <>
                <Facts
                  rows={[
                    [
                      'Over',
                      <a href={osm(p.lat, p.lon, 4)}>
                        {p.lat.toFixed(3)}, {p.lon.toFixed(3)}
                      </a>,
                    ],
                    ['Altitude', `${fmt(p.altitudeKm, 1)} km`],
                    ['Speed', p.speedKmS !== null ? `${fmt(p.speedKmS, 3)} km/s` : null],
                    ['Orbital period', `${fmt(p.periodMin, 1)} min`],
                    ['Computed for', when(p.at)],
                    [
                      'Elements from',
                      `${when(p.tleEpoch)} (${fmt(p.tleAgeDays, 1)} days old${r.tle?.source ? `, ${r.tle.source} via SatNOGS` : ''})`,
                    ],
                  ]}
                />
                {p.tleAgeDays > 14 ? (
                  <p class="muted">
                    These elements are old, so the position may be well off; the object may no
                    longer be tracked.
                  </p>
                ) : null}
                <pre>{`${r.tle.name ?? ''}\n${r.tle.line1}\n${r.tle.line2}`}</pre>
              </>
            ) : (
              <p class="muted">
                {d.inOrbit === false
                  ? `Not in orbit: ${d.status}${d.decayedAt ? ` ${d.decayedAt}` : ''}.`
                  : 'No current orbital elements on SatNOGS for this object.'}
              </p>
            )}
          </section>
          {r.record ? (
            <section>
              <h2>Catalogue</h2>
              <p>{r.record.summary}</p>
              <Facts
                rows={[
                  ['NORAD number', d.norad],
                  ['International designator', d.designator],
                  ['Name', d.name],
                  ['Payload name', d.payloadName !== d.name ? d.payloadName : null],
                  ['Type', d.objectType],
                  ['Status', d.status],
                  ['Launched', d.launchedAt],
                  ['Down', d.decayedAt],
                  ['Country', d.state],
                  ['Owner', d.owner],
                  ['Maker', d.manufacturer],
                  ['Bus', d.bus],
                  ['Mass', d.massKg ? `${fmt(d.massKg)} kg` : null],
                  [
                    'Size',
                    [d.lengthM, d.diameterM, d.spanM].some(Boolean)
                      ? `${d.lengthM ?? '?'} m long, ${d.diameterM ?? '?'} m across${d.spanM ? `, ${d.spanM} m span` : ''}`
                      : null,
                  ],
                  ['Orbit', d.orbit ? `${d.orbit} (${d.orbitClass})` : null],
                  [
                    'Perigee × apogee',
                    d.perigeeKm !== null && d.apogeeKm !== null
                      ? `${fmt(d.perigeeKm)} × ${fmt(d.apogeeKm)} km`
                      : null,
                  ],
                  ['Inclination', d.inclinationDeg !== null ? `${d.inclinationDeg}°` : null],
                  ['Also known as', d.altNames],
                  [
                    'Family',
                    d.family ? (
                      <a
                        href={`/f/${d.family === 'starlink' ? 'starlink-satellites' : 'satellites-payloads'}`}
                      >
                        {d.family}
                      </a>
                    ) : null,
                  ],
                ]}
              />
              <p class="muted">Source: {d.credit}</p>
            </section>
          ) : null}
          <Json href={`/api/v1/satellites/${encodeURIComponent(id ?? '')}`} />
        </>
      ) : null}
    </Layout>
  );
}

/* ---------------------------------------------------------------- ships -- */

export function ShipsLanding({ user, counts, ferries = [] }) {
  return (
    <Layout
      user={user}
      canonical="/ships"
      title="Ships: vessels on open AIS, and where they are now"
      description="Look up a ship or boat by name, MMSI or IMO number: type, flag, size, call sign, stated destination and live position from open AIS (Digitraffic, northern Baltic, CC BY 4.0)."
    >
      <section class="hero">
        <h1>Ships and boats</h1>
        <p class="lede">
          Vessels from open AIS: name, MMSI, IMO, type, flag, size, stated destination and where
          each one in range is right now. Type a name, a nine-digit MMSI or an IMO number.
        </p>
        <Lookup
          action="/ships"
          placeholder="Viking Grace, 230629000, IMO 9606900"
          label="Ship name, MMSI or IMO"
        />
      </section>

      <section>
        <h2>Passenger ships in range now</h2>
        <RowList rows={ferries} href={(r) => `/ships/${r.data.mmsi}`} />
      </section>

      <Counts
        counts={counts}
        labels={[
          ['in-range', 'In range at the last pass'],
          ['cargo', 'Cargo'],
          ['tanker', 'Tankers'],
          ['passenger', 'Passenger'],
          ['pleasure-craft', 'Pleasure craft'],
          ['sailing', 'Sailing'],
          ['fishing', 'Fishing'],
          ['tug', 'Tugs'],
          ['flag-fi', 'Finnish flag'],
          ['flag-se', 'Swedish flag'],
          ['flag-ee', 'Estonian flag'],
        ]}
      />

      <section>
        <h2>Follow</h2>
        <ul>
          <li>
            <a href="/f/ships-passenger">Passenger ships</a>, <a href="/f/ships-cargo">cargo</a>,{' '}
            <a href="/f/ships-tankers">tankers</a>, <a href="/f/ships-baltic-ais">every vessel</a>
          </li>
          <li>
            Sea state: <a href="/c/water">NOAA buoys and surf forecasts</a>
          </li>
          <li>
            API: <code>/api/v1/ships/230629000</code>, and <a href="/c/ships">/c/ships</a> with RSS,
            JSON, near= and MCP
          </li>
        </ul>
        <p class="muted">
          Coverage: Finland’s coastal AIS network (Digitraffic, Fintraffic, CC BY 4.0), the northern
          Baltic. There is no keyless worldwide AIS feed; more open networks will join as sources.
        </p>
      </section>
    </Layout>
  );
}

export function ShipPage({ user, report }) {
  const r = report ?? {};
  const d = r.record?.data ?? {};
  const live = r.live;
  const id = d.mmsi ?? r.query;
  return (
    <Layout
      user={user}
      canonical={`/ships/${encodeURIComponent(id ?? '')}`}
      title={r.record?.title ?? `Vessel ${r.query ?? ''}`}
      description={r.record?.summary ?? `AIS lookup for ${r.query ?? ''}.`}
    >
      <section class="hero">
        <h1>{r.record?.title ?? r.query}</h1>
        <Lookup
          action="/ships"
          value={r.query ?? ''}
          placeholder="Ship name, MMSI or IMO"
          label="Ship name, MMSI or IMO"
        />
      </section>
      {r.error ? <ErrorBox report={r} /> : null}
      {r.matches ? <Matches report={r} base="/ships" /> : null}
      {!r.error && !r.matches ? (
        <>
          <section>
            <h2>Right now</h2>
            {live ? (
              <Facts
                rows={[
                  [
                    'Position',
                    live.lat !== null ? (
                      <a href={osm(live.lat, live.lon, 10)}>
                        {live.lat.toFixed(4)}, {live.lon.toFixed(4)}
                      </a>
                    ) : null,
                  ],
                  ['Status', live.navStatus],
                  ['Speed', live.speedKn !== null ? `${live.speedKn} kn` : null],
                  ['Course', live.courseDeg !== null ? `${live.courseDeg}°` : null],
                  ['Heading', live.headingDeg !== null ? `${live.headingDeg}°` : null],
                  ['Heard', when(live.at)],
                ]}
              />
            ) : (
              <p class="muted">Out of range of the open AIS networks we read right now.</p>
            )}
          </section>
          {r.record ? (
            <section>
              <h2>Vessel</h2>
              <p>{r.record.summary}</p>
              <Facts
                rows={[
                  ['Name', d.name],
                  ['MMSI', d.mmsi],
                  ['IMO', d.imo],
                  ['Call sign', d.callSign],
                  ['Type', d.shipType],
                  ['Flag', d.flag ?? (d.mid ? `MID ${d.mid}` : null)],
                  ['Length', d.lengthM ? `${d.lengthM} m` : null],
                  ['Beam', d.beamM ? `${d.beamM} m` : null],
                  ['Draught', d.draughtM ? `${d.draughtM} m` : null],
                  ['Stated destination', d.destination],
                  ['Network', d.network],
                  ['Elsewhere', <a href={r.record.url}>MarineTraffic</a>],
                ]}
              />
              <p class="muted">Source: {d.source}</p>
            </section>
          ) : null}
          <Json href={`/api/v1/ships/${encodeURIComponent(id ?? '')}`} />
        </>
      ) : null}
    </Layout>
  );
}
