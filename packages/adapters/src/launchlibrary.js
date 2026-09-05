import { defineAdapter } from '@nichedb/core/adapter';

/**
 * The Space Devs' Launch Library: every upcoming orbital and suborbital launch.
 * Fifteen requests an hour for the whole deployment, so one detailed page per
 * run and a slow cadence.
 */
const PRECISION = {
  Second: 'minute',
  Minute: 'minute',
  Hour: 'minute',
  Day: 'day',
  Week: 'day',
  Month: 'month',
  Quarter: 'month',
  Half: 'year',
  Year: 'year',
  Decade: 'year',
};

export function toItem(l) {
  const p = l.net_precision?.name ?? 'Day';
  const precision = PRECISION[p] ?? 'day';
  const timeKnown = ['Second', 'Minute', 'Hour'].includes(p);
  const provider = l.launch_service_provider?.name ?? null;
  const rocket = l.rocket?.configuration?.full_name ?? l.rocket?.configuration?.name ?? null;
  const pad = l.pad?.location?.name ?? l.pad?.name ?? null;
  return {
    externalId: l.id,
    kind: 'launch',
    title: l.name,
    summary:
      [l.mission?.description?.slice(0, 400), l.status?.description].filter(Boolean).join(' ') ||
      l.status?.name ||
      null,
    url: `https://thespacedevs.com/launch/${l.slug}`,
    imageUrl:
      l.image?.thumbnail_url ??
      l.image?.image_url ??
      (typeof l.image === 'string' ? l.image : null),
    publishedAt: l.net,
    timeKnown,
    precision,
    tags: [
      'spacedevs',
      provider,
      rocket,
      l.mission?.type,
      l.mission?.orbit?.abbrev,
      l.status?.abbrev,
      pad,
    ].filter(Boolean),
    data: {
      provider,
      rocket,
      pad,
      status: l.status?.name ?? null,
      precision: p,
      mission: l.mission?.name ?? null,
      orbit: l.mission?.orbit?.name ?? null,
      webcast: l.vid_urls?.[0]?.url ?? null,
      probability: l.probability ?? null,
    },
  };
}

export const launchLibrary = defineAdapter({
  name: 'launch-library',
  title: 'Rocket launches (The Space Devs)',
  collection: 'space',
  description:
    'Every upcoming rocket launch worldwide with its net time, precision, provider, pad, mission and webcast. Keyless but strictly rate limited, so it runs hourly.',
  docs: 'https://ll.thespacedevs.com/docs/',
  kinds: ['launch'],
  cadenceMinutes: 60,
  configFields: [],
  defaultSources: [{ slug: 'launches-upcoming', name: 'Rocket launches: upcoming' }],
  async pull({ http, log }) {
    const res = await http.json(
      'https://ll.thespacedevs.com/2.3.0/launches/upcoming/?limit=100&mode=detailed',
    );
    const items = (res.results ?? []).map(toItem);
    log(`${items.length} launches of ${res.count ?? '?'}`);
    return { items, note: `${items.length} launches` };
  },
});
