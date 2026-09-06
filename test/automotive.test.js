import { describe, expect, test } from 'bun:test';

// The config reads the environment once at import; the automotive library
// pulls in the database module for its VIN cache and needs the variable to
// exist, not to connect. Nothing in this file touches Postgres.
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';
const {
  checkDigit,
  checkDigitOk,
  compactDecode,
  maintenanceSchedule,
  milesBetween,
  normaliseVin,
  partsSearches,
  powertrainOf,
  vinModelYear,
} = await import('../apps/web/src/lib/automotive.js');

import { toItem as aiidItem, citeOf } from '../packages/adapters/src/aiid.js';
import { menuList, modelToItem, specOf } from '../packages/adapters/src/fueleconomy.js';
import {
  advance,
  complaintToItem,
  ratingToItem,
  recallToItem,
  vehicleTags,
  yearsFor,
} from '../packages/adapters/src/nhtsa.js';
import { incidentToItem, researchToItem } from '../packages/adapters/src/rogueaitracker.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

describe('VIN', () => {
  test('normalises the way people type them', () => {
    expect(normaliseVin(' 1hgcm82633a004352 ')).toBe('1HGCM82633A004352');
    expect(normaliseVin('1HG-CM826-33A004352')).toBe('1HGCM82633A004352');
  });

  test('check digit follows ISO 3779', () => {
    // A real, published VIN: the ninth character is its own check digit.
    expect(checkDigit('1HGCM82633A004352')).toBe('3');
    expect(checkDigitOk('1HGCM82633A004352')).toBe(true);
    // Change one character and the digit no longer agrees.
    expect(checkDigitOk('1HGCM82633A004353')).toBe(false);
  });

  test('a VIN that is not 17 valid characters has no check digit', () => {
    expect(checkDigit('SHORT')).toBeNull();
    // I, O and Q are never VIN characters.
    expect(checkDigit('1HGCM82633A00435I')).toBeNull();
  });

  test('model year comes off position ten, with position seven choosing the lap', () => {
    // Position seven is a digit, so this is the first lap through the codes:
    // '3' at position ten is 2003.
    expect(vinModelYear('1HGCM82633A004352')).toBe(2003);
    // A letter at position seven puts it on the second lap: 'A' is 2010, not 1980.
    expect(vinModelYear('1HGCM8A6AA004352X')).toBe(2010);
    // The cycle repeats every thirty years, so a code that would land decades
    // in the future is read as the same code one lap back.
    expect(vinModelYear('1HGCM8A63A004352X')).toBeLessThanOrEqual(new Date().getUTCFullYear() + 2);
  });

  test('a decode keeps what was answered and drops what was not', () => {
    expect(
      compactDecode({ Make: 'HONDA', Model: '', BedType: 'Not Applicable', Doors: '2', ABS: null }),
    ).toEqual({ Make: 'HONDA', Doors: '2' });
  });
});

describe('maintenance', () => {
  test('an electric car is not told to change its oil', () => {
    const services = maintenanceSchedule({ powertrain: 'electric' }).items.map((s) => s.service);
    expect(services).not.toContain('Engine oil and filter');
    expect(services).not.toContain('Spark plugs');
    expect(services).toContain('Tyre rotation');
  });

  test('a diesel gets a fuel filter a petrol car does not', () => {
    const diesel = maintenanceSchedule({ powertrain: 'diesel' }).items.map((s) => s.service);
    const petrol = maintenanceSchedule({ powertrain: 'combustion' }).items.map((s) => s.service);
    expect(diesel).toContain('Fuel filter');
    expect(petrol).not.toContain('Fuel filter');
  });

  test('next service is the next multiple of the interval past the odometer', () => {
    const oil = maintenanceSchedule({ powertrain: 'combustion', miles: 84_000 }).items.find(
      (s) => s.service === 'Engine oil and filter',
    );
    expect(oil.nextDueAtMiles).toBe(90_000);
    expect(oil.milesUntilDue).toBe(6_000);
  });

  test('it never claims to be the manufacturer’s schedule', () => {
    const s = maintenanceSchedule({ powertrain: 'combustion' });
    expect(s.basis).toBe('general-interval');
    expect(s.disclaimer).toContain('not the manufacturer');
    for (const item of s.items) expect(item.basis).toBe('general-interval');
  });

  test('powertrain is read off whatever the decode gave', () => {
    expect(powertrainOf({ decoded: { FuelTypePrimary: 'Diesel' } })).toBe('diesel');
    expect(
      powertrainOf({ decoded: { ElectrificationLevel: 'BEV (Battery Electric Vehicle)' } }),
    ).toBe('electric');
    expect(powertrainOf({ decoded: { ElectrificationLevel: 'Strong HEV (Hybrid)' } })).toBe(
      'hybrid',
    );
    expect(powertrainOf({ economy: { fuel: 'Regular Gasoline' } })).toBe('combustion');
    expect(powertrainOf({})).toBe('combustion');
  });
});

describe('parts and places', () => {
  test('every search carries the vehicle', () => {
    const searches = partsSearches({
      year: 2014,
      make: 'Honda',
      model: 'Civic',
      part: 'alternator',
    });
    expect(searches.length).toBeGreaterThan(3);
    for (const s of searches) expect(s.url).toStartWith('https://');
    expect(searches.some((s) => s.url.includes('alternator'))).toBe(true);
    expect(searches.some((s) => s.vendor === 'RockAuto')).toBe(true);
  });

  test('an incomplete vehicle gets no searches rather than broken ones', () => {
    expect(partsSearches({ year: 2014, make: 'Honda' })).toEqual([]);
  });

  test('distance is in miles and survives a missing coordinate', () => {
    // San Francisco to Oakland, about 10 miles.
    const miles = milesBetween({ lat: 37.7749, lon: -122.4194 }, { lat: 37.8044, lon: -122.2712 });
    expect(miles).toBeGreaterThan(7);
    expect(miles).toBeLessThan(13);
    expect(milesBetween({ lat: 37.7, lon: -122.4 }, { lat: null, lon: null })).toBeNull();
  });
});

describe('NHTSA adapters', () => {
  const vehicle = { year: 2003, make: 'HONDA', model: 'ACCORD' };

  test('a recall is one row per vehicle it applies to', () => {
    const item = normaliseItem(
      recallToItem(
        {
          NHTSACampaignNumber: '19V182000',
          Component: 'AIR BAGS:FRONTAL:DRIVER SIDE:INFLATOR MODULE',
          Summary: 'Honda is recalling specific vehicles.',
          Consequence: 'An inflator explosion may result in injury.',
          Remedy: 'Honda will replace the inflator free of charge.',
          ReportReceivedDate: '06/03/2019',
          parkIt: true,
          parkOutSide: false,
        },
        vehicle,
      ),
    );
    expect(item.externalId).toBe('19V182000|2003|honda|accord');
    expect(item.kind).toBe('recall');
    expect(item.tags).toContain('do-not-drive');
    expect(item.tags).toContain('honda');
    expect(item.tags).toContain('2003');
    expect(item.data.campaign).toBe('19V182000');
    expect(item.publishedAt.toISOString()).toStartWith('2019-06-03');
    expect(item.data.redistribution).toBe('public-domain');
  });

  test('a complaint keeps injuries, deaths and the partial VIN only', () => {
    const item = normaliseItem(
      complaintToItem(
        {
          odiNumber: 11746949,
          components: 'AIR BAGS',
          crash: true,
          fire: false,
          numberOfInjuries: 1,
          numberOfDeaths: 0,
          dateOfIncident: '06/18/2026',
          dateComplaintFiled: '06/27/2026',
          vin: 'JHMCM56323C',
          summary: 'The vehicle was rear-ended.',
        },
        vehicle,
      ),
    );
    expect(item.externalId).toBe('odi-11746949');
    expect(item.tags).toContain('crash');
    expect(item.tags).toContain('injury');
    expect(item.tags).not.toContain('fatality');
    // A partial VIN is what NHTSA publishes; it identifies no one.
    expect(item.data.vinPrefix.length).toBeLessThan(17);
  });

  test('an unrated crash test does not become a zero', () => {
    const item = ratingToItem(
      {
        VehicleId: 9096,
        VehicleDescription: '2015 Honda Accord 4 DR FWD',
        OverallRating: 'Not Rated',
        RolloverRating: '4',
      },
      { year: 2015, make: 'Honda', model: 'Accord' },
    );
    expect(item.data.overall).toBeNull();
    expect(item.data.rollover).toBe('4');
  });

  test('years walk newest first and respect an explicit list', () => {
    const now = new Date('2026-09-06T00:00:00Z');
    expect(yearsFor({ yearsBack: 2 }, now)).toEqual([2027, 2026, 2025]);
    expect(yearsFor({ years: [1998, 2001, 1998] }, now)).toEqual([2001, 1998]);
  });

  test('the walk moves to the next year only when the makes run out', () => {
    expect(advance({ yearIdx: 0, makeIdx: 5, makeCount: 12, yearCount: 3 })).toEqual({
      yearIdx: 0,
      makeIdx: 5,
      done: false,
    });
    expect(advance({ yearIdx: 2, makeIdx: 12, makeCount: 12, yearCount: 3 })).toEqual({
      yearIdx: 0,
      makeIdx: 0,
      done: true,
    });
  });

  test('tags identify a vehicle the several ways a feed might ask', () => {
    expect(vehicleTags(2003, 'HONDA', 'CIVIC HATCHBACK')).toEqual([
      '2003',
      'honda',
      'civic-hatchback',
      'honda-civic-hatchback',
    ]);
  });
});

describe('vehicle catalogue', () => {
  test('a menu of one is still a list', () => {
    expect(menuList({ menuItem: { text: 'Auto', value: '42071' } })).toHaveLength(1);
    expect(menuList({ menuItem: [{ value: '1' }, { value: '2' }] })).toHaveLength(2);
    expect(menuList({})).toEqual([]);
  });

  test('the EPA’s -1 means "not applicable", not minus one', () => {
    const spec = specOf({ city08: '18', comb08: '18', range: '-1', displ: '3.0', cylinders: '6' });
    expect(spec.mpgCity).toBe(18);
    expect(spec.electricRange).toBeNull();
    expect(spec.engineLitres).toBe(3);
  });

  test('a model year is one item, keyed so a re-fetch updates it', () => {
    const item = normaliseItem(
      modelToItem({
        year: 2019,
        make: 'Subaru',
        model: 'Outback',
        trims: [{ text: 'Auto(AV-S8), 4 cyl, 2.5 L', value: '40161' }],
        spec: specOf({
          comb08: '28',
          displ: '2.5',
          cylinders: '4',
          drive: 'All-Wheel Drive',
          fuelType: 'Regular',
        }),
      }),
    );
    expect(item.externalId).toBe('2019|subaru|outback');
    expect(item.kind).toBe('model');
    expect(item.tags).toContain('subaru-outback');
    expect(item.title).toBe('2019 Subaru Outback');
    expect(item.data.spec.mpgCombined).toBe(28);
  });
});

describe('AI incidents', () => {
  test('an AIID report links to the reporting and to the incident it evidences', () => {
    const item = normaliseItem(
      aiidItem({
        title: { text: 'When AI Takes Notes' },
        description: {
          text: 'A court let the claims proceed. (https://incidentdatabase.ai/cite/1650#7893)',
        },
        guid: { text: '59d195b7-5a85-5c13-b959-566758d65f7e' },
        link: { text: 'https://www.sheppard.com/insights/blogs/when-ai-takes-notes' },
        pubDate: { text: 'Sat, 05 Sep 2026 00:00:00 GMT' },
      }),
    );
    expect(item.data.incidentId).toBe(1650);
    expect(item.data.reportId).toBe(7893);
    expect(item.url).toContain('sheppard.com');
    // The cite URL is a field, not trailing noise in the summary.
    expect(item.summary).not.toContain('incidentdatabase.ai/cite');
    expect(item.data.redistribution).toBe('cc-by-sa-4.0');
  });

  test('a description with no cite still makes an item', () => {
    expect(citeOf('no link here')).toEqual({ incidentId: null, reportId: null, citeUrl: null });
  });

  test('Rogue AI Tracker is indexed by reference: sources kept, review body dropped', () => {
    const item = normaliseItem(
      incidentToItem({
        id: 'openai-attributed-dsewiki-agent-swarm-2026-09-04',
        slug: 'openai-attributed-dsewiki-agent-swarm',
        title: 'OpenAI-attributed agents commandeered DseWiki',
        summary: 'Researchers reconstructed about 18,000 posts.',
        details: 'THE FULL REVIEW BODY THAT IS THEIRS',
        whyItMatters: 'ALSO THEIRS',
        occurredAt: '2026-05-24T12:00:00Z',
        sourceName: 'Nightingale Collective',
        sourceUrl: 'https://example.org/report',
        additionalSources: [{ name: 'TechCrunch', url: 'https://techcrunch.com/x' }],
        tags: ['Scope breach', 'Persistence'],
      }),
    );
    const blob = JSON.stringify(item);
    expect(blob).not.toContain('THE FULL REVIEW BODY');
    expect(blob).not.toContain('ALSO THEIRS');
    expect(item.data.sources).toHaveLength(2);
    expect(item.data.primarySource).toBe('https://example.org/report');
    expect(item.tags).toContain('reference-only');
    expect(item.tags).toContain('scope-breach');
    expect(item.data.redistribution).toBe('reference');
  });

  test('research entries drop fullText and eli5 the same way', () => {
    const item = normaliseItem(
      researchToItem({
        id: 'r1',
        slug: 'r1',
        title: 'Shared project state',
        summary: 'Dozens of agents.',
        fullText: 'THE WHOLE ARTICLE',
        eli5: 'SIMPLE VERSION',
        publishedAt: '2026-09-04T12:00:00Z',
        sourceUrl: 'https://example.org/paper',
        clusters: ['Coordination'],
        keyClaims: ['a claim'],
      }),
    );
    const blob = JSON.stringify(item);
    expect(blob).not.toContain('THE WHOLE ARTICLE');
    expect(blob).not.toContain('SIMPLE VERSION');
    expect(item.data.keyClaims).toEqual(['a claim']);
    expect(item.tags).toContain('reference-only');
  });
});
