import { CITIES } from '@nichedb/core/transit';
import { render } from '../lib/http.js';
import { cityAlerts, cityTables, findStation, liveArrivals, liveVehicles } from '../lib/transit.js';
import { CityPage, StationPage, TransitLanding } from '../views/transit.jsx';

/**
 * Transit pages and API:
 *   /transit                         the cities
 *   /transit/<city>                  live map, lines, alerts, stations
 *   /transit/<city>/<station>        next arrivals and the timetable
 *   /api/v1/transit[/<city>[/vehicles|/<station>]]
 */

const setCache = (c, seconds) => c.header('cache-control', `public, max-age=${seconds}`);

const LIVE = {
  gtfs: (c) =>
    c.vehicles || c.vehiclesFromTrips
      ? 'map + arrivals'
      : c.tripFeeds
        ? 'arrivals'
        : 'timetable only',
  tfl: () => 'arrivals',
  umoiq: () => 'map',
  septa: () => 'map',
};

const cityOut = (slug, c) => ({
  slug,
  name: c.name,
  system: c.system,
  timeZone: c.tz,
  center: c.center,
  live: LIVE[c.kind]?.(c) ?? '',
  agency: c.agencyUrl,
});

const compactStation = (s) => ({
  id: s.data.stationId,
  name: s.data.name,
  place: s.data.place,
  lines: (s.data.lines ?? []).map((l) => l.name),
  page: `/transit/${s.data.city}/${encodeURIComponent(s.data.stationId)}`,
});

export function registerTransit(app) {
  app.get('/transit', async (c) => {
    const cities = await Promise.all(
      Object.entries(CITIES).map(async ([slug, city]) => {
        const [t, alerts] = await Promise.all([cityTables(slug), cityAlerts(slug, 200)]);
        return {
          ...cityOut(slug, city),
          lines: t.lines.length,
          stations: t.stations.length,
          alerts: alerts.length,
        };
      }),
    );
    setCache(c, 120);
    return c.html(await render(<TransitLanding user={c.get('user')} cities={cities} />));
  });

  app.get('/api/v1/transit', (c) => {
    setCache(c, 3600);
    return c.json({ cities: Object.entries(CITIES).map(([slug, city]) => cityOut(slug, city)) });
  });

  app.get('/transit/:city', async (c) => {
    const slug = c.req.param('city');
    const city = CITIES[slug];
    if (!city) return c.notFound();
    const [t, alerts] = await Promise.all([cityTables(slug), cityAlerts(slug)]);
    setCache(c, 120);
    return c.html(
      await render(
        <CityPage
          user={c.get('user')}
          slug={slug}
          city={city}
          lines={t.lines}
          stations={t.stations}
          alerts={alerts}
        />,
      ),
    );
  });

  app.get('/api/v1/transit/:city', async (c) => {
    const slug = c.req.param('city');
    const city = CITIES[slug];
    if (!city) return c.json({ error: `no city ${slug}; see /api/v1/transit` }, 404);
    const [t, alerts] = await Promise.all([cityTables(slug), cityAlerts(slug)]);
    setCache(c, 120);
    return c.json({
      ...cityOut(slug, city),
      lines: t.lines.map((l) => ({
        id: l.data.routeId,
        name: l.data.name,
        longName: l.data.longName,
        mode: l.data.mode,
        color: l.data.color,
        stations: l.data.stations,
      })),
      stations: t.stations.map(compactStation),
      alerts: alerts.map((a) => ({
        title: a.title,
        description: a.data.description,
        routes: a.data.routes,
        since: a.data.firstSeenAt,
        page: a.page,
      })),
    });
  });

  app.get('/api/v1/transit/:city/vehicles', async (c) => {
    const slug = c.req.param('city');
    if (!CITIES[slug]) return c.json({ error: `no city ${slug}` }, 404);
    const vehicles = await liveVehicles(slug);
    setCache(c, 10);
    return c.json({ city: slug, at: new Date().toISOString(), count: vehicles.length, vehicles });
  });

  const stationReport = async (slug, id) => {
    const city = CITIES[slug];
    if (!city) return { error: `no city ${slug}`, status: 404 };
    const station = await findStation(slug, decodeURIComponent(id));
    if (!station) return { error: `no station ${id} in ${city.name}`, status: 404 };
    const routes = new Set((station.data.lines ?? []).map((l) => l.route));
    const [arrivals, alerts] = await Promise.all([
      liveArrivals(slug, station),
      cityAlerts(slug, 200),
    ]);
    return {
      city,
      station,
      arrivals,
      alerts: alerts.filter((a) => (a.data.routes ?? []).some((r) => routes.has(r))),
    };
  };

  app.get('/transit/:city/:station', async (c) => {
    const slug = c.req.param('city');
    const r = await stationReport(slug, c.req.param('station'));
    if (r.error) return c.notFound();
    setCache(c, 20);
    return c.html(
      await render(
        <StationPage
          user={c.get('user')}
          slug={slug}
          city={r.city}
          station={r.station}
          arrivals={r.arrivals}
          alerts={r.alerts}
        />,
      ),
    );
  });

  app.get('/api/v1/transit/:city/:station', async (c) => {
    const slug = c.req.param('city');
    const r = await stationReport(slug, c.req.param('station'));
    if (r.error) return c.json({ error: r.error }, r.status);
    setCache(c, 20);
    return c.json({
      city: slug,
      station: {
        ...compactStation(r.station),
        schedule: r.station.data.schedule,
        wheelchair: r.station.data.wheelchair,
        source: r.station.data.source,
      },
      arrivals: r.arrivals,
      alerts: r.alerts.map((a) => ({
        title: a.title,
        description: a.data.description,
        page: a.page,
      })),
    });
  });
}
