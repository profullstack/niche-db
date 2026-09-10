import { defineAdapter, slugify } from '@nichedb/core/adapter';

/**
 * ESPN's unauthenticated JSON API, as three sources into the `sports` collection.
 *
 * Ported from tipoffwatch.com's sports package, which polled ESPN itself and
 * stored the result in its own tables. Here the same fetch and parse code feeds
 * items instead, and the site reads the collection.
 *
 * Two hosts are used:
 *   sports.core.api.espn.com/v2  -- the catalogue (which sports, which leagues,
 *                                   a league's real name and, for domestic soccer,
 *                                   its country)
 *   site.api.espn.com/apis/site  -- rosters and the scoreboard (the fixtures)
 *
 * Verified 2026-08-19 on tipoffwatch: 17 sports, 354 leagues, 216 of them soccer.
 *
 * The three adapters cannot share state, so each carries what it needs in its own
 * cursor: the league list (refreshed daily, 18 requests), and for the schedule the
 * earliest upcoming fixture per league so the near-window pass can pick its leagues
 * without a database.
 */

const CORE = 'https://sports.core.api.espn.com/v2';
export const SITE = 'https://site.api.espn.com/apis/site/v2/sports';

/** A scoreboard response caps out around 100 events regardless of `limit`. */
export const PAGE_CAP = 100;

export const PROVIDER = 'espn';

/** Leagues people actually follow, polled ahead of the long tail. */
export const PRIORITY = new Map([
  ['nfl', 1],
  ['nba', 1],
  ['mlb', 1],
  ['nhl', 1],
  ['eng.1', 1],
  ['esp.1', 1],
  ['ger.1', 1],
  ['ita.1', 1],
  ['fra.1', 1],
  ['uefa.champions', 1],
  ['fifa.world', 1],
  ['usa.1', 2],
  ['mex.1', 2],
  ['college-football', 2],
  ['mens-college-basketball', 2],
  ['f1', 2],
  ['atp', 3],
  ['wta', 3],
  ['ufc', 3],
]);

/**
 * Sports whose scoreboard event is a tournament, a race weekend or a fight card
 * rather than a match, so the summary endpoint has no play log for the id stored.
 * Measured on tipoffwatch 2026-08-21, one finished fixture per sport.
 */
export const NO_PLAYS = new Set([
  'field-hockey',
  'lacrosse',
  'rugby',
  'rugby-league',
  'volleyball',
  'water-polo',
  'tennis',
  'golf',
  'racing',
  'mma',
]);

/** Sports whose summary has no box score either (see NO_PLAYS for why). */
export const NO_BOXSCORE = new Set(['tennis', 'golf', 'racing', 'mma']);

/**
 * Where a competition is played, for the ones the provider will not say.
 *
 * ESPN carries `country` on the core league endpoint for domestic soccer and
 * nowhere else. This is the exception list, and the bar for an entry is that
 * without it the chip names a DIFFERENT competition to a reader: Australia's NBL
 * is the National Basketball League, one word from the NBA.
 */
export const CURATED_REGIONS = new Map([
  ['basketball/nbl', 'Australia'],
  ['basketball/acb', 'Spain'],
  ['basketball/lba', 'Italy'],
  ['basketball/nbb', 'Brazil'],
]);

/**
 * Competitions ESPN ships twice under two keys. tipoffwatch marked the duplicate
 * `superseded_by` the surviving row; here the fact rides on the league item.
 */
export const SUPERSEDED = new Map([['soccer/concacaf.champions_cup', 'soccer/concacaf.champions']]);

/**
 * Names ESPN cut off mid-word, and what the channel actually calls itself.
 *
 * Cosmetic: a truncation not listed here renders as ESPN wrote it. Keyed on the
 * exact string ESPN sends. MLB.TV is deliberately not renamed to MLB Network --
 * they are two products and the listing means the streaming one.
 */
const SPELLED_OUT = new Map([
  ['nbc sports ca', 'NBC Sports California'],
  ['nbc sports ba', 'NBC Sports Bay Area'],
  ['nbc sports bo', 'NBC Sports Boston'],
  ['nbc sports phil', 'NBC Sports Philadelphia'],
  ['nbc sports wsh', 'NBC Sports Washington'],
  ['usa net', 'USA Network'],
  ['mlb net', 'MLB Network'],
  ['b1g+', 'Big Ten+'],
  ['espn unlmtd', 'ESPN Unlimited'],
  ['marquee sports net', 'Marquee Sports Network'],
  ['spectrum sports net', 'Spectrum SportsNet'],
  ['rangers sports net', 'Rangers Sports Network'],
]);

/** The broadcaster's own name for itself, where the listing abbreviated it. */
export function canonicalBroadcaster(name) {
  const key = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  return SPELLED_OUT.get(key) ?? String(name ?? '').trim();
}

/* ------------------------------------------------------------------ access -- */

/**
 * ESPN filters on User-Agent, and Bun's default is on the wrong side of it.
 *
 * Verified 2026-08-19: no UA, a browser UA, `node-fetch/*`, `Wget/*` and a plain
 * custom app string all get `403 Access Denied` with an HTML body, while `curl/*`,
 * `okhttp/*`, `python-requests/*` and `Go-http-client/*` get JSON. It is an
 * allowlist of recognised API clients, not a bot block. So the UA is curl-prefixed
 * to clear the filter, with our own URL appended so we are still identifiable.
 */
export const USER_AGENT = 'curl/8.5.0 (+https://nichedb.dev)';

/**
 * ESPN blocks datacenter egress: the identical request that returns JSON from a
 * laptop returns 403 from a cloud host. So when a residential proxy is configured
 * it is the normal route.
 *
 * What is NOT the normal route is the proxy failing as a BILLING account: on
 * tipoffwatch the plan ran out of bandwidth and every request came back `402` for
 * sixteen hours, and every score froze. 402/407 is the PROXY refusing us and says
 * nothing about ESPN, so going direct is strictly better than not going at all.
 * 403/429 is ESPN refusing the proxy's exit IP, and a datacenter IP fares worse,
 * so those are not retried. A circuit breaker rather than a per-request retry:
 * an exhausted plan costs one doomed burst per cooldown, and it re-arms itself
 * when the plan is topped up.
 */
const PROXY_COOLDOWN_MS = 5 * 60_000;
const PROXY_FAULT = new Set([402, 407]);

/** Set while the proxy is known-unusable; the value is when to try it again. */
let proxyBlockedUntil = 0;

/** Visible for tests, and for a caller that wants to force a re-probe. */
export function resetProxyBreaker() {
  proxyBlockedUntil = 0;
}

/** Whether the proxy would be used right now, for tests. */
export function proxyUsable(now = Date.now()) {
  return now >= proxyBlockedUntil;
}

/**
 * One GET against ESPN, through the proxy when there is one.
 *
 * The core http helper carries the deployment's own UA and cannot route through a
 * proxy, so the proxied path is a bare fetch with Bun's `proxy` option; the direct
 * path goes through `http.request` with the UA overridden, which also gets the
 * helper's 429 handling for free. The proxy URL is read from the environment and
 * never appears in an item.
 */
export function makeEspnClient({ env = {}, http, log = () => {}, fetchImpl = fetch } = {}) {
  const proxy = env.sportsProxyUrl ?? env.SPORTS_PROXY_URL ?? null;

  async function direct(url, timeoutMs) {
    const headers = { 'user-agent': USER_AGENT, accept: 'application/json' };
    if (http?.request) return http.request(url, { headers, timeoutMs });
    return fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  }

  async function get(url, { timeoutMs = 20_000 } = {}) {
    const useProxy = Boolean(proxy) && proxyUsable();
    let res;
    if (useProxy) {
      try {
        res = await fetchImpl(url, {
          proxy,
          headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        // A proxy that will not even connect is the same class of problem as one
        // that answers 402, and it arrives as a throw rather than a status.
        proxyBlockedUntil = Date.now() + PROXY_COOLDOWN_MS;
        log(`proxy unreachable (${err?.message ?? err}); going direct for 5 minutes`);
        res = await direct(url, timeoutMs);
      }
      if (res && PROXY_FAULT.has(res.status)) {
        // The body is the one message that says which account is out of what.
        const why = await res.text().catch(() => '');
        proxyBlockedUntil = Date.now() + PROXY_COOLDOWN_MS;
        log(`proxy ${res.status}: ${why.trim().slice(0, 160)} -- going direct for 5 minutes`);
        res = await direct(url, timeoutMs);
      }
    } else {
      res = await direct(url, timeoutMs);
    }
    if (!res.ok) {
      const err = new Error(`espn ${res.status}${useProxy ? ' (via proxy)' : ''} ${url}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  return { get, proxied: Boolean(proxy) };
}

/* --------------------------------------------------------------- catalogue -- */

/** The `$ref` links carry the slug in the path; parsing it beats a fetch per league. */
export const slugFromRef = (ref, segment) =>
  String(ref ?? '')
    .split(`/${segment}/`)[1]
    ?.split('?')[0] ?? null;

/**
 * A league's slug. Underscores are kept distinct from dots on purpose: ESPN ships
 * both `fifa.intercontinental_cup` and `fifa.intercontinental.cup`, and folding
 * both separators to `-` collapses them into one slug.
 */
export const leagueSlug = (sport, key) =>
  `${sport}-${key}`.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');

/** The sport slugs in a `/sports` listing. */
export function parseSports(json) {
  return (json?.items ?? []).map((i) => slugFromRef(i.$ref, 'sports')).filter(Boolean);
}

/** The leagues of one sport, from its `/leagues` listing. */
export function parseLeagueRefs(sport, json) {
  return (json?.items ?? [])
    .map((i) => slugFromRef(i.$ref, 'leagues'))
    .filter(Boolean)
    .map((key) => ({
      key: `${sport}/${key}`,
      sport,
      leagueKey: key,
      slug: leagueSlug(sport, key),
      priority: PRIORITY.get(key) ?? 100,
    }));
}

/**
 * Every sport and league ESPN knows about. Cheap enough (18 requests) to re-run
 * daily, which is how new competitions appear without a deploy.
 */
export async function listLeagues(client, { skipSports = [] } = {}) {
  const skip = new Set(skipSports);
  const sports = parseSports(await client.get(`${CORE}/sports?limit=50`)).filter(
    (s) => !skip.has(s),
  );
  const out = [];
  for (const sport of sports) {
    let page;
    try {
      page = await client.get(`${CORE}/sports/${sport}/leagues?limit=1000`);
    } catch {
      // A sport with no leagues (cricket, currently) 404s rather than returning
      // an empty list. Not an error worth failing the whole catalogue over.
      continue;
    }
    out.push(...parseLeagueRefs(sport, page));
  }
  return out.sort((a, b) => a.priority - b.priority || a.key.localeCompare(b.key));
}

/** A league's real name, abbreviation, logo and (domestic soccer only) country. */
export function parseLeagueDetail(json) {
  if (!json || typeof json !== 'object') return null;
  return {
    name: json.name ?? null,
    abbreviation: json.abbreviation ?? null,
    logoUrl: json.logos?.[0]?.href ?? null,
    region: json.country?.name ?? null,
  };
}

/** The region for a league: curation wins over the provider on purpose. */
export function regionFor(key, fromProvider = null) {
  return CURATED_REGIONS.get(key) ?? fromProvider ?? null;
}

/**
 * Which abbreviations identify nothing on their own. Thirteen MMA promotions
 * abbreviate to "BFC"; a chip showing that is not short, it is wrong.
 * @param {Record<string,string|null>} abbrByKey
 */
export function ambiguousAbbreviations(abbrByKey) {
  const count = new Map();
  for (const a of Object.values(abbrByKey ?? {})) {
    if (!a) continue;
    const k = String(a).toLowerCase();
    count.set(k, (count.get(k) ?? 0) + 1);
  }
  return new Set([...count].filter(([, n]) => n > 1).map(([k]) => k));
}

export function leagueItem(league, detail = {}, { ambiguous = new Set(), teams = null } = {}) {
  const { sport, leagueKey, key, slug } = league;
  const name = detail.name || leagueKey;
  const region = regionFor(key, detail.region ?? null);
  const abbreviation = detail.abbreviation ?? null;
  return {
    externalId: `${PROVIDER}:league:${sport}:${slug}`,
    kind: 'league',
    title: name,
    summary:
      [abbreviation && abbreviation !== name ? abbreviation : null, region]
        .filter(Boolean)
        .join(' · ') || null,
    url: null,
    imageUrl: detail.logoUrl ?? null,
    publishedAt: null,
    timeKnown: false,
    precision: 'day',
    tags: ['league', sport, region ? `region:${slugify(region)}` : null].filter(Boolean),
    data: {
      provider: PROVIDER,
      sport,
      slug,
      key,
      name,
      abbreviation,
      logoUrl: detail.logoUrl ?? null,
      region,
      priority: league.priority ?? PRIORITY.get(leagueKey) ?? 100,
      abbrAmbiguous: Boolean(abbreviation && ambiguous.has(String(abbreviation).toLowerCase())),
      supersededBy: SUPERSEDED.get(key) ?? null,
      plays_supported: !NO_PLAYS.has(sport),
      boxscoreSupported: !NO_BOXSCORE.has(sport),
      teams,
    },
  };
}

/**
 * Every team in a league, whether or not it plays soon.
 *
 * Keyed by LEAGUE, not sport. ESPN team ids are only unique within a league: id 7
 * is the Denver Broncos in the NFL and the Amherst Mammoths in college football,
 * and 20 NFL ids collide with college ones.
 */
export function parseTeams(league, json) {
  const entries = json?.sports?.[0]?.leagues?.[0]?.teams ?? [];
  return entries
    .map((entry) => entry.team)
    .filter((t) => t?.id)
    .map((t) => ({
      id: String(t.id),
      key: `${league.key}/${t.id}`,
      slug: `${league.slug}-${t.id}`,
      name: t.name ?? t.displayName ?? t.shortDisplayName ?? 'Unknown',
      displayName: t.displayName ?? t.name ?? 'Unknown',
      shortName: t.shortDisplayName ?? null,
      location: t.location ?? null,
      abbreviation: t.abbreviation ?? null,
      logoUrl: t.logos?.[0]?.href ?? t.logo ?? null,
      color: t.color ?? null,
      alternateColor: t.alternateColor ?? null,
      url: (t.links ?? []).find((l) => (l.rel ?? []).includes('clubhouse'))?.href ?? null,
    }));
}

/** The league name the teams endpoint carries alongside the roster. */
export function leagueNameFromTeams(json) {
  const l = json?.sports?.[0]?.leagues?.[0];
  return l?.name ? { name: l.name, abbreviation: l.abbreviation ?? null } : null;
}

export function teamItem(league, t) {
  return {
    externalId: `${PROVIDER}:team:${t.key}`,
    kind: 'team',
    title: t.displayName,
    summary: t.location && t.location !== t.displayName ? t.location : null,
    url: t.url ?? null,
    imageUrl: t.logoUrl ?? null,
    publishedAt: null,
    timeKnown: false,
    precision: 'day',
    tags: ['team', league.sport, `league:${league.slug}`],
    data: {
      provider: PROVIDER,
      sport: league.sport,
      id: t.id,
      key: t.key,
      slug: t.slug,
      name: t.name,
      displayName: t.displayName,
      shortName: t.shortName ?? null,
      abbreviation: t.abbreviation ?? null,
      location: t.location ?? null,
      logoUrl: t.logoUrl ?? null,
      color: t.color ?? null,
      alternateColor: t.alternateColor ?? null,
      leagues: [league.slug],
    },
  };
}

/* -------------------------------------------------------------------- odds -- */

/** A number ESPN may ship as a string, a float, or not at all. */
const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);

/**
 * A moneyline price, from either of the two places ESPN puts it: the scoreboard's
 * `odds[].moneyline.home.close.odds` (a STRING, with an `open` beside it) and
 * pickcenter's `odds[].homeTeamOdds.moneyLine` (a NUMBER). Close before open.
 *
 * Prices beyond ±10,000 are dropped: once a game is over the book quotes the
 * settled result (-100000 for the winner), and a real pre-game price never
 * reaches that.
 */
const MONEYLINE_LIMIT = 10_000;
function moneyline(book, which, when = 'close') {
  const fromPickcenter =
    when === 'close'
      ? which === 'draw'
        ? book.drawOdds?.moneyLine
        : book[`${which}TeamOdds`]?.moneyLine
      : null;
  const slot = book.moneyline?.[which];
  const scoreboard = when === 'open' ? slot?.open?.odds : (slot?.close?.odds ?? slot?.open?.odds);
  const value = num(fromPickcenter ?? scoreboard);
  if (value === null || Math.abs(value) > MONEYLINE_LIMIT) return null;
  return value;
}

/** A spread or total line; a total reads "o44.5" so the prefix has to come off. */
function lineAt(book, key, side, when) {
  const raw = book[key]?.[side]?.[when]?.line;
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  return num(String(raw).replace(/^[ou]/i, ''));
}

/** Where the market opened, when the provider says. Null on pickcenter. */
function openingFrom(book) {
  const opening = {
    spread: lineAt(book, 'pointSpread', 'home', 'open'),
    overUnder: lineAt(book, 'total', 'over', 'open'),
    homeMoneyline: moneyline(book, 'home', 'open'),
    awayMoneyline: moneyline(book, 'away', 'open'),
  };
  return Object.values(opening).some((v) => v !== null) ? opening : null;
}

/**
 * The betting line on a fixture, from the scoreboard entry we already have.
 *
 * The field only exists while the game is `pre`: a book stops pricing a game when
 * it starts and ESPN drops the field with it, on soccer as `[null]`, a one-entry
 * list whose entry is nothing. So the line is captured here and stamped with the
 * state it was seen in. Several books come back ordered by ESPN's own priority;
 * the first is taken rather than averaged.
 */
export function oddsFromCompetition(comp, { state = 'pre', now = new Date() } = {}) {
  const raw = (comp?.odds ?? []).filter(Boolean);
  if (raw.length === 0) return null;
  const book = raw[0];
  const home = book.homeTeamOdds ?? {};
  const away = book.awayTeamOdds ?? {};
  // Asked of the book rather than inferred from the sign of the spread: baseball
  // quotes a run line the other way round from a football spread.
  const favorite = home.favorite === true ? 'home' : away.favorite === true ? 'away' : null;
  const details = typeof book.details === 'string' && book.details.trim() ? book.details : null;
  const line = {
    provider: book.provider?.name ?? book.provider?.displayName ?? null,
    details,
    spread: num(book.spread),
    overUnder: num(book.overUnder),
    favorite,
    homeMoneyline: moneyline(book, 'home'),
    awayMoneyline: moneyline(book, 'away'),
    drawMoneyline: moneyline(book, 'draw'),
    opening: openingFrom(book),
    capturedAt: now.toISOString(),
    capturedState: state,
  };
  const hasContent =
    line.details ||
    line.spread !== null ||
    line.overUnder !== null ||
    line.homeMoneyline !== null ||
    line.awayMoneyline !== null;
  return hasContent ? line : null;
}

/* ---------------------------------------------------------------- fixtures -- */

/** ESPN's status states are already pre/in/post; anything unknown is treated as pre. */
export function normaliseState(competition) {
  const state = competition?.status?.type?.state;
  return state === 'in' || state === 'post' ? state : 'pre';
}

/**
 * When it starts, and how honestly.
 *
 * A playoff game is scheduled before its slot is sold and a rain-affected fixture
 * is "Saturday, time TBD"; ESPN pads those to midnight local and says so with
 * `timeValid: false` on the competition. tipoffwatch stored every kickoff as
 * known; this reads the flag, so a date-only fixture lands at day precision.
 */
export function startOf(e, comp) {
  const raw = e?.date ?? comp?.date ?? null;
  const d = raw ? new Date(raw) : null;
  if (!d || Number.isNaN(d.getTime()))
    return { publishedAt: null, timeKnown: false, precision: 'day' };
  const known = comp?.timeValid !== false;
  return { publishedAt: d, timeKnown: known, precision: known ? 'minute' : 'day' };
}

const broadcastNamesOf = (comp) => [
  ...new Set((comp?.broadcasts ?? []).flatMap((b) => b.names ?? []).map(canonicalBroadcaster)),
];

const summaryLink = (e) =>
  (e?.links ?? []).find((l) => (l.rel ?? []).includes('summary'))?.href ??
  (e?.links ?? []).find((l) => (l.rel ?? []).includes('desktop'))?.href ??
  null;

function sideOf(comp, league, which) {
  const c = (comp?.competitors ?? []).find((x) => x.homeAway === which);
  if (!c?.team) return null;
  const t = c.team;
  const score =
    c.score === undefined || c.score === null ? Number.NaN : Number.parseInt(c.score, 10);
  return {
    id: String(t.id),
    key: `${league.key}/${t.id}`,
    slug: `${league.slug}-${t.id}`,
    name: t.name ?? t.displayName ?? t.shortDisplayName ?? 'Unknown',
    displayName: t.displayName ?? t.name ?? 'Unknown',
    abbreviation: t.abbreviation ?? null,
    logoUrl: t.logo ?? t.logos?.[0]?.href ?? null,
    score: Number.isFinite(score) ? score : null,
    // The first record is the overall season one; later entries are splits.
    record: c.records?.[0]?.summary ?? null,
  };
}

function normaliseEvent(e, league) {
  const comp = e?.competitions?.[0];
  if (!comp || !e?.date) return null;
  const home = sideOf(comp, league, 'home');
  const away = sideOf(comp, league, 'away');
  const state = normaliseState(comp);
  const broadcastNames = broadcastNamesOf(comp);
  return {
    id: String(e.id),
    key: `${league.key}/${e.id}`,
    ...startOf(e, comp),
    state,
    statusDetail: comp.status?.type?.shortDetail ?? null,
    name: e.name ?? e.shortName ?? 'Fixture',
    shortName: e.shortName ?? null,
    url: summaryLink(e),
    venue: comp.venue?.fullName ?? null,
    venueCity: comp.venue?.address?.city ?? null,
    // US venues carry a state, everywhere else a country, and never both.
    venueRegion: comp.venue?.address?.state ?? comp.venue?.address?.country ?? null,
    neutralSite: comp.neutralSite === true,
    broadcast: broadcastNames.join(', ') || null,
    broadcastNames,
    attendance: Number.isFinite(comp.attendance) && comp.attendance > 0 ? comp.attendance : null,
    period: Number.isFinite(e.status?.period) ? e.status.period : null,
    displayClock: e.status?.displayClock ?? null,
    odds: oddsFromCompetition(comp, { state }),
    home,
    away,
    tournament: false,
  };
}

/**
 * An unfilled bracket slot: a draw is published before it is drawn, with both
 * sides "TBD" and a negative id, which is the one signal that does not depend on
 * wording.
 */
const isUndrawn = (c) =>
  Number(c?.id) < 0 || (c?.athlete?.displayName ?? c?.roster?.displayName) === 'TBD';

/** One side of a tennis match: a player, or a doubles pair on `roster`. */
function tennisSide(c, league) {
  if (!c || isUndrawn(c)) return null;
  const name = c.athlete?.displayName ?? c.roster?.displayName;
  if (!name) return null;
  return {
    id: String(c.id),
    key: `${league.key}/${c.id}`,
    slug: `${league.slug}-${c.id}`,
    name,
    displayName: name,
    abbreviation: c.athlete?.shortName ?? c.roster?.shortDisplayName ?? null,
    logoUrl: c.athlete?.flag?.href ?? c.roster?.athletes?.[0]?.flag?.href ?? null,
    // Sets won, because that is the score a tennis result is quoted in.
    score: (c.linescores ?? []).length ? c.linescores.filter((l) => l.winner).length : null,
    record: null,
  };
}

/**
 * Which tour owns a draw. A combined tournament is returned in full by BOTH tour
 * scoreboards, so each draw is taken by one tour only; mixed doubles names no
 * tour and goes to the ATP so that it lands exactly once.
 */
export const drawBelongsTo = (slug, tour) => {
  if (!slug || (tour !== 'atp' && tour !== 'wta')) return true;
  if (slug.startsWith('womens')) return tour === 'wta';
  return tour === 'atp';
};

function tennisMatches(tournament, league) {
  const out = [];
  const tour = league.leagueKey;
  for (const draw of tournament.groupings ?? []) {
    if (!drawBelongsTo(draw.grouping?.slug, tour)) continue;
    for (const m of draw.competitions ?? []) {
      if (!m?.id || !m.date) continue;
      const competitors = m.competitors ?? [];
      const pick = (which, ord) =>
        competitors.find((x) => x.homeAway === which) ?? competitors.find((x) => x.order === ord);
      const home = tennisSide(pick('home', 1), league);
      const away = tennisSide(pick('away', 2), league);
      if (!home || !away) continue;
      const broadcastNames = broadcastNamesOf(m);
      out.push({
        id: String(m.id),
        key: `${league.key}/${m.id}`,
        ...startOf(m, m),
        state: normaliseState(m),
        statusDetail: m.status?.type?.shortDetail ?? null,
        name: `${away.name} vs ${home.name}`,
        shortName:
          away.abbreviation && home.abbreviation
            ? `${away.abbreviation} vs ${home.abbreviation}`
            : null,
        url: summaryLink(m),
        venue: tournament.name ?? tournament.shortName ?? null,
        venueCity: [m.venue?.fullName, m.venue?.court].filter(Boolean).join(' · ') || null,
        venueRegion: null,
        neutralSite: true,
        broadcast: broadcastNames.join(', ') || null,
        broadcastNames,
        attendance: null,
        period: Number.isFinite(m.status?.period) ? m.status.period : null,
        displayClock: null,
        odds: null,
        home,
        away,
        tournament: false,
      });
    }
  }
  return out;
}

/** The tournament itself, so it exists in a calendar before the draw does. */
function tennisTournament(t, league) {
  if (!t?.id || !t.date) return null;
  return {
    id: String(t.id),
    key: `${league.key}/${t.id}`,
    ...startOf(t, t),
    state: normaliseState(t),
    statusDetail: t.status?.type?.shortDetail ?? null,
    name: t.name ?? t.shortName ?? 'Tournament',
    shortName: t.shortName ?? null,
    url: summaryLink(t),
    venue: t.venue?.displayName ?? null,
    venueCity: null,
    venueRegion: null,
    neutralSite: true,
    broadcast: null,
    broadcastNames: [],
    attendance: null,
    period: null,
    displayClock: null,
    odds: null,
    home: null,
    away: null,
    tournament: true,
  };
}

/** One scoreboard entry -> the fixtures it represents, which is usually itself. */
function normaliseEntry(e, league) {
  if (Array.isArray(e?.groupings) && e.groupings.length > 0) {
    const tournament = tennisTournament(e, league);
    return [...(tournament ? [tournament] : []), ...tennisMatches(e, league)];
  }
  const one = normaliseEvent(e, league);
  return one ? [one] : [];
}

/**
 * A scoreboard response -> the league's real name and its fixtures.
 *
 * The catalogue endpoint only exposes the slug, so without the `leagues[0]` block
 * here a league is called "eng.1" everywhere instead of "English Premier League".
 */
export function parseScoreboard(json, league) {
  const meta = json?.leagues?.[0];
  return {
    league: meta
      ? {
          name: meta.name ?? null,
          abbreviation: meta.abbreviation ?? null,
          logoUrl: meta.logos?.[0]?.href ?? null,
        }
      : null,
    events: (json?.events ?? []).flatMap((e) => normaliseEntry(e, league)),
  };
}

/** "Away at Home", or "Away vs Home" where nobody is at home. */
export function fixtureTitle(f) {
  if (f.home && f.away) {
    const away = f.away.displayName ?? f.away.name;
    const home = f.home.displayName ?? f.home.name;
    return `${away} ${f.neutralSite ? 'vs' : 'at'} ${home}`;
  }
  return f.name;
}

export function fixtureItem(f, league, meta = {}) {
  const sport = league.sport;
  const sides = [f.home, f.away].filter(Boolean);
  return {
    externalId: `${PROVIDER}:fixture:${f.key}`,
    kind: 'fixture',
    title: fixtureTitle(f),
    summary: f.shortName ?? null,
    url: f.url ?? null,
    imageUrl: f.home?.logoUrl ?? meta.logoUrl ?? null,
    publishedAt: f.publishedAt,
    timeKnown: f.timeKnown,
    precision: f.precision,
    tags: [
      'fixture',
      sport,
      `league:${league.slug}`,
      `state:${f.state}`,
      ...sides.map((s) => `team:${s.slug}`),
      f.tournament ? 'tournament' : null,
    ].filter(Boolean),
    data: {
      provider: PROVIDER,
      sport,
      id: f.id,
      key: f.key,
      league: {
        slug: league.slug,
        key: league.key,
        name: meta.name ?? league.name ?? league.leagueKey,
        abbreviation: meta.abbreviation ?? null,
        region: regionFor(league.key, meta.region ?? null),
      },
      name: f.name,
      shortName: f.shortName,
      home: f.home,
      away: f.away,
      state: f.state,
      statusDetail: f.statusDetail,
      period: f.period,
      displayClock: f.displayClock,
      venue: f.venue,
      venueCity: f.venueCity,
      venueRegion: f.venueRegion,
      neutralSite: f.neutralSite,
      attendance: f.attendance,
      broadcast: f.broadcast,
      broadcastSource: f.broadcast ? 'espn' : null,
      broadcastMarkets: f.broadcastNames?.length
        ? [{ country: 'United States', channels: f.broadcastNames }]
        : null,
      odds: f.odds ?? null,
      scoreDetail: null,
      plays_supported: !NO_PLAYS.has(sport) && !f.tournament,
      boxscoreSupported: !NO_BOXSCORE.has(sport) && !f.tournament,
      timeKnown: f.timeKnown,
      tournament: Boolean(f.tournament),
    },
  };
}

/* --------------------------------------------------------------- windows -- */

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;

export const yyyymmdd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
export const utcDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

/**
 * The frequent refresh reaches six hours back, enough to close out whatever was in
 * progress at the last pass, and `hours` forward.
 */
export function nearWindow(now, hours) {
  return {
    from: new Date(now - 6 * HOUR_MS),
    to: new Date(now + Math.max(1, Number(hours) || 72) * HOUR_MS),
  };
}

export function horizonWindow(now, days) {
  return {
    from: new Date(now - 6 * HOUR_MS),
    to: new Date(now + Math.max(1, Number(days) || 30) * DAY_MS),
  };
}

/**
 * Fixtures for one league across a date window.
 *
 * ESPN answers a whole range in a single request. When a response comes back at
 * the cap the window is split and re-fetched, because a truncated response is
 * indistinguishable from a quiet fortnight. A 404 on a date window means nothing
 * is scheduled inside it, which is the normal state of most leagues most of the
 * year; with `fallback` the undated scoreboard answers with the NEXT fixtures
 * instead, so an out-of-season league shows its season opener.
 */
export async function fetchSchedule(client, { league, from, to, fallback = true, depth = 0 }) {
  const base = `${SITE}/${league.key}/scoreboard`;
  let data;
  try {
    data = await client.get(`${base}?dates=${yyyymmdd(from)}-${yyyymmdd(to)}&limit=1000`);
  } catch (err) {
    if (depth > 0 || !fallback) {
      if (err?.status === 404) return { league: null, events: [] };
      throw err;
    }
    data = await client.get(base);
  }
  const parsed = parseScoreboard(data, league);
  const spansMultipleDays = to.getTime() - from.getTime() >= 2 * DAY_MS;
  if ((data?.events ?? []).length >= PAGE_CAP && depth < 4 && spansMultipleDays) {
    const mid = new Date((from.getTime() + to.getTime()) / 2);
    const dayAfterMid = new Date(mid.getTime() + DAY_MS);
    if (mid > from && dayAfterMid <= to) {
      const [a, b] = await Promise.all([
        fetchSchedule(client, { league, from, to: mid, depth: depth + 1 }),
        fetchSchedule(client, { league, from: dayAfterMid, to, depth: depth + 1 }),
      ]);
      const seen = new Set();
      return {
        league: parsed.league ?? a.league ?? b.league,
        events: [...a.events, ...b.events].filter((e) => !seen.has(e.key) && seen.add(e.key)),
      };
    }
  }
  return parsed;
}

/* ----------------------------------------------------------------- cursor -- */

const CATALOGUE_TTL_MS = 24 * HOUR_MS;

/** The parsed league list an adapter keeps in its cursor, refreshed daily. */
export function catalogueFresh(cursor, now = Date.now()) {
  return (
    Array.isArray(cursor?.leagues) &&
    cursor.leagues.length > 0 &&
    Number.isFinite(cursor.leaguesAt) &&
    now - cursor.leaguesAt < CATALOGUE_TTL_MS
  );
}

/** Config `skipSports`, as a list of sport slugs. */
export function skipSportsOf(config) {
  const raw = config?.skipSports;
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
  return list.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
}

/** Config `leagues`, as provider keys: accepts "football/nfl" or "football-nfl". */
export function leagueKeysOf(config, catalogue = []) {
  const raw = config?.leagues;
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
  const bySlug = new Map(catalogue.map((l) => [l.slug, l.key]));
  return list
    .map((s) => String(s).trim().toLowerCase())
    .filter(Boolean)
    .map((s) => (s.includes('/') ? s : (bySlug.get(s) ?? s)));
}

export async function ensureCatalogue(ctx, client, cursor) {
  const skipSports = skipSportsOf(ctx.config);
  if (catalogueFresh(cursor)) {
    return cursor.leagues.filter((l) => !skipSports.includes(l.sport));
  }
  try {
    const leagues = await listLeagues(client, { skipSports });
    if (leagues.length > 0) {
      cursor.leagues = leagues;
      cursor.leaguesAt = Date.now();
      ctx.log(`catalogue: ${leagues.length} leagues`);
      return leagues;
    }
  } catch (err) {
    ctx.log(`catalogue refresh failed: ${err?.message ?? err}`);
  }
  if (Array.isArray(cursor.leagues) && cursor.leagues.length > 0) {
    return cursor.leagues.filter((l) => !skipSports.includes(l.sport));
  }
  throw new Error('ESPN catalogue unavailable and none cached');
}

/** Run `fn` over `items` with `n` in flight, stopping at the deadline. Returns the leftover. */
export async function pool(items, n, deadline, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length && Date.now() < deadline) {
      const item = items[i++];
      await fn(item);
    }
  });
  await Promise.all(workers);
  return items.slice(i);
}

/** How much of the run is left for the fetches: a margin for the write. */
export const DEADLINE_MARGIN_MS = 15_000;

/* ------------------------------------------------------------- catalogue -- */

export const SKIP_SPORTS_FIELD = {
  key: 'skipSports',
  label: 'Skip sports',
  type: 'list',
  help: 'Sports another source covers better. Tennis comes from Live Tennis, under the same league slugs, so it is skipped here by default.',
};

export const espnCatalogue = defineAdapter({
  name: 'espn-catalogue',
  title: 'ESPN: leagues and teams',
  collection: 'sports',
  description:
    'Every league ESPN publishes a scoreboard for, across 17 sports, and every team in each one whether or not it plays this fortnight. A league carries its real name, abbreviation, logo, country where ESPN says (domestic soccer) and a polling priority; a team carries its logo, colours and abbreviation, keyed by league because ESPN team ids collide across leagues. Keyless, but ESPN blocks cloud egress, so set SPORTS_PROXY_URL to a residential proxy on a hosted deployment. Two requests per league, paged across runs.',
  docs: 'https://site.api.espn.com/apis/site/v2/sports',
  kinds: ['league', 'team'],
  cadenceMinutes: 1440,
  configFields: [SKIP_SPORTS_FIELD],
  defaults: { skipSports: ['tennis'] },
  defaultSources: [{ slug: 'espn-catalogue', name: 'Sports: ESPN leagues and teams' }],
  async pull(ctx) {
    const { cursor: prev, env, http, log, budget, deadline } = ctx;
    const client = makeEspnClient({ env, http, log });
    const cursor = { ...prev };
    const now = Date.now();

    let idx = Number.isInteger(cursor.idx) ? cursor.idx : 0;
    if (idx === 0 || !catalogueFresh(cursor)) {
      cursor.leaguesAt = 0;
      idx = 0;
      cursor.abbrNext = {};
    }
    const leagues = await ensureCatalogue(ctx, client, cursor);
    const ambiguous = ambiguousAbbreviations(cursor.abbr ?? {});
    const abbrNext = { ...(cursor.abbrNext ?? {}) };

    const items = [];
    let spent = 0;
    let teams = 0;
    const perLeague = 2;
    const stopAt = deadline - DEADLINE_MARGIN_MS;
    while (idx < leagues.length && spent + perLeague <= budget && Date.now() < stopAt) {
      const league = leagues[idx];
      const [detailRes, teamsRes] = await Promise.allSettled([
        client.get(`${CORE}/sports/${league.sport}/leagues/${league.leagueKey}`),
        // Without an explicit limit the teams endpoint returns only the first 50.
        client.get(`${SITE}/${league.key}/teams?limit=1000`),
      ]);
      spent += perLeague;
      const detail = detailRes.status === 'fulfilled' ? parseLeagueDetail(detailRes.value) : null;
      const teamsJson = teamsRes.status === 'fulfilled' ? teamsRes.value : null;
      const roster = parseTeams(league, teamsJson);
      const fromTeams = leagueNameFromTeams(teamsJson);
      const meta = {
        name: detail?.name ?? fromTeams?.name ?? null,
        abbreviation: detail?.abbreviation ?? fromTeams?.abbreviation ?? null,
        logoUrl: detail?.logoUrl ?? null,
        region: detail?.region ?? null,
      };
      abbrNext[league.key] = meta.abbreviation;
      items.push(leagueItem(league, meta, { ambiguous, teams: roster.length }));
      for (const t of roster) items.push(teamItem(league, t));
      teams += roster.length;
      idx += 1;
    }

    const done = idx >= leagues.length;
    const next = {
      leagues: cursor.leagues,
      leaguesAt: cursor.leaguesAt,
      idx: done ? 0 : idx,
      abbr: done ? abbrNext : (cursor.abbr ?? {}),
      abbrNext: done ? {} : abbrNext,
      sweptDay: done ? utcDay(now) : (cursor.sweptDay ?? null),
    };
    const progressed = idx - (Number.isInteger(prev.idx) ? prev.idx : 0);
    return {
      items,
      cursor: next,
      nextInMinutes: done ? undefined : 1,
      note: `${progressed} leagues (${teams} teams) from ${spent} requests; ${done ? 'catalogue complete' : `at ${idx}/${leagues.length}, continuing`}`,
    };
  },
});

/* -------------------------------------------------------------- schedule -- */

/**
 * Which leagues have a fixture inside the near window, from what the last passes
 * learned. `upcoming[key]` is the earliest fixture at or after six hours ago the
 * last fetch saw (null when it saw none); a league never fetched is included so
 * it gets looked at once.
 */
export function leaguesInWindow(leagues, upcoming, now, hours) {
  const { to } = nearWindow(now, hours);
  return leagues.filter((l) => {
    if (!(l.key in (upcoming ?? {}))) return true;
    const iso = upcoming[l.key];
    if (!iso) return false;
    const t = Date.parse(iso);
    return Number.isFinite(t) && t <= to.getTime();
  });
}

/** The earliest start at or after six hours ago, for the cursor. */
export function earliestUpcoming(events, now) {
  const floor = now - 6 * HOUR_MS;
  let best = null;
  for (const e of events) {
    const t = e.publishedAt?.getTime?.();
    if (!Number.isFinite(t) || t < floor) continue;
    if (best === null || t < best) best = t;
  }
  return best === null ? null : new Date(best).toISOString();
}

export const espnSchedule = defineAdapter({
  name: 'espn-schedule',
  title: 'ESPN: fixtures',
  collection: 'sports',
  description:
    'Fixtures from every ESPN scoreboard: kick-off, both sides with logos and season records, venue, broadcaster, the closing line where a book prices the game, and the state and score as of the pass. Every run refreshes the leagues with a game inside the near window; once a day it sweeps the whole catalogue out to the horizon, continuing across runs when one is not enough. Keyless, but ESPN blocks cloud egress, so set SPORTS_PROXY_URL to a residential proxy on a hosted deployment.',
  docs: 'https://site.api.espn.com/apis/site/v2/sports',
  kinds: ['fixture'],
  cadenceMinutes: 180,
  configFields: [
    {
      key: 'nearWindowHours',
      label: 'Near window (hours)',
      type: 'number',
      placeholder: '72',
      help: 'How far ahead the every-run refresh reaches. Only leagues with a fixture inside it are asked.',
    },
    {
      key: 'horizonDays',
      label: 'Horizon (days)',
      type: 'number',
      placeholder: '30',
      help: 'How far ahead the daily full sweep keeps the calendar populated.',
    },
    SKIP_SPORTS_FIELD,
  ],
  defaults: { nearWindowHours: 72, horizonDays: 30, skipSports: ['tennis'] },
  defaultSources: [
    {
      slug: 'espn-schedule',
      name: 'Sports: ESPN fixtures',
      config: { nearWindowHours: 72, horizonDays: 30 },
    },
  ],
  async pull(ctx) {
    const { config, cursor: prev, env, http, log, deadline } = ctx;
    const client = makeEspnClient({ env, http, log });
    const cursor = { ...prev };
    const now = Date.now();
    const leagues = await ensureCatalogue(ctx, client, cursor);
    const byKey = new Map(leagues.map((l) => [l.key, l]));
    const upcoming = { ...(cursor.upcoming ?? {}) };
    const regions = { ...(cursor.regions ?? {}) };
    const today = utcDay(now);

    let mode = cursor.mode;
    let queue = Array.isArray(cursor.queue) ? cursor.queue.filter((k) => byKey.has(k)) : [];
    if (queue.length === 0) {
      if (cursor.fullDay !== today) {
        mode = 'full';
        queue = leagues.map((l) => l.key);
      } else {
        mode = 'near';
        queue = leaguesInWindow(leagues, upcoming, now, config.nearWindowHours).map((l) => l.key);
      }
    }
    const window =
      mode === 'full'
        ? horizonWindow(now, config.horizonDays)
        : nearWindow(now, config.nearWindowHours);

    const items = [];
    let failed = 0;
    let done = 0;
    const stopAt = deadline - DEADLINE_MARGIN_MS;
    const leftover = await pool(queue, 4, stopAt, async (key) => {
      const league = byKey.get(key);
      try {
        // The country lives only on the core league endpoint, and only for
        // domestic soccer. Fetched once per league and kept in the cursor.
        if (league.sport === 'soccer' && !(key in regions)) {
          regions[key] = await client
            .get(`${CORE}/sports/${league.sport}/leagues/${league.leagueKey}`)
            .then((j) => parseLeagueDetail(j)?.region ?? null)
            .catch(() => null);
        }
        const { league: meta, events } = await fetchSchedule(client, {
          league,
          from: window.from,
          to: window.to,
          fallback: mode === 'full',
        });
        const metaWithRegion = { ...(meta ?? {}), region: regions[key] ?? null };
        for (const f of events) items.push(fixtureItem(f, league, metaWithRegion));
        upcoming[key] = earliestUpcoming(events, now);
        done += 1;
      } catch (err) {
        failed += 1;
        if (failed <= 5) log(`${key} failed: ${err?.message ?? err}`);
      }
    });

    const finished = leftover.length === 0;
    const next = {
      leagues: cursor.leagues,
      leaguesAt: cursor.leaguesAt,
      upcoming,
      regions,
      mode: finished ? null : mode,
      queue: finished ? [] : leftover,
      fullDay: finished && mode === 'full' ? today : (cursor.fullDay ?? null),
    };
    return {
      items,
      cursor: next,
      nextInMinutes: finished ? undefined : 1,
      note: `${mode}: ${items.length} fixtures from ${done} leagues, ${failed} failed${finished ? '' : `, ${leftover.length} left for the next run`}`,
    };
  },
});

/* ------------------------------------------------------------------ live -- */

/** How far ahead of kick-off a league joins the watch list. */
export const WATCH_LEAD_MS = 2 * HOUR_MS;

/** How long a league stays watched after the last fixture worth watching. */
export const WATCH_GRACE_MS = 15 * 60_000;

/**
 * Whether a fixture is worth emitting from the live tick: on now, about to start,
 * or finished recently enough that its final may not have been written yet.
 */
export function liveWorthy(f, now) {
  const t = f.publishedAt?.getTime?.();
  if (!Number.isFinite(t)) return false;
  if (f.state === 'in') return true;
  if (f.state === 'pre') return t >= now - 30 * 60_000 && t <= now + WATCH_LEAD_MS;
  return t >= now - 12 * HOUR_MS;
}

/** Whether a league should stay on the watch list: something on, or starting soon. */
export function keepsWatch(events, now) {
  return events.some(
    (f) =>
      f.state === 'in' ||
      (f.state === 'pre' &&
        Number.isFinite(f.publishedAt?.getTime?.()) &&
        f.publishedAt.getTime() <= now + WATCH_LEAD_MS),
  );
}

/**
 * The leagues this tick asks, in order: the watch list, then a rolling slice of
 * the catalogue so a league with a game in two hours is found before it starts.
 * At `probe` leagues a minute the whole catalogue is covered inside the lead time.
 */
export function liveTargets({ leagues, watch, scanIdx, probe, pinned = [] }) {
  const keys = new Set();
  const out = [];
  const add = (k) => {
    if (k && !keys.has(k)) {
      keys.add(k);
      out.push(k);
    }
  };
  for (const k of pinned) add(k);
  if (pinned.length > 0) return { targets: out, scanIdx: Number.isInteger(scanIdx) ? scanIdx : 0 };
  for (const k of Object.keys(watch ?? {})) add(k);
  const n = leagues.length;
  let i = Number.isInteger(scanIdx) ? scanIdx % Math.max(n, 1) : 0;
  for (let c = 0; c < Math.min(probe, n); c++) {
    add(leagues[i].key);
    i = (i + 1) % n;
  }
  return { targets: out, scanIdx: i };
}

export const espnLive = defineAdapter({
  name: 'espn-live',
  title: 'ESPN: live scores',
  collection: 'sports',
  description:
    'Scores, clock, period and state for the games being played right now, from the ESPN scoreboards of every league with a game on or starting within two hours. Which leagues those are is learned by the source itself: a rolling probe of the catalogue finds each league before its next kick-off, and a league stays on the watch list until its games are over. Pin a list of leagues to poll only those. Keyless, but ESPN blocks cloud egress, so set SPORTS_PROXY_URL to a residential proxy on a hosted deployment; every scoreboard is a few hundred kilobytes through it.',
  docs: 'https://site.api.espn.com/apis/site/v2/sports',
  kinds: ['fixture'],
  cadenceMinutes: 1,
  configFields: [
    {
      key: 'leagues',
      label: 'Leagues',
      type: 'list',
      placeholder: 'football/nfl, basketball/nba',
      help: 'ESPN league keys or slugs. Empty means every league the probe finds a game in.',
    },
    {
      key: 'probePerRun',
      label: 'Leagues probed per run',
      type: 'number',
      placeholder: '4',
      help: 'How many leagues each run checks for an upcoming game, round robin. 4 covers the catalogue every 90 minutes, inside the two-hour lead, and keeps a metered proxy affordable.',
    },
    SKIP_SPORTS_FIELD,
  ],
  defaults: { leagues: [], probePerRun: 4, skipSports: ['tennis'] },
  defaultSources: [{ slug: 'espn-live', name: 'Sports: ESPN live scores' }],
  async pull(ctx) {
    const { config, cursor: prev, env, http, log, deadline } = ctx;
    const client = makeEspnClient({ env, http, log });
    const cursor = { ...prev };
    const now = Date.now();
    const leagues = await ensureCatalogue(ctx, client, cursor);
    const byKey = new Map(leagues.map((l) => [l.key, l]));
    const watch = { ...(cursor.watch ?? {}) };
    for (const [k, seen] of Object.entries(watch)) {
      if (!byKey.has(k) || now - Date.parse(seen) > WATCH_GRACE_MS) delete watch[k];
    }
    const pinned = leagueKeysOf(config, leagues).filter((k) => byKey.has(k));
    const { targets, scanIdx } = liveTargets({
      leagues,
      watch,
      scanIdx: cursor.scanIdx,
      probe: Math.min(Math.max(Number(config.probePerRun) || 4, 1), 60),
      pinned,
    });

    const items = [];
    let failed = 0;
    let live = 0;
    const from = new Date(now - 12 * HOUR_MS);
    const to = new Date(now + 12 * HOUR_MS);
    const stopAt = deadline - DEADLINE_MARGIN_MS;
    await pool(targets, 6, stopAt, async (key) => {
      const league = byKey.get(key);
      try {
        const { league: meta, events } = await fetchSchedule(client, {
          league,
          from,
          to,
          fallback: false,
        });
        if (keepsWatch(events, now)) watch[key] = new Date(now).toISOString();
        else delete watch[key];
        for (const f of events) {
          if (!liveWorthy(f, now)) continue;
          if (f.state === 'in') live += 1;
          items.push(fixtureItem(f, league, meta ?? {}));
        }
      } catch (err) {
        failed += 1;
        if (failed === 1) log(`first failure: ${key}: ${err?.message ?? err}`);
      }
    });

    return {
      items,
      cursor: {
        leagues: cursor.leagues,
        leaguesAt: cursor.leaguesAt,
        watch,
        scanIdx,
      },
      note: `${Object.keys(watch).length} league(s) watched, ${live} in play, ${items.length} fixtures, ${failed} failed`,
    };
  },
});
