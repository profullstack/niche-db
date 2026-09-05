import { defineAdapter, first, stripHtml, xmlItems } from '@nichedb/core/adapter';

/** arXiv: newest submissions in chosen categories, with abstracts and authors. Keyless Atom. */
export function parseFeed(xml) {
  const out = [];
  for (const e of xmlItems(xml, 'entry')) {
    const id = first(e.id)?.text ?? '';
    const arxivId = id.replace(/^https?:\/\/arxiv\.org\/abs\//, '');
    if (!arxivId) continue;
    const cats = (Array.isArray(e.category) ? e.category : e.category ? [e.category] : [])
      .map((c) => c.attrs?.term)
      .filter(Boolean);
    const authors = (Array.isArray(e.author) ? e.author : e.author ? [e.author] : [])
      .map((a) => stripHtml(a.text))
      .filter(Boolean);
    out.push({
      externalId: arxivId,
      kind: 'paper',
      title: (first(e.title)?.text ?? arxivId).replace(/\s+/g, ' ').trim(),
      summary: (first(e.summary)?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 1200) || null,
      url: `https://arxiv.org/abs/${arxivId.replace(/v\d+$/, '')}`,
      publishedAt: first(e.published)?.text ?? null,
      tags: ['arxiv', ...cats.map((c) => c.toLowerCase())],
      data: {
        id: arxivId,
        authors: authors.slice(0, 12),
        categories: cats,
        pdf: `https://arxiv.org/pdf/${arxivId}`,
        updated: first(e.updated)?.text ?? null,
        comment: first(e['arxiv:comment'])?.text ?? null,
      },
    });
  }
  return out;
}

export const arxiv = defineAdapter({
  name: 'arxiv',
  title: 'arXiv',
  collection: 'research',
  description:
    'New preprints in the arXiv categories you choose, with abstracts and authors. Keyless.',
  docs: 'https://info.arxiv.org/help/api/index.html',
  kinds: ['paper'],
  cadenceMinutes: 60,
  configFields: [
    {
      key: 'categories',
      label: 'Categories',
      type: 'list',
      required: true,
      placeholder: 'cs.AI, cs.LG, cs.CL, cs.CR',
      help: 'arXiv category codes, comma separated.',
    },
    {
      key: 'query',
      label: 'Extra query',
      placeholder: 'all:agents',
      help: 'Optional arXiv search expression ANDed with the categories.',
    },
  ],
  defaults: { categories: ['cs.AI'] },
  defaultSources: [
    {
      slug: 'arxiv-ai',
      name: 'arXiv: AI, ML and language',
      config: { categories: ['cs.AI', 'cs.LG', 'cs.CL'] },
    },
    {
      slug: 'arxiv-security',
      name: 'arXiv: security and crypto',
      config: { categories: ['cs.CR'] },
    },
  ],
  async pull({ config, http, log }) {
    const cats = (
      Array.isArray(config.categories)
        ? config.categories
        : String(config.categories ?? '').split(',')
    )
      .map((s) => String(s).trim())
      .filter((s) => /^[a-z-]+(\.[A-Za-z-]+)?$/.test(s))
      .slice(0, 10);
    if (cats.length === 0) throw new Error('at least one category is needed');
    const catQ = `(${cats.map((c) => `cat:${c}`).join(' OR ')})`;
    const query = config.query ? `${catQ} AND (${config.query})` : catQ;
    const xml = await http.text(
      `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(query)}&sortBy=submittedDate&sortOrder=descending&max_results=100`,
      { headers: { accept: 'application/atom+xml' }, timeoutMs: 60_000 },
    );
    const items = parseFeed(xml);
    log(`${items.length} papers`);
    return { items, note: `${items.length} papers` };
  },
});
