import { defineAdapter } from '@nichedb/core/adapter';

/**
 * NASA EONET: natural events on the ground, worldwide, curated.
 *
 * EONET is not a sensor feed. It is a curated event layer over other people's
 * data — wildfire incident systems, volcanic ash advisories, storm tracks, ice
 * movement — and every event carries the source it was drawn from. That makes
 * it the global counterpart to the NWS alerts, which stop at the US border,
 * and it is why the source URL is kept on every row: the primary is somebody
 * else's and a reader should be able to reach it.
 *
 * The one thing to get right is that an EONET event is long-lived. A wildfire
 * burns for weeks and gains a new geometry each time it is measured, so the
 * item is keyed by event and its latest observation date, and a fire that has
 * grown lands as a new row while a fire that has not stays quiet.
 */

const KINDS = {
  wildfires: 'wildfire',
  severeStorms: 'storm',
  volcanoes: 'volcano',
  floods: 'flood',
  drought: 'drought',
  dustHaze: 'dust-and-haze',
  snow: 'snow',
  seaLakeIce: 'sea-and-lake-ice',
  earthquakes: 'earthquake',
  landslides: 'landslide',
  manmade: 'manmade',
  waterColor: 'water-colour',
  tempExtremes: 'temperature-extreme',
};

/** The most recent observation, which is where the event currently is. */
export function latestGeometry(geometry) {
  const rows = (geometry ?? []).filter((g) => g?.date);
  if (!rows.length) return null;
  return rows.reduce((a, b) => (String(b.date) > String(a.date) ? b : a));
}

/**
 * Where an event is, from whatever geometry EONET gave it.
 *
 * A Point is a coordinate pair. A Polygon is a ring of them nested one level
 * deeper, and a MultiPolygon deeper again, and the nesting depth is not worth
 * enumerating: descend to the first pair of numbers whatever wraps it. A
 * polygon's first vertex is not its centre, but it is on its edge, which is
 * enough to say roughly where an event is without pretending to a centroid.
 */
export function pointOf(g) {
  const pair = firstPair(g?.coordinates);
  return pair ? { lon: pair[0], lat: pair[1] } : { lat: null, lon: null };
}

function firstPair(c) {
  if (!Array.isArray(c)) return null;
  if (c.length >= 2 && typeof c[0] === 'number' && typeof c[1] === 'number') {
    return [c[0], c[1]];
  }
  for (const inner of c) {
    const found = firstPair(inner);
    if (found) return found;
  }
  return null;
}

export function toItem(e) {
  const category = e.categories?.[0]?.id ?? null;
  const kind = KINDS[category] ?? 'event';
  const g = latestGeometry(e.geometry);
  const { lat, lon } = pointOf(g);
  const magnitude =
    g?.magnitudeValue != null
      ? `${Number(g.magnitudeValue).toLocaleString('en-US')} ${g.magnitudeUnit ?? ''}`.trim()
      : null;
  const source = e.sources?.[0] ?? null;
  return {
    // Event plus its latest observation: a fire that grew is news again, a
    // fire that did not is not sent twice.
    externalId: g?.date ? `${e.id}@${g.date}` : String(e.id),
    kind,
    title: magnitude ? `${e.title} (${magnitude})` : e.title,
    summary:
      e.description?.replace(/\s+/g, ' ').slice(0, 600) ||
      `${[
        `A ${kind.replace(/-/g, ' ')} event tracked by NASA EONET`,
        lat != null && lon != null
          ? `near ${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`
          : null,
        magnitude ? `measured at ${magnitude}` : null,
      ]
        .filter(Boolean)
        .join(', ')}.`,
    // The primary source, not our copy of it, whenever EONET names one.
    url: source?.url ?? e.link ?? null,
    publishedAt: g?.date ?? null,
    tags: [
      'eonet',
      'nasa',
      kind,
      e.closed ? 'closed' : 'open',
      source?.id ? String(source.id).toLowerCase() : null,
    ].filter(Boolean),
    data: {
      eventId: e.id,
      category,
      categories: (e.categories ?? []).map((c) => c.title),
      closed: e.closed ?? null,
      lat,
      lon,
      magnitude: g?.magnitudeValue ?? null,
      magnitudeUnit: g?.magnitudeUnit ?? null,
      observedAt: g?.date ?? null,
      observations: (e.geometry ?? []).length,
      sources: (e.sources ?? []).map((s) => ({ id: s.id, url: s.url })),
      eonetUrl: e.link ?? null,
    },
  };
}

export const eonetEvents = defineAdapter({
  name: 'eonet-events',
  title: 'NASA EONET natural events',
  collection: 'weather',
  description:
    'Wildfires, severe storms, floods, drought, dust and haze, snow, sea ice and volcanic activity worldwide, curated by NASA’s Earth Observatory Natural Event Tracker, each event linked to the agency that reported it. Keyless.',
  docs: 'https://eonet.gsfc.nasa.gov/docs/v3',
  kinds: Object.values(KINDS),
  cadenceMinutes: 60,
  configFields: [
    {
      key: 'category',
      label: 'Category',
      type: 'select',
      options: ['', ...Object.keys(KINDS)],
      help: 'Empty for everything EONET tracks.',
    },
    {
      key: 'days',
      label: 'Days back',
      type: 'number',
      placeholder: '30',
      help: 'How far back to look on each run. EONET events are long-lived, so a short window still returns storms that started weeks ago.',
    },
  ],
  defaults: { days: 30 },
  defaultSources: [
    { slug: 'natural-events', name: 'Natural events worldwide' },
    {
      slug: 'wildfires',
      name: 'Wildfires worldwide',
      config: { category: 'wildfires' },
      cadenceMinutes: 90,
    },
  ],
  async pull({ config, http, log }) {
    const params = new URLSearchParams({ status: 'open' });
    const days = Number(config.days) || 30;
    params.set('days', String(Math.min(Math.max(days, 1), 365)));
    if (config.category && KINDS[config.category]) params.set('category', config.category);
    const res = await http.json(`https://eonet.gsfc.nasa.gov/api/v3/events?${params}`, {
      // EONET answers with an RSS content type and a JSON body. The helper
      // parses on what it is asked for rather than what is claimed, so this
      // works, but it is the kind of thing worth writing down.
      headers: { accept: 'application/json' },
      timeoutMs: 45_000,
    });
    const items = (res?.events ?? []).map(toItem).filter((i) => i.publishedAt);
    log(`${items.length} open event(s)`);
    return { items, note: `${items.length} open` };
  },
});
