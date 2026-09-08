import { defineAdapter, looseDate } from '@nichedb/core/adapter';

/**
 * News channels you can actually watch, from the iptv-org public database.
 *
 * Two keyless JSON files: `channels.json` is the directory (31k channels, 2.1k
 * of them tagged `news`) and `streams.json` maps a channel to its public HLS
 * URLs. Neither is small — together about 11MB — so this runs daily, not
 * quarter-hourly. The directory changes on the order of days.
 *
 * **Only channels with a stream are stored.** Roughly half the news channels in
 * the directory have no public stream, and a row that cannot be watched is not
 * an answer to "where do I watch this". The pull note reports how many were
 * dropped so the ratio stays visible rather than looking like a parse bug.
 *
 * Channels marked `closed` are excluded too: iptv-org keeps them as history,
 * and a shut-down broadcaster is not something to point a reader at.
 */
const CHANNELS_URL = 'https://iptv-org.github.io/api/channels.json';
const STREAMS_URL = 'https://iptv-org.github.io/api/streams.json';

/** channel id -> [{url, quality, title}], newest-listed first. */
export function indexStreams(streams) {
  const byChannel = new Map();
  for (const s of streams ?? []) {
    if (!s?.channel || !s?.url) continue;
    const list = byChannel.get(s.channel) ?? [];
    list.push({ url: s.url, quality: s.quality ?? null, title: s.title ?? null });
    byChannel.set(s.channel, list);
  }
  return byChannel;
}

export function isNewsChannel(c) {
  return Boolean(
    c?.id && c?.name && (c.categories ?? []).includes('news') && !c.is_nsfw && !c.closed,
  );
}

export function toItem(c, streams) {
  const country = (c.country ?? '').toLowerCase();
  const { publishedAt, timeKnown, precision } = c.launched
    ? looseDate(c.launched)
    : { publishedAt: null, timeKnown: false, precision: 'day' };
  const best = streams[0] ?? null;
  return {
    externalId: c.id,
    kind: 'channel',
    title: c.name,
    summary:
      [
        c.network ? `${c.network} network` : null,
        c.owners?.length ? `Operated by ${c.owners.join(', ')}` : null,
        `${streams.length} public stream${streams.length === 1 ? '' : 's'}`,
      ]
        .filter(Boolean)
        .join('. ') || null,
    url: c.website ?? null,
    imageUrl: null,
    publishedAt,
    timeKnown,
    precision,
    tags: ['news', 'channel', country, c.network?.toLowerCase()].filter(Boolean),
    data: {
      channelId: c.id,
      country: c.country ?? null,
      network: c.network ?? null,
      owners: c.owners ?? [],
      website: c.website ?? null,
      altNames: c.alt_names ?? [],
      launched: c.launched ?? null,
      streamUrl: best?.url ?? null,
      quality: best?.quality ?? null,
      streams: streams.slice(0, 8),
    },
  };
}

export function buildItems(channels, streams) {
  const byChannel = indexStreams(streams);
  const items = [];
  let withoutStream = 0;
  for (const c of channels ?? []) {
    if (!isNewsChannel(c)) continue;
    const s = byChannel.get(c.id);
    if (!s?.length) {
      withoutStream += 1;
      continue;
    }
    items.push(toItem(c, s));
  }
  return { items, withoutStream };
}

export const newsChannels = defineAdapter({
  name: 'news-channels',
  title: 'News channels',
  collection: 'news',
  description:
    'Live news channels worldwide from the iptv-org directory, each with its public stream URL, country, network and operator. Keyless. Only channels that currently carry a stream are listed.',
  docs: 'https://github.com/iptv-org/api',
  kinds: ['channel'],
  cadenceMinutes: 1440,
  configFields: [],
  defaultSources: [{ slug: 'news-channels', name: 'News: live channels' }],
  async pull({ http, log }) {
    const [channels, streams] = await Promise.all([
      http.json(CHANNELS_URL, { timeoutMs: 60_000 }),
      http.json(STREAMS_URL, { timeoutMs: 60_000 }),
    ]);
    const { items, withoutStream } = buildItems(channels, streams);
    log(`${items.length} watchable news channels, ${withoutStream} without a stream`);
    return {
      items,
      note: `${items.length} channels with a stream; ${withoutStream} listed but not streamable`,
    };
  },
});
