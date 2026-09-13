import { defineEnricher } from './enricher.js';

/**
 * The listed company behind a hosting provider, from the SEC's own list.
 *
 * `company_tickers.json` is one public file of every SEC registrant with a
 * ticker -- ~10,400 rows, 800 KB -- so a provider is matched by name against
 * it in memory, and the file is read once a run rather than once a row. That
 * is what makes this cheap enough to run on a register of 185 hosts: DigitalOcean,
 * GoDaddy, Akamai, Cloudflare, Rackspace and Wix resolve; Vultr, Hetzner and
 * OVHcloud correctly do not (private, private, Euronext).
 *
 * The match is deliberately strict -- the registrant's title must begin with
 * the provider's whole name at a word boundary, and the name must be four
 * characters or more -- because a wrong ticker is worse than none. "Digital
 * Realty" must not answer for "Digital Ocean", and "Wix" must not answer for
 * a provider called "Wixel". Only US listings are here; a European listing
 * is a gap this enricher says nothing about rather than guesses at.
 */
const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
let cache = { at: 0, rows: [] };

const norm = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** What a registrant's title may carry after the company's own name and still be that company. */
const SUFFIX = new Set([
  'inc',
  'corp',
  'corporation',
  'co',
  'company',
  'holdings',
  'holding',
  'ltd',
  'limited',
  'llc',
  'plc',
  'group',
  'technologies',
  'technology',
  'com',
  'trust',
  'sa',
  'nv',
  'ag',
  'se',
  'the',
  'international',
  'systems',
  'networks',
  'cloud',
  'de',
  'and',
  'lp',
]);

/**
 * The registrant whose title is this name plus corporate suffixes, or null.
 * "DigitalOcean" finds "DigitalOcean Holdings, Inc."; "Digital" does not find
 * "Digital Realty Trust", because "realty" is a word of the name, not a suffix.
 * Exported for the test.
 */
export function matchCompany(name, rows) {
  const n = norm(name);
  if (n.length < 4) return null;
  const hits = rows.filter((r) => {
    const t = norm(r.title);
    if (t === n) return true;
    if (!t.startsWith(`${n} `)) return false;
    return t
      .slice(n.length + 1)
      .split(' ')
      .every((w) => SUFFIX.has(w));
  });
  if (hits.length === 0) return null;
  // Several rows are one company's share classes (DLR, DLR-PK …); the plain ticker wins.
  hits.sort((a, b) => a.ticker.length - b.ticker.length);
  return hits[0];
}

async function registrants(http) {
  if (Date.now() - cache.at < 6 * 60 * 60 * 1000 && cache.rows.length) return cache.rows;
  const doc = await http.json(TICKERS_URL, { timeoutMs: 30_000 });
  const rows = Object.values(doc ?? {}).filter((r) => r?.ticker && r?.title);
  if (rows.length) cache = { at: Date.now(), rows };
  return rows;
}

export const companyTicker = defineEnricher({
  name: 'company-ticker',
  title: 'Listed company',
  description:
    'The ticker and SEC CIK of the public company behind a provider, matched by name against the SEC’s registrant list. Says nothing for a private or non-US company.',
  collections: ['hosting'],
  appliesTo: (item) => item.kind === 'provider',
  perRun: 200,
  async enrich(item, { http }) {
    const rows = await registrants(http);
    const name = item.data?.name ?? item.title;
    const hit = matchCompany(name, rows);
    if (!hit) return null;
    const cik = String(hit.cik_str).padStart(10, '0');
    return {
      ticker: hit.ticker,
      cik,
      name: hit.title,
      edgar: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}`,
      tags: ['listed', hit.ticker.toLowerCase()],
    };
  },
});
