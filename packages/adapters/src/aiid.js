import { decodeEntities, defineAdapter, first, stripHtml, xmlItems } from '@nichedb/core/adapter';

/**
 * The AI Incident Database (Responsible AI Collaborative).
 *
 * The GraphQL endpoint is now origin-locked to their own site ("API access is
 * restricted to web browsers"), so the public feed is the supported way in.
 * Each entry is a report filed against an incident: the link goes to the
 * original reporting, and the description carries the incident's cite URL,
 * which is how a report is tied back to the incident it evidences.
 *
 * This is the upstream that keeps the collection standing on its own. Where
 * Rogue AI Tracker is indexed by reference, AIID publishes under CC-BY-SA 4.0,
 * so its rows are ours to keep and redistribute with attribution.
 */

const FEED = 'https://incidentdatabase.ai/rss.xml';

/** "…(https://incidentdatabase.ai/cite/1650#7893)" → {incidentId: 1650, reportId: 7893}. */
export function citeOf(description) {
  const m = /incidentdatabase\.ai\/cite\/(\d+)(?:#(\d+))?/.exec(String(description ?? ''));
  if (!m) return { incidentId: null, reportId: null, citeUrl: null };
  return {
    incidentId: Number(m[1]),
    reportId: m[2] ? Number(m[2]) : null,
    citeUrl: `https://incidentdatabase.ai/cite/${m[1]}${m[2] ? `#${m[2]}` : ''}`,
  };
}

export function toItem(entry) {
  const title = decodeEntities(first(entry.title)?.text ?? '');
  const rawDescription = first(entry.description)?.text ?? '';
  const cite = citeOf(rawDescription);
  const guid = first(entry.guid)?.text;
  const link = first(entry.link)?.text ?? cite.citeUrl;
  const published = first(entry.pubDate)?.text;
  const image = first(entry.enclosure)?.attrs?.url ?? null;
  if (!title || !(guid || link)) return null;
  // Strip the trailing "(cite url)" the feed appends: the link is already a field.
  const summary = stripHtml(rawDescription).replace(
    /\s*\(https:\/\/incidentdatabase\.ai\/cite\/[^)]*\)\s*$/,
    '',
  );
  const at = published ? new Date(published) : null;
  return {
    externalId: guid ?? link,
    kind: 'incident-report',
    title,
    summary: summary || null,
    url: link,
    imageUrl: image && !image.includes('d41d8cd98f00b204e9800998ecf8427e') ? image : null,
    publishedAt: at && !Number.isNaN(at.getTime()) ? at : null,
    timeKnown: false,
    precision: 'day',
    tags: ['aiid', 'incident-report', 'harm'].filter(Boolean),
    data: {
      incidentId: cite.incidentId,
      reportId: cite.reportId,
      citeUrl: cite.citeUrl,
      redistribution: 'cc-by-sa-4.0',
      attribution: 'AI Incident Database (incidentdatabase.ai), CC BY-SA 4.0',
    },
  };
}

export const aiid = defineAdapter({
  name: 'aiid-reports',
  title: 'AI Incident Database',
  collection: 'ai-incidents',
  description:
    'Reports of real-world harms caused by AI systems, as they are filed at the AI Incident Database, each tied to the incident it evidences. CC BY-SA 4.0, keyless.',
  docs: 'https://incidentdatabase.ai/',
  kinds: ['incident-report'],
  cadenceMinutes: 180,
  redistribution: 'cc-by-sa-4.0',
  defaultSources: [{ slug: 'aiid-reports', name: 'AI Incident Database: new reports' }],
  async pull({ http, log }) {
    const xml = await http.text(FEED);
    const items = xmlItems(xml, 'item').map(toItem).filter(Boolean);
    log(`${items.length} AIID reports`);
    return { items, note: `${items.length} reports` };
  },
});
