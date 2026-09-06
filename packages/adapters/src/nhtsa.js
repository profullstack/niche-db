import { defineAdapter, looseDate, slugify } from '@nichedb/core/adapter';

/**
 * NHTSA: what has gone wrong with a vehicle, on the record.
 *
 * Three datasets, one shape. All of it is US federal government work — public
 * domain, no key, no published quota — so unlike most of what this site
 * indexes, these rows are ours to redistribute outright.
 *
 * The catch is that none of them can be asked "what is new". Every one is
 * keyed by (model year, make, model), so the only way through is to walk the
 * tree. NHTSA publishes that tree itself: the makes that have records for a
 * year, then the models under a make. So each run picks up where the last one
 * left off, spends a budget of lookups, and stores the walk in the cursor. A
 * full sweep takes about a day and then goes round again; rows land from the
 * first run rather than after the last one.
 */

const API = 'https://api.nhtsa.gov';
const RATINGS = 'https://api.nhtsa.gov/SafetyRatings';

/** NHTSA dates are MM/DD/YYYY. */
const mdY = (s) => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(s ?? '').trim());
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
};

/** The model years a source walks: newest first, so the useful end fills first. */
export function yearsFor(config, now = new Date()) {
  const explicit = (config.years ?? [])
    .map((y) => Number(y))
    .filter((y) => Number.isInteger(y) && y > 1949 && y < 2100);
  if (explicit.length) return [...new Set(explicit)].sort((a, b) => b - a);
  const latest = now.getUTCFullYear() + 1;
  const back = Math.min(Math.max(Number(config.yearsBack) || 5, 1), 40);
  return Array.from({ length: back + 1 }, (_, i) => latest - i);
}

/** Vehicles are named a dozen ways; tags are how a feed finds them again. */
export function vehicleTags(year, make, model) {
  return [String(year), slugify(make), slugify(model), slugify(`${make}-${model}`)].filter(Boolean);
}

export function recallToItem(r, { year, make, model }) {
  const received = mdY(r.ReportReceivedDate);
  const when = looseDate(received ?? '');
  const component = String(r.Component ?? 'Unspecified')
    .split(':')[0]
    .trim();
  return {
    externalId: `${r.NHTSACampaignNumber}|${year}|${slugify(make)}|${slugify(model)}`,
    kind: 'recall',
    title: `${year} ${make} ${model}: ${component.toLowerCase()} recall (${r.NHTSACampaignNumber})`,
    summary:
      String(r.Summary ?? '')
        .replace(/\s+/g, ' ')
        .slice(0, 1200) || null,
    url: `https://www.nhtsa.gov/recalls?nhtsaId=${encodeURIComponent(r.NHTSACampaignNumber)}`,
    publishedAt: when.publishedAt,
    timeKnown: false,
    precision: 'day',
    tags: [
      'recall',
      'nhtsa',
      ...vehicleTags(year, make, model),
      slugify(component),
      r.parkIt ? 'do-not-drive' : null,
      r.parkOutSide ? 'park-outside' : null,
      r.overTheAirUpdate ? 'over-the-air' : null,
    ].filter(Boolean),
    data: {
      campaign: r.NHTSACampaignNumber,
      actionNumber: r.NHTSAActionNumber || null,
      manufacturer: r.Manufacturer ?? null,
      component: r.Component ?? null,
      consequence: r.Consequence ?? null,
      remedy: r.Remedy ?? null,
      notes: r.Notes ?? null,
      reportReceived: received,
      parkIt: Boolean(r.parkIt),
      parkOutSide: Boolean(r.parkOutSide),
      overTheAirUpdate: Boolean(r.overTheAirUpdate),
      vehicle: { year: Number(year), make, model },
      redistribution: 'public-domain',
      attribution: 'NHTSA (nhtsa.gov), US public domain',
    },
  };
}

export function complaintToItem(r, { year, make, model }) {
  const filed = mdY(r.dateComplaintFiled);
  const incident = mdY(r.dateOfIncident);
  const when = looseDate(filed ?? incident ?? '');
  const components = String(r.components ?? 'Unspecified');
  return {
    externalId: `odi-${r.odiNumber}`,
    kind: 'complaint',
    title: `${year} ${make} ${model}: ${components.toLowerCase()} complaint (ODI ${r.odiNumber})`,
    summary:
      String(r.summary ?? '')
        .replace(/\s+/g, ' ')
        .slice(0, 1200) || null,
    url: `https://www.nhtsa.gov/vehicle/${year}/${encodeURIComponent(make)}/${encodeURIComponent(model)}#complaints`,
    publishedAt: when.publishedAt,
    timeKnown: false,
    precision: 'day',
    tags: [
      'complaint',
      'nhtsa',
      ...vehicleTags(year, make, model),
      ...String(components)
        .split(/[,|]/)
        .map((c) => slugify(c))
        .filter(Boolean)
        .slice(0, 4),
      r.crash ? 'crash' : null,
      r.fire ? 'fire' : null,
      Number(r.numberOfInjuries) > 0 ? 'injury' : null,
      Number(r.numberOfDeaths) > 0 ? 'fatality' : null,
    ].filter(Boolean),
    data: {
      odiNumber: r.odiNumber,
      manufacturer: r.manufacturer ?? null,
      components,
      crash: Boolean(r.crash),
      fire: Boolean(r.fire),
      injuries: Number(r.numberOfInjuries) || 0,
      deaths: Number(r.numberOfDeaths) || 0,
      dateOfIncident: incident,
      dateComplaintFiled: filed,
      // NHTSA publishes a partial VIN only; it does not identify a vehicle.
      vinPrefix: r.vin || null,
      vehicle: { year: Number(year), make, model },
      redistribution: 'public-domain',
      attribution: 'NHTSA (nhtsa.gov), US public domain',
    },
  };
}

const stars = (v) => (v === undefined || v === null || v === '' || v === 'Not Rated' ? null : v);

export function ratingToItem(r, { year, make, model }) {
  return {
    externalId: `ncap-${r.VehicleId}`,
    kind: 'safety-rating',
    title: `${r.VehicleDescription ?? `${year} ${make} ${model}`}: NCAP safety rating`,
    summary:
      [
        stars(r.OverallRating) ? `Overall ${r.OverallRating}/5` : null,
        stars(r.OverallFrontCrashRating) ? `frontal ${r.OverallFrontCrashRating}/5` : null,
        stars(r.OverallSideCrashRating) ? `side ${r.OverallSideCrashRating}/5` : null,
        stars(r.RolloverRating) ? `rollover ${r.RolloverRating}/5` : null,
      ]
        .filter(Boolean)
        .join(', ') || 'Tested by NCAP; see the rating detail.',
    url: `https://www.nhtsa.gov/vehicle/${year}/${encodeURIComponent(make)}/${encodeURIComponent(model)}`,
    publishedAt: looseDate(String(year)).publishedAt,
    timeKnown: false,
    precision: 'year',
    tags: ['safety-rating', 'ncap', 'nhtsa', ...vehicleTags(year, make, model)],
    data: {
      vehicleId: r.VehicleId,
      description: r.VehicleDescription ?? null,
      overall: stars(r.OverallRating),
      frontal: stars(r.OverallFrontCrashRating),
      side: stars(r.OverallSideCrashRating),
      rollover: stars(r.RolloverRating),
      frontCrashDriverSide: stars(r.FrontCrashDriversideRating),
      frontCrashPassengerSide: stars(r.FrontCrashPassengersideRating),
      sideCrashDriverSide: stars(r.SideCrashDriversideRating),
      sidePoleDriverSide: stars(r.SidePoleCrashRating),
      complaintsCount: r.ComplaintsCount ?? null,
      recallsCount: r.RecallsCount ?? null,
      investigationCount: r.InvestigationCount ?? null,
      vehicle: { year: Number(year), make, model },
      redistribution: 'public-domain',
      attribution: 'NHTSA NCAP (nhtsa.gov), US public domain',
    },
  };
}

/**
 * Where the next run resumes, given where this one stopped. Pure, so the walk
 * can be tested without asking NHTSA anything.
 */
export function advance({ yearIdx, makeIdx, makeCount, yearCount }) {
  if (makeIdx >= makeCount) return { yearIdx: (yearIdx + 1) % yearCount, makeIdx: 0, done: true };
  return { yearIdx, makeIdx, done: false };
}

/**
 * The shared walk. `fetchFor` asks one upstream about one vehicle and hands
 * back items; where we are, what to spend and when to stop live here.
 */
async function walk({ config, cursor, http, log, budget, deadline }, { issueType, fetchFor }) {
  const years = yearsFor(config);
  const only = (config.makes ?? []).map((m) => String(m).toUpperCase());
  const perRun = Math.min(Math.max(Number(config.perRun) || budget, 5), 400);

  let yearIdx = Number(cursor.yearIdx) || 0;
  if (yearIdx >= years.length) yearIdx = 0;
  const year = years[yearIdx];
  let makeIdx = Number(cursor.makeIdx) || 0;
  let makes = Array.isArray(cursor.makes) && cursor.cursorYear === year ? cursor.makes : null;

  if (!makes) {
    const res = await http.json(
      `${API}/products/vehicle/makes?modelYear=${year}&issueType=${issueType}`,
    );
    makes = [...new Set((res.results ?? []).map((r) => r.make).filter(Boolean))].sort();
    if (only.length) makes = makes.filter((m) => only.includes(String(m).toUpperCase()));
    makeIdx = 0;
    log(`${makes.length} makes with records for ${year}`);
  }

  const items = [];
  let spent = 0;
  while (makeIdx < makes.length && spent < perRun && Date.now() < deadline) {
    const make = makes[makeIdx];
    const res = await http
      .json(
        `${API}/products/vehicle/models?modelYear=${year}&make=${encodeURIComponent(make)}&issueType=${issueType}`,
      )
      .catch(() => ({ results: [] }));
    spent++;
    const models = [...new Set((res.results ?? []).map((r) => r.model).filter(Boolean))];
    for (const model of models) {
      if (spent >= perRun || Date.now() >= deadline) break;
      const got = await fetchFor({ year, make, model }).catch((err) => {
        log(`${year} ${make} ${model}: ${err.message}`);
        return [];
      });
      spent++;
      items.push(...got);
    }
    makeIdx++;
  }

  const step = advance({ yearIdx, makeIdx, makeCount: makes.length, yearCount: years.length });
  return {
    items,
    cursor: step.done
      ? { yearIdx: step.yearIdx, makeIdx: 0, makes: null, cursorYear: null }
      : { yearIdx, makeIdx, makes, cursorYear: year },
    note: `${year}: ${items.length} rows from ${spent} lookups, ${step.done ? 'year complete' : `at make ${makeIdx}/${makes.length}`}`,
  };
}

const YEAR_FIELDS = [
  {
    key: 'yearsBack',
    label: 'Model years back',
    type: 'number',
    help: 'How far back to walk from next year’s models. 5 covers what most people drive.',
  },
  {
    key: 'makes',
    label: 'Makes',
    type: 'list',
    help: 'Empty means every make NHTSA lists. Otherwise: HONDA, TOYOTA, FORD',
  },
];

export const nhtsaRecalls = defineAdapter({
  name: 'nhtsa-recalls',
  title: 'NHTSA recalls',
  collection: 'automotive',
  description:
    'Every safety recall NHTSA has issued, by model year, make and model, with the component, the consequence, the remedy, and whether the answer is to stop driving it. US public domain, keyless.',
  docs: 'https://www.nhtsa.gov/nhtsa-datasets-and-apis',
  kinds: ['recall'],
  cadenceMinutes: 120,
  redistribution: 'public-domain',
  configFields: YEAR_FIELDS,
  defaults: { yearsBack: 5 },
  defaultSources: [
    { slug: 'nhtsa-recalls', name: 'NHTSA: vehicle recalls', config: { yearsBack: 5 } },
  ],
  async pull(ctx) {
    return walk(ctx, {
      issueType: 'r',
      fetchFor: async ({ year, make, model }) => {
        const res = await ctx.http.json(
          `${API}/recalls/recallsByVehicle?make=${encodeURIComponent(make)}&model=${encodeURIComponent(model)}&modelYear=${year}`,
        );
        return (res.results ?? [])
          .filter((r) => r.NHTSACampaignNumber)
          .map((r) => recallToItem(r, { year, make, model }));
      },
    });
  },
});

export const nhtsaComplaints = defineAdapter({
  name: 'nhtsa-complaints',
  title: 'NHTSA owner complaints',
  collection: 'automotive',
  description:
    'What owners report to NHTSA about their vehicles: the component, whether it crashed or caught fire, injuries and deaths. The earliest public warning that a model has a problem. US public domain, keyless.',
  docs: 'https://www.nhtsa.gov/nhtsa-datasets-and-apis',
  kinds: ['complaint'],
  cadenceMinutes: 180,
  redistribution: 'public-domain',
  configFields: [
    ...YEAR_FIELDS,
    {
      key: 'perModel',
      label: 'Complaints per model',
      type: 'number',
      help: 'Newest first. A popular model can have thousands; 25 keeps the feed current without swamping it.',
    },
  ],
  defaults: { yearsBack: 3, perModel: 25 },
  defaultSources: [
    {
      slug: 'nhtsa-complaints',
      name: 'NHTSA: owner complaints',
      config: { yearsBack: 3, perModel: 25 },
    },
  ],
  async pull(ctx) {
    const perModel = Math.min(Math.max(Number(ctx.config.perModel) || 25, 1), 200);
    return walk(ctx, {
      issueType: 'c',
      fetchFor: async ({ year, make, model }) => {
        const res = await ctx.http.json(
          `${API}/complaints/complaintsByVehicle?make=${encodeURIComponent(make)}&model=${encodeURIComponent(model)}&modelYear=${year}`,
        );
        return (res.results ?? [])
          .filter((r) => r.odiNumber)
          .sort((a, b) => String(b.dateComplaintFiled).localeCompare(String(a.dateComplaintFiled)))
          .slice(0, perModel)
          .map((r) => complaintToItem(r, { year, make, model }));
      },
    });
  },
});

export const nhtsaRatings = defineAdapter({
  name: 'nhtsa-safety-ratings',
  title: 'NHTSA crash-test ratings',
  collection: 'automotive',
  description:
    'NCAP five-star crash-test ratings by model year, make and model: overall, frontal, side and rollover, with the recall and complaint counts NHTSA shows beside them. US public domain, keyless.',
  docs: 'https://www.nhtsa.gov/nhtsa-datasets-and-apis',
  kinds: ['safety-rating'],
  cadenceMinutes: 1440,
  redistribution: 'public-domain',
  configFields: [
    {
      key: 'yearsBack',
      label: 'Model years back',
      type: 'number',
      help: 'NCAP publishes by model year; 5 covers the current market.',
    },
    {
      key: 'perRun',
      label: 'Lookups per run',
      type: 'number',
      help: 'Three calls per vehicle, so this is the hungriest walk here. NHTSA answers 403 rather than 429 when pushed.',
    },
    {
      key: 'paceMs',
      label: 'Pause between calls',
      type: 'number',
      help: 'Milliseconds. A short wait is what keeps NHTSA answering.',
    },
  ],
  defaults: { yearsBack: 5, perRun: 60, paceMs: 150 },
  defaultSources: [
    {
      slug: 'nhtsa-safety-ratings',
      name: 'NHTSA: crash-test ratings',
      config: { yearsBack: 5, perRun: 60, paceMs: 150 },
    },
  ],
  async pull({ config, cursor, http, log, budget, deadline }) {
    // Ratings cost three nested calls per vehicle — the make's models, that
    // model's variants, then each variant's full record — so this is by far
    // the hungriest walk here. Asked at full speed, NHTSA answers 403 rather
    // than 429, which no retry-after backoff catches. So it goes deliberately
    // slowly: a smaller run and a pause between calls. Nothing about a crash
    // test from a past model year needs to arrive quickly.
    const cap = Math.min(Math.max(Number(config.perRun) || 60, 5), budget);
    const paceMs = Math.min(Math.max(Number(config.paceMs) || 0, 0), 2000);
    const pace = () => (paceMs ? Bun.sleep(paceMs) : Promise.resolve());
    const years = yearsFor(config);
    let yearIdx = Number(cursor.yearIdx) || 0;
    if (yearIdx >= years.length) yearIdx = 0;
    const year = years[yearIdx];
    let makeIdx = Number(cursor.makeIdx) || 0;
    let makes = Array.isArray(cursor.makes) && cursor.cursorYear === year ? cursor.makes : null;

    if (!makes) {
      const res = await http.json(`${RATINGS}/modelyear/${year}`).catch((err) => {
        log(`could not list ${year} makes: ${err.message}`);
        return null;
      });
      if (!res) return { items: [], cursor, note: `${year}: upstream busy, will resume` };
      makes = [...new Set((res.Results ?? []).map((r) => r.Make).filter(Boolean))].sort();
      makeIdx = 0;
      log(`${makes.length} makes rated for ${year}`);
    }

    const items = [];
    let spent = 0;
    while (makeIdx < makes.length && spent < cap && Date.now() < deadline) {
      const make = makes[makeIdx];
      await pace();
      const models = await http
        .json(`${RATINGS}/modelyear/${year}/make/${encodeURIComponent(make)}`)
        .catch(() => ({ Results: [] }));
      spent++;
      for (const m of models.Results ?? []) {
        if (spent >= cap || Date.now() >= deadline) break;
        await pace();
        const detail = await http
          .json(
            `${RATINGS}/modelyear/${year}/make/${encodeURIComponent(make)}/model/${encodeURIComponent(m.Model)}`,
          )
          .catch(() => ({ Results: [] }));
        spent++;
        for (const v of detail.Results ?? []) {
          if (!v.VehicleId || spent >= cap || Date.now() >= deadline) continue;
          await pace();
          const full = await http.json(`${RATINGS}/VehicleId/${v.VehicleId}`).catch(() => null);
          spent++;
          items.push(ratingToItem(full?.Results?.[0] ?? v, { year, make, model: m.Model }));
        }
      }
      makeIdx++;
    }

    const step = advance({ yearIdx, makeIdx, makeCount: makes.length, yearCount: years.length });
    return {
      items,
      cursor: step.done
        ? { yearIdx: step.yearIdx, makeIdx: 0, makes: null, cursorYear: null }
        : { yearIdx, makeIdx, makes, cursorYear: year },
      note: `${year}: ${items.length} ratings, ${step.done ? 'year complete' : `at make ${makeIdx}/${makes.length}`}`,
    };
  },
});
