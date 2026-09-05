import { defineAdapter } from '@nichedb/core/adapter';

/** The US National Weather Service: every active alert. Keyless; identifies by User-Agent. */
export function toItem(f) {
  const p = f.properties;
  const states = [
    ...new Set((p.geocode?.UGC ?? []).map((u) => String(u).slice(0, 2).toLowerCase())),
  ].slice(0, 6);
  return {
    externalId: p.id,
    kind: 'alert',
    title: p.headline ?? `${p.event} — ${p.areaDesc}`,
    summary: (p.description ?? '').replace(/\s+/g, ' ').slice(0, 600) || null,
    url: p['@id'] ?? f.id,
    publishedAt: p.sent ?? p.effective,
    tags: [
      'nws',
      (p.event ?? '').toLowerCase().replace(/\s+/g, '-'),
      (p.severity ?? '').toLowerCase(),
      (p.urgency ?? '').toLowerCase(),
      ...states,
    ].filter(Boolean),
    data: {
      event: p.event,
      severity: p.severity,
      urgency: p.urgency,
      certainty: p.certainty,
      area: p.areaDesc,
      sender: p.senderName,
      onset: p.onset ?? null,
      expires: p.expires ?? null,
      ends: p.ends ?? null,
      instruction: p.instruction ? p.instruction.replace(/\s+/g, ' ').slice(0, 400) : null,
    },
  };
}

export const nws = defineAdapter({
  name: 'nws-alerts',
  title: 'NWS weather alerts',
  collection: 'alerts',
  description:
    'Active US weather alerts: warnings, watches and advisories, with area, severity and expiry. Keyless. Optionally one state.',
  docs: 'https://www.weather.gov/documentation/services-web-api',
  kinds: ['alert'],
  cadenceMinutes: 10,
  configFields: [
    {
      key: 'area',
      label: 'State code',
      placeholder: 'CA',
      help: 'Optional two-letter state; empty for the whole country.',
    },
    {
      key: 'severity',
      label: 'Minimum severity',
      type: 'select',
      options: ['', 'Extreme', 'Severe', 'Moderate'],
    },
  ],
  defaults: {},
  defaultSources: [
    {
      slug: 'weather-alerts-us',
      name: 'Weather alerts: United States (severe and extreme)',
      config: { severity: 'Severe' },
    },
  ],
  async pull({ config, http, log }) {
    const params = new URLSearchParams({ status: 'actual', message_type: 'alert' });
    if (config.area) params.set('area', String(config.area).toUpperCase().slice(0, 2));
    if (config.severity === 'Extreme') params.set('severity', 'Extreme');
    else if (config.severity === 'Severe') params.set('severity', 'Extreme,Severe');
    else if (config.severity === 'Moderate') params.set('severity', 'Extreme,Severe,Moderate');
    const res = await http.json(`https://api.weather.gov/alerts/active?${params}`, {
      headers: { accept: 'application/geo+json' },
      timeoutMs: 60_000,
    });
    const items = (res.features ?? []).map(toItem);
    log(`${items.length} active alerts`);
    return { items, note: `${items.length} active` };
  },
});
