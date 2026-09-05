import { defineEnricher } from './enricher.js';

/** Semantic Scholar's TL;DR, citation counts and open-access PDF for a paper. Keyless at a low rate; S2_API_KEY raises it. */
export const semanticScholar = defineEnricher({
  name: 'semantic-scholar',
  title: 'Semantic Scholar',
  description:
    'A one-sentence TL;DR, citation counts and an open-access PDF where Semantic Scholar has the paper.',
  collections: ['research'],
  appliesTo: (item) => item.kind === 'paper' && Boolean(item.data?.id || item.data?.doi),
  perRun: 10,
  async enrich(item, { env, http }) {
    const id = item.data?.doi
      ? `DOI:${item.data.doi}`
      : `arXiv:${String(item.data.id).replace(/v\d+$/, '')}`;
    const headers = env.s2Key ? { 'x-api-key': env.s2Key } : {};
    const res = await http.request(
      `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(id)}?fields=title,citationCount,influentialCitationCount,tldr,openAccessPdf,fieldsOfStudy,year`,
      { headers },
    );
    if (res.status === 404) return null;
    if (res.status === 429) throw new Error('semantic scholar rate limited');
    if (!res.ok) return null;
    const p = await res.json();
    await Bun.sleep(3000);
    return {
      paperId: p.paperId,
      tldr: p.tldr?.text ?? null,
      citations: p.citationCount ?? 0,
      influential: p.influentialCitationCount ?? 0,
      pdf: p.openAccessPdf?.url ?? null,
      fields: p.fieldsOfStudy ?? [],
      url: `https://www.semanticscholar.org/paper/${p.paperId}`,
      tags: (p.fieldsOfStudy ?? []).slice(0, 3).map((f) => f.toLowerCase()),
    };
  },
});
