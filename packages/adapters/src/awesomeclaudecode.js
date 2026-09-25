import { defineAdapter, slugify } from '@nichedb/core/adapter';
import { repoSlug, repoUrl } from './catalogs.js';

/**
 * awesome-claude-code, read from its table rather than its README.
 *
 * The list is generated from `THE_RESOURCES_TABLE_NEW.csv`, which is the same
 * 212 entries the README renders plus three columns the README throws away:
 * `Active`, `Stale` and `Last Checked`. The maintainer re-checks links and
 * marks what has died, so this is the rare curated list that says which of its
 * own entries no longer work — and an entry marked dead is simply not
 * ingested. Parsing the CSV instead of the rendered markdown is what makes
 * that possible, and it costs one request.
 *
 * `Date Added` is written `2026-06-29:21-22-44`, which is not a format any
 * date parser knows, so `tableDate` converts it rather than letting
 * `new Date()` quietly produce Invalid Date on 171 of 212 rows.
 */

const CSV =
  'https://raw.githubusercontent.com/hesreallyhim/awesome-claude-code/main/THE_RESOURCES_TABLE_NEW.csv';

/**
 * RFC 4180 enough for this file: quoted fields, doubled quotes inside them,
 * and commas and newlines that only mean anything outside quotes.
 *
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  const s = String(text ?? '').replace(/\r\n?/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** Rows as objects, keyed by the header line. */
export function parseTable(text) {
  const [header, ...rest] = parseCsv(text);
  if (!header) return [];
  return rest.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i] ?? ''])));
}

/** `2026-06-29:21-22-44` -> an ISO instant. */
export function tableDate(raw) {
  const m = /^(\d{4}-\d{2}-\d{2}):(\d{2})-(\d{2})-(\d{2})$/.exec(String(raw ?? '').trim());
  if (m) return `${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`;
  const plain = /^\d{4}-\d{2}-\d{2}$/.exec(String(raw ?? '').trim());
  return plain ? `${plain[0]}T12:00:00Z` : null;
}

/** The categories whose entries are a kind of their own. */
const KINDS = new Map([
  ['skills', 'skill'],
  ['status lines', 'statusline'],
  ['configuration', 'config'],
  ['alternative clients', 'client'],
]);

export function toItem(r) {
  const id = String(r.ID ?? '').trim();
  const name = String(r['Display Name'] ?? '').trim();
  const url = repoUrl(r.Link);
  if (!id || !name || !url) return null;
  // The maintainer checks links and marks the dead ones. Believe them.
  if (String(r.Active ?? '').toUpperCase() === 'FALSE') return null;

  const category = String(r.Category ?? '').trim();
  const sub = String(r['Sub-Category'] ?? '').trim();
  const stale = String(r.Stale ?? '').toUpperCase() === 'TRUE';

  return {
    externalId: `acc:${id}`,
    kind: KINDS.get(category.toLowerCase()) ?? 'workflow',
    title: name.slice(0, 200),
    summary:
      String(r.Description ?? '')
        .replace(/\s+/g, ' ')
        .trim() || null,
    url,
    publishedAt: tableDate(r['Date Added']),
    tags: [
      'workflow',
      'claude-code',
      'awesome-claude-code',
      stale ? 'stale' : null,
      slugify(category),
      sub ? slugify(sub) : null,
      repoSlug(url) ? 'github' : 'web',
    ].filter(Boolean),
    data: {
      id,
      category: category || null,
      subCategory: sub || null,
      author: String(r['Author Name'] ?? '').trim() || null,
      authorUrl: String(r['Author Link'] ?? '').trim() || null,
      repo: repoSlug(url),
      stale,
      dateAdded: tableDate(r['Date Added']),
      lastChecked: tableDate(r['Last Checked']),
      list: 'awesome-claude-code',
    },
  };
}

export const awesomeClaudeCode = defineAdapter({
  name: 'awesome-claude-code',
  title: 'awesome-claude-code',
  collection: 'workflows',
  description:
    'The awesome-claude-code list, read from the CSV it is generated from: slash commands, CLAUDE.md files, hooks, status lines, skills, orchestration and the official guides, with the author of each. The list marks entries whose links have died and those are skipped.',
  docs: 'https://github.com/hesreallyhim/awesome-claude-code',
  kinds: ['workflow', 'skill', 'statusline', 'config', 'client'],
  cadenceMinutes: 60 * 6,
  configFields: [{ key: 'url', label: 'Table URL', placeholder: CSV }],
  defaults: { url: CSV },
  defaultSources: [{ slug: 'awesome-claude-code', name: 'awesome-claude-code' }],
  async pull({ config, http, log }) {
    const text = await http.text(String(config.url || CSV), {
      headers: { accept: 'text/csv, text/plain, */*' },
    });
    const rows = parseTable(text);
    if (!rows.length) throw new Error('the resources table parsed to nothing');

    const items = rows.map(toItem).filter(Boolean);
    log(`${items.length} live entries of ${rows.length}`);
    return { items, note: `${items.length} entr(ies) of ${rows.length}` };
  },
});
