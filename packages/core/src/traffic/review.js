import { isIP } from 'node:net';
import { sharedOwnerOf } from './owners.js';

/**
 * riotcoder's review of the /traffic queue: the rules a careful person would
 * apply, written down so every decision can be checked and repeated.
 *
 * An address is judged by what it actually requested (the paths in its
 * evidence and in our nginx logs) and by sshd, never by the name of the
 * ThreatCrush rule that banned it: those rules misfire (`attack-rce` on a
 * page whose query says "docker", `web-scanner-detection` on any burst of
 * 404s and 402s).
 *
 *   reject   an address in the owner registry (owners.js: CDNs, resolvers,
 *            search crawlers, Apple's 17.0.0.0/8), or anyone who logged in
 *            over SSH (an operator)
 *   approve  everything else ThreatCrush banned (Anthony, 2026-10-19), with
 *            the strongest reason we have: an exploit probe in a request
 *            path, SSH brute force, or the ban itself
 *
 * Every decision carries its reason, published on the address's page.
 */

const PROBE = new RegExp(
  [
    String.raw`/\.env\b`,
    String.raw`/\.git/`,
    String.raw`/\.aws/`,
    String.raw`/\.ssh/`,
    String.raw`/\.vscode/`,
    String.raw`/\.svn/`,
    String.raw`/\.hg/`,
    String.raw`/\.htpasswd`,
    String.raw`/\.docker`,
    String.raw`/etc/passwd`,
    String.raw`/proc/self`,
    String.raw`file:/{2,3}`,
    String.raw`wp-login\.php`,
    String.raw`xmlrpc\.php`,
    String.raw`/wp-admin`,
    String.raw`/wp-content/`,
    String.raw`/wp-includes/`,
    'wlwmanifest',
    'phpunit/',
    'eval-stdin',
    String.raw`/vendor/.*\.php`,
    'phpinfo',
    String.raw`/phpmyadmin(/|$|\?|\.php)`,
    '/pma/',
    '/adminer',
    '/cgi-bin/',
    '/boaform',
    '/hnap1',
    '/goform/',
    '/actuator',
    '/jenkins',
    '/manager/html',
    '/solr/',
    '/console/login',
    String.raw`/autodiscover/autodiscover\.json`,
    '/owa/',
    '/ecp/',
    '/remote/fgt_lang',
    '/developmentserver/metadatauploader',
    '/geoserver',
    '/druid/',
    '/telescope(/|$)',
    '/_ignition',
    '/server-status',
    String.raw`/sftp-config\.json`,
    String.raw`/config\.php`,
    '/xmlrpc',
    'cmd=',
    'exec=',
    String.raw`union[\s+]+select`,
    String.raw`sleep\(\d`,
    String.raw`benchmark\(`,
    '<script',
    String.raw`\$\{jndi`,
    String.raw`;\s*wget`,
    String.raw`wget\s+http`,
    String.raw`curl\s+http`,
    String.raw`\$\(`,
    '/bin/(ba)?sh',
    'base64_decode',
    'allow_url_include',
    '/admin/config',
    String.raw`/setup\.cgi`,
    String.raw`/login\.action`,
    '/struts',
    String.raw`/backup\.(zip|sql|tar)`,
    String.raw`/(dump|database|db)\.sql`,
    String.raw`/__vite_rsc_findsourcemapurl\?filename=file`,
    // Secrets and config files nobody links to (2026-10-19 re-review).
    String.raw`/[\w.-]*\.env(\.[\w-]+)?($|\?)`,
    String.raw`/\.(npmrc|pypirc|yarnrc|netrc|pgpass|bashrc|bash_history|zshrc|profile|s3cfg|boto|dockercfg|git-credentials|gitignore|gitlab-ci\.yml|travis\.yml|circleci/|terraform|kube/|idea/|ds_store|htaccess|my\.cnf)`,
    String.raw`/web-inf/`,
    String.raw`/(database|parameters|secrets|credentials)\.(yml|yaml|json|ini)`,
    'aws_credentials',
    String.raw`/credentials($|\?|\.)`,
    String.raw`id_(rsa|dsa|ecdsa|ed25519)\b`,
    String.raw`wp-config`,
    String.raw`/reportserver`,
    // SQL injection.
    String.raw`union(\s+all)?\s+select`,
    'information_schema',
    String.raw`\b(and|or)\s+\d+\s*=\s*\d+`,
    String.raw`waitfor\s+delay`,
    String.raw`pg_sleep\(`,
    String.raw`169\.254\.169\.254`,
  ].join('|'),
  'i',
);

/** Path traversal, in the path or in one of our own query values. */
const TRAVERSAL = /(\.\.\/|\.\.\\|\.\.;\/|\.\.%c1%9c)/i;

/**
 * Query values that are web addresses (a reader's ?p=https://site/a/../b,
 * an archive link to Editing_wp-config.php) are someone else's URL, not a
 * request to us: they are dropped before the probe and traversal tests.
 * Every other value counts, so ?range=../../proc/version is traversal.
 */
const isWebUrl = (v) => /^https?:\/\//i.test(decode(v).trim());
const ownQuery = (query) =>
  query
    .split('&')
    .filter((kv) => !isWebUrl(kv.slice(kv.indexOf('=') + 1)))
    .join('&');

/** Scripts we never serve: the fleet runs no PHP, ASP or JSP. */
const SCRIPT = /\.(php\d?|phtml|asp|aspx|jsp|cgi)$/i;

const BRUTE_RULES = new Set(['ssh-brute-force', 'ssh-root-login', 'ssh-user-enumeration']);

/**
 * Percent-decoding that survives malformed input: the stored paths are cut
 * at a length, often mid-escape ("...WHERE%"), and decodeURIComponent then
 * throws, which used to leave a UNION SELECT undecoded and unmatched.
 */
const decodeOnce = (s) =>
  s.replace(/\+/g, ' ').replace(/%([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
const decode = (s) => decodeOnce(decodeOnce(s));

/** The request paths that are exploit probes. */
export function probesIn(paths = []) {
  const hits = [];
  for (const p of paths) {
    const raw = String(p ?? '');
    const q = raw.indexOf('?');
    const path = q < 0 ? raw : raw.slice(0, q);
    const own = q < 0 ? path : `${path}?${ownQuery(raw.slice(q + 1))}`;
    if (
      PROBE.test(decode(own)) ||
      PROBE.test(own) ||
      TRAVERSAL.test(decode(own)) ||
      TRAVERSAL.test(own) ||
      SCRIPT.test(decode(path))
    )
      hits.push(raw);
  }
  return hits;
}

/**
 * One queued address. `row`: { ip, rules, blocks, servers, paths }.
 * `ev` (optional): { n, status, paths, ssh_accepted, ssh_failed } from the logs.
 * Returns { decision: 'approve' | 'reject' | 'pending', note }.
 */
export function reviewAddress(row, ev = {}) {
  const ip = row.ip;
  const owner = isIP(ip) ? sharedOwnerOf(ip) : null;
  if (owner)
    return {
      decision: 'reject',
      note: `riotcoder review: owned by ${owner.name} (${owner.range}), a known network we never list. See /ips/owners.`,
    };
  const sshOk = Number(ev.ssh_accepted) || 0;
  const sshBad = Number(ev.ssh_failed) || 0;
  if (sshOk)
    return {
      decision: 'reject',
      note: `riotcoder review: logged in over SSH ${sshOk}x; an operator, not an attacker.`,
    };
  const paths = [...new Set([...(row.paths ?? []), ...(ev.paths ?? [])])];
  const hits = probesIn(paths);
  if (hits.length)
    return {
      decision: 'approve',
      note: `riotcoder review: exploit probes, e.g. ${hits
        .slice(0, 3)
        .map((h) => h.slice(0, 80))
        .join(', ')}`,
    };
  const brute = (row.rules ?? []).some((r) => BRUTE_RULES.has(r));
  if (brute && sshBad)
    return {
      decision: 'approve',
      note: `riotcoder review: SSH brute force, ${sshBad} failed SSH logins, never a successful login.`,
    };
  // Every other ThreatCrush ban is listed (Anthony, 2026-10-19: "just approve
  // all"). Only shared infrastructure and our own operators are kept off.
  const blocks = Number(row.blocks) || 1;
  const servers = Number(row.servers) || 1;
  return {
    decision: 'approve',
    note: `riotcoder review: banned by ThreatCrush ${blocks}x on ${servers} server(s)${
      (row.rules ?? []).length ? ` (${row.rules.slice(0, 3).join(', ')})` : ''
    }.`,
  };
}
