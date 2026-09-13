#!/usr/bin/env bun
/**
 * Which storefront platforms do hosting providers run? Measured, not assumed.
 *
 * The corpus is every provider the FindHost register lists (home URLs from
 * the register's own repository, CC BY 4.0) plus every provider LowEndBox has
 * linked to in its last ten feed pages. Each host is visited politely: our
 * own user agent, robots.txt honoured, one request a second per host, a few
 * hosts at a time, and never more than a dozen requests to any one of them.
 * The home page and the shop paths each platform is known to answer at are
 * fingerprinted with `storefront-platforms.js`, and the table goes to
 * `packages/adapters/test/fixtures/storefront-survey.json`, which the
 * `storefront` adapter reads its default host list from.
 *
 *   bun scripts/survey-storefronts.js            # full survey, ~10 minutes
 *   bun scripts/survey-storefronts.js --limit 30 # a quick look
 *   bun scripts/survey-storefronts.js --domains a.com,b.net
 */
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fingerprint,
  guessedShopOrigins,
  isChallenge,
  isListing,
  PLATFORMS,
  registrableDomain,
  robotsAllows,
  shopLinks,
  shopOrigins,
} from '../packages/adapters/src/storefront-platforms.js';

const UA = 'niche-db/0.1 (+https://nichedb.dev; storefront survey)';
const OUT = new URL('../packages/adapters/test/fixtures/storefront-survey.json', import.meta.url);
const HOMES = new URL('../packages/adapters/test/fixtures/findhost-homes.json', import.meta.url);
const CONCURRENCY = 12;
const PER_HOST_MAX = 18;
const TIMEOUT = 15_000;

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] ?? true] : null))
    .filter(Boolean),
);

/** Hosts LowEndBox links to that are not providers. */
const NOISE =
  /lowend|serververify|linkedin|gleam\.io|trustpilot|sendgrid|yahoo|apple\.com|youtube|youtu\.be|twitter|x\.com|facebook|wikipedia|github|amazon|gravatar|wp\.com|reddit|google|ycombinator|theregister|techrights|gnu\.org|bbpress|linuxfromscratch|kindroid|webpros|cpanel|solusvm|virtualizor|proxmox|mymangomail|tribblix|discord|telegram|t\.me|instagram|mastodon|paypal|stripe|cloudflare\.com$|archive\.org|w3\.org|mozilla|microsoft|ubuntu|debian|docker|npmjs|pypi|medium\.com|substack/i;

async function findhostHomes() {
  try {
    const cached = JSON.parse(await readFile(HOMES, 'utf8'));
    if (Object.keys(cached).length && !args.refresh) return cached;
  } catch {}
  const dir = await mkdtemp(join(tmpdir(), 'findhost-'));
  const proc = Bun.spawn(
    ['git', 'clone', '--depth', '1', '--quiet', 'https://github.com/fortrabbit/findhost', dir],
    { stdout: 'ignore', stderr: 'inherit' },
  );
  if ((await proc.exited) !== 0) throw new Error('could not clone fortrabbit/findhost');
  const homes = {};
  const files = await readdir(join(dir, 'src/content/providers'));
  for (const f of files) {
    if (!f.endsWith('.md')) continue;
    const md = await readFile(join(dir, 'src/content/providers', f), 'utf8');
    const id = md.match(/^id:\s*(.+)$/m)?.[1]?.trim();
    const home = md.match(/^\s+home:\s*(\S+)/m)?.[1]?.trim();
    if (id && home) homes[id] = home;
  }
  await writeFile(HOMES, `${JSON.stringify(homes, null, 2)}\n`);
  return homes;
}

async function lowendboxHosts(pages = 10) {
  const hosts = new Map();
  for (let p = 1; p <= pages; p++) {
    const url = p === 1 ? 'https://lowendbox.com/feed/' : `https://lowendbox.com/feed/?paged=${p}`;
    let xml = '';
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA },
        signal: AbortSignal.timeout(TIMEOUT),
      });
      xml = await res.text();
    } catch {
      continue;
    }
    const re = /href=(?:&quot;|["'])(https?:\/\/[^"'&\s]+)/gi;
    for (const m of xml.matchAll(re)) {
      let u = null;
      try {
        u = new URL(m[1]);
      } catch {
        continue;
      }
      const host = registrableDomain(u.hostname);
      if (NOISE.test(host) || NOISE.test(u.hostname)) continue;
      if (!hosts.has(host)) hosts.set(host, `${u.protocol}//${u.hostname}/`);
    }
    await Bun.sleep(1000);
  }
  return hosts;
}

async function get(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'text/html,*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const html = (await res.text()).slice(0, 400_000);
  return { status: res.status, url: res.url || url, html, cookies };
}

async function surveyHost(entry) {
  const row = {
    domain: entry.domain,
    source: entry.source,
    findhostId: entry.findhostId ?? null,
    home: entry.home,
    platform: null,
    score: 0,
    evidence: [],
    listing: null,
    origin: null,
    challenged: false,
    requests: 0,
    error: null,
  };
  const robots = new Map();
  const allowed = async (url) => {
    const u = new URL(url);
    if (!robots.has(u.origin)) {
      try {
        const res = await fetch(`${u.origin}/robots.txt`, {
          headers: { 'user-agent': UA },
          signal: AbortSignal.timeout(TIMEOUT),
        });
        robots.set(u.origin, res.ok ? await res.text() : '');
      } catch {
        robots.set(u.origin, '');
      }
      row.requests++;
    }
    return robotsAllows(robots.get(u.origin), u.pathname + u.search, UA);
  };
  const consider = (page) => {
    const f = fingerprint(page.html, page.url, page.cookies);
    if (f.score > row.score) {
      row.platform = f.platform;
      row.score = f.score;
      row.evidence = f.evidence;
      row.origin = new URL(page.url).origin;
    }
    if (f.platform && !row.listing && isListing(f.platform, page.url) && page.status === 200) {
      row.listing = page.url;
    }
  };

  let home = null;
  for (const start of [entry.home, entry.home.replace(/^https:/, 'http:')]) {
    try {
      if (!(await allowed(start))) {
        row.error = 'robots';
        return row;
      }
      home = await get(start);
      row.requests++;
      break;
    } catch (err) {
      row.error = err.name === 'TimeoutError' ? 'timeout' : err.message.slice(0, 60);
    }
  }
  if (!home) return row;
  row.error = null;
  row.challenged = isChallenge(home.html, home.status);
  if (!row.challenged) consider(home);

  const seen = new Set([home.url]);
  const queue = [];
  const origins = row.challenged ? [] : shopOrigins(home.html, home.url);
  if (!row.challenged) for (const link of shopLinks(home.html, home.url, 12)) queue.push(link);
  for (const origin of origins) {
    for (const p of Object.values(PLATFORMS))
      for (const probe of p.probes) queue.push(origin + probe);
  }
  // The conventional billing subdomains come last: a fallback for a home page
  // that said nothing, and the only route in when it was a challenge page.
  for (const origin of guessedShopOrigins(home.url)) {
    if (origins.includes(origin)) continue;
    for (const probe of ['/cart.php', '/order/', '/cart/', '/clientarea.php'])
      queue.push(origin + probe);
  }
  let probed = 0;
  for (const url of queue) {
    if (row.requests >= PER_HOST_MAX) break;
    if (seen.has(url)) continue;
    seen.add(url);
    // Once a platform is sure and its listing found, the rest is wasted courtesy.
    if (row.score >= 4 && row.listing) break;
    // A guessed subdomain that does not resolve costs nothing; one that does is one host.
    try {
      if (!(await allowed(url))) continue;
      if (probed++) await Bun.sleep(1000);
      const page = await get(url);
      row.requests++;
      if (isChallenge(page.html, page.status)) {
        row.challenged = true;
        continue;
      }
      if (page.status >= 400) continue;
      consider(page);
    } catch {}
  }
  return row;
}

async function main() {
  const homes = await findhostHomes();
  const corpus = new Map();
  if (args.domains) {
    for (const d of String(args.domains).split(',')) {
      const domain = registrableDomain(d.trim());
      corpus.set(domain, { domain, source: 'arg', home: `https://${d.trim()}/` });
    }
  } else {
    for (const [id, home] of Object.entries(homes)) {
      let u = null;
      try {
        u = new URL(home);
      } catch {
        continue;
      }
      const domain = registrableDomain(u.hostname);
      corpus.set(domain, { domain, source: 'findhost', findhostId: id, home: u.href });
    }
    for (const [domain, home] of await lowendboxHosts()) {
      if (!corpus.has(domain)) corpus.set(domain, { domain, source: 'lowendbox', home });
    }
  }
  let entries = [...corpus.values()];
  if (args.limit) entries = entries.slice(0, Number(args.limit));
  console.error(
    `${entries.length} hosts (${entries.filter((e) => e.source === 'findhost').length} FindHost, ${entries.filter((e) => e.source === 'lowendbox').length} LowEndBox)`,
  );

  const rows = [];
  let next = 0;
  const worker = async () => {
    while (next < entries.length) {
      const entry = entries[next++];
      const row = await surveyHost(entry);
      rows.push(row);
      console.error(
        `${String(rows.length).padStart(3)}/${entries.length} ${row.domain.padEnd(28)} ${row.platform ?? '-'}${row.listing ? ' listing' : ''}${row.error ? ` (${row.error})` : ''}`,
      );
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  rows.sort((a, b) => a.domain.localeCompare(b.domain));

  const counts = {};
  const bucket = (r) =>
    r.platform ?? (r.error ? `unreachable:${r.error}` : r.challenged ? 'challenged' : 'none');
  for (const r of rows) counts[bucket(r)] = (counts[bucket(r)] ?? 0) + 1;
  const result = {
    surveyedAt: new Date().toISOString().slice(0, 10),
    userAgent: UA,
    corpus: {
      hosts: rows.length,
      findhost: rows.filter((r) => r.source === 'findhost').length,
      lowendbox: rows.filter((r) => r.source === 'lowendbox').length,
    },
    counts,
    hosts: rows,
  };
  if (!args.domains && !args.limit) await writeFile(OUT, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ corpus: result.corpus, counts }, null, 2));
}

await main();
