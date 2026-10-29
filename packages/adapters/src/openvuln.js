import { defineAdapter } from '@nichedb/core/adapter';
import house from './openvuln-house.json';
import { idTag } from './osv.js';

/**
 * OpenVuln publishers: records a researcher, vendor or scanner serves at
 * `/.well-known/openvuln.json` (logicsrc, docs/openvuln.md), plus the records
 * nichedb.dev writes itself, bundled with the code (openvuln-house.json) and
 * served back out at our own well-known path.
 *
 * An OpenVuln record is an OSV record with a `database_specific.openvuln`
 * block, so this reader keeps the whole record and tags it the way the OSV
 * adapter does (`id:<id>` for the id and every alias) so the /c/vulns deep
 * dive finds it next to the OSV, KEV and ExploitGym rows for the same
 * vulnerability. `related` ids are tagged `related:<id>`: a campaign record
 * then shows on the page of each malicious package it ties together.
 *
 * ORIGIN IS THE PROOF, as in OpenThreat: an index is believed only when it was
 * fetched from the host its `publisher.web` names, and a record listed by URL
 * only when that URL is on the same host.
 */
export const WELL_KNOWN = '/.well-known/openvuln.json';
export const HOUSE = house;

const hostOf = (url) => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
};

export function indexUrl(entry) {
  const raw = String(entry ?? '').trim();
  if (!raw) return null;
  try {
    const u = new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`);
    return u.pathname === '/' || u.pathname === '' ? `${u.origin}${WELL_KNOWN}` : u.toString();
  } catch {
    return null;
  }
}

export const sameHost = (a, b) => {
  const x = hostOf(a);
  const y = hostOf(b);
  return Boolean(x && y && (x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`)));
};

export function toItem(record, publisher) {
  const ov = record?.database_specific?.openvuln;
  if (!record?.id || !record.summary) return null;
  const host = hostOf(publisher?.web) ?? 'unknown';
  const ids = [record.id, ...(record.aliases ?? [])];
  return {
    externalId: `${host}:${record.id}`,
    kind: 'openvuln',
    title: `${record.id}: ${record.summary}`.slice(0, 300),
    summary: String(record.details ?? record.summary).slice(0, 2000),
    url: ov?.deep_dive?.url ?? `https://${host}${WELL_KNOWN}`,
    publishedAt: record.published ?? record.modified ?? null,
    tags: [
      'openvuln',
      `publisher:${host}`,
      ...[...new Set(ids)].slice(0, 12).map(idTag),
      ...(record.related ?? []).slice(0, 12).map((r) => `related:${String(r).toLowerCase()}`),
      ...(ov?.class ?? []).slice(0, 6).map((c) => `class:${String(c).toLowerCase()}`),
      ov?.subject?.kind ? `subject:${ov.subject.kind}` : null,
      ov?.label ? `severity:${ov.label}` : null,
      ov?.exploitation?.status ? `exploitation:${ov.exploitation.status}` : null,
      ov?.fix?.status ? `fix:${ov.fix.status}` : null,
    ].filter(Boolean),
    data: { record, publisher: publisher ?? null },
  };
}

/** Records from an index: inline records, or `{ id, url }` entries fetched from the same host. */
export async function readIndex(doc, fetchedFrom, http, { limit = 500 } = {}) {
  const publisher = doc?.publisher;
  if (!publisher?.name) return { items: [], rejected: 'no publisher' };
  if (publisher.web ? !sameHost(fetchedFrom, publisher.web) : !fetchedFrom.endsWith(WELL_KNOWN))
    return { items: [], rejected: 'origin' };
  const items = [];
  for (const entry of (Array.isArray(doc.records) ? doc.records : []).slice(0, limit)) {
    let record = entry;
    if (!entry?.summary && entry?.url) {
      if (!sameHost(entry.url, fetchedFrom)) continue;
      try {
        record = await http.json(entry.url, { timeoutMs: 20_000 });
      } catch {
        continue;
      }
    }
    const item = toItem(record, publisher);
    if (item) items.push(item);
  }
  return { items };
}

export const openvuln = defineAdapter({
  name: 'openvuln',
  title: 'OpenVuln publishers',
  collection: 'vulns',
  description:
    "Vulnerability records in the OpenVuln format (an OSV record plus subject, fix, exploitation and per-fact sources), read from each publisher's own /.well-known/openvuln.json and believed only from the origin the publisher names. Includes the records nichedb.dev writes itself: campaigns and agent vulnerabilities the package databases cannot hold, each with a deep dive.",
  docs: 'https://logicsrc.com/docs/openvuln',
  kinds: ['openvuln'],
  cadenceMinutes: 60,
  configFields: [
    { key: 'urls', label: 'Publisher origins or index URLs', type: 'list' },
    {
      key: 'house',
      label: "Include nichedb.dev's own records",
      type: 'select',
      options: ['yes', 'no'],
    },
  ],
  defaultSources: [
    {
      slug: 'openvuln-house',
      name: 'nichedb.dev OpenVuln records',
      description:
        'The vulnerabilities nichedb.dev writes up itself: campaigns, agent and CI flaws, and benchmarks, each with a deep dive and every fact sourced.',
      config: { house: 'yes', urls: [] },
      refresh: true,
    },
  ],
  async pull({ config, http, log, deadline }) {
    const items = [];
    const notes = [];
    if (config.house !== 'no') {
      for (const r of HOUSE.records) {
        const item = toItem(r, HOUSE.publisher);
        if (item) items.push(item);
      }
      notes.push(`house ${HOUSE.records.length}`);
    }
    const urls = (Array.isArray(config.urls) ? config.urls : String(config.urls ?? '').split(','))
      .map(indexUrl)
      .filter(Boolean)
      .slice(0, 100);
    for (const url of urls) {
      if (Date.now() > deadline) break;
      try {
        const doc = await http.json(url, { timeoutMs: 20_000 });
        const { items: got, rejected } = await readIndex(doc, url, http);
        if (rejected) notes.push(`${hostOf(url)} rejected (${rejected})`);
        else {
          items.push(...got);
          notes.push(`${hostOf(url)} ${got.length}`);
        }
      } catch (err) {
        notes.push(`${hostOf(url) ?? url} failed (${err.message.slice(0, 40)})`);
      }
    }
    log(`${items.length} records: ${notes.join(', ')}`);
    return { items, note: `${items.length} records` };
  },
});
