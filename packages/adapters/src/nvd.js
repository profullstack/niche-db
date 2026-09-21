import { defineAdapter, slugify } from '@nichedb/core/adapter';

/**
 * NVD: every CVE as the National Vulnerability Database describes it, and
 * every revision, read from the CVE API 2.0 by lastModified.
 *
 * The NVD is NIST's catalogue of published vulnerabilities: the CVE id, the
 * description its CNA wrote, the CVSS score NIST or the CNA assigned, the
 * weakness (CWE), the products affected, and, when CISA adds the CVE to its
 * Known Exploited Vulnerabilities catalogue, the date it did and the date
 * federal agencies must act by. Roughly a hundred and fifty new CVEs a day,
 * and many more revisions: a CVE arrives "Awaiting Analysis" with no score
 * and is scored days later, so a row here is updated in place and the feed
 * is the catalogue, not a log of changes.
 *
 * WINDOWS
 *
 * The API is asked for what changed between two instants. It caps a window
 * at 120 days and pages 2,000 rows at a time, and without a key allows five
 * requests per rolling thirty seconds (fifty with one), so a run reads at most
 * two days of changes, pages through them with the spacing NIST asks for, and
 * moves the cursor to the END of the window only when the whole window was
 * read. A source that has fallen behind catches up two days at a time, a
 * minute apart, rather than in one run that a deadline would cut in half. A
 * cursor older than 120 days is clamped and the gap is logged; nothing is
 * lost forever, because a CVE that is revised again is read then.
 *
 * NVD timestamps carry no offset and are UTC; JavaScript would read them as
 * local time, so a Z is appended before parsing.
 *
 * ATTRIBUTION
 *
 * NIST asks that a product using the API say so. The line is on every row's
 * data and in this adapter's description: "This product uses the NVD API but
 * is not endorsed or certified by the NVD."
 */
export const API = 'https://services.nvd.nist.gov/rest/json/cves/2.0';
export const ATTRIBUTION =
  'This product uses the NVD API but is not endorsed or certified by the NVD.';
export const PAGE = 2000;
export const MAX_WINDOW_DAYS = 120;
/** One run reads at most this much of the timeline; a source behind catches up a minute later. */
export const CHUNK_DAYS = 2;
const FIRST_RUN_DAYS = 7;
const OVERLAP_MS = 5 * 60_000;
const DAY_MS = 86_400_000;
/** NIST's own recommendation: six seconds between keyless requests, under a second with a key. */
export const SPACING_MS = { keyless: 6_500, keyed: 800 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** NVD timestamps have no offset and are UTC. */
export function nvdDate(s) {
  if (!s) return null;
  const str = String(s);
  const d = new Date(/[zZ]$|[+-]\d\d:?\d\d$/.test(str) ? str : `${str}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The API wants yyyy-MM-ddTHH:mm:ss.SSS with an explicit offset. */
export function nvdParam(d) {
  return `${d.toISOString().slice(0, -1)}+00:00`;
}

/**
 * The window this run reads: from the cursor (with a few minutes of overlap,
 * since the API's lastModified filter is inclusive and clocks drift) to at
 * most CHUNK_DAYS later, never past now and never wider than the API allows.
 */
export function windowFor(cursor, now = new Date()) {
  let start = cursor?.lastMod
    ? new Date(new Date(cursor.lastMod).getTime() - OVERLAP_MS)
    : new Date(now.getTime() - FIRST_RUN_DAYS * DAY_MS);
  let clamped = false;
  const floor = new Date(now.getTime() - MAX_WINDOW_DAYS * DAY_MS);
  if (Number.isNaN(start.getTime()) || start < floor) {
    start = floor;
    clamped = true;
  }
  const end = new Date(Math.min(now.getTime(), start.getTime() + CHUNK_DAYS * DAY_MS));
  return { start, end, clamped, more: end < now };
}

const ORDER = ['cvssMetricV40', 'cvssMetricV31', 'cvssMetricV30', 'cvssMetricV2'];

/**
 * The score to show: the newest CVSS version present, NIST's own (Primary)
 * assessment before a CNA's (Secondary). CVSS v2 keeps its severity on the
 * metric rather than inside cvssData, which is why both are read.
 */
export function cvssOf(metrics) {
  for (const key of ORDER) {
    const list = Array.isArray(metrics?.[key]) ? metrics[key] : [];
    if (list.length === 0) continue;
    const m = list.find((x) => x.type === 'Primary') ?? list[0];
    const d = m.cvssData ?? {};
    const severity = String(d.baseSeverity ?? m.baseSeverity ?? '').toLowerCase() || null;
    return {
      version: d.version ?? null,
      score: typeof d.baseScore === 'number' ? d.baseScore : null,
      severity,
      vector: d.vectorString ?? null,
      source: m.source ?? null,
      type: m.type ?? null,
    };
  }
  return null;
}

/** CWE ids named by any weakness entry; NVD's own "noinfo"/"Other" placeholders are not weaknesses. */
export function cwesOf(weaknesses) {
  const out = new Set();
  for (const w of Array.isArray(weaknesses) ? weaknesses : []) {
    for (const d of w.description ?? []) {
      const v = String(d.value ?? '').trim();
      if (/^CWE-\d+$/i.test(v)) out.add(v.toUpperCase());
    }
  }
  return [...out].slice(0, 8);
}

/**
 * Vendors and products, from the `affected` block a CNA supplies and from the
 * CPE match criteria NVD writes when it analyses the CVE (part 3 and 4 of
 * `cpe:2.3:a:vendor:product:...`). Either may be present alone.
 */
export function affectedOf(cve) {
  const vendors = new Set();
  const products = new Set();
  for (const a of Array.isArray(cve?.affected) ? cve.affected : []) {
    if (a?.vendor) vendors.add(slugify(String(a.vendor)));
    if (a?.product) products.add(slugify(String(a.product)));
  }
  for (const c of Array.isArray(cve?.configurations) ? cve.configurations : []) {
    for (const n of c.nodes ?? []) {
      for (const m of n.cpeMatch ?? []) {
        const parts = String(m.criteria ?? '').split(':');
        if (parts[0] !== 'cpe' || parts.length < 5) continue;
        if (parts[3] && parts[3] !== '*') vendors.add(slugify(parts[3]));
        if (parts[4] && parts[4] !== '*') products.add(slugify(parts[4]));
      }
    }
  }
  return {
    vendors: [...vendors].filter(Boolean).slice(0, 10),
    products: [...products].filter(Boolean).slice(0, 10),
  };
}

/** The first sentence of a description, short enough for a title. */
export function gistOf(text) {
  const s = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return '';
  const m = s.match(/^(.{20,}?[.!?])(\s|$)/);
  const first = m ? m[1] : s;
  return first.length > 140 ? `${first.slice(0, 137).trimEnd()}...` : first;
}

export function toItem(v) {
  const cve = v?.cve;
  if (!cve?.id) return null;
  const descriptions = Array.isArray(cve.descriptions) ? cve.descriptions : [];
  const desc = String(
    descriptions.find((d) => d.lang === 'en')?.value ?? descriptions[0]?.value ?? '',
  ).trim();
  const cvss = cvssOf(cve.metrics);
  const cwes = cwesOf(cve.weaknesses);
  const { vendors, products } = affectedOf(cve);
  const kev = cve.cisaExploitAdd
    ? {
        added: cve.cisaExploitAdd,
        due: cve.cisaActionDue ?? null,
        name: cve.cisaVulnerabilityName ?? null,
        action: cve.cisaRequiredAction ?? null,
      }
    : null;
  const status = cve.vulnStatus ? slugify(String(cve.vulnStatus)) : null;
  return {
    externalId: cve.id,
    kind: 'cve',
    title: `${cve.id}: ${gistOf(desc) || 'no description yet'}`,
    summary: desc.slice(0, 2000) || null,
    url: `https://nvd.nist.gov/vuln/detail/${cve.id}`,
    publishedAt: nvdDate(cve.published),
    tags: [
      'nvd',
      'cve',
      cvss?.severity ? `severity:${cvss.severity}` : null,
      status ? `status:${status}` : null,
      kev ? 'kev' : null,
      ...cwes.map((c) => `cwe:${c.toLowerCase()}`),
      ...vendors.slice(0, 6).map((x) => `vendor:${x}`),
    ].filter(Boolean),
    data: {
      id: cve.id,
      status: cve.vulnStatus ?? null,
      published: cve.published ?? null,
      lastModified: cve.lastModified ?? null,
      source: cve.sourceIdentifier ?? null,
      cvss,
      cwes,
      kev,
      vendors,
      products,
      references: (Array.isArray(cve.references) ? cve.references : [])
        .map((r) => r?.url)
        .filter(Boolean)
        .slice(0, 20),
      attribution: ATTRIBUTION,
    },
  };
}

export function pageUrl({ start, end, startIndex }) {
  const p = new URLSearchParams({
    lastModStartDate: nvdParam(start),
    lastModEndDate: nvdParam(end),
    resultsPerPage: String(PAGE),
    startIndex: String(startIndex),
  });
  return `${API}?${p}`;
}

export const nvd = defineAdapter({
  name: 'nvd',
  title: 'NVD: CVEs',
  collection: 'threats',
  description:
    'Every CVE the National Vulnerability Database publishes and every revision to one: the description, the CVSS score and severity, the weakness, the vendors and products affected, and the date CISA added it to the Known Exploited Vulnerabilities catalogue when it did. Read every fifteen minutes by lastModified from the CVE API 2.0, keyless; set NVD_API_KEY for ten times the request rate. Rows update in place as a CVE is analysed. This product uses the NVD API but is not endorsed or certified by the NVD.',
  docs: 'https://nvd.nist.gov/developers/vulnerabilities',
  kinds: ['cve'],
  cadenceMinutes: 15,
  defaultSources: [
    {
      slug: 'nvd-cves',
      name: 'NVD: every CVE, as published and as revised',
      description:
        'The National Vulnerability Database, read by lastModified every fifteen minutes: new CVEs as they are published and existing ones as NIST scores them, with CVSS, CWE, affected products and CISA KEV dates. This product uses the NVD API but is not endorsed or certified by the NVD.',
    },
  ],
  async pull({ cursor, env, http, log, deadline }) {
    const key = env?.nvdApiKey;
    const spacing = key ? SPACING_MS.keyed : SPACING_MS.keyless;
    const { start, end, clamped, more } = windowFor(cursor);
    if (clamped)
      log(`cursor older than ${MAX_WINDOW_DAYS} days; reading from ${start.toISOString()}`);

    const items = [];
    let startIndex = 0;
    let total = null;
    let pages = 0;
    let failed = null;
    while (total === null || startIndex < total) {
      if (Date.now() > deadline) {
        failed = 'deadline';
        break;
      }
      if (pages > 0) await sleep(spacing);
      let page;
      try {
        page = await http.json(pageUrl({ start, end, startIndex }), {
          headers: key ? { apiKey: key } : {},
          timeoutMs: 60_000,
        });
      } catch (err) {
        failed = err.message.slice(0, 80);
        break;
      }
      pages += 1;
      total = Number(page?.totalResults ?? 0);
      const got = (Array.isArray(page?.vulnerabilities) ? page.vulnerabilities : [])
        .map(toItem)
        .filter(Boolean);
      items.push(...got);
      startIndex += Number(page?.resultsPerPage) || got.length || PAGE;
      if (got.length === 0) break;
    }

    const done = failed === null;
    const window = `${start.toISOString().slice(0, 16)}Z..${end.toISOString().slice(0, 16)}Z`;
    log(
      `${items.length} CVEs in ${pages} page${pages === 1 ? '' : 's'} for ${window}${done ? '' : `; stopped: ${failed}`}`,
    );
    /*
     * The cursor moves only when the window was read whole. A partial read
     * keeps the old cursor so the same window is read again next time: the
     * API does not order a page by lastModified, so advancing to the newest
     * row seen would skip the rows on the pages not reached. Reading is
     * idempotent, so the cost of a retry is a few requests.
     */
    return {
      items,
      cursor: done ? { lastMod: end.toISOString() } : (cursor ?? {}),
      note: `${items.length} CVEs, ${window}${done ? '' : ` (partial: ${failed}; window re-read next run)`}${done && more ? '; catching up' : ''}`,
      ...(done && more ? { nextInMinutes: 1 } : !done ? { nextInMinutes: 5 } : {}),
    };
  },
});
