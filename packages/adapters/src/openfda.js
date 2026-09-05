import { defineAdapter, looseDate } from '@nichedb/core/adapter';

/** openFDA enforcement reports: food, drug and device recalls. Keyless (1,000 requests a day). */
const ymd = (s) =>
  s && /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s;

export function toItem(r, type) {
  const when = looseDate(ymd(r.report_date) ?? '');
  return {
    externalId: r.recall_number ?? r.event_id,
    kind: 'recall',
    title: `${r.classification ?? 'Recall'}: ${(r.product_description ?? '').replace(/\s+/g, ' ').slice(0, 140)}`,
    summary: `${r.recalling_firm ?? 'Unknown firm'} — ${(r.reason_for_recall ?? '').replace(/\s+/g, ' ').slice(0, 400)}`,
    url: `https://www.accessdata.fda.gov/scripts/ires/index.cfm?Product=${encodeURIComponent(r.recall_number ?? '')}`,
    publishedAt: when.publishedAt,
    timeKnown: false,
    precision: 'day',
    tags: [
      'fda',
      'recall',
      type,
      (r.classification ?? '').toLowerCase().replace(/\s+/g, '-'),
      (r.status ?? '').toLowerCase(),
      r.state?.toLowerCase(),
    ].filter(Boolean),
    data: {
      number: r.recall_number,
      firm: r.recalling_firm,
      classification: r.classification,
      status: r.status,
      product: r.product_description,
      reason: r.reason_for_recall,
      distribution: r.distribution_pattern ?? null,
      quantity: r.product_quantity ?? null,
      initiated: ymd(r.recall_initiation_date) ?? null,
      city: r.city ?? null,
      state: r.state ?? null,
    },
  };
}

export const openfda = defineAdapter({
  name: 'openfda-recalls',
  title: 'FDA recalls',
  collection: 'health',
  description:
    'Food, drug and device recalls as the FDA posts enforcement reports, with firm, class and reason. Keyless.',
  docs: 'https://open.fda.gov/apis/',
  kinds: ['recall'],
  cadenceMinutes: 120,
  configFields: [
    {
      key: 'type',
      label: 'Product type',
      type: 'select',
      options: ['food', 'drug', 'device'],
      required: true,
    },
  ],
  defaults: { type: 'food' },
  defaultSources: [
    { slug: 'fda-food-recalls', name: 'FDA: food recalls', config: { type: 'food' } },
    { slug: 'fda-drug-recalls', name: 'FDA: drug recalls', config: { type: 'drug' } },
    { slug: 'fda-device-recalls', name: 'FDA: device recalls', config: { type: 'device' } },
  ],
  async pull({ config, http, log }) {
    const type = ['food', 'drug', 'device'].includes(config.type) ? config.type : 'food';
    const res = await http.json(
      `https://api.fda.gov/${type}/enforcement.json?sort=report_date:desc&limit=100`,
    );
    const items = (res.results ?? []).filter((r) => r.recall_number).map((r) => toItem(r, type));
    log(`${items.length} ${type} recalls`);
    return { items, note: `${items.length} recalls` };
  },
});
