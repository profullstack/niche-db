/**
 * A name as a file or a playlist calls it, taken apart.
 *
 * "Top.Gun.Maverick.2022.1080p.WEB-DL.x265-FLUX.mkv" is a film called Top Gun
 * Maverick from 2022; "Severance.S02E03.2160p.ATVP.WEB-DL.mkv" is episode 3 of
 * the second season of a series called Severance; "ESPN2 HD" is a channel
 * called ESPN2. Every player and site that asks nichedb "what is this" cleans
 * the name here first, so they all match the same way, and so the rules live
 * in one place rather than in a torrent site, a player and a TV guide each
 * with its own copy.
 *
 * Ported from bittorrented.com's metadata enrichment, which had a year of
 * release names to learn from. The order of the replacements matters: the
 * release group is stripped before the dots become spaces, and DTS-HD before
 * DTS, or what is left is a stray "-HD".
 */

const EXTENSIONS =
  /\.(mkv|mp4|avi|mov|wmv|flv|webm|m4v|ts|mpg|mpeg|mp3|flac|m4a|aac|ogg|opus|wav)$/i;

const SITE_PREFIX = /^(www\.)?[a-z0-9-]+\.(org|com|net|io|tv|cc|to|me|xyz)\s*[-–—]\s*/i;

const QUALITY =
  /\b(1080p|1080i|720p|2160p|480p|4k|uhd|bluray|blu-ray|bdrip|brrip|dvdrip|webrip|web-?dl|hdtv|hdrip|x264|x265|hevc|avc|aac|dts|ac3|eac3|atmos|truehd|remux|hdr|hdr10\+?|dv|dolby\s*vision|10\s*bit|8\s*bit)\b/gi;
const SOURCE = /\b(telesync|cam|hdcam|hdts|dvdscr|screener|scr|r5|r6)\b/gi;
const CODEC_NOISE =
  /\b(h\s*264|h\s*265|dd\s*5\s*1|dd\s*2\s*0|ddp\s*5\s*1|ddp\s*2\s*0|5\s*1|7\s*1|2\s*0|264|265)\b/gi;
const SERVICES =
  /\b(amzn|amazon|nf|netflix|hulu|dsnp|disney\+?|hmax|hbo\s*max|max|atvp|apple\s*tv\+?|pbs|starz|starzplay|pcok|peacock|pmtp|paramount\+?|crav|itunes|web)\b/gi;
const SIZE = /\b\d+(\.\d+)?\s*(mb|gb|tb)\b/gi;
const EDITIONS =
  /\b(complete|proper|repack|internal|limited|extended|unrated|directors?\s*cut|theatrical|imax|remastered|real|rerip|nfofix|dirfix|readnfo|nuked|v\d)\b/gi;
const LANGUAGES =
  /\b(en|eng|english|multi|dual|latino|spanish|french|german|italian|portuguese|russian|japanese|korean|chinese|hindi|arabic|turkish|polish|dutch|swedish|norwegian|danish|finnish|greek|hebrew|czech|hungarian|romanian|bulgarian|ukrainian|vietnamese|thai|indonesian|malay|filipino|tagalog|vf|vff|vostfr|ita|spa|ger|fra)\b/gi;
const SUBS = /\b(subs?|subtitles?|subbed|dubbed|hardcoded|hc|hardsub)\b/gi;
const CONTAINERS = /\b(mp4|mkv|avi|mov|webm)\b/gi;

/** Season and episode, in the ways release names write them. */
const EPISODE = [
  /\bS(\d{1,2})\s*[.\-_ ]?\s*E(\d{1,3})(?:[-E]\d{1,3})?\b/i,
  /\b(\d{1,2})x(\d{1,3})\b/i,
  /\bSeason\s*(\d{1,2})\s*Episode\s*(\d{1,3})\b/i,
];
const SEASON_ONLY = [
  /\bS(\d{1,2})\b(?!\s*E)/i,
  /\bSeason\s*(\d{1,2})\b/i,
  /\bComplete\s+Series\b/i,
];

/** Things that make a name a channel rather than a title. */
const CHANNEL_NOISE =
  /\b(hd|fhd|uhd|4k|sd|hevc|h265|h264|raw|backup|vip|\d+p|fps\d*|\(\d+\)|\[\w+\])\b/gi;
const CHANNEL_PREFIX =
  /^\s*([a-z]{2,3}|[a-z]{2}-[a-z]{2}|us|uk|ca|au|de|fr|es|it|nl|pt|br|mx|ar)\s*[:|\-–]\s*/i;

export function extractYear(name) {
  const found = String(name ?? '').match(/\b(19|20)\d{2}\b/g);
  if (!found) return null;
  const now = new Date().getFullYear();
  const years = found.map((y) => Number(y)).filter((y) => y >= 1900 && y <= now + 1);
  return years.length ? years[years.length - 1] : null;
}

/** The title inside a release name, with every tag stripped. */
export function cleanReleaseName(raw) {
  let s = String(raw ?? '')
    .replace(EXTENSIONS, '')
    .replace(SITE_PREFIX, '')
    // A release group after a codec, with or without dots: x265-FLUX, MP4-BEN.THE.MEN
    .replace(/\.(mp4|mkv|avi|h264|h265|x264|x265|hevc|avc)-[a-z0-9]+(\.[a-z0-9]+)*$/i, '')
    .replace(/[-.]([a-z]{2,}[0-9]*|[0-9]+[a-z]+)$/i, (m) => {
      const group = m.slice(1);
      return group.length <= 10 && /^[a-z0-9]+$/i.test(group) ? '' : m;
    })
    .replace(/[._]/g, ' ')
    .replace(/\[.*?\]/g, '')
    .replace(/\(.*?\)/g, '')
    .replace(/\bDTS-?HD(\s*MA)?\b/gi, '')
    .replace(QUALITY, '')
    .replace(SOURCE, '')
    .replace(CODEC_NOISE, '')
    .replace(SERVICES, '')
    .replace(SIZE, '')
    .replace(/\s+-\s*[a-z0-9]{2,10}\s*$/i, '')
    .replace(EDITIONS, '')
    .replace(LANGUAGES, '')
    .replace(SUBS, '')
    .replace(CONTAINERS, '')
    .replace(/\s*\+\s*/g, ' ')
    .replace(/\bH\b(?=\s|$)/gi, '')
    .replace(/\s*-\s*$/g, '')
    .replace(/^\s*-\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length < 3) {
    const before = String(raw ?? '').match(/^(.+?)\s*(19|20)\d{2}/);
    if (before) s = before[1].replace(/[._]/g, ' ').trim();
  }
  return s;
}

/** A channel name as a playlist writes it, without the feed's decorations. */
export function cleanChannelName(raw) {
  return String(raw ?? '')
    .replace(CHANNEL_PREFIX, '')
    .replace(/[|]/g, ' ')
    .replace(/\[.*?\]/g, '')
    .replace(/\(.*?\)/g, '')
    .replace(CHANNEL_NOISE, '')
    .replace(/[._]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Take a name apart.
 *
 * @returns {{ raw: string, name: string, year: number|null, season: number|null,
 *   episode: number|null, kind: 'movie'|'series'|'channel'|'music'|'other' }}
 */
export function parseName(raw) {
  const text = String(raw ?? '').trim();
  const year = extractYear(text);
  let season = null;
  let episode = null;
  for (const re of EPISODE) {
    const m = text.match(re);
    if (m) {
      season = Number(m[1]);
      episode = Number(m[2]);
      break;
    }
  }
  if (season === null) {
    for (const re of SEASON_ONLY) {
      const m = text.match(re);
      if (m) {
        season = m[1] ? Number(m[1]) : null;
        break;
      }
    }
  }
  const series = season !== null || episode !== null || /\bcomplete\s+series\b/i.test(text);
  // A year, a file ending or a codec makes a release. A bare resolution does
  // not: a playlist writes "TF1 (720p)" and means the channel, not a rip.
  const releaseLike =
    series ||
    year !== null ||
    EXTENSIONS.test(text) ||
    /\b(x264|x265|hevc|web-?dl|webrip|bluray|bdrip|brrip|hdtv|dvdrip|remux)\b/i.test(text);
  const music =
    /\b(flac|320kbps|discography|album|ost|soundtrack|\.mp3)\b/i.test(text) ||
    /\.(mp3|flac|m4a|aac|ogg|opus|wav)$/i.test(text);

  let name;
  let kind;
  if (releaseLike || music) {
    name = cleanReleaseName(text);
    if (year !== null) name = name.replace(new RegExp(`\\b${year}\\b`), '').trim();
    name = name
      .replace(/\bS\d{1,2}(\s*E\d{1,3})?(?:[-E]\d{1,3})?\b/gi, '')
      .replace(/\b\d{1,2}x\d{1,3}\b/gi, '')
      .replace(/\bseason\s*\d+\b/gi, '')
      .replace(/\bepisode\s*\d+\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (music && !series) {
      // "02 - Song" is the song; "Artist - Discography" is the artist.
      name = name
        .replace(/^\d{1,3}\s*[-–.]\s*/, '')
        .replace(/\s*[-–]\s*(discography|complete|collection|anthology|greatest hits)\b.*$/i, '')
        .replace(/\b(320kbps|flac|discography)\b/gi, '')
        .replace(/^[\s.…-]+|[\s.-]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    }
    kind = series ? 'series' : music ? 'music' : 'movie';
  } else {
    name = cleanChannelName(text);
    kind = name === '' ? 'other' : 'channel';
  }
  return { raw: text, name: name.slice(0, 200), year, season, episode, kind };
}
