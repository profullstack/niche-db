import { defineAdapter } from '@nichedb/core/adapter';

/**
 * The National Hurricane Center: every tropical cyclone currently being tracked.
 *
 * `CurrentStorms.json` is the file the NHC's own site is built on, and it is
 * exactly the shape a feed wants: one object per active storm, replaced in
 * place every advisory. Keyless, US public domain.
 *
 * A storm is not an event that happens once. It forms, it is named, it
 * intensifies, it turns and it dies, and each advisory is a new statement
 * about the same object. So the item is keyed by storm and advisory number
 * together: a follower gets a row when advisory 27 lands and not again until
 * 28, and the storm's whole life is readable as a run of rows rather than one
 * row that quietly changed underneath them.
 */

/** The classifications NHC uses, spelled out. `TS` on its own tells nobody anything. */
const CLASSIFICATIONS = {
  TD: 'tropical depression',
  TS: 'tropical storm',
  HU: 'hurricane',
  PTC: 'potential tropical cyclone',
  STD: 'subtropical depression',
  STS: 'subtropical storm',
  EX: 'post-tropical cyclone',
  LO: 'remnant low',
  DB: 'disturbance',
};

/**
 * Saffir-Simpson, from sustained wind in knots.
 *
 * NHC gives intensity in knots and categorises hurricanes by it, so the
 * category is derived here rather than asked for. Below 64 knots there is no
 * category, and saying "category 0" would invent one.
 */
export function categoryOf(knots) {
  const kt = Number(knots);
  if (!Number.isFinite(kt) || kt < 64) return null;
  if (kt >= 137) return 5;
  if (kt >= 113) return 4;
  if (kt >= 96) return 3;
  if (kt >= 83) return 2;
  return 1;
}

/**
 * Knots are what NHC publishes; mph is what most readers think in.
 *
 * Guarded on the value before the cast, because `Number(null)` is 0 and 0 is
 * finite, so a storm with no reported intensity would otherwise be published
 * as a storm with winds of nothing.
 */
export const knotsToMph = (kt) => {
  if (kt === null || kt === undefined || kt === '') return null;
  const n = Number(kt);
  return Number.isFinite(n) ? Math.round(n * 1.15078) : null;
};

export function toItem(s) {
  const advisory = s.publicAdvisory?.advNum ?? s.forecastAdvisory?.advNum ?? null;
  const classification =
    CLASSIFICATIONS[s.classification] ?? String(s.classification ?? '').toLowerCase();
  const category = categoryOf(s.intensity);
  const mph = knotsToMph(s.intensity);
  // "Tropical Storm Marie", not "tropical storm Marie": the classification is
  // part of the storm's name in a headline even though it is a common noun in
  // the summary sentence below.
  const titled = classification.replace(/\b[a-z]/g, (c) => c.toUpperCase());
  const name = [category ? `Category ${category} Hurricane` : titled, s.name]
    .filter(Boolean)
    .join(' ');
  return {
    // Storm plus advisory: the same storm reappears as it develops, and an
    // advisory that has already been seen is not sent twice.
    externalId: advisory ? `${s.id}-adv${advisory}` : String(s.id),
    kind: 'cyclone',
    title: `${name}${mph ? `, ${mph} mph` : ''}${advisory ? ` (advisory ${advisory})` : ''}`,
    summary: `${[
      `${s.name} is a ${classification}${category ? ` at category ${category}` : ''}`,
      mph ? `with sustained winds of ${mph} mph (${s.intensity} kt)` : null,
      s.pressure ? `and a central pressure of ${s.pressure} mb` : null,
      s.latitudeNumeric != null && s.longitudeNumeric != null
        ? `near ${Math.abs(s.latitudeNumeric).toFixed(1)}°${s.latitudeNumeric >= 0 ? 'N' : 'S'} ${Math.abs(s.longitudeNumeric).toFixed(1)}°${s.longitudeNumeric >= 0 ? 'E' : 'W'}`
        : null,
      Number.isFinite(Number(s.movementSpeed)) ? `moving at ${s.movementSpeed} kt` : null,
    ]
      .filter(Boolean)
      .join(', ')}.`,
    url: s.publicAdvisory?.url ?? s.forecastAdvisory?.url ?? 'https://www.nhc.noaa.gov/',
    publishedAt: s.publicAdvisory?.issuance ?? s.lastUpdate ?? null,
    tags: [
      'nhc',
      'tropical-cyclone',
      classification.replace(/\s+/g, '-'),
      category ? `category-${category}` : null,
      // The basin, which is what a reader in Florida or Hawaii filters on.
      String(s.id ?? '').startsWith('al') ? 'atlantic' : null,
      String(s.id ?? '').startsWith('ep') ? 'eastern-pacific' : null,
      String(s.id ?? '').startsWith('cp') ? 'central-pacific' : null,
      s.name ? String(s.name).toLowerCase() : null,
      category >= 3 ? 'major-hurricane' : null,
    ].filter(Boolean),
    data: {
      stormId: s.id,
      name: s.name,
      classification: s.classification,
      classificationName: classification,
      category,
      windKnots: Number(s.intensity) || null,
      windMph: mph,
      pressureMb: Number(s.pressure) || null,
      lat: s.latitudeNumeric ?? null,
      lon: s.longitudeNumeric ?? null,
      movementDirection: s.movementDir ?? null,
      movementSpeedKnots: s.movementSpeed ?? null,
      advisory,
      advisories: {
        public: s.publicAdvisory?.url ?? null,
        forecast: s.forecastAdvisory?.url ?? null,
        discussion: s.forecastDiscussion?.url ?? null,
        windProbabilities: s.windSpeedProbabilities?.url ?? null,
      },
      lastUpdate: s.lastUpdate ?? null,
    },
  };
}

export const nhcCyclones = defineAdapter({
  name: 'nhc-cyclones',
  title: 'NHC tropical cyclones',
  collection: 'weather',
  description:
    'Every tropical cyclone the US National Hurricane Center is currently tracking, one row per advisory: name, classification, Saffir-Simpson category, sustained wind, pressure, position and movement, with links to the public advisory and forecast discussion. Keyless, US public domain.',
  docs: 'https://www.nhc.noaa.gov/aboutrss.shtml',
  kinds: ['cyclone'],
  // Advisories are issued every six hours, and intermediate ones every two or
  // three when a storm is near land. Twenty minutes catches those promptly
  // without asking a static file a thousand times a day for nothing.
  cadenceMinutes: 20,
  defaultSources: [{ slug: 'tropical-cyclones', name: 'Tropical cyclones: Atlantic and Pacific' }],
  async pull({ http, log }) {
    const res = await http.json('https://www.nhc.noaa.gov/CurrentStorms.json', {
      timeoutMs: 30_000,
    });
    const storms = res?.activeStorms ?? [];
    const items = storms.map(toItem);
    // Nothing active is the normal state for most of the year and is not a
    // failure, so it is logged as the answer it is.
    log(storms.length ? `${storms.length} active storm(s)` : 'no active storms');
    return { items, note: `${storms.length} active` };
  },
});
