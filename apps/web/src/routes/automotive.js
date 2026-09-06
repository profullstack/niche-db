import { config } from '@nichedb/config';
import * as auto from '@nichedb/db/automotive';
import * as q from '@nichedb/db/queries';
import { callerAddress } from '../lib/auth-throttle.js';
import {
  decodeVin,
  maintenanceSchedule,
  normaliseVin,
  OSM_ATTRIBUTION,
  partsSearches,
  placesNear,
  powertrainOf,
  recallsFor,
  vehicleProfile,
} from '../lib/automotive.js';
import { render } from '../lib/http.js';
import { AutomotivePage } from '../views/automotive.jsx';

/**
 * The automotive endpoints.
 *
 * Everything the collection ingests is already reachable through the ordinary
 * feed and item API, free, like every other collection here. What lives under
 * this prefix is the other half: a live answer about one specific car,
 * assembled from four upstreams at the moment it is asked.
 *
 * That half is metered. Not because the data is ours — most of it is US public
 * domain and the licence is printed in every response — but because assembling
 * it costs four round trips, and because assembling it is the thing people have
 * offered to pay for. A few an hour are free so anyone can try it; past that
 * it takes a crawl pass, which is a dollar a day, or Pro.
 */

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Where the caller is, if they said. */
function pointFrom(c) {
  const lat = num(c.req.query('lat'));
  const lon = num(c.req.query('lon'));
  if (lat === null || lon === null) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

function radiusFrom(c) {
  const r = num(c.req.query('radius')) ?? 10;
  return Math.min(Math.max(r, 1), config.automotive.maxRadiusMiles);
}

/**
 * The paywall on the assembled lookups.
 *
 * Pro and a valid crawl pass both set `modules.paid` upstream in app.js, so
 * this only has to count what a stranger has used this hour.
 */
async function meterLookup(c) {
  const modules = c.get('modules');
  if (modules?.paid) return null;

  const bucket = `auto:${c.get('user')?.id ?? callerAddress(c) ?? 'unknown'}`;
  const used = await q.bumpApiUsage(bucket).catch(() => 0);
  const limit = config.automotive.freeLookupsPerHour;
  c.header('x-automotive-limit', String(limit));
  c.header('x-automotive-remaining', String(Math.max(0, limit - used)));
  if (used <= limit) return null;

  return c.json(
    {
      error: `${limit} vehicle lookups an hour are free. Past that a lookup needs a pass.`,
      pricing: {
        day: { cents: config.automotive.dayCents, get: `${config.siteUrl}/api/v1/crawl-pass` },
        month: { cents: config.automotive.monthlyCents, get: `${config.siteUrl}/pro` },
        note: 'A crawl pass is bought over x402 and presented as `x-crawl-pass`. Pro includes it for the term.',
      },
      free: {
        note: 'The recall, complaint, rating and catalogue feeds are free and unmetered.',
        feeds: `${config.siteUrl}/c/automotive`,
        api: `${config.siteUrl}/api/v1/feeds`,
      },
    },
    402,
  );
}

export function registerAutomotive(app) {
  /* --------------------------------------------------------------- pages -- */

  app.get('/vin', async (c) => {
    const vin = normaliseVin(c.req.query('vin') ?? '');
    let profile = null;
    let error = null;
    if (vin) {
      const blocked = await meterLookup(c);
      if (blocked) {
        error = `Free lookups for this hour are used up. A pass is $${(config.automotive.dayCents / 100).toFixed(2)} a day, or Pro at $${(config.automotive.monthlyCents / 100).toFixed(0)} a month.`;
      } else {
        profile = await vehicleProfile({ vin, miles: num(c.req.query('miles')) }).catch((err) => ({
          error: err.message,
        }));
        error = profile?.error ?? null;
      }
    }
    const [stats, vins] = await Promise.all([
      auto.automotiveStats().catch(() => ({})),
      auto.vinStats().catch(() => ({})),
    ]);
    return c.html(
      await render(
        <AutomotivePage
          user={c.get('user')}
          vin={vin}
          profile={profile?.error ? null : profile}
          error={error}
          stats={stats}
          vins={vins}
        />,
      ),
    );
  });

  /* ----------------------------------------------------------------- api -- */

  app.get('/api/v1/automotive', async (c) => {
    const [stats, vins] = await Promise.all([
      auto.automotiveStats().catch(() => ({})),
      auto.vinStats().catch(() => ({})),
    ]);
    const base = `${config.siteUrl}/api/v1/automotive`;
    return c.json({
      name: 'Automotive',
      description:
        'Every make, model and year sold in the US, what has gone wrong with each one, and everything known about one specific car from its VIN.',
      stats: { ...stats, vinsDecoded: vins.vins ?? 0 },
      free: {
        endpoints: [`${base}/makes`, `${base}/years`, `${base}/models`],
        feeds: `${config.siteUrl}/c/automotive`,
        note: 'The catalogue and every feed are free and unmetered.',
      },
      metered: {
        endpoints: [
          `${base}/vin/{vin}`,
          `${base}/vehicle/{year}/{make}/{model}`,
          `${base}/recalls`,
          `${base}/mechanics`,
          `${base}/parts`,
        ],
        freePerHour: config.automotive.freeLookupsPerHour,
        dayCents: config.automotive.dayCents,
        monthlyCents: config.automotive.monthlyCents,
        pass: `${config.siteUrl}/api/v1/crawl-pass`,
      },
      sources: [
        { name: 'NHTSA vPIC', use: 'VIN decode', licence: 'US public domain' },
        { name: 'NHTSA recalls and complaints', use: 'the record', licence: 'US public domain' },
        { name: 'NHTSA NCAP', use: 'crash-test ratings', licence: 'US public domain' },
        { name: 'EPA/DOE fueleconomy.gov', use: 'catalogue and mpg', licence: 'US public domain' },
        { name: 'OpenStreetMap', use: 'mechanics and parts shops', licence: 'ODbL' },
      ],
    });
  });

  app.get('/api/v1/automotive/makes', async (c) => {
    const year = num(c.req.query('year'));
    const makes = await auto.catalogMakes({ year });
    return c.json({ year, count: makes.length, makes });
  });

  app.get('/api/v1/automotive/years', async (c) => {
    const make = c.req.query('make') ?? null;
    const years = await auto.catalogYears({ make });
    return c.json({ make, count: years.length, years });
  });

  app.get('/api/v1/automotive/models', async (c) => {
    const make = c.req.query('make');
    if (!make) return c.json({ error: 'A make is needed: ?make=Honda' }, 400);
    const models = await auto.catalogModels({ make, year: num(c.req.query('year')) });
    return c.json({ make, count: models.length, models });
  });

  app.get('/api/v1/automotive/vin/:vin', async (c) => {
    const blocked = await meterLookup(c);
    if (blocked) return blocked;
    const vin = normaliseVin(c.req.param('vin'));
    const full = c.req.query('full') !== 'false';
    if (!full) {
      const decoded = await decodeVin(vin);
      return c.json(decoded, decoded.error ? 400 : 200);
    }
    const point = pointFrom(c);
    const profile = await vehicleProfile({
      vin,
      miles: num(c.req.query('miles')),
      part: c.req.query('part') ?? '',
      lat: point?.lat ?? null,
      lon: point?.lon ?? null,
      radiusMiles: radiusFrom(c),
    });
    return c.json(profile, profile.error ? 400 : 200);
  });

  app.get('/api/v1/automotive/vehicle/:year/:make/:model', async (c) => {
    const blocked = await meterLookup(c);
    if (blocked) return blocked;
    const point = pointFrom(c);
    const profile = await vehicleProfile({
      year: num(c.req.param('year')),
      make: c.req.param('make'),
      model: c.req.param('model'),
      miles: num(c.req.query('miles')),
      part: c.req.query('part') ?? '',
      lat: point?.lat ?? null,
      lon: point?.lon ?? null,
      radiusMiles: radiusFrom(c),
    });
    return c.json(profile, profile.error ? 400 : 200);
  });

  app.get('/api/v1/automotive/recalls', async (c) => {
    const blocked = await meterLookup(c);
    if (blocked) return blocked;
    const year = num(c.req.query('year'));
    const make = c.req.query('make');
    const model = c.req.query('model');
    if (!year || !make || !model)
      return c.json({ error: 'Needs ?year=&make=&model=, or use /vin/{vin}.' }, 400);
    const recalls = await recallsFor({ year, make, model });
    return c.json({
      vehicle: { year, make, model },
      count: recalls.length,
      doNotDrive: recalls.some((r) => r.doNotDrive),
      recalls,
      licence: 'NHTSA, US public domain',
    });
  });

  app.get('/api/v1/automotive/maintenance', async (c) => {
    const powertrain = c.req.query('powertrain') ?? powertrainOf({});
    return c.json(
      maintenanceSchedule({
        powertrain,
        miles: num(c.req.query('miles')),
        modelYear: num(c.req.query('year')),
      }),
    );
  });

  app.get('/api/v1/automotive/mechanics', async (c) => {
    const blocked = await meterLookup(c);
    if (blocked) return blocked;
    const point = pointFrom(c);
    if (!point) return c.json({ error: 'Needs ?lat=&lon=.' }, 400);
    const kind =
      c.req.query('kind') === 'parts'
        ? 'car_parts'
        : c.req.query('kind') === 'tyres'
          ? 'tyres'
          : 'car_repair';
    const found = await placesNear({ ...point, radiusMiles: radiusFrom(c), kind });
    return c.json({
      ...point,
      radiusMiles: radiusFrom(c),
      kind,
      count: found.places.length,
      places: found.places,
      cached: found.cached ?? false,
      error: found.error ?? null,
      attribution: OSM_ATTRIBUTION,
    });
  });

  app.get('/api/v1/automotive/parts', async (c) => {
    const blocked = await meterLookup(c);
    if (blocked) return blocked;
    const year = num(c.req.query('year'));
    const make = c.req.query('make');
    const model = c.req.query('model');
    if (!year || !make || !model)
      return c.json({ error: 'Needs ?year=&make=&model=, and optionally &part=.' }, 400);
    const part = c.req.query('part') ?? '';
    const point = pointFrom(c);
    const nearby = point
      ? await placesNear({ ...point, radiusMiles: radiusFrom(c), kind: 'car_parts' })
      : null;
    return c.json({
      vehicle: { year, make, model },
      part: part || null,
      searches: partsSearches({ year, make, model, part }),
      nearby: nearby?.places ?? [],
      note: 'Part-fitment data (ACES/PIES) is licensed per seat and is not redistributed here. These searches carry the vehicle.',
      attribution: point ? OSM_ATTRIBUTION : null,
    });
  });
}
