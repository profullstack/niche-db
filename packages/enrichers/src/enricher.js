/**
 * What an enricher is.
 *
 * An adapter says what exists. An enricher says more about it, from somewhere
 * else: the trailer on YouTube, the Wikipedia paragraph, the repo's stars, the
 * company behind a filing. Each runs once per item, after ingest, on the
 * enrichment worker, and its answer is stored on the item under its own name.
 * A feed chooses which enrichers to show; the collection's defaults are on
 * unless a feed says otherwise.
 *
 * @typedef {object} EnricherSpec
 * @property {string} name
 * @property {string} title
 * @property {string} description
 * @property {string[]} collections   default-on for these collections
 * @property {(item) => boolean} appliesTo
 * @property {string[]} [needsEnv]
 * @property {(item, ctx) => Promise<object|null>} enrich  the stored block, or null for "nothing found"
 * @property {number} [perRun]        how many items one run may spend on this enricher (rate limits)
 */
export function defineEnricher(spec) {
  for (const k of ['name', 'title', 'description', 'collections', 'appliesTo', 'enrich']) {
    if (!spec[k]) throw new Error(`enricher ${spec.name ?? '?'} is missing ${k}`);
  }
  if (!/^[a-z0-9-]+$/.test(spec.name)) throw new Error(`enricher name ${spec.name} must be a slug`);
  return { perRun: 40, needsEnv: [], ...spec };
}

/** Strip a title down to what a search engine should see. */
export function searchTitle(item) {
  return String(item.title ?? '')
    .replace(/\s[—–-]\s.*$/, (m) => (item.kind === 'release' ? m : ''))
    .replace(/\((?:[A-Z0-9]{2,6}\s?[\d/]*|\d{4})\)\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}
