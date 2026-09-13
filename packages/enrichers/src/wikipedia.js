import { defineEnricher, searchTitle } from './enricher.js';

/** The Wikipedia lead paragraph and thumbnail for the thing, when a page matches closely enough. */
const SUBJECT = {
  release: (i) => i.data?.artists?.[0] ?? null,
  book: (i) => i.data?.authors?.[0] ?? searchTitle(i),
  launch: (i) => i.data?.rocket ?? i.data?.provider ?? null,
  tournament: () => null,
  provider: (i) => i.data?.name ?? i.title,
};

function similar(a, b) {
  const norm = (s) =>
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  const x = norm(a);
  const y = norm(b);
  return x === y || x.startsWith(y) || y.startsWith(x) || (x.length > 6 && y.includes(x));
}

export const wikipedia = defineEnricher({
  name: 'wikipedia',
  title: 'Wikipedia',
  description: 'The opening paragraph and picture from the matching Wikipedia article.',
  collections: ['games', 'music', 'books', 'space', 'tabletop', 'hosting'],
  appliesTo: (item) => ['game', 'release', 'book', 'launch', 'set', 'provider'].includes(item.kind),
  perRun: 60,
  async enrich(item, { http }) {
    const subject = (SUBJECT[item.kind] ?? searchTitle)(item);
    if (!subject) return null;
    const search = await http.json(
      `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(subject)}&limit=3&format=json`,
    );
    const titles = search?.[1] ?? [];
    const hit = titles.find((t) => similar(t, subject));
    if (!hit) return null;
    const page = await http.jsonOrNull(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(hit.replace(/ /g, '_'))}`,
    );
    if (!page || page.type === 'disambiguation' || !page.extract) return null;
    return {
      subject,
      title: page.title,
      extract: page.extract.slice(0, 1200),
      url:
        page.content_urls?.desktop?.page ??
        `https://en.wikipedia.org/wiki/${encodeURIComponent(hit)}`,
      thumbnail: page.thumbnail?.source ?? null,
      description: page.description ?? null,
      imageUrl: page.thumbnail?.source ?? null,
      summary: page.extract.slice(0, 600),
    };
  },
});
