import * as auto from '@nichedb/db/automotive';

/**
 * One car, everything known about it.
 *
 * The collection ingests vehicles the way it ingests everything else — on a
 * schedule, into `items`. But nobody arrives here wanting a feed of recalls.
 * They arrive holding a VIN, or standing in front of a 2014 Civic, and the
 * question is always the same: what is this, what is wrong with it, what does
 * it need, who fixes it and where do I get the part.
 *
 * So this module answers that question from four public-domain upstreams and
 * one open-data one, and is careful to say which answers are the government's
 * and which are ours:
 *
 *   decoded      NHTSA vPIC. What the VIN means. Theirs.
 *   recalls      NHTSA. Open safety recalls for the vehicle. Theirs.
 *   complaints   NHTSA. What owners report. Theirs.
 *   rating       NHTSA NCAP crash tests. Theirs.
 *   economy      EPA/DOE fueleconomy.gov. Engine, drive, mpg. Theirs.
 *   maintenance  OURS, and marked so. Nobody publishes manufacturer service
 *                schedules under a licence we can redistribute, so this is a
 *                mileage-and-age model over the powertrain we decoded, not the
 *                factory schedule. It says as much in the payload.
 *   parts        Searches, not a catalogue. Part fitment data (ACES/PIES) is
 *                licensed, so we hand over deep links that carry the vehicle,
 *                plus the parts shops OpenStreetMap knows about nearby.
 *   mechanics    OpenStreetMap via Overpass, ODbL, attributed.
 */

const VPIC = 'https://vpic.nhtsa.dot.gov/api/vehicles';
const NHTSA = 'https://api.nhtsa.gov';
const FE = 'https://www.fueleconomy.gov/ws/rest';

const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const UA = 'nichedb.dev automotive (+https://nichedb.dev)';

async function getJson(url, { timeoutMs = 20_000, headers = {} } = {}) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
  return res.json();
}

/* -------------------------------------------------------------- VIN maths -- */

/** I, O and Q are not VIN characters: they are too easily read as 1 and 0. */
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

export function normaliseVin(input) {
  return String(input ?? '')
    .toUpperCase()
    .replace(/[\s-]/g, '');
}

const TRANSLIT = {
  A: 1,
  B: 2,
  C: 3,
  D: 4,
  E: 5,
  F: 6,
  G: 7,
  H: 8,
  J: 1,
  K: 2,
  L: 3,
  M: 4,
  N: 5,
  P: 7,
  R: 9,
  S: 2,
  T: 3,
  U: 4,
  V: 5,
  W: 6,
  X: 7,
  Y: 8,
  Z: 9,
};
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

/**
 * ISO 3779's check digit, position nine.
 *
 * North America requires it. Much of the rest of the world does not, so a
 * failure here is a warning and not a verdict — the payload says `null` for a
 * VIN whose ninth character is not a check digit at all.
 */
export function checkDigit(vin) {
  if (!VIN_RE.test(vin)) return null;
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const ch = vin[i];
    const value = /\d/.test(ch) ? Number(ch) : TRANSLIT[ch];
    if (value === undefined) return null;
    sum += value * WEIGHTS[i];
  }
  const rem = sum % 11;
  return rem === 10 ? 'X' : String(rem);
}

export function checkDigitOk(vin) {
  const expected = checkDigit(vin);
  return expected === null ? null : vin[8] === expected;
}

/** Position ten, on a thirty-year cycle. Position seven says which lap. */
const YEAR_CODES = 'ABCDEFGHJKLMNPRSTVWXY123456789';

export function vinModelYear(vin, now = new Date()) {
  if (!VIN_RE.test(vin)) return null;
  const idx = YEAR_CODES.indexOf(vin[9]);
  if (idx < 0) return null;
  // The cycle started in 1980. A letter in position seven means the later lap.
  const secondLap = /[A-Z]/.test(vin[6]);
  let year = 1980 + idx + (secondLap ? 30 : 0);
  // A model year runs ahead of the calendar, but not by decades.
  while (year > now.getUTCFullYear() + 2) year -= 30;
  return year;
}

export function describeVin(vin) {
  return {
    vin,
    valid: VIN_RE.test(vin),
    wmi: vin.slice(0, 3),
    vds: vin.slice(3, 8),
    vis: vin.slice(9),
    serial: vin.slice(11),
    checkDigit: checkDigit(vin),
    checkDigitOk: checkDigitOk(vin),
    modelYearFromVin: vinModelYear(vin),
  };
}

/* --------------------------------------------------------------- decoding -- */

/** vPIC returns every variable it has, most of them empty. Keep what is answered. */
export function compactDecode(row) {
  const out = {};
  for (const [k, v] of Object.entries(row ?? {})) {
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (!s || s === 'Not Applicable') continue;
    out[k] = s;
  }
  return out;
}

/**
 * Decode a VIN, and remember it.
 *
 * A VIN decode does not change, so a VIN we have seen is answered from our own
 * table and never asked of NHTSA twice. `refresh` forces the round trip.
 */
export async function decodeVin(input, { refresh = false } = {}) {
  const vin = normaliseVin(input);
  const shape = describeVin(vin);
  if (!shape.valid) {
    return { ...shape, error: 'A VIN is 17 characters, and never uses I, O or Q.' };
  }

  if (!refresh) {
    const known = await auto.getVin(vin).catch(() => null);
    if (known) {
      await auto.touchVin(vin).catch(() => {});
      return {
        ...shape,
        modelYear: known.model_year,
        make: known.make,
        model: known.model,
        bodyClass: known.body_class,
        vehicleType: known.vehicle_type,
        decoded: known.decoded,
        cached: true,
        decodedAt: known.decoded_at,
        source: 'NHTSA vPIC (cached)',
      };
    }
  }

  const year = shape.modelYearFromVin;
  const url = `${VPIC}/DecodeVinValuesExtended/${encodeURIComponent(vin)}?format=json${year ? `&modelyear=${year}` : ''}`;
  const res = await getJson(url);
  const row = res?.Results?.[0];
  if (!row) return { ...shape, error: 'NHTSA returned nothing for this VIN.' };

  const decoded = compactDecode(row);
  const modelYear = Number(decoded.ModelYear) || year || null;
  const saved = await auto
    .recordVin({
      vin,
      wmi: shape.wmi,
      modelYear,
      make: decoded.Make ?? null,
      model: decoded.Model ?? null,
      bodyClass: decoded.BodyClass ?? null,
      vehicleType: decoded.VehicleType ?? null,
      decoded,
      checkDigitOk: shape.checkDigitOk,
    })
    .catch(() => null);

  return {
    ...shape,
    modelYear,
    make: decoded.Make ?? null,
    model: decoded.Model ?? null,
    bodyClass: decoded.BodyClass ?? null,
    vehicleType: decoded.VehicleType ?? null,
    manufacturer: decoded.Manufacturer ?? null,
    plant:
      [decoded.PlantCity, decoded.PlantState, decoded.PlantCountry].filter(Boolean).join(', ') ||
      null,
    engine: {
      cylinders: decoded.EngineCylinders ?? null,
      displacementL: decoded.DisplacementL ?? null,
      fuel: decoded.FuelTypePrimary ?? null,
      horsepower: decoded.EngineHP ?? null,
      configuration: decoded.EngineConfiguration ?? null,
      electrificationLevel: decoded.ElectrificationLevel ?? null,
    },
    decoded,
    cached: false,
    decodedAt: saved?.decoded_at ?? new Date().toISOString(),
    source: 'NHTSA vPIC',
    // NHTSA says this itself and it is worth repeating: a blank field means
    // NHTSA has no data on it, not that the vehicle lacks the feature.
    note: String(res.Message ?? '') || null,
  };
}

/* ------------------------------------------------------------- the record -- */

export async function recallsFor({ year, make, model }) {
  if (!year || !make || !model) return [];
  const res = await getJson(
    `${NHTSA}/recalls/recallsByVehicle?make=${encodeURIComponent(make)}&model=${encodeURIComponent(model)}&modelYear=${year}`,
  ).catch(() => ({ results: [] }));
  return (res.results ?? []).map((r) => ({
    campaign: r.NHTSACampaignNumber,
    component: r.Component,
    summary: r.Summary,
    consequence: r.Consequence,
    remedy: r.Remedy,
    reportReceived: r.ReportReceivedDate,
    doNotDrive: Boolean(r.parkIt),
    parkOutside: Boolean(r.parkOutSide),
    overTheAir: Boolean(r.overTheAirUpdate),
    url: `https://www.nhtsa.gov/recalls?nhtsaId=${encodeURIComponent(r.NHTSACampaignNumber ?? '')}`,
  }));
}

/**
 * Complaints, summarised by component.
 *
 * A popular model has thousands, and a list of thousands answers nothing. What
 * answers something is which parts of this car people complain about most, and
 * how many of those complaints involved a crash or a fire.
 */
export async function complaintsFor({ year, make, model }, { sample = 5 } = {}) {
  if (!year || !make || !model) return { total: 0, byComponent: [], recent: [] };
  const res = await getJson(
    `${NHTSA}/complaints/complaintsByVehicle?make=${encodeURIComponent(make)}&model=${encodeURIComponent(model)}&modelYear=${year}`,
  ).catch(() => ({ results: [] }));
  const rows = res.results ?? [];

  const counts = new Map();
  let crashes = 0;
  let fires = 0;
  let injuries = 0;
  let deaths = 0;
  for (const r of rows) {
    if (r.crash) crashes++;
    if (r.fire) fires++;
    injuries += Number(r.numberOfInjuries) || 0;
    deaths += Number(r.numberOfDeaths) || 0;
    for (const c of String(r.components ?? 'UNKNOWN').split(/[,|]/)) {
      const key = c.trim();
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  const recent = [...rows]
    .sort((a, b) => String(b.dateComplaintFiled).localeCompare(String(a.dateComplaintFiled)))
    .slice(0, sample)
    .map((r) => ({
      odiNumber: r.odiNumber,
      components: r.components,
      filed: r.dateComplaintFiled,
      crash: Boolean(r.crash),
      fire: Boolean(r.fire),
      summary: String(r.summary ?? '')
        .replace(/\s+/g, ' ')
        .slice(0, 400),
    }));

  return {
    total: rows.length,
    crashes,
    fires,
    injuries,
    deaths,
    byComponent: [...counts.entries()]
      .map(([component, n]) => ({ component, complaints: n }))
      .sort((a, b) => b.complaints - a.complaints)
      .slice(0, 12),
    recent,
  };
}

export async function ratingFor({ year, make, model }) {
  if (!year || !make || !model) return null;
  const list = await getJson(
    `${NHTSA}/SafetyRatings/modelyear/${year}/make/${encodeURIComponent(make)}/model/${encodeURIComponent(model)}`,
  ).catch(() => null);
  const first = list?.Results?.[0];
  if (!first?.VehicleId) return null;
  const detail = await getJson(`${NHTSA}/SafetyRatings/VehicleId/${first.VehicleId}`).catch(
    () => null,
  );
  const r = detail?.Results?.[0];
  if (!r) return null;
  const star = (v) => (v && v !== 'Not Rated' ? v : null);
  return {
    vehicleId: r.VehicleId,
    description: r.VehicleDescription,
    overall: star(r.OverallRating),
    frontal: star(r.OverallFrontCrashRating),
    side: star(r.OverallSideCrashRating),
    rollover: star(r.RolloverRating),
    url: `https://www.nhtsa.gov/vehicle/${year}/${encodeURIComponent(make)}/${encodeURIComponent(model)}`,
  };
}

const menuItems = (res) => {
  const raw = res?.menuItem;
  return (Array.isArray(raw) ? raw : raw ? [raw] : []).filter(Boolean);
};

/**
 * The two databases do not agree on what a car is called.
 *
 * vPIC decodes a VIN to "Outback"; the EPA lists "Outback AWD" and
 * "Outback AWD Turbo" for the same year. An exact match therefore finds
 * nothing for a great many real cars, so when it misses, ask the EPA what it
 * calls that make's models that year and take the closest name.
 */
export function closestModel(wanted, candidates) {
  const want = String(wanted ?? '')
    .trim()
    .toLowerCase();
  if (!want) return null;
  const names = candidates.map((c) => String(c).trim());
  const exact = names.find((n) => n.toLowerCase() === want);
  if (exact) return exact;
  // "Outback" → "Outback AWD": the EPA name usually adds a qualifier.
  const prefixed = names.filter((n) => n.toLowerCase().startsWith(want));
  if (prefixed.length) return prefixed.sort((a, b) => a.length - b.length)[0];
  // "Civic Hatchback" → "Civic": ours is the longer name.
  const contained = names.filter((n) => want.startsWith(n.toLowerCase()));
  if (contained.length) return contained.sort((a, b) => b.length - a.length)[0];
  const loose = names.filter(
    (n) => n.toLowerCase().includes(want) || want.includes(n.toLowerCase()),
  );
  return loose.sort((a, b) => a.length - b.length)[0] ?? null;
}

export async function economyFor({ year, make, model }) {
  if (!year || !make || !model) return null;
  const options = (name) =>
    getJson(
      `${FE}/vehicle/menu/options?year=${year}&make=${encodeURIComponent(make)}&model=${encodeURIComponent(name)}`,
      { headers: { accept: 'application/json' } },
    ).catch(() => null);

  let trims = menuItems(await options(model));
  let matched = model;
  if (!trims.length) {
    const models = menuItems(
      await getJson(`${FE}/vehicle/menu/model?year=${year}&make=${encodeURIComponent(make)}`, {
        headers: { accept: 'application/json' },
      }).catch(() => null),
    ).map((m) => String(m.value));
    const best = closestModel(model, models);
    if (!best) return null;
    trims = menuItems(await options(best));
    matched = best;
  }
  if (!trims.length) return null;
  const detail = await getJson(`${FE}/vehicle/${encodeURIComponent(trims[0].value)}`, {
    headers: { accept: 'application/json' },
  }).catch(() => null);
  const n = (v) => {
    const x = Number(v);
    return Number.isFinite(x) && x !== -1 ? x : null;
  };
  return {
    // Said out loud when it is not the name that was asked for.
    matchedModel: matched === model ? null : matched,
    trims: trims.map((t) => ({ id: String(t.value), name: t.text })),
    fuel: detail?.fuelType ?? null,
    cylinders: n(detail?.cylinders),
    displacementL: n(detail?.displ),
    drive: detail?.drive ?? null,
    transmission: detail?.trany ?? null,
    vehicleClass: detail?.VClass ?? null,
    mpgCity: n(detail?.city08),
    mpgHighway: n(detail?.highway08),
    mpgCombined: n(detail?.comb08),
    annualFuelCost: n(detail?.fuelCost08),
    co2GramsPerMile: n(detail?.co2TailpipeGpm),
    url: `https://www.fueleconomy.gov/feg/Find.do?action=sbs&id=${encodeURIComponent(trims[0].value)}`,
  };
}

/* ------------------------------------------------------------ maintenance -- */

/**
 * A service schedule, and an honest label on it.
 *
 * Manufacturer schedules are copyrighted and licensed; none of them can be
 * redistributed here. What can be said, and is worth saying, is the interval
 * model every schedule is a variation on, adjusted for the powertrain we
 * decoded: an EV has no oil to change and no exhaust to fail, a hybrid brakes
 * mostly on the motor, a diesel has a fuel filter that a petrol car does not.
 *
 * Every item carries `basis: 'general-interval'`. Nothing here claims to be
 * what the manufacturer says, and the payload tells the caller to check the
 * owner's manual for the vehicle in front of them.
 */
const BASE_SCHEDULE = [
  {
    service: 'Engine oil and filter',
    miles: 7500,
    months: 12,
    powertrains: ['combustion', 'hybrid', 'diesel'],
  },
  { service: 'Tyre rotation', miles: 7500, months: 12, powertrains: ['all'] },
  { service: 'Cabin air filter', miles: 20000, months: 24, powertrains: ['all'] },
  {
    service: 'Engine air filter',
    miles: 30000,
    months: 36,
    powertrains: ['combustion', 'hybrid', 'diesel'],
  },
  { service: 'Brake fluid', miles: 45000, months: 36, powertrains: ['all'] },
  { service: 'Fuel filter', miles: 30000, months: 36, powertrains: ['diesel'] },
  { service: 'Brake pads and rotors: inspect', miles: 15000, months: 12, powertrains: ['all'] },
  { service: 'Coolant', miles: 60000, months: 60, powertrains: ['combustion', 'hybrid', 'diesel'] },
  {
    service: 'Battery coolant and thermal system check',
    miles: 50000,
    months: 60,
    powertrains: ['electric', 'hybrid'],
  },
  {
    service: 'Transmission fluid',
    miles: 60000,
    months: 72,
    powertrains: ['combustion', 'diesel'],
  },
  { service: 'Spark plugs', miles: 100000, months: 120, powertrains: ['combustion', 'hybrid'] },
  {
    service: 'Timing belt (if belt-driven)',
    miles: 100000,
    months: 120,
    powertrains: ['combustion', 'diesel'],
  },
  { service: 'Reduction-gear fluid', miles: 100000, months: 120, powertrains: ['electric'] },
  { service: 'Tyres: replace on wear or age', miles: 50000, months: 72, powertrains: ['all'] },
];

/** What kind of drivetrain this is, from whatever the decode gave us. */
export function powertrainOf({ decoded = {}, economy = null } = {}) {
  const hay = [
    decoded.FuelTypePrimary,
    decoded.ElectrificationLevel,
    decoded.EngineConfiguration,
    economy?.fuel,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (/(^|\s)electric/.test(hay) && !/hybrid/.test(hay)) return 'electric';
  if (/hybrid|phev|plug-in/.test(hay)) return 'hybrid';
  if (/diesel/.test(hay)) return 'diesel';
  if (hay) return 'combustion';
  return 'combustion';
}

export function maintenanceSchedule({
  powertrain = 'combustion',
  miles = null,
  modelYear = null,
} = {}) {
  const now = new Date();
  const ageMonths = modelYear ? Math.max(0, (now.getUTCFullYear() - modelYear) * 12) : null;
  const items = BASE_SCHEDULE.filter(
    (s) => s.powertrains.includes('all') || s.powertrains.includes(powertrain),
  ).map((s) => {
    const dueAtMiles = miles === null ? null : Math.ceil((miles + 1) / s.miles) * s.miles;
    return {
      service: s.service,
      everyMiles: s.miles,
      everyMonths: s.months,
      nextDueAtMiles: dueAtMiles,
      milesUntilDue: dueAtMiles === null ? null : dueAtMiles - miles,
      // Age alone can make a service due on a car that barely moves.
      overdueByAge: ageMonths !== null && ageMonths > s.months && miles !== null && miles < s.miles,
      basis: 'general-interval',
    };
  });
  return {
    powertrain,
    milesAssumed: miles,
    items: items.sort(
      (a, b) => (a.milesUntilDue ?? a.everyMiles) - (b.milesUntilDue ?? b.everyMiles),
    ),
    basis: 'general-interval',
    disclaimer:
      'General service intervals by powertrain, not the manufacturer’s schedule. Manufacturer schedules are licensed and cannot be republished here. Check the owner’s manual or the dealer for the schedule that applies to this vehicle.',
  };
}

/* ------------------------------------------------------------------ parts -- */

/**
 * Where to get the part.
 *
 * Fitment data — which part number fits which vehicle — is the Auto Care
 * Association's ACES/PIES, and it is licensed per seat. So this does not claim
 * a catalogue it does not have. It builds the searches a person would type,
 * with the vehicle already in them, at the places that actually stock parts.
 */
export function partsSearches({ year, make, model, part = '' }) {
  if (!year || !make || !model) return [];
  const vehicle = `${year} ${make} ${model}`;
  const q = (s) => encodeURIComponent(s.trim());
  const withPart = part ? `${vehicle} ${part}` : vehicle;
  return [
    {
      vendor: 'RockAuto',
      kind: 'catalogue',
      note: 'Cheapest for most wear parts; catalogue is by year/make/model.',
      url: `https://www.rockauto.com/en/catalog/${q(make.toLowerCase())},${year},${q(model.toLowerCase())}`,
    },
    {
      vendor: 'eBay Motors',
      kind: 'marketplace',
      note: 'New, used and OEM take-offs. Filter by "fits your vehicle".',
      url: `https://www.ebay.com/sch/6028/i.html?_nkw=${q(withPart)}`,
    },
    {
      vendor: 'AutoZone',
      kind: 'retail',
      note: 'Same-day pickup in the US.',
      url: `https://www.autozone.com/searchresult?searchText=${q(withPart)}`,
    },
    {
      vendor: "O'Reilly Auto Parts",
      kind: 'retail',
      url: `https://www.oreillyauto.com/search?q=${q(withPart)}`,
    },
    {
      vendor: 'NAPA',
      kind: 'retail',
      url: `https://www.napaonline.com/en/search?text=${q(withPart)}`,
    },
    {
      vendor: 'Car-Part.com',
      kind: 'salvage',
      note: 'Recycled and salvage-yard inventory: the only realistic source for body and interior parts on an older car.',
      url: `https://www.car-part.com/`,
    },
  ];
}

/* -------------------------------------------------------------- mechanics -- */

const OSM_KINDS = {
  car_repair: 'shop=car_repair',
  car_parts: 'shop=car_parts',
  tyres: 'shop=tyres',
};

function osmPlace(el) {
  const t = el.tags ?? {};
  const lat = el.lat ?? el.center?.lat ?? null;
  const lon = el.lon ?? el.center?.lon ?? null;
  return {
    id: `${el.type}/${el.id}`,
    name: t.name ?? null,
    kind: t.shop ?? null,
    brand: t.brand ?? null,
    phone: t.phone ?? t['contact:phone'] ?? null,
    website: t.website ?? t['contact:website'] ?? null,
    openingHours: t.opening_hours ?? null,
    services: Object.keys(t)
      .filter((k) => k.startsWith('service:vehicle:') && t[k] === 'yes')
      .map((k) => k.replace('service:vehicle:', '')),
    address:
      [t['addr:housenumber'], t['addr:street'], t['addr:city'], t['addr:postcode']]
        .filter(Boolean)
        .join(' ') || null,
    lat,
    lon,
    osmUrl: `https://www.openstreetmap.org/${el.type}/${el.id}`,
  };
}

const toRad = (d) => (d * Math.PI) / 180;

/** Straight-line miles. Good enough to sort a list of shops by "near me". */
export function milesBetween(a, b) {
  if ([a?.lat, a?.lon, b?.lat, b?.lon].some((v) => typeof v !== 'number')) return null;
  const R = 3958.8;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(s)) * 10) / 10;
}

/**
 * Shops near a point, from OpenStreetMap.
 *
 * Overpass is free and frequently overloaded — a 504 from it is a normal
 * Tuesday — so this tries the mirrors in turn and caches per rounded tile.
 * A miss returns an empty list with a reason rather than failing the profile
 * around it: a VIN lookup should not 500 because a map server is busy.
 *
 * It should not take a minute either. Asked from inside a vehicle profile the
 * budget is short and only the first mirrors are tried, because the rest of
 * the answer is already waiting; asked on its own, `/mechanics` can afford to
 * be patient. Either way the tile is cached for a week, so the slow call
 * happens to one caller and no one after them.
 */
export async function placesNear({
  lat,
  lon,
  radiusMiles = 10,
  kind = 'car_repair',
  limit = 25,
  timeoutMs = 25_000,
  maxMirrors = OVERPASS.length,
}) {
  if (typeof lat !== 'number' || typeof lon !== 'number' || Number.isNaN(lat) || Number.isNaN(lon))
    return { places: [], error: 'A latitude and longitude are needed.' };
  const filter = OSM_KINDS[kind];
  if (!filter) return { places: [], error: `Unknown kind: ${kind}` };

  const radiusM = Math.round(Math.min(Math.max(radiusMiles, 1), 50) * 1609.34);
  // Cache per ~1km tile: two people in the same town get one Overpass call.
  const key = `${kind}:${lat.toFixed(2)}:${lon.toFixed(2)}:${Math.round(radiusMiles)}`;
  const cached = await auto.getPlaces(key, 7 * 24 * 3600).catch(() => null);
  if (cached) return { places: cached.slice(0, limit), cached: true, attribution: OSM_ATTRIBUTION };

  // Overpass's own server-side timeout is told the same budget, so it gives up
  // when we would have anyway rather than working on an answer nobody waits for.
  const serverSeconds = Math.max(5, Math.round(timeoutMs / 1000) - 2);
  const query = `[out:json][timeout:${serverSeconds}];nwr[${filter.split('=')[0]}=${filter.split('=')[1]}](around:${radiusM},${lat},${lon});out center ${Math.min(limit * 2, 60)};`;
  for (const endpoint of OVERPASS.slice(0, Math.max(1, maxMirrors))) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'user-agent': UA, 'content-type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) continue;
      const json = await res.json();
      const places = (json.elements ?? [])
        .map(osmPlace)
        .filter((p) => p.name)
        .map((p) => ({ ...p, miles: milesBetween({ lat, lon }, p) }))
        .sort((a, b) => (a.miles ?? 999) - (b.miles ?? 999));
      await auto.putPlaces(key, kind, places).catch(() => {});
      return { places: places.slice(0, limit), cached: false, attribution: OSM_ATTRIBUTION };
    } catch {
      // Try the next mirror.
    }
  }
  return {
    places: [],
    error: 'Every OpenStreetMap mirror was busy. Try again shortly.',
    attribution: OSM_ATTRIBUTION,
  };
}

export const OSM_ATTRIBUTION = '© OpenStreetMap contributors, ODbL';

/**
 * What a vehicle profile will wait for a map server. Short on purpose: the
 * other five sections are already answered, and a cold Overpass mirror can
 * otherwise turn a three-second profile into a fifty-second one. The tile is
 * cached for a week, so the next caller in that town waits for nothing.
 */
const PLACE_BUDGET = { timeoutMs: 9_000, maxMirrors: 2 };

/* ---------------------------------------------------------------- profile -- */

/**
 * Everything about one vehicle, in one answer.
 *
 * Each upstream is asked in parallel and each is allowed to fail on its own:
 * a busy Overpass or a vPIC hiccup costs its own section, not the profile.
 */
export async function vehicleProfile({
  vin = null,
  year = null,
  make = null,
  model = null,
  miles = null,
  lat = null,
  lon = null,
  radiusMiles = 10,
  part = '',
  includePlaces = true,
} = {}) {
  let decode = null;
  if (vin) {
    decode = await decodeVin(vin).catch((err) => ({ error: err.message }));
    if (decode?.error && !decode.make) return { vin: normaliseVin(vin), error: decode.error };
    year = decode.modelYear ?? year;
    make = decode.make ?? make;
    model = decode.model ?? model;
  }

  if (!year || !make || !model)
    return {
      error: 'Give a VIN, or a year, make and model.',
      got: { year, make, model },
    };

  const wantPlaces = includePlaces && typeof lat === 'number' && typeof lon === 'number';
  const [recalls, complaints, rating, economy, stored, mechanics, partsShops] = await Promise.all([
    recallsFor({ year, make, model }).catch(() => []),
    complaintsFor({ year, make, model }).catch(() => ({ total: 0, byComponent: [], recent: [] })),
    ratingFor({ year, make, model }).catch(() => null),
    economyFor({ year, make, model }).catch(() => null),
    auto
      .itemsForVehicle({
        tags: [String(year), slug(make), slug(model)],
        limit: 20,
      })
      .catch(() => []),
    wantPlaces
      ? placesNear({ ...PLACE_BUDGET, lat, lon, radiusMiles, kind: 'car_repair' }).catch(() => ({
          places: [],
        }))
      : Promise.resolve(null),
    wantPlaces
      ? placesNear({ ...PLACE_BUDGET, lat, lon, radiusMiles, kind: 'car_parts' }).catch(() => ({
          places: [],
        }))
      : Promise.resolve(null),
  ]);

  const powertrain = powertrainOf({ decoded: decode?.decoded ?? {}, economy });
  const urgent = recalls.filter((r) => r.doNotDrive || r.parkOutside);

  return {
    vehicle: { year, make, model, vin: decode?.vin ?? null },
    identity: decode,
    headline: {
      openRecalls: recalls.length,
      urgentRecalls: urgent.length,
      doNotDrive: urgent.some((r) => r.doNotDrive),
      complaints: complaints.total,
      crashComplaints: complaints.crashes ?? 0,
      overallSafetyRating: rating?.overall ?? null,
      mpgCombined: economy?.mpgCombined ?? null,
    },
    recalls,
    complaints,
    rating,
    economy,
    maintenance: maintenanceSchedule({ powertrain, miles, modelYear: year }),
    parts: {
      searches: partsSearches({ year, make, model, part }),
      nearby: partsShops?.places ?? [],
      note: 'Part-fitment data (ACES/PIES) is licensed and is not redistributed here; these searches carry the vehicle.',
    },
    mechanics: mechanics
      ? { places: mechanics.places, attribution: OSM_ATTRIBUTION, error: mechanics.error ?? null }
      : { places: [], note: 'Pass lat and lon for mechanics near you.' },
    indexed: stored.map((i) => ({
      id: i.id,
      kind: i.kind,
      title: i.title,
      url: i.url,
      publishedAt: i.published_at,
    })),
    sources: [
      { name: 'NHTSA vPIC (VIN decode)', licence: 'US public domain' },
      { name: 'NHTSA recalls and complaints', licence: 'US public domain' },
      { name: 'NHTSA NCAP crash tests', licence: 'US public domain' },
      { name: 'EPA/DOE fueleconomy.gov', licence: 'US public domain' },
      { name: 'OpenStreetMap', licence: 'ODbL, © OpenStreetMap contributors' },
    ],
  };
}

function slug(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-');
}
