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

/*
 * A matchup: "NFL: Chiefs vs Bills", "Lakers @ Celtics", "Arsenal v Chelsea",
 * "Rangers at Celtic 19:45". IPTV playlists name an event channel after the
 * fixture it carries, and a player wants the fixture behind it for the score.
 */

/** A clock time, with or without a meridian and a zone, as a playlist writes it. */
const TIME = String.raw`(?:\d{1,2}[:.]\d{2}\s*(?:[ap]\.?m\.?)?|\d{1,2}\s*[ap]\.?m\.?)(?:\s*(?:et|pt|ct|mt|est|edt|cst|cdt|mst|mdt|pst|pdt|gmt|bst|cet|cest|utc|aest|aedt))?`;
const WEEKDAY = '(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day|sday|nesday|rsday|urday)?';
const MONTH = String.raw`(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?`;
const DATE = String.raw`(?:\d{4}-\d{2}-\d{2}|\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?|\d{1,2}(?:st|nd|rd|th)?\s+${MONTH}(?:\s+\d{4})?|${MONTH}\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?)`;
const WHEN = `(?:${TIME}|${WEEKDAY}|${DATE}|live|hd|fhd|uhd|4k|sd|\\d{3,4}[pi]|tonight|today)`;
const TRAILING_WHEN = new RegExp(String.raw`[\s,|@()-]+${WHEN}\s*$`, 'i');
const LEADING_WHEN = new RegExp(String.raw`^${WHEN}[\s,|@:()-]+(?=\S)`, 'i');

const SIDE_SEPARATOR = /\s+(?:vs\.?|v\.?|at|@)\s+/i;
const DASH_SEPARATOR = /\s+[-–—]\s+/;
/** "NFL: ", "NBA | ": a short label before a colon or a bar. */
const LEAGUE_COLON = /^([\p{L}\p{N}][\p{L}\p{N} .&'+]{0,24}?)\s*[:|]\s*(?=\S)/u;
/** "EPL - Arsenal v Chelsea": a label before a dash, only when a matchup follows. */
const LEAGUE_DASH = /^([\p{L}\p{N}][\p{L}\p{N} .&'+]{0,24}?)\s+[-–—]\s+(?=\S)/u;
/** "NFL Chiefs vs Bills": a bare league word, only when it is one everyone knows. */
const LEAGUE_WORD =
  /^(nfl|nba|mlb|nhl|mls|wnba|epl|ncaa|ncaaf|ncaab|ncaam|ncaaw|cfb|cbb|nrl|afl|ipl|ufc|pfl|ucl|uel|uecl|serie a|la ?liga|ligue 1|bundesliga|eredivisie|primeira liga|premier league|championship|fa cup|efl cup|carabao cup|copa del rey|dfb pokal|coppa italia|nwsl|wsl|cfl|xfl|usfl|pga|lpga|atp|wta|f1|motogp|nascar|indycar|wwe|aew|boxing|mma|bellator|super rugby|six nations|rugby|cricket|t20|bbl|psl|kbo|npb|khl|shl|euroleague|eurocup|fiba)\s+(?=\S)/i;
/** The two-letter country code a playlist puts first is not a league. */
const COUNTRY_CODE = /^[a-z]{2}$/i;

/**
 * A side looks like a team: letters, a few digits (49ers), spaces, dots,
 * ampersands and apostrophes, and none of the words that make it a programme
 * ("Live at Wembley"), a channel ("Sky Sports - Football") or a regional feed
 * ("Fox Sports - West").
 */
const TEAM_LIKE = /^(?=.*\p{L})[\p{L}\p{N}][\p{L}\p{N} .'&-]{1,39}$/u;
const NOT_A_TEAM_WORD =
  /\b(live|tonight|today|replay|highlights|night|show|event|events|football|soccer|sport|sports|news|movies|movie|film|films|tv|channel|radio|music|kids|hd|fhd|uhd|sd|4k|feed|backup|the)\b/i;
const NOT_A_TEAM =
  /^(east|west|north|south|main|extra|plus|one|two|three|four|five|premium|classic|action|arena|max|xtra|red|blue)$/i;

const looksLikeTeam = (side) => {
  const s = side.trim();
  if (!TEAM_LIKE.test(s)) return false;
  if (/^\d+$/.test(s)) return false;
  if (NOT_A_TEAM_WORD.test(s) || NOT_A_TEAM.test(s)) return false;
  QUALITY.lastIndex = 0;
  const quality = QUALITY.test(s);
  QUALITY.lastIndex = 0;
  return !quality;
};

/** The league label as written, upper-cased when it is an acronym; null for a country code. */
const leagueOf = (label) => {
  const s = label.trim().replace(/\s+/g, ' ');
  if (!s || COUNTRY_CODE.test(s)) return null;
  return /^[a-z0-9]{2,5}$/i.test(s) ? s.toUpperCase() : s;
};

/**
 * Two sides and, when the playlist wrote one, the league.
 *
 * The separators are ` vs `, ` vs. `, ` v `, ` at `, ` @ ` and, when both
 * sides look like teams, ` - `. A league or sport label in front ("NFL: ",
 * "NBA | ", "EPL - ", "[Live] ") and a time or a day behind ("19:45",
 * "7:30 PM ET", "Sat", "12/09") are taken off first.
 *
 * @returns {{ teams: [string, string], league: string|null, name: string }|null}
 */
export function parseMatchup(raw) {
  let s = String(raw ?? '')
    .replace(EXTENSIONS, '')
    .replace(/\[.*?\]/g, ' ')
    .replace(/\(.*?\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;
  for (let i = 0; i < 4; i++) {
    const next = s.replace(TRAILING_WHEN, '').replace(LEADING_WHEN, '').trim();
    if (next === s) break;
    s = next;
  }
  let league = null;
  // "US: NFL: Chiefs vs Bills": the last label before the sides is the league.
  for (let i = 0; i < 3; i++) {
    const m = s.match(LEAGUE_COLON);
    if (!m) break;
    league = leagueOf(m[1]) ?? league;
    s = s.slice(m[0].length);
  }
  // "EPL - Arsenal v Chelsea", "EPL - Arsenal - Chelsea": a label before a
  // dash is the league only when what follows is still a matchup; "Arsenal -
  // Chelsea" on its own is the matchup.
  let sides = null;
  const dashed = s.match(LEAGUE_DASH);
  if (dashed) {
    const rest = s.slice(dashed[0].length);
    const inner = rest.split(SIDE_SEPARATOR);
    const byDash = rest.split(DASH_SEPARATOR);
    if (inner.length === 2 || (byDash.length === 2 && byDash.every(looksLikeTeam))) {
      league = leagueOf(dashed[1]) ?? league;
      sides = inner.length === 2 ? inner : byDash;
    }
  }
  if (!sides) sides = s.split(SIDE_SEPARATOR);
  if (sides.length !== 2) sides = s.split(DASH_SEPARATOR);
  if (sides.length !== 2) return null;
  const w = sides[0].match(LEAGUE_WORD);
  if (w && looksLikeTeam(sides[0].slice(w[0].length))) {
    league = leagueOf(w[1]) ?? league;
    sides[0] = sides[0].slice(w[0].length);
  }
  const teams = sides.map((x) => x.trim().replace(/\s+/g, ' '));
  if (!teams.every(looksLikeTeam)) return null;
  return { teams, league, name: `${teams[0]} vs ${teams[1]}` };
}

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
 * A matchup ("NFL: Chiefs vs Bills", "Rangers at Celtic 19:45") is a fixture:
 * `teams` holds the two sides as written and `league` the label in front of
 * them when there was one, so the match can score by team rather than by
 * title.
 *
 * @returns {{ raw: string, name: string, year: number|null, season: number|null,
 *   episode: number|null, kind: 'movie'|'series'|'channel'|'music'|'fixture'|'other',
 *   teams: [string, string]|null, league: string|null }}
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
  let teams = null;
  let league = null;
  const matchup = releaseLike || music ? null : parseMatchup(text);
  if (matchup) {
    name = matchup.name;
    kind = 'fixture';
    teams = matchup.teams;
    league = matchup.league;
  } else if (releaseLike || music) {
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
  return { raw: text, name: name.slice(0, 200), year, season, episode, kind, teams, league };
}
