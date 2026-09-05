/**
 * Cache-busting for the static assets the pages link.
 *
 * styles.css and app.js were linked by bare path and served with
 * `max-age=3600`. A deploy therefore did not reach anyone who had visited in the
 * last hour: their browser kept the old stylesheet, and a CSS fix looked like it
 * had simply not worked — which is indistinguishable from a bug that is still
 * there, and cost a round of "it's still broken" on a fix that was live.
 *
 * Hashing the contents means the URL changes exactly when the file does. A
 * versioned URL can then be cached hard, because a new build is a new URL rather
 * than the same one with different bytes.
 */

const versions = new Map();

/** Short, stable, and cheap — this is cache-busting, not integrity. */
async function hash(path) {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  return Bun.hash(await file.arrayBuffer())
    .toString(36)
    .slice(0, 8);
}

/**
 * Read every asset once, at boot.
 *
 * Deliberately eager: doing it per request would stat and re-hash a file on the
 * hot path, and doing it lazily would make the first request after a deploy the
 * slow one for no benefit.
 */
export async function loadAssetVersions(files) {
  for (const file of files) {
    const v = await hash(new URL(`../../public/${file}`, import.meta.url).pathname);
    if (v) versions.set(file, v);
  }
  return versions;
}

/** `/styles.css?v=1a2b3c` — or the bare path if the file could not be read. */
export function assetUrl(file) {
  const v = versions.get(file);
  return v ? `/${file}?v=${v}` : `/${file}`;
}

/** True when a request carries the current version of that asset. */
export function isCurrentVersion(file, v) {
  return Boolean(v) && versions.get(file) === v;
}
