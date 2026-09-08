import { describe, expect, test } from 'bun:test';
import { toItem as eonetItem, latestGeometry, pointOf } from '../packages/adapters/src/eonet.js';
import { ADAPTERS, adapterByName } from '../packages/adapters/src/index.js';
import { categoryOf, knotsToMph, toItem as nhcItem } from '../packages/adapters/src/nhc.js';
import {
  noticeOf,
  parseMessage,
  scaleOf,
  swpcDate,
  toItem as swpcItem,
} from '../packages/adapters/src/swpc.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

// The seed module reaches the database package, which reads the environment at
// import. It needs the variable to exist, not to connect: nothing here queries.
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';
const { COLLECTIONS, DEFAULT_FEEDS } = await import('../packages/core/src/seed.js');

/* A storm the way NHC's CurrentStorms.json actually returns one. */
const storm = (over = {}) => ({
  id: 'ep132026',
  name: 'Marie',
  classification: 'TS',
  intensity: '50',
  pressure: '992',
  latitudeNumeric: 24.8,
  longitudeNumeric: -125.3,
  movementDir: 290,
  movementSpeed: 8,
  lastUpdate: '2026-09-07T21:00:00.000Z',
  publicAdvisory: { advNum: '027', issuance: '2026-09-07T21:00:00.000Z', url: 'https://x/adv' },
  ...over,
});

describe('the weather collection', () => {
  test('exists, and every weather adapter is registered in it', () => {
    expect(COLLECTIONS.map((c) => c.slug)).toContain('weather');
    for (const name of ['nws-alerts', 'nhc-cyclones', 'swpc-space-weather', 'eonet-events']) {
      const a = adapterByName(name);
      expect(a).not.toBeNull();
      expect(a.collection).toBe('weather');
    }
  });

  test('the NWS alerts moved out of alerts, and the rest of alerts stayed', () => {
    // Earthquakes and the global disaster feed are not weather and keep their
    // home; only the weather half moved, which is what migration 0010 does.
    expect(adapterByName('usgs-earthquakes').collection).toBe('alerts');
    expect(adapterByName('gdacs').collection).toBe('alerts');
  });

  test('every weather feed queries a kind some weather adapter emits', () => {
    const emitted = new Set(
      ADAPTERS.filter((a) => a.collection === 'weather').flatMap((a) => a.kinds),
    );
    const feeds = DEFAULT_FEEDS.filter((f) => f.collection === 'weather');
    expect(feeds.length).toBeGreaterThan(5);
    for (const f of feeds) {
      for (const kind of f.query.kinds ?? []) {
        expect(emitted).toContain(kind);
      }
    }
  });

  test('the severe weather feed keeps the slug it had under alerts', () => {
    // A feed URL is a promise to whoever is polling it. The collection moved;
    // the slug must not.
    const feed = DEFAULT_FEEDS.find((f) => f.slug === 'severe-weather-us');
    expect(feed.collection).toBe('weather');
  });

  test('no two feeds share a slug, which the schema requires globally', () => {
    const slugs = DEFAULT_FEEDS.map((f) => f.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});

describe('tropical cyclones', () => {
  test('Saffir-Simpson comes from the wind, and below hurricane force there is none', () => {
    expect(categoryOf(63)).toBeNull();
    expect(categoryOf(64)).toBe(1);
    expect(categoryOf(96)).toBe(3);
    expect(categoryOf(137)).toBe(5);
    expect(categoryOf(null)).toBeNull();
  });

  test('knots become the mph a reader thinks in', () => {
    expect(knotsToMph(50)).toBe(58);
    expect(knotsToMph(null)).toBeNull();
  });

  test('a storm reads as a headline, not as a field dump', () => {
    const i = nhcItem(storm());
    expect(i.title).toBe('Tropical Storm Marie, 58 mph (advisory 027)');
    expect(i.summary).toContain('992 mb');
    expect(i.kind).toBe('cyclone');
  });

  test('a hurricane is titled by category rather than by classification', () => {
    const i = nhcItem(storm({ classification: 'HU', intensity: '100' }));
    expect(i.title).toStartWith('Category 3 Hurricane Marie');
    expect(i.tags).toContain('major-hurricane');
    expect(i.tags).toContain('category-3');
  });

  test('each advisory is its own row, so a storm is a run and not one mutating item', () => {
    const a = nhcItem(storm());
    const b = nhcItem(storm({ publicAdvisory: { advNum: '028', issuance: 'x', url: 'y' } }));
    expect(a.externalId).not.toBe(b.externalId);
    // Re-reading the same advisory must not produce a second row.
    expect(nhcItem(storm()).externalId).toBe(a.externalId);
  });

  test('the basin is a tag, because that is what a reader filters on', () => {
    expect(nhcItem(storm({ id: 'al052026' })).tags).toContain('atlantic');
    expect(nhcItem(storm()).tags).toContain('eastern-pacific');
    expect(nhcItem(storm({ id: 'cp012026' })).tags).toContain('central-pacific');
  });

  test('the item survives normalisation', () => {
    const n = normaliseItem(nhcItem(storm()));
    expect(n).not.toBeNull();
    expect(n.publishedAt).toBeInstanceOf(Date);
  });
});

describe('space weather', () => {
  const message = [
    'Space Weather Message Code: WARK05',
    'Serial Number: 2262',
    'Issue Time: 2026 Sep 07 2001 UTC',
    '',
    'WARNING: Geomagnetic K-index of 5 expected',
    'Valid From: 2026 Sep 07 2000 UTC',
    'Valid To: 2026 Sep 08 0600 UTC',
    'Warning Condition: Onset',
    'NOAA Scale: G1 - Minor',
    '',
    'Potential Impacts: Weak power grid fluctuations can occur.',
  ].join('\r\n');

  test('the teleprinter header is read as fields', () => {
    const f = parseMessage(message);
    expect(f.serial_number).toBe('2262');
    expect(f.warning_condition).toBe('Onset');
    expect(f.issue_time).toBe('2026 Sep 07 2001 UTC');
  });

  test('the NOAA scale is pulled out, because it is what people filter on', () => {
    const s = scaleOf(message);
    expect(s).toEqual({
      code: 'G1',
      letter: 'G',
      level: 1,
      kind: 'geomagnetic storm',
      label: 'minor',
    });
    expect(scaleOf('nothing here')).toBeNull();
    expect(scaleOf('R3 - Strong').kind).toBe('radio blackout');
  });

  test('watch, warning and alert are told apart', () => {
    expect(noticeOf(message)).toBe('warning');
    expect(noticeOf('WATCH: Geomagnetic Storm Category G3')).toBe('watch');
    expect(noticeOf('ALERT: Geomagnetic K-index of 6')).toBe('alert');
  });

  test('SWPC’s own date format parses, and anything else refuses to', () => {
    expect(swpcDate('2026 Sep 07 2001 UTC')).toBe('2026-09-07T20:01:00.000Z');
    expect(swpcDate('2026-09-07')).toBeNull();
    expect(swpcDate('2026 Xyz 07 2001 UTC')).toBeNull();
  });

  test('a message becomes an item that says the scale in the title', () => {
    const i = swpcItem({ product_id: 'K05W', issue_datetime: '2026-09-07 20:01:31', message });
    expect(i.title).toBe('G1 minor: Geomagnetic K-index of 5 expected');
    expect(i.tags).toContain('g1');
    expect(i.tags).toContain('warning');
    expect(i.publishedAt).toBe('2026-09-07T20:01:00.000Z');
    // The operational message is the primary source and is kept whole.
    expect(i.data.message).toContain('Space Weather Message Code');
  });

  test('a storm big enough to drop the aurora south is tagged for it', () => {
    const strong = message.replace('G1 - Minor', 'G3 - Strong');
    const i = swpcItem({ product_id: 'X', issue_datetime: 'x', message: strong });
    expect(i.tags).toContain('aurora-likely');
    expect(i.tags).toContain('severe');
  });
});

describe('NASA EONET', () => {
  const event = (over = {}) => ({
    id: 'EONET_23868',
    title: 'A fire, Humboldt, Nevada',
    description: null,
    link: 'https://eonet.gsfc.nasa.gov/api/v3/events/EONET_23868',
    closed: null,
    categories: [{ id: 'wildfires', title: 'Wildfires' }],
    sources: [{ id: 'IRWIN', url: 'https://irwin.doi.gov/x' }],
    geometry: [
      { date: '2026-09-01T00:00:00Z', type: 'Point', coordinates: [-117.7, 41.5] },
      {
        date: '2026-09-03T13:03:00Z',
        type: 'Point',
        coordinates: [-117.74, 41.51],
        magnitudeValue: 500,
        magnitudeUnit: 'acres',
      },
    ],
    ...over,
  });

  test('the latest observation is where the event currently is', () => {
    expect(latestGeometry(event().geometry).date).toBe('2026-09-03T13:03:00Z');
    expect(latestGeometry([])).toBeNull();
  });

  test('a point is read as a point, and a polygon does not become NaN', () => {
    expect(pointOf({ type: 'Point', coordinates: [-117.7, 41.5] })).toEqual({
      lon: -117.7,
      lat: 41.5,
    });
    const poly = pointOf({
      type: 'Polygon',
      coordinates: [
        [
          [1, 2],
          [3, 4],
        ],
      ],
    });
    expect(Number.isFinite(poly.lat)).toBe(true);
    expect(Number.isFinite(poly.lon)).toBe(true);
  });

  test('a growing fire is news again, and a still one is not', () => {
    const a = eonetItem(event());
    // Same event, same latest observation: the same row.
    expect(eonetItem(event()).externalId).toBe(a.externalId);
    const grown = event({
      geometry: [
        ...event().geometry,
        {
          date: '2026-09-05T00:00:00Z',
          type: 'Point',
          coordinates: [-117.74, 41.51],
          magnitudeValue: 900,
          magnitudeUnit: 'acres',
        },
      ],
    });
    expect(eonetItem(grown).externalId).not.toBe(a.externalId);
    expect(eonetItem(grown).title).toContain('900 acres');
  });

  test('the link goes to the agency that reported it, not to our copy', () => {
    const i = eonetItem(event());
    expect(i.url).toBe('https://irwin.doi.gov/x');
    expect(i.data.eonetUrl).toContain('eonet.gsfc.nasa.gov');
  });

  test('EONET categories map onto kinds the feeds ask for', () => {
    expect(eonetItem(event()).kind).toBe('wildfire');
    expect(eonetItem(event({ categories: [{ id: 'floods', title: 'Floods' }] })).kind).toBe(
      'flood',
    );
    expect(
      eonetItem(event({ categories: [{ id: 'severeStorms', title: 'Severe Storms' }] })).kind,
    ).toBe('storm');
  });

  test('the item survives normalisation', () => {
    const n = normaliseItem(eonetItem(event()));
    expect(n).not.toBeNull();
    expect(n.tags).toContain('wildfire');
  });
});
