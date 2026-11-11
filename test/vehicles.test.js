import { describe, expect, test } from 'bun:test';
import {
  jcatFor,
  parseAircraftQuery,
  parseSatelliteQuery,
  parseShipQuery,
  subpoint,
} from '../apps/web/src/lib/vehicles.js';
import { toItem as aisItem, flagOf, shipType } from '../packages/adapters/src/ais.js';
import {
  toItem as faaItem,
  parseEngines,
  parseModels,
  ymd,
} from '../packages/adapters/src/faa-registry.js';
import { family, gcatDate, toItem as gcatItem } from '../packages/adapters/src/gcat.js';
import { ADAPTERS, adapterByName } from '../packages/adapters/src/index.js';
import { isReservedNicheSlug } from '../packages/knowledge/src/index.js';

const { COLLECTIONS, DEFAULT_FEEDS } = await import('../packages/core/src/seed.js');

const ACFTREF = `﻿CODE,MFR,MODEL,TYPE-ACFT,TYPE-ENG,AC-CAT,BUILD-CERT-IND,NO-ENG,NO-SEATS,AC-WEIGHT,SPEED,TC-DATA-SHEET,TC-DATA-HOLDER,
7100510,PIPER                         ,J3C-65              ,4,1 ,1,0,01,002,CLASS 1,0067,A-691          ,PIPER AIRCRAFT INC                                ,`;
const ENGINE = `﻿CODE,MFR,MODEL,TYPE,HORSEPOWER,THRUST,
17003,CONT MOTOR,A&C65 SERIES ,1 ,00065,000000,`;
const PERSON =
  '100  ,5334                          ,7100510,17003,1940,1,BENE MARY D                                       ,PO BOX 329                       ,                                 ,KETCHUM           ,OK,743490329 ,2,097,US,20230122,20050506,1         ,4,1 ,V ,50002263, ,19540430,                                                  ,                                                  ,                                                  ,                                                  ,                                                  ,20270430,00600060,                              ,                    ,A004B3    ,';
const COMPANY =
  '10000,10000                         ,2130004,     ,    ,7,9AT LLC                                           ,511 WEDGEWOOD AVE                ,                                 ,NASHVILLE         ,TN,372035521 ,3,037,US,20240823,20240823,          ,4,1 ,25,50003445, ,        ,                                                  ,                                                  ,                                                  ,                                                  ,                                                  ,20310831,01443200,                              ,                    ,A00725    ,';

describe('FAA register', () => {
  const models = parseModels(ACFTREF);
  const engines = parseEngines(ENGINE);

  test('joins the model and engine tables', () => {
    const it = faaItem(PERSON, { models, engines });
    expect(it.externalId).toBe('N100');
    expect(it.title).toBe('N100: 1940 Piper J3C-65');
    expect(it.data.icaoHex).toBe('a004b3');
    expect(it.data.seats).toBe(2);
    expect(it.data.engine.horsepower).toBe(65);
    expect(it.tags).toContain('hex-a004b3');
    expect(it.tags).toContain('registered');
  });

  test('a private owner keeps the city and loses the name and street', () => {
    const it = faaItem(PERSON, { models, engines });
    expect(it.data.owner).toBeNull();
    expect(it.data.street).toBeNull();
    expect(it.data.zip).toBeNull();
    expect(it.data.city).toBe('Ketchum');
    expect(JSON.stringify(it)).not.toContain('BENE');
    expect(JSON.stringify(it)).not.toContain('PO BOX');
  });

  test('a company keeps its name; a numeric status is reported, not guessed', () => {
    const it = faaItem(COMPANY, { models, engines });
    expect(it.data.owner).toBe('9AT LLC');
    expect(it.data.status).toBe('FAA status code 25');
    expect(it.tags).not.toContain('registered');
  });

  test('the header line and dates', () => {
    expect(faaItem('﻿N-NUMBER,SERIAL NUMBER')).toBeNull();
    expect(ymd('20240823')).toBe('2024-08-23');
    expect(ymd('        ')).toBeNull();
  });
});

describe('GCAT', () => {
  const ISS =
    'S25544    \t25544\t1998-067\t1998-067A\tP      O    \tISS (Zarya)\tZarya\t1998 Nov 20\t-\t1998 Nov 20 0640\tEarth\t-\tO\t-\tRSA\tRU\tKHR\tFGB\t-\t   20260 \t \t  20260 \t \t  20260 \t \t  12.6 \t \t  4.1 \t \t   24.4 \t \tCyl + 2 Pan\t2026 Nov  1\t     415\t \t     420\t \t 51.64 \t \tLLEO/I\t-\t-';
  test('a row', () => {
    const it = gcatItem(ISS);
    expect(it.externalId).toBe('S25544');
    expect(it.kind).toBe('satellite');
    expect(it.data.norad).toBe(25544);
    expect(it.data.inOrbit).toBe(true);
    expect(it.data.launchedAt).toBe('1998-11-20');
    expect(it.data.perigeeKm).toBe(415);
    expect(it.tags).toEqual(
      expect.arrayContaining(['in-orbit', 'payload', 'state-ru', 'orbit-lleo']),
    );
  });
  test('headers, dates and families', () => {
    expect(gcatItem('#JCAT\tSatcat')).toBeNull();
    expect(gcatDate('1957 Dec  1 1000?')).toBe('1957-12-01');
    expect(gcatDate('-')).toBeNull();
    expect(family('Starlink 38086')).toBe('starlink');
    expect(family('ISS (Zarya)')).toBeNull();
    expect(jcatFor(1)).toBe('S00001');
  });
});

describe('AIS', () => {
  test('a vessel with a position', () => {
    const it = aisItem(
      {
        mmsi: 230629000,
        imo: 9606900,
        name: 'VIKING GRACE',
        callSign: 'OJPQ',
        shipType: 60,
        destination: 'FITKU',
        draught: 67,
        referencePointA: 22,
        referencePointB: 196,
        referencePointC: 16,
        referencePointD: 16,
        timestamp: 1794359883276,
      },
      {
        geometry: { coordinates: [19.38, 59.77] },
        properties: {
          sog: 18,
          cog: 240.1,
          heading: 511,
          navStat: 0,
          timestampExternal: 1794359883276,
        },
      },
    );
    expect(it.externalId).toBe('mmsi-230629000');
    expect(it.title).toBe('VIKING GRACE (passenger)');
    expect(it.data.flag).toBe('Finland');
    expect(it.data.lengthM).toBe(218);
    expect(it.data.draughtM).toBe(6.7);
    expect(it.data.headingDeg).toBeNull();
    expect(it.data.place).toEqual({ lat: 59.77, lon: 19.38 });
    expect(it.tags).toEqual(
      expect.arrayContaining(['passenger', 'flag-fi', 'imo-9606900', 'in-range']),
    );
  });
  test('types and flags', () => {
    expect(shipType(52)).toBe('tug');
    expect(shipType(84)).toBe('tanker');
    expect(shipType(0)).toBeNull();
    expect(flagOf(111230000)).toBeNull();
    expect(flagOf(636012345).code).toBe('LR');
  });
});

describe('lookups', () => {
  test('aircraft queries', () => {
    expect(parseAircraftQuery('n172sp')).toEqual({ type: 'reg', value: 'N172SP' });
    expect(parseAircraftQuery('172SP')).toEqual({ type: 'reg', value: 'N172SP' });
    expect(parseAircraftQuery('a2d8e1')).toEqual({ type: 'hex', value: 'a2d8e1' });
    expect(parseAircraftQuery('UAL1')).toEqual({ type: 'callsign', value: 'UAL1' });
    expect(parseAircraftQuery('Cessna 172').type).toBe('text');
  });
  test('satellite and ship queries', () => {
    expect(parseSatelliteQuery('25544')).toEqual({ type: 'norad', value: 25544 });
    expect(parseSatelliteQuery('1998-067a')).toEqual({ type: 'designator', value: '1998-067A' });
    expect(parseShipQuery('230629000')).toEqual({ type: 'mmsi', value: 230629000 });
    expect(parseShipQuery('IMO 9606900')).toEqual({ type: 'imo', value: 9606900 });
    expect(parseShipQuery('viking grace').type).toBe('text');
  });
  test('SGP4 puts the ISS where the ISS flies', () => {
    const tle = {
      line1: '1 25544U 98067A   26314.17503267  .00009346  00000-0  17575-3 0  9997',
      line2: '2 25544  51.6322 297.6644 0007292   8.9462 351.1656 15.49289712594382',
    };
    const p = subpoint(tle, new Date('2026-11-10T12:00:00Z'));
    expect(Math.abs(p.lat)).toBeLessThanOrEqual(52);
    expect(p.altitudeKm).toBeGreaterThan(380);
    expect(p.altitudeKm).toBeLessThan(450);
    expect(p.periodMin).toBeGreaterThan(90);
    expect(p.periodMin).toBeLessThan(95);
  });
});

describe('wiring', () => {
  test('collections, sources and feeds line up', () => {
    for (const slug of ['aircraft', 'satellites', 'ships']) {
      expect(COLLECTIONS.map((c) => c.slug)).toContain(slug);
      expect(isReservedNicheSlug(slug)).toBe(true);
    }
    for (const page of ['airplanes', 'boats']) expect(isReservedNicheSlug(page)).toBe(true);
    for (const name of ['faa-registry', 'gcat-satcat', 'digitraffic-ais']) {
      expect(adapterByName(name)).not.toBeNull();
    }
    const sources = new Set(ADAPTERS.flatMap((a) => (a.defaultSources ?? []).map((s) => s.slug)));
    for (const f of DEFAULT_FEEDS.filter((f) =>
      ['aircraft', 'satellites', 'ships'].includes(f.collection),
    )) {
      for (const s of f.query.sources ?? []) expect(sources.has(s)).toBe(true);
    }
  });
});
