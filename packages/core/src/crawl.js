/**
 * The fleet crawler rule (2026-11-08): "crawlers should timeout after 10
 * seconds for fetch, 30 for browser (js, images, css). We don't want broken
 * slow shit. Flag to recheck later in a month."
 *
 * One place for the numbers, and the pure function that decides whether a
 * failed run was the upstream being slow or broken. On its own, with no
 * imports, like retry.js: http.js, ingest.js and the adapters all need it.
 */

/** One plain HTTP request to a third-party URL: connect, headers and body. */
export const CRAWL_FETCH_TIMEOUT_MS = 10_000;

/** One headless-browser render (JS, images, CSS): navigation plus settle. */
export const CRAWL_BROWSER_TIMEOUT_MS = 30_000;

/** The bounded settle after `load` in a browser render; never networkidle. */
export const BROWSER_SETTLE_MS = 1_500;

/**
 * A bulk dataset download (a dump of gigabytes, `http.download`). Not a page
 * or an API call, so not the 10 s rule: an hour for the whole transfer.
 */
export const BULK_DOWNLOAD_TIMEOUT_MS = 60 * 60_000;

/** How long a source whose upstream was slow or broken is left alone. */
export const FLAG_DAYS = 30;
export const FLAG_MS = FLAG_DAYS * 86_400_000;

// Timeouts anywhere between us and the upstream (Bun: TimeoutError; undici: UND_ERR_*).
const SLOW_CODES = new Set([
  'TimeoutError',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);
// The upstream cannot be reached or spoken to: no such host, refused, reset, TLS.
const BROKEN_CODES = new Set([
  'ENOTFOUND',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EHOSTDOWN',
  'EPIPE',
  'EPROTO',
  'ConnectionRefused',
  'ConnectionClosed',
  'FailedToOpenSocket',
  'UND_ERR_SOCKET',
]);
const TLS_CODE =
  /^(ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|HOSTNAME_MISMATCH)/;

/**
 * Our own services and the vendors behind them (rule 4 of the crawler rule):
 * a house site, a pit.world host, our Supabase projects. A failure talking to
 * one of these is ours to fix, not a slow third party, so it keeps the short
 * retry instead of 30 days. Matched on the host the request went to.
 */
export const OWN_HOSTS =
  /(^|\.)(pit\.world|profullstack\.com|nichedb\.dev|bittorrented\.com|ch4nnels\.com|c0upons\.com|outreachgraph\.com|smshub\.dev|rssamplifier\.com|p0dcasters\.com|logicsrc\.com|c0mpute\.com|crawlproof\.com|r4ck\.dev|weedforcrypto\.com|supabase\.co|coinpayportal\.com)$/i;

/** The host a failed request went to: makeHttp records it; otherwise the first one the message names. */
export function failedHost(err) {
  const raw = err?.upstreamUrl ?? String(err?.message ?? '');
  const m =
    String(raw).match(/https?:\/\/([^/\s:?#]+)/i) ??
    String(raw).match(/\b(?:ENOTFOUND|EAI_AGAIN)\s+([a-z0-9.-]+\.[a-z]{2,})/i);
  return m ? m[1].toLowerCase() : null;
}

function codesOf(err) {
  const out = [];
  for (let e = err, depth = 0; e && depth < 4; e = e.cause, depth++) {
    if (typeof e !== 'object' && typeof e !== 'function') break;
    for (const c of [e.code, e.name]) if (typeof c === 'string') out.push(c);
  }
  return out;
}

/**
 * 'slow' (a timeout), 'broken' (DNS, TLS, refused/reset connection, HTTP
 * 5xx) or null for anything else: a 4xx, a parse error, a missing key, a bug
 * of ours, a database error. Those keep the short retry in retry.js.
 *
 * EAI_AGAIN is null on purpose: it is our own resolver failing for a moment
 * (dev2's Docker DNS has failed every host at once), not the upstream. An
 * error can force the answer with `flag: 'slow' | 'broken' | null`.
 */
export function failureClass(err) {
  if (!err || (typeof err !== 'object' && typeof err !== 'function')) return null;
  if ('flag' in err && (err.flag === 'slow' || err.flag === 'broken' || err.flag === null))
    return err.flag;
  const host = failedHost(err);
  if (host && OWN_HOSTS.test(host)) return null;
  const codes = codesOf(err);
  if (codes.includes('EAI_AGAIN')) return null;
  // Our own database failing is never the upstream's fault: Bun SQL errors
  // carry ERR_POSTGRES_* codes, and a refused Postgres must not park sources.
  if (codes.some((c) => c.startsWith('ERR_POSTGRES') || c === 'PostgresError' || c === 'SQLError'))
    return null;
  // A system code only says "upstream" on a fetch error: Bun's fetch throws a
  // TypeError carrying it, and makeHttp marks what it throws `upstream`.
  const fromFetch =
    err.upstream === true || err.name === 'TypeError' || err.name === 'TimeoutError';
  if (codes.includes('TimeoutError')) return 'slow';
  if (fromFetch && codes.some((c) => SLOW_CODES.has(c))) return 'slow';
  const status = Number(err.status ?? err.statusCode);
  if (Number.isFinite(status) && status >= 500 && status <= 599) return 'broken';
  if (fromFetch && codes.some((c) => BROKEN_CODES.has(c) || TLS_CODE.test(c))) return 'broken';
  const message = String(err.message ?? '');
  // httpError's message, for an error rethrown without its status.
  if (/^5\d\d from https?:\/\//.test(message)) return 'broken';
  if (/^The operation timed out\.?$/.test(message)) return 'slow';
  return null;
}

/** When a source flagged now is looked at again. */
export function flaggedUntil(now = Date.now()) {
  return new Date(now + FLAG_MS);
}
