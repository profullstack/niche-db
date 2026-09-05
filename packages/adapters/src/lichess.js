import { defineAdapter } from '@nichedb/core/adapter';

/** Lichess: official tournament broadcasts (live boards) and their rounds. Keyless, ndjson. */
export function broadcastItems(b) {
  const t = b.tour;
  const out = [];
  const first =
    b.rounds
      ?.map((r) => r.startsAt)
      .filter(Boolean)
      .sort()[0] ??
    t.dates?.[0] ??
    null;
  out.push({
    externalId: `tour:${t.id}`,
    kind: 'tournament',
    title: t.name,
    summary:
      [t.info?.format, t.info?.tc, t.info?.location, t.info?.players].filter(Boolean).join(' · ') ||
      t.description?.slice(0, 300) ||
      null,
    url: t.url,
    imageUrl: t.image ?? null,
    publishedAt: first ? new Date(first) : null,
    tags: ['lichess', 'broadcast', t.info?.fideTC, t.tier ? `tier-${t.tier}` : null].filter(
      Boolean,
    ),
    data: {
      id: t.id,
      tier: t.tier ?? null,
      website: t.info?.website ?? null,
      location: t.info?.location ?? null,
      rounds: (b.rounds ?? []).length,
    },
  });
  for (const r of b.rounds ?? []) {
    out.push({
      externalId: `round:${r.id}`,
      kind: 'round',
      title: `${t.name}: ${r.name}`,
      summary: r.finished ? 'finished' : r.ongoing ? 'live now' : null,
      url: r.url,
      imageUrl: t.image ?? null,
      publishedAt: r.startsAt ? new Date(r.startsAt) : null,
      tags: [
        'lichess',
        'round',
        r.ongoing ? 'live' : r.finished ? 'finished' : 'upcoming',
        t.info?.fideTC,
      ].filter(Boolean),
      data: { tour: t.id, round: r.id, finished: Boolean(r.finished), ongoing: Boolean(r.ongoing) },
    });
  }
  return out;
}

export const lichessBroadcasts = defineAdapter({
  name: 'lichess-broadcasts',
  title: 'Lichess broadcasts',
  collection: 'chess',
  description:
    'Official over-the-board tournaments relayed live on Lichess, one item per event and per round with its start time. Keyless.',
  docs: 'https://lichess.org/api#tag/Broadcasts',
  kinds: ['tournament', 'round'],
  cadenceMinutes: 30,
  configFields: [{ key: 'nb', label: 'Broadcasts', type: 'number', placeholder: '50' }],
  defaults: { nb: 50 },
  defaultSources: [{ slug: 'chess-broadcasts', name: 'Chess: live tournament broadcasts' }],
  async pull({ config, http, log }) {
    const text = await http.text(
      `https://lichess.org/api/broadcast?nb=${Math.min(Number(config.nb) || 50, 100)}`,
      { headers: { accept: 'application/x-ndjson' } },
    );
    const items = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        items.push(...broadcastItems(JSON.parse(line)));
      } catch {}
    }
    log(`${items.length} tournaments and rounds`);
    return { items, note: `${items.length} rows` };
  },
});
