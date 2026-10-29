/**
 * OpenVuln (logicsrc, docs/openvuln.md): one OSV-valid record per
 * vulnerability with what is affected, the fix, exploitation (CISA KEV, FIRST
 * EPSS, AI agent benchmarks) and the source of each fact.
 *
 * This module is the merge, and only the merge: the rows the vulns collection
 * holds for one vulnerability (OSV, KEV, ExploitGym, OpenVuln publishers), the
 * NVD's row for its CVE, and an EPSS reading go in; one record comes out. No
 * I/O, so the page, the API, the MCP tool and the tests share it.
 *
 * Absent is unstated, as the spec says: no fix is unknown, no exploitation
 * status is unstated, and `kev: null` is written only when the KEV catalog was
 * consulted for a CVE (the catalog is held whole, so a CVE not in it is not in
 * it).
 */
export const VERSION = '0.1';
export const OSV_SCHEMA = '1.6.0';

const RANK = { 'exploited-ransomware': 4, exploited: 3, 'poc-public': 2, 'none-known': 1 };
const CVE = /^CVE-\d{4}-\d{4,}$/i;

/** An id as a reader types it: trimmed, CVE upper-cased, everything else as given. */
export function normaliseId(raw) {
  const s = decodeURIComponent(String(raw ?? ''))
    .trim()
    .replace(/\.json$/i, '');
  if (!/^[A-Za-z][A-Za-z0-9._:-]{2,80}$/.test(s)) return null;
  return CVE.test(s) ? s.toUpperCase() : s;
}

export const keyOf = (id) => `id:${String(id).toLowerCase()}`;
export const isCve = (id) => CVE.test(String(id ?? ''));

/** The join keys the first rows carry that name the same vulnerability. */
export function secondHopKeys(rows) {
  const keys = new Set();
  for (const r of rows ?? []) {
    if (r.kind === 'openvuln' && !(r.tags ?? []).some((t) => t.startsWith('id:'))) continue;
    for (const t of r.tags ?? []) {
      if (/^(id|oss-fuzz|syzbot|crbug):/.test(t)) keys.add(t);
    }
  }
  // A campaign that relates to any alias is shown too.
  for (const k of [...keys]) if (k.startsWith('id:')) keys.add(`related:${k.slice(3)}`);
  return [...keys];
}

/** CVSS base score to the spec's label (rule 6). */
export function labelFromScore(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return null;
  if (n >= 9) return 'critical';
  if (n >= 7) return 'high';
  if (n >= 4) return 'medium';
  if (n > 0) return 'low';
  return 'none';
}

const iso = (d) => (d ? new Date(d).toISOString() : null);
const uniq = (xs) => [...new Set(xs.filter(Boolean))];

function source(name, fields, extra = {}) {
  return { name, fields, ...extra };
}

/**
 * @param {string} id  what the reader asked for
 * @param {{ rows?: object[], nvd?: object|null, epss?: object|null, live?: object|null, siteUrl?: string, now?: Date }} input
 */
export function buildRecord(
  id,
  {
    rows = [],
    nvd = null,
    epss = null,
    live = null,
    siteUrl = 'https://nichedb.dev',
    now = new Date(),
  } = {},
) {
  const key = String(id).toLowerCase();
  const has = (r, k) => (r.tags ?? []).includes(k);

  const houses = rows.filter((r) => r.kind === 'openvuln' && r.data?.record);
  const house =
    houses.find((r) => String(r.data.record.id).toLowerCase() === key) ??
    houses.find((r) => has(r, `id:${key}`)) ??
    null;
  // Any other publisher record here was found through its `related` list: a
  // campaign this vulnerability is part of.
  const campaigns = houses.filter((r) => r !== house && (r.data.record.related ?? []).length);

  const osvRows = rows.filter(
    (r) => (r.kind === 'vuln' || r.kind === 'malicious-package') && r.data?.osv,
  );
  const osvRecords = osvRows.map((r) => ({ row: r, rec: r.data.osv }));
  if (live?.id)
    osvRecords.push({
      row: {
        adapter: 'osv-live',
        url: `https://osv.dev/vulnerability/${live.id}`,
        updated_at: now,
      },
      rec: live,
    });
  const osv =
    osvRecords.find((o) => String(o.rec.id).toLowerCase() === key) ??
    osvRecords.find((o) => String(o.rec.id).startsWith('GHSA-')) ??
    osvRecords[0] ??
    null;

  const kevRow = rows.find((r) => r.kind === 'kev') ?? null;
  const aiRows = rows.filter((r) => r.kind === 'ai-exploit');
  const hr = house?.data?.record ?? null;
  const ov = hr?.database_specific?.openvuln ?? {};
  const base = hr ?? osv?.rec ?? null;

  const allIds = uniq([
    ...(hr ? [hr.id, ...(hr.aliases ?? [])] : []),
    ...osvRecords.flatMap((o) => [o.rec.id, ...(o.rec.aliases ?? []), ...(o.rec.upstream ?? [])]),
    kevRow?.external_id,
    nvd?.external_id,
    ...aiRows.flatMap((r) => r.data?.ids ?? []),
  ]);
  const recordId = base?.id ?? (isCve(id) ? id.toUpperCase() : id);
  const cves = uniq([recordId, ...allIds].filter(isCve).map((c) => c.toUpperCase()));
  if (!base && !nvd && !kevRow && aiRows.length === 0 && campaigns.length === 0) return null;

  const sources = [];
  const nvdData = nvd?.data ?? null;

  // Summary and details: the publisher's words first, then OSV's, then the NVD's.
  const summary =
    hr?.summary ??
    osv?.rec?.summary ??
    (nvd ? String(nvd.title ?? '').replace(/^CVE-[\d-]+:\s*/, '') : null) ??
    kevRow?.data?.name ??
    null;
  const details = hr?.details ?? osv?.rec?.details ?? nvd?.summary ?? kevRow?.summary ?? null;

  // Severity vectors: as given, else the NVD's primary metric.
  let severity = hr?.severity ?? osv?.rec?.severity ?? null;
  if (!severity?.length && nvdData?.cvss?.vector) {
    const v = String(nvdData.cvss.version ?? '');
    const type = v.startsWith('4') ? 'CVSS_V4' : v.startsWith('3') ? 'CVSS_V3' : 'CVSS_V2';
    severity = [{ type, score: nvdData.cvss.vector }];
  }

  let label = ov.label ?? null;
  let labelFrom = label ? (house?.source_name ?? 'publisher') : null;
  if (!label && osv?.row?.data?.label)
    [label, labelFrom] = [osv.row.data.label, 'GitHub (via OSV)'];
  if (!label && nvdData?.cvss?.severity) [label, labelFrom] = [nvdData.cvss.severity, 'NVD'];
  if (!label && nvdData?.cvss?.score != null)
    [label, labelFrom] = [labelFromScore(nvdData.cvss.score), 'nichedb.dev from NVD CVSS'];

  const fix = ov.fix ?? osv?.row?.data?.fix ?? null;

  const kev = kevRow
    ? {
        added: kevRow.data?.added ?? null,
        due: kevRow.data?.due ?? null,
        ransomware: kevRow.data?.ransomware === 'known',
        action: kevRow.data?.action ?? null,
      }
    : nvdData?.kev
      ? {
          added: nvdData.kev.added,
          due: nvdData.kev.due,
          ransomware: null,
          action: nvdData.kev.action,
        }
      : cves.length
        ? null
        : undefined;

  const ai = [
    ...(ov.exploitation?.ai ?? []),
    ...aiRows.map((r) => ({
      benchmark: r.data?.benchmark ?? 'ExploitGym',
      task: r.data?.task ?? r.external_id,
      url: r.url,
      result: r.data?.result ?? 'unstated',
    })),
  ];

  const statuses = [ov.exploitation?.status];
  if (kev?.ransomware) statuses.push('exploited-ransomware');
  else if (kev) statuses.push('exploited');
  for (const c of campaigns) {
    const s = c.data.record.database_specific?.openvuln?.exploitation?.status;
    if (s === 'exploited' && osv && String(osv.rec.id).startsWith('MAL-'))
      statuses.push('exploited');
  }
  const status = statuses.filter(Boolean).sort((a, b) => (RANK[b] ?? 0) - (RANK[a] ?? 0))[0];

  const subject =
    ov.subject ??
    (() => {
      const p = (base?.affected ?? []).find((a) => a?.package?.name)?.package;
      if (p) return { kind: 'package', name: p.name, ecosystem: p.ecosystem };
      if (kevRow?.data?.product)
        return { kind: 'product', name: kevRow.data.product, vendor: kevRow.data.vendor };
      return undefined;
    })();

  const klass = uniq([
    ...(ov.class ?? []),
    osv && String(osv.rec.id).startsWith('MAL-') ? 'malicious-package' : null,
  ]);

  const cwe = uniq([
    ...(base?.database_specific?.cwe_ids ?? []),
    ...(osv?.rec?.database_specific?.cwe_ids ?? []),
    ...(nvdData?.cwes ?? []),
    ...(kevRow?.data?.cwes ?? []),
  ]);

  // Sources: every row that contributed, with the fields it supplied.
  if (house)
    sources.push(
      ...(ov.sources ?? []),
      source(house.data.publisher?.name ?? 'publisher', ['summary', 'details', 'openvuln'], {
        url: house.url,
      }),
    );
  for (const o of osvRecords) {
    sources.push(
      source(
        o.row.adapter === 'osv-live' ? 'OSV (read live)' : 'OSV',
        o === osv && !hr ? ['affected', 'severity', 'aliases', 'details'] : ['aliases'],
        {
          id: o.rec.id,
          url: `https://osv.dev/vulnerability/${o.rec.id}`,
          retrieved: iso(o.row.updated_at),
        },
      ),
    );
  }
  if (nvd)
    sources.push(
      source('NVD', ['severity', 'label', 'database_specific.cwe_ids'], {
        id: nvd.external_id,
        url: nvd.url,
        retrieved: iso(nvd.updated_at),
        note: 'This product uses the NVD API but is not endorsed or certified by the NVD.',
      }),
    );
  if (kevRow)
    sources.push(
      source('CISA KEV', ['exploitation.kev', 'exploitation.status'], {
        id: kevRow.external_id,
        url: kevRow.url,
        retrieved: iso(kevRow.updated_at),
      }),
    );
  else if (cves.length)
    sources.push(
      source('CISA KEV', ['exploitation.kev'], {
        url: 'https://www.cisa.gov/known-exploited-vulnerabilities-catalog',
        note: 'checked: not in the catalog',
      }),
    );
  if (epss)
    sources.push(
      source('FIRST EPSS', ['exploitation.epss'], {
        id: epss.cve,
        url: `https://api.first.org/data/v1/epss?cve=${epss.cve}`,
        retrieved: iso(now),
      }),
    );
  for (const r of aiRows)
    sources.push(
      source('ExploitGym', ['exploitation.ai'], {
        id: r.external_id,
        url: r.url,
        retrieved: iso(r.updated_at),
      }),
    );
  if (labelFrom && !house) sources.push(source(labelFrom, ['label']));

  const references = [];
  const seen = new Set();
  for (const r of [
    ...(hr?.references ?? []),
    ...(osv?.rec?.references ?? []),
    ...(nvdData?.references ?? []).map((url) => ({ type: 'WEB', url })),
  ]) {
    if (!r?.url || seen.has(r.url)) continue;
    seen.add(r.url);
    references.push(r);
    if (references.length >= 40) break;
  }

  const related = uniq([
    ...(hr?.related ?? []),
    ...(osv?.rec?.related ?? []),
    ...campaigns.map((c) => c.data.record.id),
  ]).filter((x) => x !== recordId);

  const published = [
    hr?.published,
    osv?.rec?.published,
    nvdData?.published && `${nvdData.published}Z`.replace(/ZZ$/, 'Z'),
    kevRow?.published_at,
  ]
    .filter(Boolean)
    .map((d) => new Date(d))
    .filter((d) => !Number.isNaN(d.getTime()))
    .sort((a, b) => a - b)[0];
  const modified = [
    hr?.modified,
    osv?.rec?.modified,
    nvd?.updated_at,
    kevRow?.updated_at,
    ...aiRows.map((r) => r.updated_at),
  ]
    .filter(Boolean)
    .map((d) => new Date(d))
    .filter((d) => !Number.isNaN(d.getTime()))
    .sort((a, b) => b - a)[0];

  const openvuln = {
    version: VERSION,
    ...(subject ? { subject } : {}),
    ...(klass.length ? { class: klass } : {}),
    ...(label ? { label } : {}),
    ...(fix ? { fix } : {}),
    exploitation: {
      ...(status ? { status } : {}),
      ...(kev !== undefined ? { kev } : {}),
      ...(epss
        ? { epss: { score: epss.score, percentile: epss.percentile, date: epss.date } }
        : {}),
      ai,
    },
    sources,
    deep_dive: {
      url: `${siteUrl}/c/vulns/${encodeURIComponent(recordId)}`,
      ...(ov.deep_dive
        ? { ...ov.deep_dive, url: `${siteUrl}/c/vulns/${encodeURIComponent(recordId)}` }
        : {}),
    },
  };

  const record = {
    schema_version: OSV_SCHEMA,
    id: recordId,
    ...(published ? { published: published.toISOString() } : {}),
    modified: (modified ?? now).toISOString(),
    ...(base?.withdrawn ? { withdrawn: base.withdrawn } : {}),
    aliases: allIds.filter((x) => x !== recordId),
    ...(related.length ? { related } : {}),
    ...(summary ? { summary } : {}),
    ...(details ? { details } : {}),
    ...(severity?.length ? { severity } : {}),
    ...(base?.affected?.length ? { affected: base.affected } : {}),
    ...(references.length ? { references } : {}),
    ...((hr?.credits ?? osv?.rec?.credits) ? { credits: hr?.credits ?? osv.rec.credits } : {}),
    database_specific: {
      ...(cwe.length ? { cwe_ids: cwe } : {}),
      ...(hr?.database_specific?.iocs ? { iocs: hr.database_specific.iocs } : {}),
      openvuln,
    },
  };

  return {
    record,
    parts: {
      house,
      campaigns,
      osv: osvRecords.map((o) => o.rec),
      kev: kevRow,
      nvd,
      ai: aiRows,
      cves,
    },
  };
}
