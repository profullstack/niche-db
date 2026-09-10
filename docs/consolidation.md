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
scores within its 100/day budget).

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
  popularity, backdropUrl, tagline, trailerUrl, runtimeMin, watch:[service] }
```
Release `data`:
```
{ provider, category, type, titleExternalId, titleName, season, number,
  venue, venueRegion, runtimeMin }
```
`imageUrl` is the poster (title) or the episode/backdrop image (release).

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

`GET /api/v1/match?collection=&q=&kind=&limit=` answers the enrichment question:
the best items for a name, by trigram similarity on `title`, each with a `score`.
This is what nixamp asks with a file name or a playlist entry's name.
