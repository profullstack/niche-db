import { raw } from 'hono/html';
import { Layout } from './Layout.jsx';

/**
 * Transit: /transit (the cities), /transit/<city> (a live map, lines, alerts,
 * every station), /transit/<city>/<station> (next arrivals and the timetable).
 * The map is Leaflet over OpenStreetMap tiles; vehicles are polled from
 * /api/v1/transit/<city>/vehicles every 15 seconds.
 */

const when = (iso, tz) =>
  iso
    ? new Date(iso).toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: tz ?? 'UTC',
      })
    : '';
const Dot = ({ color }) => (
  <span
    style={`display:inline-block;width:.8em;height:.8em;border-radius:50%;background:${color ?? '#888'};margin-right:.35em;vertical-align:baseline`}
  />
);
const json = (v) => JSON.stringify(v).replace(/</g, '\\u003c');

export function TransitLanding({ user, cities = [] }) {
  return (
    <Layout
      user={user}
      canonical="/transit"
      title="Transit: live maps, arrivals and timetables for big cities"
      description="Public transit in New York, Boston, the Bay Area, Chicago, London, Toronto and Philadelphia: a live map of the trains and buses, every station's next arrivals, first and last trains and how often they come, and the service alerts in force."
    >
      <section class="hero">
        <h1>Transit</h1>
        <p class="lede">
          Live maps of the trains and buses, the next arrivals at every station, first and last
          trains and how often they come, and the alerts in force, from each agency’s own open
          feeds.
        </p>
      </section>
      <section>
        <table>
          <thead>
            <tr>
              <th>City</th>
              <th>System</th>
              <th class="num">Lines</th>
              <th class="num">Stations</th>
              <th class="num">Alerts now</th>
              <th>Live</th>
            </tr>
          </thead>
          <tbody>
            {cities.map((c) => (
              <tr>
                <td>
                  <a href={`/transit/${c.slug}`}>{c.name}</a>
                </td>
                <td>{c.system}</td>
                <td class="num">{c.lines || ''}</td>
                <td class="num">{c.stations || ''}</td>
                <td class="num">{c.alerts || ''}</td>
                <td>{c.live}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section>
        <h2>Follow</h2>
        <ul>
          <li>
            <a href="/f/transit-alerts">Service alerts in every city</a>,{' '}
            <a href="/f/nyc-subway-alerts">NYC subway</a>,{' '}
            <a href="/f/london-tube-status">London disruptions</a>
          </li>
          <li>
            API: <code>/api/v1/transit/nyc</code>, <code>/api/v1/transit/nyc/vehicles</code>,{' '}
            <code>/api/v1/transit/nyc/127</code>; the stored rows at{' '}
            <a href="/c/transit">/c/transit</a>
          </li>
          <li>
            Intercity rail is at <a href="/trains">/trains</a>
          </li>
        </ul>
        <p class="muted">
          Sources: MTA, MBTA, BART and CTA GTFS and GTFS-realtime; TfL Unified API; TTC via Umo IQ;
          SEPTA TransitView and TrainView. Map © OpenStreetMap contributors.
        </p>
      </section>
    </Layout>
  );
}

export function CityPage({ user, slug, city, lines = [], stations = [], alerts = [] }) {
  const points = stations
    .filter((s) => s.data.place)
    .map((s) => ({
      id: s.data.stationId,
      n: s.data.name,
      la: s.data.place.lat,
      lo: s.data.place.lon,
      c: s.data.lines?.[0]?.color ?? '#555',
    }));
  const sorted = [...stations].sort((a, b) => a.data.name.localeCompare(b.data.name));
  const sortedLines = [...lines].sort((a, b) =>
    String(a.data.name).localeCompare(String(b.data.name), 'en', { numeric: true }),
  );
  return (
    <Layout
      user={user}
      canonical={`/transit/${slug}`}
      title={`${city.name} transit: live map, arrivals and timetables`}
      description={`A live map of the ${city.system} in ${city.name}, every station's next arrivals and timetable, and the service alerts in force.`}
    >
      <link
        rel="stylesheet"
        href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css"
      />
      <section class="hero">
        <h1>{city.name}</h1>
        <p class="lede">
          {city.system}. <span id="vcount">Loading vehicles…</span>
        </p>
      </section>
      <div
        id="map"
        style="height:min(70vh,560px);width:100%;border-radius:8px;margin-bottom:1rem"
      />

      {alerts.length ? (
        <section>
          <h2>Alerts in force ({alerts.length})</h2>
          <ul>
            {alerts.slice(0, 15).map((a) => (
              <li>
                <a href={a.page}>{a.title.replace(` (${city.name})`, '')}</a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {sortedLines.length ? (
        <section>
          <h2>Lines</h2>
          <p>
            {sortedLines.map((l) => (
              <span style="display:inline-block;margin:0 1em .3em 0">
                <Dot color={l.data.color} />
                {l.data.name}
                {l.data.longName && l.data.longName !== l.data.name ? ` ${l.data.longName}` : ''}
              </span>
            ))}
          </p>
        </section>
      ) : null}

      {sorted.length ? (
        <section>
          <h2>Stations ({sorted.length})</h2>
          <input
            id="sfilter"
            placeholder="Filter stations"
            aria-label="Filter stations"
            style="max-width:24rem"
          />
          <ul id="slist" style="columns:16rem;margin-top:.75rem">
            {sorted.map((s) => (
              <li data-n={s.data.name.toLowerCase()}>
                <a href={`/transit/${slug}/${encodeURIComponent(s.data.stationId)}`}>
                  {s.data.name}
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <p class="muted">
          This city publishes live vehicle positions only; stations and timetables are not in its
          open feed.
        </p>
      )}
      <p class="muted">
        <a href={city.agencyUrl}>{city.system}</a> · JSON:{' '}
        <a href={`/api/v1/transit/${slug}`}>/api/v1/transit/{slug}</a>,{' '}
        <a href={`/api/v1/transit/${slug}/vehicles`}>vehicles</a>. Map © OpenStreetMap contributors.
      </p>

      <script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js" />
      {raw(`<script>
(function () {
  var city = ${json(slug)}, center = ${json(city.center)}, zoom = ${json(city.zoom)}, pts = ${json(points)};
  var map = L.map('map', { preferCanvas: true }).setView(center, zoom);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
  pts.forEach(function (p) {
    L.circleMarker([p.la, p.lo], { radius: 4, color: '#fff', weight: 1, fillColor: p.c, fillOpacity: 0.9 })
      .bindPopup('<a href="/transit/' + city + '/' + encodeURIComponent(p.id) + '">' + p.n.replace(/</g, '&lt;') + '</a>')
      .addTo(map);
  });
  var layer = L.layerGroup().addTo(map);
  function esc(s) { return String(s == null ? '' : s).replace(/[<&]/g, function (c) { return c === '<' ? '&lt;' : '&amp;'; }); }
  function load() {
    fetch('/api/v1/transit/' + city + '/vehicles').then(function (r) { return r.json(); }).then(function (d) {
      layer.clearLayers();
      (d.vehicles || []).forEach(function (v) {
        L.circleMarker([v.lat, v.lon], { radius: 6, color: '#111', weight: 1.5, fillColor: v.color || '#f5a623', fillOpacity: 1 })
          .bindPopup('<b>' + esc(v.line || v.route || 'Vehicle') + '</b>' + (v.label ? ' #' + esc(v.label) : '') +
            (v.status ? '<br>' + esc(v.status) : '') + (v.stop ? '<br>' + esc(v.stop) : ''))
          .addTo(layer);
      });
      var n = (d.vehicles || []).length;
      document.getElementById('vcount').textContent = n ? n + ' vehicles live, refreshed every 15 seconds.' : 'This city publishes no vehicle positions; arrivals are on each station page.';
    }).catch(function () {});
  }
  load(); setInterval(load, 15000);
  var f = document.getElementById('sfilter');
  if (f) f.addEventListener('input', function () {
    var q = f.value.toLowerCase();
    document.querySelectorAll('#slist li').forEach(function (li) { li.style.display = li.dataset.n.indexOf(q) >= 0 ? '' : 'none'; });
  });
})();
</script>`)}
    </Layout>
  );
}

const DAYNAME = { weekday: 'Weekdays', saturday: 'Saturday', sunday: 'Sunday' };

export function StationPage({ user, slug, city, station, arrivals = [], alerts = [] }) {
  const d = station.data;
  const sched = d.schedule;
  return (
    <Layout
      user={user}
      canonical={`/transit/${slug}/${encodeURIComponent(d.stationId)}`}
      title={`${d.name}: next trains and timetable (${city.name})`}
      description={`Next arrivals, first and last trains and frequency at ${d.name}, ${city.system}.`}
    >
      <section class="hero">
        <h1>{d.name}</h1>
        <p class="lede">
          {d.lines?.map((l) => (
            <span style="margin-right:1em">
              <Dot color={l.color} />
              {l.name}
            </span>
          ))}
        </p>
        <p>
          <a href={`/transit/${slug}`}>← {city.name} map</a>
          {d.place ? (
            <>
              {' · '}
              <a
                href={`https://www.openstreetmap.org/?mlat=${d.place.lat}&mlon=${d.place.lon}#map=16/${d.place.lat}/${d.place.lon}`}
              >
                where
              </a>
            </>
          ) : null}
          {d.wheelchair ? ' · step-free' : ''}
        </p>
      </section>

      <section>
        <h2>Next arrivals</h2>
        <p class="muted">Local time ({city.tz}). Refresh for the latest.</p>
        {arrivals.length ? (
          <table>
            <thead>
              <tr>
                <th>Line</th>
                <th>Toward</th>
                <th>Due</th>
                <th>In</th>
              </tr>
            </thead>
            <tbody>
              {arrivals.map((a) => (
                <tr>
                  <td>
                    <Dot color={a.color} />
                    {a.line ?? a.route ?? ''}
                  </td>
                  <td>
                    {a.toward ?? ''}
                    {a.platform ? ` · ${a.platform}` : ''}
                  </td>
                  <td>{when(a.at, city.tz)}</td>
                  <td>{a.inMinutes === 0 ? 'now' : `${a.inMinutes} min`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p class="muted">
            {city.kind === 'gtfs' && city.tripFeeds
              ? 'No live predictions for this station right now.'
              : 'This city publishes no live arrivals; the timetable is below.'}
          </p>
        )}
      </section>

      {alerts.length ? (
        <section>
          <h2>Alerts on these lines</h2>
          <ul>
            {alerts.map((a) => (
              <li>
                <a href={a.page}>{a.title.replace(` (${city.name})`, '')}</a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {sched
        ? Object.entries(DAYNAME).map(([day, label]) =>
            sched[day]?.length ? (
              <section>
                <h2>{label}</h2>
                <table>
                  <thead>
                    <tr>
                      <th>Line</th>
                      <th>Toward</th>
                      <th>First</th>
                      <th>Last</th>
                      <th class="num">Trips</th>
                      <th class="num">Busiest hour</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sched[day].map((r) => (
                      <tr>
                        <td>
                          <Dot color={r.color} />
                          {r.line}
                        </td>
                        <td>{r.toward ?? ''}</td>
                        <td>{r.first}</td>
                        <td>{r.last}</td>
                        <td class="num">{r.trips}</td>
                        <td class="num">{r.peakPerHour}/h</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            ) : null,
          )
        : null}
      <p class="muted">
        {d.scheduleNote} Source: {d.source}. JSON:{' '}
        <a href={`/api/v1/transit/${slug}/${encodeURIComponent(d.stationId)}`}>
          this station with arrivals
        </a>
        .
      </p>
    </Layout>
  );
}
