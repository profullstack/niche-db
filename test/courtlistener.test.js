import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

/**
 * CourtListener in the `law` collection: the live feeds and API on one side,
 * the bulk-data catalogue on the other, sharing ids.
 *
 * The feed fixtures are three entries and two items cut from the live feeds
 * on 2026-09-22, chosen so the parser meets what the feeds carry: a
 * published date in the year 2109, one a month ahead, the court as an Atom
 * author, the PDF as an enclosure, the MP3 with its length and duration.
 * The API rows are built from the shapes the v4 API answered the same day.
 * The catalogue rows are built from the dump headers, and the walk runs
 * against tiny bzip2 files written by the system bzip2 into a temp dump
 * directory, behind a fake S3.
 */
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';

const { config } = await import('../packages/config/src/index.js');
const { normaliseItem } = await import('../packages/core/src/adapter.js');
const { ADAPTERS, adapterByName } = await import('../packages/adapters/src/index.js');
const { COLLECTIONS, DEFAULT_FEEDS } = await import('../packages/core/src/seed.js');
const live = await import('../packages/adapters/src/courtlistener.js');
const cat = await import('../packages/adapters/src/courtlistener-catalog.js');

const fixture = (name) =>
  readFile(new URL(`../packages/adapters/test/fixtures/${name}`, import.meta.url), 'utf8');

/** Built at runtime so the character itself never appears in this file. */
const EM_DASH = String.fromCharCode(0x2014);

/** 2026-09-22 noon UTC, the day the fixtures were cut. */
const NOW = Date.UTC(2026, 8, 22, 12);

// ── The registry and the seed ────────────────────────────────────────────────

describe('registry and seed', () => {
  test('four adapters in law, one of them the old name, all keyed to the same ids', () => {
    const names = ADAPTERS.filter((a) => a.collection === 'law').map((a) => a.name);
    expect(names.sort()).toEqual([
      'courtlistener',
      'courtlistener-api',
      'courtlistener-catalog',
      'courtlistener-oral-arguments',
    ]);
    expect(
      ADAPTERS.filter((a) => a.name.startsWith('courtlistener') && a.collection !== 'law'),
    ).toEqual([]);
    expect(adapterByName('courtlistener').needsEnv).toBeUndefined();
    expect(adapterByName('courtlistener-oral-arguments').needsEnv).toBeUndefined();
    expect(adapterByName('courtlistener-api').needsEnv).toEqual(['courtlistenerToken']);
    expect(adapterByName('courtlistener-catalog').budgetMs).toBe(cat.BUDGET_MS);
  });

  test('the default sources, their cadences, and the API budget they spend', () => {
    const sources = ADAPTERS.filter((a) => a.collection === 'law').flatMap((a) =>
      a.defaultSources.map((s) => ({
        ...s,
        adapter: a.name,
        cadence: s.cadenceMinutes ?? a.cadenceMinutes,
      })),
    );
    const bySlug = Object.fromEntries(sources.map((s) => [s.slug, s]));
    expect(Object.keys(bySlug).sort()).toEqual([
      'courtlistener-catalog',
      'courtlistener-disclosures',
      'courtlistener-dockets',
      'courtlistener-judges',
      'courtlistener-opinions',
      'courtlistener-opinions-scotus',
      'courtlistener-oral-arguments',
    ]);
    expect(bySlug['courtlistener-opinions-scotus'].config).toEqual({ court: 'scotus' });
    expect(bySlug['courtlistener-opinions'].cadence).toBe(30);
    expect(bySlug['courtlistener-oral-arguments'].cadence).toBe(60);
    expect(bySlug['courtlistener-dockets'].cadence).toBe(120);
    expect(bySlug['courtlistener-judges'].cadence).toBe(1440);
    expect(bySlug['courtlistener-disclosures'].cadence).toBe(1440);
    // One request a run, so requests a day is runs a day.
    const perDay = sources
      .filter((s) => s.adapter === 'courtlistener-api')
      .reduce((n, s) => n + (24 * 60) / s.cadence, 0);
    expect(perDay).toBe(live.DEFAULT_API_REQUESTS_PER_DAY);
    expect(perDay).toBeLessThanOrEqual(20);
    expect(perDay).toBeLessThan(live.DAILY_API_BUDGET / 5);
  });

  test('the law collection, its feeds, and filings no longer claiming opinions', () => {
    const law = COLLECTIONS.find((c) => c.slug === 'law');
    expect(law.name).toBe('Courts & case law');
    expect(law.description).toContain('CourtListener');
    expect(COLLECTIONS.find((c) => c.slug === 'filings').description).not.toContain('opinion');
    const feeds = DEFAULT_FEEDS.filter((f) => f.collection === 'law');
    expect(feeds.map((f) => f.slug)).toEqual([
      'court-opinions',
      'scotus-opinions',
      'precedential-opinions',
      'oral-arguments',
      'federal-dockets',
      'federal-judges',
      'judicial-financial-disclosures',
      'courts',
    ]);
    const q = Object.fromEntries(feeds.map((f) => [f.slug, f.query]));
    expect(q['court-opinions']).toEqual({ kinds: ['opinion'] });
    expect(q['scotus-opinions']).toEqual({ kinds: ['opinion'], tags: ['scotus'] });
    expect(q['precedential-opinions']).toEqual({ kinds: ['opinion'], tags: ['precedential'] });
    expect(q['federal-dockets']).toEqual({ kinds: ['docket'] });
    expect(q.courts).toEqual({ kinds: ['court'] });
    for (const f of feeds) expect(f.description ?? '').not.toContain(EM_DASH);
    expect(
      DEFAULT_FEEDS.filter((f) => f.collection === 'filings').flatMap((f) => f.query.sources),
    ).not.toContain('courtlistener-opinions');
  });

  test('no em dashes in the adapters', async () => {
    for (const name of ['courtlistener.js', 'courtlistener-catalog.js']) {
      const src = await readFile(
        new URL(`../packages/adapters/src/${name}`, import.meta.url),
        'utf8',
      );
      expect(src).not.toContain(EM_DASH);
    }
  });
});

// ── The feeds ────────────────────────────────────────────────────────────────

describe('feeds', () => {
  test('feedDate keeps the day the court wrote and drops one it could not have', () => {
    const day = (y, m, d) => new Date(Date.UTC(y, m - 1, d, 12));
    expect(live.feedDate('2026-09-22T00:00:00-07:00', NOW)).toEqual({
      publishedAt: day(2026, 9, 22),
      timeKnown: false,
      precision: 'day',
    });
    expect(live.feedDate('Mon, 21 Sep 2026 00:00:00 -0400', NOW).publishedAt).toEqual(
      day(2026, 9, 21),
    );
    expect(live.feedDate('2109-09-06T00:00:00-08:00', NOW).publishedAt).toBeNull();
    expect(live.feedDate('2026-10-20T00:00:00-07:00', NOW).publishedAt).toBeNull();
    expect(live.feedDate('2026-09-23T00:00:00-07:00', NOW).publishedAt).toEqual(day(2026, 9, 23));
    expect(live.feedDate('', NOW).publishedAt).toBeNull();
    expect(live.feedDate('not a date', NOW).publishedAt).toBeNull();
  });

  test('the opinion feed: cluster ids, the court, the status tags, a date of 2109 stored as none', async () => {
    const items = live.parseOpinionFeed(await fixture('courtlistener-opinions.atom'), { now: NOW });
    expect(items).toHaveLength(3);
    const guam = items[0];
    expect(guam.externalId).toBe('10929933');
    expect(guam.kind).toBe('opinion');
    expect(guam.title).toBe('People v. Chewek, I and Detor, M.');
    expect(guam.url).toBe(
      'https://www.courtlistener.com/opinion/10929933/people-v-chewek-i-and-detor-m/',
    );
    expect(guam.publishedAt).toBeNull();
    expect(guam.data.published).toBe('2109-09-06T00:00:00-08:00');
    expect(guam.data.court).toBe('Superior Court of Guam');
    expect(guam.data.pdf).toMatch(/^https:\/\/storage\.courtlistener\.com\/pdf\//);
    expect(guam.data.precedentialStatus).toBe('Unknown');
    expect(guam.tags).toEqual(['courtlistener']);
    expect(guam.summary).not.toContain('Original document');
    expect(guam.data.attribution).toBe(live.ATTRIBUTION);
    // The one a month ahead is undated too; the one from today keeps its day.
    expect(items[1].publishedAt).toBeNull();
    expect(items[2].publishedAt).toEqual(new Date(Date.UTC(2026, 8, 22, 12)));
    const published = items.find((i) => i.data.precedentialStatus === 'Published');
    expect(published.tags).toEqual(['courtlistener', 'published', 'precedential']);
    for (const i of items) {
      const n = normaliseItem(i);
      expect(n).not.toBeNull();
      expect(n.precision).toBe('day');
      expect(n.timeKnown).toBe(false);
    }
    // A per-court source tags its court.
    const scotus = live.parseOpinionFeed(await fixture('courtlistener-opinions.atom'), {
      court: 'scotus',
      now: NOW,
    });
    expect(scotus[0].tags).toContain('scotus');
    expect(scotus[0].data.courtId).toBe('scotus');
  });

  test('the podcast: audio ids, the MP3, its size and duration, the court and the day', async () => {
    const items = live.parseOralArgumentFeed(await fixture('courtlistener-podcast.xml'), {
      now: NOW,
    });
    expect(items).toHaveLength(2);
    const [a] = items;
    expect(a.externalId).toBe('106466');
    expect(a.kind).toBe('oral-argument');
    expect(a.title).toBe('United States v. Malakhov');
    expect(a.url).toBe(
      'https://www.courtlistener.com/audio/106466/united-states-of-america-v-malakhov/',
    );
    expect(a.summary).toBeNull(); // the description repeats the title
    expect(a.publishedAt).toEqual(new Date(Date.UTC(2026, 8, 21, 12)));
    expect(a.data).toMatchObject({
      court: 'Court of Appeals for the Second Circuit',
      mp3: 'https://storage.courtlistener.com/mp3/2026/09/21/united_states_v._malakhov_cl_3.mp3',
      mp3Bytes: 8448903,
      durationSeconds: 1388,
      attribution: live.ATTRIBUTION,
    });
    expect(a.tags).toEqual(['courtlistener']);
    expect(normaliseItem(a)).not.toBeNull();
  });

  test('URLs: all courts by default, one court by id, junk ignored', () => {
    expect(live.opinionFeedUrl()).toBe('https://www.courtlistener.com/feed/court/all/');
    expect(live.opinionFeedUrl('scotus')).toBe('https://www.courtlistener.com/feed/court/scotus/');
    expect(live.opinionFeedUrl(' CA9 ')).toBe('https://www.courtlistener.com/feed/court/ca9/');
    expect(live.opinionFeedUrl('../etc')).toBe('https://www.courtlistener.com/feed/court/all/');
    expect(live.podcastUrl('ca2')).toBe('https://www.courtlistener.com/podcast/court/ca2/');
    expect(live.statusTags('Published')).toEqual(['published', 'precedential']);
    expect(live.statusTags('Unpublished')).toEqual(['unpublished']);
    expect(live.statusTags('Unknown')).toEqual([]);
    expect(live.statusTags('')).toEqual([]);
  });
});

// ── The API ──────────────────────────────────────────────────────────────────

describe('API', () => {
  test('one request: newest first, twenty rows, and only what changed since the cursor', () => {
    expect(live.apiUrl('dockets')).toBe(
      'https://www.courtlistener.com/api/rest/v4/dockets/?order_by=-date_modified&page_size=20',
    );
    expect(live.apiUrl('people', { maxModified: '2026-09-22T00:30:08.200681-07:00' })).toBe(
      'https://www.courtlistener.com/api/rest/v4/people/?order_by=-date_modified&page_size=20&date_modified__gt=2026-09-22T00%3A30%3A08.200681-07%3A00',
    );
    expect(live.apiUrl('financial-disclosures', { maxModified: null })).toContain(
      '/financial-disclosures/?',
    );
  });

  test('the cursor is the newest instant, compared across offsets and kept verbatim', () => {
    const next = live.nextCursor({ maxModified: '2026-09-21T23:00:00-07:00' }, [
      { date_modified: '2026-09-22T00:30:08.200681-07:00' },
      { date_modified: '2026-09-22T08:00:00+01:00' }, // 07:00Z, before 07:30Z: earlier
      { date_modified: 'garbage' },
      {},
    ]);
    expect(next.maxModified).toBe('2026-09-22T00:30:08.200681-07:00');
    expect(typeof next.checkedAt).toBe('string');
    expect(
      live.nextCursor({ maxModified: '2026-09-23T00:00:00-07:00' }, [
        { date_modified: '2026-09-22T00:00:00-07:00' },
      ]).maxModified,
    ).toBe('2026-09-23T00:00:00-07:00');
    expect(live.nextCursor({}, []).maxModified).toBeNull();
  });

  const docket = {
    id: 74829702,
    court_id: 'ilnb',
    absolute_url: '/docket/74829702/basje-l-lewis/',
    date_modified: '2026-09-22T00:30:08.200681-07:00',
    source: 1,
    assigned_to_str: 'Dorothy Eisenberg',
    date_filed: '2026-09-22',
    date_terminated: null,
    case_name: 'Basje L Lewis',
    case_name_full: '',
    slug: 'basje-l-lewis',
    docket_number: '26-15664',
    pacer_case_id: '1646171',
    cause: '',
    nature_of_suit: '',
    blocked: false,
  };

  test('a docket row: the case with its number, the court as a tag, blocked ones left out', () => {
    const item = live.docketItem(docket);
    expect(item).toMatchObject({
      externalId: '74829702',
      kind: 'docket',
      title: 'Basje L Lewis (26-15664)',
      url: 'https://www.courtlistener.com/docket/74829702/basje-l-lewis/',
      tags: ['courtlistener', 'ilnb'],
      precision: 'day',
      timeKnown: false,
    });
    expect(item.publishedAt).toEqual(new Date(Date.UTC(2026, 8, 22, 12)));
    expect(item.data).toEqual({
      provider: 'courtlistener',
      court: 'ilnb',
      docketNumber: '26-15664',
      natureOfSuit: null,
      cause: null,
      dateFiled: '2026-09-22',
      dateTerminated: null,
      assignedTo: 'Dorothy Eisenberg',
      pacerCaseId: '1646171',
      source: 1,
      dateModified: '2026-09-22T00:30:08.200681-07:00',
      attribution: live.ATTRIBUTION,
    });
    expect(live.docketItem({ ...docket, blocked: true })).toBeNull();
    expect(live.docketItem({ ...docket, absolute_url: null }).url).toBe(
      'https://www.courtlistener.com/docket/74829702/basje-l-lewis/',
    );
    expect(normaliseItem(item)).not.toBeNull();
  });

  test('a person row: the name assembled, the page built from id and slug, aliases left out', () => {
    const person = {
      id: 14468,
      is_alias_of: null,
      slug: 'mark-christopher-scarsi',
      name_first: 'Mark',
      name_middle: 'Christopher',
      name_last: 'Scarsi',
      name_suffix: '',
      date_dob: '1964-01-01',
      dob_city: 'Syracuse',
      dob_state: 'NY',
      dob_country: 'United States',
      gender: 'm',
      has_photo: false,
      date_modified: '2026-06-24T10:55:24.258243-07:00',
    };
    const item = live.judgeItem(person);
    expect(item).toMatchObject({
      externalId: '14468',
      kind: 'judge',
      title: 'Mark Christopher Scarsi',
      url: 'https://www.courtlistener.com/person/14468/mark-christopher-scarsi/',
      tags: ['courtlistener', 'judge'],
    });
    expect(item.data.birthplace).toBe('Syracuse, NY, United States');
    expect(
      live.judgeItem({
        ...person,
        is_alias_of: 'https://www.courtlistener.com/api/rest/v4/people/1/',
      }),
    ).toBeNull();
    expect(
      live.personName({
        name_first: 'Robert',
        name_middle: 'P.',
        name_last: 'Young',
        name_suffix: 'jr',
      }),
    ).toBe('Robert P. Young jr');
    expect(normaliseItem(item)).not.toBeNull();
  });

  test('a disclosure row: the person off its URL, the year as the date, the PDF as the link', () => {
    const item = live.disclosureItem({
      id: 32190,
      person: 'https://www.courtlistener.com/api/rest/v4/people/338/',
      filepath:
        'https://storage.courtlistener.com/us/federal/judicial/financial-disclosures/338/richard-franklin-boulware-ii-disclosure.2019.pdf',
      thumbnail:
        'https://storage.courtlistener.com/us/federal/judicial/financial-disclosures/338/x.png',
      year: 2019,
      page_count: 7,
      report_type: -1,
      is_amended: false,
      sha1: 'befbe774dab5b55366140b64364bd5103ca8b986',
      date_modified: '2024-11-14T23:46:19.228654-08:00',
    });
    expect(item).toMatchObject({
      externalId: '32190',
      kind: 'financial-disclosure',
      title: 'Financial disclosure 2019 (person 338)',
      url: 'https://storage.courtlistener.com/us/federal/judicial/financial-disclosures/338/richard-franklin-boulware-ii-disclosure.2019.pdf',
      precision: 'year',
    });
    expect(item.publishedAt).toEqual(new Date(Date.UTC(2019, 6, 1, 12)));
    expect(item.data).toMatchObject({
      year: 2019,
      pageCount: 7,
      personId: '338',
      isAmended: false,
    });
    expect(normaliseItem(item)).not.toBeNull();
  });

  test('pull: one request with the token, the cursor moved, and no token is an error', async () => {
    const calls = [];
    const http = {
      async json(url, opts) {
        calls.push({ url, auth: opts.headers.authorization, ua: opts.headers['user-agent'] });
        return {
          count: 'x',
          next: 'y',
          results: [
            docket,
            { ...docket, id: 2, blocked: true, date_modified: '2026-09-22T01:00:00-07:00' },
          ],
        };
      },
    };
    const res = await live.courtlistenerApi.pull({
      config: { resource: 'dockets' },
      cursor: { maxModified: '2026-09-21T00:00:00-07:00' },
      env: { courtlistenerToken: 'secret' },
      http,
      log: () => {},
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].auth).toBe('Token secret');
    expect(calls[0].ua).toBe(live.USER_AGENT);
    expect(calls[0].url).toContain('date_modified__gt=2026-09-21T00%3A00%3A00-07%3A00');
    expect(res.items).toHaveLength(1);
    expect(res.cursor.maxModified).toBe('2026-09-22T01:00:00-07:00');
    expect(res.note).toContain('1 request');
    await expect(
      live.courtlistenerApi.pull({ config: {}, cursor: {}, env: {}, http, log: () => {} }),
    ).rejects.toThrow(/COURTLISTENER_TOKEN/);
    expect(calls).toHaveLength(1);
  });
});

// ── The catalogue: listing, cursor, rows ─────────────────────────────────────

const HEADERS = {
  courts:
    'id,pacer_court_id,pacer_has_rss_feed,pacer_rss_entry_types,date_last_pacer_contact,fjc_court_id,date_modified,in_use,has_opinion_scraper,has_oral_argument_scraper,position,citation_string,short_name,full_name,url,start_date,end_date,jurisdiction,notes,parent_court_id',
  'people-db-people':
    'id,date_created,date_modified,date_completed,fjc_id,slug,name_first,name_middle,name_last,name_suffix,date_dob,date_granularity_dob,date_dod,date_granularity_dod,dob_city,dob_state,dob_country,dod_city,dod_state,dod_country,gender,religion,ftm_total_received,ftm_eid,has_photo,is_alias_of_id',
  'people-db-positions':
    'id,date_created,date_modified,position_type,job_title,sector,organization_name,location_city,location_state,date_nominated,date_elected,date_recess_appointment,date_referred_to_judicial_committee,date_judicial_committee_action,judicial_committee_action,date_hearing,date_confirmation,date_start,date_granularity_start,date_termination,termination_reason,date_granularity_termination,date_retirement,nomination_process,vote_type,voice_vote,votes_yes,votes_no,votes_yes_percent,votes_no_percent,how_selected,has_inferred_values,appointer_id,court_id,person_id,predecessor_id,school_id,supervisor_id',
  'financial-disclosures':
    'id,date_created,date_modified,year,download_filepath,filepath,thumbnail,thumbnail_status,page_count,sha1,report_type,is_amended,addendum_content_raw,addendum_redacted,has_been_extracted,person_id',
  'oral-arguments':
    'id,date_created,date_modified,source,case_name_short,case_name,case_name_full,judges,sha1,download_url,local_path_mp3,local_path_original_file,filepath_ia,ia_upload_failure_count,duration,processing_complete,date_blocked,blocked,stt_status,stt_transcript,stt_source,docket_id',
  'opinion-clusters':
    'id,date_created,date_modified,judges,date_filed,date_filed_is_approximate,slug,case_name_short,case_name,case_name_full,scdb_id,scdb_decision_direction,scdb_votes_majority,scdb_votes_minority,source,procedural_history,attorneys,nature_of_suit,posture,syllabus,headnotes,summary,disposition,history,other_dates,cross_reference,correction,citation_count,precedential_status,date_blocked,blocked,filepath_json_harvard,filepath_pdf_harvard,docket_id,arguments,headmatter',
  dockets:
    'id,date_created,date_modified,source,appeal_from_str,assigned_to_str,referred_to_str,panel_str,date_last_index,date_cert_granted,date_cert_denied,date_argued,date_reargued,date_reargument_denied,date_filed,date_terminated,date_last_filing,case_name_short,case_name,case_name_full,slug,docket_number,docket_number_core,pacer_case_id,cause,nature_of_suit,jury_demand,jurisdiction_type,appellate_fee_status,appellate_case_type_information,mdl_status,filepath_local,filepath_ia,filepath_ia_json,ia_upload_failure_count,ia_needs_upload,ia_date_first_change,view_count,date_blocked,blocked,appeal_from_id,assigned_to_id,court_id,idb_data_id,originating_court_information_id,referred_to_id,federal_dn_case_type,federal_dn_office_code,federal_dn_judge_initials_assigned,federal_dn_judge_initials_referred,federal_defendant_number,parent_docket_id,docket_number_raw,docket_number_source',
  'fjc-integrated-database':
    'id,date_created,date_modified,dataset_source,office,docket_number,origin,date_filed,jurisdiction,nature_of_suit,title,section,subsection,diversity_of_residence,class_action,monetary_demand,county_of_residence,arbitration_at_filing,arbitration_at_termination,multidistrict_litigation_docket_number,plaintiff,defendant,date_transfer,transfer_office,transfer_docket_number,transfer_origin,date_terminated,termination_class_action_status,procedural_progress,disposition,nature_of_judgement,amount_received,judgment,pro_se,year_of_tape,nature_of_offense,version,circuit_id,district_id',
};

/** A row object with every column of the table null except the ones given. */
function rowOf(table, values) {
  const row = {};
  for (const h of HEADERS[table].split(',')) row[h] = null;
  return { ...row, ...values };
}

const ROWS = {
  courts: [
    rowOf('courts', {
      id: 'nc',
      date_modified: '2016-09-08 20:38:41.131652+00',
      in_use: 't',
      has_opinion_scraper: 't',
      has_oral_argument_scraper: 'f',
      position: '366.97',
      citation_string: 'N.C.',
      short_name: 'Supreme Court of North Carolina',
      full_name: 'Supreme Court of North Carolina',
      url: 'http://www.nccourts.org/courts/appellate/supreme/',
      start_date: '1799-01-01',
      jurisdiction: 'S',
      notes: 'Created by Lawbox\nStart date: http://example.org',
      pacer_rss_entry_types: '',
    }),
    rowOf('courts', {
      id: 'minnag',
      date_modified: '2017-02-01 17:56:35.255825+00',
      in_use: 't',
      short_name: "Minn. Att'y Gen.",
      full_name: 'Minnesota Attorney General Reports',
      jurisdiction: 'SAG',
      parent_court_id: 'minn',
    }),
  ],
  'people-db-people': [
    rowOf('people-db-people', {
      id: '2749',
      date_modified: '2020-11-25 16:30:20.6966+00',
      fjc_id: '2031',
      slug: 'spottswood-william-robinson-iii',
      name_first: 'Spottswood',
      name_middle: 'William',
      name_last: 'Robinson',
      name_suffix: '3',
      date_dob: '1916-07-26',
      date_granularity_dob: '%Y-%m-%d',
      date_dod: '1998-10-11',
      dob_city: 'Richmond',
      dob_state: 'VA',
      dob_country: 'United States',
      gender: 'm',
      has_photo: 't',
    }),
    rowOf('people-db-people', {
      id: '7607',
      date_modified: '2018-06-27 21:22:40.185313+00',
      slug: 'robert-p-young-jr',
      name_first: 'Robert',
      name_middle: 'P.',
      name_last: 'Young',
      name_suffix: 'jr',
      has_photo: 'f',
      is_alias_of_id: '4803',
    }),
  ],
  'people-db-positions': [
    rowOf('people-db-positions', {
      id: '172',
      date_modified: '2016-04-20 15:15:55.6036+00',
      position_type: 'jud',
      job_title: '',
      court_id: 'cadc',
      date_start: '1966-10-06',
      date_termination: '1998-10-11',
      appointer_id: '3355',
      how_selected: 'a_pres',
      person_id: '2749',
    }),
    rowOf('people-db-positions', {
      id: '173',
      date_modified: '2016-04-20 15:15:55.612603+00',
      job_title: 'Private practice',
      organization_name: '',
      location_city: 'Richmond',
      date_start: '1943-01-01',
      date_granularity_start: '%Y',
      date_termination: '1966-01-01',
      person_id: '2749',
    }),
  ],
  'financial-disclosures': [
    rowOf('financial-disclosures', {
      id: '1108',
      date_modified: '2021-01-04 03:23:52.327643+00',
      year: '2009',
      download_filepath:
        'https://example.org/Harry S Mattice Financial Disclosure Report for 2009.pdf',
      filepath:
        'us/federal/judicial/financial-disclosures/2084/harry-sandlin-mattice-jr-disclosure.2009.pdf',
      thumbnail: 'us/federal/judicial/financial-disclosures/2084/x-thumbnail_1.png',
      page_count: '7',
      sha1: '329210df4a94fa23ed0423f64220deca8a7a0a3e',
      report_type: '-1',
      is_amended: 'f',
      addendum_content_raw: 'Par III. A, "Non-Investment Income".\nTrust Assets',
      person_id: '2084',
    }),
  ],
  'oral-arguments': [
    rowOf('oral-arguments', {
      id: '17',
      date_created: '2014-10-31 02:33:10.810318+00',
      date_modified: '2024-06-25 04:29:12.146483+00',
      source: 'C',
      case_name_short: 'Ayala',
      case_name: 'Ayala v. Shinseki',
      case_name_full: '',
      judges: '',
      sha1: '898f21803ba8c5eea92aba5072e1d3c8a3714b96',
      download_url: 'http://www.ca1.uscourts.gov/files/audio/13-2260.mp3',
      local_path_mp3: 'mp3/2014/10/28/ayala_v._shinseki_cl.mp3',
      duration: '879',
      blocked: 'f',
      docket_id: '4272451',
    }),
    rowOf('oral-arguments', {
      id: '18',
      date_modified: '2024-06-25 04:29:12.146483+00',
      case_name: 'Sealed v. Sealed',
      local_path_mp3: 'mp3/2014/10/28/sealed.mp3',
      blocked: 't',
    }),
  ],
  'opinion-clusters': [
    rowOf('opinion-clusters', {
      id: '7290305',
      date_modified: '2024-11-05 19:51:49.079046+00',
      judges: '',
      date_filed: '2002-06-06',
      date_filed_is_approximate: 'f',
      slug: 'lawless-v-muskingum-county',
      case_name_short: 'Lawless',
      case_name: 'Lawless v. Muskingum County',
      case_name_full: 'Robert J. LAWLESS v. MUSKINGUM COUNTY, OHIO',
      scdb_id: '',
      source: 'U',
      attorneys: 'Latham Castle, for appellant.',
      syllabus: `Held: ${'the court said so. '.repeat(60)}`,
      citation_count: '2',
      precedential_status: 'Published',
      blocked: 'f',
      docket_id: '64278691',
    }),
    rowOf('opinion-clusters', {
      id: '108713',
      date_modified: '2024-11-08 17:44:17.193082+00',
      judges: 'Warren',
      date_filed: '1954-05-17',
      date_filed_is_approximate: 't',
      slug: 'brown-v-board-of-education',
      case_name: 'Brown v. Board of Education',
      scdb_id: '1953-081',
      scdb_decision_direction: '2',
      source: 'LR',
      summary: 'Separate is not equal.',
      citation_count: '9000',
      precedential_status: 'Published',
      blocked: 'f',
      docket_id: '1',
    }),
    rowOf('opinion-clusters', {
      id: '1',
      date_modified: '2024-11-08 17:44:17.193082+00',
      case_name: 'Hidden',
      precedential_status: 'Unknown',
      blocked: 't',
    }),
  ],
  dockets: [
    rowOf('dockets', {
      id: '29439169',
      date_modified: '2021-01-19 07:30:57.748622+00',
      source: '1',
      assigned_to_str: 'Dorothy Eisenberg',
      date_filed: '1998-07-31',
      date_terminated: '1998-10-15',
      case_name_short: 'Huaranca',
      case_name: 'Huaranca v. Internal Revenue Service',
      slug: 'huaranca-v-internal-revenue-service',
      docket_number: '8-98-08457',
      pacer_case_id: '80578',
      cause: '',
      nature_of_suit: '',
      blocked: 'f',
      court_id: 'nyeb',
    }),
  ],
  'fjc-integrated-database': [
    rowOf('fjc-integrated-database', {
      id: '17442742',
      date_modified: '2022-01-26 22:02:36.499814+00',
      dataset_source: '9',
      office: '2',
      docket_number: '8907217',
      origin: '1',
      date_filed: '1989-10-05',
      jurisdiction: '4',
      nature_of_suit: '190',
      monetary_demand: '75',
      plaintiff: 'A.T. CHADWICK CO., INC.',
      defendant: 'DEZCON CONTRACTORS, INC.',
      date_terminated: '1989-11-15',
      disposition: '4',
      amount_received: '75',
      judgment: '1',
      circuit_id: 'ca3',
      district_id: 'paed',
    }),
  ],
};

describe('catalogue: listing and cursor', () => {
  test('the S3 listing: keys with sizes, and the newest date with every table in it', async () => {
    const page = cat.parseListing(await fixture('courtlistener-s3-listing.xml'));
    expect(page.truncated).toBe(false);
    expect(page.next).toBeNull();
    expect(page.entries).toHaveLength(19);
    expect(page.entries.find((e) => e.key === 'bulk-data/courts-2026-06-30.csv.bz2').size).toBe(
      81180,
    );
    // 2026-09-30 lists courts, people and disclosures but an empty clusters
    // file and no oral arguments or positions yet: not a dump, so June wins.
    expect(cat.newestCompleteDate(page.entries, cat.neededFiles({}))).toBe('2026-06-30');
    expect(cat.newestCompleteDate(page.entries, ['courts'])).toBe('2026-09-30');
    expect(cat.newestCompleteDate(page.entries, ['courts', 'opinion-clusters'])).toBe('2026-06-30');
    expect(cat.newestCompleteDate(page.entries, cat.neededFiles({ dockets: 'true' }))).toBe(
      '2026-06-30',
    );
    expect(cat.newestCompleteDate(page.entries, cat.neededFiles({ fjc: 'true' }))).toBeNull();
    expect(cat.newestCompleteDate([], ['courts'])).toBeNull();
  });

  test('a truncated listing page carries its continuation token, decoded', () => {
    const xml =
      '<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>1BGs+tQ&amp;x</NextContinuationToken><Contents><Key>bulk-data/courts-2026-06-30.csv.bz2</Key><Size>100</Size></Contents></ListBucketResult>';
    const page = cat.parseListing(xml);
    expect(page.truncated).toBe(true);
    expect(page.next).toBe('1BGs+tQ&x');
    expect(cat.listingUrl(page.next)).toContain('continuation-token=1BGs%2BtQ%26x');
    expect(cat.listingUrl()).toBe(
      'https://com-courtlistener-storage.s3-us-west-2.amazonaws.com/?list-type=2&prefix=bulk-data%2F&max-keys=1000',
    );
    expect(cat.parseKey('bulk-data/people-db-people-2026-06-30.csv.bz2')).toEqual({
      table: 'people-db-people',
      date: '2026-06-30',
    });
    expect(cat.parseKey('bulk-data/load-bulk-data-2026-06-30.sh')).toBeNull();
    expect(cat.parseKey('bulk-data/schema-2024-08-15.sql')).toBeNull();
  });

  test('resolveVersion follows the pages and stops at the first that says it is last', async () => {
    const calls = [];
    const http = {
      async text(url) {
        calls.push(url);
        if (calls.length === 1) {
          return '<r><IsTruncated>true</IsTruncated><NextContinuationToken>tok</NextContinuationToken><Contents><Key>bulk-data/courts-2026-06-30.csv.bz2</Key><Size>100</Size></Contents></r>';
        }
        return '<r><IsTruncated>false</IsTruncated><Contents><Key>bulk-data/people-db-positions-2026-06-30.csv.bz2</Key><Size>100</Size></Contents></r>';
      },
    };
    expect(await cat.resolveVersion(http, ['courts', 'people-db-positions'])).toBe('2026-06-30');
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('continuation-token=tok');
    await expect(cat.resolveVersion(http, ['courts', 'dockets'])).rejects.toThrow(/no date/);
  });

  test('files: the five by default, dockets and the FJC by config, side files always needed', () => {
    expect(cat.filesFor({})).toEqual(cat.FILES);
    expect(cat.filesFor({ dockets: 'false', fjc: false })).toEqual(cat.FILES);
    expect(cat.filesFor({ dockets: 'true' })).toEqual([...cat.FILES, 'dockets']);
    expect(cat.filesFor({ dockets: true, fjc: '1' })).toEqual([
      ...cat.FILES,
      'dockets',
      'fjc-integrated-database',
    ]);
    expect(cat.neededFiles({})).toEqual([...cat.FILES, 'people-db-positions']);
    expect(cat.fileUrl('courts', '2026-06-30')).toBe(
      'https://com-courtlistener-storage.s3-us-west-2.amazonaws.com/bulk-data/courts-2026-06-30.csv.bz2',
    );
    expect(
      cat.staleFiles(
        ['courts-2026-03-31.csv.bz2', 'courts-2026-06-30.csv.bz2', 'other.txt'],
        '2026-06-30',
      ),
    ).toEqual(['courts-2026-03-31.csv.bz2']);
  });

  test('the cursor: where to resume, and what is stale on a second pass', () => {
    expect(cat.resumeFrom(undefined)).toEqual({
      version: null,
      file: 'courts',
      record: 0,
      modifiedWatermark: null,
      maxModified: null,
      done: false,
    });
    expect(
      cat.resumeFrom({
        version: '2026-06-30',
        file: 'opinion-clusters',
        record: 12000,
        done: false,
      }),
    ).toMatchObject({
      version: '2026-06-30',
      file: 'opinion-clusters',
      record: 12000,
    });
    // A cursor in a table that was turned off starts the first table over.
    expect(
      cat.resumeFrom({ version: '2026-06-30', file: 'dockets', record: 500 }, cat.FILES),
    ).toMatchObject({
      file: 'courts',
      record: 0,
    });
    expect(
      cat.resumeFrom(
        { version: '2026-06-30', file: 'dockets', record: 500 },
        cat.filesFor({ dockets: 'true' }),
      ),
    ).toMatchObject({
      file: 'dockets',
      record: 500,
    });
    expect(cat.resumeFrom({ version: 'june', done: true }).done).toBe(false);
    expect(
      cat.resumeFrom({
        version: '2026-06-30',
        done: true,
        modifiedWatermark: '2026-06-01 00:00:00+00',
      }),
    ).toMatchObject({
      done: true,
      modifiedWatermark: '2026-06-01 00:00:00+00',
    });
    expect(cat.isStale('2024-11-05 19:51:49.079046+00', '2026-06-01 00:00:00+00')).toBe(true);
    expect(cat.isStale('2026-06-02 00:00:00+00', '2026-06-01 00:00:00+00')).toBe(false);
    expect(cat.isStale('2024-11-05 19:51:49.079046+00', null)).toBe(false);
    expect(cat.isStale(null, '2026-06-01 00:00:00+00')).toBe(false);
  });
});

describe('catalogue: rows', () => {
  test('a court', () => {
    const [nc, ag] = ROWS.courts.map(cat.courtItem);
    expect(nc).toMatchObject({
      externalId: 'nc',
      kind: 'court',
      title: 'Supreme Court of North Carolina',
      url: 'http://www.nccourts.org/courts/appellate/supreme/',
      tags: ['courtlistener', 'court', 'jurisdiction:s'],
    });
    expect(nc.data).toMatchObject({
      courtId: 'nc',
      citationString: 'N.C.',
      jurisdiction: 'S',
      startDate: '1799-01-01',
      endDate: null,
      inUse: true,
      hasOpinionScraper: true,
      hasOralArgumentScraper: false,
      parentCourtId: null,
      pacerCourtId: null,
      position: 366.97,
      attribution: live.ATTRIBUTION,
    });
    expect(ag.url).toBe('https://www.courtlistener.com/?court=minnag');
    expect(ag.data.parentCourtId).toBe('minn');
    expect(cat.courtItem(rowOf('courts', { id: 'x' }))).toBeNull();
    expect(normaliseItem(nc)).not.toBeNull();
  });

  test('a judge with their positions joined, an alias left out', async () => {
    const positions = new Map([['2749', ROWS['people-db-positions'].map(cat.positionOf)]]);
    const [robinson, alias] = ROWS['people-db-people'].map((r) => cat.judgeItem(r, positions));
    expect(alias).toBeNull();
    expect(robinson).toMatchObject({
      externalId: '2749',
      kind: 'judge',
      title: 'Spottswood William Robinson 3',
      url: 'https://www.courtlistener.com/person/2749/spottswood-william-robinson-iii/',
      tags: ['courtlistener', 'judge', 'cadc'],
    });
    expect(robinson.summary).toBe('jud, cadc (1966 to 1998); Private practice (1943 to 1966)');
    expect(robinson.data.positions).toEqual([
      {
        type: 'jud',
        jobTitle: null,
        organization: null,
        courtId: 'cadc',
        dateStart: '1966-10-06',
        dateTermination: '1998-10-11',
        appointerId: '3355',
        howSelected: 'a_pres',
      },
      {
        type: null,
        jobTitle: 'Private practice',
        organization: null,
        courtId: null,
        dateStart: '1943-01-01',
        dateTermination: '1966-01-01',
        appointerId: null,
        howSelected: null,
      },
    ]);
    expect(robinson.data).toMatchObject({
      fjcId: 2031,
      dateOfBirth: '1916-07-26',
      dateOfDeath: '1998-10-11',
      birthplace: 'Richmond, VA, United States',
      gender: 'm',
      hasPhoto: true,
    });
    // Without the positions file loaded a judge still has a row.
    expect(cat.judgeItem(ROWS['people-db-people'][0]).data.positions).toEqual([]);
    expect(normaliseItem(robinson)).not.toBeNull();
  });

  test('a financial disclosure, titled by the judge when the people file is loaded', () => {
    const row = ROWS['financial-disclosures'][0];
    const named = cat.disclosureItem(row, new Map([['2084', 'Harry Sandlin Mattice Jr.']]));
    expect(named).toMatchObject({
      externalId: '1108',
      kind: 'financial-disclosure',
      title: 'Harry Sandlin Mattice Jr. financial disclosure 2009',
      url: 'https://storage.courtlistener.com/us/federal/judicial/financial-disclosures/2084/harry-sandlin-mattice-jr-disclosure.2009.pdf',
      imageUrl:
        'https://storage.courtlistener.com/us/federal/judicial/financial-disclosures/2084/x-thumbnail_1.png',
      precision: 'year',
    });
    expect(named.publishedAt).toEqual(new Date(Date.UTC(2009, 6, 1, 12)));
    expect(named.data).toMatchObject({
      year: 2009,
      reportType: '-1',
      isAmended: false,
      pageCount: 7,
      personId: '2084',
      personName: 'Harry Sandlin Mattice Jr.',
    });
    const anon = cat.disclosureItem(row);
    expect(anon.title).toBe('Financial disclosure 2009 (person 2084)');
    expect(cat.disclosureItem(rowOf('financial-disclosures', { ...row, filepath: '' })).url).toBe(
      row.download_filepath,
    );
    expect(normaliseItem(named)).not.toBeNull();
  });

  test('an oral argument with its MP3, a blocked one left out', () => {
    const [ayala, sealed] = ROWS['oral-arguments'].map(cat.audioItem);
    expect(sealed).toBeNull();
    expect(ayala).toMatchObject({
      externalId: '17',
      kind: 'oral-argument',
      title: 'Ayala v. Shinseki',
      url: 'https://www.courtlistener.com/audio/17/ayala-v-shinseki/',
      tags: ['courtlistener'],
      publishedAt: null,
    });
    expect(ayala.data).toMatchObject({
      mp3: 'https://storage.courtlistener.com/mp3/2014/10/28/ayala_v._shinseki_cl.mp3',
      durationSeconds: 879,
      judges: null,
      docketId: '4272451',
      source: 'C',
      dateCreated: '2014-10-31 02:33:10.810318+00',
    });
    expect(cat.pageSlug('A'.repeat(200)).length).toBe(75);
    expect(cat.pageSlug('')).toBe('case');
    expect(normaliseItem(ayala)).not.toBeNull();
  });

  test('an opinion cluster: status and SCDB tags, the syllabus trimmed, blocked ones left out', () => {
    const [lawless, brown, hidden] = ROWS['opinion-clusters'].map(cat.clusterItem);
    expect(hidden).toBeNull();
    expect(lawless).toMatchObject({
      externalId: '7290305',
      kind: 'opinion',
      title: 'Lawless v. Muskingum County',
      url: 'https://www.courtlistener.com/opinion/7290305/lawless-v-muskingum-county/',
      tags: ['courtlistener', 'published', 'precedential'],
      precision: 'day',
      timeKnown: false,
    });
    expect(lawless.publishedAt).toEqual(new Date(Date.UTC(2002, 5, 6, 12)));
    expect(lawless.summary.length).toBeLessThanOrEqual(cat.SUMMARY_CHARS + 3);
    expect(lawless.summary.endsWith('...')).toBe(true);
    expect(lawless.data).toMatchObject({
      caseNameFull: 'Robert J. LAWLESS v. MUSKINGUM COUNTY, OHIO',
      judges: null,
      citationCount: 2,
      docketId: '64278691',
      attorneys: 'Latham Castle, for appellant.',
      precedentialStatus: 'Published',
      scdbId: null,
      source: 'U',
      dateFiledApproximate: false,
    });
    expect(brown.tags).toEqual(['courtlistener', 'published', 'precedential', 'scotus']);
    expect(brown.summary).toBe('Separate is not equal.');
    expect(brown.data).toMatchObject({
      scdbId: '1953-081',
      scdbDecisionDirection: 2,
      dateFiledApproximate: true,
    });
    expect(normaliseItem(lawless)).not.toBeNull();
  });

  test('a docket row is the shape the API source writes, and an FJC case has no page', () => {
    const docket = cat.docketRowItem(ROWS.dockets[0]);
    expect(docket).toMatchObject({
      externalId: '29439169',
      kind: 'docket',
      title: 'Huaranca v. Internal Revenue Service (8-98-08457)',
      url: 'https://www.courtlistener.com/docket/29439169/huaranca-v-internal-revenue-service/',
      tags: ['courtlistener', 'nyeb'],
    });
    expect(Object.keys(docket.data).sort()).toEqual(
      Object.keys(live.docketItem({ id: 1, case_name: 'x', court_id: 'nyeb' }).data).sort(),
    );
    expect(docket.data).toMatchObject({
      court: 'nyeb',
      dateFiled: '1998-07-31',
      dateTerminated: '1998-10-15',
      assignedTo: 'Dorothy Eisenberg',
      pacerCaseId: '80578',
      natureOfSuit: null,
    });
    expect(cat.docketRowItem(rowOf('dockets', { ...ROWS.dockets[0], blocked: 't' }))).toBeNull();

    const fjc = cat.fjcItem(ROWS['fjc-integrated-database'][0]);
    expect(fjc).toMatchObject({
      externalId: '17442742',
      kind: 'case',
      title: 'A.T. CHADWICK CO., INC. v. DEZCON CONTRACTORS, INC. (8907217)',
      url: null,
      tags: ['courtlistener', 'fjc', 'paed'],
    });
    expect(fjc.publishedAt).toEqual(new Date(Date.UTC(1989, 9, 5, 12)));
    expect(fjc.data).toMatchObject({
      natureOfSuit: '190',
      disposition: '4',
      amountReceived: 75,
      dateTerminated: '1989-11-15',
      circuit: 'ca3',
      district: 'paed',
    });
    expect(normaliseItem(fjc).dedupeKey).toBeNull();
    expect(cat.rowItem('nope', {})).toBeNull();
    expect(cat.rowItem('courts', ROWS.courts[0]).kind).toBe('court');
  });
});

// ── The catalogue: the walk ──────────────────────────────────────────────────

/** A table as COPY writes it: quoted strings with backslash escapes, nothing for NULL. */
function csvOf(table, rows) {
  const header = HEADERS[table].split(',');
  const cell = (v) =>
    v === null || v === undefined
      ? ''
      : `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return `${header.join(',')}\n${rows.map((r) => header.map((h) => cell(r[h])).join(',')).join('\n')}\n`;
}

const haveBzip2 = Bun.which('bzip2');
describe.skipIf(!haveBzip2)('catalogue: the walk', () => {
  const VERSION = '2026-06-30';
  let dir;
  let savedDataDir;
  const files = {};

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nichedb-cl-test-'));
    savedDataDir = config.ingest.dataDir;
    config.ingest.dataDir = dir;
    for (const table of Object.keys(HEADERS)) {
      const plain = join(dir, `${table}.csv`);
      await writeFile(plain, csvOf(table, ROWS[table]));
      const proc = Bun.spawn(['bzip2', '-f', plain], { stderr: 'pipe' });
      expect(await proc.exited).toBe(0);
      files[table] = await readFile(`${plain}.bz2`);
    }
  });
  afterAll(async () => {
    config.ingest.dataDir = savedDataDir;
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  /** A fake bucket: the listing names every table at VERSION; downloads write the fixtures. */
  function bucket({ listing = null } = {}) {
    const calls = [];
    const http = {
      async text(url) {
        calls.push(url);
        if (listing) return listing;
        const contents = Object.keys(HEADERS)
          .map(
            (t) =>
              `<Contents><Key>bulk-data/${t}-${VERSION}.csv.bz2</Key><Size>${files[t].length}</Size></Contents>`,
          )
          .join('');
        return `<r><IsTruncated>false</IsTruncated>${contents}</r>`;
      },
      async download(url, path) {
        calls.push(url);
        const m = url.match(/bulk-data\/([a-z0-9-]+)-(\d{4}-\d{2}-\d{2})\.csv\.bz2$/);
        expect(m[2]).toBe(VERSION);
        await writeFile(path, files[m[1]]);
        return { path, bytes: files[m[1]].length, complete: true };
      },
    };
    return { http, calls };
  }

  async function drain(gen) {
    const batches = [];
    for (;;) {
      const r = await gen.next();
      if (r.done) return { batches, result: r.value };
      batches.push(r.value);
    }
  }

  const pull = (ctx) =>
    cat.courtlistenerCatalog.pull({
      config: { ...cat.courtlistenerCatalog.defaults, ...(ctx.config ?? {}) },
      cursor: ctx.cursor ?? {},
      http: ctx.http,
      log: ctx.log ?? (() => {}),
      deadline: ctx.deadline ?? Date.now() + 60_000,
    });

  test('one run walks every default table, then says unchanged', async () => {
    const { http, calls } = bucket();
    const { batches, result } = await drain(pull({ http }));
    const items = batches.flatMap((b) => b.items);
    const kinds = {};
    for (const i of items) kinds[i.kind] = (kinds[i.kind] ?? 0) + 1;
    expect(kinds).toEqual({
      court: 2,
      judge: 1,
      'financial-disclosure': 1,
      'oral-argument': 1,
      opinion: 2,
    });
    // The judge carries positions from the side file, the disclosure a name from the people file.
    expect(items.find((i) => i.kind === 'judge').data.positions).toHaveLength(2);
    // The disclosure's person (2084) is not in the people fixture, so the fallback title.
    expect(items.find((i) => i.kind === 'financial-disclosure').title).toBe(
      'Financial disclosure 2009 (person 2084)',
    );
    expect(result.cursor).toMatchObject({
      version: VERSION,
      file: null,
      record: 0,
      done: true,
      modifiedWatermark: '2024-11-08 17:44:17.193082+00',
    });
    expect(result.note).toContain('complete');
    // The listing, then a download call per table needed: the people file is
    // asked for twice (as a table, then beside the disclosures), and the second
    // time `http.download` finds it whole on disk and costs one Range request.
    expect(calls.filter((u) => u.includes('list-type')).length).toBe(1);
    expect(calls.filter((u) => u.endsWith('.csv.bz2')).length).toBe(7);
    // The walked copies are gone from the shared disk.
    expect((await readdir(join(dir, cat.DUMP_DIR))).filter((n) => n.endsWith('.bz2'))).toEqual([]);

    const again = await drain(pull({ http, cursor: result.cursor }));
    expect(again.batches).toEqual([]);
    expect(again.result.note).toContain('unchanged');
  });

  test('a deadline already near yields nothing, downloads nothing and asks for ten minutes', async () => {
    const { http, calls } = bucket();
    const { batches, result } = await drain(pull({ http, deadline: Date.now() - 1 }));
    expect(batches).toEqual([]);
    expect(calls.filter((u) => u.endsWith('.csv.bz2'))).toEqual([]);
    expect(result.nextInMinutes).toBe(cat.RESUME_MINUTES);
    expect(result.note).toContain('out of time before the courts download');
  });

  test('a run out of time stops with a cursor the next run resumes from', async () => {
    const { http } = bucket();
    // The clock jumps past the deadline once the first batch is out, which is
    // where a long walk meets it: between two batches.
    const realNow = Date.now;
    let past = false;
    const clock = spyOn(Date, 'now').mockImplementation(() => (past ? 1e15 : realNow()));
    let first;
    try {
      const gen = pull({ http, config: { batchRows: 1 }, deadline: realNow() + 3_600_000 });
      const batches = [];
      for (;;) {
        const r = await gen.next();
        if (r.done) {
          first = { batches, result: r.value };
          break;
        }
        batches.push(r.value);
        past = true;
      }
    } finally {
      clock.mockRestore();
    }
    expect(first.batches).toHaveLength(1);
    expect(first.batches[0].items[0].externalId).toBe('nc');
    expect(first.result.cursor).toMatchObject({
      version: VERSION,
      file: 'courts',
      record: 1,
      done: false,
    });
    expect(first.result.nextInMinutes).toBe(cat.RESUME_MINUTES);

    const rest = await drain(pull({ http, config: { batchRows: 1 }, cursor: first.result.cursor }));
    const ids = rest.batches.flatMap((b) => b.items.map((i) => `${i.kind}:${i.externalId}`));
    expect(ids).toEqual([
      'court:minnag',
      'judge:2749',
      'financial-disclosure:1108',
      'oral-argument:17',
      'opinion:7290305',
      'opinion:108713',
    ]);
    expect(rest.result.cursor.done).toBe(true);
  });

  test('a second pass on a new dump skips rows modified before the watermark', async () => {
    const { http } = bucket();
    const prev = {
      version: '2026-03-31',
      file: null,
      record: 0,
      done: true,
      modifiedWatermark: '2024-11-06 00:00:00+00',
    };
    const { batches, result } = await drain(pull({ http, cursor: prev }));
    const ids = batches.flatMap((b) => b.items.map((i) => i.externalId));
    // Only the cluster modified on 2024-11-08 is newer than the watermark.
    expect(ids).toEqual(['108713']);
    expect(result.note).toContain('unchanged skipped');
    expect(result.cursor.modifiedWatermark).toBe('2024-11-08 17:44:17.193082+00');
  });

  test('dockets and the FJC join the walk only when turned on', async () => {
    const { http } = bucket();
    const { batches } = await drain(pull({ http, config: { dockets: 'true', fjc: 'true' } }));
    const kinds = new Set(batches.flatMap((b) => b.items.map((i) => i.kind)));
    expect(kinds.has('docket')).toBe(true);
    expect(kinds.has('case')).toBe(true);
  });

  test('a bucket that cannot be listed: a first run fails, a walk in progress carries on', async () => {
    let listings = 0;
    const good = bucket();
    const http = {
      async text() {
        listings += 1;
        throw new Error('503');
      },
      download: good.http.download,
    };
    // Nothing known yet and every request failed: the run is an error.
    await expect(drain(pull({ http, config: { pauseMs: 0 } }))).rejects.toThrow(
      /every request failed/,
    );
    expect(listings).toBe(cat.FAILURE_STOP);
    // A walk in progress does not need to know what is newest.
    const cursor = { version: VERSION, file: 'oral-arguments', record: 0, done: false };
    const { batches, result } = await drain(pull({ http, config: { pauseMs: 0 }, cursor }));
    expect(batches.flatMap((b) => b.items.map((i) => i.kind))).toEqual([
      'oral-argument',
      'opinion',
      'opinion',
    ]);
    expect(result.cursor.done).toBe(true);
  });
});

// ── The migration ────────────────────────────────────────────────────────────

describe('migration 0027', () => {
  let db;
  const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
  beforeAll(async () => {
    db = await new PGlite({ extensions: { citext, pg_trgm } });
    for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
      await db.exec(await readFile(dir + f, 'utf8'));
    }
  }, 60_000);
  afterAll(async () => db?.close());

  test('moves every CourtListener source, and its items, from filings into law; idempotent', async () => {
    const one = async (sql, params) => (await db.query(sql, params)).rows[0];
    const law = await one(`select id, name from collections where slug = 'law'`);
    expect(law.name).toBe('Courts & case law');
    const filings = await one(
      `insert into collections (slug, name, description) values ('filings', 'Filings', 'SEC filings, and court opinions.') returning id`,
    );
    const src = await one(
      `insert into sources (collection_id, adapter, slug, name, cursor, last_error)
       values ($1, 'courtlistener', 'courtlistener-opinions', 'old', '{"page":2}', 'COURTLISTENER_TOKEN is not set') returning id`,
      [filings.id],
    );
    const edgar = await one(
      `insert into sources (collection_id, adapter, slug, name) values ($1, 'edgar', 'edgar-form-d', 'EDGAR') returning id`,
      [filings.id],
    );
    await db.query(
      `insert into items (collection_id, source_id, external_id, title, content_hash) values ($1, $2, '1', 'x', 'h')`,
      [filings.id, src.id],
    );
    const migration = await readFile(`${dir}0027_law_collection.sql`, 'utf8');
    await db.exec(migration);
    expect(
      (await one(`select collection_id, cursor, last_error from sources where id = $1`, [src.id]))
        .collection_id,
    ).toBe(law.id);
    expect(
      (await one(`select cursor, last_error from sources where id = $1`, [src.id])).cursor,
    ).toEqual({});
    expect(
      (await one(`select last_error from sources where id = $1`, [src.id])).last_error,
    ).toBeNull();
    expect(
      (await one(`select collection_id from items where source_id = $1`, [src.id])).collection_id,
    ).toBe(law.id);
    expect(
      (await one(`select collection_id from sources where id = $1`, [edgar.id])).collection_id,
    ).toBe(filings.id);
    expect(
      (await one(`select description from collections where slug = 'filings'`)).description,
    ).not.toContain('opinion');
    await db.exec(migration);
    expect(
      (await one(`select count(*)::int as n from sources where adapter like 'courtlistener%'`)).n,
    ).toBe(1);
  });
});
