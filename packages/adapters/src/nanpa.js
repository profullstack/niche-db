import { rm } from 'node:fs/promises';
import { defineAdapter, slugify } from '@nichedb/core/adapter';
import { csvRecords, dumpDir } from '@nichedb/core/dump';
import { carrierName, lineTypeGuess } from './phone-common.js';

/**
 * Who holds every North American phone number block: the NANP numbering
 * plan as NANPA publishes it every night at reports.nanpa.com/public.
 *
 *   npa_report.csv    every area code: where, which time zone, in service
 *                     since when, overlays (800 rows, 117 KB)
 *   CoCodeAssignment_Utilized_AllStates_Public.zip
 *                     every assigned exchange (NPA-NXX, 10,000 numbers): the
 *                     carrier (OCN + name), rate centre, state, date assigned,
 *                     whether it is pooled (205,000 rows, 2.2 MB zip)
 *   ThousandsBlockAssignment_All_Augmented.zip
 *                     pooled exchanges split into ten blocks of 1,000, each
 *                     with the carrier it went to (1.43 million rows, 12 MB)
 *
 * One row per area code, and one per exchange with its blocks folded in, so a
 * lookup is one read: `nanp:202-203`, then the block from the number's next
 * digit. The block file is sorted by NPA and NXX, so it is streamed a group
 * at a time and joined to the exchange file held in memory (205k entries).
 *
 * WHAT IT IS NOT
 *
 * The carrier here is who the block was ASSIGNED to. A number ported to
 * another carrier keeps its block, and NANPA says nothing about porting (the
 * NPAC is paid). Nor does NANPA say landline or mobile: `lineTypeGuess` reads
 * the carrier's name, and every page shows it as a guess.
 *
 * TERMS
 *
 * NANPA publishes these reports for public use and grants no licence beyond
 * its copyright footer. What is kept is the assignment facts (which code went
 * to which carrier, where, when), which is the purpose of a public numbering
 * register; each row links the report it came from.
 */

const BASE = 'https://reports.nanpa.com/public';
export const NPA_URL = `${BASE}/npa_report.csv`;
export const CO_URL = `${BASE}/CoCodeAssignment_Utilized_AllStates_Public.zip`;
export const BLOCKS_URL = `${BASE}/ThousandsBlockAssignment_All_Augmented.zip`;
const BATCH = 1000;

const BLOCK_STATUS = {
  AS: 'assigned',
  AV: 'available',
  RT: 'retained by the code holder',
  AP: 'administratively pending',
  AF: 'reserved for future use',
};

const clean = (v) => {
  const s = String(v ?? '')
    .trim()
    .replace(/^"|"$/g, '')
    .trim();
  return s || null;
};

/** MM/DD/YYYY or DD-Mon-YYYY to YYYY-MM-DD, or null. */
export function nanpaDate(v) {
  const s = clean(v);
  if (!s) return null;
  let m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[1]}-${m[2]}`;
  m = /^(\d{2})-([A-Za-z]{3})-(\d{4})$/.exec(s);
  if (m) {
    const mon = 'janfebmaraprmayjunjulaugsepoctnovdec'.indexOf(m[2].toLowerCase()) / 3 + 1;
    if (mon >= 1) return `${m[3]}-${String(mon).padStart(2, '0')}-${m[1]}`;
  }
  return null;
}

const TIME_ZONE = {
  E: 'Eastern',
  C: 'Central',
  M: 'Mountain',
  P: 'Pacific',
  A: 'Alaska',
  H: 'Hawaii-Aleutian',
  N: 'Newfoundland',
  T: 'Atlantic',
  Y: 'Atlantic',
};

/** One npa_report.csv record (header names to cells) as an area code row, or null. */
export function areaCodeItem(r) {
  const npa = clean(r.NPA_ID);
  if (!npa || !/^\d{3}$/.test(npa) || clean(r.ASSIGNED) !== 'Yes') return null;
  const location = clean(r.LOCATION);
  const country = clean(r.COUNTRY);
  const inService = clean(r.IN_SERVICE) === 'Y';
  const zones = String(r.TIME_ZONE ?? '')
    .replace(/[()]/g, '')
    .split(/[\s,]+/)
    .map((z) => TIME_ZONE[z])
    .filter(Boolean);
  const overlay = clean(r.OVERLAY_COMPLEX);
  const kind = clean(r.type_of_code);
  const where = [location, country && country !== 'US' ? country : null].filter(Boolean).join(', ');
  return {
    externalId: `nanp:${npa}`,
    kind: 'area-code',
    title: `Area code ${npa}${where ? `: ${titleCase(where)}` : ''}`,
    summary: [
      `${npa} is ${kind ? `a ${kind.toLowerCase()}` : 'an area code'}`,
      where ? ` for ${titleCase(where)}` : '',
      inService
        ? `, in service since ${nanpaDate(r.IN_SERVICE_DT) ?? 'unknown'}`
        : ', not in service',
      zones.length ? `, ${[...new Set(zones)].join('/')} time` : '',
      overlay ? `. Overlay: ${overlay}.` : '.',
    ].join(''),
    url: `https://www.nanpa.com/area-codes/${npa}`,
    publishedAt: nanpaDate(r.IN_SERVICE_DT) ?? nanpaDate(r.ASSIGNMENT_DT),
    timeKnown: false,
    precision: 'day',
    tags: [
      'nanp',
      'area-code',
      `npa-${npa}`,
      location && location.length === 2 ? `state-${location.toLowerCase()}` : null,
      country ? `country-${slugify(country)}` : null,
      inService ? 'in-service' : 'not-in-service',
      overlay ? 'overlay' : null,
    ].filter(Boolean),
    data: {
      npa,
      type: kind,
      location,
      country,
      inService,
      inServiceAt: nanpaDate(r.IN_SERVICE_DT),
      assignedAt: nanpaDate(r.ASSIGNMENT_DT),
      timeZones: [...new Set(zones)],
      overlay,
      parent: clean(r.PARENT_NPA_ID),
      service: clean(r.SERVICE),
      areaServed: clean(r.AREA_SERVED),
      dialing: clean(r.DIALING_PLAN_NOTES),
      source: 'NANPA NPA report',
      dataset: NPA_URL,
    },
  };
}

const titleCase = (s) =>
  String(s)
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\b([A-Z][a-z])\b/g, (m) => (m.length === 2 ? m.toUpperCase() : m));

/** One CO code file record as an exchange, or null. Cells by position (tab-separated). */
export function exchangeFromCo(cells) {
  const key = clean(cells[1]);
  if (!key || !/^\d{3}-\d{3}$/.test(key)) return null;
  const [npa, nxx] = key.split('-');
  return {
    npa,
    nxx,
    state: clean(cells[0]),
    ocn: clean(cells[2]),
    company: carrierName(cells[3]),
    rateCenter: clean(cells[4]),
    effectiveAt: nanpaDate(cells[5]),
    use: clean(cells[6]),
    assignedAt: nanpaDate(cells[7]),
    initialOrGrowth: clean(cells[8]),
    pooled: clean(cells[9]) === 'Y',
    inService: clean(cells[10]) === 'Yes',
  };
}

/** One thousands-block record (Region..Date Assigned) as a block. */
export function blockFromRecord(c) {
  const status = clean(c[5]);
  return {
    x: clean(c[4]),
    status: BLOCK_STATUS[status] ?? status,
    statusCode: status,
    company: carrierName(c[12]) ?? carrierName(c[6]),
    ocn: clean(c[13]),
    rateCenter: clean(c[9]),
    effectiveAt: nanpaDate(c[10]),
    assignedAt: nanpaDate(c[14]),
    contaminated: clean(c[7]) === 'Y',
  };
}

/** An exchange (and its blocks, when pooled) as one row. */
export function exchangeItem(ex, blocks = []) {
  const key = `${ex.npa}-${ex.nxx}`;
  const holders = [...new Set(blocks.map((b) => b.company).filter(Boolean))];
  const guess = lineTypeGuess(ex.company);
  const where = [ex.rateCenter, ex.state].filter(Boolean).join(', ');
  return {
    externalId: `nanp:${key}`,
    kind: 'exchange',
    title: `${key}${where ? ` · ${where}` : ''}${ex.company ? ` · ${ex.company}` : ''}`,
    summary: [
      `Numbers ${ex.npa}-${ex.nxx}-xxxx`,
      ex.company ? ` were assigned to ${ex.company}` : ' are assigned',
      ex.ocn ? ` (OCN ${ex.ocn})` : '',
      where ? `, rate centre ${where}` : '',
      ex.assignedAt ? `, on ${ex.assignedAt}` : '',
      ex.pooled
        ? `. Pooled: ${blocks.length} blocks of 1,000 across ${holders.length || 1} carrier${holders.length === 1 ? '' : 's'}`
        : '',
      '.',
    ].join(''),
    url: `${BASE}/`,
    publishedAt: ex.assignedAt,
    timeKnown: false,
    precision: 'day',
    tags: [
      'nanp',
      'exchange',
      `npa-${ex.npa}`,
      `nxx-${key}`,
      ex.state ? `state-${ex.state.toLowerCase()}` : null,
      ex.ocn ? `ocn-${ex.ocn.toLowerCase()}` : null,
      ex.company ? `carrier-${slugify(ex.company)}` : null,
      ex.rateCenter ? `rc-${slugify(ex.rateCenter)}` : null,
      ex.pooled ? 'pooled' : null,
      guess ? `line-guess-${guess}` : null,
      ex.inService ? 'in-service' : null,
    ].filter(Boolean),
    data: {
      ...ex,
      lineTypeGuess: guess,
      lineTypeBasis:
        'the name of the carrier the exchange was assigned to; numbers may have been ported since',
      blocks,
      source: 'NANPA central office code and thousands-block assignment reports',
      dataset: ex.pooled ? BLOCKS_URL : CO_URL,
    },
  };
}

/** Records of a zip member through `unzip -p`, as csvRecords reads them. */
async function* zipRecords(path, opts) {
  const proc = Bun.spawn(['unzip', '-p', path], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  try {
    yield* csvRecords(proc.stdout, opts);
  } finally {
    if (proc.exitCode === null) proc.kill();
  }
}

export const nanpa = defineAdapter({
  name: 'nanpa',
  title: 'NANPA numbering plan',
  collection: 'phone',
  description:
    'Who holds every North American phone number block, from the reports NANPA publishes every night: each area code (where, time zone, in service since, overlays), each assigned exchange NPA-NXX (carrier and OCN, rate centre, state, date assigned), and the ten blocks of 1,000 inside every pooled exchange with the carrier each went to. The carrier is the one the block was assigned to; a number ported since keeps its block. Landline or mobile is a guess from the carrier name.',
  docs: 'https://www.nanpa.com/reports',
  kinds: ['area-code', 'exchange'],
  cadenceMinutes: 24 * 60,
  budgetMs: 45 * 60_000,
  defaults: {},
  defaultSources: [{ slug: 'nanpa-numbering', name: 'NANPA: area codes, exchanges and blocks' }],

  async *pull({ http, log }) {
    const dir = await dumpDir('nanpa');
    const co = `${dir}/co.zip`;
    const blocksZip = `${dir}/blocks.zip`;

    // Area codes: one small CSV whose first line is a "File Date" row.
    const npaText = await http.text(NPA_URL, { timeoutMs: 60_000 });
    const lines = npaText.split('\n');
    const start = lines.findIndex((l) => l.startsWith('NPA_ID,'));
    const areaCodes = [];
    let header = null;
    for await (const cells of csvRecords([Buffer.from(lines.slice(start).join('\n'))])) {
      if (!header) {
        header = cells;
        continue;
      }
      const item = areaCodeItem(Object.fromEntries(header.map((h, i) => [h, cells[i]])));
      if (item) areaCodes.push(item);
    }
    yield { items: areaCodes };
    log(`${areaCodes.length} area codes`);

    for (const [url, path] of [
      [CO_URL, co],
      [BLOCKS_URL, blocksZip],
    ]) {
      await rm(path, { force: true });
      const got = await http.download(url, path, { timeoutMs: 15 * 60_000 });
      if (!got.complete)
        return { cursor: {}, note: `download incomplete: ${url}`, nextInMinutes: 60 };
    }

    // Every exchange, keyed NPA-NXX. The file is tab-separated, padded, with
    // the company quoted; the header's last column is a "File Updated" date.
    const exchanges = new Map();
    for await (const cells of zipRecords(co, { delimiter: '\t', skip: 1 })) {
      const ex = exchangeFromCo(cells);
      if (ex) exchanges.set(`${ex.npa}-${ex.nxx}`, ex);
    }
    log(`${exchanges.size} exchanges`);

    let batch = [];
    let wrote = areaCodes.length;
    let pooled = 0;
    const flush = function* (force = false) {
      if (batch.length >= BATCH || (force && batch.length)) {
        wrote += batch.length;
        yield { items: batch };
        batch = [];
      }
    };

    // Pooled exchanges: the block file arrives grouped by NPA-NXX.
    let key = null;
    let group = [];
    let first = null;
    const endGroup = () => {
      if (!key) return;
      const ex = exchanges.get(key) ?? {
        npa: key.slice(0, 3),
        nxx: key.slice(4),
        state: clean(first?.[1]),
        rateCenter: clean(first?.[9]),
        company: carrierName(first?.[6]),
        ocn: null,
        pooled: true,
      };
      exchanges.delete(key);
      batch.push(exchangeItem({ ...ex, pooled: true }, group));
      pooled++;
    };
    for await (const c of zipRecords(blocksZip, { skip: 1 })) {
      const k = `${clean(c[2])}-${clean(c[3])}`;
      if (k !== key) {
        endGroup();
        key = k;
        group = [];
        first = c;
        yield* flush();
      }
      group.push(blockFromRecord(c));
    }
    endGroup();

    // The rest: exchanges held whole by one carrier.
    for (const ex of exchanges.values()) {
      batch.push(exchangeItem(ex));
      yield* flush();
    }
    yield* flush(true);
    await rm(co, { force: true });
    await rm(blocksZip, { force: true });
    return {
      cursor: { finishedAt: new Date().toISOString() },
      note: `${areaCodes.length} area codes, ${wrote - areaCodes.length} exchanges (${pooled} pooled)`,
    };
  },
});
