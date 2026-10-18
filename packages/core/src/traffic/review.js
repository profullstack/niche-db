import { isIP } from 'node:net';
import { isSharedIp } from './shared.js';

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
 *   approve  an exploit probe in a request path, or SSH brute force with no
 *            successful login
 *   reject   a shared CDN or resolver address; anyone who logged in over
 *            SSH; or an address seen making >= 5 requests with not one probe
 *            and no failed SSH logins (the ban was a false positive)
 *   pending  everything else: not enough evidence either way
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
  ].join('|'),
  'i',
);

/**
 * Traversal counts only in the path itself: "../" inside a query parameter is
 * usually a real article URL handed to a reader endpoint
 * (/x/read?p=https://site/a/../b).
 */
const TRAVERSAL = /(\.\.\/|\.\.\\|\.\.;\/|\.\.%c1%9c)/i;

const BRUTE_RULES = new Set(['ssh-brute-force', 'ssh-root-login', 'ssh-user-enumeration']);

const decode = (s) => {
  try {
    return decodeURIComponent(decodeURIComponent(s));
  } catch {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  }
};

/** The request paths that are exploit probes. */
export function probesIn(paths = []) {
  const hits = [];
  for (const p of paths) {
    const raw = String(p ?? '');
    const path = raw.split('?', 1)[0];
    if (
      PROBE.test(decode(raw)) ||
      PROBE.test(raw) ||
      TRAVERSAL.test(decode(path)) ||
      TRAVERSAL.test(path)
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
  if (isIP(ip) && isSharedIp(ip))
    return {
      decision: 'reject',
      note: 'riotcoder review: a shared CDN or resolver address (Cloudflare and the like), never one actor.',
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
  const n = Number(ev.n) || 0;
  const brute = (row.rules ?? []).some((r) => BRUTE_RULES.has(r));
  if (brute && (sshBad >= 5 || (Number(row.blocks) >= 3 && sshBad === 0 && n === 0))) {
    const why = sshBad
      ? `${sshBad} failed SSH logins`
      : `banned ${row.blocks}x for SSH brute force on ${row.servers} server(s)`;
    return {
      decision: 'approve',
      note: `riotcoder review: SSH brute force, ${why}, never a successful login.`,
    };
  }
  if (n >= 5 && sshBad === 0) {
    const top = Object.entries(ev.status ?? {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k, v]) => `${k}x${v}`)
      .join(', ');
    return {
      decision: 'reject',
      note: `riotcoder review: ${n} requests, not one exploit probe (status ${top}); the ban was a false positive.`,
    };
  }
  return { decision: 'pending', note: null };
}
