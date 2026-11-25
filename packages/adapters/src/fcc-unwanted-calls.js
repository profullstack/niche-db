import { defineAdapter, slugify } from '@nichedb/core/adapter';
import { numberTag, toE164 } from './phone-common.js';

/**
 * Unwanted-call complaints people filed with the FCC, one row per complaint
 * that names the calling number.
 *
 * The FCC's Consumer Complaints dataset (opendata.fcc.gov, Socrata id
 * 3xyp-aqkj, public domain) holds 3.8 million complaints; 1.87 million are
 * "Unwanted Calls", and about 790,000 of those carry a caller ID number. A
 * complaint can also name the number the caller told them to call back
 * (`advertiser_business_phone_number`), often the real business behind a
 * spoofed caller ID; both numbers are tagged so /phone finds the row from
 * either.
 *
 * DATES
 *
 * `issue_date` is typed by the consumer and runs from year 0001 to 9999. The
 * row's real clock is `ticket_created`, when the FCC logged it, and that is
 * the cursor: oldest first on the first walk, then whatever is newer.
 *
 * PEOPLE
 *
 * The complainant is a private person. Their state is kept, so a page can say
 * where a campaign is calling; their city, ZIP and coordinates are not.
 */

export const DATASET = 'https://opendata.fcc.gov/resource/3xyp-aqkj.json';
const PAGE = 5000;
const PAGES_PER_RUN = 40;

const clean = (v) => {
  const s = String(v ?? '').trim();
  return s || null;
};

/** A Socrata timestamp as ISO, or null. */
const when = (v) => {
  const d = v ? new Date(`${String(v).replace(/Z?$/, 'Z')}`) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
};

/** `520-655-1816` -> `+15206551816`, only for a real ten-digit NANP number. */
export function complaintNumber(v) {
  const digits = String(v ?? '').replace(/\D/g, '');
  const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(ten)) return null;
  return toE164(ten, 'US');
}

/** One complaint row as an item, or null when it names no usable caller. */
export function complaintItem(r) {
  const caller = complaintNumber(r.caller_id_number);
  if (!caller) return null;
  const callback = complaintNumber(r.advertiser_business_phone_number);
  const filed = when(r.ticket_created);
  const callType = clean(r.type_of_call_or_messge);
  const method = clean(r.method);
  const topic = clean(r.type_of_property_goods_or_services);
  const state = clean(r.state);
  const display = caller.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '+1 $1-$2-$3');
  return {
    externalId: `fcc:${r.id}`,
    kind: 'call-complaint',
    title: `Unwanted ${callType ? callType.toLowerCase() : 'call'} from ${display}`,
    summary: [
      `Reported to the FCC`,
      filed ? ` on ${filed.slice(0, 10)}` : '',
      state ? ` by someone in ${state}` : '',
      `: ${callType ?? 'an unwanted call'} from ${display}`,
      method ? ` to a ${method.replace(/\s*\(.*\)/, '').toLowerCase()} line` : '',
      topic ? `, about "${topic}"` : '',
      callback && callback !== caller ? `. Call-back number given: ${callback}` : '',
      '.',
    ].join(''),
    url: `https://opendata.fcc.gov/Consumer/CGB-Consumer-Complaints-Data/3xyp-aqkj`,
    publishedAt: filed,
    tags: [
      'fcc',
      'complaint',
      'unwanted-call',
      numberTag(caller),
      callback && callback !== caller ? numberTag(callback) : null,
      callType ? `call-${slugify(callType)}` : null,
      state ? `state-${state.toLowerCase()}` : null,
      topic ? `topic-${slugify(topic).slice(0, 60)}` : null,
    ].filter(Boolean),
    data: {
      caller,
      callback: callback !== caller ? callback : null,
      callType,
      method,
      topic,
      state,
      filedAt: filed,
      fccId: clean(r.id),
      source: 'FCC Consumer Complaints Data (public domain)',
      dataset: DATASET,
    },
  };
}

export const fccUnwantedCalls = defineAdapter({
  name: 'fcc-unwanted-calls',
  title: 'FCC unwanted-call complaints',
  collection: 'phone',
  description:
    'Unwanted-call complaints people filed with the FCC that name the calling number (about 790,000 since 2016), one row per complaint: caller ID, the call-back number the caller gave, robocall or live voice, the topic, and the complainant’s state. Read every hour from the FCC open data portal. Public domain.',
  docs: 'https://opendata.fcc.gov/Consumer/CGB-Consumer-Complaints-Data/3xyp-aqkj',
  kinds: ['call-complaint'],
  cadenceMinutes: 60,
  budgetMs: 20 * 60_000,
  defaults: {},
  defaultSources: [{ slug: 'fcc-unwanted-calls', name: 'FCC: unwanted-call complaints' }],

  async *pull({ cursor, http, log }) {
    let since = cursor?.since ?? '2016-01-01T00:00:00.000';
    let total = 0;
    for (let page = 0; page < PAGES_PER_RUN; page++) {
      const params = new URLSearchParams({
        $where: `issue='Unwanted Calls' AND caller_id_number IS NOT NULL AND ticket_created > '${since}'`,
        $order: 'ticket_created ASC, id ASC',
        $limit: String(PAGE),
      });
      const rows = await http.json(`${DATASET}?${params}`, { timeoutMs: 90_000 });
      if (!Array.isArray(rows) || rows.length === 0) break;
      const items = rows.map(complaintItem).filter(Boolean);
      // Rows sharing the last timestamp are re-read next page, never skipped:
      // the cursor steps back one millisecond and the upsert absorbs repeats.
      const last = String(rows.at(-1).ticket_created ?? since).replace(/Z$/, '');
      const next = new Date(new Date(`${last}Z`).getTime() - 1).toISOString().replace(/Z$/, '');
      since = rows.length < PAGE ? last : next > since ? next : last;
      total += items.length;
      yield { items, cursor: { since } };
      if (rows.length < PAGE) break;
    }
    log(`${total} complaints with a caller number, through ${since}`);
    return { cursor: { since }, note: `${total} complaints` };
  },
});
