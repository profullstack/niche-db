# Consolidation: sports, screen and channels move into nichedb

nichedb becomes the one place that fetches and keeps the aggregated data that
tipoffwatch.com, genrewatch.com, watchnews.now, bittorrented.com and nixamp all
need. The sites stop polling ESPN, TMDB, TVmaze, AniList, IMDb and iptv-org
themselves and read nichedb instead; nixamp enriches what it plays from the same
collections.

This document is the contract the adapters and the API are built to. Three
collections, each with fixed item kinds, tags and `data` shapes, so that a site
or a player can be written against the shape without reading the adapter.

## Conventions

- `externalId` is `<provider>:<kind>:<upstream id>`; it is the dedupe key per source.
- `publishedAt` is *when the thing happens* (a fixture's tip-off, a release date,
  an episode's air time), with `timeKnown` and `precision` honest about what the
  upstream said. For a title it is the first release.
- `tags` are lower-case slugs. Every item carries its kind as a tag and the
  collection-specific facets listed below, so `?tags=` can answer the site's
  page queries without touching `data`.
- `data` holds the full record. Nothing in `data` is queried server-side.
- Keys never leave nichedb: an item's `url` is the public page upstream, never an
  API URL with a key in it.

## `sports` (from tipoffwatch's ESPN, Live Tennis and TheSportsDB providers)

Kinds: `league`, `team`, `fixture`.

| kind | externalId | title | publishedAt | tags | data |
|---|---|---|---|---|---|
| league | `espn:league:<sport>:<slug>` | league name | null | `league`, `<sport>`, `region:<region>` | `{provider, sport, slug, abbreviation, logoUrl, region, priority, key}` |
| team | `espn:team:<id>` | team name | null | `team`, `<sport>`, `league:<slug>`… | `{provider, sport, abbreviation, shortName, location, logoUrl, color, leagues:[slug]}` |
| fixture | `espn:fixture:<id>` (tennis: `livetennis:fixture:<id>`) | "Away at Home" | starts_at | `fixture`, `<sport>`, `league:<slug>`, `state:pre|in|post`, `team:<slug>`×2 | see below |

Fixture `data`:
```
{ provider, sport, league: {slug, name, abbreviation, region},
  home: {id, name, abbreviation, logoUrl, score, record}, away: {…},
  state: 'pre'|'in'|'post', statusDetail, period, displayClock,
  venue, venueCity, venueRegion, neutralSite, attendance,
  broadcast, broadcastMarkets, odds, scoreDetail, plays_supported }
```
`imageUrl` is the league or home-team logo. `summary` is the short name.

Sources: `espn-catalogue` (leagues + teams, daily), `espn-schedule` (fixtures in
the near window, every 3 h; the whole horizon daily by config), `espn-live`
(leagues with a game on, every minute), `livetennis` (tennis fixtures and live
scores within its 100/day budget), `espn-plays` (below).

### Play-by-play and recaps

Kind `plays`, one item per fixture that is in play or ended in the last six
hours, from `espn-plays` (every 2 minutes, at most `summariesPerRun` = 8
summaries a run, which is tipoffwatch's own line).

| kind | externalId | title | publishedAt | tags |
|---|---|---|---|---|
| plays | `espn:plays:<league key>/<event id>` | Away at Home | kickoff | `plays`, `<sport>`, `league:<slug>`, `state:in|post`, `fixture:<fixture externalId>` |

```
{ provider, sport, fixtureExternalId, fixtureKey, eventId,
  league:{slug,key,name,abbreviation,region}, home/away:{id,name,score},
  state, statusDetail, playsSupported, boxscoreSupported,
  plays:[{ id, sequence, text, period, periodLabel, clock, homeScore, awayScore,
           scoring, type, team:'home'|'away'|null, teamId }],
  playsTotal, playsTruncated, recap, final, fetchedAt }
```
While a game is on `plays` is the last 400 (`playsTruncated` says so) and
`recap` is null; once final the whole log is there and `recap` carries the
linescores, team stats, leaders, officials, duration, attendance, article
and closing odds. A mirror inserts plays on `(event, play id)` and never
deletes, since a live item is the tail of the log.

### TV listings

Kind `broadcast`, one item per (event, channel, market) from TheSportsDB's
day listings (`sportsdb-tv`, every 3 h, 14 days ahead; one request a day on a
paid key, one per sport and day on the shared key). ESPN's own broadcast field
is US-only, so this is where "7 Queensland" for an AFL game comes from.

| kind | externalId | title | publishedAt | tags |
|---|---|---|---|---|
| broadcast | `sportsdb:tv:<eventId>:<channel>:<country>:<date>` | Home vs Away on Channel | listing time | `broadcast`, `<sport>`, `date:YYYY-MM-DD`, `country:<slug>`, `channel:<slug>` |

```
{ provider:'thesportsdb', sport, sportName, league, home, away, event, channel,
  channelId, country, logo, starts_at, timeKnown, date, eventId, listingId }
```
A mirror matches `home`/`away` against its own fixtures by team name, in both
orders and on the day before as well, since the two providers disagree about
which calendar day a late kickoff belongs to.

## `screen` (from genrewatch's TMDB, TVmaze, AniList and IMDb providers)

Kinds: `title`, `release`.

| kind | externalId | title | publishedAt | tags | data |
|---|---|---|---|---|---|
| title | `tmdb:title:<id>`, `tvmaze:title:<id>`, `anilist:title:<id>`, `imdb:title:<tconst>` | title | first release (precision year or day) | `title`, `<category>` (film/tv/anime), `genre:<slug>`… | see below |
| release | `tmdb:release:<id>`, `tmdb:digital:<id>`, `tmdb:stream:<id>:<service>`, `tvmaze:episode:<id>`, `anilist:airing:<id>:<ep>` | episode or film name | starts_at | `release`, `<category>`, `genre:<slug>`…, `type:theatrical|digital|stream|episode|airing` | see below |

Title `data`:
```
{ provider, category, form: 'movie'|'series', year, normTitle,
  imdbId, tmdbId, tvmazeId, anilistId, genres:[name], rating, ratingCount,
  popularity, backdropUrl, tagline, trailerUrl, runtimeMin, watch:[service],
  providers: { stream:[name], rent:[name], buy:[name] } }
```
`watch` is the flat-rate services (at most six); `providers` is the same region's
subscription, rent and buy lists apart (at most eight each), so "included where
I subscribe" and "available to rent" stay two questions.

Release `data`:
```
{ provider, category, type, titleExternalId, titleName, season, number,
  venue, venueRegion, services:[name], runtimeMin }
```
`services` names the shops on a `Rent or buy` row and the one service on a
stream row. A digital row exists only when TMDB has a type-4 date (a shop
carrying the film is not a date).

`imageUrl` is the poster (title) or the episode/backdrop image (release).

The `tmdb-artwork` enricher (default-on for `screen`, needs `TMDB_API_KEY`) asks
TMDB `find/{imdbId}` for every IMDb-only title and backfills the poster and
synopsis onto the item, storing the TMDB id, backdrop, popularity, rating and
release day under `enrichment['tmdb-artwork']`; a miss is stored as
`{ tmdbId: null }` so the title is never asked again.

Sources: `tmdb-releases` (forward calendar + home releases, 12 h), `tvmaze-schedule`
(3 h), `anilist-airing` (6 h), `imdb-ratings` (daily dumps, cursor-paginated so a
run stays inside its deadline).

## `channels` (generalising the news-channels source to the whole iptv-org directory)

Kind: `channel`. Every channel that is not closed, streamable or not, because a
player matching a playlist entry by name wants the logo, country and category
whether or not iptv-org has a public stream for it.

`externalId` `iptv-org:channel:<id>`, `title` name, `imageUrl` logo, `url` website,
tags `channel`, `<category>`…, `country:<cc>`, `lang:<code>`…, `network:<slug>`,
`streamable` when a public stream exists. `data`:
```
{ channelId, country, subdivision, city, network, owners, categories, languages,
  altNames, launched, closed, isNsfw, website, logo, streamUrl, quality, streams:[≤8] }
```

## API additions (apps/web)

`GET /api/v1/items` gains `tags=` (comma list, all must match), `from=`/`to=`
(ISO, on `published_at`), `since=` (ISO, on `updated_at`, for a site mirroring
the collection), `sort=id|published|updated` and `order=asc|desc`.

`GET /api/v1/match?collection=&q=&kind=&date=&limit=` answers the enrichment question:
the best items for a name, by trigram similarity on `title`, each with a `score`.
This is what nixamp asks with a file name or a playlist entry's name.

A matchup name ("NFL: Chiefs vs Bills", "Lakers @ Celtics", "Arsenal v Chelsea",
"Rangers at Celtic 19:45") parses as kind `fixture` with `teams: [A, B]` and
`league` (the label in front, or null), and is answered by team rather than by
title: every fixture kicking off between 36 hours ago and 7 days ahead (or on
`date=YYYY-MM-DD` plus a day either side) whose title or abbreviation is near
either side is scored by whether each side equals, whole-word-contains or is
contained by `data.home`/`data.away`'s `displayName`, `name` or `abbreviation`
(case and diacritics folded, "Man Utd" spelled out to "Manchester United"), in
both orders. Both sides matched scores 1.0 less a little per day between kickoff
and now (a game in play is 0 away, so it beats next week's rematch), plus a
little when `league` agrees with the fixture's `league:` tag or
`data.league.abbreviation`; one side matched scores 0.45, under the 0.5 floor a
player applies. When no fixture answers and `kind=fixture` was not asked for,
the plain match runs on the name as a channel.
