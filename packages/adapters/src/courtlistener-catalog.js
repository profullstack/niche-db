import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { defineAdapter, looseDate, slugify } from '@nichedb/core/adapter';
import { bzip2CsvRows, dumpDir } from '@nichedb/core/dump';
import {
  ATTRIBUTION,
  courtSlug,
  docketUrl,
  PROVIDER,
  personName,
  personUrl,
  SITE,
  STORAGE,
  statusTags,
  trimTo,
  USER_AGENT,
} from './courtlistener.js';

/**
 * CourtListener: everything Free Law Project publishes, from the bulk dumps.
 *
 * The live adapters in courtlistener.js read a feed of twenty and an API
 * page of twenty; this is the rest. CourtListener regenerates its whole
 * database as bulk data once a quarter, one bzip2-compressed CSV per table
 * in a public S3 bucket (courtlistener.com/help/api/bulk-data), Public Domain
 * Mark 1.0. The tables walked, in this order, each row keyed by the same id
 * the live adapters use so the two merge:
 *
 *   courts                  3.4k rows, 81 KB       kind court
 *   people-db-people        16k rows, 456 KB       kind judge, with the person's
 *                                                  positions joined from
 *                                                  people-db-positions (51k rows)
 *   financial-disclosures   32k rows, 5.6 MB       kind financial-disclosure,
 *                                                  titled by the judge's name
 *   oral-arguments          ~100k rows, 0.7 GB     kind oral-argument
 *   opinion-clusters        ~10M rows, 2.5 GB      kind opinion
 *   dockets                 tens of millions, 5 GB kind docket, OFF by default
 *   fjc-integrated-database ~ a few million, 280 MB kind case, OFF by default
 *
 * The opinions table itself (54 GB, the full text) is never read: a cluster
 * row carries the case name, court, date, syllabus, status and citation count,
 * which is the record, and the page link is where the text lives.
 *
 * THE WALK
 *
 * A run lists the bucket (two requests, the listing pages at a thousand keys)
 * and picks the newest date for which every table it needs exists with real
 * bytes in it, since a table is uploaded a while after the date in its name
 * and an early listing can show a date half-populated. That date is the
 * version: files are downloaded by their dated name with Range resume into
 * the dump directory, walked 500 rows a batch with the cursor after every
 * batch saying which file and which record, and a run stops when its budget
 * is spent and resumes ten minutes later. A cursor naming a different date
 * starts over. Once every file is walked the cursor is `done` and each run
 * until the date changes costs the listing and nothing else.
 *
 * The CSV is Postgres COPY output with `ESCAPE '\'` (CourtListener's own
 * load script says so), where a quote inside a field is `\"`, a NULL is
 * nothing between the commas and the empty string is `""`, and a syllabus
 * spans lines; `bzip2CsvRows` reads it with that escape and hands rows over
 * as objects keyed by the header, so a column added at the end of a table
 * (dockets grew eight since the API docs were written) costs nothing.
 *
 * Resuming into a bzip2 file re-inflates from the top at about 10 MB/s of
 * text, so getting back to the end of the clusters table (11 GB inflated)
 * is twenty minutes of a fifty-five minute run. A first pass of the five
 * default tables is roughly a day of runs; dockets, opted in, are a week.
 *
 * A re-ingest on a new dump date writes every row again in principle, but
 * the table skips an unchanged row by hash and the walk skips one before it
 * gets there: the cursor of a complete pass carries the newest date_modified
 * it saw and the next pass drops rows modified before that mark. Blocked
 * rows (a party asked CourtListener to keep the record out of search
 * engines) are skipped everywhere, as the live adapters skip them.
 */

export const BUCKET = 'https://com-courtlistener-storage.s3-us-west-2.amazonaws.com';
export const PREFIX = 'bulk-data/';

/** The subdirectory of the dump directory the files live in. */
export const DUMP_DIR = 'courtlistener-catalog';

/** The tables walked by default, in order. */
export const FILES = [
  'courts',
  'people-db-people',
  'financial-disclosures',
  'oral-arguments',
  'opinion-clusters',
];

/** The tables a config turns on, by the key that turns them on. */
export const OPTIONAL_FILES = { dockets: 'dockets', fjc: 'fjc-integrated-database' };

/** Read whole into memory beside a walked table, never walked themselves. */
export const SIDE_FILES = ['people-db-positions'];

/** Tables big enough that a walked copy is dropped from the shared disk at once. */
export const BIG_FILES = new Set([
  'oral-arguments',
  'opinion-clusters',
  'dockets',
  'fjc-integrated-database',
]);

/** The kind each table's rows become. */
export const KINDS = {
  courts: 'court',
  'people-db-people': 'judge',
  'financial-disclosures': 'financial-disclosure',
  'oral-arguments': 'oral-argument',
  'opinion-clusters': 'opinion',
  dockets: 'docket',
  'fjc-integrated-database': 'case',
};

/** COPY's escape character in every CourtListener file. */
export const CSV_ESCAPE = '\\';

/** A listed file smaller than this is an empty stream (a bzip2 header is 14 bytes). */
export const MIN_FILE_BYTES = 64;

/** Rows handed to the core at once; the memory a run holds. */
export const BATCH_ROWS = 500;

/** A run's wall-clock budget. The walk of the clusters file is several of these. */
export const BUDGET_MS = 55 * 60_000;

/** CourtListener regenerates the bulk data once a quarter; a monthly look is plenty. */
export const CADENCE_MINUTES = 30 * 24 * 60;

/** How soon an unfinished walk, or an unfinished download, picks up again. */
export const RESUME_MINUTES = 10;

/** The least a download is given; with less than this left a run does not start one. */
export const DOWNLOAD_MIN_MS = 30_000;

/** Consecutive failed requests after which a run stops asking. */
export const FAILURE_STOP = 3;

/** Pause before a retry. */
export const PAUSE_MS = 2000;

/** Listing pages followed at most; the bucket is two today. */
export const LISTING_PAGES_MAX = 10;

/** Summary length. */
export const SUMMARY_CHARS = 600;

/** Positions kept on a judge row, so one row stays a row. */
export const POSITIONS_KEPT = 100;

/** Django's slug length for an audio page, which is what the site truncates to. */
export const SLUG_CHARS = 75;

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

// ── Files and the listing ────────────────────────────────────────────────────

/** The tables a config walks, in order. */
export function filesFor(config = {}) {
  const out = [...FILES];
  for (const [key, file] of Object.entries(OPTIONAL_FILES)) if (truthy(config[key])) out.push(file);
  return out;
}

/** Every file a walk needs on the dump date, walked or read beside a walk. */
export const neededFiles = (config = {}) => [...filesFor(config), ...SIDE_FILES];

/** The dated file in the bucket, the same bytes for the life of the dump. */
export const fileUrl = (table, version) => `${BUCKET}/${PREFIX}${table}-${version}.csv.bz2`;

/** Where one file of one dump is kept locally. */
export const localName = (table, version) => `${table}-${version}.csv.bz2`;

/** The S3 listing URL, with the continuation token after the first page. */
export function listingUrl(token = null) {
  const params = new URLSearchParams({ 'list-type': '2', prefix: PREFIX, 'max-keys': '1000' });
  if (token) params.set('continuation-token', token);
  return `${BUCKET}/?${params}`;
}

/**
 * One page of an S3 ListObjectsV2 answer: the keys with their sizes, whether
 * a page follows and the token that fetches it. A tiny reader for a fixed
 * shape, not an XML parser.
 */
export function parseListing(xml) {
  const text = String(xml ?? '');
  const entries = [];
  for (const m of text.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const key = m[1].match(/<Key>([^<]*)<\/Key>/)?.[1];
    if (!key) continue;
    entries.push({
      key: decodeXml(key),
      size: Number(m[1].match(/<Size>(\d+)<\/Size>/)?.[1] ?? 0),
      lastModified: m[1].match(/<LastModified>([^<]*)<\/LastModified>/)?.[1] ?? null,
    });
  }
  const truncated = /<IsTruncated>true<\/IsTruncated>/.test(text);
  const next = text.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/)?.[1] ?? null;
  return { entries, truncated, next: truncated && next ? decodeXml(next) : null };
}

function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** `bulk-data/opinion-clusters-2026-06-30.csv.bz2` as `{ table, date }`, or null. */
export function parseKey(key) {
  const m = String(key ?? '').match(/^bulk-data\/([a-z0-9_-]+?)-(\d{4}-\d{2}-\d{2})\.csv\.bz2$/);
  return m ? { table: m[1], date: m[2] } : null;
}

/**
 * The newest dump date on which every file in `files` is present with bytes
 * in it. A date with one table missing or empty is not a dump yet (or was
 * never a whole one: the early 2022 dates list a 14-byte citation map), so
 * the previous date wins.
 */
export function newestCompleteDate(entries, files) {
  const byDate = new Map();
  for (const e of entries ?? []) {
    const k = parseKey(e.key);
    if (!k || !(e.size >= MIN_FILE_BYTES)) continue;
    if (!byDate.has(k.date)) byDate.set(k.date, new Set());
    byDate.get(k.date).add(k.table);
  }
  const dates = [...byDate.keys()].sort().reverse();
  return dates.find((d) => files.every((f) => byDate.get(d).has(f))) ?? null;
}

/**
 * The newest complete dump date, from the bucket listing. Two pages today;
 * a bucket that keeps growing is followed to LISTING_PAGES_MAX and no
 * further, which still holds the newest keys since the listing is by key
 * and every table name sorts before its dates.
 */
export async function resolveVersion(http, files) {
  const entries = [];
  let token = null;
  for (let page = 0; page < LISTING_PAGES_MAX; page++) {
    const xml = await http.text(listingUrl(token), {
      headers: { 'user-agent': USER_AGENT, accept: 'application/xml, text/xml, */*' },
      timeoutMs: 30_000,
    });
    const parsed = parseListing(xml);
    entries.push(...parsed.entries);
    if (!parsed.next) break;
    token = parsed.next;
  }
  const version = newestCompleteDate(entries, files);
  if (!version) {
    throw new Error(`the bucket lists no date with every needed table (${files.join(', ')})`);
  }
  return version;
}

/** The local files of other dumps than `version`, which nothing will read again. */
export function staleFiles(names, version) {
  return names.filter(
    (n) =>
      /^[a-z0-9_-]+-\d{4}-\d{2}-\d{2}\.csv\.bz2$/.test(n) && !n.endsWith(`-${version}.csv.bz2`),
  );
}

// ── Rows ─────────────────────────────────────────────────────────────────────

/** COPY writes booleans as `t` and `f`. */
export const bool = (v) => v === 't' || v === 'true';

/** A config flag: `true`, `'true'`, `'1'`, `'yes'`. */
export const truthy = (v) =>
  v === true || ['true', '1', 'yes', 'on'].includes(String(v ?? '').toLowerCase());

/** A number column, or null for NULL, blank or not a number. */
export function num(v) {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** A text column, trimmed; null for NULL and for blank. */
export function text(v) {
  const s = v === null || v === undefined ? '' : String(v).trim();
  return s || null;
}

/** A slug the site would accept, from a name, cut where Django cuts. */
export function pageSlug(name) {
  return slugify(name).slice(0, SLUG_CHARS) || 'case';
}

/** One court row. The site has no court page; the court's own URL is the link. */
export function courtItem(row) {
  const id = courtSlug(row?.id);
  const title = text(row?.full_name) ?? text(row?.short_name);
  if (!id || !title) return null;
  const jurisdiction = text(row.jurisdiction);
  return {
    externalId: id,
    kind: 'court',
    title,
    summary: null,
    url: text(row.url) ?? `${SITE}/?court=${id}`,
    publishedAt: null,
    timeKnown: false,
    precision: 'day',
    tags: [
      PROVIDER,
      'court',
      jurisdiction ? `jurisdiction:${jurisdiction.toLowerCase()}` : null,
    ].filter(Boolean),
    data: {
      provider: PROVIDER,
      courtId: id,
      shortName: text(row.short_name),
      citationString: text(row.citation_string),
      jurisdiction,
      startDate: text(row.start_date),
      endDate: text(row.end_date),
      inUse: bool(row.in_use),
      hasOpinionScraper: bool(row.has_opinion_scraper),
      hasOralArgumentScraper: bool(row.has_oral_argument_scraper),
      parentCourtId: courtSlug(row.parent_court_id) || null,
      pacerCourtId: num(row.pacer_court_id),
      fjcCourtId: text(row.fjc_court_id),
      position: num(row.position),
      dateModified: text(row.date_modified),
      attribution: ATTRIBUTION,
    },
  };
}

/** One position row, reduced to what a judge's card needs. */
export function positionOf(row) {
  return {
    type: text(row?.position_type),
    jobTitle: text(row?.job_title),
    organization: text(row?.organization_name),
    courtId: courtSlug(row?.court_id) || null,
    dateStart: text(row?.date_start),
    dateTermination: text(row?.date_termination),
    appointerId: text(row?.appointer_id),
    howSelected: text(row?.how_selected),
  };
}

/** A line about a judge from their positions: the court ones first, dated. */
export function positionsSummary(positions) {
  const lines = [];
  for (const p of positions ?? []) {
    const what = p.jobTitle ?? p.type;
    const where = p.courtId ?? p.organization;
    if (!what && !where) continue;
    const years = [p.dateStart?.slice(0, 4), p.dateTermination?.slice(0, 4)].filter(Boolean);
    const span = years.length ? ` (${years.join(' to ')})` : '';
    lines.push(`${[what, where].filter(Boolean).join(', ')}${span}`);
    if (lines.length >= 5) break;
  }
  return trimTo(lines.join('; '), SUMMARY_CHARS);
}

/** One person row as a judge, with their positions; an alias of another person is nothing. */
export function judgeItem(row, positionsByPerson = new Map()) {
  if (!row?.id || text(row.is_alias_of_id)) return null;
  const title = personName(row);
  if (!title) return null;
  const positions = (positionsByPerson.get(String(row.id)) ?? []).slice(0, POSITIONS_KEPT);
  return {
    externalId: String(row.id),
    kind: 'judge',
    title,
    summary: positionsSummary(positions),
    url: personUrl(row.id, text(row.slug)),
    publishedAt: null,
    timeKnown: false,
    precision: 'day',
    tags: [PROVIDER, 'judge', ...new Set(positions.map((p) => p.courtId).filter(Boolean))].slice(
      0,
      40,
    ),
    data: {
      provider: PROVIDER,
      nameFirst: text(row.name_first),
      nameMiddle: text(row.name_middle),
      nameLast: text(row.name_last),
      nameSuffix: text(row.name_suffix),
      slug: text(row.slug),
      fjcId: num(row.fjc_id),
      dateOfBirth: text(row.date_dob),
      dateOfBirthGranularity: text(row.date_granularity_dob),
      dateOfDeath: text(row.date_dod),
      birthplace:
        [row.dob_city, row.dob_state, row.dob_country].map(text).filter(Boolean).join(', ') || null,
      gender: text(row.gender),
      religion: text(row.religion),
      hasPhoto: bool(row.has_photo),
      positions,
      dateModified: text(row.date_modified),
      attribution: ATTRIBUTION,
    },
  };
}

/** One financial disclosure row, titled by the judge when the people file is loaded. */
export function disclosureItem(row, namesByPerson = new Map()) {
  if (!row?.id) return null;
  const year = num(row.year);
  const personId = text(row.person_id);
  const name = personId ? namesByPerson.get(personId) : null;
  const filepath = text(row.filepath);
  const url = filepath ? `${STORAGE}/${filepath.replace(/^\/+/, '')}` : text(row.download_filepath);
  const thumb = text(row.thumbnail);
  const when = looseDate(year === null ? '' : String(year));
  return {
    externalId: String(row.id),
    kind: 'financial-disclosure',
    title: name
      ? `${name} financial disclosure ${year ?? '?'}`
      : `Financial disclosure ${year ?? '?'} (person ${personId ?? '?'})`,
    summary: null,
    url,
    imageUrl: thumb ? `${STORAGE}/${thumb.replace(/^\/+/, '')}` : null,
    publishedAt: when.publishedAt,
    timeKnown: false,
    precision: 'year',
    tags: [PROVIDER, 'financial-disclosure'],
    data: {
      provider: PROVIDER,
      year,
      reportType: text(row.report_type),
      isAmended: bool(row.is_amended),
      pageCount: num(row.page_count),
      personId,
      personName: name ?? null,
      sha1: text(row.sha1),
      dateModified: text(row.date_modified),
      attribution: ATTRIBUTION,
    },
  };
}

/** One oral argument row; a blocked one is nothing. */
export function audioItem(row) {
  if (!row?.id || bool(row.blocked)) return null;
  const title = text(row.case_name) ?? text(row.case_name_full) ?? text(row.case_name_short);
  if (!title) return null;
  const mp3 = text(row.local_path_mp3);
  return {
    externalId: String(row.id),
    kind: 'oral-argument',
    title,
    summary: null,
    url: `${SITE}/audio/${row.id}/${pageSlug(title)}/`,
    publishedAt: null,
    timeKnown: false,
    precision: 'day',
    tags: [PROVIDER],
    data: {
      provider: PROVIDER,
      mp3: mp3 ? `${STORAGE}/${mp3.replace(/^\/+/, '')}` : text(row.download_url),
      durationSeconds: num(row.duration),
      judges: text(row.judges),
      docketId: text(row.docket_id),
      source: text(row.source),
      sha1: text(row.sha1),
      dateCreated: text(row.date_created),
      dateModified: text(row.date_modified),
      attribution: ATTRIBUTION,
    },
  };
}

/** One opinion cluster row as an opinion; a blocked one is nothing. */
export function clusterItem(row) {
  if (!row?.id || bool(row.blocked)) return null;
  const title = text(row.case_name) ?? text(row.case_name_short) ?? text(row.case_name_full);
  if (!title) return null;
  const when = looseDate(text(row.date_filed) ?? '');
  const status = text(row.precedential_status);
  const scdbId = text(row.scdb_id);
  return {
    externalId: String(row.id),
    kind: 'opinion',
    title,
    summary: trimTo(text(row.syllabus) ?? text(row.summary) ?? '', SUMMARY_CHARS),
    url: `${SITE}/opinion/${row.id}/${text(row.slug) ?? pageSlug(title)}/`,
    publishedAt: when.publishedAt,
    timeKnown: false,
    precision: 'day',
    tags: [PROVIDER, ...statusTags(status), scdbId ? 'scotus' : null].filter(Boolean),
    data: {
      provider: PROVIDER,
      caseNameFull: text(row.case_name_full),
      judges: text(row.judges),
      citationCount: num(row.citation_count),
      docketId: text(row.docket_id),
      natureOfSuit: text(row.nature_of_suit),
      attorneys: trimTo(text(row.attorneys) ?? '', 300),
      disposition: trimTo(text(row.disposition) ?? '', 300),
      precedentialStatus: status,
      scdbId,
      scdbDecisionDirection: num(row.scdb_decision_direction),
      source: text(row.source),
      dateFiled: text(row.date_filed),
      dateFiledApproximate: bool(row.date_filed_is_approximate),
      dateModified: text(row.date_modified),
      attribution: ATTRIBUTION,
    },
  };
}

/** One docket row, the same shape the API source writes; a blocked one is nothing. */
export function docketRowItem(row) {
  if (!row?.id || bool(row.blocked)) return null;
  const caseName = text(row.case_name) ?? text(row.case_name_short) ?? text(row.case_name_full);
  const number = text(row.docket_number);
  const title = caseName ? (number ? `${caseName} (${number})` : caseName) : number;
  if (!title) return null;
  const when = looseDate(text(row.date_filed) ?? '');
  const court = courtSlug(row.court_id);
  return {
    externalId: String(row.id),
    kind: 'docket',
    title,
    summary: trimTo([row.nature_of_suit, row.cause].map(text).filter(Boolean).join('; ')),
    url: docketUrl(row.id, text(row.slug) ?? pageSlug(caseName ?? number)),
    publishedAt: when.publishedAt,
    timeKnown: false,
    precision: 'day',
    tags: [PROVIDER, court].filter(Boolean),
    data: {
      provider: PROVIDER,
      court: court || null,
      docketNumber: number,
      natureOfSuit: text(row.nature_of_suit),
      cause: text(row.cause),
      dateFiled: text(row.date_filed),
      dateTerminated: text(row.date_terminated),
      assignedTo: text(row.assigned_to_str),
      pacerCaseId: text(row.pacer_case_id),
      source: text(row.source),
      dateModified: text(row.date_modified),
      attribution: ATTRIBUTION,
    },
  };
}

/**
 * One row of the FJC Integrated Database, the Federal Judicial Center's
 * record of every civil and criminal case in the district courts. No page
 * of its own on CourtListener (the docket carries the link the other way),
 * so the row has no URL and collides with nothing.
 */
export function fjcItem(row) {
  if (!row?.id) return null;
  const plaintiff = text(row.plaintiff);
  const defendant = text(row.defendant);
  const number = text(row.docket_number);
  const parties =
    plaintiff && defendant ? `${plaintiff} v. ${defendant}` : (plaintiff ?? defendant);
  const title = parties ? (number ? `${parties} (${number})` : parties) : number;
  if (!title) return null;
  const when = looseDate(text(row.date_filed) ?? '');
  const district = courtSlug(row.district_id);
  return {
    externalId: String(row.id),
    kind: 'case',
    title,
    summary: null,
    url: null,
    publishedAt: when.publishedAt,
    timeKnown: false,
    precision: 'day',
    tags: [PROVIDER, 'fjc', district].filter(Boolean),
    data: {
      provider: PROVIDER,
      plaintiff,
      defendant,
      docketNumber: number,
      office: text(row.office),
      origin: text(row.origin),
      jurisdiction: text(row.jurisdiction),
      natureOfSuit: text(row.nature_of_suit),
      disposition: text(row.disposition),
      judgment: text(row.judgment),
      amountReceived: num(row.amount_received),
      monetaryDemand: num(row.monetary_demand),
      classAction: bool(row.class_action),
      proSe: text(row.pro_se),
      dateFiled: text(row.date_filed),
      dateTerminated: text(row.date_terminated),
      circuit: courtSlug(row.circuit_id) || null,
      district: district || null,
      datasetSource: text(row.dataset_source),
      dateModified: text(row.date_modified),
      attribution: ATTRIBUTION,
    },
  };
}

/** The mapping for one table's rows, given the side maps loaded for it. */
export function rowItem(table, row, side = {}) {
  switch (table) {
    case 'courts':
      return courtItem(row);
    case 'people-db-people':
      return judgeItem(row, side.positions);
    case 'financial-disclosures':
      return disclosureItem(row, side.names);
    case 'oral-arguments':
      return audioItem(row);
    case 'opinion-clusters':
      return clusterItem(row);
    case 'dockets':
      return docketRowItem(row);
    case 'fjc-integrated-database':
      return fjcItem(row);
    default:
      return null;
  }
}

// ── Cursor ───────────────────────────────────────────────────────────────────

/**
 * Where a run starts. `version` is the dump date the walk is over; `file` and
 * `record` the position in it (data records already read, so the reader
 * skips that many); `modifiedWatermark` the newest date_modified a COMPLETE
 * pass has seen, below which a later pass skips rows; `maxModified` the same
 * for the pass in progress; `done` that every file of `version` is walked.
 */
export function resumeFrom(prev, files = FILES) {
  const version = /^\d{4}-\d{2}-\d{2}$/.test(String(prev?.version ?? '')) ? prev.version : null;
  const file = files.includes(prev?.file) ? prev.file : files[0];
  // A record count belongs to the file it was counted in: a cursor left in
  // a table that has since been turned off starts the first table over.
  const record = file === prev?.file ? Math.floor(Number(prev?.record)) : 0;
  const watermark =
    typeof prev?.modifiedWatermark === 'string' && prev.modifiedWatermark
      ? prev.modifiedWatermark
      : null;
  const max = typeof prev?.maxModified === 'string' && prev.maxModified ? prev.maxModified : null;
  return {
    version,
    file,
    record: record > 0 ? record : 0,
    modifiedWatermark: watermark,
    maxModified: max,
    done: version !== null && prev?.done === true,
  };
}

/**
 * A row modified before the watermark was in the previous pass unchanged.
 * COPY writes every timestamp as `YYYY-MM-DD HH:MM:SS.ffffff+00`, so the
 * strings order as the instants do.
 */
export const isStale = (dateModified, watermark) =>
  Boolean(watermark) && typeof dateModified === 'string' && dateModified < watermark;

// ── Side files ───────────────────────────────────────────────────────────────

/** Every position by person id, from the positions file: 51k small objects. */
export async function loadPositions(path) {
  const by = new Map();
  for await (const { row } of bzip2CsvRows(path, { escape: CSV_ESCAPE })) {
    const person = text(row.person_id);
    if (!person) continue;
    if (!by.has(person)) by.set(person, []);
    const list = by.get(person);
    if (list.length < POSITIONS_KEPT) list.push(positionOf(row));
  }
  return by;
}

/** Every person's display name by id, from the people file, for disclosure titles. */
export async function loadNames(path) {
  const by = new Map();
  for await (const { row } of bzip2CsvRows(path, { escape: CSV_ESCAPE })) {
    const name = personName(row);
    if (row.id && name) by.set(String(row.id), name);
  }
  return by;
}

/** What a table's mapping needs loaded beside it, by side file. */
export const SIDE_FOR = {
  'people-db-people': { file: 'people-db-positions', key: 'positions', load: loadPositions },
  'financial-disclosures': { file: 'people-db-people', key: 'names', load: loadNames },
};

// ── The adapter ──────────────────────────────────────────────────────────────

export const courtlistenerCatalog = defineAdapter({
  name: 'courtlistener-catalog',
  title: 'CourtListener: the whole catalogue',
  collection: 'law',
  description:
    'Everything CourtListener publishes as bulk data, walked from the quarterly dumps: every court (3.4k), every judge with their positions (16k), every judicial financial disclosure with its PDF (32k), every oral argument recording with its MP3 (100k) and every opinion cluster (10 million: case name, court, date filed, syllabus, precedential status, citation count). Public domain, attributed on every row. Downloads each bzip2 CSV with resume, walks it 500 rows a batch across as many runs as it takes, and after a complete pass skips the rows an earlier dump already carried. Dockets (tens of millions of rows, 5 GB) and the FJC Integrated Database (280 MB) are off unless turned on here. Shares ids with the live CourtListener sources, so the two merge.',
  docs: 'https://www.courtlistener.com/help/api/bulk-data/',
  kinds: ['court', 'judge', 'financial-disclosure', 'oral-argument', 'opinion', 'docket', 'case'],
  cadenceMinutes: CADENCE_MINUTES,
  budgetMs: BUDGET_MS,
  configFields: [
    {
      key: 'dockets',
      label: 'Walk the dockets table',
      type: 'select',
      options: ['false', 'true'],
      help: 'Tens of millions of PACER docket rows, a 5 GB download inflating to about 25 GB: a week of runs on the first pass and a re-read of the whole file to resume. Off by default.',
    },
    {
      key: 'fjc',
      label: 'Walk the FJC Integrated Database',
      type: 'select',
      options: ['false', 'true'],
      help: 'The Federal Judicial Center’s record of every district court case, a 280 MB download of a few million rows, as kind `case` with no page of its own. Off by default.',
    },
    {
      key: 'batchRows',
      label: 'Rows per batch',
      type: 'number',
      placeholder: String(BATCH_ROWS),
      help: 'Rows handed to the table at once. The cursor is saved after every batch.',
    },
    {
      key: 'pauseMs',
      label: 'Pause before a retry (ms)',
      type: 'number',
      placeholder: String(PAUSE_MS),
      help: 'After a failed request. Three failures in a row end the run; it resumes in ten minutes.',
    },
  ],
  defaults: { dockets: 'false', fjc: 'false', batchRows: BATCH_ROWS, pauseMs: PAUSE_MS },
  defaultSources: [
    {
      slug: 'courtlistener-catalog',
      name: 'Law: every court, judge, disclosure, oral argument and opinion in CourtListener',
      config: { dockets: 'false', fjc: 'false', batchRows: BATCH_ROWS, pauseMs: PAUSE_MS },
    },
  ],
  async *pull({ config, cursor: prev, http, log, deadline }) {
    const batchRows = Math.max(1, Math.floor(Number(config?.batchRows)) || BATCH_ROWS);
    const pause =
      config?.pauseMs === 0 ? 0 : Math.max(0, Math.floor(Number(config?.pauseMs))) || PAUSE_MS;
    const stopAt = Number.isFinite(deadline) ? deadline : Number.POSITIVE_INFINITY;
    const files = filesFor(config);
    const state = resumeFrom(prev, files);
    let requests = 0;
    let failures = 0;
    let streak = 0;

    const failed = (what, err) => {
      failures += 1;
      streak += 1;
      log(`${what} failed (${err?.message ?? err})`);
      return streak >= FAILURE_STOP;
    };
    const allFailed = () => {
      if (requests > 0 && failures === requests)
        throw new Error(`courtlistener: every request failed (${requests}); see the log`);
    };

    // ── Which dump ───────────────────────────────────────────────────────
    let version = null;
    while (version === null) {
      requests += 1;
      try {
        version = await resolveVersion(http, neededFiles(config));
        streak = 0;
      } catch (err) {
        if (failed('listing the bucket', err)) break;
        await sleep(pause);
      }
    }
    if (version === null) {
      if (state.version && !state.done) version = state.version;
      else {
        allFailed();
        return {
          cursor: prev ?? {},
          note: 'could not list the bulk data bucket; resuming in 10 min',
          nextInMinutes: RESUME_MINUTES,
        };
      }
    }

    if (state.version === version && state.done) {
      log(`dump ${version} already walked; nothing to do`);
      return { cursor: prev, note: `unchanged (${version})` };
    }

    const fresh = state.version !== version;
    const watermark = state.modifiedWatermark;
    let file = fresh ? files[0] : state.file;
    let record = fresh ? 0 : state.record;
    let maxModified = fresh ? null : state.maxModified;
    const cursorAt = (f, n) => ({
      version,
      file: f,
      record: n,
      modifiedWatermark: watermark,
      maxModified,
      done: false,
    });
    if (fresh) {
      log(
        `dump ${version}${state.version ? ` replaces ${state.version}` : ''}` +
          (watermark ? `; rows modified before ${watermark} are skipped` : ''),
      );
    }

    const dir = await dumpDir(DUMP_DIR);
    for (const name of staleFiles(await readdir(dir).catch(() => []), version)) {
      await unlink(join(dir, name)).catch(() => {});
    }

    let batches = 0;
    let rows = 0;
    let stale = 0;
    let skipped = 0;
    let written = 0;
    const summary = () =>
      `${written} rows written in ${batches} batches` +
      (stale ? `, ${stale} unchanged skipped` : '') +
      (skipped ? `, ${skipped} blocked or empty skipped` : '') +
      (failures ? `, ${failures} requests failed` : '');

    /*
     * Download one table of this dump, resuming whatever is on disk, until
     * the file is whole. Returns the path, or a result to return from the
     * run when the download is not done (out of time, repeated failures, or
     * a transfer still in progress).
     */
    const fetchFile = async (table) => {
      const path = join(dir, localName(table, version));
      if (stopAt - Date.now() < DOWNLOAD_MIN_MS) {
        return {
          stop: {
            cursor: cursorAt(file, record),
            note: `${summary()}; out of time before the ${table} download, resuming in 10 min`,
            nextInMinutes: RESUME_MINUTES,
          },
        };
      }
      let dl = null;
      while (dl === null) {
        requests += 1;
        try {
          dl = await http.download(fileUrl(table, version), path, {
            headers: { 'user-agent': USER_AGENT },
            timeoutMs: Number.isFinite(stopAt)
              ? Math.max(DOWNLOAD_MIN_MS, stopAt - Date.now())
              : BUDGET_MS,
          });
          streak = 0;
        } catch (err) {
          if (Date.now() > stopAt) {
            log(`${table} download cut by the run deadline (${err?.message ?? err})`);
            return {
              stop: {
                cursor: cursorAt(file, record),
                note: `${summary()}; ${table} download in progress, resuming in 10 min`,
                nextInMinutes: RESUME_MINUTES,
              },
            };
          }
          if (failed(`${table} download`, err)) {
            allFailed();
            return {
              stop: {
                cursor: cursorAt(file, record),
                note: `${summary()}; stopped after repeated failures on the ${table} download, resuming in 10 min`,
                nextInMinutes: RESUME_MINUTES,
              },
            };
          }
          await sleep(pause);
        }
      }
      if (!dl.complete) {
        log(`${table} dump ${version}: ${dl.bytes} bytes so far`);
        return {
          stop: {
            cursor: cursorAt(file, record),
            note: `${summary()}; ${table} download in progress (${dl.bytes} bytes), resuming in 10 min`,
            nextInMinutes: RESUME_MINUTES,
          },
        };
      }
      return { path };
    };

    // ── The walk ─────────────────────────────────────────────────────────
    for (let fi = files.indexOf(file); fi < files.length; fi++) {
      const table = files[fi];
      const kind = KINDS[table];

      // The side file first, loaded whole; then the table itself.
      const side = {};
      const need = SIDE_FOR[table];
      if (need) {
        const got = await fetchFile(need.file);
        if (got.stop) return got.stop;
        side[need.key] = await need.load(got.path);
        log(`${need.file} loaded: ${side[need.key].size} ${need.key}`);
      }
      const got = await fetchFile(table);
      if (got.stop) return got.stop;
      const path = got.path;

      // Walk the rows from where the cursor says, a batch at a time.
      let batch = [];
      let n = record;
      let outOfTime = false;
      let cut = null;
      try {
        const reader = bzip2CsvRows(path, {
          skip: record,
          escape: CSV_ESCAPE,
          onTruncated: (err) => {
            cut = err;
          },
        });
        for await (const { row, recordNo } of reader) {
          n = recordNo;
          rows += 1;
          const modified = row.date_modified;
          if (typeof modified === 'string' && (maxModified === null || modified > maxModified)) {
            maxModified = modified;
          }
          if (isStale(modified, watermark)) {
            stale += 1;
            continue;
          }
          const item = rowItem(table, row, side);
          if (!item) {
            skipped += 1;
            continue;
          }
          batch.push(item);
          if (batch.length >= batchRows) {
            written += batch.length;
            batches += 1;
            yield { items: batch, cursor: cursorAt(table, n) };
            batch = [];
            if (Date.now() > stopAt) {
              outOfTime = true;
              break;
            }
          }
        }
        if (cut && !outOfTime) throw new Error(`file ends mid-stream (${cut.message})`);
      } catch (err) {
        // A file the decoder cannot finish is not a file worth keeping: a
        // resume would hand the same bytes back forever. Drop it so the next
        // run downloads it again; the batches already written keep their cursor.
        await unlink(path).catch(() => {});
        throw new Error(
          `${table} dump ${version} unreadable at record ${n}, removed (${err?.message ?? err})`,
        );
      }
      if (batch.length) {
        written += batch.length;
        batches += 1;
        yield { items: batch, cursor: cursorAt(table, n) };
        batch = [];
      }
      if (outOfTime) {
        return {
          cursor: cursorAt(table, n),
          note: `${summary()}; out of time at ${table} record ${n}, resuming in 10 min`,
          nextInMinutes: RESUME_MINUTES,
        };
      }

      // The file is walked. A big one is dropped now (the disk is shared);
      // the cursor moves to the next file NOW, as an empty batch, so a crash
      // before the next file's first batch does not send the next run back
      // into this one.
      log(`${table} dump ${version} walked: ${n} ${kind} records`);
      if (BIG_FILES.has(table)) await unlink(path).catch(() => {});
      record = 0;
      file = files[fi + 1] ?? null;
      if (file) yield { items: [], cursor: cursorAt(file, 0) };
    }

    // Every file is walked; the small ones can go too.
    for (const name of await readdir(dir).catch(() => [])) {
      if (name.endsWith(`-${version}.csv.bz2`)) await unlink(join(dir, name)).catch(() => {});
    }

    return {
      cursor: {
        version,
        file: null,
        record: 0,
        modifiedWatermark: maxModified ?? watermark,
        maxModified: null,
        done: true,
        completedAt: new Date().toISOString(),
      },
      note: `complete: dump ${version}, ${rows} rows read this run, ${summary()}`,
    };
  },
});
