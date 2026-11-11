import { describe, expect, test } from 'bun:test';
import { parseTrainQuery } from '../apps/web/src/lib/vehicles.js';
import { adapterByName } from '../packages/adapters/src/index.js';
import {
  amtrakItem,
  amtrakProgress,
  finnishItem,
  lateness,
  splitCsv,
  stationItem,
} from '../packages/adapters/src/trains.js';
import { isReservedNicheSlug } from '../packages/knowledge/src/index.js';

const { COLLECTIONS, DEFAULT_FEEDS } = await import('../packages/core/src/seed.js');

const stop = (name, status, sch, act) => ({
  name,
  code: name.slice(0, 3).toUpperCase(),
  status,
  schArr: sch,
  schDep: sch,
  arr: act,
  dep: act,
});

describe('amtraker', () => {
  test('the next stop follows the last departed, even past a stop left without Departed', () => {
    const stations = [
      stop('Houston', 'Departed', '2026-11-10T08:00:00-06:00', '2026-11-10T08:05:00-06:00'),
      stop('San Antonio', 'Station', '2026-11-10T12:00:00-06:00', '2026-11-10T12:00:00-06:00'),
      stop('Maricopa', 'Departed', '2026-11-11T00:00:00-07:00', '2026-11-11T00:10:00-07:00'),
      stop('Yuma', 'Enroute', '2026-11-11T02:00:00-07:00', '2026-11-11T02:12:00-07:00'),
    ];
    const p = amtrakProgress(stations);
    expect(p.last.name).toBe('Maricopa');
    expect(p.next.name).toBe('Yuma');
    expect(p.delay).toBe(12);
  });

  test('a run row', () => {
    const it = amtrakItem({
      trainNum: '5',
      trainID: '5-9',
      routeName: 'California Zephyr',
      provider: 'Amtrak',
      providerShort: 'AMTK',
      origName: 'Chicago Union Station',
      destName: 'Emeryville',
      trainState: 'Active',
      lat: 40.1,
      lon: -111.6,
      velocity: 70.4,
      alerts: [],
      stations: [
        stop('Chicago', 'Departed', '2026-11-09T14:00:00-06:00', '2026-11-09T14:00:00-06:00'),
        stop('Provo', 'Enroute', '2026-11-11T01:00:00-07:00', '2026-11-11T01:40:00-07:00'),
      ],
    });
    expect(it.externalId).toBe('amtk-5-2026-11-09');
    expect(it.data.delay).toBe('40 min late');
    expect(it.data.speedMph).toBe(70);
    expect(it.tags).toEqual(
      expect.arrayContaining(['running', 'late', 'train-5', 'route-california-zephyr']),
    );
  });

  test('lateness words', () => {
    expect(lateness(0)).toBe('on time');
    expect(lateness(-3)).toBe('3 min early');
    expect(lateness(null)).toBeNull();
  });
});

describe('fintraffic rail', () => {
  const row = (code, type, sch, act, diff) => ({
    stationShortCode: code,
    type,
    scheduledTime: sch,
    actualTime: act,
    differenceInMinutes: diff,
    commercialStop: true,
    trainStopping: true,
    commercialTrack: '3',
  });
  const train = {
    trainNumber: 1,
    departureDate: '2026-11-11',
    trainType: 'IC',
    trainCategory: 'Long-distance',
    operatorShortCode: 'vr',
    commuterLineID: '',
    runningCurrently: true,
    cancelled: false,
    timeTableRows: [
      row('HKI', 'DEPARTURE', '2026-11-11T04:54:00Z', '2026-11-11T04:54:30Z', 1),
      row('LH', 'ARRIVAL', '2026-11-11T05:48:00Z', '2026-11-11T06:10:00Z', 22),
      row('LH', 'DEPARTURE', '2026-11-11T05:50:00Z', null, null),
      row('JNS', 'ARRIVAL', '2026-11-11T09:20:00Z', null, null),
    ],
  };
  const names = new Map([
    ['HKI', 'Helsinki'],
    ['LH', 'Lahti'],
    ['JNS', 'Joensuu'],
  ]);

  test('a passenger train row with lateness and the GPS fix', () => {
    const it = finnishItem(train, {
      names,
      location: {
        location: { coordinates: [25.6, 60.9] },
        speed: 129,
        timestamp: '2026-11-11T06:11:00Z',
      },
    });
    expect(it.externalId).toBe('fi-2026-11-11-1');
    expect(it.title).toBe('IC 1: Helsinki to Joensuu (2026-11-11)');
    expect(it.data.delayMinutes).toBe(22);
    expect(it.data.nextStop.name).toBe('Lahti');
    expect(it.data.place).toEqual({ lat: 60.9, lon: 25.6 });
    expect(it.tags).toEqual(expect.arrayContaining(['finland', 'running', 'late', 'type-ic']));
  });

  test('cargo and shunting are not passenger trains', () => {
    expect(finnishItem({ ...train, trainCategory: 'Cargo' }, { names })).toBeNull();
  });
});

describe('stations', () => {
  test('quoted semicolons survive and a row needs coordinates', () => {
    expect(splitCsv('1;"A; B";x')).toEqual(['1', 'A; B', 'x']);
    const base = {
      id: '3389',
      name: 'Paris Gare de Lyon',
      country: 'FR',
      uic: '8768600',
      latitude: '48.8443',
      longitude: '2.3743',
      is_main_station: 't',
      sncf_is_enabled: 't',
    };
    const it = stationItem(base);
    expect(it.externalId).toBe('trainline-3389');
    expect(it.data.servedBy).toEqual(['SNCF']);
    expect(it.tags).toEqual(
      expect.arrayContaining(['station', 'country-fr', 'main-station', 'served-sncf']),
    );
    expect(stationItem({ ...base, latitude: '', longitude: '' })).toBeNull();
  });
});

describe('lookups and wiring', () => {
  test('train queries', () => {
    expect(parseTrainQuery('Amtrak 5')).toEqual({ type: 'number', value: '5', operator: 'amtrak' });
    expect(parseTrainQuery('IC 1')).toEqual({ type: 'number', value: '1', operator: 'ic' });
    expect(parseTrainQuery('amtk-5-2026-11-09')).toEqual({
      type: 'id',
      value: 'amtk-5-2026-11-09',
    });
    expect(parseTrainQuery('Paris Gare de Lyon').type).toBe('text');
  });
  test('collection, sources and feeds', () => {
    expect(COLLECTIONS.map((c) => c.slug)).toContain('trains');
    expect(isReservedNicheSlug('trains')).toBe(true);
    for (const n of ['amtraker', 'fintraffic-rail', 'trainline-stations'])
      expect(adapterByName(n)).not.toBeNull();
    expect(DEFAULT_FEEDS.filter((f) => f.collection === 'trains').length).toBe(4);
  });
});
