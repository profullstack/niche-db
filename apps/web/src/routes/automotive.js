import { config } from '@nichedb/config';
import * as auto from '@nichedb/db/automotive';
import * as q from '@nichedb/db/queries';
import { callerAddress } from '../lib/auth-throttle.js';
import {
  complaintsFor,
  decodeVin,
  maintenanceSchedule,
  normaliseVin,
  OSM_ATTRIBUTION,
  partsSearches,
  placesNear,
  powertrainOf,
  ratingFor,
  recallsFor,
  vehicleProfile,
} from '../lib/automotive.js';
import { render } from '../lib/http.js';
import { vinReport } from '../lib/vin-history.js';
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
async function meterLookup(c, { charge = true } = {}) {
  const modules = c.get('modules');
  if (modules?.paid) return null;

  const bucket = `auto:${c.get('user')?.id ?? callerAddress(c) ?? 'unknown'}`;
  // A VIN we have already decoded costs us nothing to answer, so it costs the
  // caller nothing either. Otherwise re-reading the car you just looked up, or
  // reloading the page, spends the same allowance as a new one — which is how
  // somebody who has looked at one car finds the form refusing to work.
  const used = charge
    ? await q.bumpApiUsage(bucket).catch(() => 0)
    : await q.apiUsage(bucket).catch(() => 0);
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
    const miles = num(c.req.query('miles'));
    let profile = null;
    let error = null;
    if (vin) {
      const seenBefore = await auto.getVin(vin).catch(() => null);
      const blocked = await meterLookup(c, { charge: !seenBefore });
      if (blocked) {
        error = `Free lookups for this hour are used up. A pass is $${(config.automotive.dayCents / 100).toFixed(2)} a day, or Pro at $${(config.automotive.monthlyCents / 100).toFixed(0)} a month.`;
      } else {
        // `?part=` narrows the parts searches. The JSON endpoint already
        // honoured it; the page was dropping it on the floor.
        profile = await vehicleProfile({ vin, miles, part: c.req.query('part') ?? '' }).catch(
          (err) => ({ error: err.message }),
        );
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
          miles={miles}
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
          `${base}/history/{vin}`,
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
        {
          name: 'NMVTIS',
          use: 'title brands, total-loss records, odometer history',
          licence: 'licensed per report through an approved provider',
          // Said here so an agent reading the index knows what the history
          // section will and will not contain before it spends a lookup.
          configured: Boolean(config.automotive.historyUrl),
        },
      ],
      rating: {
        endpoint: `${base}/history/{vin}`,
        basis: 'nichedb-computed',
        note: 'A condition-and-risk score out of 100 with every deduction itemised, computed from NHTSA recall, complaint and crash-test data plus any title record available. It is a summary of published evidence about this vehicle and vehicles built like it, not an inspection of this one.',
      },
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
    const vin = normaliseVin(c.req.param('vin'));
    const seenBefore = await auto.getVin(vin).catch(() => null);
    const blocked = await meterLookup(c, { charge: !seenBefore });
    if (blocked) return blocked;
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

  /**
   * The history report on its own, for callers who want the grade and not the
   * mpg. It is the same work the VIN profile already does, so it is metered
   * the same way and a VIN already decoded is still free.
   */
  app.get('/api/v1/automotive/history/:vin', async (c) => {
    const vin = normaliseVin(c.req.param('vin'));
    const seenBefore = await auto.getVin(vin).catch(() => null);
    const blocked = await meterLookup(c, { charge: !seenBefore });
    if (blocked) return blocked;

    const decode = await decodeVin(vin).catch((err) => ({ error: err.message }));
    if (decode?.error && !decode.make) return c.json({ vin, error: decode.error }, 400);

    const vehicle = { year: decode.modelYear, make: decode.make, model: decode.model };
    const [recalls, complaints, ncap] = await Promise.all([
      recallsFor(vehicle).catch(() => []),
      complaintsFor(vehicle).catch(() => ({ total: 0, byComponent: [], rows: [] })),
      ratingFor(vehicle).catch(() => null),
    ]);
    const { rows = [], ...summary } = complaints;
    const report = await vinReport({
      vin,
      identity: decode,
      recalls,
      complaintRows: rows,
      complaints: summary,
      ncap,
      modelYear: vehicle.year,
      miles: num(c.req.query('miles')),
      refresh: c.req.query('refresh') === 'true',
    });
    const past = await auto.ratingHistory(vin).catch(() => []);
    return c.json({
      vehicle: { ...vehicle, vin },
      ...report,
      // Every grade this VIN has been given here, so a score that moved is
      // visible as a score that moved rather than as a different number.
      previousRatings: past.map((r) => ({
        score: r.score,
        grade: r.grade,
        confidence: r.confidence,
        computedAt: r.computed_at,
      })),
    });
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
