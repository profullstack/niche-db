/**
 * What a suggested feed URL has to be before anything looks at it. Pure
 * functions with no imports, so they are testable from outside the workspace
 * and so the rules read in one place.
 */

/** Hosts a public site never legitimately asks us to fetch. */
const PRIVATE_HOST =
  /^(localhost|.*\.local|.*\.internal|.*\.localhost|0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|\[::1\]|\[fc[0-9a-f]{2}:.*\]|\[fe80:.*\])$/i;

/**
 * Normalise a pasted URL: trim, add https:// when the scheme is missing, drop
 * the fragment, lower-case the host. Returns null when it is not something
 * a crawler can fetch from a public host.
 */
export function normaliseFeedUrl(input) {
  let s = String(input ?? '').trim();
  if (!s || s.length > 2048) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname?.includes('.')) return null;
  if (u.username || u.password) return null;
  if (PRIVATE_HOST.test(u.hostname)) return null;
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  return u.toString();
}

/** Do the first bytes of a document read as RSS, RDF or Atom? */
export function looksLikeFeed(head) {
  return /<(rss|rdf:RDF|feed)[\s>]/i.test(String(head ?? '').slice(0, 8000));
}

/** The first <title> in a document head, as text, or null. */
export function titleOf(head) {
  const m = String(head ?? '').match(
    /<title[^>]*>\s*(?:<!\[CDATA\[)?([^<\]]{1,200}?)(?:\]\]>)?\s*<\/title>/i,
  );
  if (!m) return null;
  const t = m[1]
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
  return t || null;
}

/** An address a person typed, or null. Loose on purpose: it is only for replies. */
export function cleanEmail(input) {
  const s = String(input ?? '')
    .trim()
    .toLowerCase();
  if (!s || s.length > 254) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
}
