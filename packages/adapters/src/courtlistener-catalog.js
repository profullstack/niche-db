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
 *   citations               ~10M rows, 127 MB      no rows of its own: each
 *                                                  reporter cite ("410 U.S.
 *                                                  113") is added to its
 *                                                  opinion as a tag and to
 *                                                  data.citations, so the case
 *                                                  is found by the cite people
 *                                                  type (see patchItems)
 *   fjc-integrated-database ~ a few million, 280 MB kind case
 *   dockets                 tens of millions, 5 GB kind docket, OFF by default
 *
 * Judges are joined with their positions, education (school names from
 * people-db-schools) and political affiliations; disclosures with what the
 * reports say, from eight detail tables (investments, gifts, debts, positions,
 * agreements, reimbursements, spousal income, non-investment income).
 * people-db-retention-events is published as a header and nothing else.
 *
 * The opinions table itself (54 GB, the full text) is never read: a cluster
 * row carries the case name, court, date, syllabus, status and citation count,
 * which is the record, and the page link is where the text lives. That also
 * rules out parentheticals and the citation map: both are keyed by OPINION id,
 * and the only map from an opinion to its cluster is in that 54 GB table.
 *
 * IDS
 *
 * Every table's rows share one source, and `(source_id, external_id)` is the
 * row. Courts are keyed by their slug and opinions by the bare cluster id;
 * every other table's ids are prefixed with what they are (`judge:2749`,
 * `disclosure:1108`, `audio:17`, `docket:…`, `fjc:…`), because the tables
 * number their rows independently from 1 and a bare id would make cluster 17
 * overwrite audio 17. Until ID_SCHEME 2 they did exactly that: the clusters
 * walk overwrote nearly every judge and disclosure row and half the oral
 * arguments. A cursor from before the scheme walks those three tables again
 * (and migration 0028 deletes the bare-id rows they left).
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
 * is spent and resumes ten minutes later. The cursor also lists the tables
 * already walked on that date, so a table turned on (or re-keyed) later is
 * walked without walking the others again. A cursor naming a different date
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

/** The tables walked always, in order. Citations follow the clusters they patch. */
export const FILES = [
  'courts',
  'people-db-people',
  'financial-disclosures',
  'oral-arguments',
  'opinion-clusters',
  'citations',
];

/** The tables a config turns on, by the key that turns them on, in walk order. */
export const OPTIONAL_FILES = { fjc: 'fjc-integrated-database', dockets: 'dockets' };

/** Read whole into memory beside a walked table, never walked themselves. */
export const DISCLOSURE_DETAIL_FILES = {
  investments: 'financial-disclosure-investments',
  gifts: 'financial-disclosures-gifts',
  debts: 'financial-disclosures-debts',
  positions: 'financial-disclosures-positions',
  agreements: 'financial-disclosures-agreements',
  reimbursements: 'financial-disclosures-reimbursements',
  spousalIncome: 'financial-disclosures-spousal-income',
  nonInvestmentIncome: 'financial-disclosures-non-investment-income',
};
export const SIDE_FILES = [
  'people-db-positions',
  'people-db-schools',
  'people-db-educations',
  'people-db-political-affiliations',
  ...Object.values(DISCLOSURE_DETAIL_FILES),
];

/** Tables big enough that a walked copy is dropped from the shared disk at once. */
export const BIG_FILES = new Set([
  'oral-arguments',
  'opinion-clusters',
  'citations',
  'dockets',
  'fjc-integrated-database',
]);

/** The kind each table's rows become (citations become none: they patch opinions). */
export const KINDS = {
  courts: 'court',
  'people-db-people': 'judge',
  'financial-disclosures': 'financial-disclosure',
  'oral-arguments': 'oral-argument',
  'opinion-clusters': 'opinion',
  citations: 'citation',
  dockets: 'docket',
  'fjc-integrated-database': 'case',
};

/**
 * The external id scheme. 2: every table but courts and clusters prefixes its
 * ids (see IDS above). A cursor without it was written under bare ids.
 */
export const ID_SCHEME = 2;

/** The prefix each table's ids carry under ID_SCHEME 2. */
export const ID_PREFIX = {
  'people-db-people': 'judge',
  'financial-disclosures': 'disclosure',
  'oral-arguments': 'audio',
  dockets: 'docket',
  'fjc-integrated-database': 'fjc',
};

/** A row's external id: the table's prefix and CourtListener's id. */
export const catalogId = (table, id) => `${ID_PREFIX[table]}:${id}`;

/** The tables a pre-scheme walk wrote under bare ids, walked again under the new ones. */
export const REKEYED = ['people-db-people', 'financial-disclosures', 'oral-arguments'];

/** The tables of the walk before ID_SCHEME 2, in its order, to read an old cursor by. */
export const LEGACY_FILES = [
  'courts',
  'people-db-people',
  'financial-disclosures',
  'oral-arguments',
  'opinion-clusters',
  'dockets',
  'fjc-integrated-database',
];

/**
 * Tables walked whole on every pass, whatever the watermark: a citation patch
 * that is already on its opinion writes nothing, and one whose opinion was
 * rewritten by a changed cluster row (which drops what patches added) must
 * be applied again even though the citation itself did not change.
 */
export const NO_WATERMARK = new Set(['citations']);

/** Detail rows kept per disclosure, per kind, so one row stays a row. */
export const DETAIL_KEPT = 50;

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

/**
 * CourtListener's party codes (people.models.PoliticalAffiliation). An
 * unknown code is kept as the code.
 */
export const PARTIES = {
  d: 'Democratic',
  r: 'Republican',
  i: 'Independent',
  g: 'Green',
  l: 'Libertarian',
  f: 'Federalist',
  w: 'Whig',
  j: 'Jeffersonian Republican',
  u: 'National Union',
  z: 'Reform',
};

/** One education row, with the school's name when the schools file is loaded. */
export function educationOf(row, schools = new Map()) {
  const schoolId = text(row?.school_id);
  return {
    school: (schoolId && schools.get(schoolId)) || null,
    schoolId,
    degreeLevel: text(row?.degree_level),
    degree: text(row?.degree_detail),
    year: num(row?.degree_year),
  };
}

/** One political affiliation row. */
export function affiliationOf(row) {
  const code = text(row?.political_party);
  return {
    party: code ? (PARTIES[code] ?? code) : null,
    source: text(row?.source),
    dateStart: text(row?.date_start),
    dateEnd: text(row?.date_end),
  };
}

/** `Yale Law School (J.D., 1997)`, and the rest after it, for a judge's summary. */
export function educationSummary(educations) {
  return (educations ?? [])
    .filter((e) => e.school)
    .slice(0, 4)
    .map((e) => {
      const what = [e.degree ?? e.degreeLevel, e.year].filter(Boolean).join(', ');
      return what ? `${e.school} (${what})` : e.school;
    })
    .join('; ');
}

/** A party as a tag: `party:democratic`. */
const partyTag = (party) => (party ? `party:${slugify(party)}` : null);

/**
 * One person row as a judge, with their positions, education and parties
 * from the side files; an alias of another person is nothing.
 */
export function judgeItem(row, positionsByPerson = new Map(), extra = {}) {
  if (!row?.id || text(row.is_alias_of_id)) return null;
  const title = personName(row);
  if (!title) return null;
  const id = String(row.id);
  const positions = (positionsByPerson.get(id) ?? []).slice(0, POSITIONS_KEPT);
  const educations = (extra.educations?.get(id) ?? []).slice(0, POSITIONS_KEPT);
  const affiliations = (extra.affiliations?.get(id) ?? []).slice(0, POSITIONS_KEPT);
  const schooling = educationSummary(educations);
  const parties = [...new Set(affiliations.map((a) => a.party).filter(Boolean))];
  return {
    externalId: catalogId('people-db-people', row.id),
    kind: 'judge',
    title,
    summary: trimTo(
      [positionsSummary(positions), schooling ? `Education: ${schooling}` : null]
        .filter(Boolean)
        .join('. '),
      SUMMARY_CHARS,
    ),
    url: personUrl(row.id, text(row.slug)),
    publishedAt: null,
    timeKnown: false,
    precision: 'day',
    tags: [
      PROVIDER,
      'judge',
      ...parties.map(partyTag),
      ...new Set(positions.map((p) => p.courtId).filter(Boolean)),
    ]
      .filter(Boolean)
      .slice(0, 40),
    data: {
      educations,
      politicalAffiliations: affiliations,
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

/**
 * One row of a disclosure detail table, reduced to what the report says. The
 * value columns are the report's letter codes (J: $15,000 or less, up to P4:
 * over $50 million), kept as codes.
 */
export function detailOf(kind, row) {
  const redacted = bool(row?.redacted);
  switch (kind) {
    case 'investments':
      return {
        description: text(row.description),
        incomeCode: text(row.income_during_reporting_period_code),
        incomeType: text(row.income_during_reporting_period_type),
        grossValueCode: text(row.gross_value_code),
        transaction: text(row.transaction_during_reporting_period),
        transactionDate: text(row.transaction_date) ?? text(row.transaction_date_raw),
        transactionValueCode: text(row.transaction_value_code),
        redacted,
      };
    case 'gifts':
      return {
        source: text(row.source),
        description: text(row.description),
        value: text(row.value),
        redacted,
      };
    case 'debts':
      return {
        creditor: text(row.creditor_name),
        description: text(row.description),
        valueCode: text(row.value_code),
        redacted,
      };
    case 'positions':
      return { position: text(row.position), organization: text(row.organization_name), redacted };
    case 'agreements':
      return { date: text(row.date_raw), partiesAndTerms: text(row.parties_and_terms), redacted };
    case 'reimbursements':
      return {
        source: text(row.source),
        date: text(row.date_raw),
        location: text(row.location),
        purpose: text(row.purpose),
        itemsPaid: text(row.items_paid_or_provided),
        redacted,
      };
    case 'spousalIncome':
      return { sourceType: text(row.source_type), date: text(row.date_raw), redacted };
    case 'nonInvestmentIncome':
      return {
        sourceType: text(row.source_type),
        date: text(row.date_raw),
        amount: text(row.income_amount),
        redacted,
      };
    default:
      return null;
  }
}

/** The words that name a detail row, for the summary. */
function detailLabel(kind, d) {
  switch (kind) {
    case 'investments':
      return d.description;
    case 'gifts':
      return [d.description, d.source].filter(Boolean).join(' from ');
    case 'debts':
      return [d.creditor, d.description].filter(Boolean).join(', ');
    case 'positions':
      return [d.position, d.organization].filter(Boolean).join(', ');
    case 'agreements':
      return d.partiesAndTerms;
    case 'reimbursements':
      return [d.source, d.purpose].filter(Boolean).join(', ');
    case 'spousalIncome':
    case 'nonInvestmentIncome':
      return d.sourceType;
    default:
      return null;
  }
}

/** Summary headings, in the order a report reads. */
const DETAIL_HEADINGS = [
  ['positions', 'Positions'],
  ['nonInvestmentIncome', 'Income'],
  ['spousalIncome', 'Spouse'],
  ['reimbursements', 'Reimbursements'],
  ['gifts', 'Gifts'],
  ['agreements', 'Agreements'],
  ['debts', 'Liabilities'],
  ['investments', 'Investments'],
];

/** What a report says, as a line: `Positions (2): Trustee, Trust #1; Investments (150): …`. */
export function disclosureSummary(detail) {
  const parts = [];
  for (const [kind, heading] of DETAIL_HEADINGS) {
    const d = detail?.[kind];
    if (!d?.count) continue;
    const names = d.items
      .filter((x) => !x.redacted)
      .map((x) => detailLabel(kind, x))
      .filter(Boolean)
      .slice(0, 5);
    parts.push(`${heading} (${d.count})${names.length ? `: ${names.join(', ')}` : ''}`);
  }
  return trimTo(parts.join('; '), SUMMARY_CHARS);
}

/**
 * One financial disclosure row, titled by the judge when the people file is
 * loaded and carrying what the report says when the detail tables are.
 */
export function disclosureItem(row, namesByPerson = new Map(), detailByDisclosure = new Map()) {
  if (!row?.id) return null;
  const year = num(row.year);
  const personId = text(row.person_id);
  const name = personId ? namesByPerson.get(personId) : null;
  const filepath = text(row.filepath);
  const url = filepath ? `${STORAGE}/${filepath.replace(/^\/+/, '')}` : text(row.download_filepath);
  const thumb = text(row.thumbnail);
  const when = looseDate(year === null ? '' : String(year));
  const detail = detailByDisclosure.get(String(row.id)) ?? {};
  return {
    externalId: catalogId('financial-disclosures', row.id),
    kind: 'financial-disclosure',
    title: name
      ? `${name} financial disclosure ${year ?? '?'}`
      : `Financial disclosure ${year ?? '?'} (person ${personId ?? '?'})`,
    summary: disclosureSummary(detail),
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
      counts: Object.fromEntries(
        Object.keys(DISCLOSURE_DETAIL_FILES).map((k) => [k, detail[k]?.count ?? 0]),
      ),
      ...Object.fromEntries(
        Object.keys(DISCLOSURE_DETAIL_FILES).map((k) => [k, detail[k]?.items ?? []]),
      ),
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
    externalId: catalogId('oral-arguments', row.id),
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
    externalId: catalogId('dockets', row.id),
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
    externalId: catalogId('fjc-integrated-database', row.id),
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

/**
 * One citation row as a patch to its opinion: the cite as a tag (so a search
 * for "410 U.S. 113" finds the case) and appended to data.citations. A row
 * without its three parts is nothing.
 */
export function citationPatch(row) {
  const cluster = text(row?.cluster_id);
  const volume = text(row?.volume);
  const reporter = text(row?.reporter);
  const page = text(row?.page);
  if (!cluster || !/^\d+$/.test(cluster) || !volume || !reporter || !page) return null;
  const cite = `${volume} ${reporter} ${page}`;
  return { externalId: cluster, tags: [cite], append: { citations: [cite] } };
}

/**
 * The mapping for one table's rows, given the side maps loaded for it: an
 * item, a patch (`{ patch }`), or null.
 */
export function rowItem(table, row, side = {}) {
  switch (table) {
    case 'courts':
      return courtItem(row);
    case 'people-db-people':
      return judgeItem(row, side.positions, side);
    case 'financial-disclosures':
      return disclosureItem(row, side.names, side.detail);
    case 'oral-arguments':
      return audioItem(row);
    case 'opinion-clusters':
      return clusterItem(row);
    case 'citations': {
      const patch = citationPatch(row);
      return patch ? { patch } : null;
    }
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
 * Where a run starts. `version` is the dump date the walk is over; `walked`
 * the tables of it already walked; `file` and `record` the position in the
 * one in progress (data records already read, so the reader skips that many);
 * `modifiedWatermark` the newest date_modified a COMPLETE pass has seen,
 * below which a later pass skips rows; `maxModified` the same for the pass in
 * progress; `done` that every table in `files` is walked.
 *
 * A cursor from before ID_SCHEME 2 has no `walked`: the tables before its
 * `file` in the old order were walked (all of them if it was done), except
 * the re-keyed ones, which were written under bare ids and so are walked
 * again; and its watermark is dropped, since a re-keyed table must be walked
 * whole.
 */
export function resumeFrom(prev, files = FILES) {
  const version = /^\d{4}-\d{2}-\d{2}$/.test(String(prev?.version ?? '')) ? prev.version : null;
  const current = prev?.idScheme === ID_SCHEME;
  let walked = [];
  if (version && Array.isArray(prev?.walked)) {
    walked = prev.walked.filter((f) => files.includes(f));
  } else if (version && !current) {
    const at = LEGACY_FILES.indexOf(prev?.file);
    const before = prev?.done === true ? LEGACY_FILES : at >= 0 ? LEGACY_FILES.slice(0, at) : [];
    walked = before.filter((f) => files.includes(f) && !REKEYED.includes(f));
  }
  const pending = files.filter((f) => !walked.includes(f));
  // A record count belongs to the file it was counted in: a cursor left in a
  // table that has since been turned off (or was walked) starts the next one.
  const file = pending.includes(prev?.file) ? prev.file : (pending[0] ?? null);
  const record = file !== null && file === prev?.file ? Math.floor(Number(prev?.record)) : 0;
  const watermark =
    current && typeof prev?.modifiedWatermark === 'string' && prev.modifiedWatermark
      ? prev.modifiedWatermark
      : null;
  const max = typeof prev?.maxModified === 'string' && prev.maxModified ? prev.maxModified : null;
  return {
    version,
    walked,
    file,
    record: record > 0 ? record : 0,
    modifiedWatermark: watermark,
    maxModified: max,
    done: version !== null && pending.length === 0,
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

/** Rows of a side file grouped by one column, each mapped and capped at `keep`. */
async function groupBy(path, column, map, keep = POSITIONS_KEPT) {
  const by = new Map();
  for await (const { row } of bzip2CsvRows(path, { escape: CSV_ESCAPE })) {
    const key = text(row[column]);
    if (!key) continue;
    if (!by.has(key)) by.set(key, []);
    const list = by.get(key);
    if (list.length < keep) list.push(map(row));
  }
  return by;
}

/** Every position by person id, from the positions file: 51k small objects. */
export const loadPositions = (path) => groupBy(path, 'person_id', positionOf);

/** Every person's display name by id, from the people file, for disclosure titles. */
export async function loadNames(path) {
  const by = new Map();
  for await (const { row } of bzip2CsvRows(path, { escape: CSV_ESCAPE })) {
    const name = personName(row);
    if (row.id && name) by.set(String(row.id), name);
  }
  return by;
}

/** Every school's name by id. */
export async function loadSchools(path) {
  const by = new Map();
  for await (const { row } of bzip2CsvRows(path, { escape: CSV_ESCAPE })) {
    const name = text(row.name);
    if (row.id && name) by.set(String(row.id), name);
  }
  return by;
}

/** Every education by person id, named by the schools loaded before it. */
export const loadEducations = (path, side) =>
  groupBy(path, 'person_id', (row) => educationOf(row, side.schools));

/** Every political affiliation by person id. */
export const loadAffiliations = (path) => groupBy(path, 'person_id', affiliationOf);

/**
 * One disclosure detail table folded into `side.detail`: per disclosure id,
 * `{ count, items }` under the table's kind, the first DETAIL_KEPT rows kept
 * and every row counted. Investments are ~2M rows; this keeps 32k small lists.
 */
export function loadDetail(kind) {
  return async (path, side) => {
    const by = side.detail ?? new Map();
    for await (const { row } of bzip2CsvRows(path, { escape: CSV_ESCAPE })) {
      const id = text(row.financial_disclosure_id);
      if (!id) continue;
      if (!by.has(id)) by.set(id, {});
      const entry = by.get(id);
      entry[kind] ??= { count: 0, items: [] };
      entry[kind].count += 1;
      if (entry[kind].items.length < DETAIL_KEPT) entry[kind].items.push(detailOf(kind, row));
    }
    return by;
  };
}

/**
 * What a table's mapping needs loaded beside it, in load order: each side
 * file is loaded whole into `side[key]`, and a loader may read what an
 * earlier one loaded (educations name their schools).
 */
export const SIDE_FOR = {
  'people-db-people': [
    { file: 'people-db-positions', key: 'positions', load: loadPositions },
    { file: 'people-db-schools', key: 'schools', load: loadSchools },
    { file: 'people-db-educations', key: 'educations', load: loadEducations },
    { file: 'people-db-political-affiliations', key: 'affiliations', load: loadAffiliations },
  ],
  'financial-disclosures': [
    { file: 'people-db-people', key: 'names', load: loadNames },
    ...Object.entries(DISCLOSURE_DETAIL_FILES).map(([kind, file]) => ({
      file,
      key: 'detail',
      load: loadDetail(kind),
    })),
  ],
};

// ── The adapter ──────────────────────────────────────────────────────────────

export const courtlistenerCatalog = defineAdapter({
  name: 'courtlistener-catalog',
  title: 'CourtListener: the whole catalogue',
  collection: 'law',
  description:
    'Everything CourtListener publishes as bulk data, walked from the quarterly dumps: every court (3.4k), every judge with their positions (16k), every judge with their positions, education and party (16k), every judicial financial disclosure with its PDF and what it reports: investments, gifts, debts, outside positions and income, reimbursements (32k), every oral argument recording with its MP3 (100k), every opinion cluster (10 million: case name, court, date filed, syllabus, precedential status, citation count) with its reporter citations, and the FJC Integrated Database of district court cases (a few million). Public domain, attributed on every row. Downloads each bzip2 CSV with resume, walks it 500 rows a batch across as many runs as it takes, and after a complete pass skips the rows an earlier dump already carried. Dockets (tens of millions of rows, 5 GB) are off unless turned on here.',
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
      options: ['true', 'false'],
      help: 'The Federal Judicial Center’s record of every district court case, a 280 MB download of a few million rows, as kind `case` with no page of its own. On by default.',
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
  defaults: { dockets: 'false', fjc: 'true', batchRows: BATCH_ROWS, pauseMs: PAUSE_MS },
  defaultSources: [
    {
      slug: 'courtlistener-catalog',
      name: 'Law: every court, judge, disclosure, oral argument and opinion in CourtListener',
      config: { dockets: 'false', fjc: 'true', batchRows: BATCH_ROWS, pauseMs: PAUSE_MS },
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
    const walked = fresh ? [] : [...state.walked];
    let file = fresh ? files[0] : state.file;
    let record = fresh ? 0 : state.record;
    let maxModified = fresh ? null : state.maxModified;
    const cursorAt = (f, n) => ({
      idScheme: ID_SCHEME,
      version,
      walked: [...walked],
      file: f,
      record: n,
      modifiedWatermark: watermark,
      maxModified,
      done: false,
    });
    if (!fresh && prev?.version && prev?.idScheme !== ID_SCHEME) {
      log(
        `ids re-keyed (scheme ${ID_SCHEME}): walking ${files.filter((f) => !walked.includes(f)).join(', ')}`,
      );
    }
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
    // The table in progress first, then every table of this dump not yet walked.
    while (file) {
      const table = file;
      const kind = KINDS[table];
      const mark = NO_WATERMARK.has(table) ? null : watermark;

      // The side files first, loaded whole; then the table itself.
      const side = {};
      for (const need of SIDE_FOR[table] ?? []) {
        const got = await fetchFile(need.file);
        if (got.stop) return got.stop;
        side[need.key] = await need.load(got.path, side);
        log(`${need.file} loaded: ${side[need.key].size} ${need.key}`);
      }
      const got = await fetchFile(table);
      if (got.stop) return got.stop;
      const path = got.path;

      // Walk the rows from where the cursor says, a batch at a time.
      let batch = [];
      let patches = [];
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
          if (isStale(modified, mark)) {
            stale += 1;
            continue;
          }
          const item = rowItem(table, row, side);
          if (!item) {
            skipped += 1;
            continue;
          }
          if (item.patch) patches.push(item.patch);
          else batch.push(item);
          if (batch.length + patches.length >= batchRows) {
            written += batch.length + patches.length;
            batches += 1;
            yield { items: batch, patches, cursor: cursorAt(table, n) };
            batch = [];
            patches = [];
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
      if (batch.length || patches.length) {
        written += batch.length + patches.length;
        batches += 1;
        yield { items: batch, patches, cursor: cursorAt(table, n) };
        batch = [];
        patches = [];
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
      walked.push(table);
      file = files.find((f) => !walked.includes(f)) ?? null;
      if (file) yield { items: [], cursor: cursorAt(file, 0) };
    }

    // Every file is walked; the small ones can go too.
    for (const name of await readdir(dir).catch(() => [])) {
      if (name.endsWith(`-${version}.csv.bz2`)) await unlink(join(dir, name)).catch(() => {});
    }

    return {
      cursor: {
        idScheme: ID_SCHEME,
        version,
        walked: [...walked],
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
