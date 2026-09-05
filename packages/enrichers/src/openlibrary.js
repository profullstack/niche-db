import { defineEnricher } from './enricher.js';

/** The work's description and subjects from Open Library. */
export const openlibraryWork = defineEnricher({
  name: 'openlibrary-work',
  title: 'Open Library description',
  description: "The work's own description and subject list from Open Library.",
  collections: ['books'],
  appliesTo: (item) =>
    item.kind === 'book' && /^\/(works|books)\/OL/.test(String(item.external_id ?? '')),
  perRun: 60,
  async enrich(item, { http }) {
    const w = await http.jsonOrNull(`https://openlibrary.org${item.external_id}.json`);
    if (!w) return null;
    const desc = typeof w.description === 'string' ? w.description : w.description?.value;
    const subjects = (w.subjects ?? []).slice(0, 10);
    if (!desc && subjects.length === 0) return null;
    return {
      description: desc ? String(desc).slice(0, 1200) : null,
      subjects,
      summary: desc ? String(desc).slice(0, 600) : null,
      tags: subjects.slice(0, 5).map((s) => s.toLowerCase()),
    };
  },
});
