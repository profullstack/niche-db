import { defineEnricher, searchTitle } from './enricher.js';

/**
 * Videos about the thing: trailers for games and sets, official audio for
 * releases, the webcast for a launch. With YOUTUBE_API_KEY set it uses the Data
 * API; without one it reads the public results page, which carries the same
 * list inside `ytInitialData`.
 */
const HINT = {
  game: 'trailer',
  set: 'trailer',
  release: 'official',
  launch: 'launch',
  tournament: 'chess',
  book: 'book',
  card: 'mtg',
  extension: 'extension',
  'mcp-server': 'mcp',
  paper: 'paper',
};

export function parseResultsPage(html) {
  const m = html.match(/var ytInitialData = (\{.*?\});<\/script>/s);
  if (!m) return [];
  let data;
  try {
    data = JSON.parse(m[1]);
  } catch {
    return [];
  }
  const out = [];
  const walk = (o) => {
    if (out.length >= 5) return;
    if (Array.isArray(o)) for (const x of o) walk(x);
    else if (o && typeof o === 'object') {
      if (o.videoRenderer?.videoId) {
        const v = o.videoRenderer;
        out.push({
          id: v.videoId,
          title: (v.title?.runs ?? []).map((r) => r.text).join(''),
          channel: v.ownerText?.runs?.[0]?.text ?? null,
          length: v.lengthText?.simpleText ?? null,
          url: `https://www.youtube.com/watch?v=${v.videoId}`,
          thumbnail: `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
        });
      }
      for (const x of Object.values(o)) walk(x);
    }
  };
  walk(data);
  return out;
}

export const youtube = defineEnricher({
  name: 'youtube',
  title: 'YouTube videos',
  description:
    'The top videos for the item: trailers for games and sets, official audio for releases, webcasts for launches.',
  collections: ['games', 'music', 'tabletop', 'space', 'chess', 'books'],
  appliesTo: (item) =>
    ['game', 'set', 'release', 'launch', 'tournament', 'book'].includes(item.kind),
  perRun: 30,
  async enrich(item, { env, http }) {
    const q = `${searchTitle(item)} ${HINT[item.kind] ?? ''}`.trim();
    let videos = [];
    if (env.youtubeKey) {
      const res = await http.json(
        `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=3&q=${encodeURIComponent(q)}&key=${env.youtubeKey}`,
      );
      videos = (res.items ?? []).map((v) => ({
        id: v.id.videoId,
        title: v.snippet.title,
        channel: v.snippet.channelTitle,
        url: `https://www.youtube.com/watch?v=${v.id.videoId}`,
        thumbnail:
          v.snippet.thumbnails?.high?.url ?? `https://i.ytimg.com/vi/${v.id.videoId}/hqdefault.jpg`,
      }));
    } else {
      const html = await http.text(
        `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=EgIQAQ%253D%253D`,
        {
          headers: {
            'user-agent':
              'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
            'accept-language': 'en-US,en;q=0.9',
            cookie: 'CONSENT=YES+1; SOCS=CAI',
          },
          timeoutMs: 20_000,
        },
      );
      videos = parseResultsPage(html).slice(0, 3);
      await Bun.sleep(1500);
    }
    if (videos.length === 0) return null;
    return { query: q, videos, imageUrl: videos[0].thumbnail };
  },
});
