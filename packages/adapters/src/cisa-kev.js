import { defineAdapter, slugify } from '@nichedb/core/adapter';
import { idTag } from './osv.js';

/**
 * CISA's Known Exploited Vulnerabilities catalog: the CVEs the US
 * Cybersecurity and Infrastructure Security Agency has evidence of being
 * exploited, each with the date it was added, the date federal agencies must
 * act by, and whether it is known to be used in ransomware campaigns.
 *
 * One JSON file, about 1,800 entries and 2 MB, keyless and public domain.
 * `catalogVersion` changes when the file does, so a run that finds the same
 * version writes nothing. A CVE leaves the catalog only by correction; a row
 * that vanished is kept, as history, and is no longer refreshed.
 *
 * The NVD copies `cisaExploitAdd` onto its own CVE rows, but only once NIST
 * has touched the CVE again; the catalog says it the day CISA does, and it
 * alone carries `knownRansomwareCampaignUse`.
 */
export const FEED =
  'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';

export function toItem(v) {
  const cve = String(v?.cveID ?? '').toUpperCase();
  if (!/^CVE-\d{4}-\d+$/.test(cve)) return null;
  const ransomware = String(v.knownRansomwareCampaignUse ?? '').toLowerCase() === 'known';
  const cwes = (Array.isArray(v.cwes) ? v.cwes : []).filter((c) => /^CWE-\d+$/i.test(c));
  return {
    externalId: cve,
    kind: 'kev',
    title: `${cve}: ${v.vulnerabilityName || `${v.vendorProject ?? ''} ${v.product ?? ''}`.trim()}`,
    summary: v.shortDescription ? String(v.shortDescription) : null,
    url: `https://www.cisa.gov/known-exploited-vulnerabilities-catalog?search_api_fulltext=${cve}`,
    publishedAt: v.dateAdded ? `${v.dateAdded}T00:00:00Z` : null,
    precision: 'day',
    tags: [
      'kev',
      idTag(cve),
      v.vendorProject ? `vendor:${slugify(v.vendorProject)}` : null,
      v.product ? `product:${slugify(v.product)}` : null,
      ransomware ? 'ransomware' : null,
      ...cwes.map((c) => `cwe:${c.toLowerCase()}`),
    ].filter(Boolean),
    data: {
      cve,
      vendor: v.vendorProject ?? null,
      product: v.product ?? null,
      name: v.vulnerabilityName ?? null,
      added: v.dateAdded ?? null,
      due: v.dueDate ?? null,
      action: v.requiredAction ?? null,
      ransomware: ransomware
        ? 'known'
        : String(v.knownRansomwareCampaignUse ?? '').toLowerCase() || null,
      notes: v.notes ?? null,
      cwes,
    },
  };
}

export const cisaKev = defineAdapter({
  name: 'cisa-kev',
  title: 'CISA Known Exploited Vulnerabilities',
  collection: 'vulns',
  description:
    "Every CVE in CISA's Known Exploited Vulnerabilities catalog: exploited in the wild on CISA's evidence, with the date it was added, the date federal agencies must patch by, the required action, and whether ransomware crews are known to use it. One public-domain JSON file, read every six hours, written only when its version changes.",
  docs: 'https://www.cisa.gov/known-exploited-vulnerabilities-catalog',
  kinds: ['kev'],
  cadenceMinutes: 360,
  defaultSources: [
    {
      slug: 'cisa-kev',
      name: 'CISA KEV: vulnerabilities exploited in the wild',
      description:
        "CISA's Known Exploited Vulnerabilities catalog, entry by entry, with due dates and known ransomware use.",
    },
  ],
  async pull({ cursor, http, log }) {
    const doc = await http.json(FEED, { timeoutMs: 120_000 });
    const version = doc?.catalogVersion ?? null;
    if (version && cursor?.version === version) {
      return { items: [], cursor, note: `catalog ${version} unchanged` };
    }
    const items = (Array.isArray(doc?.vulnerabilities) ? doc.vulnerabilities : [])
      .map(toItem)
      .filter(Boolean);
    log(`catalog ${version}: ${items.length} entries`);
    return { items, cursor: { version }, note: `catalog ${version}, ${items.length} entries` };
  },
});
