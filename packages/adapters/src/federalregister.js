import { defineAdapter, looseDate } from '@nichedb/core/adapter';

/** The Federal Register's public JSON API: rules, proposed rules, notices and presidential documents. Keyless. */
export function toItem(d) {
  const when = looseDate(d.publication_date);
  const agencies = (d.agencies ?? []).map((a) => a.name).filter(Boolean);
  return {
    externalId: d.document_number,
    kind: 'document',
    title: d.title,
    summary: d.abstract ?? null,
    url: d.html_url,
    publishedAt: when.publishedAt,
    timeKnown: false,
    precision: 'day',
    tags: [
      'federal-register',
      String(d.type ?? '')
        .toLowerCase()
        .replace(/\s+/g, '-'),
      ...agencies.slice(0, 4).map((a) => a.toLowerCase()),
    ],
    data: {
      type: d.type,
      agencies,
      pdf: d.pdf_url ?? null,
      citation: d.citation ?? null,
      docket: d.docket_ids ?? [],
    },
  };
}

export const federalRegister = defineAdapter({
  name: 'federal-register',
  title: 'Federal Register',
  collection: 'filings',
  description:
    'Newest documents in the Federal Register: rules, proposed rules, notices, presidential documents. Keyless. Filter by type or a search term.',
  docs: 'https://www.federalregister.gov/developers/documentation/api/v1',
  kinds: ['document'],
  cadenceMinutes: 60,
  configFields: [
    {
      key: 'type',
      label: 'Type',
      type: 'select',
      options: ['', 'RULE', 'PRORULE', 'NOTICE', 'PRESDOCU'],
    },
    { key: 'term', label: 'Search term', placeholder: 'artificial intelligence' },
    { key: 'agency', label: 'Agency slug', placeholder: 'federal-communications-commission' },
  ],
  defaults: {},
  defaultSources: [{ slug: 'federal-register', name: 'Federal Register: newest documents' }],
  async pull({ config, http, log }) {
    const params = new URLSearchParams({ order: 'newest', per_page: '100' });
    if (config.type) params.append('conditions[type][]', String(config.type));
    if (config.term) params.set('conditions[term]', String(config.term));
    if (config.agency) params.append('conditions[agencies][]', String(config.agency));
    const res = await http.json(`https://www.federalregister.gov/api/v1/documents.json?${params}`);
    const items = (res.results ?? []).map(toItem);
    log(`${items.length} document(s)`);
    return { items, note: `${items.length} of ${res.count ?? '?'}` };
  },
});
