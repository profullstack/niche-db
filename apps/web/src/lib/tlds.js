import { config } from '@nichedb/config';
import { buildRows } from '@nichedb/core/tlds';
import * as store from '@nichedb/db/tlds';

/**
 * What the /tlds pages, the API and the MCP tools share: the catalogue, held
 * for a minute per process (it changes once a day), and the rule that turns
 * a query into the names an RDAP check asks about.
 */

const CATALOGUE_MS = 60_000;
let held = null;

export async function catalogueRows({ now = Date.now, read = store.catalogue } = {}) {
  if (held && now() - held.at < CATALOGUE_MS) return held.rows;
  const rows = buildRows(await read());
  held = { at: now(), rows };
  return rows;
}

export const forgetCatalogue = () => {
  held = null;
};

/** The endings tried when a bare word is checked with none named. */
export const DEFAULT_ENDINGS = ['com', 'net', 'org', 'io', 'dev', 'app', 'ai', 'co', 'xyz'];

/** Names to check: `name=foo.watches`, or `name=foo&tlds=com,dev`, or `names=a.com,b.dev`. */
export function namesFrom(query, { max = config.tlds.maxNamesPerCheck } = {}) {
  const raw = String(query.names ?? query.name ?? '').trim();
  if (!raw) return { names: [], label: '', truncated: false };
  const parts = raw.split(/[\s,]+/).filter(Boolean);
  const tlds = String(query.tlds ?? '')
    .split(/[\s,]+/)
    .map((t) => t.trim().toLowerCase().replace(/^\./, ''))
    .filter(Boolean);
  const names = [];
  for (const p of parts) {
    if (p.includes('.')) names.push(p);
    else for (const t of tlds.length ? tlds : DEFAULT_ENDINGS) names.push(`${p}.${t}`);
  }
  const unique = [...new Set(names)];
  return { names: unique.slice(0, max), label: raw, truncated: unique.length > max };
}
