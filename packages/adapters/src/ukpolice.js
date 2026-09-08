import { defineAdapter, slugify } from '@nichedb/core/adapter';

/**
 * Street-level crime in England, Wales and Northern Ireland.
 *
 * data.police.uk is what the US does not have: one keyless national API,
 * covering forty-odd police forces on a single schema, published under the
 * Open Government Licence. Every US city in this collection needed its own
 * field map; the whole of England needs one adapter.
 *
 * Two things about it shape this file.
 *
 * It is monthly, not live. Forces submit at the end of a month and the Home
 * Office publishes some weeks later, so the newest available data is typically
 * two months old. `/api/crime-last-updated` says which month is current, and
 * this asks that rather than assuming, because guessing the month returns an
 * empty list that looks exactly like a quiet town.
 *
 * Locations are deliberately fuzzed. The API never returns a real address: it
 * snaps each crime to an anonymised map point, which is why the location reads
 * "On or near James Street" rather than a house number. That is a privacy
 * design decision by the Home Office, not missing data, and the payload says
 * so rather than letting a reader treat the coordinates as the scene.
 *
 * Scotland is not in it. Police Scotland does not publish to this API, so a
 * "UK" label would be wrong; the sources say England and Wales, and the item
 * carries the force that reported it.
 */

const API = 'https://data.police.uk/api';

/** The categories the API uses, in the words it uses, made readable. */
const CATEGORIES = {
  'anti-social-behaviour': 'anti-social behaviour',
  'bicycle-theft': 'bicycle theft',
  burglary: 'burglary',
  'criminal-damage-arson': 'criminal damage and arson',
  drugs: 'drugs',
  'other-theft': 'other theft',
  'possession-of-weapons': 'possession of weapons',
  'public-order': 'public order',
  robbery: 'robbery',
  shoplifting: 'shoplifting',
  'theft-from-the-person': 'theft from the person',
  'vehicle-crime': 'vehicle crime',
  'violent-crime': 'violence and sexual offences',
  'other-crime': 'other crime',
};

/** The coarse category the US rows also carry, so the two can be read together. */
const TO_COARSE = {
  'anti-social-behaviour': 'disorder',
  'bicycle-theft': 'theft',
  burglary: 'burglary',
  'criminal-damage-arson': 'vandalism',
  drugs: 'drugs',
  'other-theft': 'theft',
  'possession-of-weapons': 'weapons',
  'public-order': 'disorder',
  robbery: 'robbery',
  shoplifting: 'theft',
  'theft-from-the-person': 'theft',
  'vehicle-crime': 'vehicle-theft',
  'violent-crime': 'assault',
  'other-crime': 'other',
};

/** The places the default sources watch. Coordinates are each city centre. */
export const UK_PLACES = [
  { key: 'london', city: 'London', region: 'Greater London', lat: 51.5074, lon: -0.1278 },
  {
    key: 'manchester',
    city: 'Manchester',
    region: 'Greater Manchester',
    lat: 53.4808,
    lon: -2.2426,
  },
  { key: 'birmingham', city: 'Birmingham', region: 'West Midlands', lat: 52.4862, lon: -1.8904 },
  { key: 'leeds', city: 'Leeds', region: 'West Yorkshire', lat: 53.8008, lon: -1.5491 },
  { key: 'liverpool', city: 'Liverpool', region: 'Merseyside', lat: 53.4084, lon: -2.9916 },
  { key: 'bristol', city: 'Bristol', region: 'Avon and Somerset', lat: 51.4545, lon: -2.5879 },
  { key: 'cardiff', city: 'Cardiff', region: 'South Wales', lat: 51.4816, lon: -3.1791 },
  { key: 'belfast', city: 'Belfast', region: 'Northern Ireland', lat: 54.5973, lon: -5.9301 },
];

export function toItem(c, place, month) {
  const category = String(c.category ?? 'other-crime');
  const readable = CATEGORIES[category] ?? category.replace(/-/g, ' ');
  const street = c.location?.street?.name ?? null;
  const lat = Number(c.location?.latitude);
  const lon = Number(c.location?.longitude);
  const outcome = c.outcome_status?.category ?? null;

  return {
    // The API's persistent id where there is one. Some rows carry none, and
    // then the crime is identified by what it is, where and when, which is
    // stable enough for the same monthly file read twice.
    externalId: c.persistent_id
      ? `uk-${c.persistent_id}`
      : `uk-${c.id ?? `${place.key}-${category}-${month}-${slugify(street ?? 'unknown')}`}`,
    kind: 'crime-report',
    title: `${readable[0].toUpperCase()}${readable.slice(1)}${street ? ` — ${street}` : ''}, ${place.city}`,
    summary: [
      `${readable} recorded ${street ? `${street.toLowerCase().startsWith('on or near') ? street.toLowerCase() : `on or near ${street}`}` : ''} in ${place.city}`,
      `during ${month}`,
      outcome ? `. Latest outcome: ${outcome}` : '. No outcome has been recorded yet',
    ]
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .replace(' .', '.')
      .concat('.'),
    url: 'https://www.police.uk/',
    // A month, not a day: the API publishes no finer and pretending to a date
    // would put every crime in England on the first of the month.
    publishedAt: `${month}-01`,
    timeKnown: false,
    precision: 'month',
    tags: [
      'crime',
      'gb',
      'uk',
      place.key,
      slugify(place.region),
      TO_COARSE[category] ?? 'other',
      category,
      outcome ? slugify(outcome).slice(0, 40) : 'no-outcome',
    ].filter(Boolean),
    data: {
      place: {
        country: 'GB',
        // England's regions are police force areas rather than states, and the
        // field is named the same as the US one so a reader filtering by
        // region does not need to know which country a row came from.
        state: place.region,
        city: place.city,
        area: street,
        address: null,
        lat: Number.isFinite(lat) ? lat : null,
        lon: Number.isFinite(lon) ? lon : null,
      },
      incidentId: c.persistent_id || String(c.id ?? ''),
      offense: readable,
      description: street,
      category: TO_COARSE[category] ?? 'other',
      ukCategory: category,
      month,
      outcome,
      outcomeDate: c.outcome_status?.date ?? null,
      locationType: c.location_type ?? null,
      locationSubtype: c.location_subtype || null,
      // Said on every row, because the coordinates look precise and are not.
      locationBasis: 'anonymised-map-point',
      locationNote:
        'Locations are snapped to an anonymised map point by the Home Office before publication. The point is near the crime, never the address of it.',
      source: 'data.police.uk',
      licence: 'Open Government Licence v3.0',
    },
  };
}

export const ukPoliceCrime = defineAdapter({
  name: 'uk-police-crime',
  title: 'Street-level crime (England, Wales, NI)',
  collection: 'crime',
  description:
    'Street-level crime from data.police.uk, the national API covering every police force in England, Wales and Northern Ireland, with category, anonymised location and the latest recorded outcome. Published monthly under the Open Government Licence. Keyless. Scotland does not publish to this API.',
  docs: 'https://data.police.uk/docs/',
  kinds: ['crime-report'],
  // The data changes once a month. Checking twice a day finds a new release
  // the day it lands without asking a static monthly file hourly.
  cadenceMinutes: 60 * 12,
  configFields: [
    {
      key: 'place',
      label: 'City',
      type: 'select',
      options: ['', ...UK_PLACES.map((p) => p.key)],
      help: 'One of the built-in cities, or give a latitude and longitude below.',
    },
    { key: 'lat', label: 'Latitude', type: 'number', placeholder: '51.5074' },
    { key: 'lon', label: 'Longitude', type: 'number', placeholder: '-0.1278' },
    { key: 'cityName', label: 'Place name', placeholder: 'London' },
    { key: 'region', label: 'Region or force area', placeholder: 'Greater London' },
    {
      key: 'months',
      label: 'Months to read',
      type: 'number',
      placeholder: '1',
      help: 'How many months back from the newest available to fetch on each run.',
    },
  ],
  defaults: { months: 1 },
  defaultSources: UK_PLACES.map((p) => ({
    slug: `crime-uk-${p.key}`,
    name: `Crime reports: ${p.city}, ${p.region}`,
    config: { place: p.key },
  })),
  async pull({ config, cursor, http, log }) {
    const preset = UK_PLACES.find((p) => p.key === config.place);
    const place = preset ?? {
      key: slugify(config.cityName ?? 'custom'),
      city: config.cityName ?? 'Custom location',
      region: config.region ?? 'Unknown force area',
      lat: Number(config.lat),
      lon: Number(config.lon),
    };
    if (!Number.isFinite(place.lat) || !Number.isFinite(place.lon)) {
      throw new Error('uk-police-crime needs a built-in city or a latitude and longitude');
    }

    // Ask which month is current rather than assuming. The lag is a couple of
    // months and it moves; a guessed month returns [] and looks like no crime.
    const latest = await http
      .json(`${API}/crime-last-updated`, { timeoutMs: 20_000 })
      .catch(() => null);
    const newest = String(latest?.date ?? '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(newest)) {
      throw new Error('data.police.uk did not say which month is current');
    }

    const wanted = Math.min(Math.max(Number(config.months) || 1, 1), 6);
    const months = [];
    for (let i = 0; i < wanted; i++) {
      const d = new Date(`${newest}-01T00:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() - i);
      months.push(d.toISOString().slice(0, 7));
    }

    const items = [];
    for (const month of months) {
      // A month already read whole has nothing new in it: the file is closed
      // once the Home Office has published it.
      if (cursor.done?.includes?.(month) && month !== newest) continue;
      const url = `${API}/crimes-street/all-crime?lat=${place.lat}&lng=${place.lon}&date=${month}`;
      const rows = await http.json(url, { timeoutMs: 90_000 }).catch((err) => {
        log(`${month} unavailable: ${err.message}`);
        return [];
      });
      for (const c of Array.isArray(rows) ? rows : []) items.push(toItem(c, place, month));
    }

    log(`${items.length} crime(s) in ${place.city} across ${months.join(', ')}`);
    return {
      items,
      cursor: { done: [...new Set([...(cursor.done ?? []), ...months])].slice(-24), newest },
      note: `${items.length} in ${place.city}, to ${newest}`,
    };
  },
});
