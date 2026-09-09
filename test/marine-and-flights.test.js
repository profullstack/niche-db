import { describe, expect, test } from 'bun:test';
import {
  altitude,
  toItem as flightItem,
  minutesBetween,
  SQUAWKS,
  WATCHES,
} from '../packages/adapters/src/adsb.js';
import { ADAPTERS, adapterByName } from '../packages/adapters/src/index.js';
import {
  toItem as buoyItem,
  compass,
  parseLatest,
  parseRow,
  parseStations,
  reading,
  swellDescription,
} from '../packages/adapters/src/ndbc.js';
import {
  firstParagraph,
  hazards,
  OFFICES,
  toItem as surfItem,
} from '../packages/adapters/src/surfzone.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';
const { DEFAULT_FEEDS } = await import('../packages/core/src/seed.js');

/* Rows exactly as latest_obs.txt writes them, MM and all. */
const HEADER =
  '#STN       LAT      LON  YYYY MM DD hh mm WDIR WSPD   GST WVHT  DPD APD MWD   PRES  PTDY  ATMP  WTMP  DEWP  VIS   TIDE';
const WAVE_ROW =
  '46205    54.18  -134.32 2026 09 09 19 00 260   8.0  10.0  2.7    8 6.4 270 1015.0    MM  14.8  13.5    MM   MM     MM';
const BARE_ROW =
  '15009     0.000   -3.051 2026 09 09 18 00 192   6.0    MM   MM  MM   MM  MM 1013.4    MM  24.6  26.0    MM   MM     MM';

describe('ocean buoys', () => {
  test('MM is a missing reading, never a zero', () => {
    /* This is the whole adapter. `parseFloat('MM')` is NaN and `Number('MM') || 0`
     * is 0, and a station with no anemometer would be published as a flat calm. */
    expect(reading('MM')).toBeNull();
    expect(reading('')).toBeNull();
    expect(reading('N/A')).toBeNull();
    expect(reading('0.0')).toBe(0);
    expect(reading('2.7')).toBe(2.7);
  });

  test('a row without a wave sensor is not a row reporting a flat sea', () => {
    const bare = parseRow(BARE_ROW);
    expect(bare.waveHeight).toBeNull();
    expect(bare.windSpeed).toBe(6);
    expect(bare.waterTemp).toBe(26);

    const item = normaliseItem(buoyItem(bare));
    expect(item.kind).toBe('marine-observation');
    expect(item.data.waveHeightM).toBeNull();
    expect(item.data.waveHeightFt).toBeNull();
    expect(item.tags).not.toContain('waves');
  });

  test('a wave row carries height in both units and the period that classifies it', () => {
    const item = normaliseItem(
      buoyItem(parseRow(WAVE_ROW), { name: 'West Dixon Entrance', type: 'buoy' }),
    );
    expect(item.kind).toBe('sea-state');
    expect(item.data.waveHeightM).toBe(2.7);
    // Every US surf forecast is in feet; converting at read time is how a
    // nine-foot day becomes a three-foot day.
    expect(item.data.waveHeightFt).toBe(8.9);
    expect(item.data.dominantPeriodS).toBe(8);
    expect(item.data.waveDirection).toBe('W');
    expect(item.title).toContain('West Dixon Entrance');
    expect(item.tags).toContain('big-surf');
  });

  test('the period is what separates two swells of the same size', () => {
    // Two metres at 18 seconds and two metres at 5 seconds are completely
    // different days in the water.
    expect(swellDescription(2, 18)).toContain('long-period groundswell');
    expect(swellDescription(2, 11)).toContain('groundswell');
    expect(swellDescription(2, 8)).toContain('mixed swell');
    expect(swellDescription(2, 5)).toContain('windswell');
    // A period of 0 or 1 is a sensor saying nothing, not a wave.
    expect(swellDescription(0, 0)).toBe('0 ft');
    expect(swellDescription(0.5, 1)).toBe('1.6 ft');
    expect(swellDescription(null, 12)).toBeNull();
  });

  test('an empty name in the register is not a name', () => {
    /* Station 15009 really is published with name="". Left as an empty string
     * it beats the fallback and titles the row with nothing at all. */
    const stations = parseStations(
      '<station id="15009" lat="0" lon="-3" name="" owner="PIRATA" type="other"/>' +
        '<station id="46205" lat="54.18" lon="-134.32" name="West Dixon Entrance" owner="ECCC" type="buoy"/>',
    );
    expect(stations['15009'].name).toBeNull();
    expect(stations['46205'].name).toBe('West Dixon Entrance');
    expect(buoyItem(parseRow(BARE_ROW), stations['15009']).title).toStartWith('Station 15009:');
  });

  test('the header rows are not observations', () => {
    const rows = parseLatest([HEADER, '#text deg deg', WAVE_ROW, BARE_ROW, ''].join('\n'));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.station)).toEqual(['46205', '15009']);
  });

  test('a compass point is where the swell comes from', () => {
    expect(compass(0)).toBe('N');
    expect(compass(270)).toBe('W');
    expect(compass(200)).toBe('SSW');
    expect(compass(359)).toBe('N');
    expect(compass(null)).toBeNull();
  });
});

describe('surf zone forecasts', () => {
  const product = {
    id: 'b1b6d224-cfa4-4329-9f2c-aa29e01e4838',
    issuingOffice: 'PHFO',
    issuanceTime: '2026-09-09T19:03:00+00:00',
  };
  const text = [
    '000',
    'FZHW52 PHFO 091903',
    'SRFHFO',
    '',
    'Surf Zone Forecast for Hawaii',
    'National Weather Service Honolulu HI',
    '',
    '.DISCUSSION...',
    'A moderate long-period south swell peaked last night and will produce',
    'advisory level surf through today. A High Surf Advisory remains in effect',
    'for south facing shores. There is a High Risk of rip currents.',
  ].join('\n');

  test('the hazard is lifted from the forecaster’s own wording', () => {
    expect(hazards(text)).toContain('high-surf-advisory');
    expect(hazards(text)).toContain('rip-current-risk:high');
    expect(hazards('High Surf Warning in effect')).toContain('high-surf-warning');
    expect(hazards('nothing much happening')).toEqual([]);
  });

  test('an advisory shows in the title, and the full text is kept as the authority', () => {
    const item = normaliseItem(surfItem(product, text));
    expect(item.title).toContain('Honolulu');
    expect(item.title).toContain('high surf advisory');
    expect(item.data.coast).toBe('hawaii');
    expect(item.data.text).toContain('High Surf Advisory');
    expect(item.data.hazardBasis).toContain('the authority');
    expect(item.tags).toContain('hawaii');
  });

  test('the summary is the forecast, not the teletype header', () => {
    const lead = firstParagraph(text);
    expect(lead).not.toContain('FZHW52');
    expect(lead).not.toContain('SRFHFO');
    expect(lead).toContain('south swell');
  });

  test('each issuance is its own row, so a reissue does not overwrite the last', () => {
    const a = normaliseItem(surfItem(product, text));
    const b = normaliseItem(
      surfItem({ ...product, id: 'other-uuid', issuanceTime: '2026-09-09T22:00:00+00:00' }, text),
    );
    expect(a.externalId).not.toBe(b.externalId);
  });

  test('every office in the lookup names a coast a feed can ask for', () => {
    const coasts = new Set(Object.values(OFFICES).map((o) => o.coast));
    for (const c of coasts) expect(typeof c).toBe('string');
    expect(OFFICES.PHFO.coast).toBe('hawaii');
    expect(OFFICES.KLOX.coast).toBe('pacific');
  });
});

describe('aircraft on watch', () => {
  const ac = (over = {}) => ({
    hex: 'a06115',
    flight: 'AAL1234 ',
    r: 'N123AB',
    t: 'B738',
    desc: 'BOEING 737-800',
    squawk: '7700',
    alt_baro: 31000,
    gs: 420,
    lat: 39.7,
    lon: -104.9,
    ...over,
  });

  test('is registered in aviation, with feeds pointed at both kinds', () => {
    const a = adapterByName('adsb-flights');
    expect(a.collection).toBe('aviation');
    const kinds = new Set(
      ADAPTERS.filter((x) => x.collection === 'aviation').flatMap((x) => x.kinds),
    );
    for (const feed of DEFAULT_FEEDS.filter((f) => f.collection === 'aviation')) {
      for (const kind of feed.query.kinds ?? []) expect(kinds.has(kind)).toBe(true);
    }
  });

  test('an emergency squawk is read as what it means', () => {
    const item = normaliseItem(
      flightItem(ac(), {
        watch: 'emergency',
        firstSeen: '2026-09-09T19:00:00.000Z',
        now: '2026-09-09T19:00:00.000Z',
      }),
    );
    expect(item.kind).toBe('aircraft-emergency');
    expect(item.data.squawkMeaning).toBe('general emergency');
    expect(item.tags).toContain('emergency');
    expect(item.tags).toContain('severity:critical');
    expect(item.title).toContain('AAL1234');
    expect(SQUAWKS[7500].tag).toBe('hijack');
  });

  test('an aircraft is one row while it is on the list, not one row per poll', () => {
    const first = normaliseItem(
      flightItem(ac(), {
        watch: 'emergency',
        firstSeen: '2026-09-09T19:00:00.000Z',
        now: '2026-09-09T19:00:00.000Z',
      }),
    );
    const later = normaliseItem(
      flightItem(ac({ alt_baro: 12000 }), {
        watch: 'emergency',
        firstSeen: '2026-09-09T19:00:00.000Z',
        now: '2026-09-09T19:20:00.000Z',
      }),
    );
    expect(later.externalId).toBe(first.externalId);
    expect(later.contentHash).not.toBe(first.contentHash);
    expect(later.tags).toContain('active');
  });

  test('when it clears, the row is written once more with how long it ran', () => {
    const ended = normaliseItem(
      flightItem(ac(), {
        watch: 'emergency',
        firstSeen: '2026-09-09T19:00:00.000Z',
        now: '2026-09-09T19:22:00.000Z',
        ended: true,
      }),
    );
    expect(ended.title).toContain('ended after 22m');
    expect(ended.data.endedAt).toBe('2026-09-09T19:22:00.000Z');
    expect(ended.data.status).toBe('ended');
    expect(ended.tags).toContain('ended');
    expect(minutesBetween('2026-09-09T19:00:00Z', '2026-09-09T21:30:00Z')).toBe('2h 30m');
    expect(minutesBetween('2026-09-09T21:00:00Z', '2026-09-09T19:00:00Z')).toBeNull();
  });

  test('on the ground is an altitude, not a missing one', () => {
    // The feed writes the word `ground` where a number would be, and coercing
    // that yields NaN, which reads as "we do not know" for an aircraft whose
    // altitude is known exactly.
    expect(altitude('ground')).toEqual({ feet: 0, onGround: true });
    expect(altitude(31000)).toEqual({ feet: 31000, onGround: false });
    expect(altitude(null)).toEqual({ feet: null, onGround: false });
    expect(
      flightItem(ac({ alt_baro: 'ground' }), { watch: 'emergency', firstSeen: 'x', now: 'x' }).tags,
    ).toContain('on-ground');
  });

  test('a military sighting is not an emergency', () => {
    const item = flightItem(ac({ squawk: '5564', flight: 'RCH123' }), {
      watch: 'military',
      firstSeen: '2026-09-09T19:00:00.000Z',
      now: '2026-09-09T19:00:00.000Z',
    });
    expect(item.kind).toBe('aircraft-sighting');
    expect(item.data.squawkMeaning).toBeNull();
    expect(item.tags).toContain('military');
    expect(item.tags).not.toContain('emergency');
  });

  test('every default source names a watch list the adapter knows', () => {
    for (const s of adapterByName('adsb-flights').defaultSources) {
      expect(Object.keys(WATCHES)).toContain(s.config.watch);
    }
  });
});
