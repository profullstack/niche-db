# Geographic queries and scanner context

Location filtering is shared by collections, item search, matches, upcoming
items and saved feeds. It is opt-in: requests without geographic parameters
retain their existing results and ordering.

```http
GET /api/v1/items?collection=crime&lat=41.88&long=-87.62&radius=10&unit=km
GET /api/v1/items?lat=41.88&long=-87.62&sort=distance&limit=50&offset=50
GET /api/v1/search?q=flood&lat=41.88&long=-87.62&radius=100
GET /api/v1/items?bbox=-88,41,-87,42
GET /api/v1/feeds/my-local-feed/items?lat=41.88&long=-87.62&radius=2
GET /crimes?lat=41.88&long=-87.62
GET /scanners?lat=41.88&long=-87.62
```

`/crimes` redirects to the existing `/c/crime` collection. `/scanners`
redirects there with `kind=scanner-stream`. Both preserve GPS parameters.
All `/c/:slug` pages and `/f/:slug` pages, RSS and JSON feeds support the same
filters. Page caches and pagination links include the location parameters.

| Parameter | Contract |
| --- | --- |
| `lat`, `long` | Both required together. Finite decimal numbers, latitude −90…90 and longitude −180…180. Zero is valid. |
| `radius` | Default 10 in the selected unit; positive, at least 0.001 units, at most 1000 km equivalent. |
| `unit` | `km` (default) or `mi`. One mile is 1609.344 metres. |
| `bbox` | `west,south,east,north`. Alternative to a center/radius; west greater than east crosses the antimeridian. |
| `sort=distance` | Requires a center. Nearest first regardless of `order`, with existing tie-breakers. |
| `offset` | For distance-sorted item and feed pages, default 0, capped at 10000. Do not combine distance sorting with `before`/`after`. |

Invalid combinations return HTTP 400 (MCP reports a tool error). Records with
unknown or invalid locations are excluded from geographic reads. Text-only
city/state metadata is preserved, but is not guessed into coordinates. The API
includes `distance_m` for radius queries; it is absent for unfiltered/bbox reads.
Distances are to a point or to the nearest coverage boundary (zero inside).

Filtering happens in PostgreSQL **before** result limits. A GiST expression
index on a geographic bounding box narrows radius candidates; a spherical
point/circle distance then applies the radius. Polygon containment honours
holes and supports local polygons crossing the antimeridian. Polygon edge
distances are approximate: longitude/latitude segments are subdivided at
0.1-degree intervals and projected locally before measuring spherical distance.
These are geographic discovery distances, not surveyed distances. Use local
jurisdiction polygons rather than polygons enclosing a pole or most of Earth.

For coverage shapes, `bbox` means **bounding-envelope overlap**, not exact
polygon intersection. This deliberately includes candidates whose polygon has
a hole or concavity within the viewport. Antimeridian-crossing coverage envelopes
are widened to all longitudes; radius queries refine them with distance.

## Supported stored metadata

No re-ingestion is needed. The database recognizes coordinate pairs in
`data.location`, `data.place`, `data.position`, or `data` itself:

- `lat` or `latitude` paired with `long`, `lon`, `lng` or `longitude`.
- GeoJSON `Point`, `Polygon`, or `MultiPolygon` in those objects or `data.geometry`.
- Explicit `data.coverage`, which takes precedence over every point, including
  receiver coordinates. Malformed explicit coverage never falls back to a point.

GeoJSON coordinates use **[longitude, latitude]**. Approximate circular coverage
uses this extension:

```json
{"type":"Circle","coordinates":[-87.62,41.88],"radius_m":15000}
```

The original payload remains intact, including upstream source, timestamps,
anonymisation notes and precision. Coordinates published as strings are accepted;
empty strings, nulls, nonnumeric values and out-of-range coordinates are unknown.
Adapter-specific sentinels (for example Seattle's −1/−1) remain the adapter's
responsibility because those can be legitimate coordinates elsewhere.

## Saved feeds, CLI and MCP

Create a geographic feed by supplying `lat`, `long`, `radius`, `unit`, `bbox`
and optional `sort` alongside existing filters in a feed's `query` (or the
existing flat API body). URL geographic filters **intersect** the saved scope;
they do not replace it. Delivery scanning always walks ascending item IDs,
even when the displayed feed is distance-sorted, so notifications cannot skip
rows by advancing a cursor in distance order. Web editing preserves the saved
geographic fields.

```sh
nichedb recent --collection crime --lat 41.88 --long -87.62 --radius 10 --sort distance --json
nichedb search theft --lat 41.88 --long -87.62 --radius 5 --json
nichedb feed create --collection crime --name 'Local reports' --lat 41.88 --long -87.62 --radius 5
```

The `items`, `recent`, `search`, `match`, and `upcoming` CLI commands forward
geographic flags. The corresponding MCP tools expose the same fields;
`create_feed` also saves them. Offset pagination is for a live view and is not
a snapshot: concurrent arrivals or location changes can shift pages. Use the
existing ID/update cursors for synchronization with the default ordering.

## Permissioned scanner catalogs

Add a `scanner-directory` source in the `crime` collection with `config.url`
pointing to a JSON catalog you have permission to index. There is no automatic
Broadcastify/OpenMHz scrape, API subscription or background audio download.
The catalog can be an array or `{ "feeds": [...] }`, at most 10000 entries.
Each row needs `id`, `name`, `provider`, `access_terms`, and `player_url`.

```json
{
  "feeds": [{
    "id": "community-dispatch",
    "name": "Community dispatch",
    "provider": "Example volunteer operator",
    "agency": "Example public safety dispatch",
    "jurisdiction": "Example county",
    "service_type": "public-safety",
    "player_url": "https://scanner.example.org/listen",
    "access_terms": "Operator permission to index player and coverage metadata",
    "stream_reuse_allowed": false,
    "coverage": {
      "type": "Circle",
      "coordinates": [-87.62, 41.88],
      "radius_m": 15000
    },
    "coverage_basis": "approximate-radius",
    "location_precision": "approximate service area",
    "location_source": "operator",
    "updated_at": "2026-09-13T00:00:00Z",
    "last_checked": "2026-09-13T00:00:00Z"
  }]
}
```

`stream_url` is retained only if the operator explicitly declares
`stream_reuse_allowed: true`; this declaration must reflect actual permission.
Otherwise only the player link is published. An authorized stream has a
user-operated HTML audio player with `preload="none"`. `last_checked` is the
catalog's observation, not a fabricated claim that NicheDB tested the audio.
Invalid/absent coverage stays unknown. Polygon rings must close, and an entry
may contain at most 2000 polygon vertices. Coverage/metadata source fields
remain separate from the scanner's audio provider.

## Crime context

```http
GET /api/v1/items/123/nearby-crime?from=2026-08-01&to=2026-09-01
GET /api/v1/items/123/nearby-crime?lat=41.88&long=-87.62&radius=2
```

The item must be a `scanner-stream`. This returns recent `crime-report` items
whose points fall inside its coverage, optionally intersected with a GPS search
and a half-open `published_at` window (`from` inclusive, `to` exclusive).
State-level `crime-estimate` rows are not individual incidents and are excluded.
Unknown coverage returns an empty list. A polygon's holes are excluded.
Restricted early-access crime collections are excluded from this context.
The response carries `relationship: "within-coverage"`, coverage basis,
source-linked items, timestamps and original location-precision metadata.
Scanner item pages show this context with date filters.

This is a spatial association, not a link between an incident and a radio call.
Historical/month-precision reports retain their original dates; the enrichment
does not label them live. Empty results can mean unknown coverage, absent source
data or a date window with no indexed reports, not absence of crime.

## Deployment and verification

Migration `0023_geographic_queries.sql` uses standard PostgreSQL functions and
GiST, with no PostGIS extension or container change. The expression index is
built over existing items in the migration transaction. On a large production
table, schedule its initial build for a maintenance window: normal `CREATE INDEX`
blocks writes while building. Measure its duration on a production-sized copy.
Malformed coordinate fields cannot abort the migration or later ingestion.

Tests execute the actual query functions against PGlite/PostgreSQL, including
migration application, index eligibility, mixed collections, radius boundaries,
unit conversion, antimeridian/polar points, polygon holes, saved-feed intersection,
notification cursor order, pagination and scanner context.
