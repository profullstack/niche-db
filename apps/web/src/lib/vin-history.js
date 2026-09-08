import { config } from '@nichedb/config';
import * as auto from '@nichedb/db/automotive';

/**
 * The history report, and an honest line down the middle of it.
 *
 * People arrive at a VIN box wanting the thing Carfax sells: has this car been
 * wrecked, was it written off, is the odometer real, how many owners. That
 * question has two halves and they are not the same kind of fact, so this
 * module keeps them apart and says which is which in every payload.
 *
 * The licensed half. Title brands, total-loss records, odometer readings at
 * each title transfer and salvage-yard entries come from NMVTIS, the federal
 * title system, and NMVTIS is sold per report through approved providers. It
 * cannot be scraped and it is not free. So `history` is provider-backed: with
 * a provider configured it returns real records, and with none configured it
 * returns `available: false` and points at where to buy one. It never returns
 * an empty record list that a reader could mistake for a clean history — a
 * silence we cannot hear is not the same as a car with nothing on it, and
 * conflating those two is the one thing a report like this must not do.
 *
 * The free half, which is most of what is here. NHTSA publishes every owner
 * complaint with an eleven-character partial VIN, and eleven characters is the
 * whole VIN except the serial: manufacturer, body, engine, restraint system,
 * check digit, model year and assembly plant. So a complaint carrying our
 * first eleven characters is not merely about the same model, it is about a
 * car built to the same specification in the same plant in the same year. When
 * one of those complaints is marked `crash` or `fire`, that is as close to an
 * accident record as public data gets, and it is genuinely useful — but it is
 * still not this car, and the payload says so at every level rather than once
 * in a footnote.
 *
 * The rating is computed from those halves with every deduction itemised. A
 * score whose factors are not printed is a number to be argued with; a score
 * that shows its work is a summary of evidence the reader can check.
 */

const UA = 'nichedb.dev automotive (+https://nichedb.dev)';

/* ------------------------------------------------------- the exact build -- */

/**
 * Positions 1-11 of a VIN: everything except the serial number.
 *
 * This is what NHTSA publishes on a complaint, and it is deliberate on their
 * part — it describes the vehicle without identifying the vehicle. Two cars
 * sharing these eleven characters left the same plant in the same model year
 * built to the same specification, which is exactly the population a defect
 * lives in.
 */
export function buildKey(vin) {
  const v = String(vin ?? '').toUpperCase();
  return v.length >= 11 ? v.slice(0, 11) : null;
}

/**
 * Split a model's complaints into the ones about this exact build and the rest.
 *
 * NHTSA's partial VIN is often blank — a complaint filed without one still
 * counts for the model, so it lands in the wider bucket rather than being
 * dropped. `matched` is therefore a floor and never an upper bound, which is
 * the right direction for a number a person may act on.
 */
export function splitByBuild(rows, vin) {
  const key = buildKey(vin);
  const sameBuild = [];
  const sameModel = [];
  for (const r of rows ?? []) {
    const partial = String(r.vin ?? '')
      .toUpperCase()
      .trim();
    if (key && partial && partial.length >= 11 && partial.slice(0, 11) === key) sameBuild.push(r);
    else sameModel.push(r);
  }
  return { sameBuild, sameModel, key, withPartialVin: (rows ?? []).filter((r) => r.vin).length };
}

const harmOf = (rows) => {
  let crashes = 0;
  let fires = 0;
  let injuries = 0;
  let deaths = 0;
  for (const r of rows) {
    if (r.crash) crashes++;
    if (r.fire) fires++;
    injuries += Number(r.numberOfInjuries) || 0;
    deaths += Number(r.numberOfDeaths) || 0;
  }
  return { complaints: rows.length, crashes, fires, injuries, deaths };
};

/** NHTSA writes dates MM/DD/YYYY. Sorting those as strings puts December first. */
export function usDate(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(s ?? '').trim());
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
}

/**
 * What owners of this exact build have reported, and what it cost them.
 *
 * Reported at two levels because the two answer different questions. The build
 * level answers "has a car like mine, from my plant and year, been in this
 * kind of crash" — small samples, high relevance. The model level answers "is
 * this model dangerous" — large samples, lower relevance to the individual
 * car. Presenting only one of them would be a choice about which question the
 * reader is allowed to ask.
 */
export function accidentEvidence(complaintRows, vin, { sample = 10 } = {}) {
  const { sameBuild, sameModel, key, withPartialVin } = splitByBuild(complaintRows, vin);
  const all = [...sameBuild, ...sameModel];

  const incident = (r, exact) => ({
    odiNumber: r.odiNumber,
    date: usDate(r.dateOfIncident) ?? usDate(r.dateComplaintFiled),
    filed: usDate(r.dateComplaintFiled),
    components: r.components ?? null,
    crash: Boolean(r.crash),
    fire: Boolean(r.fire),
    injuries: Number(r.numberOfInjuries) || 0,
    deaths: Number(r.numberOfDeaths) || 0,
    // Said on every row, not inferred from which array it came out of: an
    // agent reading this JSON should not have to know our bucket names.
    sameBuild: exact,
    partialVin: r.vin ?? null,
    summary: String(r.summary ?? '')
      .replace(/\s+/g, ' ')
      .slice(0, 500),
    url: r.odiNumber
      ? `https://www.nhtsa.gov/?nhtsaId=${encodeURIComponent(r.odiNumber)}`
      : 'https://www.nhtsa.gov/recalls',
  });

  const harmful = (rows, exact) =>
    rows
      .filter((r) => r.crash || r.fire || r.numberOfInjuries > 0 || r.numberOfDeaths > 0)
      .map((r) => incident(r, exact));

  const incidents = [...harmful(sameBuild, true), ...harmful(sameModel, false)].sort((a, b) =>
    String(b.date ?? '').localeCompare(String(a.date ?? '')),
  );

  return {
    build: { key, ...harmOf(sameBuild) },
    model: { ...harmOf(all) },
    // How much of the model's complaint pile could be attributed at all. A low
    // number here is why a build-level count of zero means very little.
    attributable: {
      withPartialVin,
      of: all.length,
      matched: sameBuild.length,
    },
    incidents: incidents.slice(0, sample),
    incidentsTotal: incidents.length,
    basis: 'nhtsa-complaints',
    note: key
      ? `Matched on VIN positions 1-11 (${key}), which identify the model year, specification and assembly plant but not the individual vehicle. These are incidents reported on vehicles built like this one, not on this one.`
      : 'No VIN given, so nothing could be matched to a specific build; these counts are for the model year.',
    source: 'NHTSA owner complaints, US public domain',
  };
}

/* ------------------------------------------------------ the licensed half -- */

/**
 * Title brands, total losses and odometer readings: NMVTIS, through a provider.
 *
 * NMVTIS is the federal title database. Its records are the ones that matter
 * for a used car — salvage, junk, flood, rebuilt, an insurer's total-loss
 * entry, the odometer reading recorded at each title transfer — and none of
 * them are published openly. Access is per report through providers approved
 * by the Department of Justice.
 *
 * So rather than pick one and hard-code its request shape, this takes a URL
 * template with `{vin}` in it, the way the parts vendors already take an
 * affiliate template. A deployment that has bought access supplies the
 * template its provider gave it and no code changes:
 *
 *   AUTOMOTIVE_HISTORY_URL="https://api.example.com/v2/report?key=K&vin={vin}"
 *   AUTOMOTIVE_HISTORY_HEADERS="authorization: Bearer K"
 *
 * With nothing configured this returns `available: false` and the places to
 * buy a report, including the free one — NICB's VINCheck covers theft and
 * insurer total-loss records at no cost, and a person who only wants to know
 * whether a car was stolen should be told that rather than sold something.
 */
export function historyProvider() {
  const url = config.automotive.historyUrl;
  return url?.includes('{vin}') ? { url, name: config.automotive.historyProvider } : null;
}

function parseHeaders(spec) {
  const out = {};
  for (const line of String(spec ?? '').split(/[\n,]/)) {
    const at = line.indexOf(':');
    if (at < 1) continue;
    const k = line.slice(0, at).trim();
    const v = line.slice(at + 1).trim();
    if (k && v) out[k.toLowerCase()] = v;
  }
  return out;
}

/**
 * Providers do not agree on field names, so normalise the ones they do share.
 *
 * Every NMVTIS report carries the same underlying record types whatever the
 * reseller calls them, and this maps the common spellings onto one shape. What
 * it will not do is guess: an unrecognised payload is returned whole under
 * `raw` and the normalised fields stay null, because a report that quietly
 * drops the brand that mattered is worse than one that hands over everything.
 */
export function normaliseHistory(payload) {
  const pick = (...names) => {
    for (const n of names) {
      const v = n.split('.').reduce((o, k) => (o == null ? o : o[k]), payload);
      if (v !== undefined && v !== null) return v;
    }
    return null;
  };
  const arr = (v) => (Array.isArray(v) ? v : v ? [v] : []);

  const titles = arr(pick('titles', 'titleRecords', 'nmvtis.titles')).map((t) => ({
    state: t.state ?? t.titleState ?? null,
    date: t.date ?? t.titleDate ?? null,
    odometer: Number(t.odometer ?? t.mileage) || null,
    odometerUnit: t.odometerUnit ?? 'miles',
    brands: arr(t.brands ?? t.brand).map((b) => String(b?.name ?? b)),
    current: Boolean(t.current),
  }));

  const brands = [
    ...new Set([
      ...titles.flatMap((t) => t.brands),
      ...arr(pick('brands', 'titleBrands')).map((b) => String(b?.name ?? b)),
    ]),
  ].filter(Boolean);

  const junkSalvage = arr(pick('junkAndSalvage', 'salvage', 'junk')).map((j) => ({
    reportingEntity: j.reportingEntity ?? j.name ?? null,
    date: j.date ?? j.obtainedDate ?? null,
    disposition: j.disposition ?? null,
    intendedForExport: Boolean(j.intendedForExport),
  }));

  const insurance = arr(pick('insurance', 'totalLoss', 'insuranceRecords')).map((i) => ({
    reportingEntity: i.reportingEntity ?? i.name ?? null,
    date: i.date ?? null,
    // The field that matters: an insurer declaring the car a total loss.
    totalLoss: i.totalLoss === undefined ? null : Boolean(i.totalLoss),
  }));

  const odometers = titles
    .filter((t) => t.odometer)
    .map((t) => ({ date: t.date, miles: t.odometer, state: t.state }))
    .sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')));

  return {
    titles,
    brands,
    junkSalvage,
    insurance,
    odometers,
    // Only claimed when the provider actually said so. Absent stays absent.
    theft: pick('theft', 'thefts') ?? null,
    owners: Number(pick('ownerCount', 'owners.count')) || null,
    raw: payload,
  };
}

/**
 * A brand that should stop a sale, and one that should slow it down.
 *
 * Kept as patterns rather than an enumeration because states do not use one
 * vocabulary: "flood", "water damage" and "flood damage" are the same event
 * written by three DMVs.
 */
const SEVERE_BRANDS = [
  /salvage/i,
  /junk/i,
  /\bflood\b|water damage/i,
  /total\s*loss/i,
  /dismantl/i,
  /scrap/i,
  /crush/i,
  /fire damage/i,
];
const CAUTION_BRANDS = [
  /rebuilt|reconstruct/i,
  /odometer|not actual|mileage discrepan|rollback/i,
  /lemon|manufacturer buyback/i,
  /hail/i,
  /theft|stolen/i,
  /taxi|police|fleet|rental|livery/i,
];

export function classifyBrands(brands) {
  const severe = (brands ?? []).filter((b) => SEVERE_BRANDS.some((re) => re.test(b)));
  const caution = (brands ?? []).filter(
    (b) => !severe.includes(b) && CAUTION_BRANDS.some((re) => re.test(b)),
  );
  return {
    severe,
    caution,
    other: (brands ?? []).filter((b) => !severe.includes(b) && !caution.includes(b)),
  };
}

/** Odometer readings that go backwards, which is the fraud this data exists to catch. */
export function odometerRollback(odometers) {
  const rows = (odometers ?? []).filter((o) => o.miles);
  for (let i = 1; i < rows.length; i++) {
    // A small backwards step is a typo at a title office; a big one is a crime.
    if (rows[i].miles + 1000 < rows[i - 1].miles) {
      return { rollback: true, from: rows[i - 1], to: rows[i] };
    }
  }
  return { rollback: false };
}

/**
 * Where to get the records we do not have.
 *
 * Printed whenever the licensed half is missing, because "we cannot tell you"
 * is only half an answer and the other half is short.
 */
export const HISTORY_ELSEWHERE = [
  {
    name: 'NICB VINCheck',
    url: 'https://www.nicb.org/vincheck',
    cost: 'free, five lookups a day',
    covers:
      'Theft records not yet recovered, and total-loss records from participating insurers. Not title brands.',
  },
  {
    name: 'NMVTIS approved providers',
    url: 'https://vehiclehistory.bja.ojp.gov/nmvtis_vehiclehistory',
    cost: 'usually $2 to $13 a report',
    covers:
      'The federal title record: brands (salvage, junk, flood, rebuilt), odometer readings at each title transfer, insurer total-loss entries and salvage-yard records.',
  },
  {
    name: 'A pre-purchase inspection',
    url: null,
    cost: 'usually $100 to $200',
    covers:
      'Repaired collision damage that never reached a title or an insurer, which is most of it. No database holds this.',
  },
];

export async function historyReport(
  vin,
  { refresh = false, ttlDays = config.automotive.historyTtlDays } = {},
) {
  const provider = historyProvider();
  if (!provider) {
    return {
      available: false,
      reason: 'no-provider-configured',
      // Stated positively so nobody reads a missing report as a clean one.
      explanation:
        'Title brands, total-loss records and odometer history come from NMVTIS, the federal title database, which is sold per report through approved providers. This deployment has no provider configured, so no title record has been checked for this VIN. That is not the same as this VIN having a clean title.',
      elsewhere: HISTORY_ELSEWHERE,
      basis: 'nmvtis-provider-required',
    };
  }

  if (!refresh) {
    const cached = await auto.getVinHistory(vin, ttlDays * 24 * 3600).catch(() => null);
    if (cached) {
      return {
        available: true,
        provider: cached.provider,
        cached: true,
        fetchedAt: cached.fetched_at,
        ...cached.report,
      };
    }
  }

  const url = provider.url.replaceAll('{vin}', encodeURIComponent(vin));
  const res = await fetch(url, {
    headers: {
      'user-agent': UA,
      accept: 'application/json',
      ...parseHeaders(config.automotive.historyHeaders),
    },
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null);

  if (!res?.ok) {
    return {
      available: false,
      reason: 'provider-error',
      explanation: `The configured history provider answered ${res ? res.status : 'nothing'}. No title record has been checked for this VIN.`,
      elsewhere: HISTORY_ELSEWHERE,
      basis: 'nmvtis-provider-required',
    };
  }

  const payload = await res.json().catch(() => null);
  if (!payload) {
    return {
      available: false,
      reason: 'provider-unreadable',
      explanation: 'The configured history provider did not return readable JSON.',
      elsewhere: HISTORY_ELSEWHERE,
      basis: 'nmvtis-provider-required',
    };
  }

  const normalised = normaliseHistory(payload);
  const report = {
    ...normalised,
    classified: classifyBrands(normalised.brands),
    odometer: odometerRollback(normalised.odometers),
    basis: 'nmvtis-provider',
    source: `NMVTIS via ${provider.name ?? 'the configured provider'}`,
  };
  await auto
    .putVinHistory({ vin, provider: provider.name ?? 'configured', report })
    .catch(() => {});
  return { available: true, provider: provider.name ?? 'configured', cached: false, ...report };
}

/* ----------------------------------------------------------- the rating -- */

/**
 * One hundred points, and every deduction shown.
 *
 * The grade is the part people look at and the factors are the part that makes
 * it worth looking at. Each factor carries what it took off, why, and which
 * upstream said so, so a seller who thinks the score is unfair can see exactly
 * which recall or which fire complaint is responsible and argue with that
 * instead of with a letter.
 *
 * Two rules run through the weighting. First, rates rather than totals: a
 * model that sold four million units collects more complaints than one that
 * sold forty thousand without being worse, so what counts is the share of its
 * complaints that involved a crash or a fire. Second, an unknown never scores
 * as a zero — a car with no crash test and no title record is not thereby a
 * safe car with a clean title, so those factors drop out of the total and pull
 * `confidence` down instead of quietly inflating the score.
 */
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export function conditionRating({
  recalls = [],
  evidence = null,
  ncap = null,
  history = null,
  identity = null,
  modelYear = null,
  miles = null,
  baseline = null,
  now = new Date(),
} = {}) {
  const factors = [];
  const unknown = [];
  // Negating a clamped zero gives -0, which serialises as -0 and renders on the
  // page as a deduction of minus nothing. Normalised here rather than at each
  // of the seven call sites.
  const add = (f) => {
    const points = Math.round(f.points * 10) / 10;
    factors.push({ ...f, points: points === 0 ? 0 : points });
  };

  /* Recall campaigns, and a careful word about what they are.
   *
   * NHTSA's free endpoint answers by year, make and model: it returns every
   * campaign ever issued against that model year, not the campaigns still open
   * against this VIN. Whether a specific car was in the affected batch, and
   * whether the dealer has since done the work, is answered only by NHTSA's
   * own by-VIN tool, which has no public API. So this must not be scored as
   * "twenty-four things wrong with this car" — a twenty-year-old model with
   * twenty campaigns behind it, nearly all long since remedied, is ordinary.
   *
   * What is not ordinary is a lot of campaigns in a short life, so the
   * deduction is campaigns per year rather than campaigns. A do-not-drive
   * order is scored flat and heavily whatever the age, because it is the
   * strongest thing NHTSA ever says and it does not weaken with time.
   */
  const year = Number(modelYear) || null;
  const age = year ? Math.max(1, now.getUTCFullYear() - year) : null;
  const urgent = recalls.filter((r) => r.doNotDrive);
  const outside = recalls.filter((r) => r.parkOutside && !r.doNotDrive);
  const perYear = age ? recalls.length / age : recalls.length;
  const recallPoints =
    -clamp((perYear - 0.5) * 8, 0, 16) - (urgent.length ? 30 : 0) - (outside.length ? 12 : 0);
  add({
    key: 'recall-campaigns',
    label: 'Recall campaigns for this model year',
    points: recallPoints,
    floor: -58,
    evidence: recalls.length
      ? `${recalls.length} campaign${recalls.length === 1 ? '' : 's'} issued against this model year${age ? `, about ${perYear.toFixed(1)} a year over ${age} years` : ''}${urgent.length ? `. ${urgent.length} carries a do-not-drive order` : ''}${outside.length ? `. ${outside.length} tells owners to park outside` : ''}.`
      : 'No recall campaigns on record for this model year.',
    detail: recalls.slice(0, 5).map((r) => ({ campaign: r.campaign, component: r.component })),
    source: 'NHTSA recalls, by model year',
    scope: 'model-year',
    remediable: true,
    // The correction that keeps this factor from being read as a verdict on
    // the individual car, with the one place that can answer that question.
    note: recalls.length
      ? 'These are campaigns against the model year, not confirmed open recalls on this VIN. NHTSA’s free data cannot say whether this car was in an affected batch or whether a dealer has already done the work. Check the VIN itself, free, at nhtsa.gov/recalls, and remember the repair is free at a franchised dealer.'
      : null,
    checkThisVin: 'https://www.nhtsa.gov/recalls',
  });

  /* Crashes and fires reported by owners, as a share of complaints. */
  const build = evidence?.build ?? null;
  const model = evidence?.model ?? null;
  /* The build sample is the more relevant one, and it is usually far too small
     to be a rate. Twenty-four complaints with no crash among them is not a
     zero-percent crash rate, it is a sample that would have shown nothing even
     at the model's own eight percent, and scoring it as clean would flatter
     the car for being obscure. So the build pool has to be genuinely large
     before it is used, and below that the model year answers — wider, less
     specific, and honestly labelled as such in `scope`. */
  const useBuild = (build?.complaints ?? 0) >= 100;
  const pool = useBuild ? build : model;
  if ((pool?.complaints ?? 0) >= 5) {
    const crashRate = pool.crashes / pool.complaints;
    const fireRate = pool.fires / pool.complaints;
    const harmRate = (pool.injuries + pool.deaths * 3) / pool.complaints;
    const scope = useBuild ? 'same-build' : 'same-model-year';
    const where = useBuild ? 'this exact build' : 'this model year';

    /* Scored against ordinary, not against perfect.
     *
     * A complaint rate means nothing without something to compare it to. Owners
     * who have been in a crash file more readily than owners who have not, so
     * every model on the road runs at some non-zero crash-complaint rate, and
     * deducting from zero marks down every car ever built equally — which is
     * the same as ranking nothing. So the comparison is the measured average
     * across every complaint this site has ingested, and a car pays only for
     * the distance it sits above ordinary.
     *
     * `baseline` is null when the corpus is too thin to average. Then these
     * fixed reference points stand in, and `basis` says which was used, because
     * a threshold we chose and a number we measured are not the same evidence.
     */
    const ref = baseline ?? { crashRate: 0.08, fireRate: 0.015, harmRate: 0.09 };
    const basis = baseline ? 'measured-baseline' : 'reference-threshold';
    const over = (rate, norm) => (norm > 0 ? rate / norm : 0);
    const says = (rate, norm, unit) => {
      const ratio = over(rate, norm);
      if (ratio <= 1.05)
        return `at or below the ${(norm * 100).toFixed(1)}% that is ordinary${unit}`;
      return `${ratio.toFixed(1)} times the ordinary rate of ${(norm * 100).toFixed(1)}%`;
    };
    const unit = baseline
      ? ` across the ${baseline.complaints.toLocaleString('en-US')} complaints this site has indexed`
      : ' for a vehicle of any kind';

    add({
      key: 'crash-complaints',
      label: 'Complaints involving a crash',
      // Nothing is taken off for being ordinary; the deduction starts above it.
      points: -clamp((over(crashRate, ref.crashRate) - 1) * 12, 0, 22),
      floor: -22,
      evidence: `${pool.crashes} of ${pool.complaints} complaints (${(crashRate * 100).toFixed(1)}%) on ${where} describe a crash: ${says(crashRate, ref.crashRate, unit)}.`,
      source: 'NHTSA owner complaints',
      scope,
      basis,
    });
    add({
      key: 'fire-complaints',
      label: 'Complaints involving a fire',
      points: -clamp((over(fireRate, ref.fireRate) - 1) * 10, 0, 18),
      floor: -18,
      evidence: `${pool.fires} of ${pool.complaints} complaints (${(fireRate * 100).toFixed(1)}%) describe a fire: ${says(fireRate, ref.fireRate, unit)}.`,
      source: 'NHTSA owner complaints',
      scope,
      basis,
    });
    add({
      key: 'injuries-and-deaths',
      label: 'Injuries and deaths reported',
      points: -clamp((over(harmRate, ref.harmRate) - 1) * 12, 0, 20),
      floor: -20,
      evidence: `${pool.injuries} injuries and ${pool.deaths} deaths across ${pool.complaints} complaints: ${says(harmRate, ref.harmRate, unit)}.`,
      source: 'NHTSA owner complaints',
      scope,
      basis,
    });
  } else {
    unknown.push({
      key: 'crash-complaints',
      label: 'Complaints involving a crash',
      why: 'Too few complaints on file to make a rate mean anything. Not scored, in either direction.',
    });
  }

  /* Where the complaints cluster. One component holding most of a car's
     complaints is what a systemic defect looks like from outside. */
  const top = evidence?.topComponent ?? null;
  if (top && (pool?.complaints ?? 0) >= 25) {
    const share = top.complaints / (model?.complaints || pool.complaints);
    // Some concentration is normal: a car has a handful of systems and
    // complaints do not spread evenly across them. Half of them naming one
    // system is the shape of a defect rather than of ordinary wear.
    if (share >= 0.4) {
      add({
        key: 'component-concentration',
        label: 'Complaints concentrated on one system',
        points: -clamp((share - 0.4) * 30, 0, 10),
        floor: -10,
        evidence: `${(share * 100).toFixed(0)}% of complaints name ${top.component}, which is the shape of a single recurring defect rather than of scattered wear.`,
        source: 'NHTSA owner complaints',
      });
    }
  }

  /* The crash test. Unrated is unknown, not average. */
  const stars = Number(ncap?.overall) || null;
  if (stars) {
    add({
      key: 'crash-test',
      label: 'NCAP crash-test rating',
      points: stars >= 5 ? 0 : -clamp((5 - stars) * 5, 0, 20),
      floor: -20,
      evidence: `${stars} out of 5 overall${ncap.frontal ? `, ${ncap.frontal} frontal` : ''}${ncap.side ? `, ${ncap.side} side` : ''}${ncap.rollover ? `, ${ncap.rollover} rollover` : ''}.`,
      source: 'NHTSA NCAP',
    });
  } else {
    unknown.push({
      key: 'crash-test',
      label: 'NCAP crash-test rating',
      why: 'NHTSA has not crash-tested this model year. An untested car is not a poorly rated one; the factor is left out.',
    });
  }

  /* The title record, when somebody paid for it. */
  if (history?.available) {
    const { severe, caution } = history.classified ?? classifyBrands(history.brands);
    const totalLoss = (history.insurance ?? []).some((i) => i.totalLoss);
    const salvageYard = (history.junkSalvage ?? []).length > 0;
    const rolled = history.odometer?.rollback ?? false;
    const points =
      -clamp(severe.length * 35, 0, 55) -
      (totalLoss ? 25 : 0) -
      (salvageYard ? 15 : 0) -
      (rolled ? 30 : 0) -
      clamp(caution.length * 8, 0, 16);
    add({
      key: 'title-record',
      label: 'Title brands and total-loss records',
      points,
      floor: -80,
      evidence:
        severe.length || caution.length || totalLoss || salvageYard || rolled
          ? [
              severe.length ? `Branded ${severe.join(', ')}.` : null,
              totalLoss ? 'An insurer recorded this vehicle as a total loss.' : null,
              salvageYard ? 'It appears in a salvage or junk yard report.' : null,
              rolled
                ? `Odometer went backwards: ${history.odometer.from.miles} miles then ${history.odometer.to.miles}.`
                : null,
              caution.length ? `Also carries ${caution.join(', ')}.` : null,
            ]
              .filter(Boolean)
              .join(' ')
          : 'No brands, total-loss records or salvage entries on the federal title record.',
      source: history.source ?? 'NMVTIS',
      permanent: true,
    });
  } else {
    unknown.push({
      key: 'title-record',
      label: 'Title brands, total loss, odometer history',
      why:
        history?.explanation ?? 'No NMVTIS provider is configured, so no title record was checked.',
      // The single most load-bearing absence in the whole report.
      weight: 'major',
    });
  }

  /* Age and mileage. Deliberately light.
   *
   * Neither is a defect. An old car with nothing against it is an old car with
   * nothing against it, and a report that grades one down to a D for having
   * survived twenty years is not measuring condition, it is measuring the
   * calendar — and it grades every twenty-year-old car alike, which tells a
   * buyer choosing between two of them nothing at all. They earn a few points
   * because wear is real and worth pricing, and no more than that. */
  if (year) {
    add({
      key: 'age',
      label: 'Age',
      points: -clamp((age - 12) * 0.6, 0, 6),
      floor: -6,
      evidence: `${age} model year${age === 1 ? '' : 's'} old. Age is wear, not a fault: it costs a few points and no more.`,
      source: 'VIN',
    });
  }
  if (Number.isFinite(miles) && miles > 0) {
    const perYear = year ? miles / age : null;
    add({
      key: 'mileage',
      label: 'Mileage',
      points: -clamp((miles - 120_000) / 30_000, 0, 6),
      floor: -6,
      evidence: `${miles.toLocaleString('en-US')} miles${perYear ? `, about ${Math.round(perYear).toLocaleString('en-US')} a year` : ''}.`,
      source: 'entered by the person asking, not verified',
      unverified: true,
    });
  } else {
    unknown.push({
      key: 'mileage',
      label: 'Mileage',
      why: 'No mileage given. Pass ?miles= to include it, or buy an NMVTIS report for the readings recorded at each title transfer.',
    });
  }

  /* The VIN itself. A failed check digit on a North American VIN usually means
     a typo, and occasionally means the number on the paperwork is invented. */
  if (identity?.checkDigitOk === false) {
    add({
      key: 'vin-integrity',
      label: 'VIN check digit',
      points: -8,
      floor: -8,
      evidence:
        'Position nine does not check out under ISO 3779. Usually a mistyped VIN; on a North American car it can also mean the number is not genuine.',
      source: 'ISO 3779',
    });
  }

  const deductions = factors.reduce((sum, f) => sum + f.points, 0);
  const score = Math.round(clamp(100 + deductions, 0, 100));

  /* Confidence is about coverage, not about the score. A 92 computed without a
     title record is a different object from a 92 computed with one, and the
     reader is entitled to know which they are holding. */
  const majorGaps = unknown.filter((u) => u.weight === 'major').length;
  const confidence =
    majorGaps === 0 && stars && (pool?.complaints ?? 0) >= 20
      ? 'high'
      : majorGaps === 0 || (pool?.complaints ?? 0) >= 20
        ? 'moderate'
        : 'low';

  return {
    score,
    grade: gradeOf(score),
    band: bandOf(score),
    confidence,
    factors: factors.sort((a, b) => a.points - b.points),
    unknown,
    // The part a Carfax report has and this one does not. Printed every time.
    notCovered: [
      'Police-reported accidents, and any collision an insurer did not write off.',
      'Repair and service records from dealers and independent shops.',
      'Number of previous owners, and whether it was a rental, fleet or lease car.',
      'Liens and repossessions.',
      ...(history?.available
        ? []
        : ['Title brands, insurer total-loss records and odometer readings (NMVTIS).']),
    ],
    basis: 'nichedb-computed',
    // Which yardstick the complaint factors were measured against, said in the
    // payload: a population average we measured and a threshold we chose are
    // different kinds of evidence and should never look identical.
    comparedAgainst: baseline
      ? {
          basis: 'measured-baseline',
          complaints: baseline.complaints,
          crashRate: Math.round(baseline.crashRate * 1000) / 1000,
          fireRate: Math.round(baseline.fireRate * 1000) / 1000,
          note: 'The average across every owner complaint this site has indexed. A model is scored on how far it sits above ordinary, not above zero.',
        }
      : {
          basis: 'reference-threshold',
          note: 'Not enough complaints indexed yet to measure a population average, so fixed reference rates were used instead. These are our judgement, not a measurement.',
        },
    disclaimer:
      'This rating is computed by nichedb from federal recall, complaint and crash-test data for this vehicle, plus whatever title record was available. It is a summary of published evidence about vehicles like this one, not an inspection of this one and not a vehicle history report. Nothing here is a substitute for a pre-purchase inspection.',
  };
}

export function gradeOf(score) {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

export function bandOf(score) {
  if (score >= 90) return 'Nothing outstanding against this vehicle in the public record.';
  if (score >= 80) return 'Minor issues in the public record. Worth reading the detail.';
  if (score >= 70) return 'Several issues on record. Get the recalls done and inspect it.';
  if (score >= 60) return 'Significant issues on record. Inspect before buying.';
  return 'Serious issues on record. Do not buy this without an inspection.';
}

/* ---------------------------------------------------------- the timeline -- */

/**
 * The report as a dated list, which is the shape people already read.
 *
 * A history report is understood as a timeline because that is how the events
 * happened, so recalls, harmful complaints on this build and any title events
 * we have are merged and sorted rather than kept in three lists that the
 * reader has to interleave themselves. Every entry carries `scope`, so an
 * event about this exact car and an event about cars like it are never left
 * looking the same.
 */
export function timelineOf({ recalls = [], evidence = null, history = null }) {
  const rows = [];

  for (const r of recalls) {
    rows.push({
      date: usDate(r.reportReceived),
      type: 'recall',
      scope: 'model-year',
      title: `Recall: ${r.component}`,
      detail: r.summary,
      severity: r.doNotDrive ? 'critical' : r.parkOutside ? 'high' : 'medium',
      url: r.url,
      source: 'NHTSA',
    });
  }

  for (const i of evidence?.incidents ?? []) {
    rows.push({
      date: i.date,
      type: i.fire ? 'fire' : i.crash ? 'crash' : 'harm',
      scope: i.sameBuild ? 'same-build' : 'model-year',
      title: `${i.fire ? 'Fire' : i.crash ? 'Crash' : 'Injury'} reported: ${i.components ?? 'unspecified'}`,
      detail: i.summary,
      severity: i.deaths ? 'critical' : i.injuries || i.fire ? 'high' : 'medium',
      url: i.url,
      source: 'NHTSA owner complaint',
    });
  }

  if (history?.available) {
    for (const t of history.titles ?? []) {
      rows.push({
        date: t.date,
        type: 'title',
        scope: 'this-vehicle',
        title: `Title issued${t.state ? ` in ${t.state}` : ''}${t.brands?.length ? `: ${t.brands.join(', ')}` : ''}`,
        detail: t.odometer
          ? `Odometer ${t.odometer.toLocaleString('en-US')} ${t.odometerUnit}.`
          : null,
        severity: t.brands?.length ? 'high' : 'info',
        source: 'NMVTIS',
      });
    }
    for (const j of history.junkSalvage ?? []) {
      rows.push({
        date: j.date,
        type: 'salvage',
        scope: 'this-vehicle',
        title: `Salvage or junk record${j.reportingEntity ? ` from ${j.reportingEntity}` : ''}`,
        detail: j.disposition,
        severity: 'critical',
        source: 'NMVTIS',
      });
    }
    for (const i of history.insurance ?? []) {
      if (!i.totalLoss) continue;
      rows.push({
        date: i.date,
        type: 'total-loss',
        scope: 'this-vehicle',
        title: `Declared a total loss${i.reportingEntity ? ` by ${i.reportingEntity}` : ''}`,
        detail: null,
        severity: 'critical',
        source: 'NMVTIS',
      });
    }
  }

  return rows
    .filter((r) => r.title)
    .sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
}

/**
 * The population average, held for an hour.
 *
 * It is an aggregate over every complaint in the collection and it moves by
 * nothing in the course of a day, so recomputing it per lookup would be a
 * table scan to learn a number that has not changed. Memoised in the process
 * rather than in a table: it is derived data, it is cheap to rebuild, and a
 * stale copy after a deploy is not worth a migration.
 */
let baselineCache = { at: 0, value: null };

export async function baselineNow({ ttlMs = 3_600_000, now = Date.now() } = {}) {
  if (baselineCache.value && now - baselineCache.at < ttlMs) return baselineCache.value;
  const value = await auto.complaintBaseline().catch(() => null);
  baselineCache = { at: now, value };
  return value;
}

/**
 * The whole report for one VIN, assembled from parts already fetched.
 *
 * Takes what `vehicleProfile` already has rather than re-fetching it: the four
 * upstream calls happen once, and this turns them into the history answer.
 */
export async function vinReport({
  vin = null,
  identity = null,
  recalls = [],
  complaintRows = [],
  complaints = null,
  ncap = null,
  modelYear = null,
  miles = null,
  refresh = false,
} = {}) {
  const history = vin
    ? await historyReport(vin, { refresh }).catch(() => ({
        available: false,
        reason: 'provider-error',
        elsewhere: HISTORY_ELSEWHERE,
      }))
    : { available: false, reason: 'no-vin', elsewhere: HISTORY_ELSEWHERE };

  const evidence = accidentEvidence(complaintRows, vin);
  evidence.topComponent = complaints?.byComponent?.[0] ?? null;

  // What ordinary looks like, measured over every complaint the collection has
  // ingested. Null on a thin corpus or a database that is not there, and the
  // rating falls back to fixed reference points and labels itself accordingly.
  const baseline = await baselineNow().catch(() => null);

  const rating = conditionRating({
    recalls,
    evidence,
    ncap,
    history,
    identity,
    modelYear,
    miles,
    baseline,
  });

  // The grade we gave this car today, kept with the evidence behind it. A
  // failure to write it must not cost the caller their answer.
  if (vin) {
    await auto
      .recordRating({
        vin,
        score: rating.score,
        grade: rating.grade,
        confidence: rating.confidence,
        factors: rating.factors,
        unknown: rating.unknown,
      })
      .catch(() => {});
  }

  return {
    vin,
    rating,
    accidents: evidence,
    history,
    timeline: timelineOf({ recalls, evidence, history }),
    sources: [
      { name: 'NHTSA recalls, complaints and NCAP', licence: 'US public domain' },
      history.available
        ? { name: history.source ?? 'NMVTIS', licence: 'licensed, per report' }
        : { name: 'NMVTIS', licence: 'not checked: no provider configured' },
    ],
  };
}
