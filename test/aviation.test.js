import { describe, expect, test } from 'bun:test';
import {
  bboxOf,
  hazardItem,
  metarItem,
  movement,
  parseBox,
  quarters,
  regionsOf,
} from '../packages/adapters/src/aviationweather.js';
import {
  duration,
  toItem as faaItem,
  legsOf,
  parseStatus,
  reasonTags,
} from '../packages/adapters/src/faanas.js';
import { adapterByName } from '../packages/adapters/src/index.js';
import { normaliseItem, xmlItems } from '../packages/core/src/adapter.js';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';
const { COLLECTIONS, DEFAULT_FEEDS } = await import('../packages/core/src/seed.js');

/*
 * The FAA snapshot, in the shape nasstatus.faa.gov actually returns it, taken
 * on 9 September 2026. Two things in here are the reason it is a fixture rather
 * than a hand-simplified example: `Airport Closures` appears TWICE as a
 * Delay_type, and a `Delay` carries its arrival and departure legs as nested
 * children distinguished only by an attribute.
 */
const SNAPSHOT = `<AIRPORT_STATUS_INFORMATION><Update_Time>Wed Sep 9 17:23:43 2026 GMT</Update_Time><Dtd_File>http://www.fly.faa.gov/AirportStatus.dtd</Dtd_File><Delay_type><Name>Ground Delay Programs</Name><Ground_Delay_List><Ground_Delay><ARPT>BOS</ARPT><Reason>runway construction</Reason><Avg>58 minutes</Avg><Max>2 hours and 31 minutes</Max></Ground_Delay><Ground_Delay><ARPT>MIA</ARPT><Reason>thunderstorms</Reason><Avg>35 minutes</Avg><Max>1 hour and 59 minutes</Max></Ground_Delay></Ground_Delay_List></Delay_type><Delay_type><Name>Ground Stop Programs</Name><Ground_Stop_List><Program><ARPT>EWR</ARPT><Reason>weather / thunderstorms</Reason><End_Time>7 PM EDT</End_Time></Program></Ground_Stop_List></Delay_type><Delay_type><Name>Arrival/Departure Delays</Name><Arrival_Departure_Delay_List><Delay><ARPT>SFO</ARPT><Reason>low ceilings</Reason><Arrival_Departure Type="Arrival"><Min>46 minutes</Min><Max>1 hour</Max><Trend>Increasing</Trend></Arrival_Departure><Arrival_Departure Type="Departure"><Min>15 minutes</Min><Max>30 minutes</Max><Trend>Decreasing</Trend></Arrival_Departure></Delay></Arrival_Departure_Delay_List></Delay_type><Delay_type><Name>Airport Closures</Name><Airport_Closure_List><Airport><ARPT>SNA</ARPT><Reason>!SNA 09/016 SNA AD AP CLSD DLY 0630-1315</Reason><Start>Sep 09 at 06:30 UTC.</Start><Reopen>Sep 12 at 13:15 UTC.</Reopen></Airport></Airport_Closure_List></Delay_type><Delay_type><Name>Airport Closures</Name><Airport_Closure_List><Airport><ARPT>LAX</ARPT><Reason>!LAX 05/277 LAX AD AP CLSD TO NON SKED TRANSIENT GA ACFT</Reason><Start>May 27 at 18:26 UTC.</Start><Reopen>May 28 at 16:00 UTC.</Reopen></Airport></Airport_Closure_List></Delay_type></AIRPORT_STATUS_INFORMATION>`;

describe('the aviation collection', () => {
  test('exists, and every aviation adapter is registered in it', () => {
    expect(COLLECTIONS.map((c) => c.slug)).toContain('aviation');
    for (const name of ['faa-nas-status', 'aviation-hazards', 'aviation-metar']) {
      const a = adapterByName(name);
      expect(a).not.toBeNull();
      expect(a.collection).toBe('aviation');
    }
  });

  test('every aviation feed queries kinds the collection actually emits', () => {
    const kinds = new Set(
      ['faa-nas-status', 'aviation-hazards', 'aviation-metar'].flatMap(
        (n) => adapterByName(n).kinds,
      ),
    );
    const feeds = DEFAULT_FEEDS.filter((f) => f.collection === 'aviation');
    expect(feeds.length).toBeGreaterThan(0);
    for (const feed of feeds) {
      for (const kind of feed.query.kinds ?? []) expect(kinds.has(kind)).toBe(true);
    }
  });
});

describe('the FAA snapshot', () => {
  test('reads every program type out of one snapshot', () => {
    const { updated, programs } = parseStatus(SNAPSHOT);
    expect(updated).toBe('Wed Sep 9 17:23:43 2026 GMT');
    const kinds = programs.map((p) => `${p.kind}:${p.where}`);
    expect(kinds).toContain('ground-delay:BOS');
    expect(kinds).toContain('ground-delay:MIA');
    expect(kinds).toContain('ground-stop:EWR');
    expect(kinds).toContain('airport-delay:SFO');
    expect(kinds).toContain('airport-closure:SNA');
  });

  test('keeps both Airport Closures blocks, because the FAA sends two', () => {
    /* The snapshot really does repeat the Delay_type name. A reader that
     * indexed blocks by their name would keep whichever came last and lose the
     * other airport entirely, with nothing to show that it had. */
    const closures = parseStatus(SNAPSHOT)
      .programs.filter((p) => p.kind === 'airport-closure')
      .map((p) => p.where);
    expect(closures).toEqual(expect.arrayContaining(['SNA', 'LAX']));
  });

  test('a delay carries both directions, with the minutes belonging to each', () => {
    const delay = xmlItems(SNAPSHOT, 'Delay').find((f) => f.ARPT?.text === 'SFO');
    const legs = legsOf(delay);
    expect(legs).toHaveLength(2);
    expect(legs.find((l) => l.type === 'Arrival')).toMatchObject({
      min: '46 minutes',
      max: '1 hour',
      trend: 'Increasing',
    });
    expect(legs.find((l) => l.type === 'Departure').min).toBe('15 minutes');
  });

  test('does not mistake Ground_Delay for Delay, or Airport_Closure_List for Airport', () => {
    const { programs } = parseStatus(SNAPSHOT);
    expect(programs.filter((p) => p.kind === 'airport-delay')).toHaveLength(1);
    expect(programs.filter((p) => p.kind === 'airport-closure')).toHaveLength(2);
  });

  test('a program is one row that keeps its identity while it lasts', () => {
    const [program] = parseStatus(SNAPSHOT).programs;
    const first = normaliseItem(
      faaItem(program, { firstSeen: '2026-09-09T17:00:00.000Z', now: '2026-09-09T17:00:00.000Z' }),
    );
    const later = normaliseItem(
      faaItem(program, { firstSeen: '2026-09-09T17:00:00.000Z', now: '2026-09-09T19:00:00.000Z' }),
    );
    expect(later.externalId).toBe(first.externalId);
    expect(later.contentHash).not.toBe(first.contentHash);
    expect(later.tags).toContain('in-force');
  });

  test('a program that leaves the snapshot is written once more, with how long it ran', () => {
    const [program] = parseStatus(SNAPSHOT).programs;
    const ended = normaliseItem(
      faaItem(program, {
        firstSeen: '2026-09-09T17:00:00.000Z',
        now: '2026-09-09T20:40:00.000Z',
        ended: true,
      }),
    );
    expect(ended.title).toContain('ended after 3h 40m');
    expect(ended.data.endedAt).toBe('2026-09-09T20:40:00.000Z');
    expect(ended.data.status).toBe('ended');
    expect(ended.tags).toContain('ended');
  });

  test('durations read the way a person would say them', () => {
    expect(duration('2026-09-09T17:00:00Z', '2026-09-09T17:25:00Z')).toBe('25m');
    expect(duration('2026-09-09T17:00:00Z', '2026-09-09T19:00:00Z')).toBe('2h');
    expect(duration('2026-09-09T17:00:00Z', '2026-09-09T19:05:00Z')).toBe('2h 5m');
    expect(duration('2026-09-09T19:00:00Z', '2026-09-09T17:00:00Z')).toBeNull();
  });

  test('the cause is tagged from the FAA’s own wording', () => {
    expect(reasonTags('weather / thunderstorms')).toEqual(
      expect.arrayContaining(['weather', 'thunderstorms']),
    );
    expect(reasonTags('runway construction')).toContain('runway');
    expect(reasonTags('disabled aircraft on the runway')).toContain('incident');
    expect(reasonTags(null)).toEqual([]);
  });
});

describe('aviation weather', () => {
  const sigmet = {
    icaoId: 'KKCI',
    airSigmetType: 'SIGMET',
    seriesId: '93C',
    hazard: 'CONVECTIVE',
    severity: 5,
    validTimeFrom: 1788972900,
    validTimeTo: 1788980100,
    altitudeHi1: 29000,
    movementDir: 240,
    movementSpd: 35,
    coords: [
      { lat: 46.3, lon: -83.2 },
      { lat: 44.6, lon: -83.0 },
      { lat: 44.9, lon: -85.4 },
    ],
    rawAirSigmet:
      'WSUS32 KKCI 091655\nSIGC\nCONVECTIVE SIGMET 93C\nVALID UNTIL 1855Z\nMI LH\nFROM 70SE SSM-60NNE ASP\nDMSHG AREA EMBD TS MOV FROM 24035KT.',
  };

  test('the region comes off the bulletin, not from the office that wrote it', () => {
    expect(regionsOf(sigmet.rawAirSigmet)).toBe('MI LH');
    const item = normaliseItem(hazardItem(sigmet));
    expect(item.title).toContain('over MI LH');
    expect(item.data.issuingOffice).toBe('KKCI');
    expect(item.tags).toContain('mi');
    // KKCI is the Aviation Weather Center. It is not a place weather is over.
    expect(item.tags).not.toContain('kkci');
  });

  test('a bulletin with no region line says so rather than inventing one', () => {
    expect(regionsOf('SIGMET\nFROM 70SE SSM-60NNE ASP')).toBeNull();
    expect(regionsOf(null)).toBeNull();
    const item = hazardItem({ ...sigmet, rawAirSigmet: 'SIGMET\nno from line here' });
    expect(item.data.area).toBeNull();
    expect(item.title).not.toContain('over');
  });

  test('a reissue under the same series is its own row', () => {
    const a = hazardItem(sigmet);
    const b = hazardItem({ ...sigmet, validTimeFrom: sigmet.validTimeFrom + 7200 });
    expect(a.externalId).not.toBe(b.externalId);
  });

  test('the polygon becomes a box, and movement becomes words', () => {
    expect(bboxOf(sigmet.coords)).toEqual({
      minLat: 44.6,
      minLon: -85.4,
      maxLat: 46.3,
      maxLon: -83.0,
    });
    expect(bboxOf(null)).toBeNull();
    expect(movement(sigmet)).toBe('WSW at 35 kt');
    expect(movement({ movementDir: 0, movementSpd: 0 })).toBeNull();
  });

  test('an observation keeps the zeroes that mean something', () => {
    const item = normaliseItem(
      metarItem({
        icaoId: 'KORD',
        name: 'Chicago/O’Hare Intl, IL, US',
        reportTime: '2026-09-09T17:00:00.000Z',
        fltCat: 'IFR',
        temp: 0,
        dewp: 0,
        wdir: 0,
        wspd: 5,
        visib: '1/2',
        lat: 41.9,
        lon: -87.9,
        rawOb: 'METAR KORD 091651Z 36005KT 1/2SM',
      }),
    );
    // Zero degrees is a temperature and north is a direction; `|| null` on
    // either would have erased both.
    expect(item.data.temperatureC).toBe(0);
    expect(item.data.windDirectionDeg).toBe(0);
    expect(item.summary).toContain('wind 0° at 5 kt');
    expect(item.tags).toContain('below-vfr');
    expect(item.tags).toContain('ifr');
  });

  test('an observation with no station or no time is not an observation', () => {
    expect(metarItem({ icaoId: 'KORD' })).toBeNull();
    expect(metarItem({ reportTime: '2026-09-09T17:00:00.000Z' })).toBeNull();
  });

  test('a box is split until its answer is not at the cap', () => {
    expect(parseBox('24,-125,50,-66')).toEqual([24, -125, 50, -66]);
    expect(parseBox('24,-125,50')).toBeNull();
    expect(parseBox('north,west,south,east')).toBeNull();

    /* The continental United States answers a single box with exactly 400
     * stations while its two halves answer with 247 and 240. The quartering is
     * what stops that silent 87-station loss, so the quarters must tile the
     * box exactly: no gap between them is an airport nobody reads. */
    const box = [24, -125, 50, -66];
    const qs = quarters(box);
    expect(qs).toHaveLength(4);
    expect(Math.min(...qs.map((q) => q[0]))).toBe(24);
    expect(Math.max(...qs.map((q) => q[2]))).toBe(50);
    expect(Math.min(...qs.map((q) => q[1]))).toBe(-125);
    expect(Math.max(...qs.map((q) => q[3]))).toBe(-66);
    const area = (b) => (b[2] - b[0]) * (b[3] - b[1]);
    expect(qs.reduce((sum, q) => sum + area(q), 0)).toBeCloseTo(area(box), 6);
  });
});
