import { describe, expect, test } from 'bun:test';

// As in automotive.test.js: the config reads the environment at import and the
// library pulls in the database module for its caches. Nothing here connects.
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';

const {
  accidentEvidence,
  bandOf,
  buildKey,
  classifyBrands,
  conditionRating,
  gradeOf,
  HISTORY_ELSEWHERE,
  historyReport,
  normaliseHistory,
  odometerRollback,
  splitByBuild,
  timelineOf,
  usDate,
} = await import('../apps/web/src/lib/vin-history.js');

const VIN = '1HGCM82633A004352';

/** A complaint the way NHTSA actually returns one. */
const complaint = (over = {}) => ({
  odiNumber: 11000000 + Math.floor(Math.random() * 1000),
  crash: false,
  fire: false,
  numberOfInjuries: 0,
  numberOfDeaths: 0,
  dateOfIncident: '06/18/2024',
  dateComplaintFiled: '06/27/2024',
  vin: VIN.slice(0, 11),
  components: 'AIR BAGS',
  summary: 'Something happened.',
  ...over,
});

describe('the exact build', () => {
  test('a build key is the VIN without its serial', () => {
    expect(buildKey(VIN)).toBe('1HGCM82633A');
    expect(buildKey(VIN)).toHaveLength(11);
    expect(buildKey('short')).toBeNull();
  });

  test('matches NHTSA’s partial VIN, and only on all eleven characters', () => {
    const rows = [
      complaint({ vin: '1HGCM82633A' }),
      // Same model, different plant or specification: ten characters agree and
      // the eleventh does not, which is exactly the case that must not match.
      complaint({ vin: '1HGCM82633B' }),
      complaint({ vin: '' }),
    ];
    const { sameBuild, sameModel } = splitByBuild(rows, VIN);
    expect(sameBuild).toHaveLength(1);
    expect(sameModel).toHaveLength(2);
  });

  test('a complaint filed without a partial VIN still counts for the model', () => {
    const { sameBuild, sameModel, withPartialVin } = splitByBuild(
      [complaint({ vin: null }), complaint()],
      VIN,
    );
    expect(sameBuild).toHaveLength(1);
    expect(sameModel).toHaveLength(1);
    // The floor, not the ceiling: what could be attributed at all.
    expect(withPartialVin).toBe(1);
  });

  test('with no VIN nothing is claimed about a build', () => {
    const { sameBuild, key } = splitByBuild([complaint()], null);
    expect(key).toBeNull();
    expect(sameBuild).toHaveLength(0);
  });

  test('NHTSA’s MM/DD/YYYY sorts as a date, not as a string', () => {
    expect(usDate('06/18/2024')).toBe('2024-06-18');
    expect(usDate('not a date')).toBeNull();
    expect(usDate('12/01/2023') < usDate('01/02/2024')).toBe(true);
  });
});

describe('accident evidence', () => {
  const rows = [
    complaint({ crash: true, numberOfInjuries: 1 }),
    complaint({ fire: true, vin: '1HGCM82633A' }),
    complaint({ crash: true, vin: '1HGCM82633B' }),
    complaint(),
  ];

  test('counts the build and the model year separately', () => {
    const e = accidentEvidence(rows, VIN);
    expect(e.build.complaints).toBe(3);
    expect(e.build.crashes).toBe(1);
    expect(e.build.fires).toBe(1);
    expect(e.model.complaints).toBe(4);
    expect(e.model.crashes).toBe(2);
  });

  test('every incident says whether it is this build or merely this model', () => {
    const e = accidentEvidence(rows, VIN);
    expect(e.incidents.every((i) => typeof i.sameBuild === 'boolean')).toBe(true);
    expect(e.incidents.filter((i) => i.sameBuild)).toHaveLength(2);
  });

  test('the note never lets a matched build be read as this car', () => {
    const e = accidentEvidence(rows, VIN);
    expect(e.note).toContain('not on this one');
  });

  test('says how much of the pile could be attributed at all', () => {
    const e = accidentEvidence(rows, VIN);
    expect(e.attributable).toEqual({ withPartialVin: 4, of: 4, matched: 3 });
  });
});

describe('title brands', () => {
  test('sorts the brands that stop a sale from the ones that slow it down', () => {
    const c = classifyBrands(['SALVAGE', 'Rebuilt', 'Flood Damage', 'Lien']);
    expect(c.severe).toEqual(['SALVAGE', 'Flood Damage']);
    expect(c.caution).toEqual(['Rebuilt']);
    expect(c.other).toEqual(['Lien']);
  });

  test('reads the same event however a DMV spelled it', () => {
    for (const brand of ['FLOOD', 'Water Damage', 'flood damage']) {
      expect(classifyBrands([brand]).severe).toHaveLength(1);
    }
  });

  test('an odometer that goes backwards is caught, a typo is not', () => {
    expect(
      odometerRollback([
        { miles: 40_000, date: '2019-01-01' },
        { miles: 12_000, date: '2021-01-01' },
      ]).rollback,
    ).toBe(true);
    // A hundred miles the wrong way is a title clerk, not a crime.
    expect(
      odometerRollback([
        { miles: 40_000, date: '2019-01-01' },
        { miles: 39_900, date: '2021-01-01' },
      ]).rollback,
    ).toBe(false);
  });

  test('a provider payload is normalised without dropping what it sent', () => {
    const n = normaliseHistory({
      titles: [{ state: 'TX', date: '2020-02-01', odometer: 51_000, brands: ['SALVAGE'] }],
      insurance: [{ reportingEntity: 'An insurer', totalLoss: true, date: '2019-11-02' }],
      unexpectedField: 'kept',
    });
    expect(n.brands).toEqual(['SALVAGE']);
    expect(n.insurance[0].totalLoss).toBe(true);
    expect(n.odometers).toHaveLength(1);
    // Whatever we failed to understand is still there to be read.
    expect(n.raw.unexpectedField).toBe('kept');
  });
});

describe('the rating', () => {
  const clean = {
    recalls: [],
    evidence: {
      build: { complaints: 40, crashes: 0, fires: 0, injuries: 0, deaths: 0 },
      model: { complaints: 40, crashes: 0, fires: 0, injuries: 0, deaths: 0 },
    },
    ncap: { overall: '5' },
    modelYear: new Date().getUTCFullYear(),
  };

  test('a clean, new, five-star car with a checked title scores at the top', () => {
    const r = conditionRating({
      ...clean,
      history: { available: true, brands: [], classified: { severe: [], caution: [] } },
    });
    expect(r.score).toBe(100);
    expect(r.grade).toBe('A');
    expect(r.confidence).toBe('high');
  });

  test('a do-not-drive order is the heaviest single deduction', () => {
    const r = conditionRating({
      ...clean,
      recalls: [{ campaign: '24V001', component: 'AIR BAGS', doNotDrive: true }],
    });
    const recall = r.factors.find((f) => f.key === 'recall-campaigns');
    expect(recall.points).toBeLessThanOrEqual(-30);
    expect(r.score).toBeLessThan(75);
  });

  test('a recall factor refuses to be read as a verdict on this VIN', () => {
    const r = conditionRating({
      ...clean,
      recalls: [{ campaign: '24V001', component: 'AIR BAGS' }],
    });
    const recall = r.factors.find((f) => f.key === 'recall-campaigns');
    expect(recall.remediable).toBe(true);
    expect(recall.scope).toBe('model-year');
    // NHTSA's free data answers by model year, not by VIN, and the factor says so.
    expect(recall.note).toContain('not confirmed open recalls on this VIN');
    expect(recall.checkThisVin).toContain('nhtsa.gov/recalls');
  });

  test('an old car is not condemned for a long recall history', () => {
    const many = Array.from({ length: 24 }, (_, i) => ({ campaign: `C${i}`, component: 'X' }));
    // Twenty-four campaigns over twenty-three years is ordinary; the same
    // twenty-four in a two-year-old car is not, and the score separates them.
    const old = conditionRating({ ...clean, modelYear: 2003, recalls: many });
    const recent = conditionRating({
      ...clean,
      modelYear: new Date().getUTCFullYear() - 2,
      recalls: many,
    });
    const points = (r) => r.factors.find((f) => f.key === 'recall-campaigns').points;
    expect(points(old)).toBeGreaterThan(points(recent));
    expect(points(old)).toBeGreaterThan(-10);
  });

  test('crashes are scored as a rate, so a popular model is not punished for selling', () => {
    const small = conditionRating({
      ...clean,
      evidence: {
        build: { complaints: 100, crashes: 10, fires: 0, injuries: 0, deaths: 0 },
        model: { complaints: 100, crashes: 10, fires: 0, injuries: 0, deaths: 0 },
      },
    });
    const big = conditionRating({
      ...clean,
      evidence: {
        build: { complaints: 10_000, crashes: 1000, fires: 0, injuries: 0, deaths: 0 },
        model: { complaints: 10_000, crashes: 1000, fires: 0, injuries: 0, deaths: 0 },
      },
    });
    expect(small.score).toBe(big.score);
  });

  test('an unrated car is not scored as a badly rated one', () => {
    const rated = conditionRating({ ...clean, ncap: { overall: '5' } });
    const unrated = conditionRating({ ...clean, ncap: null });
    expect(unrated.score).toBe(rated.score);
    expect(unrated.unknown.map((u) => u.key)).toContain('crash-test');
  });

  test('a missing title record lowers confidence rather than raising the score', () => {
    const withTitle = conditionRating({
      ...clean,
      history: { available: true, brands: [], classified: { severe: [], caution: [] } },
    });
    const without = conditionRating({ ...clean, history: { available: false } });
    expect(without.score).toBe(withTitle.score);
    expect(without.confidence).not.toBe('high');
    const gap = without.unknown.find((u) => u.key === 'title-record');
    expect(gap.weight).toBe('major');
  });

  test('an unchecked title is named in what the report does not cover', () => {
    const r = conditionRating({ ...clean, history: { available: false } });
    expect(r.notCovered.join(' ')).toContain('NMVTIS');
    const checked = conditionRating({
      ...clean,
      history: { available: true, brands: [], classified: { severe: [], caution: [] } },
    });
    expect(checked.notCovered.join(' ')).not.toContain('NMVTIS');
  });

  test('a salvage brand and a total loss drive the grade to the bottom', () => {
    const r = conditionRating({
      ...clean,
      history: {
        available: true,
        brands: ['SALVAGE'],
        classified: { severe: ['SALVAGE'], caution: [] },
        insurance: [{ totalLoss: true }],
        junkSalvage: [{ reportingEntity: 'A yard' }],
      },
    });
    expect(r.grade).toBe('F');
    expect(r.factors.find((f) => f.key === 'title-record').permanent).toBe(true);
  });

  test('too few complaints is scored as unknown, not as clean', () => {
    const r = conditionRating({
      ...clean,
      evidence: {
        build: { complaints: 2, crashes: 0, fires: 0, injuries: 0, deaths: 0 },
        model: { complaints: 2, crashes: 0, fires: 0, injuries: 0, deaths: 0 },
      },
    });
    expect(r.factors.map((f) => f.key)).not.toContain('crash-complaints');
    expect(r.unknown.map((u) => u.key)).toContain('crash-complaints');
  });

  test('a small build sample falls back to the model year and says which it used', () => {
    const r = conditionRating({
      ...clean,
      evidence: {
        build: { complaints: 4, crashes: 4, fires: 0, injuries: 0, deaths: 0 },
        model: { complaints: 400, crashes: 4, fires: 0, injuries: 0, deaths: 0 },
      },
    });
    expect(r.factors.find((f) => f.key === 'crash-complaints').scope).toBe('same-model-year');
  });

  test('a build with no crashes but too small a sample does not score as clean', () => {
    // The real case that produced this rule: 24 complaints on one build, none
    // of them a crash, while the model year runs at 7.8%. Twenty-four is not
    // enough to have seen a crash even at that rate, so the wider pool answers.
    const r = conditionRating({
      ...clean,
      evidence: {
        build: { complaints: 24, crashes: 0, fires: 0, injuries: 0, deaths: 0 },
        model: { complaints: 2013, crashes: 158, fires: 19, injuries: 157, deaths: 1 },
      },
    });
    const crash = r.factors.find((f) => f.key === 'crash-complaints');
    expect(crash.scope).toBe('same-model-year');
    // The build's empty crash column must not become a 0% claim about the car.
    expect(crash.evidence).toContain('158 of 2013');
    expect(crash.evidence).not.toContain('0 of 24');
  });

  test('an ordinary rate costs nothing, and a bad one costs a lot', () => {
    const pool = (crashes) => ({
      build: { complaints: 1000, crashes, fires: 0, injuries: 0, deaths: 0 },
      model: { complaints: 1000, crashes, fires: 0, injuries: 0, deaths: 0 },
    });
    const baseline = { complaints: 500_000, crashRate: 0.08, fireRate: 0.015, harmRate: 0.09 };
    const points = (crashes) =>
      conditionRating({ ...clean, baseline, evidence: pool(crashes) }).factors.find(
        (f) => f.key === 'crash-complaints',
      ).points;
    // At the population average a car is not marked down for existing.
    expect(points(80)).toBe(0);
    expect(points(240)).toBeLessThan(-15);
  });

  test('the payload says whether ordinary was measured or assumed', () => {
    const measured = conditionRating({
      ...clean,
      baseline: { complaints: 500_000, crashRate: 0.08, fireRate: 0.015, harmRate: 0.09 },
    });
    expect(measured.comparedAgainst.basis).toBe('measured-baseline');
    expect(measured.comparedAgainst.complaints).toBe(500_000);
    const assumed = conditionRating(clean);
    expect(assumed.comparedAgainst.basis).toBe('reference-threshold');
    expect(assumed.comparedAgainst.note).toContain('our judgement, not a measurement');
  });

  test('age alone cannot fail a car that has nothing else against it', () => {
    // The case that forced the recalibration: a twenty-three-year-old car with
    // an ordinary complaint record and a long-since-remedied recall history
    // is not an F. Grading every old car alike ranks nothing.
    const r = conditionRating({
      ...clean,
      modelYear: 2003,
      miles: 165_000,
      recalls: Array.from({ length: 24 }, (_, i) => ({ campaign: `C${i}`, component: 'X' })),
      evidence: {
        build: { complaints: 24, crashes: 0, fires: 0, injuries: 0, deaths: 0 },
        model: { complaints: 2013, crashes: 158, fires: 19, injuries: 157, deaths: 1 },
      },
      ncap: null,
    });
    expect(r.score).toBeGreaterThanOrEqual(75);
    expect(['A', 'B', 'C']).toContain(r.grade);
  });

  test('a mistyped VIN is flagged rather than silently decoded', () => {
    const r = conditionRating({ ...clean, identity: { checkDigitOk: false } });
    expect(r.factors.map((f) => f.key)).toContain('vin-integrity');
  });

  test('mileage is scored but marked as the caller’s word', () => {
    const r = conditionRating({ ...clean, miles: 180_000 });
    const m = r.factors.find((f) => f.key === 'mileage');
    expect(m.unverified).toBe(true);
    expect(m.points).toBeLessThan(0);
  });

  test('the score never leaves its range however bad the car is', () => {
    const r = conditionRating({
      recalls: Array.from({ length: 40 }, () => ({ doNotDrive: true, parkOutside: true })),
      evidence: {
        build: { complaints: 100, crashes: 100, fires: 100, injuries: 400, deaths: 90 },
        model: { complaints: 100, crashes: 100, fires: 100, injuries: 400, deaths: 90 },
      },
      ncap: { overall: '1' },
      history: {
        available: true,
        brands: ['SALVAGE', 'JUNK', 'FLOOD'],
        classified: { severe: ['SALVAGE', 'JUNK', 'FLOOD'], caution: ['REBUILT'] },
        insurance: [{ totalLoss: true }],
        junkSalvage: [{}],
        odometer: { rollback: true, from: { miles: 200_000 }, to: { miles: 20_000 } },
      },
      modelYear: 1998,
      miles: 400_000,
    });
    expect(r.score).toBe(0);
    expect(r.grade).toBe('F');
  });

  test('grades and bands line up at the boundaries', () => {
    expect(gradeOf(90)).toBe('A');
    expect(gradeOf(89)).toBe('B');
    expect(gradeOf(59)).toBe('F');
    expect(bandOf(95)).toContain('Nothing outstanding');
    expect(bandOf(10)).toContain('Do not buy');
  });

  test('the disclaimer refuses the comparison a reader will otherwise make', () => {
    const r = conditionRating(clean);
    expect(r.disclaimer).toContain('not an inspection');
    expect(r.disclaimer).toContain('not a vehicle history report');
  });
});

describe('the timeline', () => {
  test('merges recalls, incidents and title events newest first', () => {
    const rows = timelineOf({
      recalls: [{ reportReceived: '01/05/2020', component: 'BRAKES', summary: 's', url: 'u' }],
      evidence: {
        incidents: [
          {
            date: '2023-06-01',
            crash: true,
            components: 'AIR BAGS',
            sameBuild: true,
            summary: 's',
          },
        ],
      },
      history: {
        available: true,
        titles: [{ date: '2021-03-02', state: 'TX', brands: [], odometer: 40_000 }],
      },
    });
    expect(rows.map((r) => r.date)).toEqual(['2023-06-01', '2021-03-02', '2020-01-05']);
  });

  test('scope is on every row, so this car and cars like it never look the same', () => {
    const rows = timelineOf({
      recalls: [{ reportReceived: '01/05/2020', component: 'BRAKES' }],
      evidence: { incidents: [{ date: '2023-06-01', crash: true, sameBuild: true }] },
      history: { available: true, junkSalvage: [{ date: '2022-01-01' }] },
    });
    expect(rows.find((r) => r.type === 'salvage').scope).toBe('this-vehicle');
    expect(rows.find((r) => r.type === 'crash').scope).toBe('same-build');
    expect(rows.find((r) => r.type === 'recall').scope).toBe('model-year');
  });

  test('a salvage or total-loss entry is always critical', () => {
    const rows = timelineOf({
      history: {
        available: true,
        junkSalvage: [{ date: '2022-01-01' }],
        insurance: [{ date: '2022-02-01', totalLoss: true }],
      },
    });
    expect(rows.every((r) => r.severity === 'critical')).toBe(true);
  });
});

describe('the licensed half', () => {
  test('with no provider configured the report refuses to imply a clean title', async () => {
    const h = await historyReport(VIN);
    expect(h.available).toBe(false);
    expect(h.reason).toBe('no-provider-configured');
    expect(h.explanation).toContain('not the same as this VIN having a clean title');
    expect(h.titles).toBeUndefined();
    expect(h.brands).toBeUndefined();
  });

  test('and says where to get it, including the free one', async () => {
    const h = await historyReport(VIN);
    expect(h.elsewhere).toEqual(HISTORY_ELSEWHERE);
    expect(h.elsewhere.some((p) => p.cost.includes('free'))).toBe(true);
    // The one no database holds, said out loud.
    expect(h.elsewhere.some((p) => p.covers.includes('never reached a title'))).toBe(true);
  });
});
