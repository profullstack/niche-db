import { defineAdapter, looseDate } from '@nichedb/core/adapter';

/** CourtListener's search API, newest opinions first. Free, but needs an account token (COURTLISTENER_TOKEN). */
export function toItem(r) {
  const when = looseDate(r.dateFiled);
  return {
    externalId: String(r.cluster_id ?? r.id),
    kind: 'opinion',
    title: r.caseName ?? r.caseNameFull ?? `Opinion ${r.cluster_id}`,
    summary: r.snippet ? String(r.snippet).replace(/\s+/g, ' ').trim() : null,
    url: r.absolute_url ? `https://www.courtlistener.com${r.absolute_url}` : null,
    publishedAt: when.publishedAt,
    timeKnown: false,
    precision: 'day',
    tags: ['courtlistener', r.court_id, String(r.status ?? '').toLowerCase()].filter(Boolean),
    data: {
      court: r.court,
      courtId: r.court_id,
      docket: r.docketNumber ?? null,
      citation: r.citation ?? [],
      judge: r.judge ?? null,
    },
  };
}

export const courtlistener = defineAdapter({
  name: 'courtlistener',
  title: 'CourtListener opinions',
  collection: 'filings',
  description:
    'Court opinions as they are published, from CourtListener. Free with an account; set COURTLISTENER_TOKEN on the deployment. Optionally narrow to a court or a search.',
  docs: 'https://www.courtlistener.com/help/api/rest/',
  kinds: ['opinion'],
  cadenceMinutes: 60,
  needsEnv: ['courtlistenerToken'],
  configFields: [
    { key: 'q', label: 'Search', placeholder: 'copyright', help: 'Optional full-text query.' },
    {
      key: 'court',
      label: 'Court id',
      placeholder: 'scotus',
      help: 'Optional: scotus, ca9, nysd…',
    },
  ],
  defaults: {},
  defaultSources: [{ slug: 'courtlistener-opinions', name: 'CourtListener: newest opinions' }],
  async pull({ config, env, http, log }) {
    if (!env.courtlistenerToken) throw new Error('COURTLISTENER_TOKEN is not set');
    const params = new URLSearchParams({ type: 'o', order_by: 'dateFiled desc' });
    if (config.q) params.set('q', String(config.q));
    if (config.court) params.set('court', String(config.court));
    const res = await http.json(`https://www.courtlistener.com/api/rest/v4/search/?${params}`, {
      headers: { authorization: `Token ${env.courtlistenerToken}` },
    });
    const items = (res.results ?? []).map(toItem);
    log(`${items.length} opinion(s)`);
    return { items, note: `${items.length} of ${res.count ?? '?'}` };
  },
});
