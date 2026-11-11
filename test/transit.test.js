import { describe, expect, test } from 'bun:test';
import { primeCity } from '../apps/web/src/lib/transit.js';
import { adapterByName } from '../packages/adapters/src/index.js';
import {
  activeServices,
  csvRows,
  gtfsAlertItem,
  sampleDates,
  summarise,
  tally,
  tflStatusItem,
} from '../packages/adapters/src/transit.js';
import { CITIES, hhmm, translated } from '../packages/core/src/transit.js';
import { isReservedNicheSlug } from '../packages/knowledge/src/index.js';

const { COLLECTIONS, DEFAULT_FEEDS } = await import('../packages/core/src/seed.js');

describe('timetable summaries', () => {
  test('sample dates are the next Wednesday, Saturday and Sunday', () => {
    const d = sampleDates(new Date('2026-11-11T12:00:00Z')); // a Wednesday
    expect(d.weekday).toEqual({ ymd: '20261111', dow: 'wednesday' });
    expect(d.saturday.ymd).toBe('20261114');
    expect(d.sunday.ymd).toBe('20261115');
  });

  test('calendar_dates add and remove services on the day', () => {
    const dates = sampleDates(new Date('2026-11-11T12:00:00Z'));
    const cal = [
      {
        service_id: 'WKD',
        wednesday: '1',
        saturday: '0',
        sunday: '0',
        start_date: '20260101',
        end_date: '20261231',
      },
      {
        service_id: 'SAT',
        wednesday: '0',
        saturday: '1',
        sunday: '0',
        start_date: '20260101',
        end_date: '20261231',
      },
    ];
    const ex = [
      { service_id: 'SAT', date: '20261114', exception_type: '2' },
      { service_id: 'WORKS', date: '20261114', exception_type: '1' },
    ];
    const s = activeServices(cal, ex, dates);
    expect([...s.weekday]).toEqual(['WKD']);
    expect([...s.saturday]).toEqual(['WORKS']);
    expect(s.sunday.size).toBe(0);
  });

  test('quoted CSV and the per-line counters', () => {
    const rows = csvRows('"stop_id","stop_name"\r\n"A10-1","Lake Merritt, Oakland"\r\n');
    expect(rows).toEqual([{ stop_id: 'A10-1', stop_name: 'Lake Merritt, Oakland' }]);
    const acc = new Map();
    for (const t of [6 * 3600, 6 * 3600 + 600, 6 * 3600 + 1200, 9 * 3600, 25 * 3600]) {
      tally(acc, { station: '127', route: '1', dir: '0', day: 'weekday', t });
    }
    const routes = new Map([
      ['1', { route_id: '1', route_short_name: '1', route_color: 'D82233' }],
    ]);
    const headsigns = new Map([['1\u00000', 'South Ferry']]);
    const out = summarise(acc.get('127'), { routes, headsigns });
    expect(out.weekday[0]).toEqual({
      route: '1',
      line: '1',
      color: '#D82233',
      toward: 'South Ferry',
      first: '06:00',
      last: '01:00 (+1)',
      trips: 5,
      peakPerHour: 3,
    });
    expect(hhmm(null)).toBeNull();
  });
});

describe('alerts', () => {
  test('a GTFS-realtime alert, active then ended', () => {
    const entity = {
      id: 'lmm:planned_work:1',
      alert: {
        headerText: { translation: [{ text: '[4][6] trains are delayed', language: 'en' }] },
        descriptionText: {
          translation: [{ text: 'Track maintenance in Manhattan.', language: 'en' }],
        },
        informedEntity: [{ routeId: '4' }, { trip: { routeId: '6' } }],
        effect: 'SIGNIFICANT_DELAYS',
      },
    };
    const a = gtfsAlertItem('nyc', entity, { now: '2026-11-11T06:00:00Z' });
    expect(a.externalId).toBe('nyc-alert-lmm:planned_work:1');
    expect(a.data.routes).toEqual(['4', '6']);
    expect(a.tags).toEqual(
      expect.arrayContaining([
        'active',
        'route-4',
        'route-6',
        'city-nyc',
        'effect-significant-delays',
      ]),
    );
    const e = gtfsAlertItem('nyc', entity, {
      ended: true,
      now: '2026-11-11T07:00:00Z',
      firstSeen: '2026-11-11T06:00:00Z',
    });
    expect(e.tags).toContain('ended');
    expect(e.data.firstSeenAt).toBe('2026-11-11T06:00:00Z');
    expect(
      translated({
        translation: [
          { text: 'Bonjour', language: 'fr' },
          { text: 'Hello', language: 'en-US' },
        ],
      }),
    ).toBe('Hello');
  });

  test('a TfL line status', () => {
    const it = tflStatusItem(
      { id: 'district', name: 'District', modeName: 'tube' },
      {
        statusSeverity: 9,
        statusSeverityDescription: 'Minor Delays',
        reason: 'Signal failure at Earls Court.',
        validityPeriods: [{ fromDate: '2026-11-11T06:00:00Z' }],
      },
    );
    expect(it.title).toBe('District: Minor Delays (London)');
    expect(it.tags).toEqual(expect.arrayContaining(['city-london', 'route-district', 'active']));
  });
});

describe('live joins', () => {
  test('a station is found by any of its platform stop ids', () => {
    const t = primeCity('test-city', {
      stations: [
        {
          externalId: 'nyc-station-127',
          data: { stationId: '127', name: 'Times Sq-42 St', stopIds: ['127N', '127S'] },
        },
      ],
      lines: [
        { externalId: 'x', data: { routeId: '1', name: '1', color: '#D82233', tripIds: ['T1'] } },
      ],
    });
    expect(t.byStop.get('127S').data.name).toBe('Times Sq-42 St');
    expect(t.tripRoute.get('T1')).toBe('1');
  });
});

describe('wiring', () => {
  test('cities, sources, feeds, reserved slug', () => {
    expect(COLLECTIONS.map((c) => c.slug)).toContain('transit');
    expect(isReservedNicheSlug('transit')).toBe(true);
    const gtfs = adapterByName('gtfs-transit').defaultSources.map((s) => s.config.city);
    expect(gtfs.sort()).toEqual(['bay-area', 'boston', 'chicago', 'nyc']);
    const alerts = adapterByName('transit-alerts').defaultSources.map((s) => s.slug);
    for (const f of DEFAULT_FEEDS.filter((f) => f.collection === 'transit')) {
      for (const s of f.query.sources ?? []) expect(alerts).toContain(s);
    }
    for (const c of Object.values(CITIES)) expect(c.tz).toBeTruthy();
  });
});
