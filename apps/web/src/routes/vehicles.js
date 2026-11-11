import * as q from '@nichedb/db/queries';
import { render } from '../lib/http.js';
import {
  airplaneReport,
  collectionCounts,
  rowOut,
  satelliteReport,
  satelliteTle,
  shipReport,
  subpoint,
  trainReport,
} from '../lib/vehicles.js';
import {
  AirplanePage,
  AirplanesLanding,
  SatellitePage,
  SatellitesLanding,
  ShipPage,
  ShipsLanding,
  TrainPage,
  TrainsLanding,
} from '../views/vehicles.jsx';

/**
 * Airplanes, satellites and ships: /airplanes, /satellites, /ships, one
 * thing at /<kind>/<id>, and the same at /api/v1/<kind>/<id>.
 *
 * Each page is a stored register row (FAA, GCAT, AIS, in the aircraft,
 * satellites and ships collections) plus where the thing is right now, asked
 * live and cached briefly (lib/vehicles.js). A lookup that matches nothing
 * stored can still answer from the live half: a foreign aircraft has no FAA
 * row but adsb.lol may see it.
 */

const setCache = (c, seconds) => c.header('cache-control', `public, max-age=${seconds}`);

/* -------------------------------------------------------------- routes -- */

const KINDS = [
  {
    path: 'airplanes',
    report: airplaneReport,
    Page: AirplanePage,
    canonicalId: (r) => r.record?.data?.nNumber ?? r.live?.[0]?.hex ?? null,
  },
  {
    path: 'satellites',
    report: satelliteReport,
    Page: SatellitePage,
    canonicalId: (r) => r.record?.data?.norad ?? r.parsed?.value ?? null,
  },
  {
    path: 'ships',
    report: shipReport,
    Page: ShipPage,
    canonicalId: (r) => r.record?.data?.mmsi ?? null,
  },
  {
    path: 'trains',
    report: trainReport,
    Page: TrainPage,
    canonicalId: (r) => r.record?.externalId ?? null,
  },
];

export function registerVehicles(app) {
  app.get('/boats', (c) => c.redirect('/ships', 301));
  app.get('/vessels', (c) => c.redirect('/ships', 301));
  app.get('/aircraft', (c) => c.redirect('/airplanes', 301));
  app.get('/railways', (c) => c.redirect('/trains', 301));

  app.get('/trains', async (c) => {
    const term = (c.req.query('q') ?? '').trim();
    if (term) return c.redirect(`/trains/${encodeURIComponent(term)}`, 303);
    const counts = await collectionCounts('trains');
    const late = counts.collection
      ? await q
          .recentItems({
            collectionId: counts.collection.id,
            tags: ['late', 'running'],
            sort: 'updated',
            limit: 15,
            timeoutMs: 5_000,
          })
          .catch(() => [])
      : [];
    setCache(c, 60);
    return c.html(
      await render(<TrainsLanding user={c.get('user')} counts={counts} late={late.map(rowOut)} />),
    );
  });

  app.get('/airplanes', async (c) => {
    const term = (c.req.query('q') ?? '').trim();
    if (term) return c.redirect(`/airplanes/${encodeURIComponent(term)}`, 303);
    const aviation = await q.getCollection('aviation');
    const [counts, emergencies] = await Promise.all([
      collectionCounts('aircraft'),
      aviation
        ? q
            .recentItems({
              collectionId: aviation.id,
              kind: 'aircraft-emergency',
              tags: ['active'],
              sort: 'updated',
              limit: 10,
              timeoutMs: 5_000,
            })
            .catch(() => [])
        : [],
    ]);
    setCache(c, 120);
    return c.html(
      await render(
        <AirplanesLanding
          user={c.get('user')}
          counts={counts}
          emergencies={emergencies.map(rowOut)}
        />,
      ),
    );
  });

  app.get('/satellites', async (c) => {
    const term = (c.req.query('q') ?? '').trim();
    if (term) return c.redirect(`/satellites/${encodeURIComponent(term)}`, 303);
    const counts = await collectionCounts('satellites');
    const launches = counts.collection
      ? await q
          .recentItems({
            collectionId: counts.collection.id,
            kind: 'satellite',
            sort: 'published',
            limit: 15,
            timeoutMs: 5_000,
          })
          .catch(() => [])
      : [];
    const iss = satelliteTle(25544).then((t) => (t ? subpoint(t) : null));
    setCache(c, 120);
    return c.html(
      await render(
        <SatellitesLanding
          user={c.get('user')}
          counts={counts}
          launches={launches.map(rowOut)}
          iss={await iss}
        />,
      ),
    );
  });

  app.get('/ships', async (c) => {
    const term = (c.req.query('q') ?? '').trim();
    if (term) return c.redirect(`/ships/${encodeURIComponent(term)}`, 303);
    const counts = await collectionCounts('ships');
    const underway = counts.collection
      ? await q
          .recentItems({
            collectionId: counts.collection.id,
            tags: ['passenger', 'in-range'],
            sort: 'updated',
            limit: 15,
            timeoutMs: 5_000,
          })
          .catch(() => [])
      : [];
    setCache(c, 120);
    return c.html(
      await render(
        <ShipsLanding user={c.get('user')} counts={counts} ferries={underway.map(rowOut)} />,
      ),
    );
  });

  for (const k of KINDS) {
    app.get(`/${k.path}/:id`, async (c) => {
      const raw = decodeURIComponent(c.req.param('id'));
      const json = /\.json$/i.test(raw);
      const r = await k.report(raw.replace(/\.json$/i, ''));
      if (json) {
        if (r.error) return c.json({ error: r.error }, r.status ?? 404);
        setCache(c, 30);
        return c.json(r);
      }
      // One address per thing: /airplanes/172sp and /airplanes/a2d8e1 land on /airplanes/N172SP.
      const id = !r.error && !r.matches ? k.canonicalId(r) : null;
      if (id && String(id) !== raw) return c.redirect(`/${k.path}/${encodeURIComponent(id)}`, 301);
      if (!r.error) setCache(c, 30);
      return c.html(
        await render(<k.Page user={c.get('user')} report={r} />),
        r.error ? (r.status ?? 404) : 200,
      );
    });

    app.get(`/api/v1/${k.path}/:id`, async (c) => {
      const r = await k.report(decodeURIComponent(c.req.param('id')));
      if (r.error) return c.json({ error: r.error }, r.status ?? 404);
      setCache(c, 30);
      return c.json(r);
    });
  }
}
