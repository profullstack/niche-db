import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

/**
 * Public transit: the cities, and how to read GTFS-realtime.
 *
 * Shared by the adapters (which store each city's lines, stations, timetable
 * summaries and service alerts) and the web app (which reads vehicles and
 * arrivals live, at page time, because a position is stale in seconds).
 *
 * Every feed here is keyless. The cities that need a key for live data
 * (Chicago's Train Tracker, WMATA, LA Metro, Bay Area 511, Paris IDFM) are
 * either schedule-only or not here yet.
 */

const MTA = 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds';

export const CITIES = {
  nyc: {
    tz: 'America/New_York',
    name: 'New York City',
    system: 'NYC Subway (MTA)',
    center: [40.73, -73.94],
    zoom: 11,
    kind: 'gtfs',
    gtfs: 'https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip',
    routeTypes: [1, 2],
    tripFeeds: [
      'gtfs',
      'gtfs-ace',
      'gtfs-bdfm',
      'gtfs-g',
      'gtfs-jz',
      'gtfs-nqrw',
      'gtfs-l',
      'gtfs-si',
    ].map((f) => `${MTA}/nyct%2F${f}`),
    // The subway feed carries vehicles inside the trip feeds, at a stop, without coordinates.
    vehiclesFromTrips: true,
    alerts: `${MTA}/camsys%2Fsubway-alerts`,
    agencyUrl: 'https://new.mta.info/',
  },
  boston: {
    tz: 'America/New_York',
    name: 'Boston',
    system: 'MBTA subway, commuter rail, trolley and ferry',
    center: [42.355, -71.07],
    zoom: 11,
    kind: 'gtfs',
    gtfs: 'https://cdn.mbta.com/MBTA_GTFS.zip',
    routeTypes: [0, 1, 2, 4],
    vehicles: 'https://cdn.mbta.com/realtime/VehiclePositions.pb',
    tripFeeds: ['https://cdn.mbta.com/realtime/TripUpdates.pb'],
    alerts: 'https://cdn.mbta.com/realtime/Alerts.pb',
    agencyUrl: 'https://www.mbta.com/',
  },
  'bay-area': {
    tz: 'America/Los_Angeles',
    name: 'San Francisco Bay Area',
    system: 'BART',
    center: [37.77, -122.27],
    zoom: 10,
    kind: 'gtfs',
    gtfs: 'https://www.bart.gov/dev/schedules/google_transit.zip',
    routeTypes: [1],
    tripFeeds: ['https://api.bart.gov/gtfsrt/tripupdate.aspx'],
    // BART's trip updates carry no route id: the line rows keep their trip ids.
    tripMap: true,
    alerts: 'https://api.bart.gov/gtfsrt/alerts.aspx',
    agencyUrl: 'https://www.bart.gov/',
  },
  chicago: {
    tz: 'America/Chicago',
    name: 'Chicago',
    system: "CTA 'L' (schedules; live tracking needs a CTA key)",
    center: [41.88, -87.68],
    zoom: 11,
    kind: 'gtfs',
    gtfs: 'https://www.transitchicago.com/downloads/sch_data/google_transit.zip',
    routeTypes: [1],
    agencyUrl: 'https://www.transitchicago.com/',
  },
  london: {
    tz: 'Europe/London',
    name: 'London',
    system: 'Underground, DLR, Overground, Elizabeth line and trams (TfL)',
    center: [51.51, -0.12],
    zoom: 11,
    kind: 'tfl',
    modes: ['tube', 'dlr', 'overground', 'elizabeth-line', 'tram'],
    agencyUrl: 'https://tfl.gov.uk/',
  },
  toronto: {
    tz: 'America/Toronto',
    name: 'Toronto',
    system: 'TTC streetcars and buses (live positions)',
    center: [43.7, -79.4],
    zoom: 11,
    kind: 'umoiq',
    agency: 'ttc',
    agencyUrl: 'https://www.ttc.ca/',
  },
  philadelphia: {
    tz: 'America/New_York',
    name: 'Philadelphia',
    system: 'SEPTA buses, trolleys and Regional Rail (live positions)',
    center: [39.97, -75.16],
    zoom: 11,
    kind: 'septa',
    agencyUrl: 'https://www.septa.org/',
  },
};

export const ROUTE_TYPE = {
  0: 'tram',
  1: 'subway',
  2: 'rail',
  3: 'bus',
  4: 'ferry',
  5: 'cable tram',
  6: 'aerial lift',
  7: 'funicular',
  11: 'trolleybus',
  12: 'monorail',
};

const { FeedMessage } = GtfsRealtimeBindings.transit_realtime;

/** Decode a GTFS-realtime protobuf body to plain objects (longs as numbers, enums as names). */
export function decodeFeed(bytes) {
  return FeedMessage.toObject(FeedMessage.decode(bytes), {
    longs: Number,
    enums: String,
    defaults: false,
  });
}

/** The English text of a GTFS-realtime TranslatedString. */
export function translated(ts) {
  const list = ts?.translation ?? [];
  const en = list.find((t) => !t.language || /^en/i.test(t.language)) ?? list[0];
  return en?.text?.trim() || null;
}

/** "Mon 06:12" style seconds-after-midnight (GTFS times run past 24:00). */
export function hhmm(secs) {
  if (!Number.isFinite(secs)) return null;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return `${String(h % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}${h >= 24 ? ' (+1)' : ''}`;
}
