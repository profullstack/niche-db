import { defineAdapter, looseDate } from '@nichedb/core/adapter';

/**
 * Rogue AI Tracker: reviewed incidents involving autonomous AI agents, and the
 * research it reads alongside them.
 *
 * The site publishes two read-only JSON APIs and documents them in its own
 * llms.txt as the machine-readable way in, so this is the front door rather
 * than a scrape. Its robots.txt sets `search=yes, ai-train=no, use=reference`,
 * and that signal is honoured here in what we keep, not just in what we say:
 *
 *   kept     title, the site's own one-paragraph summary, the tracker URL,
 *            dates, tags, and — the part that matters most — the PRIMARY
 *            sources each entry cites, so a reader ends up at the evidence.
 *   dropped  `details`, `whyItMatters`, `fullText`, `eli5`: the substantive
 *            body is theirs. We index and point; we do not republish it.
 *
 * Every item is tagged `reference-only` and carries `data.redistribution`, so
 * a bulk export can exclude it while the CC0/public-domain sources stay clean.
 */

const BASE = 'https://rogueaitracker.com';

/** Their tag vocabulary is prose ("Scope breach"); ours is slugs. */
const tag = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** Every primary source an entry cites, deduped, as {name, url}. */
function sourcesOf(r) {
  const all = [
    { name: r.sourceName ?? null, url: r.sourceUrl ?? null },
    ...(Array.isArray(r.additionalSources) ? r.additionalSources : []),
  ];
  const seen = new Set();
  return all
    .map((s) => ({ name: s?.name ?? s?.title ?? null, url: s?.url ?? null }))
    .filter((s) => {
      if (!s.url || seen.has(s.url)) return false;
      seen.add(s.url);
      return true;
    })
    .slice(0, 12);
}

export function incidentToItem(r) {
  const when = looseDate(r.occurredAt ?? r.publishedAt ?? '');
  const sources = sourcesOf(r);
  return {
    externalId: r.id ?? r.slug,
    kind: 'incident',
    title: r.title,
    summary: r.summary ?? null,
    url: `${BASE}/incidents/${r.slug}/`,
    publishedAt: when.publishedAt,
    timeKnown: when.timeKnown,
    precision: when.precision,
    tags: ['rogue-ai', 'incident', 'reference-only', ...(r.tags ?? []).map(tag)].filter(Boolean),
    data: {
      slug: r.slug,
      occurredAt: r.occurredAt ?? null,
      publishedAt: r.publishedAt ?? null,
      dateBasis: r.dateBasis ?? null,
      dateNote: r.dateNote ?? null,
      evidenceAttribution: r.evidenceAttribution ?? null,
      attributionReview: r.attributionReview ?? null,
      capabilities: r.tags ?? [],
      gateImpacts: r.gateImpacts ?? null,
      sources,
      primarySource: sources[0]?.url ?? null,
      markdown: `${BASE}/incidents/${r.slug}/index.md`,
      redistribution: 'reference',
      attribution: 'Rogue AI Tracker (rogueaitracker.com)',
    },
  };
}

export function researchToItem(r) {
  const when = looseDate(r.publishedAt ?? '');
  const sources = sourcesOf(r);
  return {
    externalId: r.id ?? r.slug,
    kind: 'research',
    title: r.title,
    summary: r.summary ?? null,
    url: `${BASE}/research/${r.slug}/`,
    publishedAt: when.publishedAt,
    timeKnown: when.timeKnown,
    precision: when.precision,
    tags: [
      'rogue-ai',
      'research',
      'reference-only',
      tag(r.articleType),
      tag(r.topic),
      ...(r.clusters ?? []).map(tag),
    ].filter(Boolean),
    data: {
      slug: r.slug,
      articleType: r.articleType ?? null,
      topic: r.topic ?? null,
      clusters: r.clusters ?? [],
      keyClaims: r.keyClaims ?? [],
      relatedIncidents: r.relatedIncidentSlugs ?? [],
      reviewStatus: r.reviewStatus ?? null,
      sources,
      primarySource: sources[0]?.url ?? null,
      markdown: `${BASE}/research/${r.slug}/index.md`,
      redistribution: 'reference',
      attribution: 'Rogue AI Tracker (rogueaitracker.com)',
    },
  };
}

export const rogueIncidents = defineAdapter({
  name: 'rogue-ai-incidents',
  title: 'Rogue AI Tracker: incidents',
  collection: 'ai-incidents',
  description:
    'Reviewed real-world incidents involving autonomous AI agents, with the capabilities each event demonstrated and links to every primary source cited. Indexed under the site’s own content signal: summary and sources, never the review body. Keyless.',
  docs: `${BASE}/llms.txt`,
  kinds: ['incident'],
  cadenceMinutes: 180,
  redistribution: 'reference',
  defaultSources: [{ slug: 'rogue-ai-incidents', name: 'Rogue AI Tracker: incidents' }],
  async pull({ http, log }) {
    const res = await http.json(`${BASE}/api/incidents`);
    const items = (res.incidents ?? [])
      .filter((r) => r?.title && (r.id || r.slug))
      .map(incidentToItem);
    log(`${items.length} reviewed incidents`);
    return { items, note: `${items.length} incidents` };
  },
});

export const rogueResearch = defineAdapter({
  name: 'rogue-ai-research',
  title: 'Rogue AI Tracker: research',
  collection: 'ai-incidents',
  description:
    'Reviewed research on multi-agent systems, swarms and coordination failures, with key claims, clusters and the source paper. Summary and sources only. Keyless.',
  docs: `${BASE}/llms.txt`,
  kinds: ['research'],
  cadenceMinutes: 360,
  redistribution: 'reference',
  defaultSources: [{ slug: 'rogue-ai-research', name: 'Rogue AI Tracker: research' }],
  async pull({ http, log }) {
    const res = await http.json(`${BASE}/api/research`);
    const items = (res.articles ?? [])
      .filter((r) => r?.title && (r.id || r.slug))
      .map(researchToItem);
    log(`${items.length} research entries`);
    return { items, note: `${items.length} entries` };
  },
});
