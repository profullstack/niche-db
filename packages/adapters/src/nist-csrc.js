import { defineAdapter, looseDate, stripHtml } from '@nichedb/core/adapter';

/**
 * NIST CSRC: the cybersecurity and privacy publications NIST has out for
 * public comment, from the Computer Security Resource Center's own feed.
 *
 * NIST publishes its security standards and guidance as drafts first: SP
 * 800-series guidelines, FIPS, Internal Reports, white papers, the AI series.
 * Each has a comment period, and CSRC keeps one feed of the drafts whose
 * period is still open, with the date it closes (or "No Due Date"). The feed
 * is served as JSON and as Atom; the JSON is read here, and it arrives with a
 * UTF-8 byte-order mark that JSON.parse rejects, so the mark is stripped.
 *
 * A draft leaves the feed when its comment period ends. The row is not left
 * open: the cursor remembers which drafts were open last time, and one that
 * has gone is re-emitted from the data it was stored with, tagged
 * `status:closed`, so the open-for-comment feed shows only what a reader can
 * still comment on and the row keeps its history.
 */
export const FEED = 'https://csrc.nist.gov/CSRC/media/feeds/pubs/drafts-open-for-comment.json';
export const PAGE_URL = 'https://csrc.nist.gov/publications/drafts-open-for-comment';
export const ATTRIBUTION = 'NIST Computer Security Resource Center, csrc.nist.gov: public domain.';

/** The feed as JSON, with the byte-order mark CSRC serves it with removed. */
export function parseDrafts(text) {
  const doc = JSON.parse(String(text ?? '').replace(/^﻿/, ''));
  return {
    updated: doc?.updated ?? null,
    entries: Array.isArray(doc?.entries) ? doc.entries : [],
  };
}

const SERIES = [
  [/^(?:NIST\s+)?SP\s*(\d{3,4})/i, (m) => `sp-${m[1]}`],
  [/^(?:NIST\s+)?FIPS\b/i, () => 'fips'],
  [/^(?:NIST\s+)?IR\b/i, () => 'ir'],
  [/^(?:NIST\s+)?CSWP\b/i, () => 'cswp'],
  [/^(?:NIST\s+)?AI\b/i, () => 'ai'],
  [/^(?:NIST\s+)?TN\b/i, () => 'tn'],
  [/^(?:NIST\s+)?GCR\b/i, () => 'gcr'],
];

/** The publication family from the title's prefix: sp-800, sp-1800, fips, ir, cswp, ai; null when it names none. */
export function seriesOf(title) {
  const t = String(title ?? '').trim();
  for (const [re, make] of SERIES) {
    const m = t.match(re);
    if (m) return make(m);
  }
  return null;
}

/**
 * When comments close, from the feed's one-line `content`: "Comment period
 * closes September 30, 2026" carries a date, "No Due Date: Comment Period
 * Remains Open" carries none.
 */
export function closesOf(content) {
  const s = String(content ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s || /no due date/i.test(s)) return { closes: null, note: s || null };
  const m = s.match(/([A-Z][a-z]+ \d{1,2}, \d{4})/);
  const d = m ? new Date(`${m[1]} 12:00:00 UTC`) : null;
  return { closes: d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : null, note: s };
}

export function toItem(e, status = 'open') {
  const id = e?.id ?? e?.link;
  if (!id || !e?.title) return null;
  const title = String(e.title).replace(/\s+/g, ' ').trim();
  const series = seriesOf(title);
  const { closes, note } = closesOf(e.content);
  const published = String(e.published ?? e.updated ?? '').slice(0, 10);
  const dated = /^\d{4}-\d\d-\d\d$/.test(published) ? looseDate(published) : { publishedAt: null };
  return {
    externalId: String(id),
    kind: 'draft',
    title,
    summary:
      stripHtml(e.summary ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 1200) || null,
    url: e.link ?? String(id),
    ...dated,
    tags: [
      'nist',
      'csrc',
      'draft',
      `status:${status}`,
      series ? `series:${series}` : null,
      status === 'open' && !closes ? 'no-due-date' : null,
    ].filter(Boolean),
    data: {
      status,
      series,
      published: e.published ?? null,
      updated: e.updated ?? null,
      closes,
      commentPeriod: note,
      attribution: ATTRIBUTION,
      // What a closed draft is rebuilt from once the feed no longer carries it.
      entry: {
        id: String(id),
        title: e.title,
        summary: e.summary ?? null,
        link: e.link ?? null,
        content: e.content ?? null,
        published: e.published ?? null,
        updated: e.updated ?? null,
      },
    },
  };
}

export const nistCsrcDrafts = defineAdapter({
  name: 'nist-csrc-drafts',
  title: 'NIST CSRC: drafts open for comment',
  collection: 'research',
  description:
    'The cybersecurity and privacy publications NIST has out for public comment: SP 800 guidelines, FIPS, Internal Reports, white papers and the AI series, each with the date its comment period closes, from the Computer Security Resource Center’s own feed. Keyless, public domain. A draft whose period has ended is marked closed in place.',
  docs: PAGE_URL,
  kinds: ['draft'],
  cadenceMinutes: 180,
  defaultSources: [
    {
      slug: 'nist-csrc-drafts',
      name: 'NIST CSRC: draft publications open for comment',
      description:
        'Every NIST security and privacy draft whose public comment period is open, with the closing date, read from CSRC every three hours; a draft whose period ends is marked closed rather than dropped.',
    },
  ],
  async pull({ cursor, http, previous, log, deadline }) {
    const text = await http.text(FEED, {
      headers: { accept: 'application/json, */*' },
      timeoutMs: 30_000,
    });
    const { entries } = parseDrafts(text);
    const items = entries.map((e) => toItem(e, 'open')).filter(Boolean);
    const ids = items.map((it) => it.externalId);
    const gone = (Array.isArray(cursor?.ids) ? cursor.ids : []).filter((id) => !ids.includes(id));
    let closed = 0;
    if (gone.length > 0 && Date.now() < deadline && typeof previous === 'function') {
      const prev = await previous(gone);
      for (const id of gone) {
        const data = prev?.get?.(id);
        if (!data?.entry) continue;
        const it = toItem({ ...data.entry, id }, 'closed');
        if (it) {
          items.push(it);
          closed += 1;
        }
      }
    }
    log(
      `${ids.length} drafts open for comment${closed ? `, ${closed} closed since last run` : ''}`,
    );
    return {
      items,
      cursor: { ids },
      note: `${ids.length} drafts open${closed ? `, ${closed} closed` : ''}`,
    };
  },
});
