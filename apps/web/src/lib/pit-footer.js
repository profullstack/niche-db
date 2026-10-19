/**
 * The pit.world global footer (site name, search, ring, publish), fetched on
 * the server from pit.world and injected as the last thing in <body>.
 *
 * Layout is a sync component, so the page renders whatever was last fetched and
 * a stale copy (older than an hour) triggers a background refresh. Any failure
 * keeps the previous copy, and with no copy at all the footer is simply absent:
 * the network footer must never break a page.
 */
const URL = 'https://pit.world/snippets/footer.html?site=nichedb.dev';
const MAX_AGE_MS = 60 * 60 * 1000;

let html = '';
let fetchedAt = 0;
let inflight = null;

export const refreshPitFooter = () => {
  if (inflight) return inflight;
  inflight = fetch(URL, { signal: AbortSignal.timeout(3000) })
    .then(async (res) => {
      if (!res.ok) throw new Error(`pit footer ${res.status}`);
      const text = await res.text();
      if (!text.includes('data-pit-footer')) throw new Error('pit footer: unexpected body');
      html = text;
      fetchedAt = Date.now();
    })
    .catch(() => {
      // Keep the last good copy; retry on a later render.
      fetchedAt = Date.now() - MAX_AGE_MS + 60_000;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
};

/** The cached fragment ('' until the first fetch lands). */
export const pitFooterHtml = () => {
  if (Date.now() - fetchedAt > MAX_AGE_MS) refreshPitFooter();
  return html;
};

refreshPitFooter();
