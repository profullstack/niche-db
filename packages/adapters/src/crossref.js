import { defineAdapter, looseDate, stripHtml } from '@nichedb/core/adapter';

/** Crossref: newly registered DOIs, optionally filtered by type or a query. Keyless with a mailto for the polite pool. */
export function toItem(w) {
  const created = w.created?.['date-time'] ?? null;
  const issued = w.issued?.['date-parts']?.[0];
  const when = created
    ? { publishedAt: new Date(created), timeKnown: true, precision: 'minute' }
    : looseDate(issued ? issued.join('-') : '');
  const authors = (w.author ?? [])
    .map((a) => [a.given, a.family].filter(Boolean).join(' '))
    .filter(Boolean);
  return {
    externalId: w.DOI,
    kind: 'paper',
    title: (w.title?.[0] ?? w.DOI).replace(/\s+/g, ' ').trim(),
    summary: w.abstract
      ? stripHtml(w.abstract).slice(0, 1000)
      : [w['container-title']?.[0], w.publisher].filter(Boolean).join(' · ') || null,
    url: w.URL ?? `https://doi.org/${w.DOI}`,
    publishedAt: when.publishedAt,
    timeKnown: when.timeKnown,
    precision: when.precision,
    tags: [
      'crossref',
      w.type,
      ...(w.subject ?? []).slice(0, 5).map((s) => s.toLowerCase()),
      w['container-title']?.[0] ? w['container-title'][0].toLowerCase().slice(0, 60) : null,
    ].filter(Boolean),
    data: {
      doi: w.DOI,
      type: w.type,
      journal: w['container-title']?.[0] ?? null,
      publisher: w.publisher ?? null,
      authors: authors.slice(0, 12),
      issued: issued ? issued.join('-') : null,
      references: w['reference-count'] ?? 0,
      license: w.license?.[0]?.URL ?? null,
    },
  };
}

export const crossref = defineAdapter({
  name: 'crossref',
  title: 'Crossref DOIs',
  collection: 'research',
  description:
    'Newly registered scholarly works from Crossref (journal articles, preprints, books, datasets), with abstracts where deposited. Keyless.',
  docs: 'https://api.crossref.org/swagger-ui/index.html',
  kinds: ['paper'],
  cadenceMinutes: 30,
  configFields: [
    {
      key: 'type',
      label: 'Type',
      type: 'select',
      options: ['', 'journal-article', 'posted-content', 'book', 'dataset', 'proceedings-article'],
    },
    { key: 'query', label: 'Query', placeholder: 'large language models' },
  ],
  defaults: { type: 'journal-article' },
  defaultSources: [
    {
      slug: 'crossref-articles',
      name: 'Crossref: new journal articles',
      config: { type: 'journal-article' },
    },
  ],
  async pull({ config, env, http, log }) {
    const params = new URLSearchParams({
      sort: 'created',
      order: 'desc',
      rows: '100',
      select: 'DOI,title,abstract,URL,type,subject,container-title,publisher,author,issued,created',
    });
    const filters = ['has-abstract:true'];
    if (config.type) filters.push(`type:${config.type}`);
    params.set('filter', filters.join(','));
    if (config.query) params.set('query', String(config.query));
    if (env.contactEmail) params.set('mailto', env.contactEmail);
    const res = await http.json(`https://api.crossref.org/works?${params}`, { timeoutMs: 60_000 });
    const items = (res.message?.items ?? []).filter((w) => w.DOI).map(toItem);
    log(`${items.length} works`);
    return { items, note: `${items.length} works` };
  },
});
