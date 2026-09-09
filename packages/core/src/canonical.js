/**
 * The form of a URL that decides whether two sources are carrying one story.
 *
 * The same article reaches this database by several roads -- the newsroom's own
 * feed, GDELT, and any directory that indexes the same publisher -- and each
 * road decorates the link differently. Compared raw, none of these match:
 *
 *   https://www.bbc.co.uk/news/articles/abc123
 *   http://bbc.co.uk/news/articles/abc123/
 *   https://www.bbc.co.uk/news/articles/abc123?utm_source=rss&utm_medium=feed
 *   https://www.bbc.co.uk/news/articles/abc123#comments
 *
 * They are one story, and this returns one key for all four.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It does not follow redirects, resolve shorteners or fetch anything: a dedupe
 * key that costs a request per item is not a dedupe key, it is a crawl. It also
 * does not touch the stored `url` -- a reader still gets the link the publisher
 * published, tracking parameters and all, because rewriting somebody's link is
 * a different decision from deciding two of them are the same.
 */

/**
 * Parameters that identify the road rather than the destination.
 *
 * Everything `utm_*` plus the per-network click ids, and the handful of feed
 * parameters that publishers append per-syndication. Anything else is left
 * alone: `?id=` and `?p=` and `?story=` are how a great many sites address an
 * article at all, and stripping those would fuse a publisher's whole archive
 * into one key.
 */
const TRACKING = new Set([
  'fbclid',
  'gclid',
  'dclid',
  'msclkid',
  'twclid',
  'igshid',
  'mc_cid',
  'mc_eid',
  'ref_src',
  'ref_url',
  'cmpid',
  'ito',
  'ns_campaign',
  'ns_mchannel',
  'ns_source',
  'ocid',
  'at_medium',
  'at_campaign',
  'at_custom1',
  'at_custom2',
  'at_custom3',
  'at_custom4',
  'at_bbc_team',
  'smid',
  'partner',
  'sh',
  'guccounter',
]);

const isTracking = (k) => k.startsWith('utm_') || TRACKING.has(k);

/**
 * A stable key for an article URL, or null if there is nothing to key on.
 *
 * @param {string|null|undefined} url
 * @returns {string|null}
 */
export function canonicalUrl(url) {
  const raw = String(url ?? '').trim();
  if (!raw) return null;

  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

  // Scheme is dropped rather than normalised. A publisher that moved to https
  // is the same publisher, and half the feeds in this database still say http.
  let host = u.hostname.toLowerCase().replace(/^www\./, '');
  // A trailing dot is a legal fully-qualified host and the same site.
  host = host.replace(/\.$/, '');
  if (!host) return null;

  const port = u.port && u.port !== '80' && u.port !== '443' ? `:${u.port}` : '';

  for (const key of [...u.searchParams.keys()]) {
    if (isTracking(key.toLowerCase())) u.searchParams.delete(key);
  }
  // Sorted, because two sources can list the same parameters in either order.
  u.searchParams.sort();
  const query = u.searchParams.toString();

  // A trailing slash is a formatting choice, not a different document -- except
  // at the root, where removing it leaves nothing to key on.
  let path = u.pathname.replace(/\/+$/, '');
  if (!path) path = '/';

  // The fragment is a position within the document, never another document.
  return `${host}${port}${path}${query ? `?${query}` : ''}`;
}
