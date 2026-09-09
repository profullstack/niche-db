import { defineAdapter, slugify } from '@nichedb/core/adapter';

/**
 * Every complaint Americans send the Consumer Financial Protection Bureau
 * about a bank, a lender, a credit bureau or a debt collector.
 *
 * 17.6 million of them, around seven thousand a day, published within a day or
 * two of being filed and naming the company each one is about. There is no
 * other public record of what financial firms are actually doing to their
 * customers at this resolution, and it is keyless.
 *
 * WHAT MAKES IT WORTH A COLLECTION RATHER THAN A SOURCE
 *
 * A complaint on its own is one person's account. What makes it evidence is the
 * company it names, and the company is a bare uppercase string -- `TRANSUNION
 * INTERMEDIATE HOLDINGS, INC.` -- with no identifier of any kind attached. Two
 * other feeds in this collection turn that string into an institution:
 * `fdic-institutions` has every insured bank with its charter, its regulator
 * and its assets, and `fdic-structure-changes` has what happened to it since.
 * Both normalise the name the same way this one does -- `data.companyKey` here
 * and `data.nameKey` there are the same slug, and there is a test that fails if
 * they ever stop being -- so the same string can be read as "a $60bn bank
 * supervised by the OCC whose Westport branch closed in August", which is the
 * question a complaint count is actually asked in aid of.
 *
 * THE FIELD THAT IS USUALLY EMPTY
 *
 * `complaint_what_happened` is the consumer's own narrative. Publishing it is
 * opt-in, the Bureau scrubs it first, and the scrubbing takes months: of the
 * complaints received in the last month, one carries a narrative; of those
 * received since May, 42,516 do. So a narrative arrives attached to a complaint
 * that is already old, long after any feed following the newest rows has moved
 * past it. That is why the narratives source sweeps a trailing window one day
 * per run instead of tailing the front, and why the two are separate sources
 * rather than one query with a flag.
 */

const SEARCH = 'https://www.consumerfinance.gov/data-research/consumer-complaints/search/api/v1/';

/**
 * How many rows one request can return.
 *
 * The search is Elasticsearch with its default result window, so 10,000 is the
 * ceiling on a single answer and there is no way past it: `frm` is accepted,
 * echoed and IGNORED -- `frm=0`, `frm=500` and `frm=1000` return byte-identical
 * pages -- so anything built on offset paging silently stores the same first
 * page over and over and believes it read everything. This adapter therefore
 * never pages. It narrows the window until the answer fits.
 */
const MAX_SIZE = 10_000;

/** The states, for splitting a day that will not fit in one answer. */
const STATES = [
  'AL',
  'AK',
  'AZ',
  'AR',
  'CA',
  'CO',
  'CT',
  'DE',
  'DC',
  'FL',
  'GA',
  'HI',
  'ID',
  'IL',
  'IN',
  'IA',
  'KS',
  'KY',
  'LA',
  'ME',
  'MD',
  'MA',
  'MI',
  'MN',
  'MS',
  'MO',
  'MT',
  'NE',
  'NV',
  'NH',
  'NJ',
  'NM',
  'NY',
  'NC',
  'ND',
  'OH',
  'OK',
  'OR',
  'PA',
  'RI',
  'SC',
  'SD',
  'TN',
  'TX',
  'UT',
  'VT',
  'VA',
  'WA',
  'WV',
  'WI',
  'WY',
  'PR',
  'VI',
  'GU',
  'AS',
  'MP',
  'AE',
  'AP',
  'AA',
  'FM',
  'MH',
  'PW',
];

/** The UTC day, as the date filters want it. */
export const utcDay = (d) => new Date(d).toISOString().slice(0, 10);

/** The day after this one. */
export function nextDay(day) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return utcDay(d);
}

/** Every day from `from` to `to` inclusive, capped. */
export function daysBetween(from, to, cap) {
  const out = [];
  let day = from;
  while (day <= to && out.length < cap) {
    out.push(day);
    day = nextDay(day);
  }
  return out;
}

const clean = (v) => {
  const s = String(v ?? '').trim();
  return s && s.toLowerCase() !== 'null' ? s : null;
};

/** The day part of an ISO timestamp, which is the granularity the filter takes. */
export const day = (iso) => String(iso ?? '').slice(0, 10);

/**
 * How the company answered, in the Bureau's own vocabulary.
 *
 * `In progress` means the company has not answered yet, and it is the most
 * common value on recent complaints for the obvious reason. It is kept as a
 * tag rather than folded into "no response", because a complaint filed
 * yesterday and one ignored for a year are not the same fact.
 */
/**
 * A short name for the product, because the Bureau's own are long enough to be
 * cut in half by a tag length and nearly all of them are the same one.
 *
 * Worth knowing before reading any count from this dataset: 9,843 of the
 * 10,000 complaints filed on 7-8 September 2026 were about credit reporting,
 * and one was about a mortgage. The database is overwhelmingly a record of
 * disputes with the three credit bureaus, and any comparison across products
 * that does not say so is misleading.
 */
export const PRODUCT_FAMILIES = [
  [/credit report|consumer report/i, 'credit-reporting'],
  [/debt collection/i, 'debt-collection'],
  [/mortgage/i, 'mortgage'],
  [/credit card|prepaid card/i, 'credit-card'],
  [/student loan/i, 'student-loan'],
  [/vehicle loan|lease/i, 'auto-loan'],
  [/payday|title loan|personal loan|advance loan/i, 'payday-loan'],
  [/checking|savings|bank account/i, 'bank-account'],
  [/money transfer|virtual currency|money service/i, 'money-transfer'],
  [/credit management|debt settlement|debt or credit/i, 'debt-relief'],
];

export function productFamily(product) {
  const s = String(product ?? '');
  for (const [re, name] of PRODUCT_FAMILIES) if (re.test(s)) return name;
  return s ? 'other' : null;
}

const RESPONSE_TAGS = {
  'closed with explanation': 'explained',
  'closed with non-monetary relief': 'relief-non-monetary',
  'closed with monetary relief': 'relief-monetary',
  'closed without relief': 'no-relief',
  'closed with relief': 'relief',
  closed: 'closed',
  'in progress': 'in-progress',
  untimely: 'untimely',
};

export function toItem(hit) {
  const s = hit?._source ?? hit;
  const id = clean(s?.complaint_id);
  const received = clean(s?.date_received);
  const company = clean(s?.company);
  const product = clean(s?.product);
  if (!id || !received || !company) return null;

  const issue = clean(s.issue);
  const subIssue = clean(s.sub_issue);
  const subProduct = clean(s.sub_product);
  const state = clean(s.state);
  const narrative = s.has_narrative ? clean(s.complaint_what_happened) : null;
  const response = clean(s.company_response);

  return {
    externalId: `cfpb-${id}`,
    kind: 'complaint',
    title: `${company}: ${issue ?? product ?? 'complaint'}${state ? ` (${state})` : ''}`,
    summary: [
      `A consumer${state ? ` in ${state}` : ''} complained to the CFPB about ${company}`,
      product
        ? ` over ${product.toLowerCase()}${subProduct ? ` (${subProduct.toLowerCase()})` : ''}`
        : '',
      issue ? `. Issue: ${issue}${subIssue ? ` — ${subIssue}` : ''}` : '',
      `. Received ${day(received)}`,
      response ? `, company response: ${response.toLowerCase()}` : '',
      '.',
      narrative ? ` ${narrative.slice(0, 900)}` : '',
    ].join(''),
    url: `https://www.consumerfinance.gov/data-research/consumer-complaints/search/detail/${id}`,
    publishedAt: received,
    timeKnown: true,
    precision: 'minute',
    tags: [
      'consumer-finance',
      'complaint',
      'us',
      slugify(company).slice(0, 60),
      productFamily(product),
      issue ? slugify(issue).slice(0, 60) : null,
      state ? state.toLowerCase() : null,
      narrative ? 'has-narrative' : null,
      response ? (RESPONSE_TAGS[response.toLowerCase()] ?? slugify(response).slice(0, 30)) : null,
      clean(s.timely) === 'No' ? 'untimely-response' : null,
      clean(s.submitted_via) ? `via:${slugify(s.submitted_via)}` : null,
    ].filter(Boolean),
    data: {
      complaintId: id,
      company,
      // The company name exactly as the Bureau writes it, so it can be joined
      // to the FDIC feeds in this collection without guessing at the casing.
      companyKey: slugify(company),
      product,
      productFamily: productFamily(product),
      subProduct,
      issue,
      subIssue,
      narrative,
      hasNarrative: Boolean(s.has_narrative),
      narrativeNote:
        'Publishing the consumer’s own account is opt-in and the CFPB scrubs it before release, so most complaints have none. Absent means not published, not that nothing was said.',
      receivedAt: received,
      sentToCompanyAt: clean(s.date_sent_to_company),
      companyResponse: response,
      companyPublicResponse: clean(s.company_public_response),
      timelyResponse: clean(s.timely),
      submittedVia: clean(s.submitted_via),
      consumerDisputed: clean(s.consumer_disputed),
      place: { country: 'US', state, zip: clean(s.zip_code) },
      source: 'CFPB Consumer Complaint Database',
      dataset: SEARCH,
    },
  };
}

export const cfpbComplaints = defineAdapter({
  name: 'cfpb-complaints',
  title: 'CFPB consumer complaints',
  collection: 'consumer-finance',
  description:
    'Complaints Americans file with the Consumer Financial Protection Bureau about banks, lenders, credit bureaus and debt collectors — around seven thousand a day, each naming the company, the product and the issue. A third of them eventually carry the consumer’s own account of what happened, and those are swept up separately because the Bureau publishes them months after the complaint. Keyless.',
  docs: 'https://cfpb.github.io/api/ccdb/',
  kinds: ['complaint'],
  cadenceMinutes: 60,
  configFields: [
    { key: 'product', label: 'Only this product', help: 'e.g. Mortgage, Debt collection.' },
    { key: 'company', label: 'Only this company', help: 'The name exactly as the CFPB writes it.' },
    { key: 'state', label: 'Only this state', help: 'Two-letter code.' },
    {
      key: 'narrativesOnly',
      label: 'Only with a narrative',
      type: 'select',
      options: ['', 'yes'],
      help: 'Keep only the complaints where the consumer’s own account was published.',
    },
    {
      key: 'sweepDays',
      label: 'Sweep window (days)',
      type: 'number',
      help: 'Re-read one older day per run over a window this wide, instead of following the newest. Set this for narratives, which are published long after the complaint.',
    },
    { key: 'maxDays', label: 'Days per run', type: 'number', help: 'Default 5.' },
    {
      key: 'backfillDays',
      label: 'Days to read on a first run',
      type: 'number',
      help: 'Default 2.',
    },
  ],
  defaults: {},
  defaultSources: [
    { slug: 'cfpb-complaints-all', name: 'CFPB complaints: everything' },
    {
      /*
       * A narrative is not published with its complaint. The Bureau scrubs it
       * first, and the wait is months: complaints received since 10 August
       * carry exactly one narrative between them, while the same query from 1
       * May returns 42,516. A feed that followed the newest complaints would
       * therefore be permanently empty, so this one sweeps the window where
       * narratives actually appear, one day per run.
       */
      slug: 'cfpb-complaints-narratives',
      name: 'CFPB complaints in the consumer’s own words',
      config: { narrativesOnly: 'yes', sweepDays: 180 },
    },
    {
      slug: 'cfpb-complaints-debt-collection',
      name: 'CFPB complaints about debt collectors',
      config: { product: 'Debt collection' },
      cadenceMinutes: 60 * 3,
    },
    {
      /*
       * Everything that is not a credit-report dispute, which is 1.6% of the
       * database and the half most people mean when they ask what consumers
       * complain about. There is no "not" filter, so it is one source per
       * product; these are the four with enough volume to be worth following.
       */
      slug: 'cfpb-complaints-bank-accounts',
      name: 'CFPB complaints about bank accounts',
      config: { product: 'Checking or savings account' },
      cadenceMinutes: 60 * 3,
    },
    {
      slug: 'cfpb-complaints-credit-cards',
      name: 'CFPB complaints about credit cards',
      config: { product: 'Credit card' },
      cadenceMinutes: 60 * 3,
    },
  ],
  async pull({ config, cursor, http, log, deadline }) {
    const today = utcDay(Date.now());
    const sweepDays = Math.max(0, Math.min(Number(config.sweepDays) || 0, 3650));

    /** One day, in as few requests as the result window allows. */
    const readDay = async (dayString) => {
      const query = (extra = {}) => {
        const params = new URLSearchParams({
          size: String(MAX_SIZE),
          no_aggs: 'true',
          sort: 'created_date_desc',
          date_received_min: dayString,
          date_received_max: dayString,
          ...extra,
        });
        if (config.product) params.set('product', String(config.product));
        if (config.company) params.set('company', String(config.company));
        if (config.state) params.set('state', String(config.state));
        if (String(config.narrativesOnly ?? '') === 'yes') params.set('has_narrative', 'true');
        return http.json(`${SEARCH}?${params}`, { timeoutMs: 180_000 });
      };

      const body = await query();
      const hits = body?.hits?.hits;
      if (!Array.isArray(hits)) throw new Error('the CFPB search did not return hits');
      const total = Number(body?.hits?.total?.value ?? hits.length);
      if (total <= MAX_SIZE || config.state) return { hits, total, split: false };

      /* A day the window cannot hold is re-read state by state. Nothing else
       * splits it: the date filters are day-granular, so there is no narrower
       * window, and every other facet is dominated by one value. A row with no
       * state is picked up by the unsplit read, which is why its hits are kept
       * rather than thrown away. */
      log(
        `${dayString} has ${total} complaints, over the ${MAX_SIZE} result window; splitting by state`,
      );
      const byState = [...hits];
      for (const state of STATES) {
        if (Date.now() > deadline) break;
        const part = await query({ state });
        const partHits = part?.hits?.hits;
        if (Array.isArray(partHits)) byState.push(...partHits);
      }
      return { hits: byState, total, split: true };
    };

    const items = [];
    const seen = new Set();
    const keep = (hit, floor) => {
      const item = toItem(hit);
      if (!item || seen.has(item.externalId)) return null;
      seen.add(item.externalId);
      if (floor && item.publishedAt <= floor) return null;
      items.push(item);
      return item;
    };

    if (sweepDays) {
      /* Sweep mode: one older day per run, walking forward and wrapping at the
       * end of the window. Nothing is filtered by a watermark, because the
       * point is to pick up rows that changed after they were first read. */
      const start = utcDay(Date.now() - sweepDays * 24 * 3_600_000);
      let day = cursor.sweepDay ?? start;
      if (day < start || day > today) day = start;
      const { hits, total } = await readDay(day);
      for (const hit of hits) keep(hit, null);
      const nextSweep = nextDay(day) > today ? start : nextDay(day);
      log(`swept ${day}: ${items.length} complaint(s) of ${total}, next ${nextSweep}`);
      return {
        items,
        cursor: { ...cursor, sweepDay: nextSweep },
        note: `${items.length} from ${day}`,
      };
    }

    const backfill = Math.max(1, Math.min(Number(config.backfillDays) || 2, 365));
    const maxDays = Math.max(1, Math.min(Number(config.maxDays) || 5, 60));
    const since = cursor.since ?? new Date(Date.now() - backfill * 24 * 3_600_000).toISOString();
    const days = daysBetween(day(since), today, maxDays);

    let newest = since;
    let read = 0;
    for (const d of days) {
      if (Date.now() > deadline) {
        log(`out of time after ${read} day(s)`);
        break;
      }
      const { hits, total } = await readDay(d);
      read += 1;
      for (const hit of hits) {
        const item = toItem(hit);
        if (item && item.publishedAt > newest) newest = item.publishedAt;
        keep(hit, cursor.since ?? null);
      }
      if (d === today) log(`${d}: ${total} complaint(s) so far today`);
    }

    log(`${items.length} new complaint(s) across ${read} day(s), newest ${newest}`);
    return { items, cursor: { ...cursor, since: newest }, note: `${items.length} complaints` };
  },
});
