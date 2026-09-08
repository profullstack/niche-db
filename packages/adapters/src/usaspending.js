import { defineAdapter, slugify } from '@nichedb/core/adapter';

/**
 * USAspending: every dollar the US federal government awards, as it is awarded.
 *
 * The disclosure regime behind this is unusually generous. Federal agencies
 * are required to report each contract and each grant, and USAspending
 * publishes the lot through an open API with no key and no registration — the
 * recipient, the awarding agency and sub-agency, the amount, the period and
 * the government's own description of what was bought.
 *
 * Contracts and assistance are the same endpoint with different type codes,
 * and they are genuinely different things: a contract is the government buying
 * something, an assistance award is the government funding something. They are
 * seeded as separate sources so a reader can follow one without the other.
 *
 * The one number to be careful with is the amount. `Award Amount` is the
 * current total obligated over the life of the award, not what was signed this
 * week, so a decades-old contract that received a small modification appears
 * with its whole historic value. That is what the field means and it is not
 * wrong, but printed beside a date it invites being read as "this was awarded
 * today", so the payload carries the start date and the item says what the
 * figure is.
 */

const API = 'https://api.usaspending.gov/api/v2';

/**
 * The award type codes, grouped the way people actually think about them.
 *
 * These are the government's own codes: A-D are the procurement families,
 * 02-05 are grants and other assistance, 06-11 cover direct payments, loans
 * and insurance.
 */
export const AWARD_GROUPS = {
  contracts: {
    codes: ['A', 'B', 'C', 'D'],
    kind: 'contract-award',
    label: 'contract',
    verb: 'awarded a contract',
  },
  grants: {
    codes: ['02', '03', '04', '05'],
    kind: 'grant-award',
    label: 'grant',
    verb: 'awarded a grant',
  },
  loans: {
    codes: ['07', '08'],
    kind: 'loan',
    label: 'loan',
    verb: 'issued a loan',
  },
  'direct-payments': {
    codes: ['06', '10'],
    kind: 'direct-payment',
    label: 'direct payment',
    verb: 'made a direct payment',
  },
};

export const GROUP_KEYS = Object.keys(AWARD_GROUPS);

const FIELDS = [
  'Award ID',
  'Recipient Name',
  'Award Amount',
  'Awarding Agency',
  'Awarding Sub Agency',
  'Start Date',
  'End Date',
  'Description',
];

/**
 * Dollars, in the shape a headline uses them.
 *
 * Guarded on the value before the cast. `Number(null)` is 0 and 0 is finite,
 * so an award with no reported amount would render as "$0 contract" — which
 * does not read as "amount not disclosed", it reads as a contract worth
 * nothing.
 */
export function money(n) {
  if (n === null || n === undefined || n === '') return null;
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  if (Math.abs(v) >= 1e9) return `$${(v / 1e9).toFixed(2)}bn`;
  if (Math.abs(v) >= 1e6) return `$${(v / 1e6).toFixed(1)}m`;
  if (Math.abs(v) >= 1e3) return `$${Math.round(v / 1e3)}k`;
  return `$${Math.round(v)}`;
}

export function toItem(row, group) {
  const spec = AWARD_GROUPS[group] ?? AWARD_GROUPS.contracts;
  const id = row['Award ID'];
  const recipient = row['Recipient Name'];
  const amount = Number(row['Award Amount']);
  if (!id || !recipient) return null;

  const agency = row['Awarding Agency'] ?? null;
  const sub = row['Awarding Sub Agency'] ?? null;
  const start = row['Start Date'] ?? null;
  // A minority of assistance awards carry no start date. An item with no date
  // sinks to the bottom of every feed and reads as undated rather than as an
  // award, so the end date stands in and the payload keeps both apart.
  const dated = start ?? row['End Date'] ?? null;
  const description = String(row.Description ?? '')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    // USAspending's own generated id where it gave one: an award that is
    // modified keeps its identity rather than arriving again as a new row.
    externalId: `usa-${row.generated_internal_id ?? row.internal_id ?? id}`,
    kind: spec.kind,
    title: `${recipient}: ${money(amount) ?? 'an undisclosed amount'} ${spec.label} from ${sub ?? agency ?? 'a federal agency'}`,
    summary:
      [
        `${agency ?? 'A federal agency'}${sub && sub !== agency ? ` (${sub})` : ''} ${spec.verb} to ${recipient}`,
        Number.isFinite(amount) ? `worth ${money(amount)} in total obligations` : null,
        start ? `beginning ${start}` : null,
        row['End Date'] ? `and running to ${row['End Date']}` : null,
      ]
        .filter(Boolean)
        .join(', ')
        .concat('.') + (description ? ` ${description.slice(0, 600)}` : ''),
    url: row.generated_internal_id
      ? `https://www.usaspending.gov/award/${encodeURIComponent(row.generated_internal_id)}`
      : 'https://www.usaspending.gov/search',
    publishedAt: dated,
    timeKnown: false,
    precision: 'day',
    tags: [
      'public-money',
      'us',
      spec.kind,
      agency ? slugify(agency).slice(0, 50) : null,
      sub ? slugify(sub).slice(0, 50) : null,
      // Bands, so "the big ones" is a feed rather than a sort.
      Number.isFinite(amount) && amount >= 1e9 ? 'billion-plus' : null,
      Number.isFinite(amount) && amount >= 1e6 ? 'million-plus' : null,
    ].filter(Boolean),
    data: {
      // The shape every row in this collection shares, whichever government
      // published it, so a reader can compare without knowing which.
      award: {
        country: 'US',
        jurisdiction: 'US federal',
        id: String(id),
        buyer: agency,
        buyerUnit: sub,
        supplier: recipient,
        amount: Number.isFinite(amount) ? amount : null,
        currency: 'USD',
        startDate: start,
        endDate: row['End Date'] ?? null,
        stage: 'award',
      },
      awardType: spec.label,
      description: description || null,
      recipientId: row.recipient_id ?? null,
      // Which date the row is filed under, since it is not always the start.
      datedBy: start ? 'start-date' : row['End Date'] ? 'end-date' : 'undated',
      // Said explicitly, because the field name does not say it: this is the
      // total obligated over the award's life, not this week's signing.
      amountBasis: 'total-obligated-to-date',
      amountNote:
        'The total obligated over the life of the award to date, not the value of a single transaction. A long-running award that received a small modification still shows its whole historic value.',
      source: 'USAspending.gov',
      licence: 'US public domain',
      raw: row,
    },
  };
}

export const usaspendingAwards = defineAdapter({
  name: 'usaspending-awards',
  title: 'US federal contracts and grants',
  collection: 'public-money',
  description:
    'Every contract, grant, loan and direct payment the US federal government awards, with the recipient, the awarding agency and sub-agency, the amount obligated and the period. Keyless, US public domain.',
  docs: 'https://api.usaspending.gov/',
  kinds: ['contract-award', 'grant-award', 'loan', 'direct-payment'],
  cadenceMinutes: 60 * 6,
  configFields: [
    {
      key: 'group',
      label: 'Award type',
      type: 'select',
      options: GROUP_KEYS,
      help: 'Contracts are the government buying something; grants are the government funding something.',
    },
    {
      key: 'lookbackDays',
      label: 'Days back',
      type: 'number',
      placeholder: '14',
      help: 'Awards are reported with a lag, so a window rather than a cursor.',
    },
    {
      key: 'minimumAmount',
      label: 'Minimum amount',
      type: 'number',
      placeholder: '1000000',
      help: 'Optional floor, to keep a feed to the awards worth reading.',
    },
  ],
  defaults: { group: 'contracts', lookbackDays: 14 },
  defaultSources: [
    { slug: 'us-federal-contracts', name: 'US federal contracts', config: { group: 'contracts' } },
    { slug: 'us-federal-grants', name: 'US federal grants', config: { group: 'grants' } },
    {
      slug: 'us-federal-big-awards',
      name: 'US federal awards over $100m',
      config: { group: 'contracts', minimumAmount: 100_000_000 },
    },
  ],
  async pull({ config, http, log }) {
    const group = GROUP_KEYS.includes(config.group) ? config.group : 'contracts';
    const spec = AWARD_GROUPS[group];
    const days = Math.min(Math.max(Number(config.lookbackDays) || 14, 1), 365);
    const end = new Date();
    const start = new Date(end.getTime() - days * 86_400_000);
    const day = (d) => d.toISOString().slice(0, 10);

    const items = [];
    let page = 1;
    let hasNext = true;
    while (hasNext && page <= 5) {
      const res = await http.json(`${API}/search/spending_by_award/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          filters: {
            award_type_codes: spec.codes,
            time_period: [{ start_date: day(start), end_date: day(end) }],
          },
          fields: FIELDS,
          page,
          limit: 100,
          sort: 'Award Amount',
          order: 'desc',
          subawards: false,
        }),
        timeoutMs: 60_000,
      });
      const rows = res?.results ?? [];
      for (const r of rows) {
        const amount = Number(r['Award Amount']);
        if (config.minimumAmount && !(amount >= Number(config.minimumAmount))) continue;
        const item = toItem(r, group);
        if (item) items.push(item);
      }
      hasNext = Boolean(res?.page_metadata?.hasNext) && rows.length > 0;
      page++;
    }

    log(`${items.length} ${spec.label} award(s) in the last ${days} days`);
    return { items, note: `${items.length} ${group}` };
  },
});
