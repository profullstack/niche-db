import { describe, expect, test } from 'bun:test';
import { adapterByName } from '../packages/adapters/src/index.js';
import {
  archiveDate,
  indexByEvent,
  newestFirst,
  ntsbDate,
  operatorName,
  parseNdjson,
  toItem,
} from '../packages/adapters/src/ntsb.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';
const { DEFAULT_FEEDS } = await import('../packages/core/src/seed.js');

/* An event row as `mdb-json` emits it out of avall.mdb. */
const event = (over = {}) => ({
  ev_id: '20260831203691',
  ntsb_no: 'WPR26LA319',
  ev_type: 'ACC',
  ev_date: '08/22/26 00:00:00',
  ev_time: 1830,
  ev_city: 'Brenham',
  ev_state: 'TX',
  ev_country: 'USA',
  ev_year: 2026,
  latitude: '003000N',
  longitude: '0009600W',
  dec_latitude: 30,
  dec_longitude: -96,
  wx_cond_basic: 'VMC',
  light_cond: 'DAYL',
  wx_temp: 99,
  wind_dir_deg: 330,
  wind_vel_kts: 4,
  gust_kts: 0,
  vis_sm: 9,
  metar: 'METAR KTME 221835Z AUTO 33004KT 9SM CLR 37/21 A3005 RMK AO2',
  ev_highest_injury: 'NONE',
  inj_tot_f: 0,
  inj_tot_s: 0,
  inj_tot_t: 1,
  ...over,
});

const plane = (over = {}) => ({
  ev_id: '20260831203691',
  Aircraft_Key: 1,
  regis_no: 'N2285D',
  acft_make: 'CESSNA',
  acft_model: '170B',
  damage: 'SUBS',
  far_part: '091',
  oper_name: 'JET CANE CORP',
  ...over,
});

describe('the NTSB bulk reader', () => {
  test('is registered in the aviation collection and has feeds pointed at it', () => {
    const a = adapterByName('ntsb-accidents');
    expect(a).not.toBeNull();
    expect(a.collection).toBe('aviation');
    expect(a.kinds).toContain('accident');
    const feeds = DEFAULT_FEEDS.filter(
      (f) => f.collection === 'aviation' && (f.query.kinds ?? []).includes('accident'),
    );
    expect(feeds.length).toBeGreaterThan(0);
  });

  test('a two-digit year is read against 1982, not against the century', () => {
    /* The database starts in 1982 and the dates arrive as `08/22/26`. Handing
     * that to `new Date` yields 1926. Every accident in the file would be
     * published a hundred years early and sorted before every other row in the
     * collection. */
    expect(ntsbDate('08/22/26 00:00:00').date).toBe('2026-08-22');
    expect(ntsbDate('01/09/98 00:00:00').date).toBe('1998-01-09');
    expect(ntsbDate('12/31/82 00:00:00').date).toBe('1982-12-31');
    expect(ntsbDate('03/04/2015').date).toBe('2015-03-04');
    expect(ntsbDate('')).toBeNull();
    expect(ntsbDate(null)).toBeNull();
  });

  test('the time is HHMM as an integer, and an impossible one is not a time', () => {
    expect(ntsbDate('08/22/26', 1830)).toEqual({ date: '2026-08-22T18:30:00Z', timeKnown: true });
    expect(ntsbDate('04/19/26', 217)).toEqual({ date: '2026-04-19T02:17:00Z', timeKnown: true });
    expect(ntsbDate('08/22/26', 0)).toEqual({ date: '2026-08-22T00:00:00Z', timeKnown: true });
    // 2575 is not a time; the day is still known.
    expect(ntsbDate('08/22/26', 2575)).toEqual({ date: '2026-08-22', timeKnown: false });
    expect(ntsbDate('08/22/26', null)).toEqual({ date: '2026-08-22', timeKnown: false });
  });

  test('the coordinates come from the decimal columns, never the packed ones', () => {
    /* The same row carries `latitude: "003000N"` and `dec_latitude: 30`.
     * Reading the packed pair as a number puts a Texas accident three thousand
     * degrees north of the equator. */
    const item = toItem(event());
    expect(item.data.place.lat).toBe(30);
    expect(item.data.place.lon).toBe(-96);
    expect(toItem(event({ dec_latitude: 0, dec_longitude: 0 })).data.place.lat).toBeNull();
    expect(toItem(event({ dec_latitude: 3000 })).data.place.lat).toBeNull();
  });

  test('the damage code becomes a word, because SUBS is what makes it an accident', () => {
    const item = normaliseItem(toItem(event(), { aircraft: plane() }));
    expect(item.summary).toContain('Aircraft substantially damaged');
    expect(item.data.damage).toBe('substantially damaged');
    expect(item.data.damageCode).toBe('SUBS');
    expect(item.tags).toContain('damage:substantially-damaged');
    expect(toItem(event(), { aircraft: plane({ damage: 'DEST' }) }).data.damage).toBe('destroyed');
    expect(toItem(event(), { aircraft: plane({ damage: 'ZZZ' }) }).data.damage).toBeNull();
  });

  test('a placeholder operator is not an operator', () => {
    // The register writes a bare `N` in the operator columns on many rows, and
    // printed straight it reads "operated by N", which looks like a company.
    expect(operatorName('N')).toBeNull();
    expect(operatorName('N', 'BADINELLI RALPH D')).toBe('BADINELLI RALPH D');
    expect(operatorName('none', 'UNK')).toBeNull();
    expect(operatorName('JET CANE CORP')).toBe('JET CANE CORP');
    expect(toItem(event(), { aircraft: plane({ oper_name: 'N' }) }).summary).not.toContain(
      'operated by',
    );
  });

  test('an unruled accident says so rather than looking finished', () => {
    const open = toItem(event(), { aircraft: plane() });
    expect(open.data.probableCause).toBeNull();
    expect(open.tags).toContain('under-investigation');
    expect(open.data.narrativeNote).toContain('updated in place');

    const ruled = toItem(event(), {
      aircraft: plane(),
      narrative: { ev_id: event().ev_id, narr_cause: 'The pilot’s failure to maintain control.' },
    });
    expect(ruled.tags).toContain('probable-cause');
    expect(ruled.summary).toContain('Probable cause: The pilot’s failure');
  });

  test('the same accident keeps one id however many times the file is re-read', () => {
    /* This is what makes a monthly re-read cheap and a late ruling an update
     * rather than a second, contradicting row. */
    const first = normaliseItem(toItem(event(), { aircraft: plane() }));
    const later = normaliseItem(
      toItem(event(), {
        aircraft: plane(),
        narrative: { ev_id: event().ev_id, narr_cause: 'Loss of control on landing.' },
      }),
    );
    expect(later.externalId).toBe(first.externalId);
    expect(later.externalId).toBe('ntsb-20260831203691');
    expect(later.contentHash).not.toBe(first.contentHash);
  });

  test('the weather at the accident is kept in the shape the live METAR feed uses', () => {
    // events.metar holds the raw observation, which is the identical field
    // `aviation-metar` publishes hourly. That is the join between the two.
    const item = toItem(event());
    expect(item.data.weather.metar).toStartWith('METAR KTME');
    expect(item.data.weather.conditions).toBe('visual conditions');
    expect(item.data.weather.windSpeedKt).toBe(4);
    expect(item.data.weather.gustKt).toBe(0);
    expect(item.tags).toContain('has-metar');
    expect(toItem(event({ metar: null })).tags).not.toContain('has-metar');
  });

  test('zero deaths is a fact, not a missing number', () => {
    const item = toItem(event());
    expect(item.data.injuries.fatal).toBe(0);
    expect(item.data.injuries.aboard).toBe(1);
    expect(item.title).not.toContain('killed');
    expect(toItem(event({ inj_tot_f: 2 })).title).toContain('2 killed');
  });

  test('an event with no id or no date is not an accident', () => {
    expect(toItem(event({ ev_id: null }))).toBeNull();
    expect(toItem(event({ ev_date: null }))).toBeNull();
    expect(toItem(null)).toBeNull();
  });

  test('NDJSON survives the lines that are not rows', () => {
    const text = '{"ev_id":"a"}\n\n{"ev_id":"b"}\nnot json\n{"ev_id":"c"';
    expect(parseNdjson(text).map((r) => r.ev_id)).toEqual(['a', 'b']);
    expect(parseNdjson('')).toEqual([]);
  });

  test('the walk runs newest first, so a bounded run stores what a reader wants', () => {
    const rows = [
      { ev_id: '1', ev_date: '01/04/15 00:00:00' },
      { ev_id: '2', ev_date: '08/22/26 00:00:00' },
      { ev_id: '3', ev_date: '03/09/98 00:00:00' },
    ];
    expect(newestFirst(rows).map((r) => r.ev_id)).toEqual(['2', '1', '3']);
  });

  test('the narrative chosen for an event is the one that says something', () => {
    /* An event has a narrative row per aircraft, and the empty ones are as
     * numerous as the full ones. Taking the first would drop the ruling. */
    const rows = [
      { ev_id: 'x', Aircraft_Key: 1, narr_cause: '' },
      { ev_id: 'x', Aircraft_Key: 2, narr_cause: 'The pilot lost control.' },
    ];
    const picked = indexByEvent(rows, (n) => Boolean(String(n?.narr_cause ?? '').trim()));
    expect(picked.get('x').narr_cause).toBe('The pilot lost control.');
    expect(indexByEvent(rows).get('x').Aircraft_Key).toBe(1);
  });

  test('the archive date is read off the listing, so the download is conditional', () => {
    const page =
      '<td>avall.zip</td><td>9/1/2026 7:03:59 AM</td><td>96148686</td><td><a href="x">avall.zip</a></td>';
    expect(archiveDate(page)).toBe('2026-09-01');
    expect(archiveDate('<td>codman.pdf</td><td>9/15/2021 3:32:50 PM</td>')).toBeNull();
    expect(archiveDate('')).toBeNull();
  });
});
