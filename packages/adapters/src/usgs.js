import { defineAdapter } from '@nichedb/core/adapter';

/** USGS: earthquakes in the last day, magnitude 2.5 and up. Keyless GeoJSON, refreshed every minute. */
export function toItem(f) {
  const p = f.properties;
  const [lon, lat, depth] = f.geometry?.coordinates ?? [];
  const band =
    p.mag >= 7
      ? 'major'
      : p.mag >= 6
        ? 'strong'
        : p.mag >= 5
          ? 'moderate'
          : p.mag >= 4
            ? 'light'
            : 'minor';
  return {
    externalId: f.id,
    kind: 'earthquake',
    title: `M${Number(p.mag).toFixed(1)} — ${p.place ?? 'unknown location'}`,
    summary: `Depth ${depth != null ? `${Number(depth).toFixed(0)} km` : '?'}${p.tsunami ? ' · tsunami advisory' : ''}${p.felt ? ` · felt by ${p.felt}` : ''}${p.alert ? ` · alert ${p.alert}` : ''}`,
    url: p.url,
    publishedAt: new Date(p.time),
    tags: [
      'usgs',
      'earthquake',
      band,
      p.alert ? `alert-${p.alert}` : null,
      p.tsunami ? 'tsunami' : null,
      (p.place ?? '').split(', ').pop()?.toLowerCase(),
    ].filter(Boolean),
    data: {
      mag: p.mag,
      place: p.place,
      lat,
      lon,
      depthKm: depth,
      tsunami: Boolean(p.tsunami),
      felt: p.felt ?? null,
      alert: p.alert ?? null,
      sig: p.sig ?? null,
      type: p.type,
    },
  };
}

export const usgs = defineAdapter({
  name: 'usgs-earthquakes',
  title: 'USGS earthquakes',
  collection: 'alerts',
  description:
    'Every earthquake of magnitude 2.5 and up in the last day, worldwide, from the USGS real-time feed. Keyless.',
  docs: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php',
  kinds: ['earthquake'],
  cadenceMinutes: 10,
  configFields: [
    {
      key: 'min',
      label: 'Minimum magnitude',
      type: 'select',
      options: ['1.0', '2.5', '4.5', 'significant'],
    },
  ],
  defaults: { min: '2.5' },
  defaultSources: [
    { slug: 'earthquakes', name: 'Earthquakes: M2.5+ worldwide', config: { min: '2.5' } },
    {
      slug: 'earthquakes-significant',
      name: 'Earthquakes: significant',
      config: { min: 'significant' },
      cadenceMinutes: 15,
    },
  ],
  async pull({ config, http, log }) {
    const min = ['1.0', '2.5', '4.5', 'significant'].includes(config.min) ? config.min : '2.5';
    const res = await http.json(
      `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/${min}_day.geojson`,
    );
    const items = (res.features ?? []).map(toItem);
    log(`${items.length} quakes`);
    return { items, note: `${items.length} in the last day` };
  },
});
