import { defineAdapter, looseDate } from '@nichedb/core/adapter';
import { indexStreams } from './newschannels.js';

/**
 * Every television channel in the iptv-org directory, streamable or not.
 *
 * The news-channels source keeps the 900 news channels a reader can watch.
 * This keeps all 31,000, because the question a player asks is different: a
 * playlist entry called "ESPN2 HD" or "TF1" wants a logo, a country, a
 * language and a category whether or not iptv-org knows a public stream for
 * it. The stream is kept when there is one and tagged `streamable`, so the
 * watchable subset is one tag away.
 *
 * Closed channels are kept too, flagged, because a playlist made three years
 * ago still names them and "this shut down in 2023" is a better answer than
 * nothing. NSFW channels are flagged and never given a stream.
 *
 * Three keyless files, ~13MB together, so this runs daily.
 */
const CHANNELS_URL = 'https://iptv-org.github.io/api/channels.json';
const STREAMS_URL = 'https://iptv-org.github.io/api/streams.json';
const LOGOS_URL = 'https://iptv-org.github.io/api/logos.json';

const slug = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** channel id -> best logo url, preferring the widest. */
export function indexLogos(logos) {
  const byChannel = new Map();
  for (const l of logos ?? []) {
    if (!l?.channel || !l?.url) continue;
    const have = byChannel.get(l.channel);
    if (!have || (l.width ?? 0) > (have.width ?? 0)) byChannel.set(l.channel, l);
  }
  return byChannel;
}

export function toItem(c, streams = [], logo = null) {
  const country = (c.country ?? '').toLowerCase();
  const categories = (c.categories ?? []).map(slug).filter(Boolean);
  const languages = (c.languages ?? []).map((l) => String(l).toLowerCase()).filter(Boolean);
  const { publishedAt, timeKnown, precision } = c.launched
    ? looseDate(c.launched)
    : { publishedAt: null, timeKnown: false, precision: 'day' };
  const watchable = streams.length > 0 && !c.is_nsfw;
  const best = watchable ? streams[0] : null;
  const closed = c.closed ?? null;
  return {
    externalId: `iptv-org:channel:${c.id}`,
    kind: 'channel',
    title: c.name,
    summary:
      [
        c.network ? `${c.network} network` : null,
        c.owners?.length ? `Operated by ${c.owners.join(', ')}` : null,
        categories.length ? `Category: ${categories.join(', ')}` : null,
        closed ? `Closed ${closed}` : null,
        watchable
          ? `${streams.length} public stream${streams.length === 1 ? '' : 's'}`
          : 'No public stream',
      ]
        .filter(Boolean)
        .join('. ') || null,
    url: c.website ?? null,
    imageUrl: logo?.url ?? c.logo ?? null,
    publishedAt,
    timeKnown,
    precision,
    tags: [
      'channel',
      ...categories,
      country ? `country:${country}` : null,
      ...languages.map((l) => `lang:${l}`),
      c.network ? `network:${slug(c.network)}` : null,
      watchable ? 'streamable' : null,
      closed ? 'closed' : null,
    ].filter(Boolean),
    data: {
      channelId: c.id,
      country: c.country ?? null,
      subdivision: c.subdivision ?? null,
      city: c.city ?? null,
      network: c.network ?? null,
      owners: c.owners ?? [],
      categories: c.categories ?? [],
      languages: c.languages ?? [],
      altNames: c.alt_names ?? [],
      launched: c.launched ?? null,
      closed,
      isNsfw: Boolean(c.is_nsfw),
      website: c.website ?? null,
      logo: logo?.url ?? c.logo ?? null,
      streamUrl: best?.url ?? null,
      quality: best?.quality ?? null,
      streams: watchable ? streams.slice(0, 8) : [],
    },
  };
}

export function buildItems(channels, streams, logos = []) {
  const byChannel = indexStreams(streams);
  const byLogo = indexLogos(logos);
  const items = [];
  let streamable = 0;
  for (const c of channels ?? []) {
    if (!c?.id || !c?.name) continue;
    const s = byChannel.get(c.id) ?? [];
    const item = toItem(c, s, byLogo.get(c.id) ?? null);
    if (item.tags.includes('streamable')) streamable += 1;
    items.push(item);
  }
  return { items, streamable };
}

export const channels = defineAdapter({
  name: 'iptv-org-channels',
  title: 'Television channels',
  collection: 'channels',
  description:
    'Every television channel in the iptv-org directory, worldwide: name, logo, country, language, category, network and operator, with the public stream URL where one exists. Keyless. Closed channels are kept and flagged, because old playlists still name them.',
  docs: 'https://github.com/iptv-org/api',
  kinds: ['channel'],
  cadenceMinutes: 1440,
  configFields: [],
  defaultSources: [{ slug: 'iptv-org-channels', name: 'Channels: the iptv-org directory' }],
  async pull({ http, log }) {
    const [channelList, streams, logos] = await Promise.all([
      http.json(CHANNELS_URL, { timeoutMs: 90_000 }),
      http.json(STREAMS_URL, { timeoutMs: 90_000 }),
      http.json(LOGOS_URL, { timeoutMs: 90_000 }).catch(() => []),
    ]);
    const { items, streamable } = buildItems(channelList, streams, logos);
    log(`${items.length} channels, ${streamable} with a public stream`);
    return { items, note: `${items.length} channels; ${streamable} streamable` };
  },
});
