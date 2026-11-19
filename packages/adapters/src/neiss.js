import { rm } from 'node:fs/promises';
import { defineAdapter, slugify } from '@nichedb/core/adapter';
import { csvRecords, dumpDir } from '@nichedb/core/dump';

/**
 * Emergency room visits for injuries, from NEISS.
 *
 * The National Electronic Injury Surveillance System is the CPSC's sample of
 * about a hundred US hospital emergency departments. Every visit those
 * hospitals see that involves a consumer product, a sport or a recreational
 * activity becomes one record: the date, age, sex, body part, diagnosis,
 * where it happened, what was done with the patient, up to three product
 * codes, and a sentence or two of the triage nurse's narrative. Each record
 * carries a statistical weight, the number of visits nationally it stands
 * for, so summing weights gives a national estimate. Public domain.
 *
 * ## Where the files are
 *
 * One tab-separated file per year at
 * `cgibin/NEISSQuery/Data/Archived Data/<year>/neiss<year>.tsv`, 60-90 MB,
 * around 360,000 rows, published each spring for the year before (2025 was
 * posted 2026-05-06). A year not yet published answers 404. The code
 * tables (product, body part, diagnosis, disposition, location...) are one
 * file, `Info Docs/NEISS_FMT.txt`: format name, start, end, label.
 *
 * ## Two traps, measured 2026-11-19
 *
 * - **Akamai refuses a spoofed browser.** A Chrome user agent over a
 *   non-Chrome TLS handshake is answered 403 from the CDN; curl's default
 *   agent, Bun's, and the deployment's own `niche-db/0.1 (+url)` all get the
 *   file. A bare `nichedb/1.0` with no URL was refused too, so the agent the
 *   ingest sets is what works; never override it with a browser string.
 * - **A narrative is RFC-quoted and may hold a tab.** One 2024 row has a tab
 *   inside a quoted Other_Diagnosis, and quotes inside narratives are
 *   doubled, so the file is read with `csvRecords` at `delimiter: '\t'`,
 *   never split on tabs.
 *
 * ## What the collection holds
 *
 * - `estimate`: one row per product code per year, the weighted national
 *   estimate with the share admitted, the commonest diagnoses and body parts,
 *   the age and sex split and the change on the year before. Flagged
 *   `unstable` where the CPSC's own rule says not to publish the number: fewer
 *   than 20 sampled cases or an estimate under 1,200 (the third leg of the
 *   rule, a CV over 33%, needs the survey design and is not computed).
 * - `er-visit`: one row per sampled visit, decoded, with the narrative and
 *   the weight. Not an estimate of anything on its own.
 *
 * A case names up to three products and counts toward each of them, as the
 * CPSC's own query tool counts it, so estimates across products do not sum to
 * the number of visits.
 */

const BASE = 'https://www.cpsc.gov/cgibin/NEISSQuery/Data';
export const FORMAT_URL = `${BASE}/Info%20Docs/NEISS_FMT.txt`;
export const yearUrl = (year) => `${BASE}/Archived%20Data/${year}/neiss${year}.tsv`;
export const FIRST_YEAR = 2019;
const DAY = 60 * 24;

/** Product codes grouped into the tags the feeds are cut on. */
export const PRODUCT_GROUPS = {
  // Powered: e-bikes, e-scooters, hoverboards, mopeds, powered minibikes.
  'e-mobility': ['3215', '5022', '5025', '5035', '5042', '5045'],
  // Pickleball has no code of its own; it is coded as paddle ball (3256).
  'racquet-sports': ['1269', '3256', '3284'],
};

/**
 * Activities the product codes cannot see, found in the narrative instead.
 *
 * Pickleball has no code: 97% of the 2024 cases that name it are coded 3235,
 * "other ball sports", among everything else that is, and 1% are paddle ball.
 * The triage nurses spell it a dozen ways (PICKELBALL, PICKLE BALL,
 * PICKLEYBALL, PICIKEBALL...), so the pattern takes PI, then C/I/K, then an
 * E or L, while refusing PICK BALL and SPIKE BALL. 675 visits in 2024.
 */
export const NARRATIVE_ACTIVITIES = {
  pickleball: { name: 'pickleball', pattern: /\bPI[CIK]{1,4}[EL][ELY]{0,3} ?BALL\b/i },
  padel: { name: 'padel', pattern: /\bPADEL\b/i },
};
const RACQUET_ACTIVITIES = ['pickleball', 'padel'];

/** The narrative activities a visit names, by key. */
export function narrativeActivities(text) {
  const s = String(text ?? '');
  return Object.entries(NARRATIVE_ACTIVITIES)
    .filter(([, a]) => a.pattern.test(s))
    .map(([k]) => k);
}

const DISPOSITION_TAG = {
  0: 'no-injury',
  1: 'released',
  2: 'transferred',
  4: 'admitted',
  5: 'held-for-observation',
  6: 'left-without-being-seen',
  8: 'fatal',
};

const LOCATION_TAG = {
  1: 'at-home',
  2: 'at-farm',
  3: 'at-apartment',
  4: 'on-street',
  5: 'at-public-place',
  6: 'at-mobile-home',
  7: 'at-industrial-site',
  8: 'at-school',
  9: 'at-sports-venue',
};

const SEX = { 1: 'male', 2: 'female' };

const REQUIRED = ['CPSC_Case_Number', 'Treatment_Date', 'Product_1', 'Weight'];

/** `"64 - STRAIN, SPRAIN"` → `STRAIN, SPRAIN`. */
export function cleanLabel(raw) {
  return String(raw ?? '')
    .replace(/^\s*\d+\s*-\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** `STRAIN, SPRAIN` → `Strain, sprain`. The code tables are all capitals. */
export function sentence(label) {
  const s = String(label ?? '')
    .toLowerCase()
    .trim();
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}

/** `SOCCER (ACTIVITY, APPAREL OR EQUIPMENT)` → `soccer`: the name without its qualifier. */
export function productShort(label) {
  const bare = String(label ?? '')
    .replace(/\s*\([^)]*\)?/g, ' ')
    .replace(/,?\s*N\.?S\.?$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return (bare || String(label ?? '').trim()).toLowerCase();
}

/**
 * The code tables, as `{ PROD: Map('1233' => 'TRAMPOLINES'), BDYPT: ..., ... }`.
 * Ranges (the age table's `2..120`) are skipped; ages are decoded by `ageOf`.
 */
export function parseFormats(text) {
  const out = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const cells = line.split('\t');
    if (cells.length < 4) continue;
    const name = cells[0].replace(/"/g, '').trim();
    const start = cells[1].trim();
    if (!name || name === 'Format name' || start !== cells[2].trim()) continue;
    if (!/^\d+$/.test(start)) continue;
    out[name] ??= new Map();
    out[name].set(start, cleanLabel(cells.slice(3).join('\t')));
  }
  return out;
}

/**
 * Age in years. NEISS writes children under two as 200 + months (`209` is
 * nine months old); 0 is unknown.
 */
export function ageOf(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 200 && n < 300) return { years: 0, months: n - 200 };
  if (n > 130) return null;
  return { years: n, months: null };
}

export function ageBand(years) {
  if (years === null || years === undefined) return null;
  if (years <= 4) return 'age-0-4';
  if (years <= 14) return 'age-5-14';
  if (years <= 24) return 'age-15-24';
  if (years <= 44) return 'age-25-44';
  if (years <= 64) return 'age-45-64';
  return 'age-65-plus';
}

/** `01/31/2024` → `2024-01-31`. */
export function treatmentDate(raw) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(raw ?? '').trim());
  if (!m) return null;
  return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

/** Column positions by header name. Throws if the layout lost a column we need. */
export function headerIndex(cells) {
  const idx = {};
  cells.forEach((c, i) => {
    idx[String(c ?? '').trim()] = i;
  });
  const missing = REQUIRED.filter((k) => idx[k] === undefined);
  if (missing.length) throw new Error(`NEISS layout changed: no ${missing.join(', ')}`);
  return idx;
}

const cell = (cells, idx, key) => {
  const i = idx[key];
  if (i === undefined) return '';
  return String(cells[i] ?? '').trim();
};

const code = (v) => {
  const s = String(v ?? '').trim();
  return /^\d+$/.test(s) ? String(Number(s)) : '';
};

/** One file row as named, decoded-enough fields. */
export function toRecord(cells, idx) {
  const products = [
    ...new Set(
      ['Product_1', 'Product_2', 'Product_3']
        .map((k) => code(cell(cells, idx, k)))
        .filter((c) => c && c !== '0'),
    ),
  ];
  const narrative = ['Narrative_1', 'Narrative', 'Narrative_2']
    .map((k) => cell(cells, idx, k))
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    caseNumber: cell(cells, idx, 'CPSC_Case_Number'),
    date: treatmentDate(cell(cells, idx, 'Treatment_Date')),
    age: ageOf(cell(cells, idx, 'Age')),
    sex: code(cell(cells, idx, 'Sex')),
    race: code(cell(cells, idx, 'Race')),
    hispanic: code(cell(cells, idx, 'Hispanic')),
    bodyPart: code(cell(cells, idx, 'Body_Part')),
    diagnosis: code(cell(cells, idx, 'Diagnosis')),
    otherDiagnosis: cell(cells, idx, 'Other_Diagnosis'),
    bodyPart2: code(cell(cells, idx, 'Body_Part_2')),
    diagnosis2: code(cell(cells, idx, 'Diagnosis_2')),
    disposition: code(cell(cells, idx, 'Disposition')),
    location: code(cell(cells, idx, 'Location')),
    fire: code(cell(cells, idx, 'Fire_Involvement')),
    alcohol: code(cell(cells, idx, 'Alcohol')),
    drug: code(cell(cells, idx, 'Drug')),
    products,
    activities: narrativeActivities(narrative),
    narrative,
    stratum: cell(cells, idx, 'Stratum'),
    psu: cell(cells, idx, 'PSU'),
    weight: Number(cell(cells, idx, 'Weight')) || 0,
  };
}

const label = (fmt, table, c) => (c ? (fmt?.[table]?.get(c) ?? null) : null);

/** `OTHER` diagnoses carry their own words in Other_Diagnosis; prefer them. */
function diagnosisLabel(rec, fmt) {
  const base = label(fmt, 'DIAG', rec.diagnosis);
  if ((rec.diagnosis === '71' || rec.diagnosis === '70' || !base) && rec.otherDiagnosis) {
    return rec.otherDiagnosis;
  }
  return base;
}

function groupTags(products, activities = []) {
  const out = [];
  for (const [tag, codes] of Object.entries(PRODUCT_GROUPS)) {
    if (products.some((p) => codes.includes(p))) out.push(tag);
  }
  if (activities.some((a) => RACQUET_ACTIVITIES.includes(a)) && !out.includes('racquet-sports')) {
    out.push('racquet-sports');
  }
  return out;
}

export function visitItem(rec, fmt) {
  if (!rec?.caseNumber || !rec.date) return null;
  const productLabels = rec.products.map((p) => label(fmt, 'PROD', p) ?? `product ${p}`);
  const dx = diagnosisLabel(rec, fmt);
  const body = label(fmt, 'BDYPT', rec.bodyPart);
  const disposition = label(fmt, 'DISP', rec.disposition);
  const location = label(fmt, 'LOC', rec.location);
  const years = rec.age?.years ?? null;
  const ageText = rec.age
    ? rec.age.months !== null
      ? `${rec.age.months}-month-old`
      : `${rec.age.years}-year-old`
    : null;
  const who = [ageText, SEX[rec.sex]].filter(Boolean).join(' ');

  const what = [sentence(dx ?? 'Injury'), body ? `(${body.toLowerCase()})` : null]
    .filter(Boolean)
    .join(' ');
  const title = [what, productLabels.length ? productShort(productLabels[0]) : null, who || null]
    .filter(Boolean)
    .join(' · ');

  return {
    externalId: `neiss-${rec.caseNumber}`,
    kind: 'er-visit',
    title,
    summary: rec.narrative || null,
    url: null,
    publishedAt: rec.date,
    timeKnown: false,
    precision: 'day',
    tags: [
      'neiss',
      'er-visit',
      ...rec.products.map((p) => `product-${p}`),
      ...productLabels.map((l) => slugify(productShort(l))).filter(Boolean),
      ...(rec.activities ?? []),
      ...groupTags(rec.products, rec.activities ?? []),
      body ? `body-${slugify(body)}` : null,
      dx && label(fmt, 'DIAG', rec.diagnosis) ? `dx-${slugify(dx)}` : null,
      DISPOSITION_TAG[rec.disposition] ?? null,
      LOCATION_TAG[rec.location] ?? null,
      ageBand(years),
      SEX[rec.sex] ?? null,
      rec.alcohol === '1' ? 'alcohol' : null,
      rec.drug === '1' ? 'drugs' : null,
    ].filter(Boolean),
    data: {
      caseNumber: rec.caseNumber,
      treatmentDate: rec.date,
      ageYears: years,
      ageMonths: rec.age?.months ?? null,
      sex: SEX[rec.sex] ?? null,
      race: label(fmt, 'RACE', rec.race),
      hispanic: label(fmt, 'HISP', rec.hispanic),
      bodyPart: body,
      diagnosis: dx,
      bodyPart2: label(fmt, 'BDYPT', rec.bodyPart2),
      diagnosis2: label(fmt, 'DIAG', rec.diagnosis2),
      disposition,
      location,
      fireInvolvement: label(fmt, 'FIRE', rec.fire),
      alcohol: rec.alcohol === '1' ? true : rec.alcohol === '0' ? false : null,
      drug: rec.drug === '1' ? true : rec.drug === '0' ? false : null,
      products: rec.products.map((p, i) => ({ code: p, name: productLabels[i] })),
      activities: rec.activities ?? [],
      narrative: rec.narrative || null,
      // The visit stands for this many nationally. One row is a sample, not an estimate.
      weight: rec.weight,
      stratum: rec.stratum || null,
      psu: rec.psu || null,
      codes: {
        sex: rec.sex,
        bodyPart: rec.bodyPart,
        diagnosis: rec.diagnosis,
        disposition: rec.disposition,
        location: rec.location,
      },
      source: 'NEISS, US Consumer Product Safety Commission (public domain)',
    },
  };
}

/* ---------------------------------------------------------------- estimates */

const bump = (obj, key, w) => {
  if (!key) return;
  obj[key] = (obj[key] ?? 0) + w;
};

/** Running weighted counts for one product in one year. */
export function emptyTally() {
  return { n: 0, w: 0, sex: {}, age: {}, disposition: {}, body: {}, diagnosis: {}, location: {} };
}

/**
 * Add a visit to the tally of every product it names, and of every narrative
 * activity, keyed `a:<activity>` so the two never collide.
 */
export function tallyVisit(tallies, rec) {
  for (const p of [...rec.products, ...(rec.activities ?? []).map((a) => `a:${a}`)]) {
    const t = tallies.get(p) ?? emptyTally();
    tallies.set(p, t);
    const w = rec.weight;
    t.n += 1;
    t.w += w;
    bump(t.sex, SEX[rec.sex] ?? 'unknown', w);
    bump(t.age, ageBand(rec.age?.years ?? null) ?? 'unknown', w);
    bump(t.disposition, rec.disposition, w);
    bump(t.body, rec.bodyPart, w);
    bump(t.diagnosis, rec.diagnosis, w);
    bump(t.location, rec.location, w);
  }
}

/** The CPSC's rule for an estimate it would not publish (less the CV leg). */
export function unstable(t) {
  return t.n < 20 || t.w < 1200;
}

const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

function shares(obj, total, name = (k) => k, limit = 5) {
  return Object.entries(obj)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k, w]) => ({ key: k, name: name(k), estimate: Math.round(w), share: pct(w, total) }));
}

export function estimateItem(productCode, t, year, fmt, previous = null) {
  const activity = productCode.startsWith('a:') ? productCode.slice(2) : null;
  const name = activity
    ? (NARRATIVE_ACTIVITIES[activity]?.name ?? activity)
    : (label(fmt, 'PROD', productCode) ?? `Product ${productCode}`);
  const short = activity ? name : productShort(name);
  const estimate = Math.round(t.w);
  const flagged = unstable(t);
  const admitted = (t.disposition['4'] ?? 0) + (t.disposition['2'] ?? 0);
  const fatal = t.disposition['8'] ?? 0;
  const change =
    previous && previous > 0 ? Math.round(((estimate - previous) / previous) * 1000) / 10 : null;

  const diagnoses = shares(t.diagnosis, t.w, (k) => label(fmt, 'DIAG', k) ?? k);
  const bodyParts = shares(t.body, t.w, (k) => label(fmt, 'BDYPT', k) ?? k);
  const locations = shares(t.location, t.w, (k) => label(fmt, 'LOC', k) ?? k);
  const ages = shares(t.age, t.w, (k) => k, 10);
  const sexes = shares(t.sex, t.w, (k) => k, 3);

  const fmtN = (n) => n.toLocaleString('en-US');
  const summary = [
    `An estimated ${fmtN(estimate)} US emergency department visits in ${year} involved ${short}, from ${fmtN(t.n)} sampled cases.`,
    change !== null
      ? `${change >= 0 ? 'Up' : 'Down'} ${Math.abs(change)}% on ${year - 1} (${fmtN(previous)}).`
      : null,
    `${pct(admitted, t.w)}% admitted or transferred.`,
    diagnoses.length
      ? `Commonest diagnoses: ${diagnoses
          .slice(0, 3)
          .map((d) => `${d.name.toLowerCase()} ${d.share}%`)
          .join(', ')}.`
      : null,
    bodyParts.length
      ? `Body parts: ${bodyParts
          .slice(0, 3)
          .map((d) => `${d.name.toLowerCase()} ${d.share}%`)
          .join(', ')}.`
      : null,
    flagged
      ? 'Unstable: under 20 sampled cases or under 1,200 estimated visits, which the CPSC does not publish as an estimate.'
      : null,
  ]
    .filter(Boolean)
    .join(' ');

  return {
    externalId: `neiss-estimate-${year}-${activity ?? productCode}`,
    kind: 'estimate',
    title: `${sentence(short)}: about ${fmtN(estimate)} ER visits in ${year}`,
    summary,
    url: null,
    publishedAt: `${year}-01-01`,
    timeKnown: false,
    precision: 'year',
    tags: [
      'neiss',
      'estimate',
      `year-${year}`,
      activity ? `activity-${activity}` : `product-${productCode}`,
      slugify(short),
      ...groupTags(activity ? [] : [productCode], activity ? [activity] : []),
      flagged ? 'unstable' : 'stable',
      change !== null && change >= 25 ? 'rising' : null,
      change !== null && change <= -25 ? 'falling' : null,
    ].filter(Boolean),
    data: {
      year,
      productCode: activity ? null : productCode,
      product: activity ? null : name,
      activity,
      estimate,
      cases: t.n,
      unstable: flagged,
      previousYearEstimate: previous ?? null,
      changePct: change,
      admittedOrTransferredPct: pct(admitted, t.w),
      fatalities: Math.round(fatal),
      diagnoses,
      bodyParts,
      locations,
      ages,
      sexes,
      method: activity
        ? `Sum of NEISS case weights for every sampled visit whose narrative names ${name}, misspellings included; the product codes do not carry it. No variance or confidence interval.`
        : 'Sum of NEISS case weights for every sampled visit naming this product in any of its three product fields. No variance or confidence interval: that needs the stratum and PSU design, which each visit row carries.',
      source: 'NEISS, US Consumer Product Safety Commission (public domain)',
    },
  };
}

/* ---------------------------------------------------------------- the pull */

/** Last-Modified and size of a year's file, or null if it is not published. */
async function probe(http, year) {
  const res = await http.request(yearUrl(year), {
    headers: { range: 'bytes=0-0' },
    timeoutMs: 30_000,
  });
  await res.body?.cancel().catch(() => {});
  if (res.status === 404) return null;
  if (res.status !== 206 && res.status !== 200) {
    const err = new Error(`NEISS ${year}: HTTP ${res.status}`);
    err.status = res.status;
    err.upstream = true;
    throw err;
  }
  const total = /\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1];
  return `${res.headers.get('last-modified') ?? ''}|${total ?? res.headers.get('content-length') ?? ''}`;
}

async function* rows(path, skip = 0) {
  let idx = null;
  for await (const cells of csvRecords(Bun.file(path).stream(), {
    skip,
    keepHeader: true,
    delimiter: '\t',
  })) {
    if (!idx) {
      idx = headerIndex(cells);
      continue;
    }
    yield toRecord(cells, idx);
  }
}

export const neiss = defineAdapter({
  name: 'neiss',
  title: 'ER injury visits (CPSC NEISS)',
  collection: 'injuries',
  description:
    'Every injury visit sampled by the CPSC’s National Electronic Injury Surveillance System, about a hundred US hospital emergency departments: date, age, sex, body part, diagnosis, disposition, location, the products and sports involved and the triage narrative, each with its national weight; and per product per year the weighted national estimate. Read from the yearly public files, public domain.',
  docs: 'https://www.cpsc.gov/Research--Statistics/NEISS-Injury-Data',
  kinds: ['estimate', 'er-visit'],
  cadenceMinutes: DAY,
  budgetMs: 55 * 60 * 1000,
  configFields: [
    {
      key: 'fromYear',
      label: 'From year',
      type: 'number',
      placeholder: String(FIRST_YEAR),
      help: 'The first year read. Files go back to 1998; alcohol, drug and Hispanic fields start in 2019.',
    },
    {
      key: 'visits',
      label: 'Visit rows',
      type: 'select',
      options: ['yes', 'no'],
      help: 'Store every sampled visit as well as the yearly estimates. About 360,000 rows a year.',
    },
  ],
  defaults: { fromYear: FIRST_YEAR, visits: 'yes' },
  defaultSources: [
    {
      slug: 'neiss',
      name: 'US emergency room injury visits',
      description:
        'Injury visits to a national sample of US emergency departments, and the national estimate per product per year.',
      enabled: true,
    },
  ],

  async *pull({ config, cursor, http, log, deadline }) {
    const fromYear = Math.max(1998, Number(config.fromYear) || FIRST_YEAR);
    const withVisits = !['no', 'false', false].includes(config.visits);
    const thisYear = new Date().getUTCFullYear();
    const state = {
      years: { ...(cursor?.years ?? {}) },
      totals: { ...(cursor?.totals ?? {}) },
    };
    const snapshot = () => ({
      years: structuredClone(state.years),
      totals: structuredClone(state.totals),
    });
    const late = () => Date.now() > deadline - 90_000;

    const fmt = parseFormats(await http.text(FORMAT_URL, { timeoutMs: 60_000 }));
    if (!fmt.PROD?.size) throw new Error('NEISS code tables came back without products');

    const published = [];
    for (let y = fromYear; y <= thisYear; y += 1) {
      const version = await probe(http, y);
      if (!version) continue;
      published.push(y);
      const had = state.years[y];
      if (!had || had.version !== version) {
        if (had) log(`${y}: republished (${version}), reading it again`);
        state.years[y] = { version, estimates: false, visits: 0 };
        await rm(`${await dumpDir('neiss')}/neiss${y}.tsv`, { force: true }).catch(() => {});
      }
    }
    if (!published.length) return { cursor: snapshot(), note: 'no NEISS year published' };

    const dir = await dumpDir('neiss');
    const fetchYear = async (y) => {
      const path = `${dir}/neiss${y}.tsv`;
      const got = await http.download(yearUrl(y), path, {
        timeoutMs: Math.max(60_000, deadline - Date.now() - 60_000),
      });
      return got.complete ? path : null;
    };

    let estimates = 0;
    let visits = 0;

    // Phase A: estimates, oldest first so each year can say how it moved on the last.
    for (const y of published) {
      const st = state.years[y];
      if (st.estimates) continue;
      if (late())
        return { cursor: snapshot(), note: `estimates stopped before ${y}`, nextInMinutes: 1 };
      const path = await fetchYear(y);
      if (!path) return { cursor: snapshot(), note: `downloading ${y}`, nextInMinutes: 2 };
      const tallies = new Map();
      for await (const rec of rows(path)) tallyVisit(tallies, rec);
      const prev = state.totals[y - 1] ?? null;
      const items = [];
      const totals = {};
      for (const [p, t] of tallies) {
        items.push(estimateItem(p, t, y, fmt, prev?.[p] ?? null));
        totals[p] = Math.round(t.w);
      }
      state.totals[y] = totals;
      st.estimates = true;
      estimates += items.length;
      log(`${y}: ${items.length} product estimates`);
      if (!withVisits || st.visits === 'done') await rm(path, { force: true }).catch(() => {});
      yield { items, cursor: snapshot() };
    }

    // Phase B: every visit, newest year first.
    if (withVisits) {
      for (const y of [...published].reverse()) {
        const st = state.years[y];
        if (st.visits === 'done') continue;
        if (late())
          return { cursor: snapshot(), note: `visits stopped before ${y}`, nextInMinutes: 1 };
        const path = await fetchYear(y);
        if (!path) return { cursor: snapshot(), note: `downloading ${y}`, nextInMinutes: 2 };
        // `visits` counts records read, the header included, which is what csvRecords skips.
        let consumed = Math.max(Number(st.visits) || 0, 1);
        let batch = [];
        for await (const rec of rows(path, Number(st.visits) || 0)) {
          consumed += 1;
          const item = visitItem(rec, fmt);
          if (item) batch.push(item);
          if (batch.length >= 1000) {
            st.visits = consumed;
            visits += batch.length;
            yield { items: batch, cursor: snapshot() };
            batch = [];
            if (late()) {
              return {
                cursor: snapshot(),
                note: `${y}: visits read to record ${consumed}`,
                nextInMinutes: 1,
              };
            }
          }
        }
        st.visits = 'done';
        visits += batch.length;
        await rm(path, { force: true }).catch(() => {});
        log(`${y}: visits done`);
        yield { items: batch, cursor: snapshot() };
      }
    }

    return {
      cursor: snapshot(),
      note: `${estimates} estimates, ${visits} visits; years ${published[0]}-${published.at(-1)}`,
    };
  },
});
