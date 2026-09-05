import { defineAdapter, looseDate } from '@nichedb/core/adapter';

/**
 * MusicBrainz: official releases dated inside a forward window. Keyless, one
 * request a second, and it insists on a User-Agent. Cover art comes from the
 * Cover Art Archive, checked with a HEAD per release inside the detail budget
 * so the page never shows a broken image.
 */
const iso = (d) => d.toISOString().slice(0, 10);

export function toItem(r, cover) {
  const artists = (r['artist-credit'] ?? []).map((a) => a.name ?? a.artist?.name).filter(Boolean);
  const when = looseDate(r.date ?? '');
  const type = r['release-group']?.['primary-type'] ?? null;
  const secondary = r['release-group']?.['secondary-types'] ?? [];
  const label = (r['label-info'] ?? []).map((l) => l.label?.name).filter(Boolean)[0] ?? null;
  return {
    externalId: r.id,
    kind: 'release',
    title: `${artists.join(', ') || 'Various'} — ${r.title}`,
    summary:
      [type, ...secondary, label ? `on ${label}` : null, r.country ? `(${r.country})` : null]
        .filter(Boolean)
        .join(' · ') || null,
    url: `https://musicbrainz.org/release/${r.id}`,
    imageUrl: cover,
    publishedAt: when.publishedAt,
    timeKnown: false,
    precision: when.precision,
    tags: [
      'musicbrainz',
      type?.toLowerCase(),
      ...secondary.map((s) => s.toLowerCase()),
      r.country?.toLowerCase(),
      ...artists.slice(0, 3),
    ].filter(Boolean),
    data: {
      mbid: r.id,
      artists,
      title: r.title,
      date: r.date ?? null,
      country: r.country ?? null,
      label,
      type,
      trackCount: r['track-count'] ?? null,
      releaseGroup: r['release-group']?.id ?? null,
    },
  };
}

export const musicbrainz = defineAdapter({
  name: 'musicbrainz',
  title: 'MusicBrainz releases',
  collection: 'music',
  description:
    'Official album and single releases dated in the next few months, from MusicBrainz, with cover art where the Cover Art Archive has it. Keyless.',
  docs: 'https://musicbrainz.org/doc/MusicBrainz_API',
  kinds: ['release'],
  cadenceMinutes: 180,
  configFields: [
    { key: 'days', label: 'Days ahead', type: 'number', placeholder: '90' },
    { key: 'pages', label: 'Pages of 100', type: 'number', placeholder: '3' },
  ],
  defaults: { days: 90, pages: 3 },
  defaultSources: [{ slug: 'musicbrainz-upcoming', name: 'MusicBrainz: upcoming releases' }],
  async pull({ config, cursor, http, log, budget, deadline }) {
    const from = new Date();
    const to = new Date(Date.now() + (Number(config.days) || 90) * 86_400_000);
    const query = encodeURIComponent(`date:[${iso(from)} TO ${iso(to)}] AND status:official`);
    const pages = Math.min(Math.max(1, Number(config.pages) || 3), 10);
    const covers = cursor.covers ?? {};
    const items = [];
    let spent = 0;
    for (let p = 0; p < pages; p++) {
      if (Date.now() > deadline) break;
      const res = await http.json(
        `https://musicbrainz.org/ws/2/release/?query=${query}&fmt=json&limit=100&offset=${p * 100}`,
      );
      for (const r of res.releases ?? []) {
        let cover = covers[r.id] ?? null;
        if (cover === null && spent < budget) {
          spent++;
          const head = await http
            .request(`https://coverartarchive.org/release/${r.id}/front-250`, {
              method: 'HEAD',
              timeoutMs: 10_000,
            })
            .catch(() => null);
          cover =
            head && (head.ok || head.status === 307)
              ? `https://coverartarchive.org/release/${r.id}/front-250`
              : false;
          covers[r.id] = cover;
        }
        items.push(toItem(r, cover || null));
      }
      if ((res.releases ?? []).length < 100) break;
      await Bun.sleep(1100);
    }
    for (const id of Object.keys(covers)) if (Object.keys(covers).length > 3000) delete covers[id];
    log(`${items.length} releases, ${spent} cover checks`);
    return { items, cursor: { covers }, note: `${items.length} releases` };
  },
});
