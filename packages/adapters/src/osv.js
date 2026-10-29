import { defineAdapter, slugify } from '@nichedb/core/adapter';

/**
 * OSV.dev: the open vulnerability database, read from its public bucket.
 *
 * Every ecosystem has a `modified_id.csv` at
 * osv-vulnerabilities.storage.googleapis.com/<ecosystem>/, one `<modified>,<id>`
 * line per record, newest first, and every record is served at
 * `<ecosystem>/<id>.json`. No key, no rate card, and no API call: the bucket is
 * the dump.
 *
 * WHICH RECORDS
 *
 * The bucket holds 2.7 million records and two thirds are a distro restating a
 * CVE for its own rebuild (Chainguard, Wolfi, MinimOS each re-file every CVE
 * per package). Those say nothing a reader does not get from the CVE, so the
 * default source reads the language ecosystems, OSS-Fuzz, the Linux kernel and
 * Android, and of those only the advisory prefixes (`prefixes`). Malicious
 * package reports (`MAL-`, a quarter of a million on npm alone) are a second
 * source with a short backfill, because what matters there is the new ones.
 *
 * NEW, THEN OLD
 *
 * Each run first reads the head of every ecosystem's list (a Range request:
 * the list is newest first, so the head is everything since last time) down to
 * the high-water mark, then spends what is left of its budget walking the
 * backlog older than where the last backfill stopped. Both positions are
 * `(modified, id)` pairs, never line numbers: new records land at the top and
 * would shift a line count under the walk. The high-water mark moves only when
 * every new record was fetched, so a failed fetch is read again next run.
 *
 * TAGS ARE THE JOIN
 *
 * `id:<id>` for the record's own id and every alias, lower-cased, is what the
 * /c/vulns deep dive gathers on: one CVE's OSV record, its KEV entry, its
 * ExploitGym task and a house OpenVuln record all carry `id:cve-...`. An
 * OSS-Fuzz record also carries `oss-fuzz:<issue>` from its bug link, which is
 * how an ExploitGym task named after the issue finds it.
 */
export const BUCKET = 'https://osv-vulnerabilities.storage.googleapis.com';

export const ADVISORY_ECOSYSTEMS = [
  'npm',
  'PyPI',
  'Go',
  'Maven',
  'NuGet',
  'RubyGems',
  'crates.io',
  'Packagist',
  'Pub',
  'Hex',
  'SwiftURL',
  'Hackage',
  'CRAN',
  'GitHub Actions',
  'Julia',
  'OSS-Fuzz',
  'Linux',
  'Android',
];

export const ADVISORY_PREFIXES = [
  'GHSA',
  'PYSEC',
  'GO',
  'RUSTSEC',
  'RSEC',
  'OSV',
  'CVE',
  'JLSEC',
  'ASB',
  'PUB',
  'HSEC',
  'PSF',
];

// A Range read of the head of a list: about 4,000 lines, more than a day of
// changes in the busiest ecosystem.
export const HEAD_BYTES = 256 * 1024;
const CONCURRENCY = 8;

/** `<modified>,<id>` lines, newest first, with ties ordered by id so a walk is deterministic. */
export function parseModifiedCsv(text, { complete = true } = {}) {
  const lines = String(text ?? '').split('\n');
  // A Range read stops mid-line: the last line is only whole if the file ended.
  if (!complete) lines.pop();
  const out = [];
  for (const line of lines) {
    const comma = line.indexOf(',');
    if (comma < 1) continue;
    const modified = line.slice(0, comma).trim();
    const id = line.slice(comma + 1).trim();
    if (!id || Number.isNaN(Date.parse(modified))) continue;
    out.push({ modified, id });
  }
  return out.sort((a, b) => cmp(b, a));
}

/** Order two `(modified, id)` positions: newer first means a > b when a is newer. */
export function cmp(a, b) {
  const ta = Date.parse(a.modified);
  const tb = Date.parse(b.modified);
  if (ta !== tb) return ta - tb;
  // Within one instant, the smaller id sorts first in the newest-first list.
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export const prefixOf = (id) => String(id).split('-')[0].toUpperCase();

export function wanted(id, { prefixes = [], skipPrefixes = [] } = {}) {
  const p = prefixOf(id);
  if (skipPrefixes.map((x) => x.toUpperCase()).includes(p)) return false;
  return prefixes.length === 0 || prefixes.map((x) => x.toUpperCase()).includes(p);
}

/** The OSS-Fuzz issue a record was filed from, read off its bug link. */
export function ossFuzzIssue(record) {
  for (const r of record?.references ?? []) {
    const m = String(r?.url ?? '').match(
      /(?:bugs\.chromium\.org\/p\/oss-fuzz\/issues\/detail\?id=|issues\.oss-fuzz\.com\/issues\/)(\d+)/,
    );
    if (m) return m[1];
  }
  return null;
}

/** GitHub's word for it, as OSV carries it: critical, high, moderate (=medium), low. */
export function labelOf(record) {
  const s = String(record?.database_specific?.severity ?? '').toLowerCase();
  if (s === 'moderate') return 'medium';
  return ['critical', 'high', 'medium', 'low'].includes(s) ? s : null;
}

/** First fixed version per affected package, and whether any range is still open. */
export function fixOf(record) {
  const versions = new Set();
  let ranges = 0;
  let open = 0;
  for (const a of record?.affected ?? []) {
    for (const r of a?.ranges ?? []) {
      if (r?.type === 'GIT') continue;
      ranges += 1;
      const fixed = (r.events ?? []).filter((e) => e.fixed).map((e) => e.fixed);
      if (fixed.length === 0) open += 1;
      for (const f of fixed) versions.add(f);
    }
  }
  if (ranges === 0) return null;
  return {
    status: open === 0 ? 'fixed' : versions.size ? 'partial' : 'unfixed',
    versions: [...versions].slice(0, 12),
  };
}

export const idTag = (id) => `id:${String(id).toLowerCase()}`;

export function toItem(record, { ecosystem } = {}) {
  if (!record?.id) return null;
  const ids = [record.id, ...(record.aliases ?? []), ...(record.upstream ?? [])];
  const packages = (record.affected ?? [])
    .map((a) => a?.package)
    .filter((p) => p?.name)
    .slice(0, 20);
  const ecosystems = [...new Set(packages.map((p) => p.ecosystem).filter(Boolean))];
  const malicious = prefixOf(record.id) === 'MAL';
  const label = labelOf(record);
  const fix = fixOf(record);
  const issue = ossFuzzIssue(record);
  const cwes = (record.database_specific?.cwe_ids ?? []).filter((c) => /^CWE-\d+$/i.test(c));
  const firstPkg = packages[0]
    ? `${packages[0].name}${packages.length > 1 ? ' and others' : ''}`
    : '';
  const gist =
    record.summary || String(record.details ?? '').split('\n')[0] || firstPkg || 'no summary';
  return {
    externalId: record.id,
    kind: malicious ? 'malicious-package' : 'vuln',
    title: `${record.id}: ${gist}`.slice(0, 300),
    summary: String(record.details ?? record.summary ?? '').slice(0, 2000) || null,
    url: `https://osv.dev/vulnerability/${record.id}`,
    publishedAt: record.published ?? record.modified ?? null,
    tags: [
      'osv',
      ...[...new Set(ids)].slice(0, 12).map(idTag),
      ...ecosystems.slice(0, 4).map((e) => `ecosystem:${slugify(e)}`),
      ...packages
        .slice(0, 6)
        .map(
          (p) => `pkg:${slugify(p.ecosystem ?? ecosystem ?? '')}/${String(p.name).toLowerCase()}`,
        ),
      label ? `severity:${label}` : null,
      fix ? `fix:${fix.status}` : null,
      malicious ? 'class:malicious-package' : null,
      record.withdrawn ? 'withdrawn' : null,
      issue ? `oss-fuzz:${issue}` : null,
      ...cwes.slice(0, 4).map((c) => `cwe:${c.toLowerCase()}`),
    ].filter(Boolean),
    data: {
      osv: {
        ...record,
        affected: (record.affected ?? []).slice(0, 25),
        references: (record.references ?? []).slice(0, 30),
        details: String(record.details ?? '').slice(0, 20_000),
      },
      label,
      fix,
      ecosystem: ecosystem ?? ecosystems[0] ?? null,
    },
  };
}

async function headList(http, ecosystem) {
  const url = `${BUCKET}/${encodeURIComponent(ecosystem)}/modified_id.csv`;
  const res = await http.request(url, {
    headers: { range: `bytes=0-${HEAD_BYTES - 1}`, accept: 'text/csv, */*' },
    timeoutMs: 60_000,
  });
  const text = await res.text();
  // 206 with a content-range shorter than the file is a partial read.
  const total = Number(String(res.headers.get('content-range') ?? '').split('/')[1]);
  const complete = res.status === 200 || !Number.isFinite(total) || total <= HEAD_BYTES;
  return { rows: parseModifiedCsv(text, { complete }), complete };
}

async function fullList(http, ecosystem) {
  const url = `${BUCKET}/${encodeURIComponent(ecosystem)}/modified_id.csv`;
  return parseModifiedCsv(await http.text(url, { timeoutMs: 5 * 60_000 }));
}

/** Fetch records with a little concurrency; a failure is reported, never thrown. */
async function fetchRecords(http, ecosystem, rows, deadline) {
  const items = [];
  const failed = [];
  let next = 0;
  async function worker() {
    while (next < rows.length && Date.now() < deadline) {
      const row = rows[next++];
      try {
        const rec = await http.json(
          `${BUCKET}/${encodeURIComponent(ecosystem)}/${encodeURIComponent(row.id)}.json`,
          { timeoutMs: 30_000 },
        );
        const item = toItem(rec, { ecosystem });
        if (item) items.push(item);
      } catch {
        failed.push(row);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  // Anything the deadline cut off counts as not fetched.
  const done = new Set(items.map((i) => i.externalId));
  const missed = rows.filter((r) => !done.has(r.id));
  return { items, failed: missed.length ? missed : failed };
}

export const osv = defineAdapter({
  name: 'osv',
  title: 'OSV.dev: open source vulnerabilities',
  collection: 'vulns',
  description:
    "Open source vulnerabilities from OSV.dev, the OpenSSF database that gathers GitHub advisories, PyPA, the Go and Rust advisory databases, OSS-Fuzz crashes, the Linux kernel CNA and Android bulletins into one schema: affected packages and version ranges, first fixed versions, aliases (CVE, GHSA), CWE and severity. Read from the public bucket, keyless: the head of each ecosystem's modified list every half hour, and the backlog walked a slice at a time until it is all in.",
  docs: 'https://google.github.io/osv.dev/data/',
  kinds: ['vuln', 'malicious-package'],
  cadenceMinutes: 30,
  budgetMs: 8 * 60_000,
  configFields: [
    {
      key: 'ecosystems',
      label: 'Ecosystems',
      type: 'list',
      help: 'OSV ecosystem names, exactly as the bucket spells them',
    },
    { key: 'prefixes', label: 'Id prefixes to keep', type: 'list', help: 'Empty keeps every id' },
    { key: 'skipPrefixes', label: 'Id prefixes to skip', type: 'list' },
    { key: 'perRun', label: 'Records per run', type: 'number' },
    { key: 'backfillDays', label: 'Backfill only this many days (empty = all)', type: 'number' },
  ],
  defaults: {
    ecosystems: ADVISORY_ECOSYSTEMS,
    prefixes: ADVISORY_PREFIXES,
    skipPrefixes: ['MAL'],
    perRun: 2500,
  },
  defaultSources: [
    {
      slug: 'osv-advisories',
      name: 'OSV.dev: advisories for open source packages, OSS-Fuzz and the kernel',
      description:
        'Every advisory OSV.dev holds for npm, PyPI, Go, Maven, NuGet, RubyGems, crates.io, Packagist, Pub, Hex, Swift, Hackage, CRAN, GitHub Actions, Julia, OSS-Fuzz, the Linux kernel and Android, with affected ranges, fixed versions and aliases. Distribution rebuild notices (Chainguard, Wolfi, Debian, Ubuntu and the rest) are left out: they restate a CVE per package.',
      config: {
        ecosystems: ADVISORY_ECOSYSTEMS,
        prefixes: ADVISORY_PREFIXES,
        skipPrefixes: ['MAL'],
        perRun: 2500,
      },
    },
    {
      slug: 'osv-malicious',
      name: 'OSV.dev: malicious packages (OpenSSF)',
      description:
        'Packages published to steal or destroy, as the OpenSSF Malicious Packages project reports them to OSV: npm, PyPI, RubyGems, crates.io and the rest. New reports within the half hour; the backlog only for the last thirty days.',
      config: {
        ecosystems: ['npm', 'PyPI', 'RubyGems', 'crates.io', 'NuGet', 'Go', 'Maven', 'Packagist'],
        prefixes: ['MAL'],
        skipPrefixes: [],
        perRun: 1500,
        backfillDays: 30,
      },
    },
  ],
  async pull({ config, cursor, http, log, deadline }) {
    const ecosystems = config.ecosystems?.length ? config.ecosystems : ADVISORY_ECOSYSTEMS;
    const filter = { prefixes: config.prefixes ?? [], skipPrefixes: config.skipPrefixes ?? [] };
    const perRun = Math.max(1, Number(config.perRun) || 2500);
    const floor =
      Number(config.backfillDays) > 0
        ? new Date(Date.now() - Number(config.backfillDays) * 86_400_000).toISOString()
        : null;
    const state = { ...(cursor?.ecosystems ?? {}) };
    const items = [];
    const notes = [];
    let spent = 0;
    let backlog = false;

    // 1. What changed since the high-water mark, in every ecosystem.
    for (const eco of ecosystems) {
      if (Date.now() > deadline || spent >= perRun) break;
      const s = { ...(state[eco] ?? {}) };
      let rows;
      try {
        const head = await headList(http, eco);
        rows = head.rows;
        const hw = s.hw ? { modified: s.hw.modified, id: s.hw.id } : null;
        const reached = !hw || rows.some((r) => cmp(r, hw) <= 0);
        if (hw && !reached && !head.complete) rows = await fullList(http, eco);
      } catch (err) {
        notes.push(`${eco}: list failed (${err.message.slice(0, 60)})`);
        continue;
      }
      if (!s.hw) {
        // First run: the newest record is the high-water mark, and the backfill
        // starts just below it.
        if (rows[0]) {
          s.hw = rows[0];
          s.bf = s.bf ?? null;
        }
        state[eco] = s;
        backlog = true;
        continue;
      }
      const fresh = rows.filter((r) => cmp(r, s.hw) > 0).filter((r) => wanted(r.id, filter));
      const take = fresh.slice(-Math.max(0, perRun - spent)); // oldest new first if over budget
      const got = await fetchRecords(http, eco, take, deadline);
      items.push(...got.items);
      spent += take.length;
      if (got.failed.length === 0 && take.length === fresh.length) {
        s.hw = rows.find((r) => cmp(r, s.hw) > 0) ?? s.hw;
      } else if (got.failed.length === 0 && take.length) {
        // Over budget: move only up to the newest record actually read.
        s.hw = take[0];
      }
      if (fresh.length) notes.push(`${eco} +${got.items.length}`);
      state[eco] = s;
    }

    // 2. The backlog, oldest-unread first, with whatever budget is left.
    for (const eco of ecosystems) {
      const s = state[eco];
      if (!s?.hw || s.bfDone) continue;
      backlog = true;
      if (Date.now() > deadline || spent >= perRun) break;
      let rows;
      try {
        rows = await fullList(http, eco);
      } catch (err) {
        notes.push(`${eco}: backlog list failed (${err.message.slice(0, 60)})`);
        continue;
      }
      const start = s.bf ?? s.hw;
      const below = rows.filter((r) => cmp(r, start) < 0 || (!s.bf && cmp(r, start) === 0));
      const inRange = floor ? below.filter((r) => r.modified >= floor) : below;
      const todo = inRange.filter((r) => wanted(r.id, filter)).slice(0, perRun - spent);
      const got = await fetchRecords(http, eco, todo, deadline);
      items.push(...got.items);
      spent += todo.length;
      // Advance to the last record read in order, stopping at the first failure.
      const failedIds = new Set(got.failed.map((r) => r.id));
      let last = null;
      for (const r of todo) {
        if (failedIds.has(r.id)) break;
        last = r;
      }
      if (last) s.bf = last;
      const remaining = inRange.filter((r) => wanted(r.id, filter)).length - todo.length;
      if (remaining <= 0 && failedIds.size === 0) s.bfDone = true;
      notes.push(`${eco} backlog +${got.items.length}${s.bfDone ? ' (done)' : ''}`);
      state[eco] = s;
    }

    const still = backlog && Object.values(state).some((s) => s?.hw && !s.bfDone);
    log(`${items.length} OSV records; ${notes.join(', ') || 'nothing new'}`);
    return {
      items,
      cursor: { ecosystems: state },
      note: `${items.length} records${still ? '; backfilling' : ''}`,
      ...(still ? { nextInMinutes: 2 } : {}),
    };
  },
});
