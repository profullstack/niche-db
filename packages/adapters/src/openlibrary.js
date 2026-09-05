import { defineAdapter, looseDate } from '@nichedb/core/adapter';

/** Open Library: works first published this year, newest additions first. Keyless. */
export function toItem(d) {
  const year = d.first_publish_year ?? null;
  const when = looseDate(year ? String(year) : '');
  const cover = d.cover_i
    ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg`
    : d.isbn?.[0]
      ? `https://covers.openlibrary.org/b/isbn/${d.isbn[0]}-M.jpg?default=false`
      : null;
  const subjects = (d.subject ?? []).slice(0, 8).map((s) => s.toLowerCase());
  return {
    externalId: d.key,
    kind: 'book',
    title: `${d.title}${d.author_name?.length ? ` — ${d.author_name.slice(0, 2).join(', ')}` : ''}`,
    summary:
      [
        d.publisher?.[0],
        d.language?.[0] ? `lang ${d.language[0]}` : null,
        d.number_of_pages_median ? `${d.number_of_pages_median} pages` : null,
      ]
        .filter(Boolean)
        .join(' · ') || null,
    url: `https://openlibrary.org${d.key}`,
    imageUrl: cover,
    publishedAt: when.publishedAt,
    timeKnown: false,
    precision: 'year',
    tags: ['openlibrary', ...subjects],
    data: {
      title: d.title,
      authors: d.author_name ?? [],
      year,
      isbn: (d.isbn ?? []).slice(0, 5),
      publisher: d.publisher?.[0] ?? null,
      editions: d.edition_count ?? null,
    },
  };
}

export const openlibrary = defineAdapter({
  name: 'openlibrary',
  title: 'Open Library',
  collection: 'books',
  description:
    'Books first published this year as they are added to Open Library, with covers. Keyless. Narrow with a subject or a search.',
  docs: 'https://openlibrary.org/dev/docs/api/search',
  kinds: ['book'],
  cadenceMinutes: 120,
  configFields: [
    {
      key: 'q',
      label: 'Search',
      placeholder: 'subject:science fiction',
      help: 'Optional extra query; the year filter is added automatically.',
    },
    { key: 'pages', label: 'Pages of 100', type: 'number', placeholder: '2' },
  ],
  defaults: { pages: 2 },
  defaultSources: [{ slug: 'openlibrary-new', name: 'Open Library: new this year' }],
  async pull({ config, http, log }) {
    const year = new Date().getUTCFullYear();
    const q = `first_publish_year:${year}${config.q ? ` AND ${config.q}` : ''}`;
    const fields =
      'key,title,author_name,first_publish_year,cover_i,isbn,subject,publisher,language,number_of_pages_median,edition_count';
    const pages = Math.min(Math.max(1, Number(config.pages) || 2), 5);
    const items = [];
    for (let p = 1; p <= pages; p++) {
      const res = await http.json(
        `https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&sort=new&limit=100&page=${p}&fields=${fields}`,
      );
      for (const d of res.docs ?? []) if (d.key && d.title) items.push(toItem(d));
      if ((res.docs ?? []).length < 100) break;
    }
    log(`${items.length} books`);
    return { items, note: `${items.length} books` };
  },
});
