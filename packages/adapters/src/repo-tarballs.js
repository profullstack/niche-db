import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { defineAdapter } from '@nichedb/core/adapter';
import { dumpDir, tarGzEntries } from '@nichedb/core/dump';
import { idTag } from './osv.js';

/**
 * Two vulnerability datasets kept as one JSON file per CVE in a GitHub
 * repository, read as the repository's tarball from codeload.github.com: one
 * download, no GitHub API calls (the deployment has no token, and a per-file
 * walk of 200,000 files would be 200,000 requests). The archive is streamed
 * through @nichedb/core/dump's tarGzEntries and never unpacked; every run reads
 * it whole and an unchanged row costs no write (the item's content hash).
 *
 * - CISA Vulnrichment (cisagov/vulnrichment, CC0-1.0): CISA's own assessment
 *   of each CVE as the CISA ADP container of the CVE record, chiefly SSVC:
 *   Exploitation none|poc|active, Automatable yes|no, Technical Impact
 *   partial|total, dated. 200,000 CVEs. This is the CISA slice of the CVE List
 *   (CVEProject/cvelistV5); the CNA slice the NVD source already mirrors.
 * - PoC-in-GitHub (nomi-sec/PoC-in-GitHub, CC0-1.0): for each CVE, the GitHub
 *   repositories that claim to hold a proof of concept. UNVETTED: fake PoC
 *   repositories that carry malware are a known lure, so a row lists them as
 *   claims (`vetted: false`) and does not, on its own, make a vulnerability
 *   "exploit public" in the OpenVuln merge.
 */
const BATCH = 500;

async function fetchTarball(http, url, name, log) {
  const dir = await dumpDir(name);
  const path = join(dir, 'repo.tar.gz');
  await rm(path, { force: true });
  const dl = await http.download(url, path, { timeoutMs: 20 * 60_000 });
  log(`${name}: ${(dl.bytes / 1e6).toFixed(1)} MB`);
  return path;
}

async function* batches(path, filter, toItem, log, deadline) {
  let batch = [];
  let read = 0;
  let kept = 0;
  let bad = 0;
  for await (const e of tarGzEntries(path, { filter })) {
    read += 1;
    let doc;
    try {
      doc = JSON.parse(e.body.toString('utf8'));
    } catch {
      bad += 1;
      continue;
    }
    const item = toItem(doc, e.name);
    if (item) {
      batch.push(item);
      kept += 1;
    }
    if (batch.length >= BATCH) {
      yield { items: batch };
      batch = [];
      if (Date.now() > deadline) {
        log(`stopped at the deadline after ${read} files`);
        return { read, kept, bad, partial: true };
      }
    }
  }
  if (batch.length) yield { items: batch };
  return { read, kept, bad, partial: false };
}

/* ------------------------------------------------------- CISA Vulnrichment -- */

export const VULNRICHMENT_TGZ =
  'https://codeload.github.com/cisagov/vulnrichment/tar.gz/refs/heads/develop';

const SSVC_STATUS = { active: 'exploited', poc: 'poc-public', none: 'none-known' };

/** CISA's ADP container of a CVE record: SSVC, its KEV note, and any CVSS/CWE it added. */
export function vulnrichmentItem(rec) {
  const cve = String(rec?.cveMetadata?.cveId ?? '').toUpperCase();
  if (!/^CVE-\d{4}-\d{4,}$/.test(cve)) return null;
  const adp = (rec.containers?.adp ?? []).find((a) =>
    /CISA-ADP/i.test(a?.providerMetadata?.shortName ?? ''),
  );
  if (!adp) return null;
  let ssvc = null;
  let kev = null;
  let cvss = null;
  for (const m of adp.metrics ?? []) {
    if (m?.other?.type === 'ssvc') {
      const opts = Object.assign({}, ...(m.other.content?.options ?? []));
      ssvc = {
        exploitation: String(opts.Exploitation ?? '').toLowerCase() || null,
        automatable: String(opts.Automatable ?? '').toLowerCase() || null,
        technicalImpact: String(opts['Technical Impact'] ?? '').toLowerCase() || null,
        timestamp: m.other.content?.timestamp ?? null,
        version: m.other.content?.version ?? null,
      };
    } else if (m?.other?.type === 'kev') {
      kev = { added: m.other.content?.dateAdded ?? null };
    } else {
      const c = m?.cvssV3_1 ?? m?.cvssV3_0 ?? m?.cvssV4_0 ?? null;
      if (c?.vectorString)
        cvss = {
          score: c.baseScore ?? null,
          severity: String(c.baseSeverity ?? '').toLowerCase() || null,
          vector: c.vectorString,
        };
    }
  }
  if (!ssvc) return null;
  const cwes = (adp.problemTypes ?? [])
    .flatMap((p) => p.descriptions ?? [])
    .map((d) => d.cweId)
    .filter((c) => /^CWE-\d+$/i.test(String(c ?? '')));
  const title = rec.containers?.cna?.title ?? '';
  return {
    externalId: cve,
    kind: 'ssvc',
    title:
      `${cve}: CISA SSVC exploitation ${ssvc.exploitation ?? 'unstated'}${title ? `, ${title}` : ''}`.slice(
        0,
        300,
      ),
    summary: null,
    url: `https://www.cve.org/CVERecord?id=${cve}`,
    publishedAt: ssvc.timestamp ?? rec.cveMetadata?.datePublished ?? null,
    tags: [
      'vulnrichment',
      idTag(cve),
      ssvc.exploitation ? `ssvc-exploitation:${ssvc.exploitation}` : null,
      ssvc.automatable ? `ssvc-automatable:${ssvc.automatable}` : null,
      ssvc.technicalImpact ? `ssvc-impact:${ssvc.technicalImpact}` : null,
      kev ? 'kev' : null,
    ].filter(Boolean),
    data: {
      cve,
      ssvc,
      status: SSVC_STATUS[ssvc.exploitation] ?? null,
      kev,
      cvss,
      cwes,
      license: 'CC0-1.0',
    },
  };
}

export const vulnrichment = defineAdapter({
  name: 'vulnrichment',
  title: 'CISA Vulnrichment: SSVC for every CVE CISA assessed',
  collection: 'vulns',
  description:
    "CISA's own reading of each CVE it assessed (200,000 of them), as it adds them to the CVE List: SSVC Exploitation (none, proof of concept public, or active), whether exploitation is automatable, and the technical impact, plus the CVSS and CWE CISA added where the CNA gave none. From the cisagov/vulnrichment repository (CC0), read daily as one tarball.",
  docs: 'https://github.com/cisagov/vulnrichment',
  kinds: ['ssvc'],
  cadenceMinutes: 24 * 60,
  budgetMs: 30 * 60_000,
  defaultSources: [
    {
      slug: 'cisa-vulnrichment',
      name: 'CISA Vulnrichment: SSVC exploitation, automatable, impact',
      description: "CISA's SSVC decision points for each CVE it assessed.",
    },
  ],
  async *pull({ http, log, deadline }) {
    const path = await fetchTarball(http, VULNRICHMENT_TGZ, 'vulnrichment', log);
    const r = yield* batches(
      path,
      (n) => /\/CVE-\d{4}-\d+\.json$/.test(n),
      (doc) => vulnrichmentItem(doc),
      log,
      deadline,
    );
    log(`${r.kept} CVEs with SSVC of ${r.read} files${r.bad ? `, ${r.bad} unreadable` : ''}`);
    return {
      note: `${r.kept} CVEs${r.partial ? ' (partial)' : ''}`,
      ...(r.partial ? { nextInMinutes: 30 } : {}),
    };
  },
});

/* ----------------------------------------------------------- PoC-in-GitHub -- */

export const POC_TGZ =
  'https://codeload.github.com/nomi-sec/PoC-in-GitHub/tar.gz/refs/heads/master';
const POC_KEEP = 10;

export function pocItem(repos, name) {
  const cve = (String(name).match(/CVE-\d{4}-\d{4,}/i)?.[0] ?? '').toUpperCase();
  if (!cve || !Array.isArray(repos) || repos.length === 0) return null;
  const list = repos
    .filter((r) => r?.html_url && !r.fork)
    .sort((a, b) => (b.stargazers_count ?? 0) - (a.stargazers_count ?? 0));
  if (list.length === 0) return null;
  const first =
    list
      .map((r) => r.created_at)
      .filter(Boolean)
      .sort()[0] ?? null;
  return {
    externalId: `poc:${cve}`,
    kind: 'poc-claim',
    title: `${cve}: ${list.length} GitHub ${list.length === 1 ? 'repository claims' : 'repositories claim'} a proof of concept`,
    summary:
      'Unvetted: repositories that call themselves a proof of concept for this CVE. Fake PoCs carrying malware are a known lure; read any code before running it, in isolation.',
    url: `https://github.com/nomi-sec/PoC-in-GitHub/blob/master/${String(name).split('/').slice(1).join('/')}`,
    publishedAt: first,
    tags: ['poc-in-github', idTag(cve)],
    data: {
      source: 'PoC-in-GitHub',
      cve,
      count: list.length,
      first,
      vetted: false,
      repos: list.slice(0, POC_KEEP).map((r) => ({
        url: r.html_url,
        name: r.full_name ?? null,
        stars: r.stargazers_count ?? 0,
        created: r.created_at ?? null,
        description: String(r.description ?? '').slice(0, 200) || null,
      })),
      license: 'CC0-1.0',
    },
  };
}

export const pocInGithub = defineAdapter({
  name: 'poc-in-github',
  title: 'PoC-in-GitHub: proof-of-concept repositories by CVE (unvetted)',
  collection: 'vulns',
  description:
    'For each CVE, the GitHub repositories that claim to hold a proof of concept, as nomi-sec/PoC-in-GitHub (CC0) collects them, with stars and dates: 11,500 CVEs, read daily as one tarball. Unvetted by design: fake PoC repositories carrying malware are a known lure, so these are listed as claims and never counted as a public exploit on their own.',
  docs: 'https://github.com/nomi-sec/PoC-in-GitHub',
  kinds: ['poc-claim'],
  cadenceMinutes: 24 * 60,
  defaultSources: [
    {
      slug: 'poc-in-github',
      name: 'PoC-in-GitHub: claimed proof-of-concept repositories',
      description: 'GitHub repositories claiming a proof of concept for each CVE. Unvetted.',
    },
  ],
  async *pull({ http, log, deadline }) {
    const path = await fetchTarball(http, POC_TGZ, 'poc-in-github', log);
    const r = yield* batches(
      path,
      (n) => /\/CVE-\d{4}-\d+\.json$/i.test(n),
      (doc, name) => pocItem(doc, name),
      log,
      deadline,
    );
    log(`${r.kept} CVEs with PoC claims of ${r.read} files`);
    return {
      note: `${r.kept} CVEs${r.partial ? ' (partial)' : ''}`,
      ...(r.partial ? { nextInMinutes: 30 } : {}),
    };
  },
});
